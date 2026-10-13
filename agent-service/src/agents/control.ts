import type { AgentSelection, Json, SubmitRun, Run, ModelSelection } from '@openworkgraph/protocol';
import type { WorkflowRuntime } from '../runtime.js';
import type { AgentSettingsPatch } from './settings.js';
import { nativeSkillCatalog } from './skills.js';
import { ServiceError } from '../errors.js';
import { isPlainRecord, exactKeys, normalizeConfiguration, publicText } from './configuration.js';
import { AgentError } from './errors.js';
import { validAgentId } from './registry.js';

function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && exactKeys(value, keys) && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => field.enumerable);
}
function model(value: unknown): value is ModelSelection {
  return record(value, ['model', 'reasoningEffort']) && publicText(value.model, 256) && value.model === value.model.trim()
    && (value.reasoningEffort === null || publicText(value.reasoningEffort, 64));
}
function options(value: unknown): boolean {
  return isPlainRecord(value) && Reflect.ownKeys(value).length <= 64 && record(value, Object.keys(value))
    && Object.entries(value).every(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)
      && (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && (item === '' || publicText(item))));
}
function selection(value: unknown): value is AgentSelection {
  return record(value, ['backendId', 'configRevision', 'schemaVersion', 'options', 'model']) && validAgentId(value.backendId)
    && revision(value.configRevision) && revision(value.schemaVersion) && value.schemaVersion > 0
    && (!Object.hasOwn(value, 'options') || options(value.options)) && (!Object.hasOwn(value, 'model') || model(value.model));
}
function identity(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 256; }
function invalidSubmit(): never { throw new ServiceError('INVALID_REQUEST', '执行器任务请求无效。'); }

