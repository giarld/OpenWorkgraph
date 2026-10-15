import { translate } from '../i18n/translate';
import '../i18n/catalogs/agent-configuration';
import { useEffect, useSyncExternalStore } from 'react';
import type { AgentDefault, AgentDescriptor, AgentModelOption, AgentSelection, AgentSettings, AgentRunKind, AgentWorkspaceConfiguration, AgentBackendConfiguration, AgentConfigurationUpdate, AgentConfiguredModel } from '../../../packages/protocol/src/agents';
import type { ModelSelection, SandboxMode } from '../../../packages/protocol/src/index';
import type { SkillReference } from '../../../packages/protocol/src/skills';
import type { AgentInstallationStatus } from '../../../packages/protocol/src/agents';
import { ConnectionRegistry, LifecycleCancelledError, TransportError } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import type { Request } from './contracts';

export const AGENT_CONFIGURATION_PATH = '/v1/agents/configuration';
export type WorkspaceAgentConfiguration = AgentWorkspaceConfiguration;
export interface AgentResource { settings?: AgentBackendConfiguration; models?: AgentModelOption[]; configuredModels?: AgentConfiguredModel[]; configRevision?: number; knownModelIds?: string[]; settingsError?: string; modelsError?: string; modelsUnsupported?: boolean; installation?: AgentInstallationStatus }
export interface AgentState {
  mode: 'loading' | 'legacy' | 'agents' | 'error';
  descriptors: AgentDescriptor[]; default?: AgentDefault; resources: Record<string, AgentResource>;
  configuration?: WorkspaceAgentConfiguration; configurationError?: string; error?: string;
}
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function explicitAgentApi404(error: unknown): boolean { return error instanceof TransportError && error.status === 404; }
export function parseAgentList(value: unknown): { items: AgentDescriptor[]; default: AgentDefault } {
  if (!record(value) || !Array.isArray(value.items) || !record(value.default) || !revision(value.default.revision) || typeof value.default.backendId !== 'string') throw Error('Invalid Agent catalog response');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !record(item.configuration) || !revision(item.configuration.version) || !Array.isArray(item.configuration.fields) || !record(item.capabilities) || !Array.isArray(item.capabilities.kinds) || !Array.isArray(item.capabilities.inputKinds) || !record(item.models)) throw Error('Invalid Agent descriptor');
    ids.add(item.id);
  }
  return value as unknown as { items: AgentDescriptor[]; default: AgentDefault };
}
export function parseAgentSettings(value: unknown, backendId: string): AgentSettings {
  if (!record(value) || value.backendId !== backendId || !revision(value.revision) || !revision(value.schemaVersion) || typeof value.enabled !== 'boolean' || !record(value.options) || !Object.values(value.options).every(option => typeof option === 'string' || typeof option === 'boolean' || typeof option === 'number' && Number.isFinite(option)) || value.model !== null && (!record(value.model) || typeof value.model.model !== 'string' || value.model.reasoningEffort !== null && typeof value.model.reasoningEffort !== 'string')) throw Error('Invalid Agent settings response');
  return value as unknown as AgentSettings;
}
export function parseAgentModels(value: unknown): AgentModelOption[] {
  if (!Array.isArray(value) || value.some(item => !record(item) || typeof item.id !== 'string' || !item.id || !Array.isArray(item.reasoningEfforts) || !item.reasoningEfforts.every(effort => typeof effort === 'string') || item.defaultReasoningEffort != null && !item.reasoningEfforts.includes(item.defaultReasoningEffort as string)) || new Set(value.map(item => item.id)).size !== value.length) throw Error('Invalid Agent models response');
  return value as AgentModelOption[];
}
export function initialEffort(model: AgentModelOption): string | null {
  // Directory order is the plugin's declared order, never alphabetical order.
  return model.reasoningEfforts.includes('medium') ? 'medium' : model.reasoningEfforts[0] ?? null;
}
export const agentModelKey = (backendId: string, modelId: string) => JSON.stringify([backendId, modelId]);
/** A saved null explicitly inherits defaults, even when this node has history. */
export function nodeAgentModelPreference(value: unknown, snapshot?: import('../../../packages/protocol/src/index').InputSnapshot): { backendId: string; model: ModelSelection } | undefined {
  if (value === null) return undefined;
  if (record(value) && typeof value.backendId === 'string' && record(value.model) && typeof value.model.model === 'string' && (value.model.reasoningEffort === null || typeof value.model.reasoningEffort === 'string')) {
    return { backendId: value.backendId, model: { model: value.model.model, reasoningEffort: value.model.reasoningEffort } };
  }
  if (snapshot?.agent) return { backendId: snapshot.agent.backendId, model: { ...snapshot.agent.model } };
  if (snapshot?.model && !snapshot.imageRoute) return { backendId: 'codex', model: { ...snapshot.model } };
  return undefined;
}
export function agentModelChoices(state: AgentState, backendId: string, selectedId?: string) {
  const resource = state.resources[backendId], descriptor = state.descriptors.find(item => item.id === backendId);
  const configured = state.configuration?.backends.find(item => item.backendId === backendId)?.models ?? [];
  const models = [...(resource?.models ?? [])];
  for (const item of configured) if (!models.some(model => model.id === item.id)) models.push({ id: item.id, reasoningEfforts: [] });
  return models.filter(model => configured.some(item => item.id === model.id && item.visible) || selectedId === model.id).map(model => {
    const absent = !!resource?.models && !resource.modelsError && !resource.models.some(item => item.id === model.id);
    const manual = absent && !!descriptor?.models.allowCustom && !resource?.knownModelIds?.includes(model.id);
    return { ...model, manual, unavailable: absent && !manual, hidden: configured.find(item => item.id === model.id)?.visible === false };
  });
}

