import { modelProviderGroup } from './model-groups.js';
import { AGENT_PLUGIN_API_VERSION, SERVICE_VERSION } from '@openworkgraph/protocol';
import type { AgentDescriptor, AgentAvailability, ResourceEnvelope, ProjectFileInput, FrozenSkill, VisualizeFeatureSelection, Json } from '@openworkgraph/protocol';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { AgentAdapter, AgentAdapterDependencies, AgentExtensionContext, AgentPlugin } from './contracts.js';
import type { BackendCallbacks, BackendReply, BackendRunContext, RuntimeSnapshot } from '../backend/types.js';
import { AgentError } from './errors.js';
import { normalizeConfiguration } from './configuration.js';
import { validateSelectionGeneration } from './workspace-configuration-validation.js';
import { validateRunPaths, within } from '../backend/paths.js';
import { nodeGenerationGuidance } from '../prompts/index.js';
import { claudeNativeGuidance } from './claude/guidance.js';
import { publicProgressText } from '../backend/progress.js';
import { redactSkillValues } from '../backend/redaction.js';
import { AgentHostTools } from './host-tools.js';
import { ClaudeHostMcp } from './claude/host-mcp.js';
import { ClaudeTransport } from './claude/transport.js';
import { ClaudeInteractions, claudeResponse } from './claude/interactions.js';
import { claudeNativeSkills, resolveClaudeSkills } from './claude/skills.js';
import { publicSkillGuidance } from '../skill-sessions.js';
import { hasVisualizeFeature } from '../visualize-features.js';
import { nativeSkillCommand } from './claude/skill-command.js';
import { AgentOperations } from './operations.js';
import { ClaudeSessionStore } from './claude/sessions.js';
import { redactClaudeOutput } from './claude/output.js';
import { claudeModels } from './claude/models.js';
import { claudeVersion, launchClaude, signalClaude, claudeGroupAlive, ClaudeExecutableNotFoundError, type ClaudeDeviceOptions } from './claude/process.js';

export type ClaudePluginOptions = ClaudeDeviceOptions;
const descriptor: AgentDescriptor = {
  id: 'claude-code', name: 'Claude Code', description: 'Claude Code 原生任务执行器。',
  logo: { symbol: '✳', color: '#D97757' },
  projectPermissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
  implementationVersion: SERVICE_VERSION, apiVersion: AGENT_PLUGIN_API_VERSION,
  configuration: { version: 1, fields: [{ name: 'sandboxMode', type: 'enum', label: '项目权限', description: '完全访问自动批准权限请求；其他模式使用原生权限规则及用户审批，不提供命令沙盒。', required: true, default: 'read-only', values: ['read-only', 'workspace-write', 'danger-full-access'] }] },
  models: { type: 'dynamic', allowCustom: true, effort: true },
  capabilities: { kinds: ['execution', 'text_generation', 'visualize_generation'], inputKinds: ['text', 'document', 'image', 'video', 'file'], platforms: ['darwin', 'linux', 'win32'], cancellation: true, restoredRunStart: true, conversationContinuation: true, reattach: true, approvals: true, userInput: true, historyTools: true, nativeSkills: true, configuredSkills: true, dynamicSkillCommands: true, visualize: true },
};
const terminal = (state: RuntimeSnapshot['state']) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
const MAX_ANSWER = 1024 * 1024;
function supported(context: { kind: string; resources?: readonly ResourceEnvelope[]; projectFiles?: readonly ProjectFileInput[]; features?: readonly VisualizeFeatureSelection[]; skills?: readonly FrozenSkill[] }): boolean {
  return ['execution', 'text_generation', 'visualize_generation'].includes(context.kind)
    && !(context.skills ?? []).some(skill => skill.source === 'codex' || skill.source === 'agent' && skill.backendId !== descriptor.id)
    && [...(context.resources ?? []), ...(context.projectFiles ?? [])].every(input => descriptor.capabilities.inputKinds.includes(input.kind));
}
export function claudeLaunchArgs(context: BackendRunContext, mcp: Record<string, unknown>): string[] {
  const mode = context.agent?.options.sandboxMode;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(mode))) throw new AgentError('invalid_configuration');
  const runRoot = join(context.serviceRoot, 'runs');
  if ([context.projectPath, runRoot].some(path => /[()*?\[\]\r\n\u0000]/.test(path)) || !context.model.model || context.model.model.startsWith('-') || context.model.reasoningEffort?.startsWith('-')) throw new AgentError('invalid_configuration');
  const writable = mode === 'read-only' ? [runRoot] : [context.projectPath, runRoot];
  const editRule = (path: string) => { const native = path.replaceAll(String.fromCharCode(92), '/'); return 'Edit(/' + (native.startsWith('/') ? native : '/' + native) + '/**)'; };
  // Claude absolute path rules start with //; Edit rules govern Write too.
  const permissions = { allow: ['Read', 'Glob', 'Grep', ...writable.map(editRule), 'mcp__workgraph__query_run_history', 'mcp__workgraph__read_run_context', 'mcp__workgraph__validate_visualize_output', 'mcp__workgraph__run_skill_command'], deny: mode === 'read-only' ? [editRule(context.projectPath), 'Bash', 'PowerShell', 'Agent', 'Task'] : [] };
  // The legacy key is retained for frozen selections; this is permission policy,
  // not an OS sandbox. Complete access is explicitly authorized auto-approval.
  const args = ['--print', '--verbose', '--include-hook-events', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-mode', mode === 'danger-full-access' ? 'bypassPermissions' : 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--setting-sources', 'user,project,local', '--mcp-config', JSON.stringify(mcp), '--settings', JSON.stringify({ sandbox: { enabled: false }, permissions }), '--tools', 'default', '--model', context.model.model, '--add-dir', runRoot];
  if (context.kind !== 'execution') args.push('--add-dir', context.projectPath);
  if (context.model.reasoningEffort !== null) args.push('--effort', context.model.reasoningEffort);
  return args;
}

