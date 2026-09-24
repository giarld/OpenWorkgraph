import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isTerminalRunStatus } from '@openworkgraph/protocol';
import type { InputSnapshot, Interaction, InteractionReply, Json, Run, RunNotification, RunStatus, SubmitRun, SandboxMode } from '@openworkgraph/protocol';
import { Graphs } from './graphs.js';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import { canonicalJson, Repositories } from './persistence/repositories.js';

export interface RunContext { runId: string; projectId: string; graphId: string; nodeId: string; kind: SubmitRun['kind']; baseVersion: number; canonicalPath: string; publicationVersion: 1 | 2; sandboxMode?: SandboxMode }
export interface RunsDependencies {
  /** Synchronous: extraction/preflight caches must already be prepared. */
  freeze: (request: SubmitRun, context: RunContext) => InputSnapshot;
  validate?: (request: SubmitRun, context: RunContext) => void;
  validateReply?: (interaction: Interaction, answer: Json) => void;
  now?: () => number;
}
export interface RunToken { epoch: string; revision: number }
export interface RunRuntime extends RunToken { details: { [key: string]: Json } }
const terminalSql = "'succeeded','failed','cancelled','interrupted'";
const notificationStatuses = new Set<RunStatus>(['succeeded', 'failed', 'waiting_answer', 'waiting_approval', 'interrupted']);
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  accepted: ['queued', 'cancelled', 'failed'], queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'cancelling', 'failed', 'reconciling', 'interrupted'],
  running: ['waiting_answer', 'waiting_approval', 'agent_completed', 'cancelling', 'failed', 'reconciling', 'interrupted'],
  waiting_answer: ['running', 'waiting_answer', 'waiting_approval', 'cancelling', 'reconciling', 'interrupted', 'failed'],
  waiting_approval: ['running', 'waiting_answer', 'waiting_approval', 'cancelling', 'reconciling', 'interrupted', 'failed'],
  agent_completed: ['finalizing', 'cancelling', 'reconciling', 'failed'],
  finalizing: ['succeeded', 'failed', 'cancelling'],
  cancelling: ['cancelled', 'reconciling'],
  reconciling: ['running', 'cancelling', 'interrupted', 'agent_completed', 'finalizing'],
  paused_restore: ['accepted', 'queued', 'cancelled'], succeeded: [], failed: [], cancelled: [], interrupted: [],
};
function json<T>(value: T): Json { return JSON.parse(JSON.stringify(value)) as Json; }
function recordedFailureReason(details: { [key: string]: Json }): string | undefined {
  if (typeof details.error !== 'string') return undefined;
  const reason = details.error.trim();
  return reason ? reason.slice(0, 2000) : undefined;
}
function sync<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Run dependencies must be synchronous');
  return value;
}

