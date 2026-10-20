import { isTerminalRunStatus, AGENT_FAILURE_REASONS } from '@openworkgraph/protocol';
import type { InputSnapshot, Interaction, Json, Run, AgentPlatform, AgentFailureReason } from '@openworkgraph/protocol';
import type { BackendAdapter, BackendCallbacks, RuntimeSnapshot } from '../backend/types.js';
import type { SchedulerBackend, BackendContext, ReconcileResult } from '../scheduler.js';
import type { DataDirectories } from '../directories.js';
import type { SkillSessions } from '../skill-sessions.js';
import type { ProjectProbe } from '../project-probe.js';
import { RuntimeBackend } from '../runtime-backend.js';
import type { VisualizePreviews } from '../visualize-preview.js';
import { Runs } from '../runs.js';
import { redactSkillValues } from '../backend/redaction.js';
import { AgentError, agentError as normalizeAgentError } from './errors.js';
import type { AgentAdapter, AgentPlugin, AgentExecutionSelection } from './contracts.js';
import { evaluateAgentTask } from './registry.js';

interface AttachedAgent {
  attemptId: string; backendId: string; selection: AgentExecutionSelection; controller: AbortController;
  adapter?: AgentAdapter; bridge?: RuntimeBackend; started: boolean; sideEffects: boolean;
  starting: boolean; startSettled: boolean; work: Set<Promise<unknown>>;
  last?: RuntimeSnapshot; pending: number; callbackBytes: number; callbacks: Promise<void>; callbackError?: AgentError;
  extensionContext?: import('./contracts.js').AgentExtensionContext;
  secrets: Record<string, string>; secretValues: Set<string>;
  failureVersion: number; reported: Set<string>; released: boolean; disposed: boolean;
  releaseWork?: Promise<void>; disposeWork?: Promise<void>; cleaning?: Promise<void>;
}
export interface AgentRouterOptions { timeoutMs?: number; abortGraceMs?: number; pollMs?: number; callbackLimit?: number }
const terminal = (snapshot: RuntimeSnapshot | undefined) => snapshot !== undefined && ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state);
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
/** Freeze detached host data, not AbortSignal internals or callback functions. */
function immutable<T>(value: T): T {
  if (value === null || typeof value !== 'object' || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}
function agentError(error: unknown, fallback: AgentFailureReason = 'protocol_error'): AgentError {
  const reasons: readonly string[] = AGENT_FAILURE_REASONS;
  let reason = fallback;
  try { if (error instanceof AgentError) { const nativeReason = error.reason; if (reasons.includes(nativeReason)) reason = nativeReason; } } catch { /* Native error getters are not public diagnostics. */ }
  return normalizeAgentError(new AgentError(reason), fallback);
}

/** Static host composition. Attachment/control always use the original instance. */
export class AgentRouter implements SchedulerBackend {
  private readonly attached = new Map<string, AttachedAgent>();
  private readonly restartWork = new Map<string, Promise<'drained' | 'unknown'>>();
  private readonly options: Required<AgentRouterOptions>;
  constructor(readonly runs: Runs, readonly directories: DataDirectories, private readonly plugin: (id: string) => AgentPlugin, private readonly assertFrozen: (snapshot: InputSnapshot, kind: Run['status'] | string) => void, private readonly legacy: SchedulerBackend, private readonly probe: ProjectProbe, private readonly skills: SkillSessions, options: AgentRouterOptions = {}, private readonly compatibility?: (run: Run, snapshot: InputSnapshot) => AgentExecutionSelection, private readonly visualizePreviews?: VisualizePreviews) {
    this.options = { timeoutMs: options.timeoutMs ?? 30000, abortGraceMs: options.abortGraceMs ?? 1000, pollMs: options.pollMs ?? 25, callbackLimit: options.callbackLimit ?? 256 };
    if (Object.values(this.options).some(value => !Number.isSafeInteger(value) || value < 1) || this.options.timeoutMs > 60000 || this.options.abortGraceMs > 60000 || this.options.pollMs > 1000 || this.options.callbackLimit > 256) throw new AgentError('invalid_configuration');
  }
  private owned(id: string, entry: AttachedAgent): boolean {
    return this.attached.get(id) === entry && Boolean(this.runs.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id)) && this.runs.runtime(id).epoch === entry.attemptId;
  }
  private accepting(id: string, entry: AttachedAgent): boolean {
    return this.owned(id, entry) && !entry.disposed && !isTerminalRunStatus(this.runs.get(id).status) && !['agent_completed', 'finalizing'].includes(this.runs.get(id).status);
  }
  private record(id: string, entry: AttachedAgent, kind: string, operation: string, error: unknown): AgentError {
    const safe = agentError(error); const key = kind + '/' + operation + '/' + safe.reason;
    if (this.owned(id, entry) && !entry.reported.has(key)) { this.runs.record(id, kind, { operation, reason: safe.reason }); entry.reported.add(key); }
    return safe;
  }
  private callbackFailure(id: string, entry: AttachedAgent, name: string, error: unknown): AgentError {
    const safe = this.record(id, entry, 'agent.callback_error', name, error);
    entry.callbackError ??= safe; entry.failureVersion++;
    if (this.accepting(id, entry)) {
      const run = this.runs.get(id);
      if (['preparing', 'running', 'waiting_answer', 'waiting_approval', 'cancelling'].includes(run.status)) this.runs.transition(id, this.runs.runtime(id), 'reconciling', { uncertainty: safe.message });
    }
    return safe;
  }
  /** Track underlying settlement separately from a caller's timeout/abort. */
  private track<T>(entry: AttachedAgent, work: () => T | Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(work); entry.work.add(promise);
    void promise.then(() => entry.work.delete(promise), () => entry.work.delete(promise));
    return promise;
  }
  private bounded<T>(entry: AttachedAgent, promise: Promise<T>, preparation = false, timeoutMs = this.options.timeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined; let abortReason: AgentError | undefined;
      const finish = () => { clearTimeout(deadline); if (grace !== undefined) clearTimeout(grace); entry.controller.signal.removeEventListener('abort', abort); };
      const abort = () => {
        abortReason = agentError(entry.controller.signal.reason, 'outcome_unknown');
        clearTimeout(deadline);
        if (grace === undefined) grace = setTimeout(() => { finish(); reject(new AgentError('outcome_unknown')); }, this.options.abortGraceMs);
      };
      const deadline = setTimeout(() => {
        if (preparation) { if (!entry.controller.signal.aborted) entry.controller.abort(new AgentError('timeout')); else abort(); }
        else { finish(); reject(new AgentError('outcome_unknown')); }
      }, timeoutMs);
      if (preparation) { entry.controller.signal.addEventListener('abort', abort, { once: true }); if (entry.controller.signal.aborted) abort(); }
      promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(abortReason ?? agentError(error)); });
    });
  }
  private preparing(id: string, entry: AttachedAgent): void {
    if (!this.accepting(id, entry) || entry.controller.signal.aborted || entry.callbackError || this.runs.runtime(id).details.cancelRequested === true) throw new AgentError('outcome_unknown');
  }
  private check(id: string, entry: AttachedAgent, value: RuntimeSnapshot): RuntimeSnapshot {
    const selection = entry.selection;
    if (!value || value.runId !== id || value.backendId !== undefined && value.backendId !== entry.backendId || value.attemptId !== undefined && value.attemptId !== entry.attemptId || value.identity && (value.identity.backendId !== entry.backendId || value.identity.attemptId !== entry.attemptId || !identifier(value.identity.messageId) || value.identity.sessionId !== undefined && !identifier(value.identity.sessionId) || value.identity.turnId !== undefined && !identifier(value.identity.turnId))) throw new AgentError('protocol_error');
    if (!['starting', 'running', 'waiting_answer', 'waiting_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(value.state) || typeof value.answer !== 'string' || !value.model || value.model.model !== selection.model.model || value.model.reasoningEffort !== selection.model.reasoningEffort || typeof value.observedAt !== 'string' || value.observedAt.length > 64 || !Number.isFinite(Date.parse(value.observedAt)) || value.threadId !== null && !identifier(value.threadId) || value.turnId !== null && !identifier(value.turnId)) throw new AgentError('protocol_error');
    const diagnostic = value.transportFailure;
    if (value.failureReason !== undefined && !(AGENT_FAILURE_REASONS as readonly string[]).includes(value.failureReason)) throw new AgentError('protocol_error');
    if (diagnostic !== undefined && (!diagnostic || !['process_exit', 'spawn_error', 'stdin_error', 'frame_too_large', 'invalid_frame', 'rpc_timeout', 'host_close'].includes(diagnostic.kind) || diagnostic.exitCode !== undefined && diagnostic.exitCode !== null && !Number.isSafeInteger(diagnostic.exitCode) || diagnostic.exitSignal !== undefined && diagnostic.exitSignal !== null && (typeof diagnostic.exitSignal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(diagnostic.exitSignal)) || diagnostic.observedFrameBytes !== undefined && (!Number.isSafeInteger(diagnostic.observedFrameBytes) || diagnostic.observedFrameBytes < 0))) throw new AgentError('protocol_error');
    // Native diagnostics are not public history; preserve only bounded categories.
    if (value.progress !== undefined && typeof value.progress.text !== 'string') throw new AgentError('protocol_error');
    return { ...value, answer: redactSkillValues(value.answer, entry.secrets), ...(value.progress ? { progress: { ...value.progress, text: redactSkillValues(value.progress.text, entry.secrets) } } : {}), observedAt: new Date(value.observedAt).toISOString(), reason: value.reason === null ? null : new AgentError(value.state === 'unknown' ? 'outcome_unknown' : value.failureReason ?? 'protocol_error').message };
  }
  private callbacks(id: string, entry: AttachedAgent, callbacks: BackendCallbacks): BackendCallbacks {
    const observe = <T>(name: string, value: T, work: (copy: T) => void | Promise<void>): Promise<void> => {
      if (!this.accepting(id, entry) || terminal(entry.last)) return Promise.resolve();
      let copy: T; let bytes: number;
      try { copy = structuredClone(value); bytes = Buffer.byteLength(JSON.stringify(copy)); } catch { const failed = Promise.reject<void>(this.callbackFailure(id, entry, name, new AgentError('protocol_error'))); void failed.catch(() => {}); return failed; }
      if (entry.pending >= this.options.callbackLimit || bytes > 4 * 1024 * 1024 || entry.callbackBytes + bytes > 8 * 1024 * 1024) { const failed = Promise.reject<void>(this.callbackFailure(id, entry, name, new AgentError('protocol_error'))); void failed.catch(() => {}); return failed; }
      entry.pending++; entry.callbackBytes += bytes;
      const next = entry.callbacks.then(async () => {
        if (!this.accepting(id, entry) || terminal(entry.last)) return;
        try { await this.bounded(entry, this.track(entry, () => work(copy))); }
        catch (error) { throw this.callbackFailure(id, entry, name, error); }
      });
      entry.callbacks = next.catch(() => {}).finally(() => { entry.pending--; entry.callbackBytes -= bytes; });
      void next.catch(() => {}); return next;
    };
    return { ...callbacks,
      onSnapshot: value => observe('onSnapshot', value, async copy => {
        const checked = this.check(id, entry, copy);
        const failures = entry.failureVersion;
        entry.sideEffects = true;
        // A terminal notification cannot release a still-settling start/preparation.
        await callbacks.onSnapshot(terminal(checked) && !entry.startSettled ? { ...checked, state: 'running' } : checked);
        if (this.owned(id, entry) && entry.failureVersion === failures) entry.last = checked;
      }),
      onInteraction: value => observe('onInteraction', value, async copy => { entry.sideEffects = true; await callbacks.onInteraction(copy); }),
      ...(callbacks.onInteractionCancelled ? { onInteractionCancelled: (value: string) => observe('onInteractionCancelled', value, async copy => { if (!identifier(copy)) throw new AgentError('protocol_error'); entry.sideEffects = true; await callbacks.onInteractionCancelled!(copy); }) } : {}),
      ...(callbacks.setNodeTitle ? { setNodeTitle: async (title: string) => {
        if (typeof title !== 'string' || !this.accepting(id, entry) || terminal(entry.last) || entry.controller.signal.aborted) return false;
        try {
          const timeoutMs = Math.max(1, Math.min(1000, Math.floor(this.options.timeoutMs / 2)));
          return await this.bounded(entry, Promise.resolve().then(() => this.accepting(id, entry) && !terminal(entry.last) ? callbacks.setNodeTitle!(redactSkillValues(title, entry.secrets)) : false), false, timeoutMs);
        } catch (error) { this.record(id, entry, 'agent.title_error', 'setNodeTitle', error); return false; }
      } } : {}),
      ...(callbacks.withSkillEnvironment ? { withSkillEnvironment: <T>(skillId: string | null, dispatch: (environment: Record<string, string>, secrets: Record<string, string>) => T) => callbacks.withSkillEnvironment!(skillId, (environment, secrets) => {
        if (!this.accepting(id, entry) || entry.controller.signal.aborted || this.runs.runtime(id).details.cancelRequested === true) throw new AgentError('outcome_unknown');
        // Retain private literal forms only, across activations of this same Run.
        // Ordinary configuration values are never added to the redaction set.
        for (const value of Object.values(secrets)) if (value && !entry.secretValues.has(value)) { entry.secretValues.add(value); entry.secrets[String(entry.secretValues.size)] = value; }
        entry.sideEffects = true; return dispatch(environment, secrets);
      }) } : {}),
    };
  }
  private async flush(entry: AttachedAgent, failureVersion?: number): Promise<void> {
    await this.bounded(entry, entry.callbacks);
    if (entry.callbackError && (failureVersion === undefined || entry.failureVersion !== failureVersion)) throw entry.callbackError;
  }
  async start(run: Run, snapshot: InputSnapshot, context: BackendContext): Promise<void> {
    const selection = snapshot.agent ?? this.compatibility?.(run, snapshot);
    if (!selection) return this.legacy.start(run, snapshot, context);
    if (this.attached.has(run.id)) throw new AgentError('outcome_unknown');
    if (this.runs.get(run.id).status !== 'preparing' || this.runs.runtime(run.id).epoch !== context.epoch) throw new AgentError('outcome_unknown');
    if (this.attached.size >= 1024) throw new AgentError('runtime_unavailable');
    const entry: AttachedAgent = { attemptId: context.epoch, backendId: selection.backendId, selection: immutable(structuredClone(selection)), controller: new AbortController(), started: false, sideEffects: false, starting: true, startSettled: false, work: new Set(), pending: 0, callbackBytes: 0, callbacks: Promise.resolve(), secrets: Object.create(null) as Record<string, string>, secretValues: new Set(), failureVersion: 0, reported: new Set(), released: false, disposed: false };
    // Reserve before calling a possibly asynchronous factory, including duplicate starts.
    this.attached.set(run.id, entry);
    const poll = setInterval(() => {
      try { if (!this.owned(run.id, entry) || this.runs.runtime(run.id).details.cancelRequested === true) entry.controller.abort(new AgentError('outcome_unknown')); }
      catch { entry.controller.abort(new AgentError('outcome_unknown')); }
    }, this.options.pollMs); poll.unref();
    try {
      this.preparing(run.id, entry);
      let plugin: AgentPlugin;
      try { this.assertFrozen(snapshot, String(this.runs.runtime(run.id).details.kind)); plugin = this.plugin(entry.backendId); } catch (error) { throw agentError(error, 'runtime_unavailable'); }
      const factory = this.track(entry, async () => {
        let adapter: AgentAdapter;
        const dependencies = immutable({ runId: run.id, attemptId: context.epoch, selection: immutable(structuredClone(entry.selection)), platform: process.platform as AgentPlatform, signal: entry.controller.signal });
        try { adapter = await plugin.createAdapter(dependencies); } catch (error) { throw agentError(error, 'runtime_unavailable'); }
        entry.adapter = adapter;
        for (const method of ['start', 'cancel', 'respond', 'reconcile', 'releaseRun', 'disposeUnstarted', 'disposeDrained'] as const) if (typeof adapter?.[method] !== 'function') throw new AgentError('protocol_error');
        return adapter;
      });
      const adapter = await this.bounded(entry, factory, true); this.preparing(run.id, entry);
      const guarded: BackendAdapter = {
        start: async (input, callbacks) => {
          this.preparing(run.id, entry);
          // RuntimeBackend may freeze business forms and predecessor resources at
          // launch. Recheck the actual complete input before any native dispatch.
          if (input.model.model !== entry.selection.model.model || input.model.reasoningEffort !== entry.selection.model.reasoningEffort) throw new AgentError('invalid_configuration');
          const resources = input.resources ?? snapshot.resources, projectFiles = input.projectFiles ?? snapshot.projectFiles ?? [];
          const availability = evaluateAgentTask(plugin, { kind: input.kind, platform: process.platform as AgentPlatform, options: entry.selection.options, model: entry.selection.model, inputKinds: [...new Set([...resources.map(resource => resource.kind), ...projectFiles.map(file => file.kind)])], resources, projectFiles, skills: input.skills ?? [], visualize: input.kind === 'execution' && !!input.features?.length });
          if (availability.status !== 'available') throw new AgentError(availability.reason ?? 'runtime_unavailable');
          // No current registry/settings lookup after attachment: the accepted selection is final.
          const nativeCallbacks = this.callbacks(run.id, entry, callbacks);
          const frozenInput = immutable(structuredClone({ ...input, agent: entry.selection, attemptId: context.epoch }));
          const extensionContext = { runId: run.id, attemptId: context.epoch, signal: entry.controller.signal, context: frozenInput, callbacks: nativeCallbacks };
          entry.extensionContext = extensionContext;
          for (const prepare of [plugin.extensions?.configuredSkills?.prepare.bind(plugin.extensions.configuredSkills), plugin.extensions?.historyTools?.install.bind(plugin.extensions.historyTools)]) {
            if (prepare) await this.bounded(entry, this.track(entry, () => prepare(extensionContext)), true);
            this.preparing(run.id, entry);
          }
          entry.started = true;
          const nativeStart = this.track(entry, async () => {
            try { return await adapter.start(frozenInput, nativeCallbacks); } catch (error) { throw agentError(error, 'outcome_unknown'); }
            finally { entry.startSettled = true; }
          });
          const result = await this.bounded(entry, nativeStart, true); await this.flush(entry);
          if (!this.owned(run.id, entry)) throw new AgentError('outcome_unknown');
          const checked = this.check(run.id, entry, result);
          if (!terminal(entry.last)) entry.last = checked;
          return entry.last ?? checked;
        },
        cancel: async id => this.control(id, entry, 'cancel', () => adapter.cancel(id)),
        respond: async (id, interactionId, reply) => this.control(id, entry, 'respond', () => adapter.respond(id, interactionId, reply)),
        reconcile: async id => this.control(id, entry, 'reconcile', () => adapter.reconcile(id)),
      };
      entry.bridge = new RuntimeBackend(this.runs, this.directories, guarded, this.probe, this.skills, {}, this.visualizePreviews);
      await entry.bridge.start(run, snapshot, context);
    } catch (error) {
      const safe = this.record(run.id, entry, 'agent.start_error', 'start', agentError(error, 'outcome_unknown'));
      if (this.owned(run.id, entry)) {
        if (!entry.started && !entry.sideEffects && entry.work.size === 0) {
          if (this.runs.runtime(run.id).details.cancelRequested === true) context.emit({ type: 'stopped' });
          else context.emit({ type: 'failed', error: safe.message });
        } else throw new AgentError('outcome_unknown');
      }
    } finally { entry.starting = false; clearInterval(poll); }
  }
  private async control(id: string, entry: AttachedAgent, name: 'cancel' | 'respond' | 'reconcile', work: () => Promise<RuntimeSnapshot>): Promise<RuntimeSnapshot> {
    if (!this.owned(id, entry)) throw new AgentError('outcome_unknown');
    const failures = entry.failureVersion;
    try {
      const result = await this.bounded(entry, this.track(entry, work));
      await this.flush(entry, name !== 'respond' ? failures : undefined);
      if (!this.owned(id, entry)) throw new AgentError('outcome_unknown');
      const checked = this.check(id, entry, result);
      if (name === 'reconcile' && checked.state !== 'unknown' || name === 'cancel' && terminal(checked)) delete entry.callbackError;
      if (!terminal(entry.last)) entry.last = checked;
      // Keep occupancy while a timed-out factory/preparation/start might still dispatch.
      return terminal(checked) && entry.work.size ? { ...checked, state: 'unknown', reason: new AgentError('outcome_unknown').message } : checked;
    } catch (error) { throw this.record(id, entry, 'agent.control_error', name, agentError(error, 'outcome_unknown')); }
  }
  async cancel(run: Run, context: BackendContext): Promise<'confirmed' | 'unknown'> {
    if (!this.runs.snapshot(run.id).agent && !this.compatibility) return this.legacy.cancel(run, context);
    const entry = this.attached.get(run.id);
    if (!entry) return await this.recoverOriginal(run, context) === 'drained' ? 'confirmed' : 'unknown';
    if (entry.attemptId !== context.epoch || !this.owned(run.id, entry)) return 'unknown';
    entry.controller.abort(new AgentError('outcome_unknown'));
    if (entry.starting || entry.work.size && !entry.started) return 'unknown';
    if (!entry.started && !entry.sideEffects) return 'confirmed';
    if (!entry.bridge) return 'unknown';
    return entry.bridge.cancel(run, context);
  }
  async reply(run: Run, interaction: Interaction, answer: Json, context: BackendContext): Promise<void> {
    if (!this.runs.snapshot(run.id).agent && !this.compatibility) { if (!this.legacy.reply) throw new AgentError('capability_unsupported'); return this.legacy.reply(run, interaction, answer, context); }
    const entry = this.attached.get(run.id);
    if (!entry || entry.attemptId !== context.epoch || !entry.bridge || !this.owned(run.id, entry)) throw new AgentError('outcome_unknown');
    await entry.bridge.reply(run, interaction, answer, context);
  }
  async reconcile(run: Run, context: BackendContext): Promise<ReconcileResult> {
    if (!this.runs.snapshot(run.id).agent && !this.compatibility) return this.legacy.reconcile ? this.legacy.reconcile(run, context) : 'unknown';
    const entry = this.attached.get(run.id);
    if (!entry) return await this.recoverOriginal(run, context) === 'drained' ? 'interrupted' : 'unknown';
    if (entry.attemptId !== context.epoch || !this.owned(run.id, entry)) return 'unknown';
    if (entry.starting || entry.work.size && !entry.started) return 'unknown';
    if (!entry.started && !entry.sideEffects) return 'interrupted';
    return entry.bridge ? entry.bridge.reconcile(run, context) : 'unknown';
  }
  private async recoverOriginal(run: Run, context: BackendContext): Promise<'drained' | 'unknown'> {
    const token = this.runs.runtime(run.id), selection = this.runs.snapshot(run.id).agent;
    const attemptId = token.details.recoveryAttemptId ?? token.details.previousEpoch;
    if (!selection || token.epoch !== context.epoch || typeof attemptId !== 'string' || !attemptId) return 'unknown';
    const previous = this.restartWork.get(run.id); if (previous) return previous;
    const work = (async () => {
      try {
        const extension = this.plugin(selection.backendId).extensions?.restartRecovery;
        if (!extension) return 'unknown' as const;
        const result = await extension.reconcile({ runId: run.id, attemptId, serviceRoot: this.directories.root, projectPath: String(token.details.canonicalPath), selection: immutable(structuredClone(selection)), signal: AbortSignal.timeout(this.options.timeoutMs) });
        return this.runs.runtime(run.id).epoch === context.epoch && result === 'drained' ? 'drained' as const : 'unknown' as const;
      } catch { return 'unknown' as const; }
    })();
    this.restartWork.set(run.id, work);
    try { return await work; } finally { if (this.restartWork.get(run.id) === work) this.restartWork.delete(run.id); }
  }
  async operation(id: string, attemptId: string, request: Json): Promise<Json> {
    const entry = this.attached.get(id);
    if (!entry) {
      const run = this.runs.get(id), token = this.runs.runtime(id), selection = this.runs.snapshot(id).agent;
      const original = token.details.recoveryAttemptId ?? token.details.previousEpoch;
      if (token.epoch !== attemptId || !['reconciling', 'cancelling'].includes(run.status) || !selection || typeof original !== 'string') throw new AgentError('outcome_unknown');
      const extension = this.plugin(selection.backendId).extensions?.restartRecovery;
      if (!extension?.operation) throw new AgentError('capability_unsupported');
      const result = await extension.operation({ runId: id, attemptId: original, serviceRoot: this.directories.root, projectPath: String(token.details.canonicalPath), selection: immutable(structuredClone(selection)), signal: AbortSignal.timeout(this.options.timeoutMs) }, structuredClone(request));
      if (this.runs.runtime(id).epoch !== attemptId || isTerminalRunStatus(this.runs.get(id).status)) throw new AgentError('outcome_unknown');
      return result;
    }
    if (!entry || entry.attemptId !== attemptId || !entry.extensionContext || !entry.startSettled || !this.accepting(id, entry) || entry.controller.signal.aborted || terminal(entry.last)) throw new AgentError('outcome_unknown');
    const extension = this.plugin(entry.backendId).extensions?.runOperations;
    if (!extension) throw new AgentError('capability_unsupported');
    const result = await this.bounded(entry, this.track(entry, () => extension.execute(entry.extensionContext!, structuredClone(request))));
    if (!this.owned(id, entry) || entry.disposed) throw new AgentError('outcome_unknown');
    return JSON.parse(redactSkillValues(JSON.stringify(result), entry.secrets)) as Json;
  }
  private async cleanup(id: string, entry: AttachedAgent): Promise<void> {
    if (!this.owned(id, entry) || !isTerminalRunStatus(this.runs.get(id).status) || entry.starting || entry.work.size || entry.pending || entry.callbackError || (entry.started || entry.sideEffects) && !terminal(entry.last)) return;
    try {
      if (entry.adapter && !entry.disposed) {
        if (entry.started || entry.sideEffects) {
          if (!entry.released) {
            entry.releaseWork ??= this.track(entry, async () => { await entry.adapter!.releaseRun(id); entry.released = true; });
            try { await this.bounded(entry, entry.releaseWork); } catch (error) { if (!entry.work.size) delete entry.releaseWork; throw error; }
          }
          entry.disposeWork ??= this.track(entry, async () => { await entry.adapter!.disposeDrained(); entry.disposed = true; });
        } else entry.disposeWork ??= this.track(entry, async () => { await entry.adapter!.disposeUnstarted(); entry.disposed = true; });
        try { await this.bounded(entry, entry.disposeWork); } catch (error) { if (!entry.work.size) delete entry.disposeWork; throw error; }
      }
      if (this.owned(id, entry)) this.attached.delete(id);
    } catch (error) { this.record(id, entry, 'agent.cleanup', 'cleanup', error); }
  }
  async releaseFinished(): Promise<void> {
    await Promise.all([...this.attached].map(async ([id, entry]) => {
      const cleaning = entry.cleaning ??= this.cleanup(id, entry);
      try { await cleaning; } finally { if (entry.cleaning === cleaning) delete entry.cleaning; }
    }));
  }
  async disposeUnstarted(): Promise<void> { if (this.attached.size) throw new AgentError('outcome_unknown'); }
  async disposeDrained(): Promise<void> { await this.releaseFinished(); if (this.attached.size) throw new AgentError('outcome_unknown'); }
  get retainedRuns(): number { return this.attached.size; }
}
