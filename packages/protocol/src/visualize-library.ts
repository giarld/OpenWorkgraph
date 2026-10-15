import type { BundleResource, GraphScope, GraphSnapshot, Json, Node, Scope } from './index.js';
import type { VisualizeNodeContent, VisualizePagePackage, VisualizeResourceReference } from './visualize.js';
import { base64Bytes, bytesBase64, jsonByteLength } from './graph-binary.js';
import { validateVisualizeAssetReference, visualizeAssetUrl } from './visualize-assets.js';
import { normalizeVisualizePageLogo } from './visualize-logo.js';
import { checkedVisualizeJson, validateVisualizeForm, validateVisualizeNodeContent, validateVisualizePagePackage, validateVisualizeSize, VisualizeValidationError } from './visualize-validation.js';

export const VISUALIZE_ASSET_MIME = 'application/vnd.openworkgraph.visualize+json' as const;
export const VISUALIZE_ASSET_EXTENSION = '.owgv' as const;
const visualizeAssetSuffix = /(?:[.]owgv|[.]owvisualize[.]json)$/i;
/** Extensions only identify candidates; package validation remains mandatory. */
export function isVisualizeAssetFilename(name: string): boolean { return visualizeAssetSuffix.test(name); }
/** Always emit the dedicated extension, including when re-exporting legacy files. */
export function visualizeAssetFilename(name: string): string { return name.replace(visualizeAssetSuffix, '') + VISUALIZE_ASSET_EXTENSION; }
export const VISUALIZE_LIBRARY_FORMAT = 'openworkgraph.visualize-asset' as const;
export const VISUALIZE_LIBRARY_VERSION = 1 as const;
export const VISUALIZE_LIBRARY_MIN_VERSION = 1 as const;
export interface VisualizeCompatibility { minimumVersion: number; currentVersion: number }
export const VISUALIZE_LIBRARY_COMPATIBILITY: Readonly<VisualizeCompatibility> = Object.freeze({ minimumVersion: VISUALIZE_LIBRARY_MIN_VERSION, currentVersion: VISUALIZE_LIBRARY_VERSION });
/** File format versions are integers, independent of product and page versions. */
export function validateVisualizeAssetVersion(version: unknown, compatibility: VisualizeCompatibility = VISUALIZE_LIBRARY_COMPATIBILITY): void {
  if (!Number.isSafeInteger(compatibility.minimumVersion) || !Number.isSafeInteger(compatibility.currentVersion) || compatibility.minimumVersion < 1 || compatibility.currentVersion < compatibility.minimumVersion || !Number.isSafeInteger(version) || Number(version) < compatibility.minimumVersion || Number(version) > compatibility.currentVersion) {
    throw new VisualizeValidationError('SCHEMA_UNSUPPORTED', 'The visualization file version is unsupported by this Workspace.');
  }
}
export const VISUALIZE_LIBRARY_MAX_JSON_BYTES = 32 * 1024 * 1024;
export const VISUALIZE_LIBRARY_MAX_DECODED_BYTES = 24 * 1024 * 1024;
export const VISUALIZE_LIBRARY_MAX_RESOURCES = 256;
const encoder = new TextEncoder();

export interface VisualizeAssetPackage {
  format: typeof VISUALIZE_LIBRARY_FORMAT; version: number; title: string;
  node: { title: string; width: number; height: number; content: VisualizeNodeContent };
  inputNames: string[]; resources: BundleResource[];
}
export type VisualizeSaveToLibraryRequest = GraphScope & {
  nodeId: string; name: string; idempotencyKey: string; expectedContentVersion: number;
  expectedPageRevision: number; expectedFormVersion: number; expectedStateVersion: number;
  expectedExecutionRevision: number; expectedLayoutRevision: number;
} & ({ mode: 'new' } | { mode: 'update'; assetId: string; expectedAssetVersion: number });
export interface VisualizeAssetInstallRequest extends GraphScope {
  assetId: string; expectedAssetVersion: number; x: number; y: number; idempotencyKey: string;
  expectedExecutionRevision: number; expectedLayoutRevision: number;
}
export interface VisualizeAssetInstallResult { nodeId: string; snapshot: GraphSnapshot }
export type VisualizeAssetUploadRequest = Scope & { name: string; package: VisualizeAssetPackage; idempotencyKey: string } &
  ({ mode: 'new' } | { mode: 'update'; assetId: string; expectedAssetVersion: number });
