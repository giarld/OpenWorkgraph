import { AGENT_PLUGIN_API_VERSION, SERVICE_VERSION } from '@openworkgraph/protocol';
import type { AgentAvailability, FrozenAgentSelection, SandboxMode, Json, BuiltinAgentConnectionConfiguration } from '@openworkgraph/protocol';
import type { AgentAdapterDependencies, AgentPlugin, AgentExtensionContext } from './contracts.js';
import { AgentError } from './errors.js';
import { BuiltinAgentAdapter } from './builtin/adapter.js';
import type { BuiltinAgentAdapterOptions } from './builtin/adapter.js';
import { builtinModelIdentity, parseBuiltinModelIdentity } from './builtin/connections.js';
import type { BuiltinAgentConnections } from './builtin/connections.js';
import type { BuiltinLocalSkills } from './builtin/local-skills.js';
import { reconcileBuiltinAttempt } from './builtin/recovery.js';
import { BUILTIN_AGENT_LIMITS } from './builtin/limits.js';
import { readBuiltinHistory } from './builtin/history.js';
import { BuiltinCommands } from './builtin/commands.js';
import { diagnoseBuiltinCommands } from './builtin/diagnostics.js';
import { builtinModelInputKinds } from './builtin/inputs.js';
import { builtinAssertMediaFormat, builtinMediaKind } from './builtin/media.js';
import type { BackendRunContext } from '../backend/types.js';

export interface BuiltinAgentPluginOptions {
  connections: BuiltinAgentConnections;
  localSkills?: BuiltinLocalSkills;
  /** Private execution integration, never supplied by Web configuration. */
  adapterOptions?(dependencies: AgentAdapterDependencies): BuiltinAgentAdapterOptions;
  /** Optional custom-host override for the per-command configuration lease. */
  configuredSkills?: boolean;
}
const available = (): AgentAvailability => ({ status: 'available', reason: null, message: '内置 Agent 配置可用。', installation: 'installed', runtimeVersion: SERVICE_VERSION });
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const permission = (mode: SandboxMode) => {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new AgentError('invalid_configuration');
  return { sandboxMode: mode };
};
const reference = (selection: Pick<FrozenAgentSelection, 'model' | 'options'>) => ({ ...parseBuiltinModelIdentity(selection.model.model), revision: Number(selection.options.connectionRevision) });

