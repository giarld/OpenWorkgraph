import { isNodeBorderColor } from '../../../packages/protocol/src/node-appearance';
import { portableSkillContent } from "./project-file-mentions";
import { documentSnapshot, recordDocumentVersion, recordVisualizeInteraction, travelDocumentVersion, nextVisualizeVersions, type VersionedDocument } from './document-versions';
import { jsonByteLength, WORKGRAPH_TRANSFER_TOTAL_BYTES, WORKGRAPH_BUNDLE_MAX_BYTES } from '../../../packages/protocol/src/index';
import { previewEdgeError } from '../../../packages/protocol/src/preview';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import { randomId } from '../adapter/random';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { GraphBundle, Json, CopiedProvenance } from '../../../packages/protocol/src/index';
import { sniffResourceMime, isOpaqueResourceMime } from '../../../packages/protocol/src/resource-mime';
import { limitNodeTitleOperations } from '../../../packages/protocol/src/node-title';
import { importedGraphTitle } from '../../../packages/protocol/src/graph-title';
import { validateVisualizeNodeContent, validateVisualizePagePackage, validateVisualizeForm } from '../../../packages/protocol/src/visualize-validation';
import { collectVisualizeAssetReferences, validateVisualizeAssetReference } from '../../../packages/protocol/src/visualize-assets';
import type { VisualizeNodeContent, VisualizePagePackage, VisualizeResourceReference } from '../../../packages/protocol/src/visualize';
import { FILE_NODE_MAX_BYTES, importedNodeType } from '../domain/file-types';
import { graphPath, type GraphSnapshot, type GraphOperation, type Request } from './contracts';
import type { CanvasCreated } from './ResourcesPanel';
import { buildVisualizeToolTemplate, remapVisualizeAssetPackage, validateVisualizeAssetPackageBytes, visualizeLibraryResourceKey, VISUALIZE_LIBRARY_MAX_DECODED_BYTES } from '../../../packages/protocol/src/visualize-library';
import { validateVisualizeBridgeRequest } from '../../../packages/protocol/src/visualize-bridge';
import type { VisualizeHostContext, VisualizeBridgeResponse } from '../../../packages/protocol/src/visualize';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export const TEMPORARY_DATABASE = 'openworkgraph-temporary-canvases';
export type TemporaryResource = { name: string; blob: Blob };
export interface TemporaryProjectFileDescriptor {
  name: string;
  mime: string;
  size: number;
  read(): Promise<Uint8Array>;
}
export type TemporaryProjectFileReader = (source: { serviceId: string; projectId: string; relativePath: string }) => Promise<TemporaryProjectFileDescriptor>;
type ServiceOperation = { signature: string; result?: unknown; packageDigest?: string };
type RecordValue = VersionedDocument & { receiptBodies?: Record<string,string>; resources: Record<string, TemporaryResource>; receipts: Record<string, GraphSnapshot>; copies?: Record<string, CanvasCreated>; serviceOperations?: Record<string, ServiceOperation>; pluginRequirements?: GraphBundle['pluginRequirements']; copiedProvenance?: CopiedProvenance[] };
function rememberReceipt(record: RecordValue, key: string, signature: string, graph: GraphSnapshot) {
  (record.receiptBodies ??= {})[key] = signature;
  record.receipts[key] = structuredClone(graph);
  for (const expired of Object.keys(record.receipts).slice(0,-50)) {
    delete record.receipts[expired]; delete record.receiptBodies[expired];
  }
}
const conflict = () => Object.assign(Error(translate("The temporary Work Graph was modified in another page. Refresh and try again.")), { code: 'REVISION_CONFLICT', status: 409 });
const EXPORT_MAX_NODES = 2000;
const EXPORT_MAX_RESOURCES = 256;
const EXPORT_MAX_TOTAL_RESOURCE_BYTES = WORKGRAPH_TRANSFER_TOTAL_BYTES;
const EXPORT_MAX_BUNDLE_BYTES = WORKGRAPH_BUNDLE_MAX_BYTES;
const preservedTextMimes = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/css', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'image/svg+xml', 'application/json', 'application/xml', 'text/xml', 'text/yaml', 'text/x-yaml', 'application/yaml', 'application/x-yaml']);
const coreTypes = new Set(['text', 'image', 'document', 'video', 'file', 'preview', 'execution', 'group', 'visualize']);
const resourceKey = (reference: VisualizeResourceReference) => JSON.stringify([reference.resourceId, reference.resourceVersion]);
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonical(item))]))
  : value);
export function visualizeResourceReferences(value: unknown): VisualizeResourceReference[] {
  const content = validateVisualizeNodeContent(value);
  if (!content.page || !content.form) return [];
  const references = [content.page.resource, ...content.page.dependencies, content.form.resource, ...collectVisualizeAssetReferences({ form: content.form.data, state: content.state?.data ?? null })
    .flatMap(asset => asset.kind === 'resource' ? [{ resourceId: asset.resourceId, resourceVersion: asset.resourceVersion }] : [])];
  return [...new Map(references.map(reference => [resourceKey(reference), reference])).values()];
}
/** Only explicitly tagged assets are identities; ordinary business IDs stay intact. */
export function remapTemporaryVisualizeAssetData(value: Json, mapping: Map<string, VisualizeResourceReference>): Json {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && value.format === 'openworkgraph.asset-reference') {
    const asset = validateVisualizeAssetReference(value);
    if (asset.kind === 'project-file') return structuredClone(asset) as unknown as Json;
    const next = mapping.get(resourceKey(asset));
    if (!next) throw Error(translate('A resource referenced by the visualization node is missing.'));
    return { ...asset, ...next };
  }
  return Array.isArray(value) ? value.map(child => remapTemporaryVisualizeAssetData(child, mapping))
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapTemporaryVisualizeAssetData(child, mapping)]));
}
/** Rewrite fixed references and tagged form assets; view state stays business data. */
export function remapTemporaryVisualizeContent(value: unknown, mapping: Map<string, VisualizeResourceReference>, edges: Map<string, string>): Json {
  const content = validateVisualizeNodeContent(value);
  const mapped = (reference: VisualizeResourceReference) => {
    const next = mapping.get(resourceKey(reference));
    if (!next) throw Error(translate('A resource referenced by the visualization node is missing.'));
    return structuredClone(next);
  };
  if (content.page && content.form) {
    content.page.resource = mapped(content.page.resource);
    content.page.dependencies = content.page.dependencies.map(mapped);
    content.form.resource = mapped(content.form.resource);
    content.form.data = remapTemporaryVisualizeAssetData(content.form.data, mapping) as { [key: string]: Json };
    if (content.state) content.state.data = remapTemporaryVisualizeAssetData(content.state.data, mapping);
  }
  content.inputBindings = content.inputBindings.map(binding => {
    const edgeId = edges.get(binding.edgeId);
    if (!edgeId) throw Error(translate('A reference edge bound by the visualization node is missing.'));
    return { ...binding, edgeId };
  });
  return content as unknown as Json;
}
export function remapTemporaryVisualizePage(value: unknown, mapping: Map<string, VisualizeResourceReference>): VisualizePagePackage {
  const page = validateVisualizePagePackage(value);
  page.initialForm = remapTemporaryVisualizeAssetData(page.initialForm, mapping) as { [key: string]: Json };
  page.initialState = remapTemporaryVisualizeAssetData(page.initialState, mapping);
  page.form.schema = remapTemporaryVisualizeAssetData(page.form.schema as unknown as Json, mapping) as unknown as typeof page.form.schema;
  const markers = new Map<string, string>();
  for (const dependency of page.dependencies) if (dependency.kind === 'resource') {
    const next = mapping.get(resourceKey(dependency));
    if (!next) throw Error(translate('A resource required by the visualization page is missing.'));
    markers.set('visualize-resource:' + encodeURIComponent(dependency.resourceId) + '@' + dependency.resourceVersion,
      'visualize-resource:' + encodeURIComponent(next.resourceId) + '@' + next.resourceVersion);
    Object.assign(dependency, next);
  }
  if (markers.size) {
    const pattern = [...markers.keys()].map(marker => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    page.html = page.html.replace(new RegExp('(?:' + pattern + ')(?![0-9])', 'g'), marker => markers.get(marker)!);
  }
  return validateVisualizePagePackage(page);
}
export async function validateTemporaryVisualizeResources(nodes: GraphSnapshot['nodes'], resources: Map<string, TemporaryResource>): Promise<Map<string, VisualizePagePackage>> {
  const read = async (reference: VisualizeResourceReference) => {
    const resource = resources.get(resourceKey(reference));
    if (!resource || resource.blob.type !== 'application/json' || resource.blob.size > 4_194_304) throw Error(translate('A visualization fixed JSON resource is missing or invalid.'));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await resource.blob.arrayBuffer()));
  };
  const pages = new Map<string, VisualizePagePackage>();
  for (const node of nodes) if (node.type === 'visualize') {
    if (node.schemaVersion !== 1) throw Error(translate('Unsupported visualization node schema version.'));
    const content = validateVisualizeNodeContent(node.content);
    if (!content.page || !content.form) continue;
    const page = validateVisualizePagePackage(await read(content.page.resource));
    const references: VisualizeResourceReference[] = [];
    for (const dependency of page.dependencies) if (dependency.kind === 'resource') {
      const mime = resources.get(resourceKey(dependency))?.blob.type;
      const matches = dependency.media === 'script' ? ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(mime ?? '')
        : dependency.media === 'style' ? mime === 'text/css' : mime?.startsWith(dependency.media + '/') || dependency.media === 'video' && mime?.startsWith('audio/');
      if (!matches) throw Error(translate('A visualization page dependency is missing or has an incompatible MIME type.'));
      references.push({ resourceId: dependency.resourceId, resourceVersion: dependency.resourceVersion });
    }
    for (const asset of collectVisualizeAssetReferences({ initialForm: page.initialForm, initialState: page.initialState, schema: page.form.schema } as unknown as Json)) if (asset.kind === 'resource') {
      if (!resources.get(resourceKey(asset))) throw Error(translate('A resource required by the visualization page is missing.'));
      references.push({ resourceId: asset.resourceId, resourceVersion: asset.resourceVersion });
    }
    const unique = [...new Map(references.map(reference => [resourceKey(reference), reference])).values()];
    if (unique.length !== content.page.dependencies.length || new Set(content.page.dependencies.map(resourceKey)).size !== unique.length || unique.some(reference => !content.page!.dependencies.some(saved => resourceKey(saved) === resourceKey(reference))) || content.page.resource.resourceId === content.form.resource.resourceId || page.form.version !== content.form.schemaVersion) throw Error(translate('The visualization page and form resource contracts do not match.'));
    const data = await read(content.form.resource);
    validateVisualizeForm(page.form.schema, data, 'save');
    for (const asset of collectVisualizeAssetReferences({ form: data, state: content.state?.data ?? null })) if (asset.kind === 'resource' && !resources.get(resourceKey(asset)))
      throw Error(translate('A resource referenced by the visualization node is missing.'));
    if (canonical(data) !== canonical(content.form.data)) throw Error(translate('The visualization business form does not match its fixed resource.'));
    pages.set(resourceKey(content.page.resource), page);
  }
  return pages;
}
export function validateVisualizeConfiguration(previous: Json | undefined, next: Json): void {
  const content = validateVisualizeNodeContent(next);
  const old = previous === undefined ? undefined : validateVisualizeNodeContent(previous);
  if (previous !== undefined && ['page', 'form', 'state'].some(field => canonical(old?.[field as keyof VisualizeNodeContent] ?? null) !== canonical(content[field as keyof VisualizeNodeContent] ?? null)))
    throw Error(translate('Ordinary edits cannot replace the visualization page, business form, or view state.'));
}
/** Configuration edits compare only fields the editor owns. Runtime snapshots
 * remain authoritative even when a page saves state while a draft is open. */
