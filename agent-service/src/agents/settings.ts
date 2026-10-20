import type { DatabaseSync } from 'node:sqlite';
import type { AgentDefault, AgentModelOption, AgentOptionValue, AgentPlatform, AgentSelection, AgentSettings, FrozenAgentSelection, ModelSelection } from '@openworkgraph/protocol';
import { ModelDefaultsStore } from '../backend/models.js';
import { ExecutionSettingsStore } from '../execution-settings.js';
import { ServiceError } from '../errors.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText } from './configuration.js';
import { validateAgentModels, assertModelVariant } from './discovery.js';
import { AgentError } from './errors.js';
import { AgentRegistry } from './registry.js';

export interface AgentSettingsPatch { enabled?: boolean; schemaVersion?: number; options?: Record<string, AgentOptionValue>; model?: ModelSelection | null }
export interface AgentFreezeContext { availableModels: readonly AgentModelOption[]; platform?: AgentPlatform; runtimeVersion?: string | null }
export interface AgentSettingsBinding {
  read(): { revision: number; options: Record<string, AgentOptionValue>; model: ModelSelection | null };
  write(options: Record<string, AgentOptionValue>, model: ModelSelection | null, models: readonly AgentModelOption[]): void;
  /** Names whose values live exclusively in the legacy store. */
  optionNames: readonly string[];
}
/** The ONLY named compatibility bridge. Generic Registry/router need no branches.
 * Models and sandbox permissions have one source of truth shared with old APIs. */