export type VisualizeResourceMap = ReadonlyMap<string, VisualizeResourceReference>;
export const visualizeLibraryResourceKey = (id: string, version: number): string => JSON.stringify([id, version]);
function invalid(message: string): never { throw new VisualizeValidationError('INVALID_REQUEST', message); }
function limit(message: string): never { throw new VisualizeValidationError('PAYLOAD_TOO_LARGE', message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) invalid('Invalid visualize asset fields');
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }

/** Portable synchronous SHA-256 for deterministic packaging in browsers and services. */
export function sha256VisualizeLibraryBytes(bytes: Uint8Array): string {
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, bytes.length * 8);
  const w = new Uint32Array(64), rotate = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const x = w[i - 15]!, y = w[i - 2]!; w[i] = w[i - 16]! + (rotate(x,7)^rotate(x,18)^(x>>>3)) + w[i - 7]! + (rotate(y,17)^rotate(y,19)^(y>>>10)); }
    let [a,b,c,d,e,f,g,j] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + k[i]! + w[i]!) | 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
      j=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    [a,b,c,d,e,f,g,j].forEach((value, i) => { h[i] = (h[i]! + value) | 0; });
  }
  return h.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

function decode(resource: BundleResource): Uint8Array {
  if (typeof resource.base64 !== 'string' || resource.base64.length !== Math.ceil(resource.bytes / 3) * 4 ||
      /[^A-Za-z0-9+/=]/.test(resource.base64)) invalid('Invalid asset base64');
  let bytes: Uint8Array;
  try { bytes = base64Bytes(resource.base64); } catch { return invalid('Invalid asset base64'); }
  if (bytes.length !== resource.bytes || bytesBase64(bytes) !== resource.base64) invalid('Asset byte length or canonical base64 mismatch');
  return bytes;
}
function readJson(resource: BundleResource, maxBytes: number): Json {
  if (resource.mime !== 'application/json') invalid('Page and form resources must be application/json');
  if (resource.bytes > maxBytes) limit('Visualize JSON resource exceeds its budget');
  try { return checkedVisualizeJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(resource))), maxBytes); }
  catch (error) { if (error instanceof VisualizeValidationError) throw error; return invalid('Invalid visualize JSON encoding'); }
}
function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as Record<string, Json>)[key]!, (b as Record<string, Json>)[key]!));
}
/** Walk tagged refs only, including schema enums and both initial/current view state. */
function visitAssets(value: Json, work: (ref: ReturnType<typeof validateVisualizeAssetReference>) => Json): Json {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && value.format === 'openworkgraph.asset-reference') return work(validateVisualizeAssetReference(value));
  return Array.isArray(value) ? value.map(child => visitAssets(child, work)) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visitAssets(child, work)]));
}
function mapped(ref: VisualizeResourceReference, map: VisualizeResourceMap): VisualizeResourceReference {
  const result = map.get(visualizeLibraryResourceKey(ref.resourceId, ref.resourceVersion));
  if (!result || !text(result.resourceId, 256) || !Number.isSafeInteger(result.resourceVersion) || result.resourceVersion < 1) invalid('Missing or invalid visualize resource mapping');
  return { ...result };
}
/** Match complete reserved URL identities once: mapping never cascades. */
function remapHtml(html: string, replacements: ReadonlyMap<string, string>): string {
  // Pages resolve refreshed SDK input descriptors at runtime. A quoted URL
  // scheme concatenated with an input identity is code, not a fixed dependency.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => {
    const start = match.index! + match[0].indexOf('>') + 1;
    return { start, end: start + match[1]!.length };
  });
  const escaped = [...replacements.keys()].sort((a, b) => b.length - a.length).map(marker =>
    Array.from(marker, char => '^$.*+?()[]{}|'.includes(char) || char.charCodeAt(0) === 92 ? String.fromCharCode(92) + char : char).join(''));
  const declared = escaped.length ? '(?:' + escaped.join('|') + ')(?![A-Za-z0-9_.!~*()%+@-])|' : '';
  return html.replace(new RegExp(declared + 'visualize-(?:resource|project-file):', 'g'),
    (marker: string, offset: number) => {
      const replacement = replacements.get(marker);
      if (replacement !== undefined) return replacement;
      if (scripts.some(script => offset >= script.start && offset + marker.length < script.end)) {
        const quote = html[offset - 1], tail = html.slice(offset + marker.length);
        if ((quote === '"' || quote === "'") && tail.startsWith(quote) && /^\s*\+/.test(tail.slice(1)) ||
            quote === '`' && tail.startsWith('${')) return marker;
      }
      return invalid('Undeclared visualize HTML resource marker');
    });
}