export function sameVisualizeConfiguration(a: Json, b: Json): boolean {
  const configuration = (value: Json) => Object.fromEntries(Object.entries(validateVisualizeNodeContent(value)).filter(([key]) => !['page', 'form', 'state'].includes(key)));
  return canonical(configuration(a)) === canonical(configuration(b));
}
export function mergeVisualizeConfiguration(base: Json, edited: Json, current: Json): Json {
  validateVisualizeConfiguration(base, edited);
  const latest = validateVisualizeNodeContent(current);
  const merged = { ...(edited as Record<string, Json>) };
  for (const field of ['page', 'form', 'state'] as const) {
    delete merged[field];
    if (latest[field] !== undefined) merged[field] = structuredClone(latest[field]) as unknown as Json;
  }
  return merged;
}
/** Only the target's interaction saves may be reconciled during generation
 * submission. Other nodes remain inputs, and a changed page is a new source. */
export function sameVisualizeGenerationInputs(a: GraphSnapshot, b: GraphSnapshot, nodeId: string): boolean {
  const snapshot = (graph: GraphSnapshot) => ({
    serviceId: graph.serviceId, projectId: graph.projectId, graphId: graph.graphId, archived: graph.archived, trashed: graph.trashed,
    edges: graph.edges,
    nodes: graph.nodes.map(({ x, y, width, height, borderColor, contentVersion, ...node }) => node.id !== nodeId
      ? { ...node, contentVersion }
      : { ...node, content: Object.fromEntries(Object.entries(validateVisualizeNodeContent(node.content)).filter(([key]) => !['form', 'state'].includes(key))) }),
  });
  return canonical(snapshot(a)) === canonical(snapshot(b));
}
const portableMime = (bytes: Uint8Array, declared: string) => {
  const detected = sniffResourceMime(bytes);
  const mime = declared.toLowerCase();
  if (detected === 'text/plain' && preservedTextMimes.has(mime) ||
      ['text/plain', 'application/octet-stream'].includes(detected) && isOpaqueResourceMime(mime)) return mime;
  return detected;
};
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

/** Pure, atomic command reducer shared by the IndexedDB writer and tests. */
export function applyTemporaryOperations(source: GraphSnapshot, operations: GraphOperation[]): GraphSnapshot {
  operations = limitNodeTitleOperations(operations);
  const graph = structuredClone(source);
  let execution = false, layout = false;
  const node = (id: string) => {
    const value = graph.nodes.find(n => n.id === id);
    if (!value) throw Error(translate("Node not found"));
    return value;
  };
  for (const op of operations) {
    const layoutOnly = ['layout.move', 'layout.resize', 'layout.appearance', 'group.members', 'group.rename', 'graph.rename'].includes(op.type)
      || (op.type === 'node.create' && op.node.type === 'group')
      || (op.type === 'node.delete' && node(op.nodeId).type === 'group');
    execution ||= !layoutOnly;
    layout ||= layoutOnly || op.type === 'node.create' || op.type === 'node.delete';
    switch (op.type) {
      case 'node.create':
        if (op.node.borderColor !== undefined && !isNodeBorderColor(op.node.borderColor)) throw Error(translate('Invalid node border color.'));
        if (graph.nodes.some(n => n.id === op.node.id)) throw Error(translate("Node already exists"));
        if (op.node.type === 'visualize') {
          if (op.node.schemaVersion !== 1) throw Error(translate('Unsupported visualization node schema version.'));
          validateVisualizeConfiguration(undefined, op.node.content);
          if (validateVisualizeNodeContent(op.node.content).page) throw Error(translate('Visualization page snapshots require the page copy or Work Graph import flow.'));
        }
        graph.nodes.push(structuredClone(op.node)); break;
      case 'node.content': {
        const n = node(op.nodeId);
        if (n.readOnly) throw Error(translate('The node does not exist or is read-only.'));
        if (n.type === 'visualize') validateVisualizeConfiguration(n.content, op.content);
        if (n.contentVersion !== op.expectedContentVersion) throw Object.assign(conflict(), { code: 'CONTENT_CONFLICT' });
        n.content = structuredClone(op.content); n.contentVersion++; break;
      }
      case 'node.delete':
        graph.nodes = graph.nodes.filter(n => n.id !== op.nodeId);
        graph.edges = graph.edges.filter(e => e.sourceId !== op.nodeId && e.targetId !== op.nodeId);
        for (const n of graph.nodes) if (n.memberIds) n.memberIds = n.memberIds.filter(id => id !== op.nodeId);
        break;
      case 'edge.create': {
        const source = node(op.edge.sourceId), target = node(op.edge.targetId);
        if (op.edge.kind === 'execution') {
          if (source.type !== 'execution' || target.type !== 'execution' || source.id === target.id) throw Error(translate("A sequence edge can only connect two different execution nodes."));
          if (graph.edges.some(e => e.id === op.edge.id || (e.sourceId === source.id && e.targetId === target.id))) throw Error(translate("The connection already exists"));
          if (!executionOrder([...graph.edges, op.edge])) throw Error(translate("Cannot create the sequence edge because it would form a cycle."));
          graph.edges.push(structuredClone(op.edge)); break;
        }
        if (op.edge.kind !== 'reference' || source.type === 'execution' || source.type === 'group' || target.type === 'group' || source.id === target.id) throw Error(translate("This node cannot be used as a content predecessor or connection endpoint."));
        const previewError = previewEdgeError(source.type, target.type, graph.edges.filter(e => e.kind === 'reference' && e.targetId === target.id).length);
        if (previewError) throw Error(previewError);
        if (graph.edges.some(e => e.id === op.edge.id || (e.sourceId === source.id && e.targetId === target.id))) throw Error(translate("The connection already exists"));
        if (graph.edges.filter(e => e.kind === 'reference' && e.targetId === target.id).length >= 8) throw Error(translate("A node can have at most 8 direct predecessors."));
        graph.edges.push(structuredClone(op.edge)); break;
      }
      case 'edge.delete': graph.edges = graph.edges.filter(e => e.id !== op.edgeId); break;
      case 'layout.move': {
        const moves = new Map(op.positions.map(p => [p.nodeId, { x: p.x, y: p.y }]));
        for (const p of op.positions) {
          const group = node(p.nodeId);
          if (group.type === 'group') for (const id of group.memberIds ?? []) {
            const member = node(id);
            moves.set(id, { x: member.x + p.x - group.x, y: member.y + p.y - group.y });
          }
        }
        for (const [id, position] of moves) Object.assign(node(id), position);
        break;
      }
      case 'layout.appearance': {
        if (op.borderColor !== null && !isNodeBorderColor(op.borderColor)) throw Error(translate('Invalid node border color.'));
        const n = node(op.nodeId);
        if (n) { if (op.borderColor === null) delete n.borderColor; else n.borderColor = op.borderColor; }
        break;
      }
      case 'layout.resize':
        for (const s of op.sizes) {
          const n = node(s.nodeId);
          if (s.width === null) delete n.width; else n.width = s.width;
          if (s.height === null) delete n.height; else n.height = s.height;
          if (s.x !== undefined) n.x = s.x;
          if (s.y !== undefined) n.y = s.y;
        } break;
      case 'group.members': node(op.groupId).memberIds = [...op.memberIds]; break;
      case 'group.rename': node(op.groupId).content = { title: op.title }; break;
      case 'graph.rename': graph.title = op.title.trim() || translate("Untitled Work Graph"); break;
      case 'graph.archive': graph.archived = op.archived; break;
      case 'graph.trash': graph.trashed = op.trashed; break;
    }
  }
  graph.executionRevision += Number(execution);
  graph.layoutRevision += Number(layout);
  if (operations.length) graph.updatedAt = new Date().toISOString();
  return graph;
}

