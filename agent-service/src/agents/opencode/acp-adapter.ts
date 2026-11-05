import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Json } from '@openworkgraph/protocol';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
import type { AgentAdapter, AgentAdapterDependencies, AgentExtensionContext } from '../contracts.js';
import type { BackendCallbacks, BackendReply, BackendRunContext, RuntimeSnapshot } from '../../backend/types.js';
import { AgentError } from '../errors.js';
import { canonicalJson } from '../../persistence/repositories.js';
import { validateRunPaths, within } from '../../backend/paths.js';
import { nodeGenerationGuidance } from '../../prompts/index.js';
import { publicSkillGuidance, skillProcessEnvironment } from '../../skill-sessions.js';
import { redactSkillValues } from '../../backend/redaction.js';
import { publicProgressText } from '../../backend/progress.js';
import { tokenUsage, sumTokens } from '../../backend/token-usage.js';
import { AgentHostTools } from '../host-tools.js';
import { AgentHostMcp } from '../host-mcp.js';
import { cancelAgentRun } from '../cancellation.js';
import { OpenCodeAcp, type AcpObject } from './acp.js';
import { OpenCodeAcpInteractions } from './acp-interactions.js';
import { openCodeCliDevice, openCodeCliRequest, type OpenCodeCliOptions } from './cli.js';
import { boundedWait, forceStopOpenCode, launchOpenCode, type OpenCodeProcess } from './process.js';
import { OpenCodeActionJournal } from './journal.js';
import { openCodeRecoveryOperation } from './recovery.js';
import { isSupportedOpenCodeAcpVersion } from './version.js';
import { openCodeQueryInstance } from './query.js';
import { readOpenCodeNativeCatalog } from './catalog.js';

export interface OpenCodeAcpOptions extends OpenCodeCliOptions { pollMs?: number; runTimeoutMs?: number; cancelAttemptMs?: number }
export const openCodeDigest = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)) as Json)).digest('hex');
const terminal = (value: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value);
const ended = (value: string) => ['completed', 'failed', 'cancelled'].includes(value);
const sessionId = (id: unknown): id is string => typeof id === 'string' && /^ses_[A-Za-z0-9_-]+$/.test(id);
const NL = String.fromCharCode(10);
// Code Mode reports its nested calls in the final tool metadata. An ended
// interpreter alone does not prove pending calls or independent work ended.
function foregroundCodeMode(metadata: AcpObject | undefined): boolean {
  return Array.isArray(metadata?.toolCalls) && metadata.toolCalls.length <= 1024 && metadata.toolCalls.every((call: AcpObject) => {
    if (!call || typeof call.tool !== 'string' || !['completed', 'error'].includes(call.status)) return false;
    const name = call.tool.split('.').at(-1);
    return !['subagent', 'execute', 'shell', 'pty'].includes(name!) && call.input?.background !== true && call.input?.detached !== true;
  });
}

/** Official ACP foreground execution. This adapter deliberately provides no
 * native service composition, PTY, protected commands or transparent restart.
 * A cancelled/incomplete executable or background action retains occupancy. */
