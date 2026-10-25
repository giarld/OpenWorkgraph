import { tokenUsage, sumTokens } from '../backend/token-usage.js';
import { AGENT_PLUGIN_API_VERSION, SERVICE_VERSION, isSkillName } from '@openworkgraph/protocol';
import type { AgentDescriptor, AgentAvailability, AgentModelOption, FrozenSkill, Json, SandboxMode } from '@openworkgraph/protocol';
import { canonicalJson } from '../persistence/repositories.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentAdapter, AgentAdapterDependencies, AgentExtensionContext, AgentPlugin, AgentQueryContext, AgentTaskRequirements } from './contracts.js';
import type { BackendCallbacks, BackendReply, BackendRunContext, RuntimeSnapshot } from '../backend/types.js';
import { AgentError } from './errors.js';
import { normalizeConfiguration, publicText } from './configuration.js';
import { AgentHostTools } from './host-tools.js';
import { AgentOperations } from './operations.js';
import { nodeGenerationGuidance } from '../prompts/index.js';
import { validateRunPaths, within } from '../backend/paths.js';
import { publicProgressText } from '../backend/progress.js';
import { redactSkillValues } from '../backend/redaction.js';
import { publicSkillGuidance } from '../skill-sessions.js';
import { openCodeDevice, OpenCodeSdkMissingError } from './opencode/device.js';
import type { OpenCodeDeviceOptions } from './opencode/process.js';
import { OpenCodePrivateInstance } from './opencode/instance.js';
import { OpenCodeActionJournal } from './opencode/journal.js';
import { readOpenCodeNativeCatalog, type OpenCodeNativeCatalog } from './opencode/catalog.js';
import { openCodeQueryInstance } from './opencode/query.js';
import { OpenCodeProjectInstructions } from './opencode/project-instructions.js';
import { OpenCodeHost } from './opencode/host.js';
import { OpenCodeRunOperations } from './opencode/run-operations.js';
import { recoverOpenCodeRun, openCodeRecoveryOperation } from './opencode/recovery.js';
import { OpenCodeInteractions } from './opencode/interactions.js';
import { modelProviderGroup } from './model-groups.js';

type Native = Record<string, any>;
export interface OpenCodePluginOptions extends OpenCodeDeviceOptions { pollMs?: number; runTimeoutMs?: number }
const descriptor: AgentDescriptor = {
  id: 'opencode', name: 'OpenCode', description: 'OpenCode V2 原生任务执行器。', logo: { symbol: 'OC', color: '#3F3F46' },
  implementationVersion: SERVICE_VERSION, apiVersion: AGENT_PLUGIN_API_VERSION,
  // Native path checks cannot currently prove read-only in the presence of
  // write aliases/races and auxiliary commands. Refuse instead of promising a sandbox.
  projectPermissionModes: ['workspace-write', 'danger-full-access'],
  configuration: { version: 1, fields: [
    { name: 'sandboxMode', type: 'enum', label: '项目权限', default: 'workspace-write', required: true, values: ['read-only', 'workspace-write', 'danger-full-access'] },
    { name: 'profile', type: 'text', label: '原生 Agent', default: 'build', maxLength: 256, hidden: true },
    { name: 'variant', type: 'text', label: '模型变体', default: '', maxLength: 64, hidden: true },
  ] },
  models: { type: 'dynamic', allowCustom: false, effort: true, variantOption: 'variant' },
  capabilities: { kinds: ['execution', 'text_generation', 'visualize_generation'], inputKinds: ['text', 'image', 'document', 'video', 'file'], platforms: ['darwin', 'linux', 'win32'],
    cancellation: true, restoredRunStart: true, conversationContinuation: true, reattach: true, approvals: true, userInput: true, historyTools: true, nativeSkills: true, configuredSkills: process.platform !== 'win32', dynamicSkillCommands: process.platform !== 'win32', visualize: true },
};
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)) as Json)).digest('hex');
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
const nativeSkillId = (skill: OpenCodeNativeCatalog['skills'][number]) => 'opencode-' + hash([skill.id, skill.path, skill.contentSha256]);
const nativeSkillName = (skill: OpenCodeNativeCatalog['skills'][number]) => isSkillName(skill.name) ? skill.name : skill.id;
// Keep old frozen options readable; a per-task effort always takes precedence.
const selectedVariant = (selection: AgentAdapterDependencies['selection']) => selection.model.reasoningEffort ?? selection.options.variant;
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function reasoningEfforts(variants: readonly string[]): string[] {
  return [...effortOrder.filter(value => variants.includes(value)), ...variants.filter(value => !effortOrder.includes(value))];
}
function nativeModel(model: string, variant: unknown) {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1 || model.includes('#')) throw new AgentError('model_unavailable');
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(typeof variant === 'string' && variant ? { variant } : {}) };
}
function publicModels(catalog: OpenCodeNativeCatalog): AgentModelOption[] {
  return catalog.models.map(model => ({ id: model.id, reasoningEfforts: reasoningEfforts(model.variants), variants: model.variants, tools: model.tools,
    inputKinds: ['text', ...(model.input.includes('image') ? ['image'] : []), ...(model.tools ? ['document', 'file', 'video'] : [])] as NonNullable<AgentModelOption['inputKinds']> }));
}
async function catalog(options: OpenCodePluginOptions, context: AgentQueryContext): Promise<OpenCodeNativeCatalog> {
  const query = context.permissions ? { ...context, options: { ...context.options, sandboxMode: context.permissions.project } } : context;
  const instance = await openCodeQueryInstance(await openCodeDevice(options), query, { update: 'disable', share: 'disabled', warming: false });
  return readOpenCodeNativeCatalog(instance.transport, instance.identity.cwd, context.signal);
}
function openCodeTaskAvailability(requirements: AgentTaskRequirements): AgentAvailability {
  const model = requirements.modelCapabilities;
  const supported = requirements.kind !== 'image_generation' && requirements.options.sandboxMode !== 'read-only'
    && !(model?.tools === false && (requirements.kind !== 'text_generation' || !!requirements.skills?.length || !!requirements.projectFiles?.length || requirements.inputKinds.some(kind => !['text', 'image'].includes(kind))))
    && (!model?.inputKinds || requirements.inputKinds.every(kind => model.inputKinds!.includes(kind)));
  return { status: supported ? 'available' : 'unavailable', reason: supported ? null : 'capability_unsupported',
    message: supported ? '任务将使用冻结的原生选择。' : 'OpenCode 不支持此任务、输入或项目权限组合。' };
}

