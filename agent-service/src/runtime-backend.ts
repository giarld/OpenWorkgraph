import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentApprovalDetails, AgentMessageIdentity, InputSnapshot, Interaction, Json, Run } from '@openworkgraph/protocol';
import { normalizeApprovalPermissions, validApprovalPaths } from '@openworkgraph/protocol';
import type { BackendAdapter, BackendInteraction, BackendReply, RuntimeSnapshot } from './backend/types.js';
import type { SchedulerBackend, BackendContext, ReconcileResult } from './scheduler.js';
import { Runs } from './runs.js';
import { ProjectProbe } from './project-probe.js';
import { materializeInputs } from './input-materialization.js';
import { runDirectories, type DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { publicProgressText } from './backend/progress.js';
import { sandboxMode } from './execution-settings.js';
import { ProjectFiles } from './project-files.js';
import { RunContexts, type RunLineage } from './run-context.js';
import type { SkillSessions } from './skill-sessions.js';
import { hasVisualizeFeature } from './visualize-features.js';
import { validateVisualizeOutput } from './visualize-output-validation.js';
import type { VisualizePreviews } from './visualize-preview.js';
import { validateAgentForm, validateAgentFormAnswer } from './agents/forms.js';
import { canonicalJson } from './persistence/repositories.js';
import { atomic } from './persistence/database.js';

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept only the displayed operation, never session/permanent grants. */
function approvableDetails(details: AgentApprovalDetails): boolean {
  if (!object(details) || details.version !== 1 || !['command', 'file_change', 'permissions', 'tool'].includes(details.kind) || typeof details.summary !== 'string' || !details.summary.trim()) return false;
  if (details.scope !== undefined && !['once', 'turn'].includes(details.scope)) return false;
  if (details.command !== undefined && (typeof details.command !== 'string' || details.command.length > 16000)) return false;
  if (details.paths !== undefined && !validApprovalPaths(details.paths)) return false;
  if (details.kind !== 'permissions') return details.permissions === undefined;
  // Unknown shapes remain readable and declineable, but cannot be approved.
  return normalizeApprovalPermissions(details.permissions) !== null;
}

export function backendReply(interaction: Interaction, answer: Json): BackendReply {
  const payload = interaction.payload as unknown as BackendInteraction;
  if (interaction.kind === 'approval') {
    const decision = typeof answer === 'boolean' ? (answer ? 'accept' : 'decline') : answer && typeof answer === 'object' && !Array.isArray(answer) && answer.kind === 'approval' ? answer.decision : null;
    if (!['accept', 'decline'].includes(String(decision)) || (decision === 'accept' && (payload?.canApprove !== true || (payload.details !== undefined && !approvableDetails(payload.details))))) throw new ServiceError('INVALID_REQUEST', 'Approval is not permitted for this action');
    return { kind: 'approval', decision: decision as 'accept' | 'decline' };
  }
  const questions = payload?.questions;
  if (payload.form && object(answer) && answer.kind === 'form') {
    if (Object.keys(answer).some(key => !['kind', 'values'].includes(key))) throw new ServiceError('INVALID_REQUEST', 'Unknown form answer field');
    return { kind: 'form', values: validateAgentFormAnswer(payload.form, answer.values) };
  }
  if (!Array.isArray(questions) || !questions.length || questions.length > 32 || questions.some(question => !object(question) || !identifier(question.id)) || new Set(questions.map(question => question.id)).size !== questions.length) throw new ServiceError('INVALID_REQUEST', 'Invalid question group');
  const ids = questions.map(question => question.id);
  const answers = typeof answer === 'string' && ids.length === 1 ? { [ids[0]!]: [answer] } : answer && typeof answer === 'object' && !Array.isArray(answer) && answer.kind === 'question' ? answer.answers : null;
  if (!object(answers) || Object.keys(answers).length !== ids.length || ids.some(id => !Object.hasOwn(answers, id))) throw new ServiceError('INVALID_REQUEST', 'Answer each requested question exactly once');
  for (const question of questions) {
    const values = answers[question.id]; const mode = question.mode ?? 'text';
    if (!['text', 'single', 'multiple'].includes(mode) || !Array.isArray(values) || !values.length || values.length > 64 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16000)) throw new ServiceError('INVALID_REQUEST', 'Invalid question answer');
    // Legacy questions allowed arrays and free text even when suggestions exist.
    if (question.mode === 'text' && values.length !== 1 || mode === 'single' && values.length !== 1 || mode === 'multiple' && new Set(values).size !== values.length) throw new ServiceError('INVALID_REQUEST', 'Invalid question selection count');
    if (mode !== 'text' && question.allowOther !== true && (!Array.isArray(question.options) || (values as string[]).some(value => !question.options.includes(value)))) throw new ServiceError('INVALID_REQUEST', 'Select only requested options');
  }
  return { kind: 'question', answers: answers as Record<string, string[]> };
}

