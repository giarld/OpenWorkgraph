import { AGENT_PLUGIN_API_VERSION, SERVICE_VERSION } from '@openworkgraph/protocol';
import type { AgentDescriptor, AgentAvailability, FrozenAgentSelection, Json, SandboxMode } from '@openworkgraph/protocol';
import type { AgentAdapter, AgentAdapterDependencies, AgentExtensionContext, AgentPlugin, AgentQueryContext } from './contracts.js';
import { CodexBackendAdapter, type AdapterOptions } from '../backend/adapter.js';
import type { BackendCallbacks, BackendRunContext, BackendReply, RuntimeSnapshot } from '../backend/types.js';
import { BackendError } from '../backend/types.js';
import { connect, initialize, listModels } from '../backend/capabilities.js';
import { StdioRpc } from '../backend/stdio.js';
import { describeCodexFailure } from '../backend/diagnostics.js';
import { AgentError, getAgentErrorOrigin } from './errors.js';
import { AgentHostTools } from './host-tools.js';
import { normalizeConfiguration } from './configuration.js';
import { hasVisualizeFeature } from '../visualize-features.js';
import { codexNativeSkills, resolveCodexSkills } from './codex/skills.js';
import { validateSelectionGeneration } from './workspace-configuration-validation.js';

export type CodexPluginOptions = AdapterOptions & { cwd?: string };
function projectPermissions(mode: SandboxMode): { sandboxMode: SandboxMode } {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new AgentError('invalid_configuration');
  // Native workspaceWrite adds cwd in 0.160.1, even with direct writableRoots=[runs].
  // Codex 0.160.1 command/exec negative probe confirmed project cwd is writable.
  // readOnly denies runs writes; neither policy implements this public contract.
  if (mode === 'read-only') throw new AgentError('capability_unsupported', 'Codex 尚不支持项目只读且全部 Run 目录可读写的原生权限组合。');
  return { sandboxMode: mode };
}
const descriptor: AgentDescriptor = {
  id: 'codex', name: 'Codex', description: 'Codex app-server 原生任务执行器。', implementationVersion: SERVICE_VERSION, apiVersion: AGENT_PLUGIN_API_VERSION,
  logo: { symbol: '◎', color: '#16816A' },
  projectPermissionModes: ['workspace-write', 'danger-full-access'],
  configuration: { version: 1, fields: [{ name: 'sandboxMode', type: 'enum', label: '原生权限模式', required: true, default: 'read-only', values: ['read-only', 'workspace-write', 'danger-full-access'] }] },
  models: { type: 'dynamic', allowCustom: false, effort: true },
  capabilities: { kinds: ['execution', 'text_generation', 'image_generation', 'visualize_generation'], inputKinds: ['text', 'document', 'image', 'video', 'file'], platforms: ['darwin', 'linux', 'win32'], cancellation: true, restoredRunStart: true, conversationContinuation: false, reattach: false, approvals: true, userInput: true, historyTools: true, nativeSkills: true, configuredSkills: true, dynamicSkillCommands: true, visualize: true },
};
const terminal = (snapshot: RuntimeSnapshot) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state);
function failure(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof BackendError) return new AgentError(error.code === 'MODEL_UNAVAILABLE' ? 'model_unavailable' : error.code === 'TIMEOUT' ? 'timeout' : error.code === 'UNAVAILABLE' ? 'runtime_unavailable' : error.code === 'CONFLICT' ? 'outcome_unknown' : error.code === 'INVALID_INPUT' ? 'invalid_configuration' : 'protocol_error');
  return new AgentError('protocol_error');
}
const queryFailures = new WeakMap<AgentError, ReturnType<typeof describeCodexFailure>>();
/** Trusted old API mapping only; raw native errors remain unreachable publicly. */
export class CodexQueryError extends AgentError {
  constructor(error: unknown, rpc?: StdioRpc) {
    super(failure(error).reason);
    queryFailures.set(this, describeCodexFailure(error, rpc));
  }
}
export function codexQueryFailure(error: unknown): ReturnType<typeof describeCodexFailure> | undefined {
  for (let hop = 0; hop < 16 && error instanceof AgentError; hop++) {
    const value = queryFailures.get(error); if (value) return structuredClone(value);
    error = getAgentErrorOrigin(error);
  }
  return undefined;
}
/** Queries own separate transports and register cleanup before acquisition. */
export async function codexQuery<T>(options: CodexPluginOptions, context: AgentQueryContext, query: (rpc: StdioRpc) => Promise<T>): Promise<T> {
  let rpc: StdioRpc | undefined;
  const abort = () => rpc?.close();
  context.deferCleanup(async () => { context.signal.removeEventListener('abort', abort); if (rpc) { rpc.close(); await rpc.waitForClose(); } });
  context.signal.throwIfAborted();
  context.signal.addEventListener('abort', abort, { once: true });
  rpc = new StdioRpc({ ...options, cwd: context.projectPath ?? options.cwd ?? process.cwd() });
  try { const value = await query(rpc); context.signal.throwIfAborted(); return value; }
  catch (error) { if (context.signal.aborted) throw context.signal.reason; throw new CodexQueryError(error, rpc); }
}