export function orderedAgents(state: AgentState): AgentDescriptor[] {
  const order = state.configuration?.order.backendIds ?? [];
  const rank = (id: string) => order.includes(id) ? order.indexOf(id) : order.length + state.descriptors.findIndex(item => item.id === id);
  return [...state.descriptors].sort((a, b) => rank(a.id) - rank(b.id));
}
export function workspaceAgentDefault(state: AgentState): { backendId: string; model: ModelSelection } | undefined {
  if (state.configuration) {
    const saved = state.configuration.default.selection;
    if (saved) return { backendId: saved.backendId, model: { model: saved.model, reasoningEffort: saved.reasoningEffort } };
    const backend = orderedAgents(state)[0], model = backend && state.resources[backend.id]?.models?.[0];
    return backend && model ? { backendId: backend.id, model: { model: model.id, reasoningEffort: initialEffort(model) } } : undefined;
  }
  return undefined;
}

export function nativeSkillConflict(ref: SkillReference, backendId: string, nativeSkills = true): string | undefined {
  const owner = ref.source === 'codex' ? 'codex' : ref.source === 'agent' ? ref.backendId : undefined;
  if (owner && owner !== backendId) return translate('Skill {name} belongs to {owner}; this run uses {backend}. Switch back, reselect or remove the reference.', { name: ref.name, owner, backend: backendId });
  if (owner && !nativeSkills) return translate('This Agent does not support native skill {name}.', { name: ref.name });
}
export function captureAgentSelection(state: AgentState, draft: { backendId: string; model: ModelSelection } | undefined, kind: AgentRunKind, legacyOverride?: ModelSelection): AgentSelection {
  if (state.mode !== 'agents') throw Error(state.error ?? translate('Agent configuration has not loaded yet.'));
  const chosen = draft ?? workspaceAgentDefault(state);
  if (!chosen) { const first = orderedAgents(state)[0]; throw Error(first && state.resources[first.id]?.modelsError || translate('The Workspace default model is unavailable. Choose a model explicitly.')); }
  if (legacyOverride && chosen.backendId !== 'codex') throw Error(translate('This node retains a legacy Codex model override. Explicitly clear it before running this Agent, or switch back to Codex.'));
  const descriptor = state.descriptors.find(item => item.id === chosen.backendId), resource = state.resources[chosen.backendId];
  if (!state.configuration || !descriptor || !resource?.settings || resource.settingsError || resource.modelsError || resource.configRevision !== resource.settings.revision) throw Error(resource?.settingsError ?? resource?.modelsError ?? translate('The selected Agent configuration or model catalog is unavailable.'));
  if (!resource.settings.enabled) throw Error(translate('The selected Agent is disabled. Choose another Agent explicitly.'));
  if (descriptor.projectPermissionModes && !descriptor.projectPermissionModes.includes(state.configuration.permissions.project)) throw Error(translate('The selected Agent does not support this project permission mode.'));
  if (state.configuration.platform && descriptor.capabilities.platforms && !descriptor.capabilities.platforms.includes(state.configuration.platform)) throw Error(translate('This Agent is not available on this platform.'));
  if (resource.settings.schemaVersion !== descriptor.configuration.version) throw Error(translate('The Agent configuration version changed. Refresh and run again.'));
  if (!descriptor.capabilities.kinds.includes(kind) || kind === 'visualize_generation' && !descriptor.capabilities.visualize) throw Error(translate('The selected Agent does not support this task kind.'));
  const selectedModel = !draft && chosen.backendId === 'codex' && legacyOverride ? legacyOverride : chosen.model;
  const model = resource.models?.find(item => item.id === selectedModel.model);
  if ((!model && !descriptor.models.allowCustom) || (selectedModel.reasoningEffort && !model?.reasoningEfforts.includes(selectedModel.reasoningEffort))) throw Error(translate('The selected model or reasoning effort is unavailable. Select it again.'));
  return structuredClone({ settingsGeneration: 'agent-configuration-v1' as const, permissions: state.configuration.permissions, backendId: chosen.backendId, configRevision: resource.settings.revision, schemaVersion: resource.settings.schemaVersion, options: resource.settings.options, model: selectedModel });
}