class ClaudeAgentAdapter implements AgentAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private transport?: ClaudeTransport;
  private interactions?: ClaudeInteractions;
  private context?: BackendRunContext;
  private resumeId?: string;
  private sessionStore?: ClaudeSessionStore;
  private requireResume = false;
  private sessionState?: string;
  private turnActive = false;
  private inputEndTimer?: NodeJS.Timeout;
  private readonly nativeWrites = new Set<Promise<unknown>>();
  private readonly operations = new AgentOperations();
  private readonly commands = new Map<string, { fingerprint: string; work: Promise<Json> }>();
  private commandQueue: Promise<unknown> = Promise.resolve();
  private nativeReady?: Promise<void>;
  private mcp: ClaudeHostMcp | undefined;
  private snapshot: RuntimeSnapshot;
  private callbacks?: BackendCallbacks;
  private callbackQueue: Promise<void> = Promise.resolve();
  private finish?: Promise<void>;
  private closing?: Promise<void>;
  private started = false;
  private starting = false;
  private disposed = false;
  private released = false;
  private active = false;
  private cancelled = false;
  private wireFailed = false;
  private callbackFailed = false;
  private result?: { success: boolean; answer: string; fingerprint: string };
  private readonly messages = new Map<string, Set<string>>();
  private messageCount = 0;
  private secrets: Record<string, string> = {};
  private timer?: NodeJS.Timeout;
  private abort?: () => void;
  private launchSignal?: AbortSignal;
  private nativeClosed?: { code: number | null; signal: NodeJS.Signals | null };
  private preparation = new AbortController();
  private preparationDone?: Promise<void>;
  private startupFailed = false;
  private readonly pendingHooks = new Set<string>();
  private readonly pendingTasks = new Set<string>();
  private readonly taskTypes = new Map<string, string>();
  private readonly finishedTasks = new Map<string, string>();
  private actionsUnknown = false;
  constructor(private readonly dependencies: AgentAdapterDependencies, private readonly options: ClaudePluginOptions, private readonly unregister: () => void) {
    this.snapshot = { runId: dependencies.runId, backendId: 'claude-code', attemptId: dependencies.attemptId, threadId: null, turnId: null, state: 'starting', observedAt: new Date().toISOString(), model: structuredClone(dependencies.selection.model), reason: null, answer: '' };
  }
  private check(runId: string): void { if (this.disposed || runId !== this.dependencies.runId) throw new AgentError('outcome_unknown'); }
  private copy(): RuntimeSnapshot { return structuredClone(this.snapshot); }
  private emit(): void {
    this.snapshot.observedAt = new Date().toISOString(); const value = this.copy();
    this.callbackQueue = this.callbackQueue.then(() => this.callbacks?.onSnapshot(value)).catch(() => { this.callbackFailed = true; });
  }
  private current(): boolean { return this.active && !this.cancelled && !this.disposed && !this.dependencies.signal?.aborted; }
  async install(context: AgentExtensionContext): Promise<void> {
    this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || this.started) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted();
  }
  async prepare(context: AgentExtensionContext): Promise<void> {
    this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || this.started) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted();
    if (context.context.skills?.some(skill => skill.source === 'openworkgraph' && skill.requiresConfiguration) && !context.callbacks.withSkillEnvironment) throw new AgentError('invalid_configuration');
    await validateRunPaths(context.context);
    claudeLaunchArgs({ ...context.context, model: this.dependencies.selection.model }, {});
    this.nativeReady ??= (async () => {
      const cleanup: (() => void | Promise<void>)[] = [];
      const signal = AbortSignal.any([context.signal, this.preparation.signal, ...(this.dependencies.signal ? [this.dependencies.signal] : [])]);
      try { await claudeVersion(this.options, { platform: this.dependencies.platform, projectPath: context.context.projectPath, options: this.dependencies.selection.options, signal, deferCleanup: work => cleanup.push(work) }); }
      finally { await Promise.all(cleanup.map(work => work())); }
    })();
    await this.nativeReady;
  }
  async start(context: BackendRunContext, callbacks: BackendCallbacks): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (this.started || this.starting || context.attemptId !== this.dependencies.attemptId) throw new AgentError('outcome_unknown');
    if (!context.agent || JSON.stringify(context.agent) !== JSON.stringify(this.dependencies.selection)) throw new AgentError('invalid_configuration');
    if (!supported(context)) throw new AgentError('capability_unsupported');
    this.starting = true; this.callbacks = callbacks;
    let prepared!: () => void;
    this.preparationDone = new Promise<void>(resolve => { prepared = resolve; });
    const signal = AbortSignal.any([this.preparation.signal, ...(this.dependencies.signal ? [this.dependencies.signal] : [])]);
    this.launchSignal = signal;
    try {
      await this.prepare({ runId: context.runId, attemptId: this.dependencies.attemptId, signal, context, callbacks });
      signal.throwIfAborted();
      context = { ...context, skills: await resolveClaudeSkills(context.skills ?? [], {}, { platform: this.dependencies.platform, projectPath: context.projectPath, options: this.dependencies.selection.options, signal, deferCleanup() {} }) };
      this.context = context;
      if (!this.sessionStore) {
        this.sessionStore = new ClaudeSessionStore(context);
        const resumed = await this.sessionStore.initialize(); if (resumed) this.resumeId = resumed;
        if (this.requireResume && !resumed) throw new AgentError('outcome_unknown');
      }
      const toolCallbacks = { ...callbacks };
      if (!(context.kind === 'visualize_generation' || context.kind === 'execution' && hasVisualizeFeature(context.features))) {
        delete toolCallbacks.validateVisualizeOutput; delete toolCallbacks.previewVisualizeOutput; delete toolCallbacks.inspectVisualizePreview; delete toolCallbacks.closeVisualizePreview;
      }
      const tools = new AgentHostTools(context.runId, this.dependencies.attemptId, toolCallbacks, () => this.current());
      this.mcp = new ClaudeHostMcp(tools, context.skills?.some(skill => skill.source === 'openworkgraph') && callbacks.withSkillEnvironment ? {
        describe: { version: 1, name: 'run_skill_command', description: 'Execute exactly one frozen skill command using native Claude permissions and protected per-command environment.', inputSchema: { type: 'object', properties: { skillId: { type: 'string', minLength: 1, maxLength: 1024 }, command: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 16000 } } }, required: ['skillId', 'command'], additionalProperties: false } },
        call: (callId, args) => this.dispatchCommand(callId, args),
      } : undefined); const config = await this.mcp.listen(); signal.throwIfAborted();
      const args = claudeLaunchArgs({ ...context, model: this.dependencies.selection.model }, config);
      if (this.resumeId) args.push('--resume=' + this.resumeId, '--system-prompt-snapshot', 'off');
      const skillDirectories: string[] = [];
      for (const skill of context.skills ?? []) {
        if (!isAbsolute(skill.path) || !(await lstat(skill.path)).isFile() || await realpath(skill.path) !== resolve(skill.path)) throw new AgentError('invalid_configuration');
        skillDirectories.push(dirname(skill.path));
      }
      signal.throwIfAborted();
      // Relative materialized references are relative to Input, never native cwd.
      const promptContext = { ...context, ...(context.files ? { files: context.files.map(file => { const path = isAbsolute(file.path) ? file.path : resolve(context.inputPath, file.path); if (!isAbsolute(file.path) && !within(context.inputPath, path)) throw new AgentError('invalid_configuration'); return { ...file, path }; }) } : {}) };
      const skillRead = publicSkillGuidance(context.skills ?? [], { backendId: descriptor.id, dynamicSkillCommands: descriptor.capabilities.dynamicSkillCommands });
      const prompt = [nodeGenerationGuidance(promptContext, { generateTitle: Boolean(callbacks.setNodeTitle) }), skillRead, claudeNativeGuidance(), 'User request follows:', context.prompt].filter(Boolean).join('\n');
      for (const path of skillDirectories) args.push('--add-dir', path);
      const cwd = context.kind === 'execution' ? context.projectPath : context.outputPath;
      this.interactions = new ClaudeInteractions(this.dependencies.selection.options.sandboxMode === 'danger-full-access', () => this.current(), async interaction => {
        if (!this.current()) throw new AgentError('outcome_unknown');
        this.snapshot.state = interaction ? interaction.kind === 'question' ? 'waiting_answer' : 'waiting_approval' : 'running'; this.emit();
        this.callbackQueue = this.callbackQueue.then(() => interaction ? callbacks.onInteraction(interaction) : undefined).catch(() => { this.callbackFailed = true; this.protocolFailure(); });
        await this.callbackQueue;
      }, value => redactSkillValues(value, this.secrets), async id => {
        this.callbackQueue = this.callbackQueue.then(() => callbacks.onInteractionCancelled?.(id)).catch(() => { this.callbackFailed = true; this.protocolFailure(); }); await this.callbackQueue;
      });
      let spawned!: Promise<boolean>;
      const spawn = (environment: Record<string, string>, secrets: Record<string, string> = {}) => {
        signal.throwIfAborted();
        if (this.child) throw new AgentError('outcome_unknown');
        this.secrets = { ...secrets };
        const child = this.child = launchClaude(this.options, args, cwd, { ...process.env, ...environment, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
        this.started = true; this.active = true;
        // Attach before returning to an asynchronous skill lease. Native output
        // and close may arrive before that lease settles or throws.
        const transport: ClaudeTransport = this.transport = new ClaudeTransport(child, event => this.event(event), async event => {
          if (!this.current()) { await transport.send(claudeResponse(event.request_id, { behavior: 'deny', message: 'The Run has stopped.' })); return; }
          if (event.request?.subtype === 'hook_callback' && event.request.callback_id === 'workgraph-redact-output') {
            await transport.send(claudeResponse(event.request_id, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: redactClaudeOutput(event.request.input?.tool_response, this.secrets) } })); return;
          }
          await this.interactions!.request('main', event, message => transport.send(message));
        }, () => this.protocolFailure());
        spawned = new Promise<boolean>(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
        this.closing = transport.closed.then(({ code, signal: nativeSignal, failed }) => {
          this.nativeClosed = { code, signal: nativeSignal }; if (failed) this.wireFailed = true;
          this.finish = this.finishClosed(code, nativeSignal).catch(() => { this.snapshot.state = 'unknown'; this.snapshot.reason = 'Claude 结束状态尚未确认。'; this.emit(); });
          return this.finish;
        });
        // Long development/visualize runs may keep making progress for hours.
        // Only a host-supplied execution deadline may terminate the native run.
        if (this.options.runTimeoutMs !== undefined) {
          this.timer = setTimeout(() => { this.snapshot.failureReason = 'timeout'; this.protocolFailure(); }, this.options.runTimeoutMs);
          this.timer.unref();
        }
        this.abort = () => { void this.cancel(context.runId).catch(() => {}); };
        signal.addEventListener('abort', this.abort, { once: true });
        return child;
      };
      if (callbacks.withSkillEnvironment) await callbacks.withSkillEnvironment(null, spawn);
      else spawn(context.skillEnvironment ?? {}, context.skillEnvironment ?? {});
      if (!this.child) throw new AgentError('invalid_configuration');
      const child = this.child;
      const attached = await spawned;
      if (!attached) { this.started = false; throw new AgentError('runtime_unavailable'); }
      if (signal.aborted) { signalClaude(child, 'SIGTERM'); return this.copy(); }
      if (this.nativeClosed || this.wireFailed) throw new AgentError('outcome_unknown');
      this.snapshot.state = 'running'; this.emit();
      await this.transport!.request({ subtype: 'initialize', hooks: { PostToolUse: [{ hookCallbackIds: ['workgraph-redact-output'] }] }, skills: (context.skills ?? []).filter(skill => skill.source === 'agent' && skill.explicit).map(skill => skill.name) }, this.options.queryTimeoutMs ?? 20000);
      await this.transport!.send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
      return this.copy();
    } catch (error) {
      if (!this.child || !this.started) {
        await this.mcp?.close(); this.mcp = undefined;
        if (error instanceof AgentError && error.reason === 'outcome_unknown' && !this.cancelled) {
          this.actionsUnknown = true; this.snapshot.state = 'unknown'; this.snapshot.reason = '原生会话所有权尚未确认。'; this.emit(); await this.callbackQueue; return this.copy();
        }
        if (!this.child && !this.cancelled) {
          this.snapshot.failureReason = error instanceof AgentError ? error.reason : 'invalid_configuration';
          this.snapshot.state = 'failed'; this.snapshot.reason = 'Claude 启动准备失败。'; this.emit(); await this.callbackQueue;
          if (this.callbackFailed) { this.snapshot.state = 'unknown'; this.snapshot.reason = '宿主回调送达尚未确认。'; }
          // Deliver the confirmed terminal result after start settles, rather
          // than making the router treat a known failure as uncertain dispatch.
          else return this.copy();
        }
      } else if (!terminal(this.snapshot.state)) { this.startupFailed = true; this.active = false; this.snapshot.state = 'unknown'; this.snapshot.reason = '原生启动结果尚未确认。'; this.emit(); signalClaude(this.child, 'SIGKILL'); }
      throw error instanceof AgentError ? error : new AgentError(this.started ? 'outcome_unknown' : 'invalid_configuration');
    } finally {
      this.starting = false;
      if (!this.started && this.cancelled) {
        this.snapshot.state = 'cancelled'; this.snapshot.reason = null; this.emit(); await this.callbackQueue;
        if (this.callbackFailed) { this.snapshot.state = 'unknown'; this.snapshot.reason = '宿主回调送达尚未确认。'; }
      }
      prepared();
    }
  }
  private protocolFailure(): void { this.wireFailed = true; this.active = false; if (this.child) signalClaude(this.child, 'SIGKILL'); }
  private endInput(): void {
    clearTimeout(this.inputEndTimer);
    if (!this.result || this.turnActive || this.pendingTasks.size || this.pendingHooks.size || this.interactions?.pending || this.nativeWrites.size || !this.current()) return;
    // A result ends a turn. Keep stdin available for native follow-up turns,
    // permission replies and MCP while background work is still running.
    this.inputEndTimer = setTimeout(() => {
      if (this.pendingTasks.size || this.pendingHooks.size || this.interactions?.pending || this.transport?.busy || this.nativeWrites.size) { this.endInput(); return; }
      if (this.result && !this.turnActive && this.current()) this.transport?.end();
    }, this.sessionState === 'idle' || this.sessionState === undefined ? 50 : 10000);
    this.inputEndTimer.unref();
  }
  private event(raw: unknown): void | Promise<void> {
    if (this.disposed || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const event = raw as Record<string, any>;
    // Cancellation still drains lifecycle evidence. Hook stdout is never public.
    if (event.type === 'system' && event.subtype === 'session_state_changed') {
      if (!['idle', 'running', 'requires_action'].includes(event.state)) { this.protocolFailure(); return; }
      if (event.state === 'running' && this.result) { delete this.result; this.turnActive = true; clearTimeout(this.inputEndTimer); }
      this.sessionState = event.state; if (event.state === 'idle') { if (this.result) this.turnActive = false; this.endInput(); } return;
    }
    if (event.type === 'control_cancel_request' && typeof event.request_id === 'string') return this.interactions?.abandon('main', event.request_id).then(() => this.endInput());
    if (event.type === 'system' && ['hook_started', 'hook_progress', 'hook_response', 'task_started', 'task_progress', 'task_notification', 'task_updated'].includes(event.subtype)) {
      const hook = event.subtype.startsWith('hook_');
      const id = hook ? event.hook_id : event.task_id;
      const pending = hook ? this.pendingHooks : this.pendingTasks;
      if (typeof id !== 'string' || !id || id.length > 256) { this.actionsUnknown = true; this.protocolFailure(); return; }
      if (event.subtype.endsWith('_started')) {
        if (pending.has(id) || pending.size >= 256) { this.actionsUnknown = true; this.protocolFailure(); return; }
        pending.add(id);
        if (!hook) this.taskTypes.set(id, event.task_type);
      } else if (event.subtype === 'hook_response' || event.subtype === 'task_notification' || event.subtype === 'task_updated' && ['completed', 'failed', 'stopped'].includes(event.changes?.status)) {
        const outcome = hook ? event.outcome : event.status ?? event.changes?.status;
        if (!hook && this.finishedTasks.get(id) === outcome) return;
        if (!pending.has(id) || !(hook ? ['success', 'error', 'cancelled'] : ['completed', 'failed', 'stopped']).includes(outcome)) { this.actionsUnknown = true; this.protocolFailure(); return; }
        pending.delete(id);
        if (!hook) {
          this.finishedTasks.set(id, outcome);
          if (this.result && ['local_agent', 'local_workflow'].includes(this.taskTypes.get(id) ?? '')) this.turnActive = true;
        }
        if (hook && outcome !== 'success') this.wireFailed = true;
      } else if (!pending.has(id)) { this.actionsUnknown = true; this.protocolFailure(); }
      this.endInput(); return;
    }
    if (event.type === 'system' && /^(?:hook|task)_/.test(String(event.subtype))) { this.actionsUnknown = true; this.protocolFailure(); return; }
    if (!this.active) return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string' && event.session_id.length <= 200) {
        if (this.resumeId && event.session_id !== this.resumeId) { this.actionsUnknown = true; this.protocolFailure(); return; }
        this.snapshot.threadId = event.session_id;
        const saving = this.sessionStore!.record(event.session_id, this.child!.pid ?? null); this.nativeWrites.add(saving);
        void saving.then(() => { this.nativeWrites.delete(saving); this.endInput(); }, () => { this.nativeWrites.delete(saving); this.protocolFailure(); });
      }
      return;
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      const failure = { authentication_failed: 'authentication_required', billing_error: 'quota_exceeded', rate_limit: 'quota_exceeded', rate_limit_error: 'quota_exceeded', model_not_found: 'model_unavailable' } as const;
      if (typeof event.error === 'string') { if (Object.hasOwn(failure, event.error)) this.snapshot.failureReason = failure[event.error as keyof typeof failure]; return; }
      const message = event.message;
      if (!message || typeof message.id !== 'string' || message.id.length > 200 || !Array.isArray(message.content)) return;
      if (this.result && (this.turnActive || this.sessionState === 'running')) { delete this.result; this.turnActive = true; clearTimeout(this.inputEndTimer); }
      const text = message.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join(String.fromCharCode(10));
      const safe = publicProgressText(redactSkillValues(text, this.secrets));
      if (!safe) return;
      // Native AssistantMessages describe complete content blocks, not whole
      // responses. Thinking, tools and later text can share message.message.id.
      // Give each public text block an identity the generic host can deduplicate.
      const uuid = typeof event.uuid === 'string' && event.uuid.length > 0 && event.uuid.length <= 200 ? event.uuid : null;
      const fingerprint = createHash('sha256').update(JSON.stringify([uuid, text])).digest('hex');
      const blocks = this.messages.get(message.id) ?? new Set<string>();
      if (blocks.has(fingerprint)) return;
      if (this.messageCount >= 256) { this.protocolFailure(); return; }
      const messageId = blocks.size ? 'claude-content-' + createHash('sha256').update(JSON.stringify([message.id, fingerprint])).digest('hex') : message.id;
      blocks.add(fingerprint); this.messages.set(message.id, blocks); this.messageCount++;
      this.snapshot.progress = { messageId, phase: 'commentary', text: safe };
      this.snapshot.identity = { backendId: 'claude-code', attemptId: this.dependencies.attemptId, messageId, ...(this.snapshot.threadId ? { sessionId: this.snapshot.threadId } : {}) }; this.emit();
      return;
    }
    if (event.type === 'result') {
      const answer = typeof event.result === 'string' ? event.result : '';
      if (Buffer.byteLength(answer) > MAX_ANSWER) { this.protocolFailure(); return; }
      const success = event.subtype === 'success' && event.is_error !== true && !(Array.isArray(event.permission_denials) && event.permission_denials.length);
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) this.snapshot.failureReason = 'permission_denied';
      const fingerprint = JSON.stringify([success, answer]);
      if (this.result && this.result.fingerprint !== fingerprint && !this.turnActive) { this.protocolFailure(); return; }
      this.result = { success, answer: redactSkillValues(answer, this.secrets), fingerprint };
      this.turnActive = false; this.endInput();
    }
  }
  private unconfirmedClose(reason: string): void {
    if (this.snapshot.state === 'unknown' && this.snapshot.reason === reason && !this.snapshot.progress) return;
    this.snapshot.state = 'unknown'; this.snapshot.reason = reason; delete this.snapshot.progress; this.emit();
  }
  private async finishClosed(code: number | null, nativeSignal: NodeJS.Signals | null): Promise<void> {
    clearTimeout(this.timer); clearTimeout(this.inputEndTimer); this.active = false;
    await this.preparationDone;
    await this.mcp?.close(); this.mcp = undefined;
    if (this.child && claudeGroupAlive(this.child)) {
      signalClaude(this.child, 'SIGKILL');
      // A surviving process group is unresolved, even though its parent closed.
      this.unconfirmedClose('Claude 原生进程组尚未确认结束。'); return;
    }
    // No permission response can reach a closed, drained native connection.
    // Withdraw its requests before deciding whether independent work remains.
    await this.transport?.settled();
    await this.interactions?.abandonAll('main');
    await this.callbackQueue;
    if (this.pendingHooks.size || this.pendingTasks.size || this.turnActive || this.interactions?.pending || this.operations.unresolved || this.actionsUnknown || this.startupFailed) {
      this.unconfirmedClose('原生独立动作或启动副作用尚未确认结束。'); await this.callbackQueue; return;
    }
    await this.sessionStore?.closed();
    const result = this.result;
    this.snapshot.state = this.cancelled ? 'cancelled' : !this.wireFailed && !this.callbackFailed && code === 0 && !nativeSignal && result?.success && result.answer.trim() ? 'completed' : 'failed';
    this.snapshot.reason = this.snapshot.state === 'failed' ? this.snapshot.failureReason ? new AgentError(this.snapshot.failureReason).message : 'Claude 未提供已确认的完整成功结果。' : null;
    if (this.snapshot.state === 'completed') {
      this.snapshot.answer = result!.answer;
      const messageId = 'result'; this.snapshot.identity = { backendId: 'claude-code', attemptId: this.dependencies.attemptId, messageId, ...(this.snapshot.threadId ? { sessionId: this.snapshot.threadId } : {}) };
      const safe = publicProgressText(result!.answer); if (safe) this.snapshot.progress = { messageId, phase: 'final_answer', text: safe }; else delete this.snapshot.progress;
    } else delete this.snapshot.progress;
    this.emit(); await this.callbackQueue;
    if (this.callbackFailed) { this.snapshot.state = 'unknown'; this.snapshot.reason = '宿主回调送达尚未确认。'; this.snapshot.answer = ''; delete this.snapshot.progress; }
  }
  async cancel(runId: string): Promise<RuntimeSnapshot> {
    this.check(runId); if (terminal(this.snapshot.state)) { await this.finish; return this.copy(); }
    if (this.cancelled) { await this.closing; return this.copy(); }
    this.cancelled = true; this.active = false; this.operations.cancelPending(); this.interactions?.cancel(); clearTimeout(this.inputEndTimer); this.preparation.abort();
    if (!this.child) {
      this.snapshot.state = this.starting || this.actionsUnknown ? 'unknown' : 'cancelled';
      if (!this.starting) { this.emit(); await this.callbackQueue; if (this.callbackFailed) { this.snapshot.state = 'unknown'; this.snapshot.reason = '宿主回调送达尚未确认。'; } }
      return this.copy();
    }
    const timeout = this.options.stopTimeoutMs ?? 2000;
    if (this.pendingTasks.size && this.transport) {
      await Promise.allSettled([...this.pendingTasks].map(task_id => this.transport!.request({ subtype: 'stop_task', task_id }, timeout)));
      await this.transport.request({ subtype: 'interrupt' }, timeout).catch(() => {});
    }
    signalClaude(this.child, 'SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([this.closing?.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); clearTimeout(timer);
    if (!stopped) {
      signalClaude(this.child, 'SIGKILL');
      const killed = await Promise.race([this.closing?.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); clearTimeout(timer);
      if (!killed) { this.snapshot.state = 'unknown'; this.snapshot.reason = '取消后的原生终态尚未确认。'; this.emit(); }
    }
    return this.copy();
  }
  async respond(runId: string, interactionId: string, reply: BackendReply): Promise<RuntimeSnapshot> {
    this.check(runId); if (!this.interactions) throw new AgentError('outcome_unknown');
    await this.interactions.reply(interactionId, reply); await this.callbackQueue; this.endInput(); return this.copy();
  }
  async dispatch(context: AgentExtensionContext, request: Json): Promise<Json> {
    this.check(context.runId); if (context.attemptId !== this.dependencies.attemptId || !request || typeof request !== 'object' || Array.isArray(request) || typeof request.callId !== 'string') throw new AgentError('invalid_configuration');
    context.signal.throwIfAborted(); const { callId, ...args } = request; return this.dispatchCommand(callId, args);
  }
  private dispatchCommand(callId: string, value: unknown): Promise<Json> {
    if (!this.current() || !this.context || !this.callbacks?.withSkillEnvironment || !value || typeof value !== 'object' || Array.isArray(value)) return Promise.reject(new AgentError('outcome_unknown'));
    const args = value as Record<string, unknown>;
    if (Object.keys(args).some(key => !['skillId', 'command'].includes(key)) || typeof args.skillId !== 'string' || !Array.isArray(args.command) || !args.command.length || args.command.length > 128 || args.command.some(arg => typeof arg !== 'string' || arg.length > 16000 || arg.includes(String.fromCharCode(0))) || !args.command[0]) return Promise.reject(new AgentError('invalid_configuration'));
    const skill = this.context.skills?.find(skill => skill.source === 'openworkgraph' && skill.skillId === args.skillId);
    if (!skill) return Promise.reject(new AgentError('invalid_configuration'));
    const fingerprint = JSON.stringify(args), previous = this.commands.get(callId);
    if (previous) return previous.fingerprint === fingerprint ? previous.work : Promise.reject(new AgentError('outcome_unknown'));
    const argv = [...args.command] as string[], skillId = skill.skillId;
    this.operations.enqueue(callId);
    const work = this.commandQueue.then(async () => {
      if (!this.current()) throw new AgentError('outcome_unknown');
      return this.operations.dispatch(callId, skillId, this.callbacks!.withSkillEnvironment!, (environment, secrets) => {
        for (const secret of Object.values(secrets)) if (secret) this.secrets['activation-' + Object.keys(this.secrets).length] = secret;
        return nativeSkillCommand(this.options, this.context!, argv, environment, secrets, this.launchSignal!, (message, send) => this.interactions!.request(callId, message, send), known => {
          if (known) this.operations.confirm(callId, this.cancelled ? 'cancelled' : 'completed'); else this.actionsUnknown = true;
        }, this.dependencies.platform, id => id === null ? this.interactions!.abandonAll(callId) : this.interactions!.abandon(callId, id));
      });
    });
    this.commands.set(callId, { fingerprint, work }); this.commandQueue = work.catch(() => {}); this.nativeWrites.add(work);
    void work.then(() => { this.nativeWrites.delete(work); this.endInput(); }, () => { this.nativeWrites.delete(work); this.endInput(); }); return work;
  }
  async continue(context: AgentExtensionContext, message: string): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (context.attemptId !== this.dependencies.attemptId || !this.context || !this.snapshot.threadId || this.snapshot.state !== 'completed' || this.released || !message.trim() || message.length > 1048576 || this.dependencies.signal?.aborted) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted(); await this.finish; await this.callbackQueue;
    const resumed = this.snapshot.threadId;
    this.launchSignal?.removeEventListener('abort', this.abort!);
    delete this.child; delete this.transport; delete this.closing; delete this.finish; delete this.nativeClosed; delete this.result;
    delete this.nativeReady;
    this.started = false; this.starting = false; this.active = false; this.wireFailed = false; delete this.sessionState; this.messages.clear(); this.messageCount = 0; this.resumeId = resumed;
    this.snapshot.state = 'starting'; this.snapshot.answer = ''; delete this.snapshot.progress;
    delete this.snapshot.failureReason;
    return this.start({ ...this.context, prompt: message }, context.callbacks);
  }
  async attach(context: AgentExtensionContext): Promise<RuntimeSnapshot> {
    this.check(context.runId);
    if (context.attemptId !== this.dependencies.attemptId || JSON.stringify(context.context.agent) !== JSON.stringify(this.dependencies.selection)) throw new AgentError('outcome_unknown');
    context.signal.throwIfAborted();
    if (this.started) { await this.callbackQueue; return this.copy(); }
    // Resume only an owned, identical frozen Run whose former native process
    // has stopped. Never steal a live process or attach an arbitrary session id.
    this.requireResume = true; return this.start(structuredClone(context.context), context.callbacks);
  }
  async reconcile(runId: string): Promise<RuntimeSnapshot> {
    this.check(runId); if (this.finish) await this.finish;
    if (this.snapshot.state === 'unknown' && this.nativeClosed && !this.callbackFailed && this.child && !claudeGroupAlive(this.child)) {
      this.finish = this.finishClosed(this.nativeClosed.code, this.nativeClosed.signal); await this.finish;
    }
    if (!this.started && !this.starting && !this.cancelled && !terminal(this.snapshot.state)) { this.snapshot.state = 'unknown'; this.snapshot.reason = '没有原生会话，不能恢复推理或伪造终态。'; }
    return this.copy();
  }
  async releaseRun(runId: string): Promise<void> { this.check(runId); if (this.starting || !terminal(this.snapshot.state) || this.child && claudeGroupAlive(this.child)) throw new AgentError('outcome_unknown'); await this.finish; await this.callbackQueue; if (this.callbackFailed) this.snapshot.state = 'unknown'; if (!terminal(this.snapshot.state) || this.child && claudeGroupAlive(this.child)) throw new AgentError('outcome_unknown'); this.released = true; }
  async disposeUnstarted(): Promise<void> { if (this.started || this.starting || this.actionsUnknown) throw new AgentError('outcome_unknown'); this.preparation.abort(); await this.nativeReady?.catch(() => {}); await this.dispose(); }
  async disposeDrained(): Promise<void> { if (this.starting || this.started && !this.released) throw new AgentError('outcome_unknown'); await this.dispose(); }
  private async dispose(): Promise<void> { if (this.disposed) return; this.active = false; this.disposed = true; this.interactions?.cancel(); clearTimeout(this.timer); clearTimeout(this.inputEndTimer); if (this.abort) this.launchSignal?.removeEventListener('abort', this.abort); await this.mcp?.close(); this.mcp = undefined; this.messages.clear(); this.secrets = {}; this.unregister(); }
}