/** Strict structure, byte lengths and complete closure; SHA-256 is checked separately. */
export function parseVisualizeAssetPackage(value: unknown, compatibility: VisualizeCompatibility = VISUALIZE_LIBRARY_COMPATIBILITY): VisualizeAssetPackage {
  if (typeof value === 'string') {
    if (encoder.encode(value).length > VISUALIZE_LIBRARY_MAX_JSON_BYTES) limit('Visualize asset JSON exceeds 32 MiB');
    try { value = JSON.parse(value); } catch { invalid('Invalid visualize asset JSON'); }
  }
  const clean = checkedVisualizeJson(value, VISUALIZE_LIBRARY_MAX_JSON_BYTES + 4096, 40);
  if (jsonByteLength(clean) > VISUALIZE_LIBRARY_MAX_JSON_BYTES) limit('Visualize asset JSON exceeds 32 MiB');
  if (!object(clean)) invalid('Invalid visualize asset');
  fields(clean, ['format', 'version', 'title', 'node', 'inputNames', 'resources']);
  if (clean.format !== VISUALIZE_LIBRARY_FORMAT) invalid('Invalid visualize asset format');
  validateVisualizeAssetVersion(clean.version, compatibility);
  if (!text(clean.title, 1024) || !object(clean.node)) invalid('Invalid visualize asset title or node');
  fields(clean.node, ['title', 'width', 'height', 'content']);
  if (!text(clean.node.title, 1024)) invalid('Invalid visualize node title');
  validateVisualizeSize({ width: clean.node.width, height: clean.node.height }, 'snapshot', { width: 1e9, height: 1e9 });
  if (!Array.isArray(clean.inputNames) || clean.inputNames.length > 64 || clean.inputNames.some(name => !text(name, 128)) || new Set(clean.inputNames).size !== clean.inputNames.length) invalid('Invalid visualize input names');
  const content = validateVisualizeNodeContent(clean.node.content);
  if (['modelOverride', 'agentModelOverride', 'skillReferences', 'features'].some(key => Object.hasOwn(content, key)) || content.inputBindings.length) invalid('Asset cannot carry model, skill, feature or input bindings');
  if (!content.page || !content.form || !content.state) invalid('Asset requires page, form and state');
  if ([content.page.revision, content.form.pageRevision, content.form.version, content.state.pageRevision, content.state.version].some(version => version !== 1)) invalid('Asset snapshot revisions must be 1');
  if (!Array.isArray(clean.resources)) invalid('Invalid asset resources');
  if (clean.resources.length > VISUALIZE_LIBRARY_MAX_RESOURCES) limit('Too many visualize asset resources');
  const resources = clean.resources as unknown as BundleResource[], entries = new Map<string, BundleResource>();
  let total = 0;
  for (const resource of resources) {
    if (!object(resource)) invalid('Invalid asset resource');
    fields(resource, ['resourceId', 'version', 'name', 'mime', 'bytes', 'sha256', 'base64']);
    if (!text(resource.resourceId, 256) || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(resource.resourceId) || resource.version !== 1 || entries.has(resource.resourceId) || !text(resource.name, 1024) || !text(resource.mime, 256) || !/^[a-f0-9]{64}$/.test(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) invalid('Invalid or duplicate asset resource metadata');
    total += resource.bytes; if (total > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit('Visualize asset decoded bytes exceed 24 MiB');
    decode(resource); entries.set(resource.resourceId, resource);
  }
  const used = new Set<string>();
  const requireResource = (ref: VisualizeResourceReference): BundleResource => {
    const resource = entries.get(ref.resourceId);
    if (!resource || ref.resourceVersion !== 1) invalid('Missing package-local visualize resource');
    used.add(ref.resourceId); return resource;
  };
  const page = validateVisualizePagePackage(readJson(requireResource(content.page.resource), 4_194_304));
  if (page.version !== 2 || page.form.version !== content.form.schemaVersion) invalid('Asset requires page v2 and matching schema version');
  if (content.page.resource.resourceId === content.form.resource.resourceId) invalid('Page and form must have separate identities');
  const dependencies = new Set<string>(), markers = new Map<string, string>();
  for (const dep of page.dependencies) {
    if (dep.kind === 'project-file') invalid('Project files must be frozen before packaging');
    if (dep.kind !== 'resource') continue;
    const resource = requireResource(dep), mime = resource.mime;
    const matches = dep.media === 'script' ? ['text/javascript','application/javascript','text/ecmascript','application/ecmascript'].includes(mime) : dep.media === 'style' ? mime === 'text/css' : mime.startsWith(dep.media + '/') || dep.media === 'video' && mime.startsWith('audio/');
    if (!matches) invalid('Visualize dependency MIME mismatch');
    dependencies.add(dep.resourceId); const marker = visualizeAssetUrl({ format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: dep.resourceId, resourceVersion: 1 }); markers.set(marker, marker);
  }
  for (const data of [page.form.schema, page.initialForm, page.initialState]) visitAssets(data as Json, ref => {
    if (ref.kind !== 'resource') invalid('Live project-file refs are not portable');
    requireResource(ref); dependencies.add(ref.resourceId); return ref as unknown as Json;
  });
  remapHtml(page.html, markers);
  const declared = new Set(content.page.dependencies.map(ref => { requireResource(ref); return ref.resourceId; }));
  if (declared.size !== dependencies.size || [...dependencies].some(id => !declared.has(id))) invalid('Page dependency closure does not match snapshot');
  for (const data of [content.form.data, content.state.data]) visitAssets(data, ref => {
    if (ref.kind !== 'resource') invalid('Live project-file refs are not portable');
    requireResource(ref); return ref as unknown as Json;
  });
  if (page.inputNames && !equal(page.inputNames as Json, clean.inputNames as Json)) invalid('Page and package input hints disagree');
  const form = readJson(requireResource(content.form.resource), 1_048_576);
  validateVisualizeForm(page.form.schema, content.form.data);
  if (!equal(form, content.form.data)) invalid('Form resource and snapshot disagree');
  if (used.size !== entries.size) invalid('Asset contains resources outside its closure');
  return clean as unknown as VisualizeAssetPackage;
}

/** Use before trusting/persisting bytes. Returns an isolated, fully validated package. */
export async function validateVisualizeAssetPackageBytes(value: unknown): Promise<VisualizeAssetPackage> {
  const asset = parseVisualizeAssetPackage(value);
  for (const resource of asset.resources) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(decode(resource)));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== resource.sha256) invalid('Visualize asset SHA-256 mismatch');
  }
  return asset;
}
export function readVisualizeAssetPage(asset: VisualizeAssetPackage): VisualizePagePackage {
  const parsed = parseVisualizeAssetPackage(asset), ref = parsed.node.content.page!.resource;
  return validateVisualizePagePackage(readJson(parsed.resources.find(resource => resource.resourceId === ref.resourceId)!, 4_194_304));
}
function jsonResource(resource: BundleResource, value: unknown): BundleResource {
  const bytes = encoder.encode(JSON.stringify(value));
  return { ...resource, mime: 'application/json', bytes: bytes.length, sha256: sha256VisualizeLibraryBytes(bytes), base64: bytesBase64(bytes) };
}