/** All authoritative changes are short synchronous transactions (safe inside Auth). */
export class Runs {
  readonly repo: Repositories;
  readonly now: () => number;
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly dependencies: RunsDependencies) {
    this.repo = new Repositories(db); this.now = dependencies.now ?? Date.now;
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new ServiceError('NOT_FOUND', 'Run not found');
    const details = this.db.prepare('SELECT details FROM run_runtime WHERE run_id=?').get(id);
    const executionDetails = details ? JSON.parse(String(details.details)) : {};
    const executionStart = executionDetails.executionStart as Run['executionStart'];
    const chainBatch = typeof executionDetails.chainBatch === 'string' ? executionDetails.chainBatch : undefined;
    const chainMembers = chainBatch === id ? this.db.prepare("SELECT r.status FROM runs r JOIN run_runtime rt ON rt.run_id=r.id WHERE r.project_id=? AND r.graph_id=? AND json_extract(rt.details,'$.chainBatch')=?").all(row.project_id!,row.graph_id!,id) : [];
    const chainActive = chainMembers.some(member => !isTerminalRunStatus(member.status as RunStatus));
    const chainControl: Run['chainControl'] = chainMembers.length ? executionDetails.chainStopRequested ? chainActive ? 'stopping' : 'stopped' : chainActive ? 'active' : undefined : undefined;
    return { serviceId: this.serviceId, projectId: String(row.project_id), graphId: String(row.graph_id), id: String(row.id), nodeId: String(row.node_id), status: row.status as RunStatus, submissionSequence: String(row.sequence), inputDigest: String(row.input_digest), createdAt: String(row.created_at), historyState: row.history_state as Run['historyState'], ...(row.status === 'accepted' && executionStart ? { executionStart } : {}), ...(chainBatch ? {chainBatch} : {}), ...(chainControl ? {chainControl} : {}) };
  }
  list(projectId?: string): Run[] {
    const rows = projectId === undefined ? this.db.prepare('SELECT id FROM runs ORDER BY sequence').all() : this.db.prepare('SELECT id FROM runs WHERE project_id=? ORDER BY sequence').all(projectId);
    return rows.map(row => this.get(String(row.id)));
  }
  notifications(): RunNotification[] {
    return this.db.prepare(`SELECT n.run_id,n.revision,n.created_at FROM run_notifications n JOIN runs r ON r.id=n.run_id WHERE n.read_at IS NULL AND n.status=r.status ORDER BY n.created_at,n.run_id`).all().map(row => ({
      run: this.get(String(row.run_id)),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
    }));
  }
  readNotification(id: string, expectedRevision: number): { read: boolean } {
    return atomic(this.db, () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ServiceError('INVALID_REQUEST', 'Invalid notification revision');
      const row = this.db.prepare('SELECT n.revision,n.read_at,r.project_id,r.graph_id FROM run_notifications n JOIN runs r ON r.id=n.run_id WHERE n.run_id=?').get(id);
      if (!row) throw new ServiceError('NOT_FOUND', 'Notification not found');
      if (Number(row.revision) !== expectedRevision) throw new ServiceError('REVISION_CONFLICT', 'Notification changed');
      if (row.read_at !== null) return { read: false };
      this.db.prepare('UPDATE run_notifications SET read_at=? WHERE run_id=? AND revision=? AND read_at IS NULL').run(new Date(this.now()).toISOString(), id, expectedRevision);
      this.repo.appendEvent({ eventId:randomUUID(), type:'notification.changed', projectId:String(row.project_id), graphId:String(row.graph_id), entityId:id, revision:expectedRevision, occurredAt:new Date(this.now()).toISOString(), payload:{ runId:id, read:true, notificationRevision:expectedRevision } });
      return { read: true };
    });
  }
  readAllNotifications(): { read: number } {
    return atomic(this.db, () => {
      const rows = this.db.prepare('SELECT n.run_id,n.revision FROM run_notifications n JOIN runs r ON r.id=n.run_id WHERE n.read_at IS NULL AND n.status=r.status').all();
      if (!rows.length) return { read: 0 };
      this.db.prepare('UPDATE run_notifications SET read_at=? WHERE read_at IS NULL AND EXISTS(SELECT 1 FROM runs r WHERE r.id=run_notifications.run_id AND r.status=run_notifications.status)').run(new Date(this.now()).toISOString());
      const revision = Math.max(...rows.map(row => Number(row.revision)));
      this.repo.appendEvent({ eventId:randomUUID(), type:'notification.changed', projectId:null, graphId:null, entityId:'all', revision, occurredAt:new Date(this.now()).toISOString(), payload:{ readAll:true, count:rows.length } });
      return { read: rows.length };
    });
  }
  runtime(id: string): RunRuntime {
    const row = this.db.prepare('SELECT * FROM run_runtime WHERE run_id=?').get(id);
    if (!row) throw new ServiceError('NOT_FOUND', 'Run runtime not found');
    return { epoch: String(row.epoch), revision: Number(row.revision), details: JSON.parse(String(row.details)) as RunRuntime['details'] };
  }
  snapshot(id: string): InputSnapshot {
    const effective = this.db.prepare('SELECT payload FROM execution_input_snapshots WHERE run_id=?').get(id);
    if (effective) return JSON.parse(String(effective.payload)) as InputSnapshot;
    const row = this.db.prepare('SELECT payload FROM snapshots WHERE run_id=?').get(id);
    if (!row) throw new ServiceError('NOT_FOUND', 'Run snapshot not found');
    return JSON.parse(String(row.payload)) as InputSnapshot;
  }
  private event(run: Run, revision: number, type: 'run.changed' | 'interaction.changed' = 'run.changed', entityId = run.id, payload: Json = json(run)): void {
    this.repo.appendEvent({ eventId: randomUUID(), type, projectId: run.projectId, graphId: run.graphId, entityId, revision, occurredAt: new Date(this.now()).toISOString(), payload });
  }
  private refreshNotification(run: Run): void {
    if (!notificationStatuses.has(run.status)) return;
    this.db.prepare(`INSERT INTO run_notifications(run_id,status,revision,created_at,read_at) VALUES(?,?,1,?,NULL)
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,revision=run_notifications.revision+1,created_at=excluded.created_at,read_at=NULL`).run(run.id, run.status, new Date(this.now()).toISOString());
  }
  record(id: string, kind: string, payload: Json): void {
    atomic(this.db, () => {
      if (this.get(id).historyState === 'cleared') return;
      this.db.prepare('INSERT INTO run_process_records(run_id,occurred_at,kind,payload) VALUES(?,?,?,?)').run(id, new Date(this.now()).toISOString(), kind, canonicalJson(payload));
    });
  }
  submit(request: SubmitRun, principal = 'local', holdExecution = false): Run {
    return this.repo.idempotent(principal + ':run.submit', request.idempotencyKey, json(request), () => {
      if (request.serviceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', 'Wrong service');
      if (this.repo.setting('acceptingRuns') !== true) throw new ServiceError('MAINTENANCE', 'Service is not accepting runs');
      const row = this.db.prepare('SELECT p.state,p.canonical_path,g.archived,g.trashed,g.execution_revision,n.type,n.deleted,n.current_version,n.read_only FROM projects p JOIN graphs g ON g.project_id=p.id JOIN nodes n ON n.graph_id=g.id WHERE p.id=? AND g.id=? AND n.id=?').get(request.projectId, request.graphId, request.nodeId);
      if (!row) throw new ServiceError('NOT_FOUND', 'Run target not found');
      if (row.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', 'Project is inactive');
      if (row.archived || row.trashed || row.deleted || row.read_only) throw new ServiceError('NODE_LOCKED', 'Run target is archived, deleted or read-only');
      const expectedType = { execution: 'execution', text_generation: 'text', image_generation: 'image' }[request.kind];
      if (!expectedType || row.type !== expectedType) throw new ServiceError('INVALID_REQUEST', 'Run kind does not match node type');
      if (!Number.isSafeInteger(request.expectedExecutionRevision) || row.execution_revision !== request.expectedExecutionRevision) throw new ServiceError('REVISION_CONFLICT', 'Graph execution revision changed');
      if (this.db.prepare(`SELECT 1 FROM runs WHERE node_id=? AND status NOT IN (${terminalSql})`).get(request.nodeId)) throw new ServiceError('ACTIVE_RUN', 'Node already has an unfinished run');
      const context: RunContext = { runId: randomUUID(), projectId: request.projectId, graphId: request.graphId, nodeId: request.nodeId, kind: request.kind, baseVersion: Number(row.current_version), canonicalPath: String(row.canonical_path), publicationVersion:request.kind === 'execution' ? 2 : 1 };
      if (this.dependencies.validate) sync(this.dependencies.validate(request, context));
      const snapshot = sync(this.dependencies.freeze(request, context));
      const hasImage = Array.isArray(snapshot?.resources) && snapshot.resources.some(item=>item.kind==='image' && item.resource) || Array.isArray(snapshot?.projectFiles) && snapshot.projectFiles.some(item=>item.kind==='image');
      if (!snapshot || (!snapshot.prompt?.trim() && !(request.kind==='image_generation' && hasImage)) || !snapshot.inputDigest || snapshot.executionRevision !== request.expectedExecutionRevision || !Array.isArray(snapshot.resources) || snapshot.projectFiles !== undefined && !Array.isArray(snapshot.projectFiles)) throw new ServiceError('INPUT_BLOCKED', 'Invalid frozen input snapshot');
      const route = request.kind==='image_generation' ? request.imageRoute ?? {type:'codex' as const} : undefined;
      if (route?.type==='api') {
        if (request.modelOverride) throw new ServiceError('INVALID_REQUEST','API image runs cannot select a Codex model');
        const frozen=snapshot.imageRoute;
        const mode=hasImage ? (snapshot.prompt.trim()?'text_image':'image') : 'text';
        if (!frozen || frozen.type!=='api' || snapshot.model !== undefined || snapshot.inputMode!==mode || frozen.providerId!==route.providerId || frozen.modelId!==route.modelId || canonicalJson((frozen.options??null) as Json)!==canonicalJson((route.options??null) as Json) || !Number.isSafeInteger(frozen.configRevision) || frozen.configRevision<1 || !Number.isSafeInteger(frozen.credentialRevision) || frozen.credentialRevision<1 || Object.keys(frozen).some(key=>!['type','providerId','modelId','options','configRevision','credentialRevision'].includes(key))) throw new ServiceError('INPUT_BLOCKED','Invalid frozen API image route');
      } else if (!snapshot.model?.model || (request.kind==='image_generation' && canonicalJson(((snapshot.imageRoute?.type==='codex'?snapshot.imageRoute.options:undefined)??null) as Json)!==canonicalJson(((route?.type==='codex'?route.options:undefined)??null) as Json))) throw new ServiceError('INPUT_BLOCKED','Invalid frozen Codex model/route');
      const graphHistory=new Graphs(this.db,this.serviceId);
      const historyBefore=graphHistory.history.capture(request);
      if(request.kind==='execution' && !holdExecution)graphHistory.retireExecutionOutputs(request,request.nodeId);
      this.db.prepare('INSERT INTO runs(id,project_id,graph_id,node_id,kind,status,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?)').run(context.runId, request.projectId, request.graphId, request.nodeId, request.kind, 'accepted', snapshot.inputDigest, new Date(this.now()).toISOString());
      graphHistory.history.recordRunSubmission(request,context.runId,historyBefore);
      this.db.prepare('INSERT INTO run_runtime(run_id,epoch,details) VALUES(?,?,?)').run(context.runId, '', canonicalJson(json({...context, ...(request.kind === 'execution' ? {chainDependencies: []} : {}), ...(holdExecution ? {executionStart:'manual'} : {})})));
      this.db.prepare('INSERT INTO snapshots(run_id,input_digest,payload) VALUES(?,?,?)').run(context.runId, snapshot.inputDigest, canonicalJson(json(snapshot)));
      const seen = new Set<string>();
      for (const input of snapshot.resources) {
        const resource = input.resource; if (!resource) continue;
        const key = resource.resourceId + '/' + resource.version; if (seen.has(key)) continue; seen.add(key);
        const stored = this.db.prepare('SELECT v.sha256,v.representation_version FROM canvas_resource_versions v JOIN canvas_resources r ON r.id=v.resource_id WHERE v.resource_id=? AND v.version=? AND r.graph_id=?').get(resource.resourceId, resource.version, request.graphId);
        if (!stored || stored.sha256 !== resource.sha256 || stored.representation_version !== resource.representationVersion) throw new ServiceError('INPUT_BLOCKED', 'Frozen resource does not match its immutable version');
        this.db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind,run_id) VALUES(?,?,?,?,'snapshot',?)").run(randomUUID(), resource.resourceId, resource.version, request.graphId, context.runId);
      }
      this.event(this.get(context.runId), 0);
      if (holdExecution) { this.record(context.runId, 'state', { from: 'submitted', to: 'accepted', reason: '任务已提交，等待开始执行。' }); return json(this.get(context.runId)); }
      return json(this.transition(context.runId, this.runtime(context.runId), 'queued'));
    }) as unknown as Run;
  }
  capacity(): { capacity: number; occupied: number; available: number } {
    const configured = this.repo.setting('capacity');
    if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 1) throw new ServiceError('MAINTENANCE', 'Invalid scheduler capacity');
    const occupied = Number(this.db.prepare('SELECT COUNT(*) AS n FROM occupancy').get()!.n);
    return { capacity: configured, occupied, available: Math.max(0, configured - occupied) };
  }
  /** ExecutionChains enqueues only dependency-ready runs. Claim those in persisted
   * order up to capacity, without serializing unrelated nodes by project or batch. */
  claimNext(epoch: string, excludedProjectIds: readonly string[] = [], eligible?: (run: Run, snapshot: InputSnapshot) => boolean): Run | null {
    if (!epoch) throw new ServiceError('INVALID_REQUEST', 'Scheduler epoch required');
    return atomic(this.db, () => {
      if (this.repo.setting('acceptingRuns') !== true) return null;
      const capacity = this.capacity(); if (!capacity.available) return null;
      const exclusion = excludedProjectIds.length ? ` AND (r.kind!='execution' OR r.project_id NOT IN (${excludedProjectIds.map(() => '?').join(',')}))` : '';
      const rows = this.db.prepare(`
        SELECT r.id FROM runs r
        JOIN projects p ON p.id=r.project_id
        JOIN run_runtime rt ON rt.run_id=r.id
        WHERE r.status='queued' AND p.state='active'
          AND p.canonical_path=json_extract(rt.details,'$.canonicalPath')
          ${exclusion} ORDER BY r.sequence
      `).all(...excludedProjectIds);
      const selected = rows.find(row => {
        const run = this.get(String(row.id));
        return !eligible || eligible(run, this.snapshot(run.id));
      });
      if (!selected) return null;
      const id = String(selected.id); const runtime = this.runtime(id);
      const slots = new Set(this.db.prepare('SELECT slot FROM occupancy').all().map(item => Number(item.slot)));
      let slot = 0; while (slots.has(slot)) slot++;
      // Keep the legacy nullable project_id column for database compatibility;
      // occupancy now reserves only a runtime slot, never a project-wide slot.
      this.db.prepare('INSERT INTO occupancy(run_id,slot,project_id) VALUES(?,?,NULL)').run(id, slot);
      this.db.prepare('UPDATE run_runtime SET epoch=? WHERE run_id=?').run(epoch, id);
      return this.transition(id, { epoch, revision: runtime.revision }, 'preparing');
    });
  }
  /** Persist the uncertain spawn boundary BEFORE calling an external backend. */
  markBackendLaunching(id: string, token: RunToken): RunToken {
    return atomic(this.db, () => {
      const runtime = this.runtime(id);
      if (runtime.epoch !== token.epoch || runtime.revision !== token.revision) throw new ServiceError('REVISION_CONFLICT', 'Stale launch attempt');
      if (this.get(id).status !== 'preparing' || runtime.details.backendLaunchAttempted === true) throw new ServiceError('CONFLICT', 'Run is not eligible to launch');
      this.db.prepare('UPDATE run_runtime SET revision=revision+1,details=? WHERE run_id=?').run(canonicalJson({ ...runtime.details, backendLaunchAttempted: true }), id);
      this.event(this.get(id), runtime.revision + 1);
      return this.runtime(id);
    });
  }
  /** Only a known lock-contention result BEFORE the spawn boundary can requeue.
   * No generic preparing -> queued transition is allowed after uncertain launch. */
  requeueUnstarted(id: string, token: RunToken): Run {
    return atomic(this.db, () => {
      const run = this.get(id); const runtime = this.runtime(id);
      if (runtime.epoch !== token.epoch || runtime.revision !== token.revision) throw new ServiceError('REVISION_CONFLICT', 'Stale requeue attempt');
      if (run.status !== 'preparing' || runtime.details.backendLaunchAttempted === true || runtime.details.cancelRequested === true) throw new ServiceError('CONFLICT', 'Cannot requeue after launch or cancellation');
      this.db.prepare('UPDATE run_runtime SET revision=revision+1 WHERE run_id=?').run(id);
      this.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(id);
      this.db.prepare('DELETE FROM occupancy WHERE run_id=?').run(id);
      const changed = this.get(id); this.event(changed, runtime.revision + 1);
      this.record(id, 'state', { from: 'preparing', to: 'queued', reason: 'project_lock_busy' });
      return changed;
    });
  }
  transition(id: string, token: RunToken, next: RunStatus, details: { [key: string]: Json } = {}): Run {
    return atomic(this.db, () => {
      const run = this.get(id); const runtime = this.runtime(id);
      if (runtime.epoch !== token.epoch || runtime.revision !== token.revision) throw new ServiceError('REVISION_CONFLICT', 'Stale run callback');
      if (!transitions[run.status]?.includes(next)) throw new ServiceError('CONFLICT', `Invalid run transition ${run.status} -> ${next}`);
      if (!['accepted', 'queued', 'paused_restore'].includes(next) && !isTerminalRunStatus(next) && !this.db.prepare('SELECT 1 FROM occupancy WHERE run_id=?').get(id)) throw new ServiceError('CONFLICT', 'Active states require an atomic capacity claim');
      if (runtime.details.cancelRequested === true && !['cancelling', 'cancelled', 'reconciling'].includes(next)) throw new ServiceError('CONFLICT', 'Cancellation already accepted');
      if (['kind', 'baseVersion', 'canonicalPath', 'publicationVersion', 'runId', 'projectId', 'graphId', 'nodeId'].some(key => key in details && details[key] !== runtime.details[key])) throw new ServiceError('INVALID_REQUEST', 'Frozen runtime identity cannot change');
      const updated = { ...runtime.details, ...details, ...(isTerminalRunStatus(next) ? { completedAt: new Date(this.now()).toISOString() } : {}) };
      const result = this.db.prepare('UPDATE run_runtime SET revision=revision+1,details=? WHERE run_id=? AND epoch=? AND revision=?').run(canonicalJson(updated), id, token.epoch, token.revision);
      if (Number(result.changes) !== 1) throw new ServiceError('REVISION_CONFLICT', 'Stale run callback');
      this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(next, id);
      if (isTerminalRunStatus(next)) this.db.prepare('DELETE FROM occupancy WHERE run_id=?').run(id);
      if (isTerminalRunStatus(next) || next === 'cancelling' || next === 'reconciling') this.expireInteractions(id);
      const changed = this.get(id); this.refreshNotification(changed); this.event(changed, runtime.revision + 1);
      if (isTerminalRunStatus(next)) {
        const paths = this.db.prepare('SELECT relative_path FROM project_file_outputs WHERE run_id=? ORDER BY output_key').all(id).map(row => String(row['relative_path']));
        this.repo.appendEvent({ eventId:randomUUID(), type:'project.files.changed', projectId:changed.projectId, graphId:null, entityId:changed.projectId, revision:runtime.revision + 1, occurredAt:new Date(this.now()).toISOString(), payload:{ runId:id, paths, fullRecheck:true } });
      }
      const reason = next === 'failed' ? recordedFailureReason(details) : undefined;
      this.record(id, 'state', { from: run.status, to: next, ...(reason ? { reason } : {}) });
      return changed;
    });
  }
  cancel(id: string, key: string, principal = 'local'): Run {
    return this.repo.idempotent(principal + ':run.cancel:' + id, key, { id }, () => {
      const run = this.get(id);
      if (isTerminalRunStatus(run.status) || run.status === 'cancelling') return json(run);
      // The agent has already stopped; invalidate pending publication callbacks locally.
      if (['agent_completed', 'finalizing'].includes(run.status)) {
        this.transition(id, this.runtime(id), 'cancelling', {cancelRequested:true});
        return json(this.transition(id, this.runtime(id), 'cancelled'));
      }
      return json(this.transition(id, this.runtime(id), ['queued', 'accepted', 'paused_restore'].includes(run.status) ? 'cancelled' : 'cancelling', { cancelRequested: true }));
    }) as unknown as Run;
  }
  interaction(id: string): Interaction {
    const row = this.db.prepare('SELECT * FROM interactions WHERE id=?').get(id);
    if (!row) throw new ServiceError('NOT_FOUND', 'Interaction not found');
    return { id: String(row.id), runId: String(row.run_id), epoch: String(row.epoch), version: Number(row.version), kind: row.kind as Interaction['kind'], status: row.status as Interaction['status'], payload: JSON.parse(String(row.payload)) as Json };
  }
  /** Oldest independent action whose reply has not been acknowledged by its responder. */
  activeInteraction(id: string): Interaction | null {
    const runtime = this.runtime(id);
    const delivered = new Set(Array.isArray(runtime.details.deliveredInteractionIds) ? runtime.details.deliveredInteractionIds : []);
    if (typeof runtime.details.deliveredInteractionId === 'string') delivered.add(runtime.details.deliveredInteractionId);
    const row = this.db.prepare("SELECT id FROM interactions WHERE run_id=? AND epoch=? AND status!='expired' ORDER BY rowid").all(id, runtime.epoch).find(row => !delivered.has(String(row.id)));
    return row ? this.interaction(String(row.id)) : null;
  }
  acknowledgeReply(id: string, epoch: string, interactionId: string): Run {
    return atomic(this.db, () => {
      const runtime = this.runtime(id); const run = this.get(id); const active = this.activeInteraction(id);
      if (runtime.epoch !== epoch) throw new ServiceError('REVISION_CONFLICT', 'Stale responder epoch');
      if (!['waiting_answer', 'waiting_approval'].includes(run.status) || active?.id !== interactionId || active.status !== 'answered') throw new ServiceError('ALREADY_HANDLED', 'Action is no longer awaiting delivery');
      const delivered = Array.isArray(runtime.details.deliveredInteractionIds) ? [...runtime.details.deliveredInteractionIds] : [];
      if (typeof runtime.details.deliveredInteractionId === 'string' && !delivered.includes(runtime.details.deliveredInteractionId)) delivered.push(runtime.details.deliveredInteractionId);
      if (!delivered.includes(interactionId)) delivered.push(interactionId);
      const next = this.db.prepare("SELECT id,kind FROM interactions WHERE run_id=? AND epoch=? AND status!='expired' ORDER BY rowid").all(id, epoch).find(row => !delivered.includes(String(row.id)));
      return this.transition(id, runtime, next ? (next.kind === 'question' ? 'waiting_answer' : 'waiting_approval') : 'running', { deliveredInteractionIds: delivered, deliveredInteractionId: interactionId, activeInteractionId: next ? String(next.id) : null });
    });
  }
  openInteraction(id: string, token: RunToken, kind: Interaction['kind'], payload: Json, interactionId: string = randomUUID()): Interaction {
    return atomic(this.db, () => {
      if (kind !== 'question' && kind !== 'approval') throw new ServiceError('INVALID_REQUEST', 'Invalid interaction kind');
      const existing = this.db.prepare('SELECT id FROM interactions WHERE id=?').get(interactionId);
      if (existing) {
        const prior = this.interaction(interactionId);
        if (prior.runId !== id || prior.epoch !== token.epoch || canonicalJson(prior.payload) !== canonicalJson(payload) || prior.kind !== kind) throw new ServiceError('CONFLICT', 'Interaction identity reused');
        return prior;
      }
      const run = this.get(id); const runtime = this.runtime(id);
      if (runtime.epoch !== token.epoch || runtime.revision !== token.revision) throw new ServiceError('REVISION_CONFLICT', 'Stale interaction callback');
      if (!['running', 'waiting_answer', 'waiting_approval'].includes(run.status) || runtime.details.cancelRequested === true) throw new ServiceError('CONFLICT', 'Run cannot accept interactions');
      this.db.prepare("INSERT INTO interactions(id,run_id,epoch,version,kind,status,payload) VALUES(?,?,?,1,?,'pending',?)").run(interactionId, id, token.epoch, kind, canonicalJson(payload));
      const active = this.activeInteraction(id)!;
      this.transition(id, token, active.kind === 'question' ? 'waiting_answer' : 'waiting_approval', { activeInteractionId: active.id });
      const interaction = this.interaction(interactionId); this.event(this.get(id), 1, 'interaction.changed', interactionId, json(interaction)); return interaction;
    });
  }
  private expireInteractions(id: string): void {
    const runtime = this.runtime(id);
    const delivered = new Set(Array.isArray(runtime.details.deliveredInteractionIds) ? runtime.details.deliveredInteractionIds : []);
    if (typeof runtime.details.deliveredInteractionId === 'string') delivered.add(runtime.details.deliveredInteractionId);
    for (const row of this.db.prepare("SELECT id FROM interactions WHERE run_id=? AND status IN ('pending','answered')").all(id)) {
      const interactionId = String(row.id);
      if (delivered.has(interactionId)) continue;
      this.db.prepare("UPDATE interactions SET status='expired',version=version+1 WHERE id=?").run(interactionId);
      const interaction = this.interaction(interactionId); this.event(this.get(id), interaction.version, 'interaction.changed', interactionId, json(interaction));
    }
  }
  reply(request: InteractionReply, sessionId: string, principal = sessionId): Interaction {
    return atomic(this.db, () => {
      const session = this.db.prepare('SELECT revoked_at,last_used_at FROM sessions WHERE id=?').get(sessionId);
      if (!session) throw new ServiceError('UNAUTHENTICATED', 'Valid session required');
      if (session.revoked_at !== null) throw new ServiceError('SESSION_REVOKED', 'Session revoked');
      if (Number(session.last_used_at) + 30 * 86400000 <= this.now()) throw new ServiceError('SESSION_EXPIRED', 'Session expired');
      return this.repo.idempotent(principal + ':interaction.reply:' + request.interactionId, request.idempotencyKey, json(request), () => {
        const interaction = this.interaction(request.interactionId); const run = this.get(request.runId); const runtime = this.runtime(run.id);
        if (interaction.runId !== request.runId || interaction.epoch !== request.epoch || runtime.epoch !== request.epoch) throw new ServiceError('ALREADY_HANDLED', 'Stale interaction epoch or run');
        if (interaction.status !== 'pending') throw new ServiceError('ALREADY_HANDLED', 'Interaction already handled');
        if (interaction.version !== request.expectedVersion) throw new ServiceError('REVISION_CONFLICT', 'Interaction version changed');
        if (this.activeInteraction(run.id)?.id !== interaction.id) throw new ServiceError('CONFLICT', 'An earlier independent action must be acknowledged first');
        if (run.status !== (interaction.kind === 'question' ? 'waiting_answer' : 'waiting_approval')) throw new ServiceError('ALREADY_HANDLED', 'Run is no longer waiting');
        if (this.dependencies.validateReply) sync(this.dependencies.validateReply(interaction, request.answer));
        else {
          const answer = request.answer;
          const structured = answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer : null;
          if (interaction.kind === 'approval') {
            if (typeof answer !== 'boolean' && !(structured?.kind === 'approval' && ['accept', 'decline'].includes(String(structured.decision)))) throw new ServiceError('INVALID_REQUEST', 'Approval requires accept/decline or boolean');
            if (interaction.payload && typeof interaction.payload === 'object' && !Array.isArray(interaction.payload) && interaction.payload.canApprove === false && (answer === true || structured?.decision === 'accept')) throw new ServiceError('INVALID_REQUEST', 'This action cannot be approved');
          } else {
            const answers = structured?.answers;
            const validStructured = structured?.kind === 'question' && answers !== null && typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length > 0 && Object.values(answers).every(value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim()));
            if (!(typeof answer === 'string' && answer.trim()) && !validStructured) throw new ServiceError('INVALID_REQUEST', 'Question requires nonempty text or structured answers');
          }
        }
        this.db.prepare("UPDATE interactions SET status='answered',version=version+1,answer=? WHERE id=? AND status='pending' AND version=?").run(canonicalJson(request.answer), interaction.id, request.expectedVersion);
        const changed = this.interaction(interaction.id); this.event(run, changed.version, 'interaction.changed', changed.id, json(changed));
        this.record(run.id, 'interaction.reply', { interactionId: changed.id, sessionId });
        // Remain waiting/occupied until the original responder acknowledges delivery.
        return json(changed);
      }) as unknown as Interaction;
    });
  }
  /** Caller must first establish previous service ownership is stale (not just a PID check). */
  recover(epoch: string): Run[] {
    if (!epoch) throw new ServiceError('INVALID_REQUEST', 'Recovery epoch required');
    return atomic(this.db, () => {
      for (const run of this.list()) {
        if (isTerminalRunStatus(run.status) || ['queued', 'accepted', 'paused_restore'].includes(run.status)) continue;
        const runtime = this.runtime(run.id); if (runtime.epoch === epoch) continue;
        this.db.prepare('UPDATE run_runtime SET epoch=?,revision=revision+1,details=? WHERE run_id=?').run(epoch, canonicalJson({ ...runtime.details, previousEpoch: runtime.epoch, recoveryStatus: run.status }), run.id);
        this.expireInteractions(run.id);
        if (run.status === 'preparing' && runtime.details.backendLaunchAttempted !== true) this.transition(run.id, this.runtime(run.id), 'interrupted', { interruptionReason: 'Recovered before backend launch boundary' });
        else if (run.status === 'agent_completed') this.transition(run.id, this.runtime(run.id), 'finalizing');
        else if (run.status === 'finalizing') this.event(this.get(run.id), runtime.revision + 1);
        else if (run.status === 'reconciling') this.event(this.get(run.id), runtime.revision + 1);
        else this.transition(run.id, this.runtime(run.id), 'reconciling');
      }
      return this.list().filter(run => !isTerminalRunStatus(run.status));
    });
  }
  /** A new service instance must not replay or retain ownership of old work. */
  abandonOnRestart(epoch: string): Run[] {
    if (!epoch) throw new ServiceError('INVALID_REQUEST', 'Recovery epoch required');
    return atomic(this.db, () => {
      const changed: Run[] = [];
      for (const run of this.list()) {
        if (isTerminalRunStatus(run.status)) continue;
        const runtime = this.runtime(run.id);
        const status: RunStatus = ['accepted', 'queued', 'paused_restore'].includes(run.status) ? 'cancelled' : 'interrupted';
        const revision = runtime.revision + 1;
        const details = {
          ...runtime.details, previousEpoch: runtime.epoch, recoveryStatus: run.status,
          interruptionReason: 'Service restarted before Run completion',
          completedAt: new Date(this.now()).toISOString(),
        };
        this.db.prepare('UPDATE run_runtime SET epoch=?,revision=?,details=? WHERE run_id=?').run(epoch, revision, canonicalJson(details), run.id);
        this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id);
        this.db.prepare('DELETE FROM occupancy WHERE run_id=?').run(run.id);
        this.expireInteractions(run.id);
        const current = this.get(run.id);
        this.refreshNotification(current); this.event(current, revision);
        const paths = this.db.prepare('SELECT relative_path FROM project_file_outputs WHERE run_id=? ORDER BY output_key').all(run.id).map(row => String(row['relative_path']));
        this.repo.appendEvent({ eventId: randomUUID(), type: 'project.files.changed', projectId: current.projectId, graphId: null, entityId: current.projectId, revision, occurredAt: new Date(this.now()).toISOString(), payload: { runId: run.id, paths, fullRecheck: true } });
        this.record(run.id, 'state', { from: run.status, to: status, reason: 'service_restart' });
        changed.push(current);
      }
      this.db.prepare('DELETE FROM occupancy WHERE run_id IN (SELECT id FROM runs WHERE status IN (' + terminalSql + '))').run();
      return changed;
    });
  }
}