/** Private per-attempt wrapper; native state remains in the existing adapter. */
class CodexAgentAdapter implements AgentAdapter {
  private readonly native: CodexBackendAdapter;
  private readonly preparation = new AbortController();
  private prepared?: BackendRunContext;
  private tools?: AgentHostTools;
  private preparing?: Promise<void>;
  private started = false;
  private starting = false;
  private released = false;
  private disposed = false;
  private active = true;
  constructor(private readonly dependencies: AgentAdapterDependencies, private readonly options: CodexPluginOptions, private readonly unregister: () => void) { this.native = new CodexBackendAdapter(options); }
  private check(runId: string, attemptId?: string): void {
    if (this.disposed || runId !== this.dependencies.runId || attemptId !== undefined && attemptId !== this.dependencies.attemptId) throw new AgentError('outcome_unknown');
  }
  private extension(context: AgentExtensionContext): void {
    this.check(context.runId, context.attemptId);
    if (context.context.runId !== context.runId || context.context.attemptId !== context.attemptId) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted(); this.dependencies.signal?.throwIfAborted();
  }
  async prepare(context: AgentExtensionContext): Promise<void> {
    this.extension(context);
    if (this.started) throw new AgentError('outcome_unknown');
    this.preparing ??= (async () => {
      const copy: BackendRunContext = structuredClone(context.context);
      const signal = AbortSignal.any([context.signal, this.preparation.signal, ...(this.dependencies.signal ? [this.dependencies.signal] : [])]);
      copy.skills = await resolveCodexSkills(copy.skills ?? [], copy.projectPath, this.options, signal);
      signal.throwIfAborted();
      this.extension(context);
      if (copy.skills.some(skill => skill.source === 'openworkgraph' && skill.requiresConfiguration) && !context.callbacks.withSkillEnvironment) throw new AgentError('invalid_configuration');
      // Actual process acquisition validates revisions under the protected lease.
      // Preparation never calls a dispatch lease without sending native work.
      this.extension(context); this.prepared = copy;
    })();
    await this.preparing;
  }
  async install(context: AgentExtensionContext): Promise<void> {
    this.extension(context);
    if (this.started) throw new AgentError('outcome_unknown');
    if (!this.tools) {
      const callbacks = { ...context.callbacks };
      if (!(context.context.kind === 'visualize_generation' || context.context.kind === 'execution' && hasVisualizeFeature(context.context.features))) {
        delete callbacks.validateVisualizeOutput; delete callbacks.previewVisualizeOutput; delete callbacks.inspectVisualizePreview; delete callbacks.closeVisualizePreview;
      }
      this.tools = new AgentHostTools(context.runId, context.attemptId, callbacks, () => this.active && !this.disposed && !context.signal.aborted && !this.dependencies.signal?.aborted);
    }
  }
  async dispatch(context: AgentExtensionContext, request: Json): Promise<Json> {
    this.extension(context);
    if (!this.started || !request || typeof request !== 'object' || Array.isArray(request) || typeof request.callId !== 'string') throw new AgentError('invalid_configuration');
    const { callId, ...args } = request;
    return this.native.dispatchSkillCommand(context.runId, callId, args);
  }
  async start(context: BackendRunContext, callbacks: BackendCallbacks): Promise<RuntimeSnapshot> {
    this.check(context.runId, context.attemptId);
    if (this.started || this.starting || context.attemptId !== this.dependencies.attemptId) throw new AgentError('outcome_unknown');
    const selection = this.dependencies.selection;
    if (context.agent && JSON.stringify(context.agent) !== JSON.stringify(selection)) throw new AgentError('invalid_configuration');
    const signal = this.dependencies.signal ?? new AbortController().signal;
    const extension = { runId: context.runId, attemptId: context.attemptId, signal, context, callbacks };
    this.starting = true;
    try {
      await this.prepare(extension); await this.install(extension); signal.throwIfAborted();
      const input = { ...this.prepared!, agent: structuredClone(selection), attemptId: this.dependencies.attemptId, model: structuredClone(selection.model), sandboxMode: selection.options.sandboxMode as NonNullable<BackendRunContext['sandboxMode']> };
      this.started = true;
      const result = await this.native.start(input, { ...callbacks, onSnapshot: async snapshot => {
        if (terminal(snapshot)) this.active = false;
        await callbacks.onSnapshot(this.identity(snapshot));
      } }, { signal, ...(this.tools ? { hostTools: this.tools } : {}) });
      return this.identity(await this.settled(result));
    } catch (error) { if (!this.native.hasRun(context.runId)) this.started = false; throw failure(error); } finally { this.starting = false; }
  }
  private identity(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const value = structuredClone(snapshot); value.backendId = 'codex'; value.attemptId = this.dependencies.attemptId;
    if (value.progress?.itemId) { value.progress.messageId = value.progress.itemId; value.identity = { backendId: 'codex', attemptId: this.dependencies.attemptId, messageId: value.progress.itemId, ...(value.threadId ? { sessionId: value.threadId } : {}), ...(value.turnId ? { turnId: value.turnId } : {}) }; }
    return value;
  }
  private settled(snapshot: RuntimeSnapshot): Promise<RuntimeSnapshot> { return terminal(snapshot) ? this.native.settledSnapshot(this.dependencies.runId) : Promise.resolve(snapshot); }
  async cancel(id: string): Promise<RuntimeSnapshot> { this.check(id); this.active = false; return this.identity(await this.settled(await this.native.cancel(id))); }
  async respond(id: string, interactionId: string, reply: BackendReply): Promise<RuntimeSnapshot> { this.check(id); return this.identity(await this.settled(await this.native.respond(id, interactionId, reply))); }
  async reconcile(id: string): Promise<RuntimeSnapshot> { this.check(id); const value = await this.settled(await this.native.reconcile(id)); if (terminal(value) || value.state === 'unknown') this.active = false; return this.identity(value); }
  async releaseRun(id: string): Promise<void> { this.check(id); if (this.starting) throw new AgentError('outcome_unknown'); if (!this.released) { await this.native.releaseRun(id); this.released = true; this.active = false; } }
  async disposeUnstarted(): Promise<void> {
    if (this.started || this.starting) throw new AgentError('outcome_unknown');
    this.preparation.abort(); await this.preparing?.catch(() => {});
    await this.native.disposeUnstarted(); this.disposed = true; this.active = false; this.unregister();
  }
  async disposeDrained(): Promise<void> {
    if (this.starting || this.started && !this.released) throw new AgentError('outcome_unknown');
    this.preparation.abort(); await this.preparing?.catch(() => {});
    await this.native.disposeDrained(); this.disposed = true; this.active = false; this.unregister();
  }
}