export class TemporaryCanvasStore {
  private database?: Promise<IDBDatabase>;
  private visualizeSessions = new Map<string, { graphId: string; nodeId: string; pageRevision: number; presentation: Pick<VisualizeHostContext, 'theme' | 'locale' | 'viewport'> }>();
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(TEMPORARY_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('canvases', { keyPath: 'graph.graphId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('canvases', mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(tx.error ?? Error(translate("The browser could not save the temporary Work Graph. Check available storage.")));
      work(tx.objectStore('canvases'), result => { value = result; });
    });
  }
  list() {
    return this.transaction<GraphSnapshot[]>('readonly', (store, done) => {
      const read = store.getAll();
      read.onsuccess = () => done((read.result as RecordValue[]).map(r => documentSnapshot(r)));
    });
  }
  async create(title = translate("Temporary Work Graph")) {
    const graph: GraphSnapshot = { serviceId: 'browser-local', projectId: 'temporary', graphId: randomId(), updatedAt: new Date().toISOString(), title, archived: false, trashed: false, executionRevision: 0, layoutRevision: 0, eventCursor: '', nodes: [], edges: [] };
    return this.transaction<GraphSnapshot>('readwrite', (store, done) => {
      graph.history = { cursor:null, canUndo:false, canRedo:false, expiresAt:null };
      store.add({ graph, resources: {}, receipts: {} } satisfies RecordValue); done(graph);
    });
  }
  async importGraph(input: unknown) {
    if (jsonByteLength(input) > EXPORT_MAX_BUNDLE_BYTES) throw Error(translate('The Work Graph file exceeds the export limit.'));
    const bundle = input as GraphBundle;
    if (!bundle || bundle.format !== 'openworkgraph.graph' || bundle.version !== 1 ||
      !bundle.graph || typeof bundle.graph.title !== 'string' || !bundle.graph.title.trim() ||
      !Array.isArray(bundle.graph.nodes) || !Array.isArray(bundle.graph.edges) || !Array.isArray(bundle.resources) ||
      !Array.isArray(bundle.pluginRequirements) || bundle.graph.nodes.length > 10000 || bundle.graph.edges.length > 90000 || bundle.resources.length > 10000)
      throw Error(translate("The Work Graph file format is invalid."));
    if (bundle.pluginRequirements.some(r => !r || typeof r.typeId !== 'string' || !Number.isInteger(r.schemaVersion) || r.schemaVersion < 1 || r.contract === undefined)) throw Error(translate("A plugin requirement is invalid."));
    const graph: GraphSnapshot = { serviceId: 'browser-local', projectId: 'temporary', graphId: randomId(),
      title: bundle.graph.title, updatedAt: new Date().toISOString(), archived: false, trashed: false, executionRevision: 0, layoutRevision: 0, eventCursor: '', nodes: [], edges: [] };
    const resources: Record<string, TemporaryResource> = Object.create(null);
    const sourceResources = new Map<string, TemporaryResource>();
    const resourceIds = new Map<string, { id: string; bytes: number; mime: string }>();
    let totalBytes = 0;
    for (const resource of bundle.resources) {
      if (!resource || typeof resource.resourceId !== 'string' || !Number.isInteger(resource.version) || resource.version < 1 || typeof resource.base64 !== 'string' || typeof resource.name !== 'string' || typeof resource.mime !== 'string') throw Error(translate("The resource format is invalid."));
      const key = JSON.stringify([resource.resourceId, resource.version]);
      if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > FILE_NODE_MAX_BYTES || (totalBytes += resource.bytes) > EXPORT_MAX_TOTAL_RESOURCE_BYTES || resource.base64.length > Math.ceil(resource.bytes / 3) * 4) throw Error(translate('The Work Graph resources exceed the export limit.'));
      if (resourceIds.has(key)) throw Error(translate("Duplicate resource."));
      const bytes = Uint8Array.from(atob(resource.base64), c => c.charCodeAt(0));
      if (bytes.length !== resource.bytes || bytesToHex(sha256(bytes)) !== resource.sha256) throw Error(translate("Resource file verification failed."));
      const mime = portableMime(bytes, resource.mime);
      const id = randomId(); resourceIds.set(key, { id, bytes: bytes.length, mime });
      resources[id] = { name: resource.name, blob: new Blob([bytes], { type: mime }) };
      sourceResources.set(key, resources[id]);
    }
    const pages = await validateTemporaryVisualizeResources(bundle.graph.nodes, sourceResources);
    const visualizeMapping = new Map([...resourceIds].map(([key, resource]) => [key, { resourceId: resource.id, resourceVersion: 1 }]));
    for (const [key, page] of pages) {
      const resource = resources[resourceIds.get(key)!.id];
      resource.blob = new Blob([JSON.stringify(remapTemporaryVisualizePage(page, visualizeMapping))], { type: 'application/json' });
    }
    for (const node of bundle.graph.nodes) if (node.type === 'visualize') {
      const content = validateVisualizeNodeContent(node.content);
      if (content.form) resources[resourceIds.get(resourceKey(content.form.resource))!.id].blob = new Blob(
        [JSON.stringify(remapTemporaryVisualizeAssetData(content.form.data, visualizeMapping))], { type: 'application/json' });
    }
    if (Object.values(resources).some(resource => resource.blob.size > FILE_NODE_MAX_BYTES) || Object.values(resources).reduce((total, resource) => total + resource.blob.size, 0) > EXPORT_MAX_TOTAL_RESOURCE_BYTES) throw Error(translate('The Work Graph resources exceed the export limit.'));
    const edgeMapping = new Map<string, string>();
    for (const edge of bundle.graph.edges) {
      if (!edge || typeof edge.id !== 'string' || edgeMapping.has(edge.id)) throw Error(translate('A Work Graph connection is invalid.'));
      edgeMapping.set(edge.id, randomId());
    }
    const remap = (value: Json, depth = 0): Json => {
      if (depth > 32) throw Error(translate("The node content is nested too deeply."));
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(v => remap(v, depth + 1));
      const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, depth + 1)]));
      if (typeof value.resourceId === 'string') {
        const resource = resourceIds.get(JSON.stringify([value.resourceId, value.resourceVersion ?? value.version]));
        if (!resource) throw Error(translate("A resource referenced by the Work Graph is missing."));
        result.resourceId = resource.id;
        result.bytes = resource.bytes;
        result.mime = resource.mime;
        if ('resourceVersion' in value) result.resourceVersion = 1;
        if ('version' in value) result.version = 1;
      }
      return result;
    };
    const ids = new Map<string, string>();
    for (const n of bundle.graph.nodes) {
      if (!n || typeof n.id !== 'string' || ids.has(n.id) || typeof n.type !== 'string' ||
        !Number.isInteger(n.schemaVersion) || n.schemaVersion < 1 || !Number.isInteger(n.contentVersion) || n.contentVersion < 1 ||
        !Number.isFinite(n.x) || !Number.isFinite(n.y) || typeof n.readOnly !== 'boolean' || n.content === undefined ||
        [n.width, n.height].some(v => v !== undefined && (!Number.isFinite(v) || v <= 0))) throw Error(translate("A Work Graph node is invalid or duplicated."));
      if (n.borderColor !== undefined && !isNodeBorderColor(n.borderColor)) throw Error(translate('Invalid node border color.'));
      ids.set(n.id, randomId());
    }
    const members = new Set<string>();
    graph.nodes = bundle.graph.nodes.map(n => {
      if (n.memberIds !== undefined && (n.type !== 'group' || !Array.isArray(n.memberIds))) throw Error(translate("A group member is invalid."));
      const memberIds = n.memberIds?.map(id => {
        if (!ids.has(id) || members.has(id) || bundle.graph.nodes.find(v => v.id === id)?.type === 'group') throw Error(translate("Group members are missing or overlapping."));
        members.add(id); return ids.get(id)!;
      });
      const portable = coreTypes.has(n.type) ? portableSkillContent(n.content) : n.content;
      return { ...n, id: ids.get(n.id)!, content: n.type === 'visualize' ? remapTemporaryVisualizeContent(portable, visualizeMapping, edgeMapping) : remap(portable), ...(memberIds ? { memberIds } : {}) };
    });
    const edges = new Set<string>(), pairs = new Set<string>(), incoming = new Map<string, number>(), deliveryTargets = new Set<string>();
    graph.edges = bundle.graph.edges.map(e => {
      const source = graph.nodes.find(n => n.id === ids.get(e?.sourceId)), target = graph.nodes.find(n => n.id === ids.get(e?.targetId));
      const pair = JSON.stringify([e?.sourceId, e?.targetId]);
      if (!e || typeof e.id !== 'string' || edges.has(e.id) || pairs.has(pair) || !source || !target || source === target || source.type === 'group' || target.type === 'group') throw Error(translate("A Work Graph connection is invalid."));
      if (e.kind === 'reference') {
        const previewError = previewEdgeError(source.type, target.type, incoming.get(target.id) ?? 0);
        if (previewError) throw Error(previewError);
        const count = (incoming.get(target.id) ?? 0) + 1; incoming.set(target.id, count);
        if (source.type === 'execution' || count > 8) throw Error(translate("A content predecessor is invalid."));
      } else if (e.kind === 'execution') {
        if (source.type !== 'execution' || target.type !== 'execution') throw Error(translate("Sequence edges can only connect execution nodes."));
      } else if (e.kind !== 'delivery' || source.type !== 'execution' || !['text','document','image','video','file','visualize'].includes(target.type) || (!target.readOnly && target.type !== 'visualize') || deliveryTargets.has(target.id)) throw Error(translate("The delivery connection is invalid."));
      if (e.kind === 'delivery') deliveryTargets.add(target.id);
      edges.add(e.id); pairs.add(pair);
      return { ...e, id: edgeMapping.get(e.id)!, sourceId: source.id, targetId: target.id };
    });
    for (const n of graph.nodes) if (n.type === 'visualize') {
      const content = validateVisualizeNodeContent(n.content);
      if (content.inputBindings.some(binding => !graph.edges.some(edge => edge.id === binding.edgeId && edge.kind === 'reference' && edge.targetId === n.id))) throw Error(translate('Visualization bindings must name incoming reference edges of the node.'));
    }
    if (!executionOrder(graph.edges)) throw Error(translate("Sequence connections cannot form a cycle."));
    // A public import copies content, never the authority of a runtime delivery.
    const copiedProvenance: CopiedProvenance[] = [];
    if (bundle.copiedProvenance !== undefined) {
      if (!Array.isArray(bundle.copiedProvenance)) throw Error(translate("The copy provenance is invalid."));
      for (const p of bundle.copiedProvenance) {
        if (!p || p.verified !== false) throw Error(translate("The copy provenance is invalid."));
        if (p.kind === 'copied-delivery' && ids.has(p.sourceId) && ids.has(p.targetId)) copiedProvenance.push({ ...p, sourceId: ids.get(p.sourceId)!, targetId: ids.get(p.targetId)! });
        else if (p.kind === 'copied-node' && ids.has(p.nodeId)) copiedProvenance.push({ ...p, nodeId: ids.get(p.nodeId)! });
        else throw Error(translate("A copy provenance node is missing."));
      }
    }
    const core = coreTypes;
    for (const node of graph.nodes) {
      node.contentVersion = 1;
      if (!core.has(node.type)) continue;
      const metadata: Record<string, Json> = {};
      if (node.content && typeof node.content === 'object' && !Array.isArray(node.content)) {
        for (const field of ['runId', 'originRunId', 'outputKey']) if (Object.hasOwn(node.content, field)) { metadata[field] = node.content[field]; delete node.content[field]; }
      }
      if (node.readOnly) metadata.sourceReadOnly = true;
      if (Object.keys(metadata).length) copiedProvenance.push({ kind: 'copied-node', nodeId: node.id, metadata, verified: false });
      node.readOnly = false;
    }
    graph.edges = graph.edges.filter(edge => {
      if (edge.kind !== 'delivery') return true;
      copiedProvenance.push({ kind: 'copied-delivery', sourceId: edge.sourceId, targetId: edge.targetId, verified: false }); return false;
    });
    return this.transaction<GraphSnapshot>('readwrite', (store, done) => {
      const read = store.getAll();
      read.onsuccess = () => {
        graph.title = importedGraphTitle(bundle.graph.title, (read.result as RecordValue[]).map(record => record.graph.title));
        store.add({ graph, resources, receipts: {}, copiedProvenance, pluginRequirements: bundle.pluginRequirements } satisfies RecordValue); done(graph);
      };
    });
  }
  private async access<T>(id: string, write: boolean, fn: (record: RecordValue) => T): Promise<T> {
    let failure: unknown;
    try {
      return await this.transaction<T>(write ? 'readwrite' : 'readonly', (store, done) => {
        const read = store.get(id);
        read.onsuccess = () => {
          try {
            if (!read.result) throw Error(translate("The temporary Work Graph does not exist."));
            const record = read.result as RecordValue;
            const result = fn(record);
            if (write) store.put(record);
            done(result);
          } catch (error) { failure = error; store.transaction.abort(); }
        };
      });
    } catch (error) { throw failure ?? error; }
  }
  upload = async (graphId: string, file: File): Promise<CanvasCreated> => {
    if (file.size > FILE_NODE_MAX_BYTES) throw Error(translate('File nodes support up to 300 MB.'));
    const id = randomId();
    return this.access(graphId, true, record => {
      record.resources[id] = { name: file.name, blob: file };
      return { resource: { id, name: file.name, current: { version: 1, mime: file.type || 'application/octet-stream', bytes: file.size } }, referenceId: id };
    });
  };
  hasRemoteDelivery(graphId: string, key: string): Promise<boolean> {
    return this.access(graphId, false, record => !!record.serviceOperations?.['remote-delivery:' + key]?.result);
  }
  async receiveRemoteDelivery(graphId: string, key: string, delivery: { node: import('../../../packages/protocol/src/index').Node; mime: string; name: string; bytes: number; sha256: string }, blob: Blob): Promise<void> {
    if (blob.size !== delivery.bytes || blob.size > FILE_NODE_MAX_BYTES || bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer()))) !== delivery.sha256) throw Error('Remote delivery content integrity check failed.');
    await this.access(graphId, true, record => {
      const identity = 'remote-delivery:' + key;
      if (record.serviceOperations?.[identity]?.result) return;
      if (record.graph.archived || record.graph.trashed) throw Error('The temporary Work Graph is read-only.');
      if (record.graph.nodes.some(node => node.id === delivery.node.id)) throw conflict();
      const resourceId = randomId();
      record.resources[resourceId] = { name: delivery.name, blob: new Blob([blob], { type: delivery.mime }) };
      const node = structuredClone(delivery.node);
      node.content = { ...node.content as Record<string, Json>, resourceId, resourceVersion: 1 };
      recordDocumentVersion(record, applyTemporaryOperations(record.graph, [{ type: 'node.create', node }]));
      (record.serviceOperations ??= {})[identity] = { signature: delivery.sha256, result: { nodeId: node.id } };
    });
  }
  readResource(graphId: string, resourceId: string, version: number) {
    return this.access(graphId, false, record => {
      if (version !== 1 || !Object.hasOwn(record.resources, resourceId)) throw Error(translate("The temporary Work Graph resource version does not exist."));
      return record.resources[resourceId];
    });
  }
  /** Persist the destination and session fingerprint before any remote side effect. */
  reserveServiceOperation(graphId: string, key: string, signature: string, guard: () => void) {
    return this.access(graphId, true, record => {
      guard();
      if (record.graph.archived || record.graph.trashed) throw Error(translate("Resources in archived or trashed Work Graphs cannot be modified."));
      record.serviceOperations ??= {};
      const prior = Object.hasOwn(record.serviceOperations, key) ? record.serviceOperations[key] : undefined;
      if (prior && prior.signature !== signature) throw Object.assign(Error(translate("The Workspace, session, or parameters of the original operation changed. Verify the original submission result first.")), { code: 'IDEMPOTENCY_CONFLICT' });
      if (!prior) Object.defineProperty(record.serviceOperations, key, { value: { signature }, enumerable: true, writable: true, configurable: true });
      return prior?.result;
    });
  }
  finishServiceOperation(graphId: string, key: string, signature: string, result: unknown, guard: () => void, resource?: TemporaryResource) {
    return this.access(graphId, true, record => {
      guard();
      const operation = record.serviceOperations?.[key];
      if (!operation || operation.signature !== signature) throw conflict();
      if (operation.result !== undefined) return operation.result;
      if (record.graph.archived || record.graph.trashed) throw Error(translate("Resources in archived or trashed Work Graphs cannot be modified."));
      if (resource) {
        const id = randomId();
        record.resources[id] = resource;
        result = { resource: { id, name: resource.name, current: { version: 1, mime: resource.blob.type, bytes: resource.blob.size } }, referenceId: id } satisfies CanvasCreated;
      }
      operation.result = result;
      return result;
    });
  }
  async exportGraph(graphId: string, readProjectFile?: TemporaryProjectFileReader): Promise<GraphBundle> {
    // Capture the graph and resource descriptors in one read transaction.
    const record = await this.access(graphId, false, value => value);
    const { title, nodes, edges } = record.graph;
    const portableNodes = nodes.map(node => { const copy = structuredClone(node); if (coreTypes.has(copy.type)) copy.content = portableSkillContent(copy.content); return copy; });
    if (portableNodes.length > EXPORT_MAX_NODES || edges.length > EXPORT_MAX_NODES * 9) throw Error(translate("The Work Graph exceeds the export limit."));
    const resourceIds = new Set(Object.keys(record.resources));
    const projectResourceIds = new Set<string>();
    const projectResources: GraphBundle['resources'] = [];
    const projectPlans: Array<{ node: typeof portableNodes[number]; relativePath: string; title: string; file: TemporaryProjectFileDescriptor }> = [];
    for (const node of portableNodes) {
      if (!node.content || typeof node.content !== 'object' || Array.isArray(node.content)) continue;
      const source = node.content.source;
      if (!source || typeof source !== 'object' || Array.isArray(source) || source.kind !== 'project-file') continue;
      if (typeof source.serviceId !== 'string' || typeof source.projectId !== 'string' || typeof source.relativePath !== 'string' || !source.relativePath) throw Error(translate("The project file source of a reference node is invalid. Work Graph export failed."));
      if (!readProjectFile) throw Error(translate("Exporting a reference node requires a connection to its source Workspace and project."));
      const file = await readProjectFile({ serviceId:source.serviceId, projectId:source.projectId, relativePath:source.relativePath });
      if (!file || typeof file.name !== 'string' || typeof file.mime !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.read !== 'function') throw Error(translate("The referenced file size could not be verified. Work Graph export failed."));
      if (file.size > FILE_NODE_MAX_BYTES) throw Error(translate("The referenced file exceeds 300 MB. Work Graph export failed."));
      projectPlans.push({ node, relativePath:source.relativePath, title:typeof node.content.title === 'string' ? node.content.title : '', file });
    }
    const links = new Map<string, number>();
    const visit = (value: Json) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && typeof value.resourceId === 'string') {
        const version = value.resourceVersion ?? value.version;
        if (version !== 1) throw Error(translate("The temporary resource version does not exist."));
        links.set(value.resourceId, version);
      }
      Object.values(value).forEach(visit);
    };
    const projectNodeIds = new Set(projectPlans.map(plan => plan.node.id));
    for (const node of portableNodes) if (!projectNodeIds.has(node.id)) {
      if (node.type === 'visualize') {
        if (node.schemaVersion !== 1) throw Error(translate('Unsupported visualization node schema version.'));
        const content = validateVisualizeNodeContent(node.content);
        if (content.inputBindings.some(binding => !edges.some(edge => edge.id === binding.edgeId && edge.kind === 'reference' && edge.targetId === node.id))) throw Error(translate('Visualization bindings must name incoming reference edges of the node.'));
        for (const reference of visualizeResourceReferences(content)) visit(reference as unknown as Json);
      } else visit(node.content);
    }
    await validateTemporaryVisualizeResources(portableNodes, new Map([...links].map(([resourceId, version]) => [JSON.stringify([resourceId, version]), record.resources[resourceId]])));
    let totalResourceBytes = 0;
    for (const [resourceId] of links) {
      const resource = record.resources[resourceId];
      if (!resource) throw Error(translate("A local resource referenced by the Work Graph is missing. No data was copied."));
      if (resource.blob.size > FILE_NODE_MAX_BYTES) throw Error(translate("A local resource exceeds 300 MB. Work Graph export failed."));
      totalResourceBytes += resource.blob.size;
    }
    for (const plan of projectPlans) totalResourceBytes += plan.file.size;
    if (links.size + projectPlans.length > EXPORT_MAX_RESOURCES || totalResourceBytes > EXPORT_MAX_TOTAL_RESOURCE_BYTES) throw Error(translate("The Work Graph resources exceed the export limit."));
    for (const plan of projectPlans) {
      const { node, relativePath, file } = plan;
      const bytes = await file.read();
      if (!(bytes instanceof Uint8Array) || bytes.length !== file.size) throw Error(translate("The referenced file changed during export. Try again."));
      const mime = portableMime(bytes, file.mime);
      const nodeType = importedNodeType(file.name, mime);
      let resourceId = 'project-file-' + node.id, suffix = 1;
      while (resourceIds.has(resourceId)) resourceId = 'project-file-' + node.id + '-' + suffix++;
      resourceIds.add(resourceId); projectResourceIds.add(resourceId);
      const resourceTitle = plan.title.trim() ? plan.title : file.name || relativePath.split('/').at(-1) || translate("Project file");
      projectResources.push({ resourceId, version:1, name:resourceTitle, mime, bytes:bytes.length, sha256:bytesToHex(sha256(bytes)), base64:base64(bytes) });
      let text = '';
      if (nodeType === 'text') {
        let decoded: string;
        try { decoded = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
        catch { throw Error(translate("The referenced text is not valid UTF-8. Work Graph export failed.")); }
        if (new TextEncoder().encode(JSON.stringify(decoded)).length <= 2 * 1024 * 1024 - 2048) text = decoded;
      }
      node.type = nodeType;
      node.content = { title:resourceTitle, text, prompt:'', resourceId, resourceVersion:1, mime, ...(nodeType === 'file' ? { bytes:bytes.length } : {}) };
    }
    const liveNodes = new Set(nodes.map(n => n.id));
    const bundle: GraphBundle = { format: 'openworkgraph.graph', version: 1, graph: { title, nodes:portableNodes, edges }, resources:projectResources, pluginRequirements: structuredClone(record.pluginRequirements ?? []),
      copiedProvenance: (record.copiedProvenance ?? []).filter(p => p.kind === 'copied-node' ? liveNodes.has(p.nodeId) : liveNodes.has(p.sourceId) && liveNodes.has(p.targetId)) };
    const core = coreTypes;
    for (const node of portableNodes) {
      if (!core.has(node.type) && !bundle.pluginRequirements.some(r => r.typeId === node.type && r.schemaVersion === node.schemaVersion))
        bundle.pluginRequirements.push({ typeId: node.type, schemaVersion: node.schemaVersion, contract: null });
    }
    for (const [resourceId, version] of links) {
      if (projectResourceIds.has(resourceId)) continue;
      const resource = record.resources[resourceId];
      if (!resource) throw Error(translate("A local resource referenced by the Work Graph is missing. No data was copied."));
      const bytes = new Uint8Array(await resource.blob.arrayBuffer());
      const mime = portableMime(bytes, resource.blob.type);
      bundle.resources.push({ resourceId, version, name: resource.name, mime, bytes: bytes.length, sha256: bytesToHex(sha256(bytes)), base64:base64(bytes) });
    }
    if (jsonByteLength(bundle) > EXPORT_MAX_BUNDLE_BYTES) throw Error(translate("The Work Graph file exceeds the export limit."));
    return bundle;
  }
  async purge(graph: GraphSnapshot, confirmTitle: string) {
    let failure: unknown;
    try {
      await this.transaction<void>('readwrite', (store, done) => {
        const read = store.get(graph.graphId);
        read.onsuccess = () => {
          try {
            const value = (read.result as RecordValue | undefined)?.graph;
            if (!value || !value.trashed || value.title !== confirmTitle) throw Error(translate("Confirm the Work Graph name in the trash before deleting it."));
            if (value.executionRevision !== graph.executionRevision || value.layoutRevision !== graph.layoutRevision) throw conflict();
            store.delete(graph.graphId); done();
          } catch (error) { failure = error; store.transaction.abort(); }
        };
      });
    } catch (error) { throw failure ?? error; }
  }
  request: Request = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    if (path === '/v1/models') throw Object.assign(Error(translate("No model Workspace is connected.")), { code: 'SERVICE_UNAVAILABLE' });
    const match = /^[/]v1[/]projects[/]temporary[/]graphs[/]([^/]+)(.*)$/.exec(path);
    if (!match) throw Object.assign(Error(translate("This operation requires a Workspace connection.")), { code: 'SERVICE_UNAVAILABLE' });
    const [, id, suffix] = match;
    if (!suffix && body === undefined) return this.access(id, false, r => documentSnapshot(r)) as Promise<T>;
    if (suffix === '/visualize-assets/install-result' && body !== undefined) {
      const command = body as { idempotencyKey: string };
      return this.access(id, false, record => {
        const prior = record.serviceOperations?.['visualize-install:' + command.idempotencyKey];
        if (!prior) return undefined;
        if (prior.signature !== JSON.stringify(command)) throw Object.assign(Error('Idempotency conflict'), { code: 'IDEMPOTENCY_CONFLICT' });
        return prior.result;
      }) as Promise<T>;
    }
    const fill = /^[/]visualize[/]([^/]+)[/]import$/.exec(suffix);
    if ((suffix === '/visualize-assets/install' || suffix === '/visualize-assets/import' || fill) && body !== undefined) {
      const command = body as { package: unknown; x: number; y: number; expectedContentVersion?: number; expectedExecutionRevision: number; expectedLayoutRevision: number; idempotencyKey: string; assertCurrent?: () => void };
      if (!command || typeof command.idempotencyKey !== 'string' || !command.idempotencyKey || (fill ? !Number.isSafeInteger(command.expectedContentVersion) || Number(command.expectedContentVersion) < 1 : !Number.isFinite(command.x) || !Number.isFinite(command.y))) throw Error(translate('Invalid visualization paste request.'));
      if (fill && ['serviceId', 'projectId', 'graphId', 'nodeId', 'x', 'y'].some(key => Object.hasOwn(command, key))) throw Error(translate('Invalid visualization paste request.'));
      const pkg = await validateVisualizeAssetPackageBytes(command.package);
      const { package: _package, assertCurrent, ...intent } = command;
      const key = (fill ? 'visualize-fill:' + fill[1] + ':' : 'visualize-install:') + command.idempotencyKey, signature = JSON.stringify(intent);
      const packageDigest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(pkg))));
      const mapping = new Map(pkg.resources.map(resource => [visualizeLibraryResourceKey(resource.resourceId, resource.version), { resourceId: randomId(), resourceVersion: 1 }]));
      const installed = remapVisualizeAssetPackage(pkg, mapping), nodeId = fill ? fill[1]! : randomId();
      const staged: Record<string, TemporaryResource> = Object.create(null);
      for (const resource of installed.resources) staged[resource.resourceId] = { name: resource.name, blob: new Blob([Uint8Array.from(atob(resource.base64), char => char.charCodeAt(0))], { type: resource.mime }) };
      const candidate: GraphSnapshot['nodes'][number] = { id: nodeId, type: 'visualize', schemaVersion: 1, contentVersion: 1, readOnly: false, x: command.x, y: command.y, width: installed.node.width, height: installed.node.height, content: { ...installed.node.content, title: installed.node.title } as unknown as Json };
      // An installation is acknowledged only when the regular reader can open it.
      visualizeResourceReferences(candidate.content);
      await validateTemporaryVisualizeResources([candidate], new Map(Object.entries(staged).map(([resourceId, resource]) => [resourceKey({ resourceId, resourceVersion: 1 }), resource])));
      return this.access(id, true, record => {
        assertCurrent?.();
        const receipt = record.serviceOperations?.[key];
        if (receipt) { if (receipt.signature !== signature || receipt.packageDigest !== packageDigest) throw Object.assign(Error('Idempotency conflict'), { code: 'IDEMPOTENCY_CONFLICT' }); return receipt.result; }
        if (record.graph.archived || record.graph.trashed) throw Object.assign(Error(translate('Archived or trashed Work Graphs are read-only.')), { code: 'READ_ONLY' });
        if (record.graph.executionRevision !== command.expectedExecutionRevision || record.graph.layoutRevision !== command.expectedLayoutRevision) throw conflict();
        const next = structuredClone(record.graph);
        if (fill) {
          const target = next.nodes.find(node => node.id === nodeId);
          if (!target || target.type !== 'visualize') throw Object.assign(Error(translate('The visualization node is unavailable.')), { code: 'NOT_FOUND' });
          if (target.readOnly) throw Object.assign(Error(translate('The node does not exist or is read-only.')), { code: 'READ_ONLY' });
          const previous = validateVisualizeNodeContent(target.content);
          if (target.contentVersion !== command.expectedContentVersion || previous.page) throw conflict();
          const versions = nextVisualizeVersions(record, nodeId), content = installed.node.content;
          target.content = { ...content, title: installed.node.title, inputBindings: previous.inputBindings,
            page: { ...content.page!, revision: versions.page },
            form: { ...content.form!, pageRevision: versions.page, version: versions.form },
            state: { ...content.state!, pageRevision: versions.page, version: versions.state },
          } as unknown as Json;
          target.contentVersion++;
        } else { next.nodes.push(candidate); next.layoutRevision++; }
        next.executionRevision++; next.updatedAt = new Date().toISOString();
        Object.assign(record.resources, staged); recordDocumentVersion(record, next);
        const result = { nodeId, snapshot: record.graph };
        (record.serviceOperations ??= {})[key] = { signature, packageDigest, result };
        return result;
      }) as Promise<T>;
    }
    const packageMatch = /^[/]visualize[/]([^/]+)[/]library-package$/.exec(suffix);
    if (packageMatch && body !== undefined) {
      const expected = body as Record<string, unknown>, record = await this.access(id, false, r => r);
      if (typeof expected.idempotencyKey !== 'string' || !expected.idempotencyKey) throw Error(translate('Resource operations require an idempotency key.'));
      const packageKey = 'visualize-package:' + expected.idempotencyKey, packageSignature = JSON.stringify(expected);
      const prior = record.serviceOperations?.[packageKey];
      if (prior) { if (prior.signature !== packageSignature) throw Object.assign(Error('Idempotency conflict'), { code: 'IDEMPOTENCY_CONFLICT' }); return prior.result as T; }
      const node = record.graph.nodes.find(item => item.id === packageMatch[1]);
      if (!node || node.readOnly || record.graph.archived || record.graph.trashed) throw Object.assign(Error(translate('The node does not exist or is read-only.')), { code: 'READ_ONLY' });
      const content = validateVisualizeNodeContent(node.content);
      if (!content.page || !content.form || !content.state) throw Error(translate('Generate an interactive page before saving it to the asset library.'));
      if (expected.expectedContentVersion !== node.contentVersion || expected.expectedPageRevision !== content.page.revision || expected.expectedFormVersion !== content.form.version || expected.expectedStateVersion !== content.state.version || expected.expectedExecutionRevision !== record.graph.executionRevision || expected.expectedLayoutRevision !== record.graph.layoutRevision) throw conflict();
      const fixedPage = record.resources[content.page.resource.resourceId];
      if (!fixedPage || fixedPage.blob.type !== 'application/json' || fixedPage.blob.size > 4_194_304) throw Error(translate('A visualization fixed JSON resource is missing or invalid.'));
      const page = validateVisualizePagePackage(JSON.parse(await fixedPage.blob.text()));
      const refs = [content.page.resource, ...page.dependencies.flatMap(dep => dep.kind === 'resource' ? [dep] : []), ...collectVisualizeAssetReferences({ schema: page.form.schema, initialForm: page.initialForm, initialState: page.initialState } as unknown as Json).flatMap(ref => ref.kind === 'resource' ? [ref] : [])];
      const resources: GraphBundle['resources'] = []; let total = 0;
      for (const ref of new Map(refs.map(ref => [resourceKey(ref), ref])).values()) {
        const resource = record.resources[ref.resourceId];
        if (!resource || ref.resourceVersion !== 1) throw Error(translate('A resource required by the visualization page is missing.'));
        total += resource.blob.size; if (total > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) throw Error(translate('Interactive content exceeds the size limit.'));
        const bytes = new Uint8Array(await resource.blob.arrayBuffer());
        resources.push({ resourceId: ref.resourceId, version: 1, name: resource.name, mime: resource.blob.type, bytes: bytes.length, sha256: bytesToHex(sha256(bytes)), base64: base64(bytes) });
      }
      const pkg = buildVisualizeToolTemplate({ node, page, resources, projectFiles: expected.projectFiles as Record<string, GraphBundle['resources'][number]> | undefined });
      return this.access(id, true, current => {
        const prior = current.serviceOperations?.[packageKey];
        if (prior) { if (prior.signature !== packageSignature) throw Object.assign(Error('Idempotency conflict'), { code: 'IDEMPOTENCY_CONFLICT' }); return prior.result; }
        if (current.graph.executionRevision !== record.graph.executionRevision || current.graph.layoutRevision !== record.graph.layoutRevision) throw conflict();
        (current.serviceOperations ??= {})[packageKey] = { signature: packageSignature, result: pkg }; return pkg;
      }) as Promise<T>;
    }
    const bridgeMatch = /^[/]visualize[/]([^/]+)[/]bridge(?:[/]([^/]+))?$/.exec(suffix);
    if (bridgeMatch) {
      const [, nodeId, sessionId] = bridgeMatch;
      if (!sessionId) {
        const stored = await this.request<import('../../../packages/protocol/src/visualize').VisualizeStoredNode>(graphPath('temporary', id) + '/visualize/' + nodeId);
        if (!stored.page) throw Error(translate('The saved interactive page is unavailable.'));
        const sessionId = randomId(); this.visualizeSessions.set(sessionId, { graphId: id, nodeId, pageRevision: stored.content.page!.revision, presentation: body as Pick<VisualizeHostContext, 'theme' | 'locale' | 'viewport'> });
        return { sessionId, nodeId } as T;
      }
      const session = this.visualizeSessions.get(sessionId);
      if (!session || session.graphId !== id || session.nodeId !== nodeId) throw Object.assign(Error('Session expired'), { code: 'SESSION_EXPIRED' });
      if (method === 'DELETE') { this.visualizeSessions.delete(sessionId); return undefined as T; }
      const request = validateVisualizeBridgeRequest(body);
      if (request.sessionId !== sessionId || request.nodeId !== nodeId) throw Object.assign(Error('Session expired'), { code: 'SESSION_EXPIRED' });
      const stored = await this.request<import('../../../packages/protocol/src/visualize').VisualizeStoredNode>(graphPath('temporary', id) + '/visualize/' + nodeId);
      const key = 'visualize-bridge:' + sessionId + ':' + request.requestId, signature = JSON.stringify(request);
      return this.access(id, request.method !== 'initialize' && request.method !== 'readInputs', record => {
        const identity = { channel: request.channel, version: request.version, sessionId, nodeId, requestId: request.requestId, type: 'response', method: request.method };
        const failure = (code: string, message: string) => ({ ...identity, ok: false, error: { code, message, retryable: false } });
        const node = record.graph.nodes.find(item => item.id === nodeId);
        if (!node) return failure('SESSION_EXPIRED', translate('Node not found'));
        const content = validateVisualizeNodeContent(node.content);
        if (!content.page || !content.form || !content.state) return failure('SESSION_EXPIRED', translate('The saved interactive page is unavailable.'));
        if (content.page.revision !== session.pageRevision) return failure('SESSION_EXPIRED', translate('The visualization page changed. Reload it before editing.'));
        const prior = record.serviceOperations?.[key];
        if (prior) return prior.signature === signature ? prior.result : failure('IDEMPOTENCY_CONFLICT', 'Idempotency conflict');
        const revisions = () => ({ pageRevision: content.page!.revision, formVersion: content.form!.version, stateVersion: content.state!.version, inputVersion: 1, executionRevision: record.graph.executionRevision, layoutRevision: record.graph.layoutRevision });
        const inputs = { version: 1, digest: bytesToHex(sha256(new TextEncoder().encode('[]'))), inputs: [] };
        if (request.method !== 'initialize' && request.expected.pageRevision !== content.page.revision) return failure('REVISION_CONFLICT', translate('The visualization page changed. Reload it before editing.'));
        if (request.method === 'initialize') return { ...identity, ok: true, result: { ...session.presentation, pageRevision: content.page.revision, form: content.form, state: content.state, inputs, inputsChanged: false, revisions: revisions(), capabilities: { readOnly: node.readOnly || record.graph.archived || record.graph.trashed, online: true, canCreateSuccessors: false, canExportAssets: false } } };
        if (request.method === 'readInputs') return content.inputBindings.length ? failure('INPUT_BLOCKED', translate('Temporary page input refresh requires converting this Work Graph to a project workspace.')) : { ...identity, ok: true, result: { inputs, inputsChanged: false } };
        if (node.readOnly || record.graph.archived || record.graph.trashed) return failure('READ_ONLY', translate('The current Work Graph is read-only.'));
        if (!['saveState', 'updateForm', 'requestLayout'].includes(request.method)) return failure('READ_ONLY', translate('Convert this Work Graph to a project workspace to create successors or export assets.'));
        if (request.expected.formVersion !== content.form.version || request.expected.stateVersion !== content.state.version || request.expected.executionRevision !== record.graph.executionRevision || request.expected.layoutRevision !== record.graph.layoutRevision) return failure('REVISION_CONFLICT', translate('The temporary Work Graph was modified in another page. Refresh and try again.'));
        const next = structuredClone(record.graph), target = next.nodes.find(item => item.id === nodeId)!;
        if (request.method === 'updateForm') validateVisualizeForm(stored.page!.form.schema, request.params.form, 'save');
        if (request.method === 'updateForm' || request.method === 'saveState') {
          const data = request.method === 'updateForm' ? request.params.form : request.params.state;
          for (const asset of collectVisualizeAssetReferences(data)) {
            if (asset.kind === 'project-file') return failure('RESOURCE_UNAVAILABLE', translate('Convert this Work Graph to a project workspace before using project file references.'));
            if (asset.resourceVersion !== 1 || !record.resources[asset.resourceId]) return failure('RESOURCE_UNAVAILABLE', translate('A resource referenced by the visualization node is missing.'));
          }
        }
        let result: unknown;
        if (request.method === 'saveState') { content.state = { ...content.state, data: request.params.state, version: content.state.version + 1 }; next.executionRevision++; }
        else if (request.method === 'updateForm') {
          content.form = { ...content.form, data: request.params.form, version: content.form.version + 1, resource: { resourceId: randomId(), resourceVersion: 1 } };
          record.resources[content.form.resource.resourceId] = { name: 'visualize-form.json', blob: new Blob([JSON.stringify(content.form.data)], { type: 'application/json' }) }; next.executionRevision++;
        } else if (request.method === 'requestLayout') { target.width = request.params.width; target.height = request.params.height; next.layoutRevision++; }
        target.content = content as unknown as Json; target.contentVersion++;
        if (request.method==='requestLayout') recordDocumentVersion(record, next);
        else recordVisualizeInteraction(record, next, nodeId);
        if (request.method === 'saveState') result = { state: content.state, revisions: revisions() };
        else if (request.method === 'updateForm') result = { form: content.form, revisions: revisions() };
        else if (request.method === 'requestLayout') result = { size: request.params, layoutRevision: record.graph.layoutRevision };
        const response = { ...identity, ok: true, result } as VisualizeBridgeResponse;
        (record.serviceOperations ??= {})[key] = { signature, result: response }; return response;
      }) as Promise<T>;
    }
    if (suffix === '/resources/import-bytes' && body !== undefined) {
      const input = body as { name: string; blob: Blob; idempotencyKey: string };
      if (!input || typeof input.name !== 'string' || !input.name.trim() || !(input.blob instanceof Blob) || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.blob.size > FILE_NODE_MAX_BYTES) throw Error(translate('The visualization copy resource is invalid or exceeds the size limit.'));
      const bytes = new Uint8Array(await input.blob.arrayBuffer()), mime = portableMime(bytes, input.blob.type);
      const signature = JSON.stringify([input.name, mime, bytesToHex(sha256(bytes))]), key = 'visualize-bytes:' + input.idempotencyKey;
      return this.access(id, true, record => {
        if (record.graph.archived || record.graph.trashed) throw Error(translate('Archived or trashed Work Graphs are read-only.'));
        if (record.copies?.[key]) {
          if (record.receiptBodies?.[key] !== signature) throw Object.assign(Error(translate('The parameters for this idempotency key changed.')), { code: 'IDEMPOTENCY_CONFLICT' });
          return record.copies[key];
        }
        const resourceId = randomId();
        record.resources[resourceId] = { name: input.name, blob: new Blob([bytes], { type: mime }) };
        (record.receiptBodies ??= {})[key] = signature;
        return (record.copies ??= {})[key] = { resource: { id: resourceId, name: input.name, current: { version: 1, mime, bytes: bytes.length } }, referenceId: resourceId };
      }) as Promise<T>;
    }
    if (suffix === '/visualize-paste' && body !== undefined) {
      const command = structuredClone(body) as { operations: GraphOperation[]; pages: { nodeId: string; page: VisualizePagePackage }[]; resources?: { resourceId: string; name: string; blob: Blob }[]; idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number };
      if (!command || typeof command.idempotencyKey !== 'string' || !command.idempotencyKey || !Array.isArray(command.operations) || !Array.isArray(command.pages) || !command.pages.length || command.pages.length > 100 || command.operations.length > 300 || jsonByteLength(command) > EXPORT_MAX_BUNDLE_BYTES) throw Error(translate('Invalid visualization paste request.'));
      if (command.resources !== undefined && (!Array.isArray(command.resources) || command.resources.length > 1000)) throw Error(translate('Invalid visualization paste request.'));
      const staged: Record<string, TemporaryResource> = Object.create(null);
      const fingerprints: unknown[] = [];
      let resourceBytes = 0;
      for (const resource of command.resources ?? []) {
        if (!resource || typeof resource.resourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(resource.resourceId) || staged[resource.resourceId] || typeof resource.name !== 'string' || !resource.name.trim() || !(resource.blob instanceof Blob) || resource.blob.size > FILE_NODE_MAX_BYTES) throw Error(translate('Invalid visualization paste request.'));
        resourceBytes += resource.blob.size;
        if (resourceBytes > WORKGRAPH_TRANSFER_TOTAL_BYTES) throw Error(translate('The Work Graph resources exceed the export limit.'));
        const bytes = new Uint8Array(await resource.blob.arrayBuffer()), mime = portableMime(bytes, resource.blob.type);
        staged[resource.resourceId] = { name: resource.name, blob: new Blob([bytes], { type: mime }) };
        fingerprints.push([resource.resourceId, resource.name, mime, bytesToHex(sha256(bytes))]);
      }
      const key = 'visualize-paste:' + command.idempotencyKey, signature = JSON.stringify(command.resources === undefined ? command : { ...command, resources: fingerprints });
      const record = await this.access(id, false, r => r);
      if (record.receipts[key]) {
        if (record.receiptBodies?.[key] !== signature) throw Object.assign(Error(translate('The parameters for this idempotency key changed.')), { code: 'IDEMPOTENCY_CONFLICT' });
        return record.receipts[key] as T;
      }
      if (Object.keys(staged).some(resourceId => record.resources[resourceId])) throw Error(translate('Invalid visualization paste request.'));
      const snapshots = new Map<string, Json>();
      for (const entry of command.pages) {
        const operation = command.operations.find(op => op.type === 'node.create' && op.node.id === entry.nodeId);
        if (!operation || operation.type !== 'node.create' || operation.node.type !== 'visualize' || operation.node.readOnly || operation.node.schemaVersion !== 1 || snapshots.has(entry.nodeId)) throw Error(translate('Invalid visualization paste request.'));
        const content = validateVisualizeNodeContent(operation.node.content), page = validateVisualizePagePackage(entry.page);
        if (!content.page || !content.form || !content.state) throw Error(translate('Invalid visualization paste request.'));
        const pageId = randomId(), formId = randomId();
        content.page.resource = { resourceId: pageId, resourceVersion: 1 };
        content.form.resource = { resourceId: formId, resourceVersion: 1 };
        staged[pageId] = { name: 'visualize-page.json', blob: new Blob([JSON.stringify(page)], { type: 'application/json' }) };
        staged[formId] = { name: 'visualize-form.json', blob: new Blob([JSON.stringify(content.form.data)], { type: 'application/json' }) };
        const resources = new Map(Object.entries({ ...record.resources, ...staged }).map(([resourceId, resource]) => [JSON.stringify([resourceId, 1]), resource]));
        await validateTemporaryVisualizeResources([{ ...operation.node, content: content as unknown as Json }], resources);
        snapshots.set(entry.nodeId, content as unknown as Json);
      }
      if (Object.values(staged).reduce((bytes, resource) => bytes + resource.blob.size, 0) > WORKGRAPH_TRANSFER_TOTAL_BYTES) throw Error(translate('The Work Graph resources exceed the export limit.'));
      return this.access(id, true, current => {
        if (current.graph.archived || current.graph.trashed) throw Error(translate('Archived or trashed Work Graphs are read-only.'));
        if (current.receipts[key]) {
          if (current.receiptBodies?.[key] !== signature) throw Object.assign(Error(translate('The parameters for this idempotency key changed.')), { code: 'IDEMPOTENCY_CONFLICT' });
          return current.receipts[key];
        }
        if (current.graph.executionRevision !== command.expectedExecutionRevision || current.graph.layoutRevision !== command.expectedLayoutRevision) throw conflict();
        if (Object.keys(staged).some(resourceId => current.resources[resourceId])) throw Error(translate('Invalid visualization paste request.'));
        const operations = command.operations.map(operation => {
          if (operation.type !== 'node.create' || !snapshots.has(operation.node.id)) return operation;
          const { page: _page, form: _form, state: _state, ...content } = operation.node.content as Record<string, Json>;
          return { ...operation, node: { ...operation.node, content } };
        });
        const next = applyTemporaryOperations(current.graph, operations);
        for (const node of next.nodes) if (snapshots.has(node.id)) node.content = snapshots.get(node.id)!;
        Object.assign(current.resources, staged);
        recordDocumentVersion(current, next);
        rememberReceipt(current, key, signature, current.graph);
        return current.graph;
      }) as Promise<T>;
    }
    const visualizeMatch = /^[/]visualize[/]([^/]+)$/.exec(suffix);
    if (visualizeMatch) {
      const record = await this.access(id, false, r => r);
      const node = record.graph.nodes.find(n => n.id === visualizeMatch[1]);
      if (!node || node.type !== 'visualize' || node.schemaVersion !== 1) throw Error(translate('Node not found'));
      if (body !== undefined || (method !== undefined && method !== 'GET')) {
        if (node.readOnly || record.graph.archived || record.graph.trashed) throw Object.assign(Error(translate('The node does not exist or is read-only.')), { code: 'READ_ONLY' });
        throw Object.assign(Error(translate('Connect a Workspace and import the temporary Work Graph before editing its visualization page.')), { code: 'TEMPORARY_SERVICE_REQUIRED' });
      }
      const content = validateVisualizeNodeContent(node.content);
      const resources = new Map(visualizeResourceReferences(content).map(reference => [resourceKey(reference), record.resources[reference.resourceId]]));
      const pages = await validateTemporaryVisualizeResources([node], resources);
      return { serviceId: record.graph.serviceId, projectId: record.graph.projectId, graphId: record.graph.graphId, nodeId: node.id, contentVersion: node.contentVersion, executionRevision: record.graph.executionRevision, layoutRevision: record.graph.layoutRevision, content, page: content.page ? pages.get(resourceKey(content.page.resource))! : null } as T;
    }
    if (suffix === '/export' && body === undefined) return this.exportGraph(id) as Promise<T>;
    if (suffix === '/permanent-delete') {
      const command = body as { expectedExecutionRevision: number; expectedLayoutRevision: number; confirmTitle: string };
      const graph = await this.access(id, false, r => r.graph);
      return await this.purge({ ...graph, executionRevision: command.expectedExecutionRevision, layoutRevision: command.expectedLayoutRevision }, command.confirmTitle) as T;
    }
    if (suffix === '/history') {
      const command = body as import('../../../packages/protocol/src/index').GraphHistoryTravel;
      if (!command || typeof command.idempotencyKey !== 'string' || !command.idempotencyKey) throw Error(translate('Invalid history direction.'));
      return this.access(id,true,record=>{
        const key = 'history:' + command.idempotencyKey;
        const signature = JSON.stringify(command);
        if (record.receipts[key]) {
          if (record.receiptBodies?.[key] !== signature) throw Object.assign(Error('Idempotency conflict'), {code:'IDEMPOTENCY_CONFLICT'});
          return record.receipts[key];
        }
        const result = travelDocumentVersion(record, command);
        rememberReceipt(record,key,signature,result);
        return result;
      }) as Promise<T>;
    }
    if (suffix === '/commands') {
      const command = body as { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; operations: GraphOperation[] };
      return this.access(id, true, record => {
        if (Object.hasOwn(record.receipts,command.idempotencyKey)) {
          const prior=record.receiptBodies?.[command.idempotencyKey];
          if (prior && prior!==JSON.stringify(command)) throw Object.assign(Error('Idempotency conflict'),{code:'IDEMPOTENCY_CONFLICT'});
          return record.receipts[command.idempotencyKey];
        }
        if (record.graph.executionRevision !== command.expectedExecutionRevision || record.graph.layoutRevision !== command.expectedLayoutRevision) throw conflict();
        const next = applyTemporaryOperations(record.graph, command.operations);
        recordDocumentVersion(record, next, command.operations.some(op=>op.type==='graph.archive'||op.type==='graph.trash'));
        rememberReceipt(record,command.idempotencyKey,JSON.stringify(command),record.graph);
        return record.graph;
      }) as Promise<T>;
    }
    if (suffix === '/resources/copy-resource') {
      const source = body as { sourceGraphId: string; resourceId: string; idempotencyKey: string };
      const resource = await this.access(source.sourceGraphId, false, r => r.resources[source.resourceId]);
      if (!resource) throw Error(translate("The original resource does not exist."));
      return this.access(id, true, record => {
        record.copies ??= {};
        if (record.copies[source.idempotencyKey]) return record.copies[source.idempotencyKey];
        const resourceId = randomId();
        record.resources[resourceId] = resource;
        return record.copies[source.idempotencyKey] = { resource: { id: resourceId, name: resource.name, current: { version: 1, mime: resource.blob.type || 'application/octet-stream', bytes: resource.blob.size } }, referenceId: resourceId };
      }) as Promise<T>;
    }
    const resourcePath = suffix.split('?')[0]!;
    const resourceMatch = /^[/]resources[/]([^/]+)[/]versions[/]1(?:[/](content|preview|representation|thumbnail))?$/.exec(resourcePath);
    if (resourceMatch && body === undefined) {
      const resource = await this.access(id, false, r => r.resources[resourceMatch[1]]);
      if (!resource) throw Error(translate("The temporary Work Graph resource does not exist."));
      if (method === 'BLOB') return resource.blob as T;
      if (resourceMatch[2] === 'representation') {
        const text = resource.blob.type.startsWith('text/') || /[.](md|markdown|txt|json|csv|xml|yaml|yml)$/i.test(resource.name);
        return { state: text ? 'ready' : 'unsupported', text: text ? await resource.blob.text() : null, reason: translate("The original file can be downloaded in this format.") } as T;
      }
      return { mime: resource.blob.type, bytes: resource.blob.size } as T;
    }
    throw Object.assign(Error(translate("This operation requires a Workspace bridge. The current Workspace does not provide a browser Work Graph execution contract yet.")), { code: 'TEMPORARY_SERVICE_REQUIRED' });
  };
  rename(graph: GraphSnapshot, title: string) {
    return this.request<GraphSnapshot>(graphPath(graph.projectId, graph.graphId) + '/commands', { idempotencyKey: randomId(), expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, operations: [{ type: 'graph.rename', title }] });
  }
}
