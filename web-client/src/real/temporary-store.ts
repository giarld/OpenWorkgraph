import { documentSnapshot, recordDocumentVersion, travelDocumentVersion, type DocumentTimeline } from './document-versions';
import { previewEdgeError } from '../../../packages/protocol/src/preview';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import { randomId } from '../adapter/random';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { GraphBundle, Json, CopiedProvenance } from '../../../packages/protocol/src/index';
import { sniffResourceMime } from '../../../packages/protocol/src/resource-mime';
import { importedGraphTitle } from '../../../packages/protocol/src/graph-title';
import { FILE_NODE_MAX_BYTES, importedNodeType } from '../domain/file-types';
import { graphPath, type GraphSnapshot, type GraphOperation, type Request } from './contracts';
import type { CanvasCreated } from './ResourcesPanel';
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
type ServiceOperation = { signature: string; result?: unknown };
type RecordValue = { graph: GraphSnapshot; timeline?: DocumentTimeline; nodeVersions?: Record<string, number>; receiptBodies?: Record<string,string>; resources: Record<string, TemporaryResource>; receipts: Record<string, GraphSnapshot>; copies?: Record<string, CanvasCreated>; serviceOperations?: Record<string, ServiceOperation>; pluginRequirements?: GraphBundle['pluginRequirements']; copiedProvenance?: CopiedProvenance[] };
function rememberReceipt(record: RecordValue, key: string, signature: string, graph: GraphSnapshot) {
  (record.receiptBodies ??= {})[key] = signature;
  record.receipts[key] = structuredClone(graph);
  for (const expired of Object.keys(record.receipts).slice(0,-50)) {
    delete record.receipts[expired]; delete record.receiptBodies[expired];
  }
}
const conflict = () => Object.assign(Error(translate("The temporary Work Graph was modified in another page. Refresh and try again.")), { code: 'REVISION_CONFLICT' });
const EXPORT_MAX_NODES = 2000;
const EXPORT_MAX_RESOURCES = 256;
const EXPORT_MAX_TOTAL_RESOURCE_BYTES = 64 * 1024 * 1024;
const EXPORT_MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
const preservedTextMimes = new Set(['text/plain', 'text/markdown', 'text/csv', 'image/svg+xml', 'application/json', 'application/xml', 'text/xml', 'text/yaml', 'text/x-yaml', 'application/yaml', 'application/x-yaml']);
const portableMime = (bytes: Uint8Array, declared: string) => {
  const detected = sniffResourceMime(bytes);
  return detected === 'text/plain' && preservedTextMimes.has(declared.toLowerCase()) ? declared.toLowerCase() : detected;
};
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

