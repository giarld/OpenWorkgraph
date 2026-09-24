import type { DatabaseSync } from 'node:sqlite';
import type { ModelDefaults, ModelOption, ModelSelection } from '@openworkgraph/protocol';
import { BackendError } from './types.js';
export interface BackendModel extends ModelOption { defaultReasoningEffort: string | null }
export function freezeModelSelection(selection: ModelSelection | null, available: readonly BackendModel[]): Readonly<ModelSelection> {
  const model = selection && available.find(option => option.id === selection.model);
  if (!model) throw new BackendError('MODEL_UNAVAILABLE', 'Select an available model explicitly; automatic fallback is disabled');
  const effort = selection.reasoningEffort ?? model.defaultReasoningEffort;
  if (effort !== null && !model.reasoningEfforts.includes(effort)) throw new BackendError('MODEL_UNAVAILABLE', 'Selected reasoning effort is unavailable');
  return Object.freeze({ model: model.id, reasoningEffort: effort });
}
/** Synchronous CAS only. Resolve/probe catalog before entering a scheduler transaction. */
export class ModelDefaultsStore {
  constructor(private readonly db: DatabaseSync) {}
  private read(): { raw: string; revision: number; selection: ModelSelection | null } {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='modelDefaults'").get();
    if (!row || typeof row['value'] !== 'string') throw new BackendError('UNAVAILABLE', 'Missing modelDefaults setting');
    const raw = row['value']; const value = JSON.parse(raw);
    if (value === null) return { raw, revision: 0, selection: null };
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || (value.selection !== null && (typeof value.selection?.model !== 'string' || !(value.selection.reasoningEffort === null || typeof value.selection.reasoningEffort === 'string')))) throw new BackendError('PROTOCOL', 'Invalid persisted model defaults');
    return { raw, revision: value.revision, selection: value.selection };
  }
  get(available: readonly BackendModel[] = []): ModelDefaults { const { revision, selection } = this.read(); return { revision, selection, available: available.map(({ id, reasoningEfforts, defaultReasoningEffort }) => ({ id, reasoningEfforts: [...reasoningEfforts], defaultReasoningEffort })) }; }
  set(selection: ModelSelection, expectedRevision: number, available: readonly BackendModel[]): ModelDefaults {
    const frozen = freezeModelSelection(selection, available); const current = this.read();
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new BackendError('CONFLICT', 'Model defaults revision changed');
    const next = { revision: expectedRevision + 1, selection: frozen };
    const result = this.db.prepare("UPDATE settings SET value=? WHERE key='modelDefaults' AND value=?").run(JSON.stringify(next), current.raw);
    if (result.changes !== 1) throw new BackendError('CONFLICT', 'Model defaults revision changed');
    return { ...next, available: available.map(({ id, reasoningEfforts, defaultReasoningEffort }) => ({ id, reasoningEfforts: [...reasoningEfforts], defaultReasoningEffort })) };
  }
  freeze(override: ModelSelection | undefined, available: readonly BackendModel[]): Readonly<ModelSelection> { return freezeModelSelection(override ?? this.read().selection, available); }
}
