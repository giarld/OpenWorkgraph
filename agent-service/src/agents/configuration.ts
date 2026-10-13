import type { AgentConfigurationField, AgentConfigurationSchema, AgentOptionValue, AgentPlatform } from '@openworkgraph/protocol';
import { configurationError } from './errors.js';

const platforms = ['darwin', 'linux', 'win32'];
const schemaKeys = ['version', 'fields'];
const fieldKeys = ['name', 'type', 'label', 'description', 'required', 'default', 'values', 'minimum', 'maximum', 'minLength', 'maxLength', 'integer', 'platforms'];
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && !Array.isArray(value);
}
export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
export function validPlatform(value: unknown): value is AgentPlatform { return typeof value === 'string' && platforms.includes(value); }
export function publicText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && ![...value].some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
    && !/(?:^|[\s="'])(?:\/[^/\s]|[A-Za-z]:[\\/]|~\/|[.][.]?\/|\\\\)|\$\{?[A-Z][A-Z0-9_]*\}?|(?:^|\s)[A-Z][A-Z0-9_]*=|(?:sk-|Bearer\s)[A-Za-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY-----/.test(value);
}
function publicValue(value: unknown): value is AgentOptionValue {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && (value === '' || publicText(value)));
}
function validValue(field: AgentConfigurationField, value: unknown): value is AgentOptionValue {
  if (!publicValue(value)) return false;
  switch (field.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && !!field.values?.includes(value);
    case 'text': return typeof value === 'string' && value.length >= (field.minLength ?? 0) && value.length <= (field.maxLength ?? 4096);
    case 'number': return typeof value === 'number' && (!field.integer || Number.isSafeInteger(value)) && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
  }
}
/** Validate the entire finite public schema without executing plugin code. */
export function validateConfigurationSchema(value: unknown): asserts value is AgentConfigurationSchema {
  if (!isPlainRecord(value) || !exactKeys(value, schemaKeys) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !Array.isArray(value.fields) || value.fields.length > 64) configurationError();
  const names = new Set<string>();
  for (const entry of value.fields) {
    if (!isPlainRecord(entry) || !exactKeys(entry, fieldKeys) || typeof entry.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(entry.name) || /(?:secret|token|password|credential|api_?key|access_?key|private_?key|authorization|cookie|environment|^env$|path|executable|^args$)/i.test(entry.name) || ['constructor', 'prototype', '__proto__'].includes(entry.name) || names.has(entry.name) || !publicText(entry.label, 256) || (entry.description !== undefined && !publicText(entry.description)) || !['text', 'boolean', 'enum', 'number'].includes(String(entry.type))) configurationError();
    names.add(entry.name);
    if (entry.required !== undefined && typeof entry.required !== 'boolean') configurationError();
    if (entry.platforms !== undefined && (!Array.isArray(entry.platforms) || entry.platforms.length === 0 || entry.platforms.length > 3 || !entry.platforms.every(validPlatform) || new Set(entry.platforms).size !== entry.platforms.length)) configurationError();
    if (entry.type === 'enum') {
      if (!Array.isArray(entry.values) || entry.values.length === 0 || entry.values.length > 128 || !entry.values.every(v => publicText(v, 256)) || new Set(entry.values).size !== entry.values.length) configurationError();
    } else if (entry.values !== undefined) configurationError();
    for (const key of ['minimum', 'maximum']) if (entry[key] !== undefined && (entry.type !== 'number' || typeof entry[key] !== 'number' || !Number.isFinite(entry[key]))) configurationError();
    if (entry.integer !== undefined && (entry.type !== 'number' || typeof entry.integer !== 'boolean')) configurationError();
    for (const key of ['minLength', 'maxLength']) if (entry[key] !== undefined && (entry.type !== 'text' || !Number.isSafeInteger(entry[key]) || (entry[key] as number) < 0 || (entry[key] as number) > 4096)) configurationError();
    if ((entry.minimum as number ?? -Infinity) > (entry.maximum as number ?? Infinity) || (entry.minLength as number ?? 0) > (entry.maxLength as number ?? 4096)) configurationError();
    if (entry.default !== undefined && !validValue(entry as unknown as AgentConfigurationField, entry.default)) configurationError();
  }
}
/** Lexically ordered keys, no coercion, no defaults for unavailable fields.
 * Values are preserved exactly; equivalent input key order has one wire form. */
export function normalizeConfiguration(schema: AgentConfigurationSchema, options: unknown = {}, schemaVersion = schema.version, platform: AgentPlatform = process.platform as AgentPlatform): Record<string, AgentOptionValue> {
  validateConfigurationSchema(schema);
  if (schemaVersion !== schema.version || !validPlatform(platform) || !isPlainRecord(options) || !exactKeys(options, schema.fields.map(field => field.name))) configurationError();
  const result: Record<string, AgentOptionValue> = {};
  for (const field of [...schema.fields].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const supplied = Object.hasOwn(options, field.name);
    if (field.platforms && !field.platforms.includes(platform)) { if (supplied) configurationError(); continue; }
    const value = supplied ? options[field.name] : field.default;
    if (value === undefined) { if (field.required) configurationError(); continue; }
    if (!validValue(field, value)) configurationError();
    result[field.name] = value;
  }
  return result;
}
