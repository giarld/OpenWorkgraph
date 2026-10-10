import type { DatabaseSync } from 'node:sqlite';
import type { GraphScope, Json, VisualizeNodeContent, VisualizePagePackage, VisualizeResourceReference } from '@openworkgraph/protocol';
import { collectVisualizeAssetReferences, validateVisualizeForm, validateVisualizeNodeContent, validateVisualizePagePackage, VisualizeValidationError } from '@openworkgraph/protocol';
import type { ProjectFileInput, ResourceEnvelope } from '@openworkgraph/protocol';
import { classifyProjectFile, ProjectFiles } from './project-files.js';
import { ServiceError } from './errors.js';
import { hashBytes } from './blob-store.js';
import { canonicalJson } from './persistence/repositories.js';

export function visualizeChecked<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (!(error instanceof VisualizeValidationError)) throw error;
    const code = error.code === 'PAYLOAD_TOO_LARGE' || error.code === 'SCHEMA_UNSUPPORTED' ? error.code : 'INVALID_REQUEST';
    throw new ServiceError(code, error.message, { details: { visualizeCode: error.code, fields: error.fields as unknown as Json } });
  }
}
export function visualizeResourceLinks(content: VisualizeNodeContent): VisualizeResourceReference[] {
  const references = content.page && content.form ? [content.page.resource, ...content.page.dependencies, content.form.resource] : [];
  if (content.form) for (const asset of collectVisualizeAssetReferences(content.form.data)) if (asset.kind === 'resource') references.push({ resourceId: asset.resourceId, resourceVersion: asset.resourceVersion });
  return [...new Map(references.map(reference => [reference.resourceId + ':' + reference.resourceVersion, reference])).values()];
}
/** Tagged form assets become actual accepted Run inputs, never guessed from strings. */
export function resolveVisualizeFormAssets(db: DatabaseSync, scope: VisualizeResourceScope, data: Json): { resources: Omit<ResourceEnvelope, 'sourceNodeIds'>[]; projectFiles: Omit<ProjectFileInput, 'sourceNodeIds' | 'edgeIds'>[] } {
  const resources: Omit<ResourceEnvelope, 'sourceNodeIds'>[] = [], projectFiles: Omit<ProjectFileInput, 'sourceNodeIds' | 'edgeIds'>[] = [];
  for (const asset of visualizeChecked(() => collectVisualizeAssetReferences(data))) {
    if (asset.kind === 'project-file') { projectFiles.push({ kind: classifyProjectFile(asset.relativePath).type, relativePath: asset.relativePath }); continue; }
    const row = resourceRow(db, scope, asset);
    const version = db.prepare('SELECT representation_version FROM canvas_resource_versions WHERE resource_id=? AND version=?').get(asset.resourceId, asset.resourceVersion)!;
    const mime = String(row.mime);
    resources.push({ kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') || mime.startsWith('audio/') ? 'video' : 'file', text: null,
      resource: { resourceId: asset.resourceId, version: asset.resourceVersion, mime, sha256: String(row.sha256), bytes: Number(row.bytes), representationVersion: version.representation_version === null ? null : Number(version.representation_version) } });
  }
  return { resources, projectFiles };
}
type VisualizeResourceScope = Pick<GraphScope, 'projectId' | 'graphId'>;
/** Live paths are project-scoped, never trusted absolute host paths. */
export async function validateVisualizeProjectDependencies(db: DatabaseSync, scope: VisualizeResourceScope, page: VisualizePagePackage): Promise<void> {
  const files = new ProjectFiles(db);
  for (const dependency of page.dependencies) if (dependency.kind === 'project-file') {
    await files.resolve(scope.projectId, dependency.relativePath, 'file');
    const mime = classifyProjectFile(dependency.relativePath).mime;
    if (!(mime.startsWith(dependency.media + '/') || dependency.media === 'video' && mime.startsWith('audio/'))) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', '项目资产类型与页面依赖声明不符。');
  }
  for (const asset of collectVisualizeAssetReferences(page.initialForm)) if (asset.kind === 'project-file') await files.resolve(scope.projectId, asset.relativePath, 'file');
}
function resourceRow(db: DatabaseSync, scope: VisualizeResourceScope, reference: VisualizeResourceReference) {
  const row = db.prepare('SELECT v.mime,v.sha256,b.bytes,f.path FROM canvas_resources r JOIN canvas_resource_versions v ON v.resource_id=r.id JOIN blobs b ON b.sha256=v.sha256 JOIN resource_blob_files f ON f.sha256=v.sha256 WHERE r.id=? AND r.project_id=? AND r.graph_id=? AND v.version=?').get(reference.resourceId, scope.projectId, scope.graphId, reference.resourceVersion);
  if (!row) throw new ServiceError('INPUT_BLOCKED', '页面资源不属于当前工作图、版本不存在或尚未就绪。');
  return row;
}
export function readStoredVisualizeJson(db: DatabaseSync, scope: VisualizeResourceScope, reference: VisualizeResourceReference): Json {
  const row = resourceRow(db, scope, reference);
  if (row['mime'] !== 'application/json' || Number(row['bytes']) > 4_194_304) throw new ServiceError('INPUT_BLOCKED', '页面包和表单必须使用有界 JSON 资源。');
  const representation = db.prepare("SELECT text FROM resource_representations WHERE sha256=? AND processor='builtin-utf8' AND version=1 AND state='ready'").get(String(row['sha256']));
  if (typeof representation?.['text'] !== 'string' || Buffer.byteLength(representation['text']) !== row['bytes'] || hashBytes(Buffer.from(representation['text'])) !== row['sha256']) throw new ServiceError('INPUT_BLOCKED', '页面 JSON 资源表示不完整或校验失败。');
  try { return JSON.parse(representation['text']) as Json; }
  catch { throw new ServiceError('INPUT_BLOCKED', '页面 JSON 资源无效。'); }
}
/** Business readers never resolve the page package or dependency/code resources. */
export function readVisualizeBusinessForm(db: DatabaseSync, scope: VisualizeResourceScope, value: unknown) {
  const content = visualizeChecked(() => validateVisualizeNodeContent(value));
  if (!content.form) throw new ServiceError('INPUT_BLOCKED', '可视化前驱尚未保存业务表单。');
  const data = readStoredVisualizeJson(db, scope, content.form.resource);
  resolveVisualizeFormAssets(db, scope, data);
  if (canonicalJson(data) !== canonicalJson(content.form.data)) throw new ServiceError('INPUT_BLOCKED', '业务表单与固定 JSON 资源版本不一致。');
  const row = resourceRow(db, scope, content.form.resource);
  const version = db.prepare('SELECT representation_version FROM canvas_resource_versions WHERE resource_id=? AND version=?').get(content.form.resource.resourceId, content.form.resource.resourceVersion)!;
  return { form: content.form, resource: { resourceId: content.form.resource.resourceId, version: content.form.resource.resourceVersion, mime: String(row['mime']), sha256: String(row['sha256']), bytes: Number(row['bytes']), representationVersion: version['representation_version'] === null ? null : Number(version['representation_version']) } };
}
export function validateVisualizeDependencies(db: DatabaseSync, scope: GraphScope, page: VisualizePagePackage, pending = new Set<string>()): VisualizeResourceReference[] {
  const dependencies: VisualizeResourceReference[] = [];
  for (const dependency of page.dependencies) {
    if (dependency.kind !== 'resource') continue;
    if (pending.has(dependency.resourceId)) continue;
    const reference = { resourceId: dependency.resourceId, resourceVersion: dependency.resourceVersion };
    const row = resourceRow(db, scope, reference), mime = String(row['mime']);
    const matches = dependency.media === 'script' ? ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(mime) :
      dependency.media === 'style' ? mime === 'text/css' : mime.startsWith(dependency.media + '/') || dependency.media === 'video' && mime.startsWith('audio/');
    if (!matches) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', '页面依赖 MIME 与声明类型不符。');
    dependencies.push(reference);
  }
  for (const asset of collectVisualizeAssetReferences({ initialForm: page.initialForm, schema: page.form.schema } as unknown as Json)) if (asset.kind === 'resource' && !pending.has(asset.resourceId)) {
    resourceRow(db, scope, asset);
    dependencies.push({ resourceId: asset.resourceId, resourceVersion: asset.resourceVersion });
  }
  return [...new Map(dependencies.map(reference => [reference.resourceId + ':' + reference.resourceVersion, reference])).values()];
}
/** DB-only integrity gate shared by graph commands, page commits and restart reads. */
export function validateStoredVisualizeContent(db: DatabaseSync, scope: GraphScope, value: unknown): { content: VisualizeNodeContent; page: VisualizePagePackage | null } {
  const content = visualizeChecked(() => validateVisualizeNodeContent(value));
  if (!content.page || !content.form) return { content, page: null };
  const page = visualizeChecked(() => validateVisualizePagePackage(readStoredVisualizeJson(db, scope, content.page!.resource)));
  const dependencies = validateVisualizeDependencies(db, scope, page);
  if (canonicalJson(dependencies as unknown as Json) !== canonicalJson(content.page.dependencies as unknown as Json)) throw new ServiceError('INPUT_BLOCKED', '页面依赖引用与页面包不一致。');
  if (content.page.resource.resourceId === content.form.resource.resourceId || content.form.schemaVersion !== page.form.version) throw new ServiceError('INVALID_REQUEST', '页面与表单资源必须分开，结构版本必须一致。');
  const data = readStoredVisualizeJson(db, scope, content.form.resource);
  visualizeChecked(() => validateVisualizeForm(page.form.schema, data, 'save'));
  resolveVisualizeFormAssets(db, scope, data);
  if (canonicalJson(data) !== canonicalJson(content.form.data)) throw new ServiceError('INVALID_REQUEST', '业务表单与固定 JSON 资源版本不一致。');
  return { content, page };
}
/** Ordinary configuration edits cannot silently rewrite/drop saved page state. */
export function validateVisualizeTransition(previous: VisualizeNodeContent | null, next: VisualizeNodeContent, page: VisualizePagePackage | null): void {
  if (!next.page || !next.form || !next.state) {
    if (previous?.page) throw new ServiceError('INVALID_REQUEST', '不能通过普通正文编辑丢弃已保存的页面和表单。');
    return;
  }
  const pageChanged = !previous?.page || canonicalJson(previous.page.resource as unknown as Json) !== canonicalJson(next.page.resource as unknown as Json);
  if (pageChanged && (!page || canonicalJson(next.form.data) !== canonicalJson(page.initialForm) || canonicalJson(next.state.data) !== canonicalJson(page.initialState))) throw new ServiceError('INVALID_REQUEST', '新页面必须安装其声明的新初始表单和视图状态。');
  if (!previous?.page || !previous.form || !previous.state) {
    if (next.page.revision !== 1 || next.form.version !== 1 || next.state.version !== 1) throw new ServiceError('INVALID_REQUEST', '初始页面、表单和视图版本必须为 1。');
    return;
  }
  if (next.page.revision !== previous.page.revision + Number(pageChanged)) throw new ServiceError('REVISION_CONFLICT', '页面修订不连续。');
  const formChanged = pageChanged || canonicalJson({ data: previous.form.data, resource: previous.form.resource } as unknown as Json) !== canonicalJson({ data: next.form.data, resource: next.form.resource } as unknown as Json);
  const stateChanged = pageChanged || canonicalJson(previous.state.data) !== canonicalJson(next.state.data);
  for (const [oldVersion, newVersion, changed] of [[previous.form.version, next.form.version, formChanged], [previous.state.version, next.state.version, stateChanged]] as const) {
    if (newVersion !== oldVersion + 1 && (changed || newVersion !== oldVersion)) throw new ServiceError('REVISION_CONFLICT', '表单或视图版本不连续。');
  }
}
