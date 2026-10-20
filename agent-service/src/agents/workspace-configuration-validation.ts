import type { AgentProjectPermissions, AgentConfigurationSchema } from '@openworkgraph/protocol';
import { exactKeys, isPlainRecord } from './configuration.js';
import { AgentError } from './errors.js';

export const SETTINGS_GENERATION = 'agent-configuration-v1' as const;
export function configurationRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function validateProjectPermissions(value: unknown): asserts value is AgentProjectPermissions {
  if (!isPlainRecord(value) || !exactKeys(value, ['revision', 'project', 'runs']) || !configurationRevision(value.revision) || !['read-only', 'workspace-write', 'danger-full-access'].includes(String(value.project)) || value.runs !== 'read-write') throw new AgentError('invalid_configuration');
}
export function sameProjectPermissions(left: AgentProjectPermissions | undefined, right: AgentProjectPermissions): boolean {
  return Boolean(left && left.revision === right.revision && left.project === right.project && left.runs === right.runs);
}
export function validateSelectionGeneration(value: { settingsGeneration?: unknown; permissions?: unknown }): void {
  if (!Object.hasOwn(value, 'settingsGeneration') && !Object.hasOwn(value, 'permissions')) return;
  if (value.settingsGeneration !== SETTINGS_GENERATION) throw new AgentError('invalid_configuration');
  validateProjectPermissions(value.permissions);
}
/** Compatibility schemas retain native permission fields, but the new editor does not. */
export function isPermissionOption(name: string): boolean {
  return /(?:permission|sandbox)/i.test(name);
}
export function workspaceConfigurationSchema(schema: AgentConfigurationSchema): AgentConfigurationSchema {
  return { ...schema, fields: schema.fields.filter(field => !isPermissionOption(field.name)) };
}

/** Validate all wire shapes before accessing nested fields or issuing discovery. */
export function validateConfigurationUpdate(value: unknown): asserts value is import('@openworkgraph/protocol').AgentConfigurationUpdate {
  const fail = (): never => { throw new AgentError('invalid_configuration'); };
  if (!isPlainRecord(value) || !configurationRevision(value.expectedRevision) || value.expectedRevision === Number.MAX_SAFE_INTEGER) fail();
  const input = value as Record<string, unknown>;
  const id = (entry: unknown) => typeof entry === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(entry) && entry.length <= 128;
  const text = (entry: unknown, max: number) => typeof entry === 'string' && entry.length > 0 && entry.length <= max && entry === entry.trim();
  switch (input.section) {
    case 'permissions':
      if (!exactKeys(input, ['section', 'expectedRevision', 'project'])) fail();
      validateProjectPermissions({ revision: input.expectedRevision, project: input.project, runs: 'read-write' }); break;
    case 'backend':
      if (!exactKeys(input, ['section', 'expectedRevision', 'backendId', 'enabled', 'schemaVersion', 'options', 'models', 'source']) || input.source !== undefined && input.source !== 'settings' || !id(input.backendId) || typeof input.enabled !== 'boolean' || !configurationRevision(input.schemaVersion) || input.schemaVersion === 0 || !isPlainRecord(input.options) || !Array.isArray(input.models) || input.models.length > 4096 || input.models.some(m => !isPlainRecord(m) || !exactKeys(m, ['id', 'visible']) || !text(m.id, 256) || typeof m.visible !== 'boolean') || new Set(input.models.map(m => m.id)).size !== input.models.length) fail();
      break;
    case 'default': {
      if (!exactKeys(input, ['section', 'expectedRevision', 'selection'])) fail();
      const selection = input.selection;
      if (selection !== null && (!isPlainRecord(selection) || !exactKeys(selection, ['backendId', 'model', 'reasoningEffort']) || !id(selection.backendId) || !text(selection.model, 256) || !(selection.reasoningEffort === null || text(selection.reasoningEffort, 64)))) fail();
      break;
    }
    case 'order':
      if (!exactKeys(input, ['section', 'expectedRevision', 'backendIds']) || !Array.isArray(input.backendIds) || input.backendIds.length > 1024 || !input.backendIds.every(id) || new Set(input.backendIds).size !== input.backendIds.length) fail();
      break;
    default: fail();
  }
}
