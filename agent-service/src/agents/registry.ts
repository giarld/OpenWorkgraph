import { AGENT_PLUGIN_API_VERSION, AGENT_FAILURE_REASONS } from '@openworkgraph/protocol';
import type { AgentAvailability, AgentDescriptor, AgentPlatform, FrozenAgentSelection } from '@openworkgraph/protocol';
import type { AgentAdapter, AgentAdapterDependencies, AgentPlugin, AgentTaskRequirements } from './contracts.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText, validateConfigurationSchema, validPlatform } from './configuration.js';
import { validateSelectionGeneration } from './workspace-configuration-validation.js';
import { AgentError, agentError } from './errors.js';

const booleanCapabilities = ['cancellation', 'restoredRunStart', 'conversationContinuation', 'reattach', 'approvals', 'userInput', 'historyTools', 'nativeSkills', 'configuredSkills', 'dynamicSkillCommands', 'visualize'] as const;
const extensionMethods = { nativeSkills: 'list', configuredSkills: 'prepare', dynamicSkillCommands: 'dispatch', historyTools: 'install', conversationContinuation: 'continue', reattach: 'attach' } as const;
const kinds = ['execution', 'text_generation', 'image_generation', 'visualize_generation'];
const inputKinds = ['text', 'image', 'document', 'video', 'file'];
export function validSemver(value: string): boolean {
  if (value.length > 128) return false;
  const match = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*))?(?:[+]([0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && (!match[4] || match[4].split('.').every(part => !/^[0-9]+$/.test(part) || part === '0' || part[0] !== '0'));
}
export function validAgentId(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) && value.length <= 128; }
function stringList(value: unknown, allowed: readonly string[], nonempty = false): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.length <= allowed.length && value.every(v => typeof v === 'string' && allowed.includes(v)) && new Set(value).size === value.length;
}
export function validateAgentDescriptor(value: unknown): asserts value is AgentDescriptor {
  if (!isPlainRecord(value) || !exactKeys(value, ['id', 'name', 'description', 'implementationVersion', 'apiVersion', 'configuration', 'capabilities', 'models', 'logo', 'projectPermissionModes']) || !validAgentId(value.id) || !publicText(value.name, 256) || !publicText(value.description) || typeof value.implementationVersion !== 'string' || !validSemver(value.implementationVersion) || value.apiVersion !== AGENT_PLUGIN_API_VERSION) throw new AgentError('protocol_error');
  if (value.logo !== undefined && (!isPlainRecord(value.logo) || !exactKeys(value.logo, ['symbol', 'color']) || !publicText(value.logo.symbol, 16) || [...value.logo.symbol].length > 4 || value.logo.symbol !== value.logo.symbol.trim() || /[\p{Cc}\p{Cf}]/u.test(value.logo.symbol) || typeof value.logo.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.logo.color))) throw new AgentError('protocol_error');
  if (value.projectPermissionModes !== undefined && !stringList(value.projectPermissionModes, ['read-only', 'workspace-write', 'danger-full-access'], true)) throw new AgentError('protocol_error');
  validateConfigurationSchema(value.configuration);
  const caps = value.capabilities; const models = value.models;
  if (!isPlainRecord(caps) || !exactKeys(caps, ['kinds', 'inputKinds', 'platforms', ...booleanCapabilities]) || !stringList(caps.kinds, kinds, true) || !stringList(caps.inputKinds, inputKinds) || booleanCapabilities.some(key => typeof caps[key] !== 'boolean') || (caps.platforms !== undefined && (!Array.isArray(caps.platforms) || caps.platforms.length === 0 || caps.platforms.length > 3 || !caps.platforms.every(validPlatform) || new Set(caps.platforms).size !== caps.platforms.length))) throw new AgentError('protocol_error');
  if (!isPlainRecord(models) || !exactKeys(models, ['type', 'allowCustom', 'effort']) || !['dynamic', 'suggested', 'manual'].includes(String(models.type)) || typeof models.allowCustom !== 'boolean' || typeof models.effort !== 'boolean' || (models.type === 'manual' && !models.allowCustom)) throw new AgentError('protocol_error');
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
export function safeAvailability(value: unknown): AgentAvailability {
  const reasons: readonly string[] = AGENT_FAILURE_REASONS;
  if (!isPlainRecord(value) || !exactKeys(value, ['status', 'reason', 'message', 'runtimeVersion']) || !['available', 'unavailable', 'unknown'].includes(String(value.status)) || !(value.reason === null || reasons.includes(String(value.reason))) || !publicText(value.message, 1024) || (value.status === 'available' && value.reason !== null) || (value.runtimeVersion !== undefined && (typeof value.runtimeVersion !== 'string' || !/^[0-9A-Za-z.+_-]{1,128}$/.test(value.runtimeVersion)))) throw new AgentError('protocol_error');
  return { status: value.status as AgentAvailability['status'], reason: value.reason as AgentAvailability['reason'], message: value.message, ...(value.runtimeVersion === undefined ? {} : { runtimeVersion: value.runtimeVersion as string }) };
}
/** Evaluate captured plugin capabilities without consulting mutable host lookup. */
export function evaluateAgentTask(plugin: AgentPlugin, requirements: AgentTaskRequirements): AgentAvailability {
  const capabilities = plugin.descriptor.capabilities;
  const options = normalizeConfiguration(plugin.descriptor.configuration, requirements.options, plugin.descriptor.configuration.version, requirements.platform);
  if (!capabilities.kinds.includes(requirements.kind) || requirements.inputKinds.some(kind => !capabilities.inputKinds.includes(kind)) || (capabilities.platforms && !capabilities.platforms.includes(requirements.platform)) || (requirements.visualize && (requirements.kind !== 'execution' || !capabilities.visualize)) || (requirements.restoredRunStart && !capabilities.restoredRunStart)) return { status: 'unavailable', reason: 'capability_unsupported', message: '执行器不支持此任务、输入或平台。' };
  if (plugin.evaluateTask) { try { return safeAvailability(plugin.evaluateTask(deepFreeze(structuredClone({ ...requirements, options })))); } catch (error) { throw agentError(error); } }
  return { status: 'available', reason: null, message: '任务满足执行器静态能力要求。' };
}
/** Static composition only. This class never owns Runs, attempts or execution. */
export class AgentRegistry {
  private readonly plugins = new Map<string, AgentPlugin>();
  register(plugin: AgentPlugin): void {
    if (!isPlainRecord(plugin as unknown) || !exactKeys(plugin as unknown as Record<string, unknown>, ['descriptor', 'createAdapter', 'diagnose', 'listModels', 'evaluateTask', 'extensions', 'projectPermissions'])) throw new AgentError('protocol_error');
    validateAgentDescriptor(plugin.descriptor);
    if (this.plugins.has(plugin.descriptor.id)) throw new AgentError('protocol_error', '执行器 ID 已注册。');
    if (typeof plugin.createAdapter !== 'function' || ['diagnose', 'listModels', 'evaluateTask', 'projectPermissions'].some(key => Object.hasOwn(plugin, key) && typeof (plugin as unknown as Record<string, unknown>)[key] !== 'function') || (plugin.descriptor.models.type !== 'manual' && typeof plugin.listModels !== 'function')) throw new AgentError('protocol_error');
    if (plugin.extensions !== undefined && (!isPlainRecord(plugin.extensions as unknown) || !exactKeys(plugin.extensions as unknown as Record<string, unknown>, Object.keys(extensionMethods)))) throw new AgentError('protocol_error');
    for (const [capability, method] of Object.entries(extensionMethods)) {
      const extension = (plugin.extensions as unknown as Record<string, unknown> | undefined)?.[capability];
      const declared = plugin.descriptor.capabilities[capability as keyof typeof extensionMethods];
      if (declared !== (extension !== undefined) || (extension !== undefined && (!isPlainRecord(extension) || !exactKeys(extension, ['version', method]) || extension.version !== 1 || typeof extension[method] !== 'function'))) throw new AgentError('protocol_error');
    }
    // Detach public data and capture functions, so mutating the registration input
    // cannot silently change a previously validated descriptor or factory.
    const copy: AgentPlugin = { descriptor: deepFreeze(structuredClone(plugin.descriptor)), createAdapter: plugin.createAdapter.bind(plugin) };
    if (plugin.projectPermissions) copy.projectPermissions = plugin.projectPermissions.bind(plugin);
    if (plugin.listModels) copy.listModels = plugin.listModels.bind(plugin);
    if (plugin.diagnose) copy.diagnose = plugin.diagnose.bind(plugin);
    if (plugin.evaluateTask) copy.evaluateTask = plugin.evaluateTask.bind(plugin);
    if (plugin.extensions) copy.extensions = deepFreeze(Object.fromEntries(Object.entries(plugin.extensions).map(([key, extension]) => [key, { ...extension }]))) as AgentPlugin['extensions'] & {};
    this.plugins.set(copy.descriptor.id, Object.freeze(copy));
  }
  get(backendId: string): AgentPlugin {
    const plugin = this.plugins.get(backendId); if (!plugin) throw new AgentError('runtime_unavailable'); return plugin;
  }
  list(): AgentDescriptor[] { return [...this.plugins.values()].map(plugin => structuredClone(plugin.descriptor)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  async create(backendId: string, dependencies: AgentAdapterDependencies): Promise<AgentAdapter> {
    const plugin = this.get(backendId);
    if (!isPlainRecord(dependencies as unknown) || !exactKeys(dependencies as unknown as Record<string, unknown>, ['runId', 'attemptId', 'selection', 'platform', 'signal']) || !publicText(dependencies.runId, 200) || !publicText(dependencies.attemptId, 200) || !isPlainRecord(dependencies.selection as unknown) || dependencies.selection.backendId !== backendId || (dependencies.signal !== undefined && !(dependencies.signal instanceof AbortSignal))) throw new AgentError('protocol_error');
    const frozen = dependencies.selection;
    if ('legacy' in frozen) throw new AgentError('invalid_configuration');
    this.validateFrozen(frozen, dependencies.platform);
    dependencies.signal?.throwIfAborted();
    let adapter: AgentAdapter;
    try { adapter = await plugin.createAdapter(Object.freeze({ ...dependencies, selection: deepFreeze(structuredClone(frozen)) })); } catch (error) { throw agentError(error, 'runtime_unavailable'); }
    if (!adapter || ['start', 'cancel', 'respond', 'reconcile', 'releaseRun', 'disposeUnstarted', 'disposeDrained'].some(method => typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function')) {
      // An invalid unstarted factory product may still own a transport.
      try { await adapter?.disposeUnstarted?.(); } catch { /* original contract failure wins */ }
      throw new AgentError('protocol_error');
    }
    if (dependencies.signal?.aborted) { await adapter.disposeUnstarted(); dependencies.signal.throwIfAborted(); }
    return adapter;
  }
  evaluate(backendId: string, requirements: AgentTaskRequirements): AgentAvailability {
    return evaluateAgentTask(this.get(backendId), requirements);
  }
  /** Public compatibility check for accepted work: never reads current settings. */
  validateFrozen(frozen: FrozenAgentSelection, platform: AgentPlatform = process.platform as AgentPlatform): void {
    const plugin = this.get(frozen.backendId);
    if (!isPlainRecord(frozen as unknown) || !exactKeys(frozen as unknown as Record<string, unknown>, ['backendId', 'apiVersion', 'schemaVersion', 'implementationVersion', 'runtimeVersion', 'configRevision', 'options', 'model', 'settingsGeneration', 'permissions']) || frozen.apiVersion !== plugin.descriptor.apiVersion || frozen.schemaVersion !== plugin.descriptor.configuration.version || typeof frozen.implementationVersion !== 'string' || !validSemver(frozen.implementationVersion) || !Number.isSafeInteger(frozen.configRevision) || frozen.configRevision < 0 || !(frozen.runtimeVersion === null || typeof frozen.runtimeVersion === 'string' && /^[0-9A-Za-z.+_-]{1,128}$/.test(frozen.runtimeVersion))) throw new AgentError('protocol_error');
    validateSelectionGeneration(frozen);
    if (frozen.settingsGeneration) {
      if (!plugin.projectPermissions) throw new AgentError('capability_unsupported');
      let native: Record<string, import('@openworkgraph/protocol').AgentOptionValue>;
      try { native = plugin.projectPermissions(frozen.permissions!.project, {}); } catch (error) { throw agentError(error, 'capability_unsupported'); }
      if (!isPlainRecord(native) || Object.entries(native).some(([key, value]) => frozen.options[key] !== value)) throw new AgentError('invalid_configuration');
    }
    const options = normalizeConfiguration(plugin.descriptor.configuration, frozen.options, frozen.schemaVersion, platform);
    // Historical options may not be silently supplemented with new defaults.
    if (Object.keys(options).length !== Object.keys(frozen.options).length || Object.entries(options).some(([key, value]) => frozen.options[key] !== value)) throw new AgentError('invalid_configuration');
    if (!isPlainRecord(frozen.model as unknown) || !exactKeys(frozen.model as unknown as Record<string, unknown>, ['model', 'reasoningEffort']) || !publicText(frozen.model.model, 256) || frozen.model.model !== frozen.model.model.trim() || !(frozen.model.reasoningEffort === null || publicText(frozen.model.reasoningEffort, 64)) || (!plugin.descriptor.models.effort && frozen.model.reasoningEffort !== null)) throw new AgentError('model_unavailable');
  }
  assertFrozen(frozen: FrozenAgentSelection, requirements: AgentTaskRequirements): void {
    this.validateFrozen(frozen, requirements.platform);
    const availability = this.evaluate(frozen.backendId, { ...requirements, options: frozen.options });
    if (availability.status !== 'available') throw new AgentError(availability.reason ?? 'runtime_unavailable');
  }
}