class OpenCodeAdapter implements AgentAdapter {
  private instance?: OpenCodePrivateInstance;
  private journal?: OpenCodeActionJournal;
  private instructions?: OpenCodeProjectInstructions;
  private interactions?: OpenCodeInteractions;
  private host?: OpenCodeHost;
  private runOperations?: OpenCodeRunOperations;
  private context?: BackendRunContext;
  private callbacks?: BackendCallbacks;
  private readonly preparation = new AbortController();
  private readonly operations = new AgentOperations();
  private readonly secrets: Record<string, string> = {};
  private readonly messages = new Set<string>();
  private readonly messageUsage = new Map<string, import('@openworkgraph/protocol').TokenUsage>();
  private readonly sessions = new Set<string>();
  private readonly commands = new Map<string, { fingerprint: string; value: Promise<Json> }>();
  private snapshot: RuntimeSnapshot;
  private sessionId = '';
  private started = false;
  private starting = false;
  private cancelled = false;
  private timedOut = false;
  private unsupportedInteraction = false;
  private sealed = false;
  private continuing = false;
  private drainedOutcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  private released = false;
  private disposed = false;
  private monitor?: Promise<void>;
  private callbacksQueue: Promise<void> = Promise.resolve();
  private callbackFailed = false;
  private observed: Promise<RuntimeSnapshot> | undefined;
  constructor(private readonly dependencies: AgentAdapterDependencies, private readonly options: OpenCodePluginOptions, private readonly unregister: () => void) {
    this.snapshot = { runId: dependencies.runId, backendId: 'opencode', attemptId: dependencies.attemptId, threadId: null, turnId: null, state: 'starting', observedAt: new Date().toISOString(), model: structuredClone(dependencies.selection.model), reason: null, answer: '' };
  }
  private check(id: string) { if (id !== this.dependencies.runId || this.disposed) throw new AgentError('outcome_unknown'); }
  private copy() { return structuredClone(this.snapshot); }
  private active = () => this.started && !this.cancelled && !this.sealed && !this.disposed && !terminal(this.snapshot.state);
  private async emit() {
    this.snapshot.observedAt = new Date().toISOString(); const copy = this.copy();
    const next = this.callbacksQueue.then(() => this.callbacks?.onSnapshot(copy)); this.callbacksQueue = next.catch(() => { this.callbackFailed = true; });
    await next; this.callbackFailed = false;
  }
  async prepare(context: AgentExtensionContext) {
    this.check(context.runId); context.signal.throwIfAborted();
    if (context.attemptId !== this.dependencies.attemptId || JSON.stringify(context.context.agent) !== JSON.stringify(this.dependencies.selection)) throw new AgentError('outcome_unknown');
    if (this.dependencies.selection.options.sandboxMode === 'read-only') throw new AgentError('capability_unsupported');
    if (context.context.skills?.some(skill => skill.source === 'codex' || skill.source === 'agent' && skill.backendId !== 'opencode')) throw new AgentError('capability_unsupported');
    if (context.context.skills?.some(skill => skill.requiresConfiguration) && !context.callbacks.withSkillEnvironment) throw new AgentError('invalid_configuration');
    if (process.platform === 'win32' && context.context.skills?.some(skill => skill.requiresConfiguration)) throw new AgentError('capability_unsupported');
    await openCodeDevice(this.options);
  }
  async start(context: BackendRunContext, callbacks: BackendCallbacks): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (this.started || this.starting || context.attemptId !== this.dependencies.attemptId) throw new AgentError('outcome_unknown');
    this.starting = true; this.context = structuredClone(context); this.callbacks = callbacks;
    const signal = AbortSignal.any([this.preparation.signal, ...(this.dependencies.signal ? [this.dependencies.signal] : [])]);
    try {
      await this.prepare({ runId: context.runId, attemptId: this.dependencies.attemptId, signal, context, callbacks });
      await validateRunPaths(context); signal.throwIfAborted();
      const device = await openCodeDevice(this.options);
      const privateRoot = join(context.serviceRoot, 'config', 'agent-sessions', 'opencode'); await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      if (!within(await realpath(context.serviceRoot), await realpath(privateRoot))) throw new AgentError('invalid_configuration');
      const directory = join(privateRoot, hash([context.runId, context.attemptId]));
      const tools = new AgentHostTools(context.runId, this.dependencies.attemptId, callbacks, this.active);
      this.host = new OpenCodeHost(tools, id => this.ownsSession(id), process.platform !== 'win32' && context.skills?.some(skill => skill.source === 'openworkgraph') && callbacks.withSkillEnvironment ? (id, args) => this.dispatchCommand(id, args) : undefined);
      const host = await this.host.listen(); signal.throwIfAborted();
      this.instance = await OpenCodePrivateInstance.start({ directory, cwd: context.kind === 'execution' ? context.projectPath : context.outputPath, projectPath: context.projectPath,
        runId: context.runId, attemptId: this.dependencies.attemptId, device, signal,
        configuration: { update: 'disable', share: 'disabled', warming: false }, bridge: { recoverable: true, selectionDigest: hash(this.dependencies.selection), permissionMode: String(context.agent!.options.sandboxMode), runsPath: join(context.serviceRoot, 'runs'), host } });
      this.journal = new OpenCodeActionJournal(directory, this.instance.identity);
      const native = await readOpenCodeNativeCatalog(this.instance.transport, this.instance.identity.cwd, signal);
      await this.instance.transport.request('/api/workgraph/ready', { method: 'POST', signal });
      const selected = native.models.find(model => model.id === context.model.model), variant = selectedVariant(context.agent!);
      if (!selected || variant && !selected.variants.includes(String(variant))) throw new AgentError('model_unavailable');
      const availability = openCodeTaskAvailability({ kind: context.kind, platform: this.dependencies.platform, options: context.agent!.options, model: context.model,
        modelCapabilities: publicModels(native).find(model => model.id === context.model.model)!, skills: context.skills ?? [], resources: context.resources ?? [], projectFiles: context.projectFiles ?? [],
        inputKinds: [...new Set([...(context.resources ?? []).map(resource => resource.kind), ...(context.projectFiles ?? []).map(file => file.kind)])] });
      if (availability.status !== 'available') throw new AgentError(availability.reason ?? 'capability_unsupported');
      const profile = String(context.agent!.options.profile || 'build');
      if (!native.agents.some(agent => agent.id === profile && !agent.hidden && agent.mode !== 'subagent')) throw new AgentError('invalid_configuration');
      const nativeSkills = (context.skills ?? []).filter(skill => skill.source === 'agent').map(skill => {
        const found = native.skills.find(entry => nativeSkillId(entry) === skill.skillId && nativeSkillName(entry) === skill.name);
        if (!found) throw new AgentError('invalid_configuration');
        return { id: found.id };
      });
      this.sessionId = 'ses_' + hash([context.runId, this.dependencies.attemptId]).slice(0, 40); this.sessions.add(this.sessionId);
      this.journal.register({ kind: 'session', id: this.sessionId });
      await this.instance.transport.request('/api/session', { method: 'POST', body: { id: this.sessionId, title: 'Work Graph task', location: { directory: this.instance.identity.cwd }, agent: profile, model: nativeModel(context.model.model, variant) }, signal });
      const record = await open(join(directory, 'session.json'), 'wx', 0o600);
      try { await record.writeFile(JSON.stringify({ version: 1, runId: context.runId, attemptId: context.attemptId, instanceId: this.instance.identity.instanceId, sessionId: this.sessionId, fingerprint: hash({ ...context, skillEnvironment: undefined }) })); await record.sync(); } finally { await record.close(); }
      if (context.kind !== 'execution') {
        const location = await this.instance.transport.request('/api/location?location%5Bdirectory%5D=' + encodeURIComponent(this.instance.identity.cwd)) as Native;
        this.instructions = await OpenCodeProjectInstructions.open(this.instance.identity, { projectRoot: location.project.directory, homePath: device.environment?.HOME ?? homedir() }, signal);
        await this.instructions.install(this.instance.transport, this.sessionId, signal);
      }
      this.interactions = new OpenCodeInteractions(this.instance.transport, directory, context.agent!.options.sandboxMode === 'danger-full-access', callbacks, text => redactSkillValues(text, this.secrets), this.instance.identity.cwd);
      this.runOperations = new OpenCodeRunOperations(this.instance.transport, directory, this.sessionId, this.instance.identity.cwd, this.journal, this.active, text => redactSkillValues(text, this.secrets));
      this.snapshot.threadId = this.sessionId; this.snapshot.turnId = 'msg_' + hash([context.runId, context.attemptId, 'input']).slice(0, 40);
      const promptContext = { ...context, ...(context.files ? { files: context.files.map(file => ({ ...file, path: isAbsolute(file.path) ? file.path : resolve(context.inputPath, file.path) })) } : {}) };
      const prompt = [nodeGenerationGuidance(promptContext, { generateTitle: Boolean(callbacks.setNodeTitle) }),
        publicSkillGuidance((context.skills ?? []).filter(skill => skill.source !== 'agent'), { backendId: 'opencode', dynamicSkillCommands: process.platform !== 'win32' }),
        'User request follows:', context.prompt].filter(Boolean).join('\n');
      const files = []; let imageBytes = 0;
      for (const resource of context.resources ?? []) if (resource.kind === 'image' && resource.resource) {
        if (!selected.input.includes('image')) throw new AgentError('capability_unsupported');
        const file = context.files?.find(file => file.resourceId === resource.resource!.resourceId && file.version === resource.resource!.version);
        if (!file) throw new AgentError('invalid_configuration');
        const path = isAbsolute(file.path) ? file.path : resolve(context.inputPath, file.path);
        if (!within(context.inputPath, path) || await realpath(path) !== resolve(path) || !/^image\/[a-zA-Z0-9.+-]+$/.test(resource.resource.mime)) throw new AgentError('invalid_configuration');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.size !== resource.resource.bytes) throw new AgentError('invalid_configuration');
          imageBytes += stat.size;
          if (imageBytes > 8 * 1024 * 1024) throw new AgentError('capability_unsupported');
          const data = await handle.readFile();
          if (data.length !== stat.size || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new AgentError('invalid_configuration');
          files.push({ uri: 'data:' + resource.resource.mime + ';base64,' + data.toString('base64') });
        } finally { await handle.close(); }
      }
      this.started = true;
      this.journal.observe(this.instance.identity.instanceId, 'session', this.sessionId, 'running');
      const body = { id: this.snapshot.turnId, text: prompt, ...(files.length ? { files } : {}), ...(nativeSkills.length ? { skills: nativeSkills } : {}) };
      // One durable input identity. If its response is lost, inspect the original
      // inbox/history rather than calling prompt a second time.
      try { await this.instance.transport.request('/api/session/' + this.sessionId + '/prompt', { method: 'POST', body, signal }); }
      catch {
        const accepted = await this.instance.transport.request('/api/session/' + this.sessionId + '/message/' + this.snapshot.turnId).catch(() => null) as Native | null;
        const inbox = await this.instance.transport.request('/api/session/' + this.sessionId + '/inbox').catch(() => null) as Native | null;
        if (accepted?.data?.id !== this.snapshot.turnId && !inbox?.data?.some((item: Native) => item.id === this.snapshot.turnId)) throw new AgentError('outcome_unknown');
      }
      this.snapshot.state = 'running'; this.starting = false;
      this.monitor = this.watch(); void this.monitor.catch(() => {});
      return this.copy();
    } catch (error) {
      this.starting = false;
      if (!this.started) {
        await this.instance?.stop(); await this.host?.close();
        if (this.sessionId) this.journal?.observe(this.instance!.identity.instanceId, 'session', this.sessionId, this.cancelled ? 'cancelled' : 'failed');
        this.snapshot.state = this.journal?.unresolved ? 'unknown' : this.cancelled ? 'cancelled' : 'failed';
        this.snapshot.failureReason = error instanceof AgentError ? error.reason : 'runtime_unavailable';
        this.snapshot.reason = new AgentError(this.snapshot.failureReason).message;
        await this.emit(); return this.copy();
      }
      else { this.snapshot.state = 'unknown'; this.journal?.disconnected(); }
      throw error;
    }
  }
  private async ownsSession(id: string): Promise<boolean> {
    if (!this.instance || !/^ses_[A-Za-z0-9_-]+$/.test(id)) return false;
    if (this.sessions.has(id)) return true;
    const seen = new Set<string>(); let current = id;
    while (!seen.has(current) && seen.size < 128) {
      seen.add(current); const value = await this.instance.transport.request('/api/session/' + current) as Native;
      if (value.data?.location?.directory !== this.instance.identity.cwd) return false;
      const fork = this.journal?.list().find(action => action.kind === 'session' && action.id === current && action.parentId === value.data?.fork?.sessionID);
      const parent = value.data.parentID ?? (fork ? fork.parentId : null);
      if (typeof parent !== 'string') return false;
      if (this.sessions.has(parent)) { for (const child of seen) this.sessions.add(child); return true; } current = parent;
    }
    return false;
  }
  private async observe(): Promise<RuntimeSnapshot> {
    if (this.drainedOutcome && !this.journal?.unresolved && !this.operations.unresolved) { this.snapshot.state = this.drainedOutcome; return this.copy(); }
    if (!this.instance || !this.journal || !this.started || terminal(this.snapshot.state)) return this.copy();
    if (this.instance.process.child.exitCode !== null || this.instance.process.child.signalCode !== null) {
      this.operations.cancelPending();
      for (const operation of this.operations.list()) if (['unknown', 'dispatched'].includes(operation.phase)) {
        const action = this.journal.list().find(action => action.kind === 'skill' && action.id === operation.callId);
        if (action && ['completed', 'failed', 'cancelled'].includes(action.phase)) this.operations.confirm(operation.callId, action.phase as 'completed' | 'failed' | 'cancelled');
      }
      if (!this.journal.unresolved && !this.operations.unresolved) { this.snapshot.state = this.cancelled ? 'cancelled' : 'interrupted'; this.drainedOutcome = this.snapshot.state; await this.host?.close(); await this.interactions?.cancel(); return this.copy(); }
      throw new AgentError('outcome_unknown');
    }
    const transport = this.instance.transport;
    if (this.cancelled) await transport.request('/api/workgraph/drain', { method: 'POST' });
    const listed: Native[] = []; let cursor = ''; const cursors = new Set<string>();
    do {
      const page = await transport.request('/api/session?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')) as Native;
      if (!Array.isArray(page.data) || listed.length + page.data.length > 2048) throw new AgentError('protocol_error');
      listed.push(...page.data);
      cursor = page.data.length ? page.cursor?.next ?? '' : '';
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new AgentError('protocol_error');
      cursors.add(cursor);
    } while (cursor);
    const active = (await transport.request('/api/session/active') as Native).data;
    if (!active || typeof active !== 'object') throw new AgentError('protocol_error');
    for (const item of listed) if ((item.parentID || item.fork) && await this.ownsSession(item.id)) this.sessions.add(item.id);
    let allEnded = true; let main: Native | undefined; const outcomes = new Map<string, string>();
    for (const id of this.sessions) {
      const value = (await transport.request('/api/session/' + id) as Native).data;
      if (!value || value.location?.directory !== this.instance.identity.cwd) throw new AgentError('outcome_unknown');
      const action = this.journal.list().find(action => action.kind === 'session' && action.id === id);
      if (!action) this.journal.register({ kind: 'session', id, parentId: value.parentID ?? null });
      const inbox = await transport.request('/api/session/' + id + '/inbox') as Native;
      if (!Array.isArray(inbox.data)) throw new AgentError('protocol_error');
      const cancelledIdle = this.cancelled && action?.phase === 'cancelled';
      const ended = (['succeeded', 'failed', 'interrupted'].includes(value.outcome) || cancelledIdle) && !active[id] && !inbox.data.length;
      allEnded &&= ended;
      outcomes.set(id, cancelledIdle || value.outcome === 'interrupted' ? 'cancelled' : value.outcome === 'succeeded' ? 'completed' : 'failed');
      if (!ended && (!action || !['completed', 'failed', 'cancelled'].includes(action.phase))) this.journal.observe(this.instance.identity.instanceId, 'session', id, 'running');
      if (id === this.sessionId) main = value;
    }
    if (main?.model?.providerID + '/' + main?.model?.id !== this.context!.model.model || (main?.model?.variant ?? 'default') !== (selectedVariant(this.dependencies.selection) || 'default') || main?.agent !== String(this.dependencies.selection.options.profile || 'build')) throw new AgentError('outcome_unknown');
    const content = (await transport.request('/api/session/' + this.sessionId + '/context') as Native).data;
    if (!Array.isArray(content) || content.length > 2048) throw new AgentError('protocol_error');
    // Compaction records its own model usage. Native IDs deduplicate repeated
    // polls and inherited fork history; retain usage removed from later context.
    for (const id of this.sessions) {
      const messages = id === this.sessionId ? content : (await transport.request('/api/session/' + id + '/context') as Native).data;
      if (!Array.isArray(messages) || messages.length > 2048) throw new AgentError('protocol_error');
      for (const message of messages) if (['assistant', 'compaction'].includes(message.type) && typeof message.id === 'string' && message.tokens) {
        const value = message.tokens;
        const usage = tokenUsage(sumTokens(value.input, value.cache?.read ?? 0, value.cache?.write ?? 0), sumTokens(value.output, value.reasoning ?? 0));
        if (usage) {
          const previous = this.messageUsage.get(message.id);
          this.messageUsage.set(message.id, {input: Math.max(previous?.input ?? 0, usage.input), output: Math.max(previous?.output ?? 0, usage.output)});
        }
      }
    }
    if (this.messageUsage.size) {
      const usage = [...this.messageUsage.values()];
      const total = tokenUsage(sumTokens(...usage.map(value => value.input)), sumTokens(...usage.map(value => value.output)));
      if (total) this.snapshot.tokenUsage = total;
    }
    for (const message of content) if (message.type === 'assistant' && message.time?.completed && !message.error) {
      const answer = (message.content ?? []).filter((part: Native) => part.type === 'text').map((part: Native) => part.text).join(String.fromCharCode(10));
      if (Buffer.byteLength(answer) > 1024 * 1024) throw new AgentError('protocol_error');
      if (!message.content.some((part: Native) => part.type === 'tool')) this.snapshot.answer = redactSkillValues(answer, this.secrets);
      if (!this.messages.has(message.id) && answer) {
        if (this.messages.size >= 2048) throw new AgentError('protocol_error');
        const text = publicProgressText(redactSkillValues(answer, this.secrets));
        if (text) { this.snapshot.progress = { messageId: message.id, phase: message.content.some((part: Native) => part.type === 'tool') ? 'commentary' : 'final_answer', text };
          this.snapshot.identity = { backendId: 'opencode', attemptId: this.dependencies.attemptId, messageId: message.id, sessionId: this.sessionId, ...(this.snapshot.turnId ? { turnId: this.snapshot.turnId } : {}) }; await this.emit(); delete this.snapshot.progress; }
        this.messages.add(message.id);
      }
    }
    const waiting = await this.interactions!.observe([...this.sessions]);
    for (const operation of this.operations.list()) if (operation.phase === 'unknown') {
      const result = await transport.request('/api/workgraph/command/' + encodeURIComponent(operation.callId)) as Native;
      if (['completed', 'failed', 'cancelled'].includes(result.status)) this.operations.confirm(operation.callId, result.status);
    }
    const bridge = await transport.request('/api/workgraph/state') as Native;
    if (allEnded && !waiting && !bridge.pendingBackground && !this.journal.list().some(action => !['session', 'process'].includes(action.kind) && !['completed', 'failed', 'cancelled'].includes(action.phase)) && !this.operations.unresolved && (bridge.accepting || this.journal.list().some(action => action.kind === 'process' && !['completed', 'failed', 'cancelled'].includes(action.phase)))) {
      this.sealed = true;
      const seal = await transport.request('/api/workgraph/seal', { method: 'POST' }) as Native;
      if (seal.sealed !== true && bridge.accepting) this.sealed = false;
      return this.copy();
    }
    if (allEnded && !waiting && !bridge.pendingBackground && !this.journal.list().some(action => action.kind !== 'session' && !['completed', 'failed', 'cancelled'].includes(action.phase)) && !this.operations.unresolved) {
      for (const [id, phase] of outcomes) this.journal.observe(this.instance.identity.instanceId, 'session', id, phase as 'completed' | 'failed' | 'cancelled');
      if (this.callbackFailed) { await this.emit(); return this.copy(); }
      // Keep a successful, sealed original instance until release so the
      // existing continuation extension can explicitly start its next busy
      // period. It has no admitting tools/MCP processes while sealed.
      if (this.cancelled || this.timedOut || main?.outcome !== 'succeeded') { await this.instance.stop(); await this.host?.close(); }
      await this.interactions!.cancel();
      this.snapshot.state = this.callbackFailed ? 'unknown' : this.timedOut || this.unsupportedInteraction ? 'failed' : this.cancelled ? 'cancelled' : main?.outcome === 'succeeded' ? 'completed' : 'failed';
      if (this.snapshot.state !== 'unknown') this.drainedOutcome = this.snapshot.state;
      if (this.snapshot.state === 'failed') {
        const error = content.filter((message: Native) => message.error).at(-1)?.error;
        this.snapshot.failureReason = this.unsupportedInteraction ? 'capability_unsupported' : this.timedOut ? 'timeout' : error?.status === 401 ? 'authentication_required' : error?.status === 429 ? 'quota_exceeded' : error?.status === 403 ? 'permission_denied' : 'runtime_unavailable';
        this.snapshot.reason = new AgentError(this.snapshot.failureReason).message;
      } else this.snapshot.reason = null;
    } else this.snapshot.state = this.cancelled ? 'cancelling' : waiting ?? 'running';
    return this.copy();
  }
  private async watch(): Promise<void> {
    const end = Date.now() + (this.options.runTimeoutMs ?? 30 * 60_000);
    while (!this.disposed && !terminal(this.snapshot.state)) {
      try { await this.reconcile(this.dependencies.runId); await this.emit(); }
      catch (error) {
        if (error instanceof AgentError && error.reason === 'capability_unsupported' && !this.cancelled) { this.unsupportedInteraction = true; await this.cancel(this.dependencies.runId).catch(() => {}); }
        if (!terminal(this.snapshot.state)) { this.snapshot.state = 'unknown'; this.snapshot.failureReason = 'outcome_unknown'; this.snapshot.reason = 'OpenCode 原生工作状态尚未确认。'; }
        await this.emit().catch(() => {});
      }
      if (Date.now() > end && !this.cancelled) { this.timedOut = true; await this.cancel(this.dependencies.runId); }
      if (!terminal(this.snapshot.state)) await new Promise(accept => setTimeout(accept, this.options.pollMs ?? 250));
    }
  }
  async reconcile(id: string): Promise<RuntimeSnapshot> {
    this.check(id); if (this.observed) return this.observed;
    this.observed = this.observe();
    try { return await this.observed; }
    catch (error) {
      if (!(error instanceof AgentError) || !['outcome_unknown', 'runtime_unavailable', 'timeout'].includes(error.reason)) throw error;
      if (!terminal(this.snapshot.state)) { this.snapshot.state = 'unknown'; this.snapshot.failureReason = 'outcome_unknown'; this.snapshot.reason = new AgentError('outcome_unknown').message; }
      return this.copy();
    } finally { this.observed = undefined; }
  }
  async cancel(id: string): Promise<RuntimeSnapshot> {
    this.check(id); this.cancelled = true; this.preparation.abort(); this.operations.cancelPending();
    if (this.instance && this.started && !terminal(this.snapshot.state)) {
      await this.instance.transport.request('/api/workgraph/cancel', { method: 'POST' }).catch(() => {});
      for (const session of this.sessions) await this.instance.transport.request('/api/session/' + session + '/interrupt?resume=false', { method: 'POST' }).catch(() => {});
      await this.interactions?.cancel();
      // An observation already in flight can finish draining while native
      // cancellation is settling. Never reactivate its terminal snapshot.
      if (!terminal(this.snapshot.state)) this.snapshot.state = 'cancelling';
      try { return await this.reconcile(id); }
      catch { if (!terminal(this.snapshot.state)) { this.snapshot.state = 'cancelling'; this.snapshot.reason = new AgentError('outcome_unknown').message; } return this.copy(); }
    }
    if (!this.starting && !this.started) { this.snapshot.state = 'cancelled'; await this.host?.close(); }
    return this.copy();
  }
  async respond(id: string, interactionId: string, reply: BackendReply): Promise<RuntimeSnapshot> { this.check(id); if (!this.interactions || this.cancelled || terminal(this.snapshot.state)) throw new AgentError('outcome_unknown'); await this.interactions.respond(interactionId, reply); return this.reconcile(id); }
  async continue(context: AgentExtensionContext, message: string): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (this.continuing || context.attemptId !== this.dependencies.attemptId || JSON.stringify(context.context.agent) !== JSON.stringify(this.dependencies.selection) || this.snapshot.state !== 'completed' || this.released || this.cancelled || !this.instance || !this.journal || typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 65536) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted(); this.continuing = true;
    try {
    await this.monitor; await this.callbacksQueue;
    if (this.released || this.cancelled || this.disposed) throw new AgentError('outcome_unknown');
    this.journal.assertDrained();
    const callId = hash([this.snapshot.turnId, message]), inputId = 'msg_' + createHash('sha256').update('continue:' + callId).digest('hex').slice(0, 40);
    this.interactions?.close();
    this.callbacks = context.callbacks;
    this.interactions = new OpenCodeInteractions(this.instance.transport, this.instance.identity.directory, this.dependencies.selection.options.sandboxMode === 'danger-full-access', context.callbacks, text => redactSkillValues(text, this.secrets), this.instance.identity.cwd);
    delete this.drainedOutcome; this.sealed = false; this.snapshot.state = 'starting'; this.snapshot.answer = ''; this.snapshot.turnId = inputId; delete this.snapshot.failureReason; delete this.snapshot.progress;
    try { await this.instance.transport.request('/api/workgraph/continue', { method: 'POST', body: { callId, sessionId: this.sessionId, text: message }, signal: context.signal }); this.snapshot.state = 'running'; }
    catch { this.snapshot.state = 'unknown'; }
    this.monitor = this.watch(); void this.monitor.catch(() => {}); return this.copy();
    } finally { this.continuing = false; }
  }
  async attach(context: AgentExtensionContext): Promise<RuntimeSnapshot> { this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || !this.started) throw new AgentError('outcome_unknown'); return this.reconcile(context.runId); }
  async dispatchCommand(id: string, args: unknown): Promise<Json> {
    if (!this.active() || !this.instance || !this.callbacks?.withSkillEnvironment || !args || typeof args !== 'object' || Array.isArray(args)) throw new AgentError('outcome_unknown');
    const request = args as Native;
    if (Object.keys(request).some(key => !['skillId', 'command'].includes(key)) || typeof request.skillId !== 'string' || !Array.isArray(request.command) || !request.command.length || request.command.some((arg: unknown) => typeof arg !== 'string')) throw new AgentError('invalid_configuration');
    const skill = this.context!.skills?.find(skill => skill.source === 'openworkgraph' && skill.skillId === request.skillId);
    if (!skill) throw new AgentError('invalid_configuration');
    const fingerprint = hash(request), prior = this.commands.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AgentError('outcome_unknown');
      try { return await prior.value; }
      catch {
        const observed = await this.instance.transport.request('/api/workgraph/command/' + encodeURIComponent(id)) as Native;
        if (!['completed', 'failed', 'cancelled'].includes(observed.status)) throw new AgentError('outcome_unknown');
        if (this.operations.list().find(operation => operation.callId === id)?.phase === 'unknown') this.operations.confirm(id, observed.status);
        return observed as Json;
      }
    }
    this.operations.enqueue(id);
    const value = this.operations.dispatch(id, request.skillId, this.callbacks.withSkillEnvironment, async (environment, secrets) => {
      for (const value of Object.values(secrets)) if (value) this.secrets[hash(value)] = value;
      try { return await this.instance!.transport.request('/api/workgraph/command', { method: 'POST', body: { callId: id, sessionId: this.sessionId, argv: request.command, environment, secrets } }) as Json; }
      catch (error) {
        const observed = await this.instance!.transport.request('/api/workgraph/command/' + encodeURIComponent(id)).catch(() => null) as Native | null;
        if (observed && ['completed', 'failed', 'cancelled'].includes(observed.status)) return observed as Json;
        throw error;
      }
    });
    this.commands.set(id, { fingerprint, value }); return value;
  }
  async dispatch(context: AgentExtensionContext, request: Json): Promise<Json> {
    this.check(context.runId);
    if (context.attemptId !== this.dependencies.attemptId || !request || typeof request !== 'object' || Array.isArray(request) || typeof request.callId !== 'string') throw new AgentError('invalid_configuration');
    context.signal.throwIfAborted(); const { callId, ...args } = request; return this.dispatchCommand(callId, args);
  }
  async execute(context: AgentExtensionContext, request: Json): Promise<Json> {
    this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || !this.runOperations || !this.active()) throw new AgentError('outcome_unknown');
    if (request && typeof request === 'object' && !Array.isArray(request) && typeof request.type === 'string' && request.type.startsWith('recovery.')) return openCodeRecoveryOperation({ runId: context.runId, attemptId: context.attemptId, serviceRoot: context.context.serviceRoot, projectPath: context.context.projectPath, selection: this.dependencies.selection, signal: context.signal }, request);
    if (request && typeof request === 'object' && !Array.isArray(request) && ['external.open', 'external.confirm'].includes(String(request.type))) {
      if (Object.keys(request).some(key => !['type', 'actionId'].includes(key)) || typeof request.actionId !== 'string' || !this.interactions) throw new AgentError('invalid_configuration');
      return this.interactions.external(request.actionId, request.type === 'external.confirm');
    }
    const result = await this.runOperations.execute(request);
    if (request && typeof request === 'object' && !Array.isArray(request) && typeof request.type === 'string' && request.type.startsWith('revert.') && result && typeof result === 'object' && !Array.isArray(result) && result.applied === true) this.snapshot.answer = '';
    return result;
  }
  async releaseRun(id: string) {
    this.check(id);
    if (this.starting || this.continuing || !terminal(this.snapshot.state) || this.journal?.unresolved || this.operations.unresolved || this.callbackFailed) throw new AgentError('outcome_unknown');
    await this.monitor; await this.instance?.stop(); await this.callbacksQueue;
    if (!terminal(this.snapshot.state) || this.journal?.unresolved || this.operations.unresolved || this.callbackFailed) throw new AgentError('outcome_unknown');
    this.released = true;
  }
  async disposeUnstarted() { if (this.started || this.starting) throw new AgentError('outcome_unknown'); await this.dispose(); }
  async disposeDrained() { if (this.started && !this.released || this.starting) throw new AgentError('outcome_unknown'); await this.dispose(); }
  private async dispose() { if (this.disposed) return; this.preparation.abort(); await this.instance?.stop(); await this.host?.close(); this.instructions?.close(); this.interactions?.close(); this.runOperations?.close(); this.journal?.close(); this.disposed = true; this.unregister(); }
}

