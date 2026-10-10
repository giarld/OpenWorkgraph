import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { InputSnapshot, Interaction, Json, Run } from '@openworkgraph/protocol';
import type { BackendAdapter, BackendInteraction, BackendReply, RuntimeSnapshot } from './backend/types.js';
import type { SchedulerBackend, BackendContext, ReconcileResult } from './scheduler.js';
import { Runs } from './runs.js';
import { ProjectProbe } from './project-probe.js';
import { materializeInputs } from './input-materialization.js';
import { runDirectories, type DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { publicProgressText } from './backend/adapter.js';
import { sandboxMode } from './execution-settings.js';
import { ProjectFiles } from './project-files.js';
import { RunContexts, type RunLineage } from './run-context.js';
import type { SkillSessions } from './skill-sessions.js';
import { hasVisualizeFeature } from './visualize-features.js';
import { validateVisualizeOutput } from './visualize-output-validation.js';

export function backendReply(interaction: Interaction, answer: Json): BackendReply {
  const payload = interaction.payload as unknown as BackendInteraction;
  if (interaction.kind === 'approval') {
    const decision = typeof answer === 'boolean' ? (answer ? 'accept' : 'decline') : answer && typeof answer === 'object' && !Array.isArray(answer) && answer.kind === 'approval' ? answer.decision : null;
    if (!['accept', 'decline'].includes(String(decision)) || (decision === 'accept' && !payload?.canApprove)) throw new ServiceError('INVALID_REQUEST', 'Approval is not permitted for this action');
    return { kind: 'approval', decision: decision as 'accept' | 'decline' };
  }
  const ids = payload?.questions?.map(question => question.id) ?? [];
  const answers = typeof answer === 'string' && ids.length === 1 ? { [ids[0]!]: [answer] } : answer && typeof answer === 'object' && !Array.isArray(answer) && answer.kind === 'question' ? answer.answers : null;
  if (!ids.length || !answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== ids.length || ids.some(id => !Array.isArray(answers[id]) || !(answers[id] as Json[]).length || (answers[id] as Json[]).some(value => typeof value !== 'string' || !value.trim() || value.length > 16000))) throw new ServiceError('INVALID_REQUEST', 'Answer each requested question exactly once');
  return { kind: 'question', answers: answers as Record<string, string[]> };
}

/** Trusted host bridge. Never accepts browser paths or creates isolation evidence. */
export class RuntimeBackend implements SchedulerBackend {
  private readonly contexts = new Map<string, BackendContext>();
  readonly runContexts: RunContexts;
  constructor(readonly runs: Runs, readonly dirs: DataDirectories, readonly adapter: BackendAdapter, readonly probe = new ProjectProbe(), readonly skillSessions?: SkillSessions) { this.runContexts = new RunContexts(runs, dirs); }
  private snapshot(snapshot: RuntimeSnapshot, context: BackendContext, expectedRunId: string): void {
    if (snapshot.runId !== expectedRunId) return;
    if (!this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(expectedRunId)) return;
    const run = this.runs.get(snapshot.runId); const token = this.runs.runtime(run.id);
    if (token.epoch !== context.epoch) return;
    if (snapshot.state === 'starting') return;
    if (run.status === 'preparing') context.emit({ type: 'started', identity: { threadId: snapshot.threadId, turnId: snapshot.turnId } });
    const progress = snapshot.progress;
    const content = progress && publicProgressText(progress.text);
    // Persistent identity deduplication also covers start/respond return snapshots and reconciliation.
    const duplicate = progress && this.runs.db.prepare("SELECT 1 FROM run_process_records WHERE run_id=? AND kind='backend.progress' AND json_extract(payload,'$.threadId')=? AND json_extract(payload,'$.turnId')=? AND json_extract(payload,'$.summary.itemId')=? LIMIT 1").get(run.id, snapshot.threadId, snapshot.turnId, progress.itemId);
    const summary = content && !duplicate && snapshot.threadId && snapshot.turnId && progress && typeof progress.itemId === 'string' && progress.itemId.length > 0 && progress.itemId.length <= 200 && ['commentary', 'final_answer'].includes(progress.phase)
      ? { source: 'agentMessage', itemId: progress.itemId, phase: progress.phase, text: content } : null;
    context.emit({ type: 'progress', payload: { state: snapshot.state, threadId: snapshot.threadId, turnId: snapshot.turnId, observedAt: snapshot.observedAt, ...(summary ? { summary } : {}), ...(snapshot.transportFailure ? { transportFailure: { kind: snapshot.transportFailure.kind, ...(snapshot.transportFailure.exitCode !== undefined ? { exitCode: snapshot.transportFailure.exitCode } : {}), ...(snapshot.transportFailure.exitSignal !== undefined ? { exitSignal: snapshot.transportFailure.exitSignal } : {}), ...(snapshot.transportFailure.observedFrameBytes !== undefined ? { observedFrameBytes: snapshot.transportFailure.observedFrameBytes } : {}) } } : {}) } });
    if (snapshot.state === 'completed') context.emit({ type: 'completed', result: { answer: snapshot.answer } });
    else if (snapshot.state === 'failed') context.emit({ type: 'failed', error: snapshot.reason ?? 'Backend confirmed failure' });
    else if (snapshot.state === 'cancelled') context.emit({ type: 'stopped' });
    else if (snapshot.state === 'unknown') {
      const current = this.runs.get(run.id);
      if (['preparing', 'running', 'waiting_answer', 'waiting_approval', 'cancelling'].includes(current.status)) this.runs.transition(run.id, this.runs.runtime(run.id), 'reconciling', { uncertainty: snapshot.reason ?? 'Backend outcome unknown' });
    }
  }
  async start(run: Run, snapshot: InputSnapshot, context: BackendContext): Promise<void> {
    if (this.runs.db.isTransaction) throw new ServiceError('CONFLICT', 'Backend preparation must run outside transactions');
    if (snapshot.imageRoute?.type === 'api' || !snapshot.model) throw new ServiceError('INVALID_REQUEST', 'Codex backend cannot execute an API image snapshot');
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
    const result = await this.adapter.start({ runId: run.id, kind: runtime.details.kind as 'execution' | 'text_generation' | 'image_generation' | 'visualize_generation', projectPath: path, inputPath: directories.input, outputPath: directories.output, serviceRoot: this.dirs.root, prompt: snapshot.prompt, resources: snapshot.resources, projectFiles: snapshot.projectFiles ?? [], files: inputFiles!, model: snapshot.model, skills: snapshot.skills ?? [], features: snapshot.features ?? [], ...(snapshot.visualizeGeneration ? { visualizeGeneration: snapshot.visualizeGeneration } : {}), ...(upstreamContext ? {upstreamContext} : {}), ...(snapshot.imageRoute?.type==='codex'&&snapshot.imageRoute.options?{imageOptions:snapshot.imageRoute.options}:{}), sandboxMode: sandboxMode(runtime.details.sandboxMode ?? 'read-only') }, {
      onSnapshot: value => this.snapshot(value, context, run.id),
      ...(this.runs.shouldGenerateNodeTitle(run.id) ? { setNodeTitle: (title: string) => {
        const token = this.runs.runtime(run.id);
        if (token.epoch !== context.epoch) return false;
        return this.runs.updateNodeTitle(run.id, token, title);
      } } : {}),
      onInteraction: value => {
        if (!this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(run.id)) return;
        const token = this.runs.runtime(run.id);
        if (token.epoch !== context.epoch || token.details.cancelRequested === true) return;
        if (this.runs.db.prepare('SELECT 1 FROM interactions WHERE id=? AND run_id=?').get(value.id, run.id)) return;
        if (this.runs.get(run.id).status === 'preparing') context.emit({ type: 'started' });
        context.emit({ type: value.kind, id: value.id, payload: JSON.parse(JSON.stringify(value)) as Json });
      },
      queryHistory: async query => this.queryHistory(run.id, query),
      readRunContext: async request => this.runContexts.read(run.id, request),
      ...(runtime.details.kind === 'visualize_generation' || runtime.details.kind === 'execution' && hasVisualizeFeature(snapshot.features) ? { validateVisualizeOutput: async (pagePath: string) => {
        const current = this.runs.runtime(run.id);
        if (current.epoch !== context.epoch || current.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(this.runs.get(run.id).status)) throw new ServiceError('CONFLICT', 'Run is no longer available for output validation.');
        const result = await validateVisualizeOutput(directories.output, pagePath, runtime.details.kind as 'execution' | 'visualize_generation');
        const after = this.runs.runtime(run.id);
        if (after.epoch !== context.epoch || after.details.cancelRequested === true || !['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(this.runs.get(run.id).status)) throw new ServiceError('CONFLICT', 'Run changed during output validation.');
        return result;
      } } : {}),
      ...(this.skillSessions ? { skillEnvironment: async (skillId: string) => this.skillSessions!.forSkill(snapshot.skills ?? [], skillId) } : {}),
      ...(this.skillSessions ? { withSkillEnvironment: <T>(skillId: string | null, dispatch: (environment: Record<string,string>, secrets: Record<string,string>) => T) => this.skillSessions!.withEnvironment(snapshot.skills ?? [], skillId, dispatch) } : {}),
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
    const result = await this.adapter.cancel(run.id); if (result.runId !== run.id) return 'unknown'; this.snapshot(result, context, run.id);
    return ['cancelled', 'failed', 'completed'].includes(result.state) ? 'confirmed' : 'unknown';
  }
  async reply(run: Run, interaction: Interaction, answer: Json, context: BackendContext): Promise<void> {
    const result = await this.adapter.respond(run.id, interaction.id, backendReply(interaction, answer));
    if (result.runId !== run.id || result.state === 'unknown') throw new ServiceError('CONFLICT', 'Reply delivery outcome unknown');
    this.snapshot(result, context, run.id);
  }
  async reconcile(run: Run, context: BackendContext): Promise<ReconcileResult> {
    try {
      const result = await this.adapter.reconcile(run.id);
      if (result.runId !== run.id) return 'unknown';
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
    } catch { return 'unknown'; }
  }
}
