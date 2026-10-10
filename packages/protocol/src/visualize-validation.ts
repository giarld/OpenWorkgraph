import type { Json } from './index.js';
import {
  VISUALIZE_BRIDGE_VERSION, VISUALIZE_DEFAULT_SIZE, VISUALIZE_GENERATION_MAX_SIZE,
  VISUALIZE_PAGE_VERSION, VISUALIZE_SCHEMA_DIALECT,
} from './visualize.js';
import type { VisualizeErrorCode, VisualizeFieldError, VisualizeFormSchema, VisualizeNodeContent, VisualizePagePackage, VisualizeSize } from './visualize.js';
import { isVisualizeFeatureSelection } from './visualize.js';
import { collectVisualizeAssetReferences, isVisualizeProjectPath } from './visualize-assets.js';

export class VisualizeValidationError extends Error {
  constructor(readonly code: VisualizeErrorCode, message: string, readonly fields: VisualizeFieldError[] = []) {
    super(message); this.name = 'VisualizeValidationError';
  }
}
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(code: VisualizeErrorCode, message: string): never { throw new VisualizeValidationError(code, message); }
/** Validate before property access: reject accessors, cycles, non-JSON and sparse arrays. */
export function checkedVisualizeJson(value: unknown, maxBytes = 1_048_576, maxDepth = 32): Json {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) fail('INVALID_REQUEST', 'Invalid JSON limits');
  let bytes = 0;
  const seen = new Set<object>();
  function charge(size: number): void { bytes += size; if (bytes > maxBytes) fail('PAYLOAD_TOO_LARGE', 'JSON size limit exceeded'); }
  function visit(item: unknown, depth: number): Json {
    if (depth > maxDepth) fail('PAYLOAD_TOO_LARGE', 'JSON depth limit exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      charge(String(item).length); return item as Json;
    }
    if (typeof item === 'string') { charge(encoder.encode(JSON.stringify(item)).length); return item; }
    if (!item || typeof item !== 'object') fail('INVALID_REQUEST', 'Value is not JSON');
    if (seen.has(item)) fail('INVALID_REQUEST', 'Cyclic JSON');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('INVALID_REQUEST', 'Only plain JSON objects are supported');
    seen.add(item); charge(2);
    const result: Record<string, Json> = {};
    const list: Json[] = [];
    const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) fail('INVALID_REQUEST', 'Arrays must contain only dense JSON elements');
    for (const key of keys) {
      if (typeof key !== 'string' || unsafe.has(key)) fail('INVALID_REQUEST', 'Unsafe JSON key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) fail('INVALID_REQUEST', 'JSON accessors and hidden properties are not supported');
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      const child = visit(descriptor.value, depth + 1);
      if (array) list.push(child); else result[key] = child;
    }
    seen.delete(item); return array ? list : result;
  }
  return visit(value, 0);
}
function fields(value: Record<string, unknown>, allowed: readonly string[], code: VisualizeErrorCode = 'INVALID_REQUEST', path = '', replacements: Record<string, string> = {}): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) {
    const at = pointer(path, key);
    const replacement = own(replacements, key) ? replacements[key] : undefined;
    const suggestion = replacement ? `Replace ${key} with ${replacement}.` : `Remove ${key}.`;
    const message = `Unsupported field ${at}. Allowed fields: ${allowed.join(', ')}. ${suggestion}`;
    throw new VisualizeValidationError(code, message, [{ path: at, keyword: 'additionalProperties', message }]);
  }
}
/** Prefix nested validator feedback without changing its error code or acceptance rules. */
function atPath<T>(path: string, work: () => T): T {
  try { return work(); } catch (error) {
    if (!(error instanceof VisualizeValidationError)) throw error;
    const fields = error.fields.length ? error.fields.map(field => ({ ...field, path: path + field.path, message: field.message.replace(`Unsupported field ${field.path}.`, `Unsupported field ${path + field.path}.`) })) : [{ path, keyword: 'validation', message: error.message }];
    const message = error.message.startsWith('Unsupported field ') ? fields[0]!.message : `${path}: ${error.message}`;
    throw new VisualizeValidationError(error.code, message, fields);
  }
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function boundedString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function equal(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]!));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equal(left[key]!, right[key]!));
}
function checkSchemaTree(input: unknown, path = ''): VisualizeFormSchema {
  if (!object(input) || typeof input.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(input.type)) fail('SCHEMA_UNSUPPORTED', 'A supported schema type is required');
  fields(input, ['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'], 'SCHEMA_UNSUPPORTED', path);
  for (const key of ['title', 'description']) if (own(input, key) && (typeof input[key] !== 'string' || String(input[key]).length > 4096)) fail('SCHEMA_UNSUPPORTED', `Invalid ${key}`);
  for (const key of ['properties', 'required', 'additionalProperties']) if (own(input, key) && input.type !== 'object') fail('SCHEMA_UNSUPPORTED', `${key} requires object type`);
  if (own(input, 'properties')) {
    if (!object(input.properties)) fail('SCHEMA_UNSUPPORTED', 'Invalid properties');
    for (const [key, schema] of Object.entries(input.properties)) checkSchemaTree(schema, pointer(path + '/properties', key));
  }
  if (own(input, 'required')) {
    if (!Array.isArray(input.required) || input.required.some(key => typeof key !== 'string' || !object(input.properties) || !own(input.properties, key)) || new Set(input.required).size !== input.required.length) fail('SCHEMA_UNSUPPORTED', 'Required fields must be unique declared properties');
  }
  if (own(input, 'additionalProperties') && typeof input.additionalProperties !== 'boolean') fail('SCHEMA_UNSUPPORTED', 'Invalid additionalProperties');
  if (own(input, 'items')) {
    if (input.type !== 'array') fail('SCHEMA_UNSUPPORTED', 'items requires array type');
    checkSchemaTree(input.items, path + '/items');
  }
  if (input.type === 'array' && !own(input, 'items')) fail('SCHEMA_UNSUPPORTED', 'Arrays require an item schema');
  for (const [low, high, types] of [
    ['minimum', 'maximum', ['number', 'integer']],
    ['minLength', 'maxLength', ['string']],
    ['minItems', 'maxItems', ['array']],
  ] as const) {
    for (const key of [low, high]) if (own(input, key)) {
      if (!(types as readonly unknown[]).includes(input.type) || typeof input[key] !== 'number' || !Number.isFinite(input[key]) || low !== 'minimum' && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)) fail('SCHEMA_UNSUPPORTED', `Invalid ${key}`);
    }
    if (own(input, low) && own(input, high) && Number(input[low]) > Number(input[high])) fail('SCHEMA_UNSUPPORTED', `${low} exceeds ${high}`);
  }
  const schema = input as unknown as VisualizeFormSchema;
  if (own(input, 'enum')) {
    if (!Array.isArray(input.enum) || !input.enum.length || input.enum.length > 256) fail('SCHEMA_UNSUPPORTED', 'Invalid enum');
    const withoutEnum = { ...schema }; delete withoutEnum.enum;
    for (let index = 0; index < input.enum.length; index++) {
      const value = input.enum[index] as Json;
      if (formErrors(withoutEnum, value, true).length || input.enum.slice(0, index).some(item => equal(item as Json, value))) fail('SCHEMA_UNSUPPORTED', 'Enum values must match the schema and be unique');
    }
  }
  return schema;
}
export function validateVisualizeSchema(value: unknown): VisualizeFormSchema & { type: 'object' } {
  const schema = checkSchemaTree(checkedVisualizeJson(value, 65_536, 24));
  if (schema.type !== 'object') fail('SCHEMA_UNSUPPORTED', 'Form schema root must be an object');
  return schema as VisualizeFormSchema & { type: 'object' };
}
const pointer = (base: string, key: string): string => base + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
function formErrors(schema: VisualizeFormSchema, value: Json, required: boolean, path = '', errors: VisualizeFieldError[] = []): VisualizeFieldError[] {
  // Bound feedback independently of the data budget.
  if (errors.length >= 100) return errors;
  const issue = (keyword: string, message: string, at = path): void => { if (errors.length < 100) errors.push({ path: at, keyword, message }); };
  const match = schema.type === 'null' ? value === null : schema.type === 'object' ? object(value) :
    schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : typeof value === schema.type;
  if (!match) { issue('type', `Expected ${schema.type}`); return errors; }
  if (schema.enum && !schema.enum.some(item => equal(item, value))) issue('enum', 'Value is not an allowed choice');
  if (schema.type === 'object' && object(value)) {
    if (required) for (const key of schema.required ?? []) if (!own(value, key)) issue('required', 'Required field is missing', pointer(path, key));
    for (const [key, child] of Object.entries(value)) {
      const field = schema.properties && own(schema.properties, key) ? schema.properties[key] : undefined;
      if (field) formErrors(field, child as Json, required, pointer(path, key), errors);
      else if (schema.additionalProperties === false) issue('additionalProperties', 'Unknown field', pointer(path, key));
    }
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issue('minItems', 'Too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issue('maxItems', 'Too many items');
    value.forEach((child, index) => { if (schema.items) formErrors(schema.items, child, required, pointer(path, String(index)), errors); });
  } else if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) issue('minLength', 'String is too short');
    if (schema.maxLength !== undefined && length > schema.maxLength) issue('maxLength', 'String is too long');
  } else if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issue('minimum', 'Value is below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) issue('maximum', 'Value exceeds maximum');
  }
  return errors;
}
/** Save checks present values; execution also checks required fields recursively. */
export function validateVisualizeForm(schema: unknown, value: unknown, mode: 'save' | 'execute' = 'save'): { [key: string]: Json } {
  if (mode !== 'save' && mode !== 'execute') fail('INVALID_REQUEST', 'Invalid form validation mode');
  const validatedSchema = validateVisualizeSchema(schema);
  const data = checkedVisualizeJson(value);
  collectVisualizeAssetReferences(data);
  const errors = formErrors(validatedSchema, data, mode === 'execute');
  if (errors.length) throw new VisualizeValidationError(errors.every(error => error.keyword === 'required') ? 'FORM_REQUIRED' : 'FORM_INVALID', 'Form validation failed', errors);
  return data as { [key: string]: Json };
}
/** Manual maximum is passed by the host from its ordinary-node geometry rule. */
export function validateVisualizeSize(value: unknown, mode: 'generation' | 'manual', manualMaximum?: VisualizeSize): VisualizeSize {
  const size = checkedVisualizeJson(value, 256, 2);
  if (!object(size)) fail('INVALID_REQUEST', 'Invalid layout');
  fields(size, ['width', 'height']);
  if (mode !== 'generation' && mode !== 'manual') fail('INVALID_REQUEST', 'Invalid layout mode');
  const max = mode === 'generation' ? VISUALIZE_GENERATION_MAX_SIZE : manualMaximum;
  if (!max || ![max.width, max.height].every(number => Number.isFinite(number) && number > 0)) fail('INVALID_REQUEST', 'Manual maximum must come from ordinary-node rules');
  for (const key of ['width', 'height'] as const) {
    const axis = size[key];
    if (typeof axis !== 'number' || !Number.isFinite(axis) || axis <= 0) fail('INVALID_REQUEST', `Invalid layout ${key}`);
    if (mode === 'manual' && axis < VISUALIZE_DEFAULT_SIZE[key] || axis > max[key]) fail('INVALID_REQUEST', `Invalid layout ${key}`);
  }
  return size as unknown as VisualizeSize;
}
export function validateVisualizePagePackage(value: unknown): VisualizePagePackage {
  let page: Json;
  try { page = checkedVisualizeJson(value, 4_194_304); }
  catch (error) {
    if (error instanceof VisualizeValidationError && error.code === 'PAYLOAD_TOO_LARGE') fail('PAYLOAD_TOO_LARGE', '页面包超过 4 MiB 或结构深度上限；图片、视频等资产请使用资源引用或项目相对路径。');
    throw error;
  }
  if (!object(page)) fail('INVALID_REQUEST', 'Invalid visualize page package');
  fields(page, ['format', 'version', 'bridgeVersion', 'html', 'dependencies', 'form', 'initialForm', 'initialState', 'layout']);
  if (page.format !== 'openworkgraph.visualize-page') fail('INVALID_REQUEST', 'Invalid page format');
  if (page.version !== VISUALIZE_PAGE_VERSION || page.bridgeVersion !== VISUALIZE_BRIDGE_VERSION) fail('SCHEMA_UNSUPPORTED', 'Unsupported page or bridge version');
  if (!boundedString(page.html, 2_097_152) || !page.html.trim()) fail('INVALID_REQUEST', 'Nonempty bounded HTML is required');
  if (!object(page.form)) fail('SCHEMA_UNSUPPORTED', 'Form declaration is required');
  fields(page.form, ['dialect', 'version', 'schema'], 'SCHEMA_UNSUPPORTED', '/form');
  if (page.form.dialect !== VISUALIZE_SCHEMA_DIALECT || !positive(page.form.version)) fail('SCHEMA_UNSUPPORTED', 'Unsupported form declaration');
  const schema = page.form.schema;
  atPath('/form/schema', () => validateVisualizeSchema(schema));
  atPath('/initialForm', () => validateVisualizeForm(schema, page.initialForm, 'save'));
  if (!own(page, 'initialState')) fail('INVALID_REQUEST', 'Initial state is required');
  checkedVisualizeJson(page.initialState);
  if (own(page, 'layout')) atPath('/layout', () => validateVisualizeSize(page.layout, 'generation'));
  if (!Array.isArray(page.dependencies) || page.dependencies.length > 64) fail('INVALID_REQUEST', 'Invalid dependencies');
  const ids = new Set<string>();
  for (const [index, dependency] of page.dependencies.entries()) {
    const path = `/dependencies/${index}`;
    if (!object(dependency) || !boundedString(dependency.id, 128) || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(dependency.id) || ids.has(dependency.id) || typeof dependency.media !== 'string' || !['script', 'style', 'image', 'video'].includes(dependency.media)) fail('INVALID_REQUEST', 'Invalid dependency identity or media');
    ids.add(dependency.id);
    if (dependency.kind === 'cdn') {
      fields(dependency, ['kind', 'id', 'media', 'url', 'version', 'integrity'], 'INVALID_REQUEST', path, { resourceVersion: 'version' });
      if (!boundedString(dependency.url, 4096) || /[\\\u0000- \u007f]/.test(dependency.url) || !boundedString(dependency.version, 128) || !dependency.version.trim()) fail('INVALID_REQUEST', 'CDN URL and version are required');
      let url: URL;
      try { url = new URL(dependency.url); } catch { fail('INVALID_REQUEST', 'Invalid CDN URL'); }
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) fail('INVALID_REQUEST', 'CDN dependencies require absolute HTTPS URLs without credentials or fragments');
      if (own(dependency, 'integrity') && (typeof dependency.integrity !== 'string' || !/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(dependency.integrity))) fail('INVALID_REQUEST', 'Invalid dependency integrity');
    } else if (dependency.kind === 'resource') {
      fields(dependency, ['kind', 'id', 'media', 'resourceId', 'resourceVersion'], 'INVALID_REQUEST', path, { version: 'resourceVersion' });
      if (!boundedString(dependency.resourceId, 256) || !dependency.resourceId.trim()) atPath(path + '/resourceId', () => fail('INVALID_REQUEST', 'Use the resourceId supplied by the input snapshot.'));
      if (!positive(dependency.resourceVersion)) atPath(path + '/resourceVersion', () => fail('INVALID_REQUEST', 'resourceVersion must be a positive integer copied from the input resource version.'));
    } else if (dependency.kind === 'project-file') {
      fields(dependency, ['kind', 'id', 'media', 'relativePath', 'mode'], 'INVALID_REQUEST', path);
      if (!['image', 'video'].includes(dependency.media) || dependency.mode !== 'live' || !isVisualizeProjectPath(dependency.relativePath)) fail('INVALID_REQUEST', 'Invalid project file dependency');
    } else fail('INVALID_REQUEST', 'Unsupported dependency kind');
  }
  return page as unknown as VisualizePagePackage;
}

