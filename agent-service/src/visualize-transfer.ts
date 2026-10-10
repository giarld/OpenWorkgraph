import type { BundleResource, GraphScope, Json, Node, VisualizePagePackage, VisualizeResourceReference } from '@openworkgraph/protocol';
import { collectVisualizeAssetReferences, validateVisualizeAssetReference, validateVisualizeForm, validateVisualizeNodeContent, validateVisualizePagePackage } from '@openworkgraph/protocol';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { PreparedBlob } from './blob-store.js';
import { hashBytes } from './blob-store.js';
import type { Graphs } from './graphs.js';
import type { Resources } from './resources.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { validateStoredVisualizeContent, visualizeChecked, visualizeResourceLinks } from './visualize-content.js';

export const transferResourceKey = (id: string, version: number): string => JSON.stringify([id, version]);
export type VisualizeResourceMap = Map<string, VisualizeResourceReference>;
const invalid = (message: string): never => { throw new ServiceError('INVALID_REQUEST', message); };
function mapped(reference: VisualizeResourceReference, resources: VisualizeResourceMap): VisualizeResourceReference {
  return structuredClone(resources.get(transferResourceKey(reference.resourceId, reference.resourceVersion)) ?? invalid('Missing visualize resource remapping'));
}
/** Only tagged asset descriptors change; ordinary business strings/IDs are untouched. */
export function remapVisualizeAssetData(value: Json, resources: VisualizeResourceMap): Json {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value) && value.format === 'openworkgraph.asset-reference') {
    const asset = validateVisualizeAssetReference(value);
    return asset.kind === 'resource' ? { ...asset, ...mapped(asset, resources) } : structuredClone(value);
  }
  return Array.isArray(value) ? value.map(child => remapVisualizeAssetData(child, resources)) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remapVisualizeAssetData(child, resources)]));
}
/** Only declared references and their reserved HTML URL markers are identities.
 * Schema, initial form and view-state values remain opaque business data. */