export class CodexAgentSettingsBinding implements AgentSettingsBinding {
  readonly optionNames = ['sandboxMode'];
  private readonly models: ModelDefaultsStore; private readonly execution: ExecutionSettingsStore;
  constructor(db: DatabaseSync) { this.models = new ModelDefaultsStore(db); this.execution = new ExecutionSettingsStore(db); }
  read() {
    const models = this.models.get(); const execution = this.execution.get();
    return { revision: revisionSum(models.revision, execution.revision), options: { sandboxMode: execution.sandboxMode }, model: models.selection };
  }
  write(options: Record<string, AgentOptionValue>, model: ModelSelection | null, models: readonly AgentModelOption[]): void {
    const currentModels = this.models.get(); const currentExecution = this.execution.get();
    if (JSON.stringify(currentModels.selection) !== JSON.stringify(model)) {
      if (model === null) throw new AgentError('model_unavailable');
      this.models.set(model, currentModels.revision, models.map(entry => ({ ...entry, reasoningEfforts: [...entry.reasoningEfforts], defaultReasoningEffort: entry.defaultReasoningEffort ?? null })));
    }
    if (options.sandboxMode !== currentExecution.sandboxMode) this.execution.set(options.sandboxMode, currentExecution.revision);
  }
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function revisionSum(...values: number[]): number {
  const value = values.reduce((total, entry) => total + entry, 0);
  if (!revision(value)) throw new ServiceError('MAINTENANCE', '执行器设置修订号损坏。'); return value;
}
function modelShape(value: unknown): value is ModelSelection {
  return isPlainRecord(value) && exactKeys(value, ['model', 'reasoningEffort']) && publicText(value.model, 256) && value.model === value.model.trim() && (value.reasoningEffort === null || publicText(value.reasoningEffort, 64));
}
function conflict(): never { throw new ServiceError('REVISION_CONFLICT', '执行器设置已变化，请刷新后重试。'); }
function immutableFrozen(selection: FrozenAgentSelection): FrozenAgentSelection {
  Object.freeze(selection.options); Object.freeze(selection.model); return Object.freeze(selection);
}
interface Persisted { revision: number; enabled: boolean; schemaVersion: number; options: Record<string, AgentOptionValue>; model: ModelSelection | null }
let transactionSerial = 0;
/** Synchronous SQL CAS. Resolve catalog BEFORE calling this store inside a host
 * acceptance transaction. Existing frozen tasks never re-read current settings. */
export class AgentSettingsStore {
  private readonly bindings: Readonly<Record<string, AgentSettingsBinding>>;
  constructor(private readonly db: DatabaseSync, private readonly registry: AgentRegistry, bindings: Readonly<Record<string, AgentSettingsBinding>> = { codex: new CodexAgentSettingsBinding(db) }) { this.bindings = bindings; }
  private key(backendId: string): string { this.registry.get(backendId); return 'agentSettings:' + backendId; }
  private read(backendId: string, platform: AgentPlatform): { raw: string | null; local: Persisted; public: AgentSettings } {
    const descriptor = this.registry.get(backendId).descriptor;
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key(backendId));
    const raw = row ? String(row.value) : null;
    let value: unknown;
    try { value = raw === null ? { revision: 0, enabled: true, schemaVersion: descriptor.configuration.version, options: {}, model: null } : JSON.parse(raw); }
    catch { throw new ServiceError('MAINTENANCE', '执行器设置损坏。'); }
    if (!isPlainRecord(value) || !exactKeys(value, ['revision', 'enabled', 'schemaVersion', 'options', 'model']) || !revision(value.revision) || (raw !== null && value.revision === 0) || typeof value.enabled !== 'boolean' || value.schemaVersion !== descriptor.configuration.version || !isPlainRecord(value.options) || (value.model !== null && !modelShape(value.model))) throw new ServiceError('MAINTENANCE', '执行器设置损坏或配置版本不兼容。');
    const local = value as unknown as Persisted;
    const binding = Object.hasOwn(this.bindings, backendId) ? this.bindings[backendId] : undefined;
    let shared: ReturnType<AgentSettingsBinding['read']> | undefined;
    try { shared = binding?.read(); }
    catch { throw new ServiceError('MAINTENANCE', '执行器兼容设置损坏或不可用。'); }
    if (shared && (!revision(shared.revision) || (shared.model !== null && !modelShape(shared.model)))) throw new ServiceError('MAINTENANCE', '执行器兼容设置损坏。');
    const schema = raw === null ? { ...descriptor.configuration, fields: descriptor.configuration.fields.map(field => ({ ...field, required: false })) } : descriptor.configuration;
    const options = normalizeConfiguration(schema, { ...local.options, ...shared?.options }, local.schemaVersion, platform);
    const model = shared ? shared.model : local.model;
    return { raw, local, public: { backendId, revision: revisionSum(local.revision, shared?.revision ?? 0), enabled: local.enabled, schemaVersion: local.schemaVersion, options, model: model === null ? null : { ...model } } };
  }
  get(backendId: string, platform: AgentPlatform = process.platform as AgentPlatform): AgentSettings { return this.read(backendId, platform).public; }
  set(backendId: string, patch: AgentSettingsPatch, expectedRevision: number, availableModels: readonly AgentModelOption[] = [], platform: AgentPlatform = process.platform as AgentPlatform): AgentSettings {
    if (!revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER || !isPlainRecord(patch as unknown) || !exactKeys(patch as unknown as Record<string, unknown>, ['enabled', 'schemaVersion', 'options', 'model']) || (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') || (Object.hasOwn(patch, 'schemaVersion') && patch.schemaVersion !== this.registry.get(backendId).descriptor.configuration.version) || (Object.hasOwn(patch, 'model') && patch.model !== null && !modelShape(patch.model))) throw new AgentError('invalid_configuration');
    return this.atomic(() => {
      const current = this.read(backendId, platform); if (current.public.revision !== expectedRevision) conflict();
      const descriptor = this.registry.get(backendId).descriptor;
      const options = normalizeConfiguration(descriptor.configuration, Object.hasOwn(patch, 'options') ? patch.options : current.public.options, patch.schemaVersion ?? current.public.schemaVersion, platform);
      // Metadata-only edits retain the stored model without requiring a live
      // directory. Every explicit non-null selection, even the same value,
      // still validates catalog membership and the plugin's effort policy.
      const model = !Object.hasOwn(patch, 'model') ? current.public.model
        : patch.model === null ? null : this.freezeModel(backendId, patch.model!, availableModels, options);
      const binding = Object.hasOwn(this.bindings, backendId) ? this.bindings[backendId] : undefined;
      binding?.write(options, model, availableModels);
      const next: Persisted = { revision: current.local.revision + 1, enabled: patch.enabled ?? current.public.enabled, schemaVersion: descriptor.configuration.version, options: Object.fromEntries(Object.entries(options).filter(([name]) => !binding?.optionNames.includes(name))), model: binding ? null : model };
      const result = current.raw === null
        ? this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(this.key(backendId), JSON.stringify(next))
        : this.db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(JSON.stringify(next), this.key(backendId), current.raw);
      if (result.changes !== 1) conflict();
      return this.get(backendId, platform);
    });
  }
  private readDefault(): { raw: string | null; selection: AgentDefault } {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='agentDefault'").get();
    if (!row) return { raw: null, selection: { revision: 0, backendId: 'codex' } };
    const raw = String(row.value); let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ServiceError('MAINTENANCE', '默认执行器设置损坏。'); }
    if (!isPlainRecord(value) || !exactKeys(value, ['revision', 'backendId']) || !revision(value.revision) || value.revision === 0 || typeof value.backendId !== 'string') throw new ServiceError('MAINTENANCE', '默认执行器设置损坏。');
    return { raw, selection: value as unknown as AgentDefault };
  }
  getDefault(): AgentDefault { return this.readDefault().selection; }
  setDefault(backendId: string, expectedRevision: number): AgentDefault {
    if (!revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER) throw new AgentError('invalid_configuration');
    return this.atomic(() => {
      if (!this.get(backendId).enabled) throw new AgentError('runtime_unavailable');
      const current = this.readDefault(); if (current.selection.revision !== expectedRevision) conflict();
      const next = { revision: expectedRevision + 1, backendId };
      const result = current.raw === null
        ? this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('agentDefault',?)").run(JSON.stringify(next))
        : this.db.prepare("UPDATE settings SET value=? WHERE key='agentDefault' AND value=?").run(JSON.stringify(next), current.raw);
      if (result.changes !== 1) conflict(); return next;
    });
  }
  private freezeModel(backendId: string, selected: ModelSelection, availableModels: readonly AgentModelOption[], options: Readonly<Record<string, AgentOptionValue>>): ModelSelection {
    if (!modelShape(selected)) throw new AgentError('model_unavailable');
    const policy = this.registry.get(backendId).descriptor.models;
    const models = validateAgentModels(availableModels, policy.effort, !!policy.variantOption);
    const known = models.find(model => model.id === selected.model);
    if (!known && !policy.allowCustom) throw new AgentError('model_unavailable');
    const effort = selected.reasoningEffort ?? known?.defaultReasoningEffort ?? null;
    if ((!policy.effort && effort !== null) || (effort !== null && (!known || !known.reasoningEfforts.includes(effort)))) throw new AgentError('model_unavailable');
    assertModelVariant(this.registry.get(backendId).descriptor, options, selected.model, models, effort);
    return { model: selected.model, reasoningEffort: effort };
  }
  freeze(selection: AgentSelection | undefined, context: AgentFreezeContext | readonly AgentModelOption[], platform?: AgentPlatform): FrozenAgentSelection {
    const preparation: AgentFreezeContext = Array.isArray(context) ? { availableModels: context, ...(platform ? { platform } : {}) } : context as AgentFreezeContext;
    const device = preparation.platform ?? process.platform as AgentPlatform;
    if (selection !== undefined && (!isPlainRecord(selection) || !exactKeys(selection, ['backendId', 'configRevision', 'schemaVersion', 'options', 'model']) || typeof selection.backendId !== 'string' || !revision(selection.configRevision) || (Object.hasOwn(selection, 'options') && !isPlainRecord(selection.options)) || (Object.hasOwn(selection, 'model') && !modelShape(selection.model)))) throw new AgentError('invalid_configuration');
    const backendId = selection?.backendId ?? this.getDefault().backendId;
    const plugin = this.registry.get(backendId); const current = this.get(backendId, device);
    if (!current.enabled) throw new AgentError('runtime_unavailable');
    if (selection && selection.configRevision !== current.revision) conflict();
    // Submission options are an overlay, not a replacement for saved settings.
    // Normalize the merged value without changing the original request identity.
    const overrides = selection?.options ?? {};
    const options = normalizeConfiguration(plugin.descriptor.configuration, { ...current.options, ...overrides }, selection?.schemaVersion ?? current.schemaVersion, device);
    const selected = selection?.model ?? current.model; if (selected === null) throw new AgentError('model_unavailable');
    const runtimeVersion = preparation.runtimeVersion ?? null;
    if (runtimeVersion !== null && !/^[0-9A-Za-z.+_-]{1,128}$/.test(runtimeVersion)) throw new AgentError('protocol_error');
    return immutableFrozen({ backendId, apiVersion: plugin.descriptor.apiVersion, schemaVersion: plugin.descriptor.configuration.version, implementationVersion: plugin.descriptor.implementationVersion, runtimeVersion, configRevision: current.revision, options, model: this.freezeModel(backendId, selected, preparation.availableModels, options) });
  }
  /** Use only for an independent new submission, in the accepting transaction. */
  assertCurrent(frozen: FrozenAgentSelection, expectedDefaultRevision?: number, platform: AgentPlatform = process.platform as AgentPlatform): void {
    this.registry.validateFrozen(frozen, platform);
    const current = this.get(frozen.backendId, platform);
    if (!current.enabled) throw new AgentError('runtime_unavailable');
    if (current.revision !== frozen.configRevision || current.schemaVersion !== frozen.schemaVersion) conflict();
    if (expectedDefaultRevision !== undefined && this.getDefault().revision !== expectedDefaultRevision) conflict();
  }
  private atomic<T>(work: () => T): T {
    const savepoint = 'agent_settings_' + (++transactionSerial);
    this.db.exec('SAVEPOINT ' + savepoint);
    try { const result = work(); this.db.exec('RELEASE SAVEPOINT ' + savepoint); return result; }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); this.db.exec('RELEASE SAVEPOINT ' + savepoint); throw error; }
  }
}