export function createClaudePlugin(options: ClaudePluginOptions = {}): AgentPlugin {
  const privateOptions = { ...options, ...(options.launcherArgs ? { launcherArgs: [...options.launcherArgs] } : {}) };
  const attached = new Map<string, ClaudeAgentAdapter>(); const key = (runId: string, attemptId: string) => JSON.stringify([runId, attemptId]);
  return {
    descriptor: structuredClone(descriptor),
    projectPermissions: mode => ({ sandboxMode: mode }),
    createAdapter(dependencies) {
      dependencies.signal?.throwIfAborted(); const selection = dependencies.selection;
      if (selection.backendId !== descriptor.id || selection.apiVersion !== AGENT_PLUGIN_API_VERSION || 'legacy' in selection || !dependencies.runId || !dependencies.attemptId || !descriptor.capabilities.platforms!.includes(dependencies.platform)) throw new AgentError('invalid_configuration');
      normalizeConfiguration(descriptor.configuration, selection.options, selection.schemaVersion, dependencies.platform);
      validateSelectionGeneration(selection);
      if (selection.settingsGeneration && selection.options.sandboxMode !== selection.permissions!.project) throw new AgentError('invalid_configuration');
      const id = key(dependencies.runId, dependencies.attemptId); if (attached.has(id)) throw new AgentError('outcome_unknown');
      const adapter = new ClaudeAgentAdapter({ ...dependencies, selection: structuredClone(selection) }, privateOptions, () => attached.delete(id)); attached.set(id, adapter); return adapter;
    },
    modelGroup: modelProviderGroup,
    async listModels(context) {
      context.signal.throwIfAborted();
      if (!descriptor.capabilities.platforms!.includes(context.platform)) throw new AgentError('capability_unsupported');
      return claudeModels(privateOptions, context);
    },
    async diagnose(context): Promise<AgentAvailability> {
      context.signal.throwIfAborted();
      if (!descriptor.capabilities.platforms!.includes(context.platform)) return { status: 'unavailable', reason: 'capability_unsupported', message: 'Claude 当前不支持此工作空间平台。' };
      try { const runtimeVersion = await claudeVersion(privateOptions, context); return { status: 'unknown', reason: null, message: 'CLI 版本查询通过；认证与模型调用尚未通过推理验证。', runtimeVersion, installation: 'installed' }; }
      catch (error) { if (context.signal.aborted) throw error; const reason = error instanceof AgentError ? error.reason : 'runtime_unavailable'; return { status: 'unavailable', reason, message: new AgentError(reason).message, installation: error instanceof ClaudeExecutableNotFoundError ? 'missing' : 'unknown' }; }
    },
    evaluateTask(requirements) {
      const available = supported(requirements) && requirements.inputKinds.every(kind => descriptor.capabilities.inputKinds.includes(kind));
      return available ? { status: 'available', reason: null, message: '任务满足原生能力要求；模型别名不表示版本锁定。' } : { status: 'unavailable', reason: 'capability_unsupported', message: 'Claude 当前不支持此任务或技能来源。' };
    },
    extensions: {
      nativeSkills: { version: 1, list: context => claudeNativeSkills({}, context) },
      configuredSkills: { version: 1, async prepare(context) { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); await adapter.prepare(context); } },
      dynamicSkillCommands: { version: 1, async dispatch(context, request) { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); return adapter.dispatch(context, request); } },
      historyTools: { version: 1, async install(context) { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); await adapter.install(context); } },
      conversationContinuation: { version: 1, async continue(context, message) { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); return adapter.continue(context, message); } },
      reattach: { version: 1, async attach(context) { const adapter = attached.get(key(context.runId, context.attemptId)); if (!adapter) throw new AgentError('outcome_unknown'); return adapter.attach(context); } },
    },
  };
}