export function remapVisualizePage(page: VisualizePagePackage, resources: VisualizeResourceMap): VisualizePagePackage {
  const result = structuredClone(page);
  result.initialForm = remapVisualizeAssetData(result.initialForm, resources) as { [key: string]: Json };
  result.form.schema = remapVisualizeAssetData(result.form.schema as unknown as Json, resources) as unknown as typeof result.form.schema;
  const replacements = new Map<string, string>();
  for (const dependency of result.dependencies) if (dependency.kind === 'resource') {
    const next = mapped(dependency, resources);
    const marker = 'visualize-resource:' + encodeURIComponent(dependency.resourceId) + '@' + dependency.resourceVersion;
    replacements.set(marker, 'visualize-resource:' + encodeURIComponent(next.resourceId) + '@' + next.resourceVersion);
    Object.assign(dependency, next);
  }
  if (replacements.size) {
    const pattern = [...replacements.keys()].map(marker => Array.from(marker, character => '\\^$.*+?()[]{}|'.includes(character) ? '\\' + character : character).join('')).join('|');
    result.html = result.html.replace(new RegExp('(?:' + pattern + ')(?![0-9])', 'g'), marker => replacements.get(marker)!);
  }
  return result;
}
export function remapVisualizeContent(value: Json, resources: VisualizeResourceMap, edges?: Map<string, string>): Json {
  const content = visualizeChecked(() => validateVisualizeNodeContent(value));
  if (content.page && content.form) {
    content.page.resource = mapped(content.page.resource, resources);
    content.page.dependencies = content.page.dependencies.map(reference => mapped(reference, resources));
    content.form.resource = mapped(content.form.resource, resources);
    content.form.data = remapVisualizeAssetData(content.form.data, resources) as { [key: string]: Json };
  }
  if (edges) content.inputBindings = content.inputBindings.map(binding => ({ ...binding, edgeId: edges.get(binding.edgeId) ?? invalid('Missing visualize input edge remapping') }));
  return content as unknown as Json;
}
/** Verify portable fixed JSON before preparing any files or committing graph rows. */
export function validateVisualizeBundle(nodes: Node[], resources: BundleResource[], buffers: Buffer[]): Map<string, VisualizePagePackage> {
  const entries = new Map(resources.map((resource, index) => [transferResourceKey(resource.resourceId, resource.version), { resource, bytes: buffers[index]! }]));
  const read = (reference: VisualizeResourceReference): Json => {
    const entry = entries.get(transferResourceKey(reference.resourceId, reference.resourceVersion));
    if (!entry || entry.resource.mime !== 'application/json' || entry.bytes.length > 4_194_304 || entry.bytes.length !== entry.resource.bytes || hashBytes(entry.bytes) !== entry.resource.sha256) invalid('Invalid visualize fixed JSON resource');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry!.bytes)) as Json; }
    catch { return invalid('Invalid visualize JSON encoding'); }
  };
  const pages = new Map<string, VisualizePagePackage>();
  for (const node of nodes) if (node.type === 'visualize') {
    if (node.schemaVersion !== 1) invalid('Unsupported visualize node schema');
    const content = visualizeChecked(() => validateVisualizeNodeContent(node.content));
    if (!content.page || !content.form) continue;
    const page = visualizeChecked(() => validateVisualizePagePackage(read(content.page!.resource)));
    const references: VisualizeResourceReference[] = [];
    for (const dependency of page.dependencies) if (dependency.kind === 'resource') {
      const entry = entries.get(transferResourceKey(dependency.resourceId, dependency.resourceVersion));
      const mime = entry?.resource.mime;
      const matches = dependency.media === 'script' ? ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(mime ?? '') : dependency.media === 'style' ? mime === 'text/css' : mime?.startsWith(dependency.media + '/') || dependency.media === 'video' && mime?.startsWith('audio/');
      if (!matches) invalid('Missing visualize dependency or incompatible MIME');
      references.push({ resourceId: dependency.resourceId, resourceVersion: dependency.resourceVersion });
    }
    const unique = [...new Map(references.map(reference => [transferResourceKey(reference.resourceId, reference.resourceVersion), reference])).values()];
    for (const asset of collectVisualizeAssetReferences({ initialForm: page.initialForm, schema: page.form.schema } as unknown as Json)) if (asset.kind === 'resource') {
      if (!entries.has(transferResourceKey(asset.resourceId, asset.resourceVersion))) invalid('Missing initial form asset');
      if (!unique.some(reference => reference.resourceId === asset.resourceId && reference.resourceVersion === asset.resourceVersion)) unique.push({ resourceId: asset.resourceId, resourceVersion: asset.resourceVersion });
    }
    if (canonicalJson(unique as unknown as Json) !== canonicalJson(content.page.dependencies as unknown as Json)) invalid('Visualize package/node dependencies disagree');
    if (content.page.resource.resourceId === content.form.resource.resourceId || page.form.version !== content.form.schemaVersion) invalid('Visualize page/form identity or schema mismatch');
    const form = read(content.form.resource);
    visualizeChecked(() => validateVisualizeForm(page.form.schema, form, 'save'));
    if (canonicalJson(form) !== canonicalJson(content.form.data)) invalid('Visualize form/fixed resource mismatch');
    const pageKey = transferResourceKey(content.page.resource.resourceId, content.page.resource.resourceVersion);
    pages.set(pageKey, page);
  }
  return pages;
}
/** Prepared page bytes contain reserved identities. Resources owns blob registration;
 * move its newly created, unbound identity before exposing it, in the same transaction. */