export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): AgentPlugin {
  const device = { ...options, ...(options.environment ? { environment: { ...options.environment } } : {}) }, attached = new Map<string, OpenCodeAdapter>();
  const key = (runId: string, attemptId: string) => hash([runId, attemptId]);
  const adapter = (context: AgentExtensionContext) => { const value = attached.get(key(context.runId, context.attemptId)); if (!value) throw new AgentError('outcome_unknown'); return value; };
  return {
    descriptor: structuredClone(descriptor), projectPermissions: mode => ({ sandboxMode: mode }),
    createAdapter(dependencies) { dependencies.signal?.throwIfAborted(); normalizeConfiguration(descriptor.configuration, dependencies.selection.options, dependencies.selection.schemaVersion, dependencies.platform);
      const id = key(dependencies.runId, dependencies.attemptId); if (attached.has(id)) throw new AgentError('outcome_unknown');
      const value = new OpenCodeAdapter(dependencies, device, () => attached.delete(id)); attached.set(id, value); return value; },
    listModels: async context => publicModels(await catalog(device, context)),
    modelGroup: modelProviderGroup,
    normalizeSettings: options => ({ ...options, profile: 'build', variant: '' }),
    async diagnose(context): Promise<AgentAvailability> { context.signal.throwIfAborted(); try { const installed = await openCodeDevice(device); return { status: 'unknown', reason: null, message: '原生 SDK 已安装；提供商认证与额度由原生模型调用检查。', runtimeVersion: installed.sdkVersion, installation: 'installed' }; }
      catch (error) { const reason = error instanceof AgentError ? error.reason : 'runtime_unavailable'; const missing = error instanceof OpenCodeSdkMissingError;
        return { status: 'unavailable', reason, message: missing ? 'OpenCode integration is incomplete. On the Workspace device, reinstall OpenWorkgraph with npm install -g openworkgraph --include=optional, then restart the Workspace and refresh the Agent catalog.' : new AgentError(reason).message, installation: missing ? 'missing' : 'unknown' }; } },
    evaluateTask: openCodeTaskAvailability,
    extensions: {
      runOperations: { version: 1, execute: (context, request) => adapter(context).execute(context, request) },
      conversationContinuation: { version: 1, continue: (context, message) => adapter(context).continue(context, message) },
      restartRecovery: { version: 1, reconcile: recoverOpenCodeRun, operation: openCodeRecoveryOperation },
      nativeCatalog: { version: 1, async list(context) { const value = await catalog(device, context); return { version: 1, revision: value.revision, profiles: value.agents, commands: value.commands.map(command => ({ ...command, description: command.description && publicText(command.description, 2048) ? command.description : null })), profileOption: 'profile' }; } },
      nativeSkills: { version: 1, async list(context) { return (await catalog(device, context)).skills.filter(skill => isSkillName(nativeSkillName(skill))).map(skill => ({ skillId: nativeSkillId(skill), name: nativeSkillName(skill), description: skill.description && publicText(skill.description, 4096) ? skill.description : '' })); } },
      ...(process.platform === 'win32' ? {} : { configuredSkills: { version: 1 as const, prepare: (context: AgentExtensionContext) => adapter(context).prepare(context) }, dynamicSkillCommands: { version: 1 as const, dispatch: (context: AgentExtensionContext, request: Json) => adapter(context).dispatch(context, request) } }),
      historyTools: { version: 1, async install(context) { context.signal.throwIfAborted(); adapter(context); } },
      reattach: { version: 1, attach: context => adapter(context).attach(context) },
    },
  };
}
