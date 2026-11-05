import { AGENT_PLUGIN_API_VERSION, SERVICE_VERSION, isSkillName } from '@openworkgraph/protocol';
import type { AgentDescriptor, AgentAvailability, AgentModelOption } from '@openworkgraph/protocol';
import type { AgentPlugin, AgentQueryContext, AgentTaskRequirements, AgentExtensionContext } from './contracts.js';
import { AgentError } from './errors.js';
import { normalizeConfiguration, publicText } from './configuration.js';
import { modelProviderGroup } from './model-groups.js';
import { openCodeCliDevice } from './opencode/cli.js';
import { OpenCodeNotInstalledError } from './opencode/process.js';
import { openCodeQueryInstance } from './opencode/query.js';
import { readOpenCodeNativeCatalog, type OpenCodeNativeCatalog } from './opencode/catalog.js';
import { OpenCodeAcpAdapter, openCodeDigest, type OpenCodeAcpOptions } from './opencode/acp-adapter.js';
import { recoverOpenCodeRun, openCodeRecoveryOperation } from './opencode/recovery.js';
import { isSupportedOpenCodeAcpVersion, OPENCODE_ACP_MINIMUM_VERSION } from './opencode/version.js';

export interface OpenCodePluginOptions extends OpenCodeAcpOptions {}
const descriptor: AgentDescriptor = {
  id: 'opencode', name: 'OpenCode', description: '通过官方 ACP 执行 OpenCode 任务。', logo: { symbol: 'OC', color: '#3F3F46' },
  implementationVersion: SERVICE_VERSION, apiVersion: AGENT_PLUGIN_API_VERSION,
  projectPermissionModes: ['danger-full-access'],
  configuration: { version: 1, fields: [
    { name: 'sandboxMode', type: 'enum', label: '项目权限', default: 'workspace-write', required: true, values: ['read-only', 'workspace-write', 'danger-full-access'] },
    { name: 'profile', type: 'text', label: '原生 Agent', default: 'build', maxLength: 256, hidden: true },
    { name: 'variant', type: 'text', label: '模型变体', default: '', maxLength: 64, hidden: true },
  ] },
  models: { type: 'dynamic', allowCustom: false, effort: true, variantOption: 'variant' },
  capabilities: { kinds: ['execution', 'text_generation', 'visualize_generation'], inputKinds: ['text', 'image', 'document', 'video', 'file'], platforms: ['darwin', 'linux', 'win32'],
    cancellation: true, restoredRunStart: true, conversationContinuation: false, reattach: true, approvals: true, userInput: true, historyTools: true, nativeSkills: true, configuredSkills: true, dynamicSkillCommands: false, visualize: true },
};
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const nativeSkillName = (skill: OpenCodeNativeCatalog['skills'][number]) => isSkillName(skill.name) ? skill.name : skill.id;
function publicModels(catalog: OpenCodeNativeCatalog): AgentModelOption[] {
  return catalog.models.map(model => ({ id: model.id, reasoningEfforts: [...effortOrder.filter(value => model.variants.includes(value)), ...model.variants.filter(value => !effortOrder.includes(value))], variants: model.variants, tools: model.tools,
    inputKinds: ['text', ...(model.input.includes('image') ? ['image'] : []), ...(model.tools ? ['document', 'file', 'video'] : [])] as NonNullable<AgentModelOption['inputKinds']> }));
}
async function catalog(options: OpenCodePluginOptions, context: AgentQueryContext): Promise<OpenCodeNativeCatalog> {
  const device = await openCodeCliDevice(options, context.signal);
  if (!isSupportedOpenCodeAcpVersion(device.runtimeVersion)) throw new AgentError('capability_unsupported');
  const instance = await openCodeQueryInstance(device, context, { update: 'disable', share: 'disabled', warming: false }, true);
  return readOpenCodeNativeCatalog(instance.transport, instance.identity.cwd, context.signal);
}
function evaluateTask(requirements: AgentTaskRequirements): AgentAvailability {
  const model = requirements.modelCapabilities;
  const supported = requirements.kind !== 'image_generation' && requirements.options.sandboxMode === 'danger-full-access'
    && !requirements.skills?.some(skill => skill.requiresConfiguration && (skill.source !== 'openworkgraph' || !skill.explicit) || skill.source === 'codex' || skill.source === 'agent' && skill.backendId !== 'opencode')
    && !(model?.tools === false && (requirements.kind !== 'text_generation' || !!requirements.skills?.length || !!requirements.projectFiles?.length || requirements.inputKinds.some(kind => !['text', 'image'].includes(kind))))
    && (!model?.inputKinds || requirements.inputKinds.every(kind => model.inputKinds!.includes(kind)));
  return { status: supported ? 'available' : 'unavailable', reason: supported ? null : 'capability_unsupported', message: supported ? '使用官方 ACP 执行前台任务。' : requirements.options.sandboxMode !== 'danger-full-access' ? 'OpenCode ACP 仅支持完全访问；请在 Agent 设置中明确选择权限。' : 'OpenCode ACP 不支持此任务或技能组合。' };
}
export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): AgentPlugin {
  const device = { ...options, ...(options.environment ? { environment: { ...options.environment } } : {}) }, attached = new Map<string, OpenCodeAcpAdapter>();
  const key = (runId: string, attemptId: string) => openCodeDigest([runId, attemptId]);
  const adapter = (context: AgentExtensionContext) => { const value = attached.get(key(context.runId, context.attemptId)); if (!value) throw new AgentError('outcome_unknown'); return value; };
  return {
    descriptor: structuredClone(descriptor), projectPermissions: mode => ({ sandboxMode: mode }),
    createAdapter(dependencies) {
      dependencies.signal?.throwIfAborted(); normalizeConfiguration(descriptor.configuration, dependencies.selection.options, dependencies.selection.schemaVersion, dependencies.platform);
      const id = key(dependencies.runId, dependencies.attemptId); if (attached.has(id)) throw new AgentError('outcome_unknown');
      const value = new OpenCodeAcpAdapter(dependencies, device, () => attached.delete(id)); attached.set(id, value); return value;
    },
    listModels: async context => publicModels(await catalog(device, context)), modelGroup: modelProviderGroup,
    normalizeSettings: options => ({ ...options, profile: 'build', variant: '' }), evaluateTask,
    async diagnose(context): Promise<AgentAvailability> {
      context.signal.throwIfAborted();
      try {
        const installed = await openCodeCliDevice(device, context.signal);
        if (!isSupportedOpenCodeAcpVersion(installed.runtimeVersion)) return { status: 'unavailable', reason: 'capability_unsupported', message: 'OpenCode CLI ' + installed.runtimeVersion + ' 版本不兼容，请在工作空间设备安装 OpenCode ' + OPENCODE_ACP_MINIMUM_VERSION + ' 或更高的 2.x 稳定版后刷新 Agent 配置。', runtimeVersion: installed.runtimeVersion, installation: 'installed' };
        return { status: 'unknown', reason: null, message: 'OpenCode CLI 已安装；认证与额度由原生调用检查。', runtimeVersion: installed.runtimeVersion, installation: 'installed' };
      } catch (error) {
        const reason = error instanceof AgentError ? error.reason : 'runtime_unavailable';
        return { status: 'unavailable', reason, message: error instanceof OpenCodeNotInstalledError ? '请在工作空间设备安装 OpenCode CLI，并确保 opencode 命令可用。' : new AgentError(reason).message, installation: error instanceof OpenCodeNotInstalledError ? 'missing' : 'unknown' };
      }
    },
    extensions: {
      configuredSkills: { version: 1, prepare: context => adapter(context).prepare(context) },
      runOperations: { version: 1, execute: (context, request) => adapter(context).execute(context, request) },
      restartRecovery: { version: 1, reconcile: recoverOpenCodeRun, operation: openCodeRecoveryOperation },
      reattach: { version: 1, attach: context => adapter(context).attach(context) },
      historyTools: { version: 1, async install(context) { context.signal.throwIfAborted(); adapter(context); } },
      nativeCatalog: { version: 1, async list(context) { const value = await catalog(device, context); return { version: 1, revision: value.revision, profiles: value.agents, commands: value.commands.map(command => ({ ...command, description: command.description && publicText(command.description, 2048) ? command.description : null })), profileOption: 'profile' }; } },
      nativeSkills: { version: 1, async list(context) { return (await catalog(device, context)).skills.filter(skill => isSkillName(nativeSkillName(skill))).map(skill => ({ skillId: 'opencode-' + openCodeDigest([skill.id, skill.path, skill.contentSha256]), name: nativeSkillName(skill), description: skill.description && publicText(skill.description, 4096) ? skill.description : '' })); } },
    },
  };
}
