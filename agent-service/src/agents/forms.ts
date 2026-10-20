import type { AgentForm, AgentFormValue, AgentFormField } from '@openworkgraph/protocol';
import { exactKeys, isPlainRecord } from './configuration.js';
import { AgentError } from './errors.js';
const keys = ['key', 'type', 'title', 'description', 'required', 'hidden', 'when', 'options', 'custom', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'placeholder', 'actionId'];
const formText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const invalid = (): never => { throw new AgentError('invalid_configuration'); };
function validFormat(format: AgentFormField['format'], value: string): boolean {
  if (!format) return true;
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (format === 'uri') { try { return !!new URL(value).protocol; } catch { return false; } }
  if (format === 'date') return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && validFormat('date', value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function validValue(field: AgentFormField, value: unknown): boolean {
  if (field.type === 'external') return false;
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (field.type !== 'integer' || Number.isSafeInteger(value)) && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  if (field.type === 'multiselect') return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length <= 16000) && new Set(value).size === value.length && value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? 64) && (field.custom === true || value.every(item => field.options?.some(option => option.value === item)));
  return typeof value === 'string' && value.length >= (field.minLength ?? 0) && value.length <= (field.maxLength ?? 16000) && (field.pattern === undefined || new RegExp(field.pattern, 'u').test(value)) && validFormat(field.format, value) && (field.options === undefined || field.custom === true || field.options.some(option => option.value === value));
}
export function validateAgentForm(value: unknown): AgentForm {
  if (!isPlainRecord(value) || !exactKeys(value, ['version', 'fields']) || value.version !== 1 || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 32 || Buffer.byteLength(JSON.stringify(value)) > 49152) invalid();
  const form = value as unknown as AgentForm, previous = new Map<string, string>();
  for (const field of form.fields) {
    if (!isPlainRecord(field) || !exactKeys(field, keys) || !formText(field.key, 128) || previous.has(field.key) || !['string', 'number', 'integer', 'boolean', 'multiselect', 'external'].includes(field.type)) invalid();
    for (const key of ['title', 'description', 'placeholder', 'actionId'] as const) if (field[key] !== undefined && !formText(field[key], key === 'description' ? 16000 : 1024)) invalid();
    for (const key of ['required', 'hidden', 'custom'] as const) if (field[key] !== undefined && typeof field[key] !== 'boolean') invalid();
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (field[key] !== undefined && (!Number.isFinite(field[key]) || !['minimum', 'maximum'].includes(key) && (!Number.isSafeInteger(field[key]) || field[key]! < 0))) invalid();
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum || field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength || field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) invalid();
    // Do not execute arbitrary backtracking regex from a plugin on the host.
    if (field.pattern !== undefined && (typeof field.pattern !== 'string' || field.pattern.length > 256 || /[()*+{]|\\[1-9]/.test(field.pattern))) invalid();
    if (field.pattern) try { new RegExp(field.pattern, 'u'); } catch { invalid(); }
    if (field.options !== undefined && (!['string', 'multiselect'].includes(field.type) || !Array.isArray(field.options) || field.options.length > 64 || field.options.some(option => !isPlainRecord(option) || !exactKeys(option, ['value', 'label', 'description']) || !formText(option.value, 1024) || !formText(option.label, 1024) || option.description !== undefined && !formText(option.description, 4096)) || new Set(field.options.map(option => option.value)).size !== field.options.length)) invalid();
    if (field.type === 'multiselect' && !field.options || field.type === 'external' && (!field.actionId || field.default !== undefined)) invalid();
    if (field.when !== undefined && (!Array.isArray(field.when) || field.when.length > 16 || field.when.some(condition => !isPlainRecord(condition) || !exactKeys(condition, ['key', 'op', 'value']) || !previous.has(condition.key) || !['eq', 'neq'].includes(condition.op) || (previous.get(condition.key) === 'boolean' ? typeof condition.value !== 'boolean' : ['number', 'integer'].includes(previous.get(condition.key)!) ? typeof condition.value !== 'number' || !Number.isFinite(condition.value) : typeof condition.value !== 'string')))) invalid();
    if (field.format !== undefined && (field.type !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(field.format))) invalid();
    for (const key of ['minimum', 'maximum'] as const) if (field[key] !== undefined && !['number', 'integer'].includes(field.type)) invalid();
    for (const key of ['minLength', 'maxLength', 'pattern'] as const) if (field[key] !== undefined && field.type !== 'string') invalid();
    for (const key of ['minItems', 'maxItems'] as const) if (field[key] !== undefined && field.type !== 'multiselect') invalid();
    if (field.actionId !== undefined && field.type !== 'external' || field.default !== undefined && !validValue(field, field.default)) invalid();
    previous.set(field.key, field.type);
  }
  return structuredClone(form);
}
/** No coercion, guessed defaults or automatic answers. Inactive fields cannot
 * be answered; defaults remain metadata until a caller explicitly supplies them. */
export function validateAgentFormAnswer(formValue: unknown, answers: unknown): Record<string, AgentFormValue> {
  const form = validateAgentForm(formValue);
  if (!isPlainRecord(answers) || Object.keys(answers).some(key => !form.fields.some(field => field.key === key))) invalid();
  if (form.fields.some(field => field.type === 'external')) throw new AgentError('capability_unsupported');
  const data = answers as Record<string, unknown>;
  for (const field of form.fields) {
    const active = !field.when || field.when.every(condition => {
      if (!Object.hasOwn(data, condition.key)) return false;
      const observed = data[condition.key], equal = Array.isArray(observed) ? observed.includes(condition.value) : observed === condition.value;
      return condition.op === 'eq' ? equal : !equal;
    });
    const value = Object.hasOwn(data, field.key) ? data[field.key] : undefined;
    if (!active) { if (value !== undefined) invalid(); continue; }
    if (field.type === 'external') { if (value !== undefined) invalid(); continue; }
    if (value === undefined) { if (field.required) invalid(); continue; }
    if (!validValue(field, value)) invalid();
  }
  return structuredClone(answers) as Record<string, AgentFormValue>;
}