/** Structural validation only; the service verifies page/form resources and transitions. */
export function validateVisualizeNodeContent(value: unknown): VisualizeNodeContent {
  const content = checkedVisualizeJson(value, 2_097_152);
  if (!object(content) || typeof content.prompt !== 'string' || !Array.isArray(content.inputBindings)) fail('INVALID_REQUEST', 'Invalid visualize node content');
  fields(content, ['title', 'prompt', 'modelOverride', 'skillReferences', 'features', 'inputBindings', 'page', 'form', 'state']);
  if (own(content, 'title') && (typeof content.title !== 'string' || content.title.length > 1024)) fail('INVALID_REQUEST', 'Invalid node title');
  if (own(content, 'modelOverride')) {
    if (!object(content.modelOverride)) fail('INVALID_REQUEST', 'Invalid model override');
    fields(content.modelOverride, ['model', 'reasoningEffort'], 'INVALID_REQUEST', '/modelOverride');
    if (!boundedString(content.modelOverride.model, 512) || !(content.modelOverride.reasoningEffort === null || typeof content.modelOverride.reasoningEffort === 'string')) fail('INVALID_REQUEST', 'Invalid model override');
  }
  if (own(content, 'skillReferences') && !Array.isArray(content.skillReferences)) fail('INVALID_REQUEST', 'Invalid skill references');
  if (own(content, 'features') && (!Array.isArray(content.features) || content.features.length > 1 || content.features.some(feature => !isVisualizeFeatureSelection(feature)))) fail('INVALID_REQUEST', 'Invalid feature selection');
  if (content.inputBindings.length > 8) fail('INVALID_REQUEST', 'Too many input bindings');
  const names = new Set<string>(), edges = new Set<string>();
  for (const [index, binding] of content.inputBindings.entries()) {
    if (!object(binding)) fail('INVALID_REQUEST', 'Invalid input binding');
    fields(binding, ['name', 'edgeId'], 'INVALID_REQUEST', `/inputBindings/${index}`);
    if (!boundedString(binding.name, 128) || !binding.name.trim() || !boundedString(binding.edgeId, 128) || names.has(binding.name) || edges.has(binding.edgeId)) fail('INVALID_REQUEST', 'Invalid or duplicate input binding');
    names.add(binding.name); edges.add(binding.edgeId);
  }
  const present = ['page', 'form', 'state'].filter(key => own(content, key));
  if (!present.length) return content as unknown as VisualizeNodeContent;
  if (present.length !== 3 || !object(content.page) || !object(content.form) || !object(content.state)) fail('INVALID_REQUEST', 'Page, form and state must be saved together');
  const page = content.page, form = content.form, state = content.state;
  fields(page, ['revision', 'resource', 'dependencies'], 'INVALID_REQUEST', '/page');
  fields(form, ['pageRevision', 'schemaVersion', 'version', 'data', 'resource'], 'INVALID_REQUEST', '/form');
  fields(state, ['pageRevision', 'version', 'data'], 'INVALID_REQUEST', '/state');
  if (!positive(page.revision) || !positive(form.schemaVersion) || !positive(form.version) || !positive(state.version) || form.pageRevision !== page.revision || state.pageRevision !== page.revision || !Array.isArray(page.dependencies) || page.dependencies.length > 64 || !object(form.data) || !own(state, 'data')) fail('INVALID_REQUEST', 'Invalid visualize revisions or data');
  function resource(value: unknown, path: string): void {
    if (!object(value)) fail('INVALID_REQUEST', 'Invalid resource reference');
    fields(value, ['resourceId', 'resourceVersion'], 'INVALID_REQUEST', path, { version: 'resourceVersion' });
    if (!boundedString(value.resourceId, 256) || !value.resourceId.trim() || !positive(value.resourceVersion)) fail('INVALID_REQUEST', 'Invalid resource reference');
  }
  resource(page.resource, '/page/resource'); resource(form.resource, '/form/resource');
  const seen = new Set<string>();
  for (const [index, dependency] of page.dependencies.entries()) {
    resource(dependency, `/page/dependencies/${index}`);
    const reference = dependency as Record<string, Json>;
    const key = String(reference.resourceId) + ':' + String(reference.resourceVersion);
    if (seen.has(key)) fail('INVALID_REQUEST', 'Duplicate dependency reference');
    seen.add(key);
  }
  checkedVisualizeJson(form.data); checkedVisualizeJson(state.data);
  return content as unknown as VisualizeNodeContent;
}