/** Pure, atomic command reducer shared by the IndexedDB writer and tests. */
export function applyTemporaryOperations(source: GraphSnapshot, operations: GraphOperation[]): GraphSnapshot {
  const graph = structuredClone(source);
  let execution = false, layout = false;
  const node = (id: string) => {
    const value = graph.nodes.find(n => n.id === id);
    if (!value) throw Error(translate("Node not found"));
    return value;
  };
  for (const op of operations) {
    const layoutOnly = ['layout.move', 'layout.resize', 'group.members', 'group.rename', 'graph.rename'].includes(op.type)
      || (op.type === 'node.create' && op.node.type === 'group')
      || (op.type === 'node.delete' && node(op.nodeId).type === 'group');
    execution ||= !layoutOnly;
    layout ||= layoutOnly || op.type === 'node.create' || op.type === 'node.delete';
    switch (op.type) {
      case 'node.create':
        if (graph.nodes.some(n => n.id === op.node.id)) throw Error(translate("Node already exists"));
        graph.nodes.push(structuredClone(op.node)); break;
      case 'node.content': {
        const n = node(op.nodeId);
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
    const resourceIds = new Map<string, { id: string; bytes: number; mime: string }>();
    for (const resource of bundle.resources) {
      if (!resource || typeof resource.resourceId !== 'string' || !Number.isInteger(resource.version) || resource.version < 1 || typeof resource.base64 !== 'string' || typeof resource.name !== 'string' || typeof resource.mime !== 'string') throw Error(translate("The resource format is invalid."));
      const key = JSON.stringify([resource.resourceId, resource.version]);
      if (resourceIds.has(key)) throw Error(translate("Duplicate resource."));
      const bytes = Uint8Array.from(atob(resource.base64), c => c.charCodeAt(0));
      if (bytes.length !== resource.bytes || bytesToHex(sha256(bytes)) !== resource.sha256) throw Error(translate("Resource file verification failed."));
      const detected = sniffResourceMime(bytes);
      const mime = detected === 'text/plain' && resource.mime.toLowerCase() === 'image/svg+xml' ? 'image/svg+xml' : detected;
      const id = randomId(); resourceIds.set(key, { id, bytes: bytes.length, mime });
      resources[id] = { name: resource.name, blob: new Blob([bytes], { type: mime }) };
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
      ids.set(n.id, randomId());
    }
    const members = new Set<string>();
    graph.nodes = bundle.graph.nodes.map(n => {
      if (n.memberIds !== undefined && (n.type !== 'group' || !Array.isArray(n.memberIds))) throw Error(translate("A group member is invalid."));
      const memberIds = n.memberIds?.map(id => {
        if (!ids.has(id) || members.has(id) || bundle.graph.nodes.find(v => v.id === id)?.type === 'group') throw Error(translate("Group members are missing or overlapping."));
        members.add(id); return ids.get(id)!;
      });
      return { ...n, id: ids.get(n.id)!, content: remap(n.content), ...(memberIds ? { memberIds } : {}) };
    });
    const edges = new Set<string>(), pairs = new Set<string>(), incoming = new Map<string, number>();
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
      } else if (e.kind !== 'delivery' || source.type !== 'execution' || !['document','image','video','file'].includes(target.type) || !target.readOnly) throw Error(translate("The delivery connection is invalid."));
      edges.add(e.id); pairs.add(pair);
      return { ...e, id: randomId(), sourceId: source.id, targetId: target.id };
    });
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
    const core = new Set(['text', 'image', 'document', 'video', 'file', 'preview', 'execution', 'group']);
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
    const id = randomId();
    return this.access(graphId, true, record => {
      record.resources[id] = { name: file.name, blob: file };
      return { resource: { id, name: file.name, current: { version: 1, mime: file.type || 'application/octet-stream', bytes: file.size } }, referenceId: id };
    });
  };
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
      if (prior && prior.signature !== signature) throw Object.assign(Error(translate("The Runtime, session, or parameters of the original operation changed. Verify the original submission result first.")), { code: 'IDEMPOTENCY_CONFLICT' });
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
    const portableNodes = nodes.map(node => structuredClone(node));
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
      if (!readProjectFile) throw Error(translate("Exporting a reference node requires a connection to its source Runtime and project."));
      const file = await readProjectFile({ serviceId:source.serviceId, projectId:source.projectId, relativePath:source.relativePath });
      if (!file || typeof file.name !== 'string' || typeof file.mime !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.read !== 'function') throw Error(translate("The referenced file size could not be verified. Work Graph export failed."));
      if (file.size > FILE_NODE_MAX_BYTES) throw Error(translate("The referenced file exceeds 50 MiB. Work Graph export failed."));
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
    for (const node of portableNodes) if (!projectNodeIds.has(node.id)) visit(node.content);
    let totalResourceBytes = 0;
    for (const [resourceId] of links) {
      const resource = record.resources[resourceId];
      if (!resource) throw Error(translate("A local resource referenced by the Work Graph is missing. No data was copied."));
      if (resource.blob.size > FILE_NODE_MAX_BYTES) throw Error(translate("A local resource exceeds 50 MiB. Work Graph export failed."));
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
    const core = new Set(['text', 'image', 'document', 'video', 'file', 'preview', 'execution', 'group']);
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
    if (new TextEncoder().encode(JSON.stringify(bundle)).length > EXPORT_MAX_BUNDLE_BYTES) throw Error(translate("The Work Graph file exceeds the export limit."));
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
    if (path === '/v1/models') throw Object.assign(Error(translate("No model Runtime is connected.")), { code: 'SERVICE_UNAVAILABLE' });
    const match = /^[/]v1[/]projects[/]temporary[/]graphs[/]([^/]+)(.*)$/.exec(path);
    if (!match) throw Object.assign(Error(translate("This operation requires a Runtime connection.")), { code: 'SERVICE_UNAVAILABLE' });
    const [, id, suffix] = match;
    if (!suffix && body === undefined) return this.access(id, false, r => documentSnapshot(r)) as Promise<T>;
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
    throw Object.assign(Error(translate("This operation requires a Runtime bridge. The current Runtime does not provide a browser Work Graph execution contract yet.")), { code: 'TEMPORARY_SERVICE_REQUIRED' });
  };
  rename(graph: GraphSnapshot, title: string) {
    return this.request<GraphSnapshot>(graphPath(graph.projectId, graph.graphId) + '/commands', { idempotencyKey: randomId(), expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, operations: [{ type: 'graph.rename', title }] });
  }
}