/** Trusted host bridge. Never accepts browser paths or creates isolation evidence. */
export class RuntimeBackend implements SchedulerBackend {
  private readonly contexts = new Map<string, BackendContext>();
  private readonly failedInteractionCallbacks = new Set<string>();
  readonly runContexts: RunContexts;
  private readonly callbackTimeoutMs: number;
  constructor(readonly runs: Runs, readonly dirs: DataDirectories, readonly adapter: BackendAdapter, readonly probe = new ProjectProbe(), readonly skillSessions?: SkillSessions, options: { callbackTimeoutMs?: number } = {}, readonly visualizePreviews?: VisualizePreviews) {
    this.runContexts = new RunContexts(runs, dirs);
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.callbackTimeoutMs) || this.callbackTimeoutMs < 1 || this.callbackTimeoutMs > 60000) throw new ServiceError('INVALID_REQUEST', 'Invalid host callback timeout');
  }
  /** The accepted epoch and frozen plugin fence callbacks and operation returns. */
  private accepts(snapshot: RuntimeSnapshot, context: BackendContext, runId: string): boolean {
    if (snapshot.runId !== runId || !this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) return false;
    const token = this.runs.runtime(runId);
    if (token.epoch !== context.epoch || snapshot.attemptId !== undefined && snapshot.attemptId !== context.epoch) return false;
    const backendId = this.runs.snapshot(runId).agent?.backendId ?? 'codex';
    if (snapshot.backendId !== undefined && snapshot.backendId !== backendId) return false;
    const identity = snapshot.identity;
    if (identity !== undefined && (!identifier(identity.backendId) || !identifier(identity.attemptId) || !identifier(identity.messageId) || identity.backendId !== backendId || identity.attemptId !== context.epoch || identity.sessionId !== undefined && !identifier(identity.sessionId) || identity.turnId !== undefined && !identifier(identity.turnId))) return false;
    return true;
  }
  private snapshot(snapshot: RuntimeSnapshot, context: BackendContext, expectedRunId: string): void {
    if (!this.accepts(snapshot, context, expectedRunId)) return;
    const run = this.runs.get(snapshot.runId);
    if (snapshot.state === 'starting') return;
    const backendId = this.runs.snapshot(run.id).agent?.backendId;
    if (run.status === 'preparing') context.emit({ type: 'started', identity: { threadId: snapshot.threadId, turnId: snapshot.turnId, ...(backendId ? { backendId, attemptId: context.epoch } : {}) } });
    const progress = snapshot.progress;
    const content = progress && publicProgressText(progress.text);
    const identity: AgentMessageIdentity | undefined = snapshot.identity ? { backendId: snapshot.identity.backendId, attemptId: snapshot.identity.attemptId, messageId: snapshot.identity.messageId, ...(snapshot.identity.sessionId ? { sessionId: snapshot.identity.sessionId } : {}), ...(snapshot.identity.turnId ? { turnId: snapshot.identity.turnId } : {}) } : backendId && progress && identifier(progress.messageId) ? { backendId, attemptId: context.epoch, messageId: progress.messageId } : undefined;
    if (snapshot.identity && progress?.messageId !== undefined && progress.messageId !== snapshot.identity.messageId) throw new ServiceError('INVALID_REQUEST', 'Progress message identity mismatch');
    // Persistent identity deduplication covers callbacks, operation returns and reconcile.
    const duplicate = progress && (identity
      ? this.runs.db.prepare("SELECT 1 FROM run_process_records WHERE run_id=? AND kind='backend.progress' AND json_extract(payload,'$.identity.backendId')=? AND json_extract(payload,'$.identity.attemptId')=? AND json_extract(payload,'$.identity.messageId')=? AND json_extract(payload,'$.summary') IS NOT NULL LIMIT 1").get(run.id, identity.backendId, identity.attemptId, identity.messageId)
      : this.runs.db.prepare("SELECT 1 FROM run_process_records WHERE run_id=? AND kind='backend.progress' AND json_extract(payload,'$.threadId')=? AND json_extract(payload,'$.turnId')=? AND json_extract(payload,'$.summary.itemId')=? LIMIT 1").get(run.id, snapshot.threadId, snapshot.turnId, progress.itemId ?? null));
    const identified = identity || (!backendId || backendId === 'codex') && snapshot.threadId && snapshot.turnId && progress && identifier(progress.itemId);
    const summary = content && !duplicate && identified && progress && ['commentary', 'final_answer'].includes(progress.phase)
      ? { source: 'agentMessage', ...(identifier(progress.itemId) ? { itemId: progress.itemId } : {}), ...(identity ? { messageId: identity.messageId } : {}), phase: progress.phase, text: content } : null;
    if (!duplicate) {
      const payload = { state: snapshot.state, threadId: snapshot.threadId, turnId: snapshot.turnId, observedAt: snapshot.observedAt, ...(identity ? { identity: { ...identity } } : {}), ...(summary ? { summary } : {}), ...(snapshot.transportFailure ? { transportFailure: { kind: snapshot.transportFailure.kind, ...(snapshot.transportFailure.exitCode !== undefined ? { exitCode: snapshot.transportFailure.exitCode } : {}), ...(snapshot.transportFailure.exitSignal !== undefined ? { exitSignal: snapshot.transportFailure.exitSignal } : {}), ...(snapshot.transportFailure.observedFrameBytes !== undefined ? { observedFrameBytes: snapshot.transportFailure.observedFrameBytes } : {}) } } : {}) };
      // The same observation can arrive from a callback, an operation return
      // and every reconciliation tick, even when it has no message identity.
      const previous = this.runs.db.prepare("SELECT payload FROM run_process_records WHERE run_id=? AND kind='backend.progress' ORDER BY id DESC LIMIT 1").get(run.id);
      if (previous?.payload !== canonicalJson(payload)) context.emit({ type: 'progress', payload });
    }
    if (snapshot.state === 'completed') context.emit({ type: 'completed', result: { answer: snapshot.answer } });
    else if (snapshot.state === 'failed') context.emit({ type: 'failed', error: snapshot.reason ?? 'Backend confirmed failure' });
    else if (snapshot.state === 'cancelled') context.emit({ type: 'stopped' });
    else if (snapshot.state === 'unknown') {
      const current = this.runs.get(run.id);
      if (['preparing', 'running', 'waiting_answer', 'waiting_approval', 'cancelling'].includes(current.status)) this.runs.transition(run.id, this.runs.runtime(run.id), 'reconciling', { uncertainty: snapshot.reason ?? 'Backend outcome unknown' });
    }
  }
  /** Host callbacks are synchronous, preserving arrival order and propagating failure. */
  private callback<T>(runId: string, context: BackendContext, name: string, work: () => T): T {
    try { return work(); } catch (error) {
      if (this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId) && this.runs.runtime(runId).epoch === context.epoch) {
        this.runs.record(runId, 'backend.callback_error', { callback: name });
        const run = this.runs.get(runId);
        if (['preparing', 'running', 'waiting_answer', 'waiting_approval', 'cancelling'].includes(run.status)) this.runs.transition(runId, this.runs.runtime(runId), 'reconciling', { uncertainty: 'Backend host callback failed' });
      }
      throw error;
    }
  }
  /** Only an exact failed callback on the attached epoch can recover interaction
   * persistence. Unrelated callbacks cannot turn unknown work into running. */
  private interactionCallback(runId: string, context: BackendContext, name: 'onInteraction' | 'onInteractionCancelled', value: unknown, work: () => void): void {
    this.callback(runId, context, name, () => {
      const key = createHash('sha256').update(JSON.stringify([runId, context.epoch, name, value])).digest('hex');
      try {
        atomic(this.runs.db, () => {
          const token = this.runs.runtime(runId);
          const recovering = this.failedInteractionCallbacks.has(key) && this.contexts.get(runId)?.epoch === context.epoch
            && token.epoch === context.epoch && this.runs.get(runId).status === 'reconciling'
            && token.details.cancelRequested !== true && token.details.unresolvedCompletion !== true;
          if (recovering) this.runs.transition(runId, token, 'running');
          work();
        });
        this.failedInteractionCallbacks.delete(key);
      } catch (error) { this.failedInteractionCallbacks.add(key); throw error; }
    });
  }
  private active(runId: string, context: BackendContext): void {
    const token = this.runs.runtime(runId);
    if (token.epoch !== context.epoch || token.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(this.runs.get(runId).status)) throw new ServiceError('CONFLICT', 'Run is no longer available for host callbacks');
  }
  /** Timeouts reject visibly; late skill resolution cannot dispatch a command. */
  private async asyncCallback<T>(runId: string, context: BackendContext, name: string, work: (check: () => void) => Promise<T> | T): Promise<T> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (expired) throw new ServiceError('CONFLICT', 'Host callback expired');
      this.active(runId, context);
    };
    try {
      check();
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(new ServiceError('CONFLICT', 'Host callback timed out')); }, this.callbackTimeoutMs); });
      const result = await Promise.race([Promise.resolve().then(() => work(check)), timeout]);
      check();
      return result;
    } catch (error) {
      if (this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId) && this.runs.runtime(runId).epoch === context.epoch) this.runs.record(runId, 'backend.callback_error', { callback: name, timedOut: expired });
      throw error;
    } finally { expired = true; if (timer !== undefined) clearTimeout(timer); }
  }
  private interaction(value: BackendInteraction, context: BackendContext, runId: string): void {
    if (!this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId)) return;
    const token = this.runs.runtime(runId); const run = this.runs.get(runId);
    if (token.epoch !== context.epoch || token.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(run.status)) return;
    if (!identifier(value.id) || !['question', 'approval'].includes(value.kind) || JSON.stringify(value).length > 65536 || !Array.isArray(value.questions) || value.questions.length > 32) throw new ServiceError('INVALID_REQUEST', 'Invalid or unbounded backend interaction');
    if (value.kind === 'question' && ((!value.questions.length && !value.form) || new Set(value.questions.map(question => question.id)).size !== value.questions.length || value.questions.some(question => !identifier(question.id) || typeof question.text !== 'string' || !question.text.trim() || question.text.length > 16000 || !Array.isArray(question.options) || question.options.length > 64 || question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 16000) || question.mode !== undefined && !['text', 'single', 'multiple'].includes(question.mode) || question.allowOther !== undefined && typeof question.allowOther !== 'boolean'))) throw new ServiceError('INVALID_REQUEST', 'Invalid backend question group');
    const form = value.form === undefined ? undefined : validateAgentForm(value.form);
    const hostId = 'backend-' + createHash('sha256').update(JSON.stringify([runId, context.epoch, value.id])).digest('hex');
    const canApprove = value.canApprove === true && (value.details === undefined || approvableDetails(value.details));
    const details = value.details;
    // Project only the public contract; adapter-private fields never become history.
    const payload = JSON.parse(JSON.stringify({ id: hostId, kind: value.kind, reason: value.reason, command: value.command, canApprove,
      questions: value.questions.map(question => ({ id: question.id, text: question.text, options: question.options, ...(question.mode !== undefined ? { mode: question.mode } : {}), ...(question.allowOther !== undefined ? { allowOther: question.allowOther } : {}) })),
      ...(details !== undefined ? { details: object(details) ? { version: details.version, kind: details.kind, summary: details.summary, ...(details.command !== undefined ? { command: details.command } : {}), ...(details.paths !== undefined ? { paths: details.paths } : {}), ...(details.permissions !== undefined ? { permissions: details.permissions } : {}), ...(details.scope !== undefined ? { scope: details.scope } : {}) } : details } : {}),
      ...(form ? { form } : {}), backendInteractionId: value.id, attemptId: context.epoch })) as Json;
    const prior = this.runs.db.prepare('SELECT id FROM interactions WHERE id=? AND run_id=?').get(hostId, runId);
    if (prior) {
      const stored = this.runs.interaction(hostId);
      const stable = (item: Json): string => JSON.stringify(item, (_key, entry: unknown) => object(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
      if (stored.kind !== value.kind || stable(stored.payload) !== stable(payload)) throw new ServiceError('CONFLICT', 'Backend interaction identity reused');
      return;
    }
    if (run.status === 'preparing') context.emit({ type: 'started' });
    context.emit({ type: value.kind, id: hostId, payload });
  }
  async start(run: Run, snapshot: InputSnapshot, context: BackendContext): Promise<void> {
    if (this.runs.db.isTransaction) throw new ServiceError('CONFLICT', 'Backend preparation must run outside transactions');
    if (snapshot.imageRoute?.type === 'api' || !snapshot.model) throw new ServiceError('INVALID_REQUEST', 'Agent backend cannot execute an API image snapshot');
    this.contexts.set(run.id, context);
    const runtime = this.runs.runtime(run.id); const path = String(runtime.details.canonicalPath);
    // All checks before adapter.start are known not to have spawned a backend.
    let directories: ReturnType<typeof runDirectories>;
    let inputFiles: Awaited<ReturnType<typeof materializeInputs>>['files'];
    let upstreamContext: RunLineage | undefined;
    try {
      if (snapshot.skills?.length) {
        if (!this.skillSessions) throw new ServiceError('INPUT_BLOCKED', '冻结技能上下文不可用。');
        await this.skillSessions.environment(snapshot.skills, true);
      }
      if (runtime.details.kind === 'execution') upstreamContext = this.runContexts.lineage(run.id);
      const inspect = await this.probe.inspect([path]);
      if (inspect(path).canonicalPath !== path) throw new ServiceError('PROJECT_UNAVAILABLE', 'Project canonical path changed');
      const projectFiles = snapshot.projectFiles ?? [];
      if (projectFiles.length) {
        const states = await new ProjectFiles(this.runs.db).stat(run.projectId, projectFiles.map(item => item.relativePath));
        const unavailable = states.find(item => item.state !== 'available');
        if (unavailable) throw new ServiceError(unavailable.state === 'missing' ? 'INPUT_BLOCKED' : 'PROJECT_UNAVAILABLE', '项目文件引用当前不可读：' + unavailable.path);
      }
      directories = runDirectories(this.dirs, run.id);
      const inputs = await materializeInputs(snapshot, { inputDirectory: directories.input, blobDirectory: this.dirs.blobs, resolveBlobPath: sha256 => {
        const row = this.runs.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(sha256);
        if (!row) throw new ServiceError('INPUT_BLOCKED', 'Frozen blob file not registered');
        return String(row.path);
      } });
      inputFiles = inputs.files;
      // Keep the materialized snapshot self-contained. Agents are told to inspect
      // this file, so omitting the frozen prompt makes an input with no references
      // look like an empty task even though the prompt is supplied to turn/start.
      const manifest = JSON.stringify({ ...snapshot, projectFiles: snapshot.projectFiles ?? [], files: inputs.files }, null, 2);
      const file = await open(join(directories.input, 'snapshot.json'), 'wx', 0o400);
      try { await file.writeFile(manifest); await file.sync(); } finally { await file.close(); }
      if (upstreamContext) {
        const lineageFile = await open(join(directories.input, 'upstream-context.json'), 'wx', 0o400);
        try { await lineageFile.writeFile(JSON.stringify(upstreamContext, null, 2)); await lineageFile.sync(); } finally { await lineageFile.close(); }
      }
      // Recheck immediately before actual spawn, after asynchronous materialization.
      const finalInspect = await this.probe.inspect([path]);
      const currentPath = this.runs.db.prepare('SELECT canonical_path,state FROM projects WHERE id=?').get(run.projectId);
      if (finalInspect(path).canonicalPath !== path || currentPath?.canonical_path !== path || currentPath.state !== 'active') throw new ServiceError('PROJECT_UNAVAILABLE', 'Project path/state changed before launch');
    } catch (error) {
      if (this.runs.get(run.id).status === 'cancelling') context.emit({ type: 'stopped' });
      else context.emit({ type: 'failed', error: error instanceof Error ? error.message : 'Input preflight failed' });
      return;
    }
    if (this.runs.runtime(run.id).epoch !== context.epoch) return;
    if (this.runs.get(run.id).status === 'cancelling') { context.emit({ type: 'stopped' }); return; }
    const result = await this.adapter.start({ runId: run.id, kind: runtime.details.kind as 'execution' | 'text_generation' | 'image_generation' | 'visualize_generation', projectPath: path, inputPath: directories.input, outputPath: directories.output, serviceRoot: this.dirs.root, prompt: snapshot.prompt, resources: snapshot.resources, projectFiles: snapshot.projectFiles ?? [], files: inputFiles!, model: snapshot.agent?.model ?? snapshot.model, attemptId: context.epoch, ...(snapshot.agent ? { agent: structuredClone(snapshot.agent) } : {}), skills: snapshot.skills ?? [], features: snapshot.features ?? [], ...(snapshot.visualizeGeneration ? { visualizeGeneration: snapshot.visualizeGeneration } : {}), ...(upstreamContext ? {upstreamContext} : {}), ...(snapshot.imageRoute?.type==='codex'&&snapshot.imageRoute.options?{imageOptions:snapshot.imageRoute.options}:{}), ...(!snapshot.agent || snapshot.agent.backendId === 'codex' ? { sandboxMode: sandboxMode(runtime.details.sandboxMode ?? 'read-only') } : {}) }, {
      onSnapshot: value => this.callback(run.id, context, 'onSnapshot', () => this.snapshot(value, context, run.id)),
      ...(this.runs.shouldGenerateNodeTitle(run.id) ? { setNodeTitle: (title: string) => {
        const token = this.runs.runtime(run.id);
        if (token.epoch !== context.epoch) return false;
        return this.runs.updateNodeTitle(run.id, token, title);
      } } : {}),
      onInteraction: value => this.interactionCallback(run.id, context, 'onInteraction', value, () => this.interaction(value, context, run.id)),
      onInteractionCancelled: id => this.interactionCallback(run.id, context, 'onInteractionCancelled', id, () => {
        if (!identifier(id)) throw new ServiceError('INVALID_REQUEST', 'Invalid cancelled interaction identity');
        const hostId = 'backend-' + createHash('sha256').update(JSON.stringify([run.id, context.epoch, id])).digest('hex');
        this.runs.expireInteraction(run.id, this.runs.runtime(run.id), hostId);
      }),
      queryHistory: query => this.asyncCallback(run.id, context, 'queryHistory', () => this.queryHistory(run.id, query)),
      readRunContext: request => this.asyncCallback(run.id, context, 'readRunContext', () => this.runContexts.read(run.id, request)),
      ...(this.visualizePreviews && (runtime.details.kind === 'visualize_generation' || runtime.details.kind === 'execution' && hasVisualizeFeature(snapshot.features)) ? {
        previewVisualizeOutput: (pagePath: string) => this.asyncCallback(run.id, context, 'previewVisualizeOutput', check => this.visualizePreviews!.create(run.id, context.epoch, pagePath, check)),
        inspectVisualizePreview: (sessionId: string) => this.asyncCallback(run.id, context, 'inspectVisualizePreview', () => this.visualizePreviews!.inspect(run.id, context.epoch, sessionId)),
        closeVisualizePreview: (sessionId: string) => this.asyncCallback(run.id, context, 'closeVisualizePreview', () => this.visualizePreviews!.release(run.id, context.epoch, sessionId)),
      } : {}),
      ...(runtime.details.kind === 'visualize_generation' || runtime.details.kind === 'execution' && hasVisualizeFeature(snapshot.features) ? { validateVisualizeOutput: (pagePath: string) => this.asyncCallback(run.id, context, 'validateVisualizeOutput', async () => {
        const current = this.runs.runtime(run.id);
        if (current.epoch !== context.epoch || current.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(this.runs.get(run.id).status)) throw new ServiceError('CONFLICT', 'Run is no longer available for output validation.');
        const result = await validateVisualizeOutput(directories.output, pagePath, runtime.details.kind as 'execution' | 'visualize_generation');
        const after = this.runs.runtime(run.id);
        if (after.epoch !== context.epoch || after.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(this.runs.get(run.id).status)) throw new ServiceError('CONFLICT', 'Run changed during output validation.');
        return result;
      }) } : {}),
      ...(this.skillSessions ? { skillEnvironment: (skillId: string) => this.asyncCallback(run.id, context, 'skillEnvironment', () => this.skillSessions!.forSkill(snapshot.skills ?? [], skillId)) } : {}),
      ...(this.skillSessions ? { withSkillEnvironment: <T>(skillId: string | null, dispatch: (environment: Record<string,string>, secrets: Record<string,string>) => T) => this.asyncCallback(run.id, context, 'withSkillEnvironment', check => this.skillSessions!.withEnvironment(snapshot.skills ?? [], skillId, (environment, secrets) => { check(); return dispatch(environment, secrets); })) } : {}),
    });
    this.snapshot(result, context, run.id);
  }
  queryHistory(runId: string, query: string): string {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new ServiceError('INVALID_REQUEST', 'Bounded history query required');
    const run = this.runs.get(runId);
    // Project scope is derived from the accepted Run, never from tool arguments.
    const rows = this.runs.db.prepare("SELECT id,node_id,status,created_at,history_state FROM runs WHERE project_id=? AND (id=? OR node_id=? OR EXISTS(SELECT 1 FROM run_process_records p WHERE p.run_id=runs.id AND instr(p.payload,?)>0)) ORDER BY sequence DESC LIMIT 10").all(run.projectId, query, query, query);
    return JSON.stringify(rows.map(row => ({ runId: row.id, nodeId: row.node_id, status: row.status, createdAt: row.created_at, historyState: row.history_state, records: row.history_state === 'cleared' ? [] : this.runs.db.prepare('SELECT kind,payload FROM run_process_records WHERE run_id=? AND instr(payload,?)>0 ORDER BY id DESC LIMIT 10').all(String(row.id), query).map(record => ({ kind: record.kind, payload: String(record.payload).slice(0, 1600) })) }))).slice(0, 30000);
  }
  async cancel(run: Run, context: BackendContext): Promise<'confirmed' | 'unknown'> {
    const result = await this.adapter.cancel(run.id); if (!this.accepts(result, context, run.id)) return 'unknown'; this.snapshot(result, context, run.id);
    return ['cancelled', 'failed', 'completed'].includes(result.state) ? 'confirmed' : 'unknown';
  }
  async reply(run: Run, interaction: Interaction, answer: Json, context: BackendContext): Promise<void> {
    if (interaction.runId !== run.id || interaction.epoch !== context.epoch || this.runs.runtime(run.id).epoch !== context.epoch) throw new ServiceError('CONFLICT', 'Stale interaction responder');
    const payload = interaction.payload;
    const nativeId = object(payload) && identifier(payload.backendInteractionId) ? payload.backendInteractionId : interaction.id;
    const result = await this.adapter.respond(run.id, nativeId, backendReply(interaction, answer));
    if (!this.accepts(result, context, run.id) || result.state === 'unknown') throw new ServiceError('CONFLICT', 'Reply delivery outcome unknown');
    this.snapshot(result, context, run.id);
  }
  async reconcile(run: Run, context: BackendContext): Promise<ReconcileResult> {
    try {
      const result = await this.adapter.reconcile(run.id);
      if (!this.accepts(result, context, run.id)) return 'unknown';
      this.snapshot(result, context, run.id);
      if (result.state === 'cancelled' || result.state === 'failed' || result.state === 'interrupted') return 'interrupted';
      if (result.state === 'completed') {
        const token = this.runs.runtime(run.id);
        if (token.details.unresolvedCompletion === true && token.details.cancelRequested !== true) return 'unknown';
        if (token.epoch === context.epoch && this.runs.get(run.id).status === 'reconciling' && token.details.cancelRequested !== true) this.runs.transition(run.id, token, 'agent_completed', { result: { answer: result.answer } });
        else if (token.details.cancelRequested === true) return 'interrupted';
        return 'unknown';
      }
      // Only an adapter attached by THIS bridge has an original responder.
      if (result.state === 'running' && this.contexts.get(run.id)?.epoch === context.epoch) return 'resumed';
      return 'unknown';
    } catch {
      if (this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(run.id) && this.runs.runtime(run.id).epoch === context.epoch) this.runs.record(run.id, 'backend.reconcile_error', { message: 'Backend reconciliation failed' });
      return 'unknown';
    }
  }
}