export function createCodexPlugin(options: CodexPluginOptions = {}): AgentPlugin {
  const privateOptions = { ...options, ...(options.args ? { args: [...options.args] } : {}) };
  const attached = new Map<string, CodexAgentAdapter>();
  const key = (runId: string, attemptId: string) => JSON.stringify([runId, attemptId]);
  const owned = (context: AgentExtensionContext) => { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); return adapter; };
  return {
    descriptor: structuredClone(descriptor),
    projectPermissions,
    createAdapter(dependencies) {
      dependencies.signal?.throwIfAborted();
      const selection = dependencies.selection;
      if (!dependencies.runId || !dependencies.attemptId || selection.backendId !== 'codex' || selection.apiVersion !== AGENT_PLUGIN_API_VERSION) throw new AgentError('invalid_configuration');
      const normalized = normalizeConfiguration(descriptor.configuration, selection.options, selection.schemaVersion, dependencies.platform);
      if (normalized.sandboxMode !== selection.options.sandboxMode) throw new AgentError('invalid_configuration');
      if (Object.hasOwn(selection, 'settingsGeneration') || Object.hasOwn(selection, 'permissions')) {
        const frozen = selection as FrozenAgentSelection;
        validateSelectionGeneration(frozen);
        if (projectPermissions(frozen.permissions!.project).sandboxMode !== normalized.sandboxMode) throw new AgentError('invalid_configuration');
      }
      const id = key(dependencies.runId, dependencies.attemptId); if (attached.has(id)) throw new AgentError('outcome_unknown');
      const adapter = new CodexAgentAdapter({ ...dependencies, selection: structuredClone(selection) }, privateOptions, () => attached.delete(id));
      attached.set(id, adapter); return adapter;
    },
    listModels: context => codexQuery(privateOptions, context, async rpc => { await connect(rpc); return listModels(rpc); }),
    async diagnose(context): Promise<AgentAvailability> {
      try { const runtimeVersion = await codexQuery(privateOptions, context, initialize); return { status: 'unknown', reason: null, message: '原生握手成功；尚未执行模型调用。', runtimeVersion, installation: 'installed' }; }
      catch (error) {
        if (context.signal.aborted) throw error;
        const missing = codexQueryFailure(error)?.details.reason === 'executable_not_found';
        return { status: 'unavailable', reason: failure(error).reason, message: failure(error).message, installation: missing ? 'missing' : 'unknown' };
      }
    },
    evaluateTask(requirements) {
      try { normalizeConfiguration(descriptor.configuration, requirements.options, 1, requirements.platform); } catch { return { status: 'unavailable', reason: 'invalid_configuration', message: '原生权限配置无效。' }; }
      return descriptor.capabilities.kinds.includes(requirements.kind) && requirements.inputKinds.every(kind => descriptor.capabilities.inputKinds.includes(kind)) ? { status: 'available', reason: null, message: '任务具备原生执行资格。' } : { status: 'unavailable', reason: 'capability_unsupported', message: '任务或输入类型不受支持。' };
    },
    extensions: {
      nativeSkills: { version: 1, list: context => codexNativeSkills(privateOptions, context) },
      configuredSkills: { version: 1, prepare: context => owned(context).prepare(context) },
      historyTools: { version: 1, install: context => owned(context).install(context) },
      dynamicSkillCommands: { version: 1, dispatch: (context, request) => owned(context).dispatch(context, request) },
    },
  };
}