export class OpenCodeAcpAdapter implements AgentAdapter {
  private native?: OpenCodeProcess;
  private rpc?: OpenCodeAcp;
  private host?: AgentHostMcp;
  private journal?: OpenCodeActionJournal;
  private interactions?: OpenCodeAcpInteractions;
  private context?: BackendRunContext;
  private callbacks?: BackendCallbacks;
  private snapshot: RuntimeSnapshot;
  private started = false;
  private starting = false;
  private cancelled = false;
  private released = false;
  private disposed = false;
  private stopping = false;
  private promptSettled = false;
  private promptSent = false;
  private failure?: AgentError;
  private result?: AcpObject;
  private text = '';
  private secrets: Record<string, string> = {};
  private commentary = 0;
  private timer?: NodeJS.Timeout;
  private monitor?: Promise<void>;
  private cancellation: Promise<RuntimeSnapshot> | undefined;
  private settling: Promise<void> | undefined;
  private emission: Promise<void> = Promise.resolve();
  private lastEmission?: string;
  private callbackFailed = false;
  private readonly preparation = new AbortController();
  private readonly background = new Set<string>();
  private readonly executing = new Set<string>();
  private readonly observedTools = new Map<string, { action: string; session: string; name?: string }>();
  constructor(private readonly dependencies: AgentAdapterDependencies, private readonly options: OpenCodeAcpOptions, private readonly unregister: () => void) {
    this.snapshot = { runId: dependencies.runId, backendId: 'opencode', attemptId: dependencies.attemptId, threadId: null, turnId: null, state: 'starting', observedAt: new Date().toISOString(), model: structuredClone(dependencies.selection.model), reason: null, answer: '' };
  }
  private check(id: string) { if (id !== this.dependencies.runId || this.disposed) throw new AgentError('outcome_unknown'); }
  private active = () => this.started && !this.cancelled && !this.stopping && !this.promptSettled && !this.disposed;
  private copy() { return structuredClone(this.snapshot); }
  private async emit() {
    const snapshot = this.copy(), { observedAt: _observedAt, ...state } = snapshot;
    const signature = openCodeDigest(state);
    const next = this.emission.then(async () => {
      if (signature === this.lastEmission) return;
      snapshot.observedAt = new Date().toISOString(); this.snapshot.observedAt = snapshot.observedAt;
      await this.callbacks?.onSnapshot(snapshot); this.lastEmission = signature;
    });
    this.emission = next.catch(() => { this.callbackFailed = true; });
    await next; this.callbackFailed = false;
  }
  async prepare(context: AgentExtensionContext) {
    this.check(context.runId); context.signal.throwIfAborted();
    if (context.attemptId !== this.dependencies.attemptId || openCodeDigest(context.context.agent) !== openCodeDigest(this.dependencies.selection)) throw new AgentError('outcome_unknown');
    if (this.dependencies.selection.options.sandboxMode !== 'danger-full-access' || context.context.kind === 'image_generation' || context.context.skills?.some(skill => skill.requiresConfiguration && (skill.source !== 'openworkgraph' || !skill.explicit) || skill.source === 'codex' || skill.source === 'agent' && skill.backendId !== 'opencode')) throw new AgentError('capability_unsupported');
    if (context.context.skills?.some(skill => skill.requiresConfiguration) && !context.callbacks.withSkillEnvironment) throw new AgentError('invalid_configuration');
  }
  async start(context: BackendRunContext, callbacks: BackendCallbacks): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (this.starting || this.started) throw new AgentError('outcome_unknown');
    this.starting = true; this.context = structuredClone(context); this.callbacks = callbacks;
    const signal = AbortSignal.any([this.preparation.signal, ...(this.dependencies.signal ? [this.dependencies.signal] : [])]);
    try {
      await this.prepare({ runId: context.runId, attemptId: this.dependencies.attemptId, signal, context, callbacks });
      await validateRunPaths(context); signal.throwIfAborted();
      const device = await openCodeCliDevice(this.options, signal);
      if (!isSupportedOpenCodeAcpVersion(device.runtimeVersion)) throw new AgentError('capability_unsupported');
      const parent = join(context.serviceRoot, 'config', 'agent-sessions', 'opencode'); await mkdir(parent, { recursive: true, mode: 0o700 });
      if (!within(await realpath(context.serviceRoot), await realpath(parent))) throw new AgentError('invalid_configuration');
      const directory = join(parent, openCodeDigest([context.runId, context.attemptId]));
      try { await mkdir(directory, { mode: 0o700 }); } catch { throw new AgentError('outcome_unknown'); }
      const instanceId = randomUUID(), cwd = await realpath(context.projectPath), database = 'device';
      const inherited = device.environment ?? process.env;
      let configuration: AcpObject = {};
      if (inherited.OPENCODE_CONFIG_CONTENT) {
        try { configuration = JSON.parse(inherited.OPENCODE_CONFIG_CONTENT); } catch { throw new AgentError('invalid_configuration'); }
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new AgentError('invalid_configuration');
      }
      // CLI authentication belongs to the native device store. Keep the
      // original data root/database; never copy credentials into a Run DB.
      const environment: NodeJS.ProcessEnv = { ...inherited, XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
        WORKGRAPH_OPENCODE_INSTANCE_ID: instanceId,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...configuration, update: 'disable', share: 'disabled', warming: false }) };
      // No native permission overrides: full mode retains the user's hard
      // native denials. Restricted modes are refused before native startup.
      delete environment.OPENCODE_PASSWORD; delete environment.OPENCODE_SERVER_PASSWORD;
      this.journal = new OpenCodeActionJournal(directory, { runId: context.runId, attemptId: this.dependencies.attemptId, instanceId });
      this.journal.register({ kind: 'session', id: 'acp-turn' });
      const prompt = await this.prompt(context, device, signal);
      signal.throwIfAborted();
      this.host = new AgentHostMcp(new AgentHostTools(context.runId, this.dependencies.attemptId, callbacks, this.active));
      const mcp = await this.host.listen() as AcpObject; signal.throwIfAborted();
      const host = mcp.mcpServers.workgraph;
      const hostName = 'workgraph_' + openCodeDigest([context.runId, context.attemptId]).slice(0, 16);
      environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...JSON.parse(environment.OPENCODE_CONFIG_CONTENT!),
        mcp: { ...configuration.mcp, servers: { ...configuration.mcp?.servers, [hostName]: { type: 'remote', url: host.url, headers: host.headers, oauth: false, codemode: false } } } });
      // Keep the configuration revision lease through the synchronous spawn.
      // Discovery and metadata CLI calls retain the device environment only.
      const spawn = (values: Record<string, string>, secrets: Record<string, string> = {}) => {
        signal.throwIfAborted();
        if (this.native) throw new AgentError('outcome_unknown');
        // Skill data must not replace native configuration, identity or storage.
        if (Object.keys(values).some(key => /^(?:OPENCODE_|XDG_|WORKGRAPH_OPENCODE_)/i.test(key))) throw new AgentError('invalid_configuration');
        this.secrets = { ...secrets };
        this.native = launchOpenCode(device, ['acp'], cwd, skillProcessEnvironment(environment, values));
      };
      if (callbacks.withSkillEnvironment) await callbacks.withSkillEnvironment(null, spawn);
      else spawn({});
      signal.throwIfAborted();
      if (!this.native) throw new AgentError('invalid_configuration');
      if (!this.native.child.pid) throw new AgentError('runtime_unavailable');
      await this.record(join(directory, 'bootstrap.json'), { version: 1, runtime: 'acp', instanceId, runId: context.runId, attemptId: this.dependencies.attemptId, directory, cwd, projectPath: context.projectPath, database, pid: this.native.child.pid, selectionDigest: openCodeDigest(this.dependencies.selection) });
      this.rpc = new OpenCodeAcp(this.native, (method, value) => this.notification(method, value), async request => {
        if (request.params.sessionId !== this.snapshot.threadId) throw new AgentError('protocol_error');
        await this.interactions!.receive(request);
      }, error => { if (!this.stopping) { this.failure = error; this.snapshot.state = 'unknown'; this.journal?.disconnected(); void this.emit().catch(() => {}); } });
      this.interactions = new OpenCodeAcpInteractions(this.rpc, directory, true, callbacks, this.active, value => redactSkillValues(value, this.secrets), async () => {
        if (this.active()) { this.snapshot.state = this.interactions!.state ?? 'running'; await this.emit(); }
      });
      const initialize = await this.rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'OpenWorkgraph', version: SERVICE_VERSION }, clientCapabilities: { elicitation: { form: {} }, _meta: { 'opencode/child-session-updates': true } } }, { signal, timeoutMs: device.startTimeoutMs ?? 30000 });
      if (initialize.protocolVersion !== 1 || initialize.agentInfo?.version !== device.runtimeVersion || initialize.agentCapabilities?.promptCapabilities?.image !== true || initialize.agentCapabilities?.mcpCapabilities?.http !== true) throw new AgentError('capability_unsupported');
      const created = await this.rpc.request('session/new', { cwd, mcpServers: [] }, { signal, timeoutMs: device.startTimeoutMs ?? 30000 });
      if (!sessionId(created.sessionId)) throw new AgentError('protocol_error');
      this.snapshot.threadId = created.sessionId;
      // ACP creates an untitled session. Set an owned fixed title through the
      // official metadata API before prompting, avoiding auxiliary title inference.
      await openCodeCliRequest(device, cwd, 'PATCH', '/api/session/' + created.sessionId, signal, { title: 'Work Graph task' });
      const variant = this.dependencies.selection.model.reasoningEffort ?? this.dependencies.selection.options.variant;
      const choices = [['model', context.model.model], ['mode', String(this.dependencies.selection.options.profile || 'build')]];
      for (const [configId, value] of choices) await this.select(configId!, value!, signal);
      const effort = typeof variant === 'string' && variant ? variant : 'default';
      const selected = await this.rpc.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: context.model.model }, { signal, timeoutMs: device.requestTimeoutMs ?? 30000 });
      if (selected.configOptions?.some((option: AcpObject) => option.id === 'effort')) await this.select('effort', effort, signal);
      else if (effort !== 'default') throw new AgentError('model_unavailable');
      await this.record(join(directory, 'session.json'), { version: 1, runId: context.runId, attemptId: context.attemptId, instanceId, sessionId: created.sessionId, fingerprint: openCodeDigest(context), promptIntent: true });
      signal.throwIfAborted(); this.started = true; this.starting = false;
      this.snapshot.turnId = 'acp-' + openCodeDigest([context.runId, context.attemptId]); this.snapshot.state = 'running';
      this.journal.observe(instanceId, 'session', 'acp-turn', 'running');
      this.promptSent = true;
      const request = this.rpc.request('session/prompt', { sessionId: created.sessionId, prompt });
      this.monitor = request.then(async value => { await this.rpc!.flushNotifications(); this.result = value; this.promptSettled = true; await this.finish(); }).catch(async error => {
        if (this.callbackFailed) { if (!terminal(this.snapshot.state)) this.snapshot.state = 'unknown'; return; }
        this.promptSettled = true; this.failure = error instanceof AgentError ? error : new AgentError('outcome_unknown');
        this.snapshot.state = 'unknown'; this.snapshot.failureReason = this.failure.reason; this.snapshot.reason = this.failure.message; this.journal?.disconnected();
        await this.emit().catch(() => {});
      });
      this.timer = setTimeout(() => { this.failure = new AgentError('timeout'); void this.cancel(context.runId).catch(() => {}); }, this.options.runTimeoutMs ?? 30 * 60000);
      return this.copy();
    } catch (error) {
      this.starting = false;
      if (this.promptSent) { this.journal?.disconnected(); this.snapshot.state = 'unknown'; }
      else {
        this.stopping = true; if (this.native) await forceStopOpenCode(this.native, this.options.stopTimeoutMs); await this.host?.close();
        if (this.journal) this.journal.observe(this.journal.identity.instanceId, 'session', 'acp-turn', this.cancelled ? 'cancelled' : 'failed');
        this.snapshot.state = this.cancelled ? 'cancelled' : 'failed';
      }
      this.failure = error instanceof AgentError ? error : new AgentError('runtime_unavailable'); this.snapshot.failureReason = this.failure.reason; this.snapshot.reason = this.failure.message;
      await this.emit(); return this.copy();
    }
  }
  private async record(path: string, value: unknown) {
    const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  }
  private async select(configId: string, value: string, signal: AbortSignal) {
    const result = await this.rpc!.request('session/set_config_option', { sessionId: this.snapshot.threadId, configId, value }, { signal, timeoutMs: this.options.requestTimeoutMs ?? 30000 }).catch(error => { if (error instanceof AgentError && error.reason === 'protocol_error') throw new AgentError(configId === 'mode' ? 'invalid_configuration' : 'model_unavailable'); throw error; });
    if (!Array.isArray(result.configOptions) || result.configOptions.find((option: AcpObject) => option.id === configId)?.currentValue !== value) throw new AgentError(configId === 'mode' ? 'invalid_configuration' : 'model_unavailable');
  }
  private async prompt(context: BackendRunContext, device: OpenCodeCliOptions, signal: AbortSignal): Promise<AcpObject[]> {
    const normalized = { ...context, ...(context.files ? { files: context.files.map(file => ({ ...file, path: isAbsolute(file.path) ? file.path : resolve(context.inputPath, file.path) })) } : {}) };
    const text = [nodeGenerationGuidance(normalized, { generateTitle: Boolean(this.callbacks?.setNodeTitle) }), publicSkillGuidance((context.skills ?? []).filter(skill => skill.source !== 'agent'), { backendId: 'opencode', dynamicSkillCommands: false }),
      'Use foreground tools only. Background commands, detached tasks and external asynchronous jobs cannot be completed by this integration. Save deliverables to the absolute Run Output paths above.', 'User request follows:', context.prompt].filter(Boolean).join(NL);
    const result: AcpObject[] = [{ type: 'text', text }]; let total = 0;
    const selectedSkills = (context.skills ?? []).filter(skill => skill.source === 'agent');
    if (selectedSkills.length) {
      // The opaque catalog identity freezes name/path/content; verify it again
      // before embedding native skill text using official ACP content blocks.
      const cleanup: (() => void | Promise<void>)[] = [];
      try {
      const instance = await openCodeQueryInstance(device, { platform: this.dependencies.platform, projectPath: context.projectPath, options: this.dependencies.selection.options, signal, deferCleanup: callback => cleanup.push(callback) }, { update: 'disable', share: 'disabled', warming: false }, true);
      const native = await readOpenCodeNativeCatalog(instance.transport, instance.identity.cwd, signal);
      const contents = await instance.transport.request('/api/skill?location%5Bdirectory%5D=' + encodeURIComponent(instance.identity.cwd), { signal }) as AcpObject;
      if (!Array.isArray(contents?.data)) throw new AgentError('protocol_error');
      for (const skill of selectedSkills) {
        const found = native.skills.find(entry => 'opencode-' + openCodeDigest([entry.id, entry.path, entry.contentSha256]) === skill.skillId && (entry.name === skill.name || entry.id === skill.name));
        if (!found) throw new AgentError('invalid_configuration');
        const content = contents.data.find((entry: AcpObject) => entry.id === found.id && entry.path === found.path)?.content;
        if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || createHash('sha256').update(content).digest('hex') !== found.contentSha256) throw new AgentError('invalid_configuration');
        result.push({ type: 'text', text: 'Frozen native skill ' + skill.name + ':' + NL + content });
      }
      } finally { for (const close of cleanup) await close(); }
    }
    for (const resource of context.resources ?? []) if (resource.kind === 'image' && resource.resource) {
      const file = context.files?.find(file => file.resourceId === resource.resource!.resourceId && file.version === resource.resource!.version);
      if (!file || !/^image\/[a-zA-Z0-9.+-]+$/.test(resource.resource.mime)) throw new AgentError('invalid_configuration');
      const path = isAbsolute(file.path) ? file.path : resolve(context.inputPath, file.path);
      if (!within(context.inputPath, path) || await realpath(path) !== resolve(path)) throw new AgentError('invalid_configuration');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); total += stat.size;
        if (!stat.isFile() || stat.size !== resource.resource.bytes || total > 8 * 1024 * 1024) throw new AgentError('input_size_limit');
        const bytes = await handle.readFile(); if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new AgentError('invalid_configuration');
        result.push({ type: 'image', mimeType: resource.resource.mime, data: bytes.toString('base64') });
      } finally { await handle.close(); }
    }
    return result;
  }
  private async notification(method: string, value: AcpObject) {
    if (method === '$/cancel_request') { await this.interactions?.withdraw(value.requestId); return; }
    if (method === 'opencode/session/child_update') {
      if (value.rootSessionId !== this.snapshot.threadId || !sessionId(value.childSessionId)) throw new AgentError('protocol_error');
      // ACP can lose child observations at a bounded cancellation boundary.
      // Child work is outside this integration's foreground contract.
      const id = 'child:' + value.childSessionId; this.background.add(id);
      if (!this.journal!.list().some(action => action.id === id)) this.journal!.register({ kind: 'session', id });
      return;
    }
    if (method !== 'session/update') return;
    if (value.sessionId !== this.snapshot.threadId && this.snapshot.threadId !== null) throw new AgentError('protocol_error');
    const update = value.update;
    if (!update || typeof update.sessionUpdate !== 'string') throw new AgentError('protocol_error');
    if (update._meta?.['opencode/child-session']) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.type === 'text' && typeof update.content.text === 'string') { this.text += update.content.text; if (Buffer.byteLength(this.text) > 1024 * 1024) throw new AgentError('output_limit'); }
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      if (typeof update.toolCallId !== 'string' || !['pending', 'in_progress', 'completed', 'failed'].includes(update.status)) throw new AgentError('protocol_error');
      if (this.text && update.sessionUpdate === 'tool_call') {
        const text = publicProgressText(redactSkillValues(this.text, this.secrets)); if (text) { this.snapshot.progress = { messageId: 'acp-commentary-' + (++this.commentary), phase: 'commentary', text }; await this.emit(); delete this.snapshot.progress; }
        this.text = '';
      }
      const key = update.toolCallId;
      let tool = this.observedTools.get(key);
      const previous = tool && this.journal!.list().find(action => action.id === tool!.action);
      if (!tool || update.sessionUpdate === 'tool_call' && previous && ended(previous.phase)) {
        if (this.observedTools.size >= 1024) throw new AgentError('protocol_error');
        tool = { action: 'tool:' + randomUUID(), session: this.snapshot.threadId!, ...(typeof update.name === 'string' ? { name: update.name } : {}) }; this.observedTools.set(key, tool);
        this.journal!.register({ kind: 'plugin', id: tool.action, sessionId: tool.session });
      }
      const action = this.journal!.list().find(action => action.id === tool!.action)!;
      const raw = update.rawInput;
      if (raw?.background === true || raw?.detached === true || tool.name === 'subagent' || update.rawOutput?.metadata?.jobID || update.rawOutput?.metadata?.background || update.rawOutput?.metadata?.status === 'running') this.background.add(tool.action);
      if (update.kind === 'execute' || update.kind === 'think' || update.kind === 'other') this.executing.add(tool.action);
      if (!ended(action.phase)) {
        if (['completed', 'failed'].includes(update.status) && !this.cancelled && !this.background.has(tool.action) && (tool.name !== 'execute' || foregroundCodeMode(update.rawOutput?.metadata))) {
          this.journal!.observe(this.journal!.identity.instanceId, 'plugin', tool.action, update.status === 'completed' ? 'completed' : 'failed'); this.executing.delete(tool.action);
        } else this.journal!.observe(this.journal!.identity.instanceId, 'plugin', tool.action, this.cancelled ? 'unknown' : 'running');
      }
    }
  }
  private async finish(): Promise<void> {
    if (this.settling) return this.settling;
    this.settling = this.settle(); try { await this.settling; } finally { this.settling = undefined; }
  }
  private async settle() {
    if (!this.result || terminal(this.snapshot.state)) return;
    clearTimeout(this.timer);
    const unresolved = this.journal!.list().filter(action => action.id !== 'acp-turn' && !ended(action.phase));
    if (this.background.size || unresolved.length || this.executing.size) { this.snapshot.state = 'unknown'; this.snapshot.failureReason = 'outcome_unknown'; this.snapshot.reason = 'ACP 无法确认后台工作已结束，请核对原生任务。'; await this.emit(); return; }
    if (!['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(this.result.stopReason)) throw new AgentError('protocol_error');
    this.stopping = true; this.rpc?.end(); if (this.native) await forceStopOpenCode(this.native, this.options.stopTimeoutMs); await this.host?.close(); await this.callbacks?.hostWork?.drain(); await this.interactions?.cancel();
    const state = this.failure ? 'failed' : this.cancelled || this.result.stopReason === 'cancelled' ? 'cancelled' : this.result.stopReason === 'end_turn' ? 'completed' : 'failed';
    this.snapshot.answer = state === 'completed' ? redactSkillValues(this.text, this.secrets) : '';
    if (this.result.usage) {
      const usage = this.result.usage; const tokens = tokenUsage(sumTokens(usage.inputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0), sumTokens(usage.outputTokens, usage.thoughtTokens ?? 0)); if (tokens) this.snapshot.tokenUsage = tokens;
    }
    if (state === 'failed') { this.snapshot.failureReason = this.failure?.reason ?? (this.result.stopReason === 'max_tokens' ? 'output_limit' : 'runtime_unavailable'); this.snapshot.reason = new AgentError(this.snapshot.failureReason).message; }
    else { delete this.snapshot.failureReason; this.snapshot.reason = null; }
    if (state === 'completed' && this.snapshot.answer) {
      this.snapshot.progress = { messageId: 'acp-final-' + this.dependencies.attemptId, phase: 'final_answer', text: this.snapshot.answer };
      this.snapshot.identity = { backendId: 'opencode', attemptId: this.dependencies.attemptId, messageId: this.snapshot.progress.messageId!, sessionId: this.snapshot.threadId!, turnId: this.snapshot.turnId! };
      await this.emit(); delete this.snapshot.progress;
    }
    this.journal!.observe(this.journal!.identity.instanceId, 'session', 'acp-turn', state);
    this.snapshot.state = state; await this.emit();
  }
  async reconcile(id: string): Promise<RuntimeSnapshot> {
    this.check(id);
    if (this.journal && !this.journal.unresolved && this.snapshot.state === 'unknown' && !this.callbackFailed) { this.snapshot.state = 'interrupted'; this.snapshot.answer = ''; await this.emit(); }
    else if (this.result && !this.cancelled && !terminal(this.snapshot.state)) await this.finish();
    else if (this.callbackFailed) await this.emit();
    return this.copy();
  }
  async respond(id: string, interactionId: string, reply: BackendReply) {
    this.check(id); if (!this.interactions) throw new AgentError('outcome_unknown'); await this.interactions.reply(interactionId, reply); return this.copy();
  }
  async attach(context: AgentExtensionContext) { this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId) throw new AgentError('outcome_unknown'); this.callbacks = context.callbacks; return this.reconcile(context.runId); }
  async cancel(id: string): Promise<RuntimeSnapshot> {
    this.check(id); if (terminal(this.snapshot.state)) return this.copy();
    this.cancelled = true; this.preparation.abort(); clearTimeout(this.timer); this.callbacks?.hostWork?.cancel();
    if (this.cancellation) return this.cancellation;
    this.cancellation = this.stop(); try { return await this.cancellation; } finally { this.cancellation = undefined; }
  }
  private async stop(): Promise<RuntimeSnapshot> {
    if (this.starting) return this.copy();
    if (!this.promptSent) { this.snapshot.state = 'cancelled'; return this.copy(); }
    this.snapshot.state = 'cancelling'; await this.emit();
    try {
      await cancelAgentRun(async signal => {
        await this.rpc!.notify('session/cancel', { sessionId: this.snapshot.threadId });
        if (!this.promptSettled) await boundedWait(this.monitor!, this.options.cancelAttemptMs ?? 2000);
        signal.throwIfAborted(); return this.promptSettled && this.executing.size === 0 && this.background.size === 0 && !this.journal!.list().some(action => action.id !== 'acp-turn' && !ended(action.phase));
      }, async () => { this.stopping = true; await forceStopOpenCode(this.native!, this.options.stopTimeoutMs); }, this.options.cancelAttemptMs);
      this.stopping = true; this.rpc?.end(); await forceStopOpenCode(this.native!, this.options.stopTimeoutMs); await this.host?.close(); await this.callbacks?.hostWork?.drain(); await this.interactions?.cancel();
      if (this.executing.size || this.background.size || !this.result || this.journal!.list().some(action => action.id !== 'acp-turn' && !ended(action.phase))) {
        this.journal!.disconnected(); this.snapshot.state = 'unknown'; this.snapshot.reason = new AgentError('outcome_unknown').message;
      } else {
        const action = this.journal!.list().find(action => action.id === 'acp-turn')!; if (!ended(action.phase)) this.journal!.observe(this.journal!.identity.instanceId, 'session', 'acp-turn', this.failure ? 'failed' : 'cancelled');
        this.snapshot.state = this.failure ? 'failed' : 'cancelled'; this.snapshot.answer = '';
      }
    } catch { this.journal?.disconnected(); this.snapshot.state = 'unknown'; this.snapshot.reason = new AgentError('outcome_unknown').message; }
    await this.emit(); return this.copy();
  }
  async execute(context: AgentExtensionContext, request: Json): Promise<Json> {
    this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || !request || typeof request !== 'object' || Array.isArray(request) || !String(request.type).startsWith('recovery.')) throw new AgentError('capability_unsupported');
    return openCodeRecoveryOperation({ runId: context.runId, attemptId: context.attemptId, serviceRoot: context.context.serviceRoot, projectPath: context.context.projectPath, selection: this.dependencies.selection, signal: context.signal }, request);
  }
  async releaseRun(id: string) {
    this.check(id); if (this.starting || !terminal(this.snapshot.state) || this.journal?.unresolved || this.callbackFailed) throw new AgentError('outcome_unknown');
    await this.emission; this.released = true;
  }
  async disposeUnstarted() { if (this.started || this.starting) throw new AgentError('outcome_unknown'); await this.dispose(); }
  async disposeDrained() { if (this.started && !this.released || this.starting) throw new AgentError('outcome_unknown'); await this.dispose(); }
  private async dispose() { if (this.disposed) return; this.stopping = true; this.preparation.abort(); clearTimeout(this.timer); this.rpc?.end(); if (this.native) await forceStopOpenCode(this.native, this.options.stopTimeoutMs); await this.host?.close(); this.interactions?.close(); this.journal?.close(); this.disposed = true; this.unregister(); }
}
