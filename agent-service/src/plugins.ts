import { isSkillName, validateVisualizeNodeContent } from '@openworkgraph/protocol';
import type { DatabaseSync } from 'node:sqlite';
import type { Json, ResourceEnvelope, SkillReference } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

type ObjectJson = { [key: string]: Json };
export interface ContentSchema { type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'; properties?: Record<string, ContentSchema>; required?: string[]; items?: ContentSchema; additionalProperties?: boolean }
export interface ResourceMapping { kind: ResourceEnvelope['kind']; textField?: string; resourceIdField?: string; resourceVersionField?: string }
export interface DeclarativeMigration { fromSchemaVersion: number; rename?: Record<string, string>; defaults?: ObjectJson }
export interface PluginContract { typeId: string; pluginId: string; version: string; apiVersion: string; schemaVersion: number; contentSchema: ContentSchema; resources: ResourceMapping[]; migrations?: DeclarativeMigration[] }
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const builtins = new Set(['text', 'image', 'document', 'video', 'file', 'preview', 'execution', 'group', 'visualize']);
function invalid(message: string): never { throw new ServiceError('INVALID_REQUEST', message); }
/** Bounded pure JSON only: no getters, functions, cycles or exotic prototypes. */
export function checkedJson(value: unknown, maxBytes = 16_777_216, maxDepth = 32): Json {
  let bytes = 0; const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (depth > maxDepth) invalid('JSON depth limit exceeded');
    if (v === null || typeof v === 'boolean') bytes += 5;
    else if (typeof v === 'number' && Number.isFinite(v)) bytes += 24;
    else if (typeof v === 'string') bytes += Buffer.byteLength(JSON.stringify(v));
    else if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) invalid('Cyclic JSON');
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid('Only plain JSON objects supported');
      seen.add(v); bytes += 2;
      for (const key of Reflect.ownKeys(v)) {
        if (Array.isArray(v) && key === 'length') continue;
        if (typeof key !== 'string' || forbidden.has(key)) invalid('Unsafe JSON key');
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) invalid('JSON accessors are not supported');
        bytes += Buffer.byteLength(key) + 4; visit(descriptor.value, depth + 1);
        if (bytes > maxBytes) invalid('JSON size limit exceeded');
      }
      seen.delete(v);
    } else invalid('Value is not JSON');
    if (bytes > maxBytes) invalid('JSON size limit exceeded');
  }
  // Clone the validated tree without constructing a single aggregate string.
  // Strings are immutable and can be shared, including large resource payloads.
  function clone(v: Json): Json {
    if (v === null || typeof v !== 'object') return Object.is(v, -0) ? 0 : v;
    if (Array.isArray(v)) return Array.from(v, item => item === undefined ? null : clone(item));
    return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, clone(item)]));
  }
  visit(value, 0); return clone(value as Json);
}
function object(v: unknown): v is ObjectJson { return !!v && typeof v === 'object' && !Array.isArray(v); }
function path(field: unknown): string[] {
  if (typeof field !== 'string' || field.length > 256) invalid('Invalid resource field path');
  const parts = field.split('.');
  if (parts.length > 8 || parts.some(p => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p) || forbidden.has(p))) invalid('Invalid resource field path');
  return parts;
}
export function readField(content: Json, field: string): Json | undefined {
  let value: Json | undefined = content;
  for (const key of path(field)) value = object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}