export function commitTransferResource(resources: Resources, scope: GraphScope, blob: PreparedBlob, name: string, reservedId: string) {
  const created = resources.createCanvasFromPrepared(scope, blob, name), db = resources.db, oldId = created.resource.id;
  db.prepare('INSERT INTO canvas_resources(id,project_id,graph_id,name,current_version) SELECT ?,project_id,graph_id,name,current_version FROM canvas_resources WHERE id=?').run(reservedId, oldId);
  db.prepare('INSERT INTO canvas_resource_versions(resource_id,version,sha256,mime,representation_version) SELECT ?,version,sha256,mime,representation_version FROM canvas_resource_versions WHERE resource_id=?').run(reservedId, oldId);
  db.prepare('UPDATE canvas_resource_references SET resource_id=? WHERE id=?').run(reservedId, created.referenceId);
  db.prepare('UPDATE events SET entity_id=? WHERE entity_id=? AND graph_id=?').run(reservedId, oldId, scope.graphId);
  db.prepare('DELETE FROM canvas_resource_versions WHERE resource_id=?').run(oldId);
  db.prepare('DELETE FROM canvas_resources WHERE id=?').run(oldId);
  return resources.getCanvas(scope, reservedId);
}
/** A transferred snapshot may have evolved from its page's initial values. */
export function insertTransferredVisualizeNode(graphs: Graphs, scope: GraphScope, node: Node): void {
  graphs.insertNode(scope, node, true, { visualizeSnapshot: true });
}
/** Read and rewrite carried dependencies before the output-preservation transaction. */
export async function prepareVisualizeCopy(graphs: Graphs, resources: Resources, scope: GraphScope, node: Node, cleanups: (() => unknown)[]): Promise<() => Json> {
  const { content, page } = validateStoredVisualizeContent(graphs.db, scope, node.content);
  const links = visualizeResourceLinks(content);
  const mapping: VisualizeResourceMap = new Map(links.map(reference => [transferResourceKey(reference.resourceId, reference.resourceVersion), { resourceId: randomUUID(), resourceVersion: 1 }]));
  const plans: { blob: PreparedBlob; name: string; id: string }[] = [];
  await resources.withBlobLease(async () => {
    for (const reference of links) {
      const source = await resources.readContent(scope, 'canvas', reference.resourceId, reference.resourceVersion);
      const isPage = page && reference.resourceId === content.page!.resource.resourceId && reference.resourceVersion === content.page!.resource.resourceVersion;
      const isForm = content.form && reference.resourceId === content.form.resource.resourceId && reference.resourceVersion === content.form.resource.resourceVersion;
      const bytes = isPage ? Buffer.from(canonicalJson(remapVisualizePage(page!, mapping) as unknown as Json)) : isForm ? Buffer.from(canonicalJson(remapVisualizeAssetData(content.form!.data, mapping))) : source.bytes;
      const blob = await resources.prepareBytes(bytes, source.mime);
      cleanups.push(() => resources.discardPrepared(blob));
      plans.push({ blob, name: resources.getCanvas(scope, reference.resourceId).name, id: mapped(reference, mapping).resourceId });
    }
  });
  return () => {
    for (const plan of plans) commitTransferResource(resources, scope, plan.blob, plan.name, plan.id);
    return remapVisualizeContent(content as unknown as Json, mapping);
  };
}
/** Undo selects old immutable bytes, but subsequent edits need a fresh resource head.
 * Append an alias version; never mutate old versions or existing Run snapshots. */
export function restoreVisualizeContent(db: DatabaseSync, scope: GraphScope, nodeId: string, value: Json, previous: Json): Json {
  const { content } = validateStoredVisualizeContent(db, scope, value);
  const old = visualizeChecked(() => validateVisualizeNodeContent(previous));
  if (!content.page || !content.form || !content.state) return content as unknown as Json;
  const advance = (reference: VisualizeResourceReference): void => {
    const head = db.prepare('SELECT current_version FROM canvas_resources WHERE id=?').get(reference.resourceId)!;
    if (head['current_version'] === reference.resourceVersion) return;
    const version = Number(head['current_version']) + 1;
    db.prepare('INSERT INTO canvas_resource_versions(resource_id,version,sha256,mime,representation_version) SELECT resource_id,?,sha256,mime,representation_version FROM canvas_resource_versions WHERE resource_id=? AND version=?').run(version, reference.resourceId, reference.resourceVersion);
    db.prepare('UPDATE canvas_resources SET current_version=? WHERE id=?').run(version, reference.resourceId);
    db.prepare('INSERT INTO events(id,type,project_id,graph_id,entity_id,revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), 'canvas_resource.changed', scope.projectId, scope.graphId, reference.resourceId, version, new Date().toISOString(), JSON.stringify({ action: 'updated' }));
    reference.resourceVersion = version;
  };
  advance(content.page.resource); advance(content.form.resource);
  // An empty checkpoint has no counters; retain the high-water marks across it.
  const versions = db.prepare("SELECT coalesce(max(json_extract(content,'$.page.revision')),0) AS page,coalesce(max(json_extract(content,'$.form.version')),0) AS form,coalesce(max(json_extract(content,'$.state.version')),0) AS state FROM node_versions WHERE node_id=?").get(nodeId)!;
  const revision = Math.max(content.page.revision, old.page?.revision ?? 0, Number(versions['page'])) + 1;
  content.page.revision = revision;
  content.form.pageRevision = revision; content.form.version = Math.max(content.form.version, old.form?.version ?? 0, Number(versions['form'])) + 1;
  content.state.pageRevision = revision; content.state.version = Math.max(content.state.version, old.state?.version ?? 0, Number(versions['state'])) + 1;
  return content as unknown as Json;
}