export function publicAgentDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return { ...descriptor, configuration: { ...descriptor.configuration, fields: descriptor.configuration.fields.filter(field => !/(permission|sandbox)/i.test(field.name)) } };
}
export function parseWorkspaceConfiguration(value: unknown): AgentWorkspaceConfiguration {
  if (record(value) && value.platform !== undefined && !['darwin', 'linux', 'win32'].includes(String(value.platform))) throw Error('Invalid Workspace platform');
  if (!record(value) || value.formatVersion !== 1 || value.settingsGeneration !== 'agent-configuration-v1' || typeof value.workspaceId !== 'string' ||
    !record(value.permissions) || !revision(value.permissions.revision) || !['read-only', 'workspace-write', 'danger-full-access'].includes(String(value.permissions.project)) || value.permissions.runs !== 'read-write' ||
    !record(value.order) || !revision(value.order.revision) || !Array.isArray(value.order.backendIds) || !value.order.backendIds.every(id => typeof id === 'string') || new Set(value.order.backendIds).size !== value.order.backendIds.length ||
    !record(value.default) || !revision(value.default.revision) || value.default.selection !== null && (!record(value.default.selection) || typeof value.default.selection.backendId !== 'string' || typeof value.default.selection.model !== 'string' || value.default.selection.reasoningEffort !== null && typeof value.default.selection.reasoningEffort !== 'string') ||
    !Array.isArray(value.backends)) throw Error('Invalid workspace Agent configuration');
  const seen = new Set<string>();
  for (const backend of value.backends) {
    if (!record(backend) || typeof backend.backendId !== 'string' || seen.has(backend.backendId) || !revision(backend.revision) || !revision(backend.schemaVersion) || typeof backend.enabled !== 'boolean' || !record(backend.options) ||
      Object.entries(backend.options).some(([key, option]) => /(permission|sandbox)/i.test(key) || !(typeof option === 'string' || typeof option === 'boolean' || typeof option === 'number' && Number.isFinite(option))) || !Array.isArray(backend.models) || backend.models.some(model => !record(model) || typeof model.id !== 'string' || typeof model.visible !== 'boolean') || new Set(backend.models.map(model => model.id)).size !== backend.models.length) throw Error('Invalid Agent backend configuration');
    seen.add(backend.backendId);
  }
  return value as unknown as AgentWorkspaceConfiguration;
}
/** Shared query owner, isolated by authenticated lease and request generation. */
export class WorkspaceAgentStore {
  private state: AgentState = { mode: 'loading', descriptors: [], resources: {} };
  private listeners = new Set<() => void>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  private loaded = false;
  private knownModels = new Map<string, Set<string>>();
  constructor(readonly request: Request, private assertCurrent: () => void = () => {}) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AgentState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private query(key: string, work: (generation: number) => Promise<void>): Promise<void> {
    const previous = this.pending.get(key); if (previous) return previous;
    const job = work(this.generation).finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
    this.pending.set(key, job); return job;
  }
  private current(generation: number): boolean { try { this.assertCurrent(); return generation === this.generation; } catch { return false; } }
  load = (): Promise<void> => {
    if (this.loaded) return Promise.resolve();
    return this.query('catalog', async generation => {
      try {
        // Only an explicit 404 enables legacy mode. Auth/network/5xx never do.
        const results = await Promise.allSettled([this.request('/v1/agents'), this.request(AGENT_CONFIGURATION_PATH)]);
        if (!this.current(generation)) return;
        for (const result of results) if (result.status === 'rejected' && !explicitAgentApi404(result.reason)) throw result.reason;
        if (results.some(result => result.status === 'rejected')) { this.loaded = true; this.update({ mode: 'legacy', configuration: undefined, resources: {}, error: undefined }); return; }
        const list = parseAgentList((results[0] as PromiseFulfilledResult<unknown>).value);
        const configuration = parseWorkspaceConfiguration((results[1] as PromiseFulfilledResult<unknown>).value);
        const resources = Object.fromEntries(configuration.backends.map(settings => [settings.backendId, { settings, knownModelIds: [...(this.knownModels.get(settings.backendId) ?? [])] }]));
        this.update({ mode: 'agents', descriptors: list.items.map(publicAgentDescriptor), configuration, resources, error: undefined });
        await Promise.all(list.items.map(item => this.loadBackend(item.id)));
        if (this.current(generation)) this.loaded = true;
      } catch (error) {
        if (!(error instanceof LifecycleCancelledError) && this.current(generation)) this.update({ mode: 'error', error: failure(error) });
      }
    });
  };
  loadBackend = (backendId: string): Promise<void> => this.query(backendId, async generation => {
    try {
      const response: unknown = await this.request(AGENT_CONFIGURATION_PATH + '/' + encodeURIComponent(backendId) + '/models');
      if (!this.current(generation)) return;
      if (!record(response) || response.backendId !== backendId || !revision(response.configRevision) || !Array.isArray(response.configuredModels) || response.configuredModels.some(model => !record(model) || typeof model.id !== 'string' || typeof model.visible !== 'boolean')) throw Error('Invalid Agent model catalog response');
      const models = parseAgentModels(response.models);
      const known = this.knownModels.get(backendId) ?? new Set<string>();
      for (const model of models) known.add(model.id);
      this.knownModels.set(backendId, known);
      if (this.state.resources[backendId]?.settings?.revision !== response.configRevision) throw Error(translate('Agent settings changed. Refresh the catalog and run again.'));
      this.update({ resources: { ...this.state.resources, [backendId]: { ...this.state.resources[backendId], models, knownModelIds: [...known], configuredModels: response.configuredModels as AgentConfiguredModel[], configRevision: response.configRevision, modelsError: undefined, modelsUnsupported: false } } });
    } catch (error) {
      const details = error instanceof TransportError && record(error.details) ? error.details.details : undefined;
      if (this.current(generation)) this.update({ resources: { ...this.state.resources, [backendId]: { ...this.state.resources[backendId], modelsError: failure(error), modelsUnsupported: record(details) && details.reason === 'capability_unsupported' } } });
    }
  });
  checkInstallation = (backendId: string): Promise<void> => this.query('installation:' + backendId, async generation => {
    let installation: AgentInstallationStatus = 'unknown';
    try {
      const response: unknown = await this.request(AGENT_CONFIGURATION_PATH + '/' + encodeURIComponent(backendId) + '/diagnose', {});
      if (record(response) && typeof response.installation === 'string' && ['installed', 'missing', 'unknown'].includes(response.installation)) installation = response.installation as AgentInstallationStatus;
    } catch { /* Network/auth/version failures do not prove the CLI is missing. */ }
    if (this.current(generation)) this.update({ resources: { ...this.state.resources, [backendId]: { ...this.state.resources[backendId], installation } } });
  });
  async saveConfiguration(update: AgentConfigurationUpdate) {
    this.assertCurrent();
    const configuration = parseWorkspaceConfiguration(await this.request(AGENT_CONFIGURATION_PATH, update));
    this.assertCurrent();
    this.update({ configuration }); this.invalidate(); await this.load();
    return configuration;
  }
  invalidate = () => { this.generation++; this.pending.clear(); this.loaded = false; };
  refresh = () => { this.invalidate(); return this.load(); };
}
const stores = new WeakMap<ConnectionRegistry, Map<string, WorkspaceAgentStore>>();
export function workspaceAgentStore(registry: ConnectionRegistry, serviceId: string): WorkspaceAgentStore {
  const lease = registry.lease(serviceId), key = JSON.stringify([serviceId, lease.sessionId, lease.generation]);
  let scoped = stores.get(registry); if (!scoped) { scoped = new Map(); stores.set(registry, scoped); }
  let store = scoped.get(key);
  if (!store) {
    const transport = new Transport(registry, serviceId);
    store = new WorkspaceAgentStore(transport.request.bind(transport), () => registry.assertCurrent(lease));
    for (const oldKey of scoped.keys()) if (JSON.parse(oldKey)[0] === serviceId) scoped.delete(oldKey);
    scoped.set(key, store);
  }
  return store;
}
const idle: AgentState = { mode: 'legacy', descriptors: [], resources: {} };
const idleSnapshot = () => idle, noSubscribe = () => () => {};
export function useWorkspaceAgents(store?: WorkspaceAgentStore, enabled = true): AgentState {
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? idleSnapshot);
  useEffect(() => {
    if (!store || !enabled) return;
    void store.load();
    const refresh = () => { void store.refresh(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [store, enabled]);
  return state;
}
