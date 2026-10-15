import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentWorkspaceConfiguration, AgentBackendConfiguration, AgentConfigurationUpdate, AgentSelection, FrozenAgentSelection, AgentModelOption, AgentPlatform, ModelSelection, AgentWorkspaceDefault } from '@openworkgraph/protocol';
import { ServiceError } from '../errors.js';
import { AgentError } from './errors.js';
import { AgentRegistry } from './registry.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText } from './configuration.js';
import { validateAgentModels } from './discovery.js';
import { SETTINGS_GENERATION, configurationRevision, validateProjectPermissions, sameProjectPermissions, validateSelectionGeneration, workspaceConfigurationSchema, isPermissionOption, validateConfigurationUpdate } from './workspace-configuration-validation.js';

export interface WorkspaceFreezeContext {
  availableModels: readonly AgentModelOption[]; platform?: AgentPlatform; runtimeVersion?: string | null;
  projectPath?: string; runsPath?: string;
}
function conflict(): never { throw new ServiceError('REVISION_CONFLICT', '工作空间 Agent 配置已变化，请刷新后重试。'); }
function invalid(): never { throw new AgentError('invalid_configuration'); }
function modelShape(value: unknown): value is ModelSelection {
  return isPlainRecord(value) && exactKeys(value, ['model', 'reasoningEffort']) && publicText(value.model, 256) && value.model === value.model.trim() && (value.reasoningEffort === null || publicText(value.reasoningEffort, 64));
}
function defaultShape(value: unknown): value is AgentWorkspaceDefault['selection'] {
  if (value === null) return true;
  if (!isPlainRecord(value) || !exactKeys(value, ['backendId', 'model', 'reasoningEffort']) || (typeof value.backendId !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value.backendId) || value.backendId.length > 128)) return false;
  return modelShape({ model: value.model, reasoningEffort: value.reasoningEffort });
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
/** Separate file, no legacy database/settings input. SQLite serializes writers across
 * processes. withCurrent holds this lock through the synchronous host acceptance. */
export class AgentWorkspaceConfigurationStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  constructor(directory: string, readonly workspaceId: string, private readonly registry: AgentRegistry) {
    if (!publicText(workspaceId, 200)) invalid();
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'agent-configuration.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS configuration(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  }
  close(): void { this.db.close(); }
  private initial(): AgentWorkspaceConfiguration {
    return { formatVersion: 1, settingsGeneration: SETTINGS_GENERATION, workspaceId: this.workspaceId,
      permissions: { revision: 0, project: 'workspace-write', runs: 'read-write' }, backends: [],
      default: { revision: 0, selection: null }, order: { revision: 0, backendIds: [] } };
  }
  private read(): AgentWorkspaceConfiguration {
    const row = this.db.prepare('SELECT value FROM configuration WHERE id=1').get();
    if (!row) return this.initial();
    try {
      const value = JSON.parse(String(row.value));
      if (!isPlainRecord(value) || !exactKeys(value, ['formatVersion', 'settingsGeneration', 'workspaceId', 'permissions', 'backends', 'default', 'order']) || value.formatVersion !== 1 || value.settingsGeneration !== SETTINGS_GENERATION || value.workspaceId !== this.workspaceId || !Array.isArray(value.backends) || value.backends.length > 1024) invalid();
      validateProjectPermissions(value.permissions);
      if (!isPlainRecord(value.default) || !exactKeys(value.default, ['revision', 'selection']) || !configurationRevision(value.default.revision) || !defaultShape(value.default.selection)) invalid();
      if (!isPlainRecord(value.order) || !exactKeys(value.order, ['revision', 'backendIds']) || !configurationRevision(value.order.revision) || !this.ids(value.order.backendIds)) invalid();
      const ids = new Set<string>();
      for (const backend of value.backends) {
        if (!isPlainRecord(backend) || !exactKeys(backend, ['backendId', 'revision', 'enabled', 'schemaVersion', 'options', 'models']) || !this.ids([backend.backendId]) || ids.has(String(backend.backendId)) || !configurationRevision(backend.revision) || backend.revision === 0 || typeof backend.enabled !== 'boolean' || !Number.isSafeInteger(backend.schemaVersion) || Number(backend.schemaVersion) < 1 || !this.publicOptions(backend.options) || !this.models(backend.models)) invalid();
        ids.add(String(backend.backendId));
      }
      return value as unknown as AgentWorkspaceConfiguration;
    } catch { throw new ServiceError('MAINTENANCE', '新版 Agent 配置损坏或不属于此工作空间。'); }
  }
  private publicOptions(value: unknown): boolean {
    return isPlainRecord(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) => !isPermissionOption(key) && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && (item === '' || publicText(item))));
  }
  private ids(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 1024 && value.every(id => typeof id === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id) && id.length <= 128) && new Set(value).size === value.length;
  }
  private models(value: unknown): boolean {
    return Array.isArray(value) && value.length <= 4096 && value.every(m => isPlainRecord(m) && exactKeys(m, ['id', 'visible']) && publicText(m.id, 256) && m.id === m.id.trim() && typeof m.visible === 'boolean') && new Set(value.map(m => m.id)).size === value.length;
  }
  private emptyBackend(backendId: string, platform: AgentPlatform): AgentBackendConfiguration {
    const schema = workspaceConfigurationSchema(this.registry.get(backendId).descriptor.configuration);
    return { backendId, revision: 0, enabled: true, schemaVersion: schema.version, models: [], options: normalizeConfiguration({ ...schema, fields: schema.fields.map(f => ({ ...f, required: false })) }, {}, schema.version, platform) };
  }
  get(platform: AgentPlatform = process.platform as AgentPlatform): AgentWorkspaceConfiguration {
    const value = this.read();
    value.platform = platform;
    for (const descriptor of this.registry.list()) if (!value.backends.some(b => b.backendId === descriptor.id)) value.backends.push(this.emptyBackend(descriptor.id, platform));
    const registered = this.registry.list().map(d => d.id);
    value.order.backendIds = [...value.order.backendIds, ...registered.filter(id => !value.order.backendIds.includes(id))];
    return value;
  }
  getBackend(backendId: string, platform: AgentPlatform = process.platform as AgentPlatform): AgentBackendConfiguration {
    this.registry.get(backendId);
    return this.get(platform).backends.find(b => b.backendId === backendId)!;
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private selectedModel(backendId: string, value: ModelSelection, catalog: readonly AgentModelOption[], inferEffort = false): ModelSelection {
    if (!modelShape(value)) throw new AgentError('model_unavailable');
    const policy = this.registry.get(backendId).descriptor.models;
    const known = validateAgentModels(catalog, policy.effort).find(m => m.id === value.model);
    if (!known && !policy.allowCustom || !policy.effort && value.reasoningEffort !== null || value.reasoningEffort !== null && (!known || !known.reasoningEfforts.includes(value.reasoningEffort))) throw new AgentError('model_unavailable');
    // Plugin's effort list is its declared low-to-high order; never alphabetical.
    const effort = value.reasoningEffort ?? (inferEffort && policy.effort && known ? (known.reasoningEfforts.includes('medium') ? 'medium' : known.reasoningEfforts[0] ?? null) : null);
    return { model: value.model, reasoningEffort: effort };
  }
  set(update: AgentConfigurationUpdate, catalog: readonly AgentModelOption[] = [], platform: AgentPlatform = process.platform as AgentPlatform, expectedCatalogRevision?: number, expectedPermissionsRevision?: number): AgentWorkspaceConfiguration {
    validateConfigurationUpdate(update);
    return this.atomic(() => {
      const value = this.read(); const revision = update.expectedRevision + 1;
      if (expectedPermissionsRevision !== undefined && value.permissions.revision !== expectedPermissionsRevision) conflict();
      const catalogBackend = update.section === 'backend' ? update.backendId : update.section === 'default' ? update.selection?.backendId : undefined;
      if (expectedCatalogRevision !== undefined && catalogBackend && (value.backends.find(b => b.backendId === catalogBackend)?.revision ?? 0) !== expectedCatalogRevision) conflict();
      switch (update.section) {
        case 'permissions':
          if (!exactKeys(update, ['section', 'expectedRevision', 'project'])) invalid();
          if (value.permissions.revision !== update.expectedRevision) conflict();
          validateProjectPermissions({ revision, project: update.project, runs: 'read-write' });
          value.permissions = { revision, project: update.project, runs: 'read-write' }; break;
        case 'backend': {
          if (!exactKeys(update, ['section', 'expectedRevision', 'backendId', 'enabled', 'schemaVersion', 'options', 'models']) || typeof update.enabled !== 'boolean' || !this.models(update.models)) invalid();
          const old = value.backends.find(b => b.backendId === update.backendId) ?? this.emptyBackend(update.backendId, platform);
          if (old.revision !== update.expectedRevision) conflict();
          const descriptor = this.registry.get(update.backendId).descriptor;
          const options = normalizeConfiguration(workspaceConfigurationSchema(descriptor.configuration), update.options, update.schemaVersion, platform);
          const models = validateAgentModels(catalog, descriptor.models.effort);
          // Delisted saved identities remain editable/hidden; only newly added
          // unknown IDs are rejected. Visibility is never an execution whitelist.
          if (!descriptor.models.allowCustom && update.models.some(m => !models.some(known => known.id === m.id) && !old.models.some(saved => saved.id === m.id))) throw new AgentError('model_unavailable');
          const next = { backendId: update.backendId, revision, enabled: update.enabled, schemaVersion: update.schemaVersion, options, models: structuredClone(update.models) };
          value.backends = [...value.backends.filter(b => b.backendId !== update.backendId), next]; break;
        }
        case 'default': {
          if (!exactKeys(update, ['section', 'expectedRevision', 'selection']) || !defaultShape(update.selection)) invalid();
          if (value.default.revision !== update.expectedRevision) conflict();
          let selection = update.selection;
          if (selection) {
            const backend = value.backends.find(b => b.backendId === selection!.backendId) ?? this.emptyBackend(selection.backendId, platform);
            if (!backend.enabled) throw new AgentError('runtime_unavailable');
            selection = { backendId: selection.backendId, ...this.selectedModel(selection.backendId, { model: selection.model, reasoningEffort: selection.reasoningEffort }, catalog) };
          }
          value.default = { revision, selection }; break;
        }
        case 'order':
          if (!exactKeys(update, ['section', 'expectedRevision', 'backendIds']) || !this.ids(update.backendIds)) invalid();
          if (value.order.revision !== update.expectedRevision) conflict();
          for (const id of update.backendIds) this.registry.get(id);
          value.order = { revision, backendIds: [...update.backendIds] }; break;
        default: invalid();
      }
      this.db.prepare('INSERT INTO configuration(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
      return this.get(platform);
    });
  }
  /** Discovery is read-only metadata: native schema defaults are not execution authority. */
  query(backendId: string, overrides?: Record<string, import('@openworkgraph/protocol').AgentOptionValue>, platform: AgentPlatform = process.platform as AgentPlatform) {
    const value = this.get(platform); const backend = value.backends.find(b => b.backendId === backendId);
    if (!backend) throw new AgentError('runtime_unavailable');
    const plugin = this.registry.get(backendId); const schema = workspaceConfigurationSchema(plugin.descriptor.configuration);
    const options = normalizeConfiguration(schema, overrides ?? backend.options, backend.schemaVersion, platform);
    return { options: normalizeConfiguration(plugin.descriptor.configuration, options, backend.schemaVersion, platform), schemaVersion: backend.schemaVersion, configRevision: backend.revision, permissionsRevision: value.permissions.revision };
  }
  /** Refresh is a draft: new catalog entries start hidden; saved flags survive. */
  modelDraft(backendId: string, catalog: readonly AgentModelOption[]): AgentBackendConfiguration['models'] {
    const saved = this.getBackend(backendId).models;
    validateAgentModels(catalog, this.registry.get(backendId).descriptor.models.effort);
    return [...structuredClone(saved), ...catalog.filter(m => !saved.some(s => s.id === m.id)).map(m => ({ id: m.id, visible: false }))];
  }
  /** Select first backend even if unavailable; callers must not fall back. */
  defaultBackendId(): string {
    const value = this.get(); const id = value.default.selection?.backendId ?? value.order.backendIds[0];
    if (!id) throw new AgentError('model_unavailable'); return id;
  }
  freeze(selection: AgentSelection, context: WorkspaceFreezeContext): FrozenAgentSelection {
    if (!isPlainRecord(selection) || !exactKeys(selection, ['settingsGeneration', 'permissions', 'backendId', 'configRevision', 'schemaVersion', 'options', 'model']) || selection.settingsGeneration !== SETTINGS_GENERATION || !this.ids([selection.backendId]) || !configurationRevision(selection.configRevision) || !configurationRevision(selection.schemaVersion) || selection.schemaVersion === 0 || (Object.hasOwn(selection, 'options') && !isPlainRecord(selection.options)) || (Object.hasOwn(selection, 'model') && !modelShape(selection.model))) invalid();
    validateSelectionGeneration(selection);
    const platform = context.platform ?? process.platform as AgentPlatform;
    const current = this.getBackend(selection.backendId, platform); const value = this.get(platform);
    if (!current.enabled) throw new AgentError('runtime_unavailable');
    if (selection.configRevision !== current.revision || selection.permissions!.revision !== value.permissions.revision || selection.permissions!.project !== value.permissions.project) conflict();
    const plugin = this.registry.get(selection.backendId);
    const schema = workspaceConfigurationSchema(plugin.descriptor.configuration);
    const publicOptions = normalizeConfiguration(schema, { ...current.options, ...selection.options }, selection.schemaVersion, platform);
    if (!plugin.projectPermissions) throw new AgentError('capability_unsupported', '执行器尚未声明公共项目权限映射。');
    const native = plugin.projectPermissions(value.permissions.project, { ...(context.projectPath ? { projectPath: context.projectPath } : {}), ...(context.runsPath ? { runsPath: context.runsPath } : {}) });
    if (!isPlainRecord(native) || Object.keys(native).some(key => schema.fields.some(f => f.name === key))) invalid();
    const options = normalizeConfiguration(plugin.descriptor.configuration, { ...publicOptions, ...native }, selection.schemaVersion, platform);
    const saved = value.default.selection;
    const selected = selection.model ?? (saved ? (saved.backendId === selection.backendId ? saved : undefined) : context.availableModels[0] ? { model: context.availableModels[0].id, reasoningEffort: null } : undefined);
    if (!selected) throw new AgentError('model_unavailable');
    if (!selection.model && !saved && this.defaultBackendId() !== selection.backendId) invalid();
    const frozen: FrozenAgentSelection = { settingsGeneration: SETTINGS_GENERATION, permissions: structuredClone(value.permissions), backendId: selection.backendId, configRevision: current.revision, schemaVersion: schema.version, apiVersion: plugin.descriptor.apiVersion, implementationVersion: plugin.descriptor.implementationVersion, runtimeVersion: context.runtimeVersion ?? null, options, model: this.selectedModel(selection.backendId, { model: selected.model, reasoningEffort: selected.reasoningEffort }, context.availableModels, !selection.model && !saved) };
    this.registry.validateFrozen(frozen, platform);
    return immutable(frozen);
  }
  assertCurrent(frozen: FrozenAgentSelection, platform: AgentPlatform = process.platform as AgentPlatform): void {
    this.registry.validateFrozen(frozen, platform);
    if (frozen.settingsGeneration !== SETTINGS_GENERATION) invalid();
    const value = this.get(platform); const backend = this.getBackend(frozen.backendId, platform);
    if (!backend.enabled) throw new AgentError('runtime_unavailable');
    if (backend.revision !== frozen.configRevision || backend.schemaVersion !== frozen.schemaVersion || !sameProjectPermissions(frozen.permissions, value.permissions)) conflict();
  }
  withCurrent<T>(frozen: FrozenAgentSelection, accept: () => T, platform?: AgentPlatform): T {
    return this.atomic(() => { this.assertCurrent(frozen, platform); const result = accept(); if (result && typeof (result as { then?: unknown }).then === 'function') invalid(); return result; });
  }
  /** Legacy/image submissions retain their old frozen options, but enabling a
   * backend is shared with the new configuration and checked under its lock. */
  withEnabledBackend<T>(backendId: string, revision: number, accept: () => T): T {
    return this.atomic(() => {
      const backend = this.getBackend(backendId);
      if (!backend.enabled) throw new AgentError('runtime_unavailable');
      if (backend.revision !== revision) conflict();
      const result = accept();
      if (result && typeof (result as { then?: unknown }).then === 'function') invalid();
      return result;
    });
  }
}