/** Static factory. Model calls, SDK and tools remain inside this plugin. */
export function createBuiltinAgentPlugin(options: BuiltinAgentPluginOptions): AgentPlugin {
  const connections = options.connections;
  const configuredSkills = options.configuredSkills ?? !options.adapterOptions;
  const attached = new Map<string, BuiltinAgentAdapter>();
  const key = (runId: string, attemptId: string) => JSON.stringify([runId, attemptId]);
  const owned = (context: Pick<AgentExtensionContext, 'runId' | 'attemptId'>) => {
    const adapter = attached.get(key(context.runId, context.attemptId));
    if (!adapter) throw new AgentError('outcome_unknown');
    return adapter;
  };
  return {
    descriptor: {
      id: 'builtin', name: '内置 Agent', description: '通过已配置连接执行任务、生成文本和可视化。', initiallyEnabled: false, defaultPriority: 100,
      logo: { symbol: '✦', color: '#6D5CE7' },
      apiVersion: AGENT_PLUGIN_API_VERSION, implementationVersion: SERVICE_VERSION,
      projectPermissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
      configuration: { version: 1, fields: [
        { name: 'sandboxMode', type: 'enum', label: '项目权限', values: ['read-only', 'workspace-write', 'danger-full-access'], default: 'read-only', hidden: true },
        { name: 'connectionRevision', type: 'number', label: '连接修订', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, integer: true, default: 0, hidden: true },
      ] },
      models: { type: 'dynamic', allowCustom: false, effort: true, automaticVisibility: true },
      capabilities: { kinds: ['execution', 'text_generation', 'visualize_generation'], inputKinds: ['text', 'image', 'video', 'audio', 'file', 'document'],
        platforms: ['darwin', 'linux', 'win32'], cancellation: true, restoredRunStart: true, approvals: true, userInput: true,
        conversationContinuation: false, reattach: false, historyTools: true, nativeSkills: !!options.localSkills, configuredSkills, dynamicSkillCommands: configuredSkills, visualize: true },
    },
    projectPermissions: permission,
    modelGroup(identity) {
      try { const selected = parseBuiltinModelIdentity(identity); return selected.workspaceId === connections.workspaceId ? connections.get(selected.connectionId).name : null; } catch { return null; }
    },
    modelLabel(identity) {
      try {
        const selected = parseBuiltinModelIdentity(identity);
        if (selected.workspaceId !== connections.workspaceId) return null;
        const connection = connections.get(selected.connectionId);
        return connection.name + '/' + (connection.models.find(model => model.id === selected.modelId)?.name ?? selected.modelId);
      } catch { return null; }
    },
    async listModels(context) {
      context.signal.throwIfAborted();
      return connections.list().filter(connection => connection.enabled).flatMap(connection => connection.models.map(model => ({
        id: builtinModelIdentity(connection.id, model.id, connections.workspaceId), reasoningEfforts: [...model.reasoningEfforts], inputKinds: builtinModelInputKinds(model),
        ...(model.tools === null ? {} : { tools: model.tools }), group: connection.name, label: connection.name + '/' + model.name,
      })));
    },
    async diagnose(context) {
      context.signal.throwIfAborted();
      const enabled = (await connections.listConfigured()).filter(connection => connection.enabled);
      context.signal.throwIfAborted();
      if (!enabled.length) return { status: 'unavailable', reason: 'invalid_configuration', message: '请在 Agent 设置中添加并启用连接。', installation: 'installed' };
      if (!enabled.some(connection => connection.credentialConfigured)) return { status: 'unavailable', reason: 'authentication_required', message: '请为连接配置认证。', installation: 'installed' };
      if (!enabled.some(connection => connection.credentialConfigured && connection.models.some(model => model.tools === true && model.contextWindow !== null && model.contextWindow > BUILTIN_AGENT_LIMITS.outputTokens + 4096))) return { status: 'unavailable', reason: 'model_unavailable', message: '请配置支持工具调用且上下文容量足够的模型。', installation: 'installed' };
      if (options.adapterOptions) return { status: 'unknown', reason: null, message: '模型配置可用；自定义命令执行器未提供环境诊断。', installation: 'installed', runtimeVersion: SERVICE_VERSION };
      const commandFailure = await diagnoseBuiltinCommands(context);
      if (commandFailure) return commandFailure;
      return available();
    },
    evaluateTask(requirements) {
      try {
        if (!requirements.model || requirements.skills?.some(skill => skill.requiresConfiguration && !configuredSkills || skill.source === 'agent' && !options.localSkills)) throw new AgentError('capability_unsupported');
        const selected = requirements.options.connectionRevision ? reference({ model: requirements.model, options: requirements.options }) : connections.freeze(requirements.model.model);
        const frozen = connections.frozen(selected);
        if (frozen.model.tools !== true || !frozen.model.contextWindow || frozen.model.contextWindow <= BUILTIN_AGENT_LIMITS.outputTokens + 4096 || requirements.model.reasoningEffort !== null && !frozen.model.reasoningEfforts.includes(requirements.model.reasoningEffort)) throw new AgentError('model_unavailable');
        const required = [
          ...requirements.inputKinds.filter(kind => !requirements.resources?.some(resource => resource.kind === kind) && !requirements.projectFiles?.some(file => file.kind === kind)),
          ...(requirements.resources ?? []).map(resource => resource.kind === 'file' ? 'file' as const : builtinMediaKind(resource.resource?.mime ?? '') ?? resource.kind),
          ...(requirements.projectFiles ?? []).map(file => file.kind),
        ];
        if (required.some(kind => !builtinModelInputKinds(frozen.model).includes(kind))) throw new AgentError('capability_unsupported');
        for (const resource of requirements.resources ?? []) {
          const mime = resource.resource?.mime, native = mime && builtinMediaKind(mime);
          if (native && frozen.model.inputKinds.includes(native)) builtinAssertMediaFormat(mime!, frozen.configuration.protocol);
        }
        // Native binary/media representation is added only with explicit adapter
        // coverage. Existing prepared text/file paths remain ordinary input.
        if (requirements.resources?.some(resource => resource.kind === 'image' && resource.resource && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(resource.resource.mime) || resource.kind === 'document' && !resource.text && resource.resource?.mime !== 'application/pdf')) throw new AgentError('capability_unsupported');
        return available();
      } catch (error) { const failure = error instanceof AgentError ? error : new AgentError('invalid_configuration'); return { status: 'unavailable', reason: failure.reason, message: failure.message }; }
    },
    createAdapter(dependencies) {
      dependencies.signal?.throwIfAborted();
      if ('legacy' in dependencies.selection || dependencies.selection.backendId !== 'builtin') throw new AgentError('invalid_configuration');
      const selected = reference(dependencies.selection); connections.frozen(selected);
      const id = key(dependencies.runId, dependencies.attemptId);
      if (attached.has(id)) throw new AgentError('outcome_unknown');
      const execution = options.adapterOptions ? options.adapterOptions(dependencies) : {
        commandsForContext: (context: Readonly<BackendRunContext>) => new BuiltinCommands(context, dependencies.selection.options.sandboxMode as SandboxMode),
      };
      const adapter = new BuiltinAgentAdapter(dependencies, connections, selected, { ...execution, ...(options.localSkills ? { localSkills: options.localSkills } : {}), ...(configuredSkills ? { skillCommands: true } : {}) }, () => attached.delete(id));
      attached.set(id, adapter);
      return adapter;
    },
    extensions: {
      nodeTitle: { version: 1, generate: context => owned(context).generateNodeTitle(context) },
      ...(configuredSkills ? {
        configuredSkills: { version: 1 as const, prepare: (context: AgentExtensionContext) => owned(context).prepare(context) },
        dynamicSkillCommands: { version: 1 as const, dispatch: (context: AgentExtensionContext, request: Json) => owned(context).dispatch(context, request) },
      } : {}),
      restartRecovery: { version: 1, reconcile: reconcileBuiltinAttempt },
      connectionSettings: { version: 1,
        async list() { return json(await connections.listConfigured()); },
        save(configuration, expected) { return json(connections.set(configuration as unknown as BuiltinAgentConnectionConfiguration, expected)); },
        async prepareCredential(id, value, expected) { const commit = await connections.prepareCredential(id, value, expected); return () => json(commit()); },
        revokeCredential(id, expected) { const result = connections.revokeCredentialCommit(id, expected); return { value: json(result.value), cleanup: result.cleanup }; },
        remove(id, expected) { connections.delete(id, expected); void connections.cleanupDeleted(id).catch(() => {}); },
        async discover(id, expected, signal) { return json(await connections.discover(id, expected, signal)); },
        async discoverDraft(draft, signal) { return json(await connections.discoverDraft(draft, signal)); },
      },
      submission: { version: 1,
        freeze(selection) { const selected = connections.freeze(selection.model.model); return { ...selection, options: { ...selection.options, connectionRevision: selected.revision } }; },
        assertCurrent(selection) { connections.assertCurrent(reference(selection)); },
        withCurrent(selection, accept) { return connections.withCurrent(reference(selection), accept); },
      },
      historyTools: { version: 1, readHistory: readBuiltinHistory, async install() { /* Installed directly from start callbacks in the private adapter. */ } },
      ...(options.localSkills ? { nativeSkills: { version: 1 as const, automatic: true, async list(context: import('./contracts.js').AgentQueryContext) {
        if (!context.projectPath) throw new AgentError('invalid_configuration');
        return options.localSkills!.list(context.projectPath, context.signal);
      }, async validateFrozen(projectPath: string, skills: readonly import('@openworkgraph/protocol').FrozenSkill[]) {
        for (const skill of skills) {
          if (skill.source !== 'agent' || skill.backendId !== 'builtin') throw new AgentError('invalid_configuration');
          const frozen = await options.localSkills!.frozen(skill.skillId, projectPath);
          if (frozen.name !== skill.name) throw new AgentError('invalid_configuration');
        }
      } } } : {}),
    },
  };
}