export interface BuildVisualizeAssetPackageInput { node: Node; page: VisualizePagePackage; resources: BundleResource[]; projectFiles?: Record<string, BundleResource> }
/** Export reusable tool defaults rather than a particular use's saved data. */
export function buildVisualizeToolTemplate(input: BuildVisualizeAssetPackageInput): VisualizeAssetPackage {
  const content = validateVisualizeNodeContent(input.node.content);
  if (!content.page || !content.form || !content.state) invalid('A saved visualize node is required');
  const page = validateVisualizePagePackage(input.page);
  const ref = content.form.resource;
  const form = jsonResource({ resourceId: ref.resourceId, version: ref.resourceVersion, name: 'visualize-form.json', mime: 'application/json', bytes: 0, sha256: '', base64: '' }, page.initialForm);
  return buildVisualizeAssetPackage({ ...input, page,
    node: { ...input.node, content: { ...content, form: { ...content.form, data: page.initialForm }, state: { ...content.state, data: page.initialState } } as unknown as Json },
    resources: [...input.resources.filter(resource => visualizeLibraryResourceKey(resource.resourceId, resource.version) !== visualizeLibraryResourceKey(ref.resourceId, ref.resourceVersion)), form],
  });
}
/** No I/O or IDs from the source graph survive in structural identity fields. */
export function buildVisualizeAssetPackage(input: BuildVisualizeAssetPackageInput): VisualizeAssetPackage {
  const node = input.node;
  if (node.type !== 'visualize' || node.schemaVersion !== 1) invalid('A visualize node is required');
  const content = validateVisualizeNodeContent(node.content);
  if (!content.page || !content.form || !content.state) invalid('A saved visualize node is required');
  const page = validateVisualizePagePackage(normalizeVisualizePageLogo(checkedVisualizeJson(input.page, 4_194_304)).page);
  const sources = new Map<string, BundleResource>();
  for (const resource of input.resources) {
    const key = visualizeLibraryResourceKey(resource.resourceId, resource.version);
    if (sources.has(key)) invalid('Duplicate source resource'); sources.set(key, resource);
  }
  const mapping = new Map<string, VisualizeResourceReference>(), selected: BundleResource[] = [];
  let decodedBytes = 0;
  const take = (ref: VisualizeResourceReference): VisualizeResourceReference => {
    const key = visualizeLibraryResourceKey(ref.resourceId, ref.resourceVersion), previous = mapping.get(key);
    if (previous) return previous;
    const resource = sources.get(key); if (!resource) invalid('Missing source resource for asset closure');
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit('Invalid or oversized source resource');
    decodedBytes += resource.bytes;
    if (decodedBytes > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) limit('Source resource total exceeds 24 MiB');
    if (sha256VisualizeLibraryBytes(decode(resource)) !== resource.sha256) invalid('Source SHA-256 mismatch');
    const next = { resourceId: 'r' + (selected.length + 1), resourceVersion: 1 };
    mapping.set(key, next); selected.push({ ...resource, resourceId: next.resourceId, version: 1 });
    if (selected.length > VISUALIZE_LIBRARY_MAX_RESOURCES) limit('Too many resources');
    return next;
  };
  const originalPageRef = content.page.resource, originalFormRef = content.form.resource;
  const pageRef = take(originalPageRef), formRef = take(originalFormRef);
  if (pageRef.resourceId === formRef.resourceId) invalid('Page and form must have separate identities');
  const sourcePage = readJson(sources.get(visualizeLibraryResourceKey(originalPageRef.resourceId, originalPageRef.resourceVersion))!, 4_194_304);
  const sourceForm = readJson(sources.get(visualizeLibraryResourceKey(originalFormRef.resourceId, originalFormRef.resourceVersion))!, 1_048_576);
  if (!equal(normalizeVisualizePageLogo(sourcePage).page as unknown as Json, page as unknown as Json) ||
      !equal(sourceForm, content.form.data) || content.form.schemaVersion !== page.form.version) invalid('Source page/form snapshot mismatch');
  const project = (relativePath: string): VisualizeResourceReference => {
    const resource = input.projectFiles && Object.hasOwn(input.projectFiles, relativePath) ? input.projectFiles[relativePath] : undefined;
    if (!resource) invalid('Project file must be frozen before packaging: ' + relativePath);
    const key = visualizeLibraryResourceKey(resource.resourceId, resource.version);
    const existing = sources.get(key);
    if (existing && !equal(existing as unknown as Json, resource as unknown as Json)) invalid('Conflicting frozen project file identity');
    sources.set(key, resource); return take({ resourceId: resource.resourceId, resourceVersion: resource.version });
  };
  const dependencies = new Map<string, VisualizeResourceReference>(), replacements = new Map<string, string>();
  const remember = (ref: VisualizeResourceReference): VisualizeResourceReference => { dependencies.set(ref.resourceId, ref); return ref; };
  const assetData = (value: Json, pageDependency = true): Json => visitAssets(value, ref => {
    const next = ref.kind === 'resource' ? take(ref) : project(ref.relativePath);
    return { format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', ...(pageDependency ? remember(next) : next) };
  });
  page.dependencies = page.dependencies.map(dep => {
    if (dep.kind === 'cdn') return dep;
    const next = remember(dep.kind === 'resource' ? take(dep) : project(dep.relativePath));
    const oldMarker = dep.kind === 'resource' ? visualizeAssetUrl({ format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: dep.resourceId, resourceVersion: dep.resourceVersion }) : 'visualize-project-file:' + encodeURIComponent(dep.relativePath);
    replacements.set(oldMarker, 'visualize-resource:' + encodeURIComponent(next.resourceId) + '@1');
    return { kind: 'resource', id: dep.id, media: dep.media, ...next };
  });
  page.form.schema = assetData(page.form.schema as unknown as Json) as unknown as typeof page.form.schema;
  page.initialForm = assetData(page.initialForm) as typeof page.initialForm; page.initialState = assetData(page.initialState);
  page.html = remapHtml(page.html, replacements);
  const formData = assetData(content.form.data, false) as typeof content.form.data, stateData = assetData(content.state.data, false);
  const inputNames = [...new Set([...(page.inputNames ?? []), ...content.inputBindings.map(binding => binding.name)])];
  page.inputNames = inputNames;
  const nextContent: VisualizeNodeContent = { prompt: content.prompt, ...(content.title === undefined ? {} : { title: content.title }), inputBindings: [],
    page: { revision: 1, resource: pageRef, dependencies: [...dependencies.values()] },
    form: { pageRevision: 1, schemaVersion: page.form.version, version: 1, data: formData, resource: formRef },
    state: { pageRevision: 1, version: 1, data: stateData } };
  const title = content.title?.trim() || 'Interactive visualization';
  const resources = selected.map(resource => resource.resourceId === pageRef.resourceId ? jsonResource(resource, page) : resource.resourceId === formRef.resourceId ? jsonResource(resource, formData) : resource);
  return parseVisualizeAssetPackage({ format: VISUALIZE_LIBRARY_FORMAT, version: 1, title, node: { title, width: node.width ?? 480, height: node.height ?? 360, content: nextContent }, inputNames, resources });
}

/** Prepare independent destination identities/bytes; the host commits them atomically. */
export function remapVisualizeAssetPackage(value: VisualizeAssetPackage, resources: VisualizeResourceMap): { node: VisualizeAssetPackage['node']; page: VisualizePagePackage; resources: BundleResource[]; inputNames: string[] } {
  const asset = parseVisualizeAssetPackage(value), content = asset.node.content, page = readVisualizeAssetPage(asset);
  page.inputNames = [...asset.inputNames];
  const targets = new Set<string>();
  for (const resource of asset.resources) {
    const next = mapped({ resourceId: resource.resourceId, resourceVersion: 1 }, resources);
    if (next.resourceVersion !== 1 || targets.has(next.resourceId)) invalid('Install requires distinct new resources at version 1'); targets.add(next.resourceId);
  }
  const data = (value: Json): Json => visitAssets(value, ref => { if (ref.kind !== 'resource') invalid('Live asset ref'); return { ...ref, ...mapped(ref, resources) }; });
  const replacements = new Map<string, string>();
  for (const dep of page.dependencies) if (dep.kind === 'resource') {
    const next = mapped(dep, resources); replacements.set('visualize-resource:' + encodeURIComponent(dep.resourceId) + '@1', 'visualize-resource:' + encodeURIComponent(next.resourceId) + '@1'); Object.assign(dep, next);
  }
  page.html = remapHtml(page.html, replacements);
  page.form.schema = data(page.form.schema as unknown as Json) as unknown as typeof page.form.schema;
  page.initialForm = data(page.initialForm) as typeof page.initialForm; page.initialState = data(page.initialState);
  const oldPage = content.page!.resource.resourceId, oldForm = content.form!.resource.resourceId;
  content.page!.resource = mapped(content.page!.resource, resources); content.page!.dependencies = content.page!.dependencies.map(ref => mapped(ref, resources));
  content.form!.resource = mapped(content.form!.resource, resources); content.form!.data = data(content.form!.data) as { [key: string]: Json }; content.state!.data = data(content.state!.data);
  const carried = asset.resources.map(resource => {
    const next = { ...resource, resourceId: mapped({ resourceId: resource.resourceId, resourceVersion: 1 }, resources).resourceId };
    return resource.resourceId === oldPage ? jsonResource(next, page) : resource.resourceId === oldForm ? jsonResource(next, content.form!.data) : next;
  });
  validateVisualizeNodeContent(content); validateVisualizePagePackage(page);
  if (carried.reduce((sum, resource) => sum + resource.bytes, 0) > VISUALIZE_LIBRARY_MAX_DECODED_BYTES ||
      jsonByteLength({ ...asset, resources: carried }) > VISUALIZE_LIBRARY_MAX_JSON_BYTES) limit('Remapped visualize asset exceeds its budget');
  return { node: asset.node, page, resources: carried, inputNames: asset.inputNames };
}