function validateSchema(schema: ContentSchema): void {
  if (!object(schema) || !['object','array','string','number','integer','boolean','null'].includes(schema.type)) invalid('Unsupported content schema');
  for (const key of Object.keys(schema)) if (!['type','properties','required','items','additionalProperties'].includes(key)) invalid(`Unsupported schema keyword ${key}`);
  if (schema.properties !== undefined) {
    if (schema.type !== 'object' || !object(schema.properties)) invalid('Invalid schema properties');
    for (const value of Object.values(schema.properties)) validateSchema(value);
  }
  if (schema.required !== undefined && (schema.type !== 'object' || !Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string' || forbidden.has(k)))) invalid('Invalid required fields');
  if (schema.additionalProperties !== undefined && (schema.type !== 'object' || typeof schema.additionalProperties !== 'boolean')) invalid('Invalid additionalProperties');
  if (schema.items !== undefined) { if (schema.type !== 'array') invalid('Invalid array schema'); validateSchema(schema.items); }
}
function matches(schema: ContentSchema, value: Json): boolean {
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every(v => matches(schema.items!, v)));
  if (schema.type === 'object') return object(value) && (schema.required ?? []).every(k => Object.hasOwn(value, k)) && Object.entries(value).every(([k,v]) => schema.properties?.[k] ? matches(schema.properties[k], v) : schema.additionalProperties !== false);
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === schema.type;
}
function validateContract(input: unknown): PluginContract {
  const c = checkedJson(input, 65_536, 16) as unknown as PluginContract;
  if (!object(c) || !/^[a-z][a-z0-9._-]{0,127}$/.test(c.typeId) || typeof c.typeId !== 'string') invalid('Invalid typeId');
  if (Object.keys(c).some(k => !['typeId','pluginId','version','apiVersion','schemaVersion','contentSchema','resources','migrations'].includes(k))) invalid('Unsupported contract field; executable entries are not resource contracts');
  if (typeof c.pluginId !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(c.pluginId) || typeof c.version !== 'string' || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(c.version)) invalid('Invalid plugin identity/version');
  if (c.apiVersion !== '1.0' || !Number.isSafeInteger(c.schemaVersion) || c.schemaVersion < 1) invalid('Unsupported API/schema version');
  validateSchema(c.contentSchema);
  if (!Array.isArray(c.resources) || c.resources.length > 32) invalid('Invalid resource mappings');
  for (const m of c.resources) {
    if (!object(m) || !['text','image','document','video','file'].includes(m.kind)) invalid('Invalid resource kind');
    if (Object.keys(m).some(k => !['kind','textField','resourceIdField','resourceVersionField'].includes(k))) invalid('Unsupported resource mapping');
    for (const field of [m.textField,m.resourceIdField,m.resourceVersionField]) if (field !== undefined) path(field);
    if (!!m.resourceIdField !== !!m.resourceVersionField || (!m.textField && !m.resourceIdField)) invalid('Incomplete resource mapping');
    if (['image','video','file'].includes(m.kind) && !m.resourceIdField) invalid('Media requires resource identity');
  }
  if (c.migrations !== undefined) {
    if (!Array.isArray(c.migrations) || c.migrations.length > 16) invalid('Invalid migrations');
    const versions = new Set<number>();
    for (const m of c.migrations) {
      if (!object(m) || !Number.isSafeInteger(m.fromSchemaVersion) || m.fromSchemaVersion < 1 || m.fromSchemaVersion >= c.schemaVersion || versions.has(m.fromSchemaVersion)) invalid('Invalid migration source');
      versions.add(m.fromSchemaVersion);
      if (Object.keys(m).some(k => !['fromSchemaVersion','rename','defaults'].includes(k))) invalid('Unsupported migration operation');
      if (m.rename !== undefined) {
        if (!object(m.rename)) invalid('Invalid rename');
        const targets = new Set<string>();
        for (const [from,to] of Object.entries(m.rename)) {
          if (path(from).length !== 1 || path(to).length !== 1 || targets.has(to)) invalid('Migration renames must be unique top-level fields');
          targets.add(to);
        }
      }
      if (m.defaults !== undefined && !object(m.defaults)) invalid('Invalid migration defaults');
    }
  }
  return c;
}
/** Validate explicit references against the exact prompt occurrence, including boundaries. */
export function validSkillContent(content: Json): boolean {
  if (!object(content) || content.skillReferences === undefined) return true;
  const refs = content.skillReferences;
  if (!Array.isArray(refs) || refs.length > 1024 || typeof content.prompt !== 'string') return false;
  const prompt = content.prompt;
  let end = 0;
  for (const value of refs) {
    if (!object(value) || Object.keys(value).some(key => !['skillId','source','name','start','end'].includes(key))) return false;
    const ref = value as unknown as SkillReference;
    if (typeof ref.skillId !== 'string' || !ref.skillId.trim() || ref.skillId.length > 4096 || /[\x00-\x1f]/.test(ref.skillId) ||
      !['openworkgraph','codex'].includes(ref.source) || !isSkillName(ref.name) ||
      !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < end || ref.end > prompt.length ||
      prompt.slice(ref.start,ref.end) !== '$'+ref.name ||
      (ref.start > 0 && !/\s/.test(prompt[ref.start-1]!)) || (ref.end < prompt.length && !/[\s.,!?;，。！？；]/.test(prompt[ref.end]!))) return false;
    end = ref.end;
  }
  return true;
}
/** Keep explicit Codex provenance while removing host paths; re-selection is required. */
export function portableSkillContent(content: Json): Json {
  if (!object(content) || content.skillReferences === undefined) return content;
  if (!validSkillContent(content)) invalid('Invalid skill references');
  return { ...content, skillReferences: (content.skillReferences as Json[]).map(ref => object(ref) && ref.source === 'codex' ? { ...ref, skillId: 'codex-unresolved:' + ref.name } : ref) };
}
export interface PluginInformation { state: 'available' | 'missing' | 'incompatible' | 'invalid'; typeId: string; schemaVersion: number; content: Json; reason: string | null; contract: PluginContract | null }
export class PluginRegistry {
  constructor(private readonly db: DatabaseSync) {}
  /** Local control only; never call for untrusted graph import or from browser routes. */
  registerTrusted(input: unknown): PluginContract {
    const c = validateContract(input);
    if (builtins.has(c.typeId)) invalid('Built-in type cannot be replaced');
    this.db.exec('SAVEPOINT plugin_registration');
    try {
    const existing = this.db.prepare('SELECT contract FROM plugin_contracts WHERE type=?').all(c.typeId);
    if (existing.some(row => (JSON.parse(String(row['contract'])) as PluginContract).pluginId !== c.pluginId)) throw new ServiceError('CONFLICT', 'Type already owned by another plugin');
    const previous = this.db.prepare('SELECT contract FROM plugin_contracts WHERE type=? AND schema_version=?').get(c.typeId,c.schemaVersion);
    if (previous) {
      if (String(previous['contract']) === JSON.stringify(c)) { this.db.exec('RELEASE plugin_registration'); return c; }
      throw new ServiceError('CONFLICT','Registered schema versions are immutable; register a new schema version');
    }
    this.db.prepare('INSERT INTO plugin_contracts(type,schema_version,api_version,contract) VALUES (?,?,?,?)').run(c.typeId,c.schemaVersion,c.apiVersion,JSON.stringify(c));
    this.db.exec('RELEASE plugin_registration');
    return c;
    } catch (error) { this.db.exec('ROLLBACK TO plugin_registration; RELEASE plugin_registration'); throw error; }
  }
  get(type: string, schemaVersion: number): PluginContract | null {
    if (builtins.has(type)) {
      if (schemaVersion !== 1) return null;
      if(type==='group')return {typeId:type,pluginId:'core',version:'1.0.0',apiVersion:'1.0',schemaVersion:1,contentSchema:{type:'object',properties:{title:{type:'string'}},additionalProperties:false},resources:[]};
      if(type==='visualize')return {typeId:type,pluginId:'core',version:'1.0.0',apiVersion:'1.0',schemaVersion:1,contentSchema:{type:'object'},resources:[]};
      const resources: ResourceMapping[] = ['execution','preview'].includes(type) ? [] : [{kind: type as ResourceEnvelope['kind'], ...(type === 'text' ? {textField:'text'} : type === 'file' ? {resourceIdField:'resourceId',resourceVersionField:'resourceVersion'} : {textField: 'text',resourceIdField:'resourceId',resourceVersionField:'resourceVersion'})}];
      return {typeId:type,pluginId:'core',version:'1.0.0',apiVersion:'1.0',schemaVersion:1,contentSchema:{type:'object'},resources};
    }
    const row = this.db.prepare('SELECT contract FROM plugin_contracts WHERE type=? AND schema_version=?').get(type,schemaVersion);
    return row ? validateContract(JSON.parse(String(row['contract']))) : null;
  }
  inspect(type: string, schemaVersion: number, input: unknown): PluginInformation {
    const content = checkedJson(input);
    let contract: PluginContract | null;
    try { contract = this.get(type,schemaVersion); } catch { return {state:'incompatible',typeId:type,schemaVersion,content,reason:'Stored contract is incompatible',contract:null}; }
    if (!contract) return {state:'missing',typeId:type,schemaVersion,content,reason:'Resource contract is unavailable',contract:null};
    let visualizeValid = true;
    if (type === 'visualize') { try { validateVisualizeNodeContent(content); } catch { visualizeValid = false; } }
    const valid = matches(contract.contentSchema,content) && (!builtins.has(type) || validSkillContent(content)) && visualizeValid;
    return {state:valid ? 'available' : 'invalid',typeId:type,schemaVersion,content,reason:valid ? null : 'Content does not match schema',contract};
  }
  /** Pure copy-on-success migration. Caller persists new node version atomically; old version is never changed. */
  migrate(type: string, fromSchema: number, toSchema: number, input: unknown): Json {
    const original = checkedJson(input); const target = this.get(type,toSchema);
    const migration = target?.migrations?.find(m => m.fromSchemaVersion === fromSchema);
    if (!target || !migration || !object(original)) throw new ServiceError('MIGRATION_FAILED','No explicit declarative migration');
    const result = {...original};
    for (const [from,to] of Object.entries(migration.rename ?? {})) {
      if (!Object.hasOwn(original,from) || from === to) continue;
      if (Object.hasOwn(result,to)) throw new ServiceError('MIGRATION_FAILED',`Migration would overwrite ${to}; original preserved`);
      result[to] = original[from]!; delete result[from];
    }
    for (const [key,value] of Object.entries(migration.defaults ?? {})) if (!Object.hasOwn(result,key)) result[key] = value;
    if (!matches(target.contentSchema,result)) throw new ServiceError('MIGRATION_FAILED','Migrated content is invalid; original preserved');
    return checkedJson(result);
  }
}