/** Authentication and accepting transactions remain with the HTTP host. */
export class AgentControl {
  constructor(private readonly runtime: WorkflowRuntime) {}
  private services() {
    const { agentSettings, agentDiscovery } = this.runtime, registry = this.runtime.options.agentRegistry;
    if (!agentSettings || !agentDiscovery || !registry) throw new ServiceError('PLUGIN_UNAVAILABLE', '工作空间未配置执行器注册表。');
    return { settings: agentSettings, discovery: agentDiscovery, registry };
  }
  getSettings(backendId: string) {
    if (!validAgentId(backendId)) throw new AgentError('invalid_configuration');
    return this.services().settings.get(backendId);
  }
  descriptors() { return this.services().registry.list(); }
  private query(backendId: string) {
    const settings = this.getSettings(backendId);
    return { options: settings.options, schemaVersion: settings.schemaVersion };
  }
  listModels(backendId: string, signal?: AbortSignal) {
    return this.services().discovery.listModels(backendId, { ...this.query(backendId), ...(signal ? { signal } : {}) });
  }
  diagnose(backendId: string, signal?: AbortSignal) {
    return this.services().discovery.diagnose(backendId, { ...this.query(backendId), ...(signal ? { signal } : {}) });
  }
  async listNativeSkills(backendId: string, signal?: AbortSignal, projectPath?: string) {
    const settings = this.getSettings(backendId);
    const request = { ...(signal ? { signal } : {}), ...(projectPath ? { projectPath } : {}) };
    const result = await nativeSkillCatalog(this.services().registry.get(backendId), settings, request);
    // An opaque public identity must not contain a legacy absolute-path ID.
    if (result.skills.some(skill => /(?:^|:)(?:\/|[A-Za-z]:[\\/]|~\/|\\\\)/.test(skill.skillId))) throw new AgentError('protocol_error');
    return result;
  }
  getDefault() {
    const value = this.services().settings.getDefault();
    if (!validAgentId(value.backendId)) throw new ServiceError('MAINTENANCE', '默认执行器设置损坏。');
    return value;
  }
  setDefault(backendId: string, expectedRevision: number) {
    if (!validAgentId(backendId) || !revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER) throw new AgentError('invalid_configuration');
    return this.services().settings.setDefault(backendId, expectedRevision);
  }
  async prepareSettings(backendId: string, patch: AgentSettingsPatch, expectedRevision: number, signal?: AbortSignal) {
    if (!validAgentId(backendId) || !revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER
      || !record(patch, ['enabled', 'schemaVersion', 'options', 'model'])
      || Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean'
      || Object.hasOwn(patch, 'schemaVersion') && (!revision(patch.schemaVersion) || patch.schemaVersion === 0)
      || Object.hasOwn(patch, 'options') && !options(patch.options)
      || Object.hasOwn(patch, 'model') && patch.model !== null && !model(patch.model)) throw new AgentError('invalid_configuration');
    const request = structuredClone(patch) as AgentSettingsPatch;
    const { settings, discovery, registry } = this.services();
    const current = settings.get(backendId);
    if (current.revision !== expectedRevision) throw new ServiceError('REVISION_CONFLICT', '执行器设置已变化，请刷新后重试。');
    const schemaVersion = request.schemaVersion ?? current.schemaVersion;
    const normalized = normalizeConfiguration(registry.get(backendId).descriptor.configuration, request.options ?? current.options, schemaVersion);
    // Retaining a model (including a pure enabled toggle) requires no directory
    // or runtime diagnosis. Explicit non-null selections still obey model policy.
    if (!Object.hasOwn(request, 'model') || request.model === null) return () => settings.set(backendId, request, expectedRevision);
    if (this.runtime.db.isTransaction) throw new ServiceError('CONFLICT', '设置目录预检必须先于宿主事务。');
    const models = await discovery.listModels(backendId, { options: normalized, schemaVersion, ...(signal ? { signal } : {}) });
    return () => settings.set(backendId, request, expectedRevision, models);
  }
  /** Trusted in-process compatibility entry; HTTP uses prepareSettings + withSession. */
  async setSettings(backendId: string, patch: AgentSettingsPatch, expectedRevision: number) {
    return (await this.prepareSettings(backendId, patch, expectedRevision))();
  }
  selection(backendId = this.getDefault().backendId): AgentSelection {
    const settings = this.getSettings(backendId);
    return { backendId, configRevision: settings.revision, schemaVersion: settings.schemaVersion };
  }
  validateSubmission(body: unknown, principal: string): SubmitRun {
    if (!identity(principal) || !record(body, ['serviceId', 'projectId', 'graphId', 'nodeId', 'kind', 'idempotencyKey', 'expectedExecutionRevision', 'agent', 'preserveHistoricalOutputs'])
      || ['serviceId', 'projectId', 'graphId', 'nodeId', 'idempotencyKey'].some(key => !identity(body[key]))
      || typeof body.kind !== 'string' || !['execution', 'text_generation', 'visualize_generation'].includes(body.kind)
      || !revision(body.expectedExecutionRevision) || !selection(body.agent)
      || Object.hasOwn(body, 'preserveHistoricalOutputs') && (typeof body.preserveHistoricalOutputs !== 'boolean' || body.kind !== 'execution')) invalidSubmit();
    return structuredClone(body) as unknown as SubmitRun;
  }
  async prepareSubmit(body: unknown, principal: string): Promise<() => Run> {
    const request = this.validateSubmission(body, principal);
    // Exact replay happens before catalog/settings preflight, including when disabled.
    const prior = this.runtime.runs.repo.replay(principal + ':run.submit', request.idempotencyKey, request as unknown as Json);
    if (prior) return () => {
      // The host may invalidate a graph between preparation and its transaction.
      const replay = this.runtime.runs.repo.replay(principal + ':run.submit', request.idempotencyKey, request as unknown as Json);
      if (!replay) throw new ServiceError('CONFLICT', '提交回放状态已变化。');
      return structuredClone(replay) as unknown as Run;
    };
    if (this.runtime.db.isTransaction) throw new ServiceError('CONFLICT', '任务预检必须先于宿主事务。');
    const { settings, registry } = this.services(), agent = request.agent!;
    const current = settings.get(agent.backendId);
    if (!current.enabled) throw new AgentError('runtime_unavailable');
    if (agent.configRevision !== current.revision) throw new ServiceError('REVISION_CONFLICT', '执行器设置已变化，请刷新后重试。');
    normalizeConfiguration(registry.get(agent.backendId).descriptor.configuration, { ...current.options, ...agent.options }, agent.schemaVersion);
    const commit = await this.runtime.prepareSubmission(request, [], principal);
    return () => commit(principal);
  }
}
