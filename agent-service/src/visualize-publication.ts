import type { GraphScope, Json, Run, VisualizeNodeContent, VisualizePagePackage } from '@openworkgraph/protocol';
import { validateVisualizePagePackage, VISUALIZE_DEFAULT_SIZE } from '@openworkgraph/protocol';
import { randomUUID } from 'node:crypto';
import type { PreparedBlob } from './blob-store.js';
import { Graphs } from './graphs.js';
import { Resources } from './resources.js';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { validateStoredVisualizeContent, validateVisualizeDependencies, validateVisualizeProjectDependencies, validateVisualizeTransition, visualizeChecked } from './visualize-content.js';
import { resolveGeneratedVisualizeAssets, type GeneratedVisualizeAsset } from './visualize-generated-assets.js';

export interface PreparedVisualizePublication { readonly page: VisualizePagePackage }
interface Preparation { scope: GraphScope; page: VisualizePagePackage; blobs: PreparedBlob[]; disposed: boolean }

/** Shared by Agent preflight and publication; no resources are installed here. */
export function validateGeneratedVisualizePage(value: unknown, generated = new Map<string, GeneratedVisualizeAsset>()): VisualizePagePackage {
  const page = visualizeChecked(() => validateVisualizePagePackage(generated.size ? resolveGeneratedVisualizeAssets(value, generated) : value));
  if (/data:(?:image|video|audio)[/][^\s"'<>]*;base64,/i.test(page.html)) throw new ServiceError('INVALID_REQUEST', '页面 HTML 不得内嵌媒体 base64；请使用资产引用。');
  return page;
}

/** Both Run paths share the same validation gates as VisualizePages. Preparation
 * verifies immutable dependency files; installation is entirely transactional. */
export class VisualizePublication {
  private readonly preparations = new WeakMap<PreparedVisualizePublication, Preparation>();
  constructor(readonly graphs: Graphs, readonly resources: Resources) {
    if (graphs.db !== resources.db) throw new Error('Visualize publication requires a shared database');
  }
  async prepare(scope: GraphScope, value: unknown, generated = new Map<string, GeneratedVisualizeAsset>()): Promise<PreparedVisualizePublication> {
    if (this.graphs.db.isTransaction) throw new Error('Visualize publication preparation must run outside a transaction');
    const page = validateGeneratedVisualizePage(value, generated);
    await validateVisualizeProjectDependencies(this.graphs.db, scope, page);
    const blobs: PreparedBlob[] = [];
    try {
      await this.resources.withBlobLease(async () => {
        const pending = new Set([...generated.values()].map(asset => asset.resourceId));
        for (const dependency of validateVisualizeDependencies(this.graphs.db, scope, page, pending)) {
          const metadata = this.resources.readCanvasVersion(scope, dependency.resourceId, dependency.resourceVersion);
          const file = this.graphs.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(metadata.sha256)!;
          await this.resources.blobs.withVerifiedFile(String(file['path']), metadata, async () => undefined);
        }
      });
      blobs.push(await this.resources.prepareBytes(Buffer.from(canonicalJson(page as unknown as Json)), 'application/json'));
      blobs.push(await this.resources.prepareBytes(Buffer.from(canonicalJson(page.initialForm)), 'application/json'));
      const token = Object.freeze({ page: structuredClone(page) });
      this.preparations.set(token, { scope: { serviceId: scope.serviceId, projectId: scope.projectId, graphId: scope.graphId }, page, blobs, disposed: false });
      return token;
    } catch (error) {
      atomic(this.graphs.db, () => { for (const blob of blobs) this.resources.discardPrepared(blob); });
      await this.resources.drainFileDeletions();
      throw error;
    }
  }
  install(run: Run, outputKey: string, token: PreparedVisualizePublication, current: Json): VisualizeNodeContent {
    if (!this.graphs.db.isTransaction) throw new Error('Visualize installation requires a publication transaction');
    const prepared = this.preparations.get(token);
    if (!prepared || prepared.disposed || prepared.scope.serviceId !== run.serviceId || prepared.scope.projectId !== run.projectId || prepared.scope.graphId !== run.graphId) throw new ServiceError('INVALID_REQUEST', '页面发布准备记录无效。');
    const before = validateStoredVisualizeContent(this.graphs.db, run, current).content;
    const dependencies = validateVisualizeDependencies(this.graphs.db, run, prepared.page);
    const page = this.resources.createCanvasFromPrepared(run, prepared.blobs[0]!, 'visualize-page.json');
    const form = this.resources.createCanvasFromPrepared(run, prepared.blobs[1]!, 'visualize-form.json');
    // Internal keys contain ':' and cannot collide with manifest output keys.
    for (const [key, reference] of [
      [outputKey, { resourceId: page.resource.id, resourceVersion: 1 }],
      ['__visualize_form:' + outputKey, { resourceId: form.resource.id, resourceVersion: 1 }],
      ...dependencies.map((reference, index) => ['__visualize_dependency:' + outputKey + ':' + index, reference] as const),
    ] as const) this.graphs.db.prepare('INSERT INTO canvas_outputs(run_id,graph_id,output_key,resource_id,resource_version) VALUES(?,?,?,?,?)').run(run.id, run.graphId, key, reference.resourceId, reference.resourceVersion);
    const revision = (before.page?.revision ?? 0) + 1;
    const content: VisualizeNodeContent = {
      ...before,
      page: { revision, resource: { resourceId: page.resource.id, resourceVersion: 1 }, dependencies },
      form: { pageRevision: revision, schemaVersion: prepared.page.form.version, version: (before.form?.version ?? 0) + 1, data: prepared.page.initialForm, resource: { resourceId: form.resource.id, resourceVersion: 1 } },
      state: { pageRevision: revision, version: (before.state?.version ?? 0) + 1, data: prepared.page.initialState },
    };
    this.validate(run, before as unknown as Json, content as unknown as Json);
    this.resources.releaseCanvasReference(run, page.referenceId);
    this.resources.releaseCanvasReference(run, form.referenceId);
    return content;
  }
  validate(scope: GraphScope, previous: Json, next: Json): VisualizeNodeContent {
    const before = validateStoredVisualizeContent(this.graphs.db, scope, previous).content;
    const stored = validateStoredVisualizeContent(this.graphs.db, scope, next);
    validateVisualizeTransition(before, stored.content, stored.page);
    return stored.content;
  }
  /** Accept a complete new page/form/state unit while preserving current config
   * and rebasing revisions onto any intervening form or page writes. */
  accept(scope: GraphScope, current: Json, proposed: Json): VisualizeNodeContent {
    const before = validateStoredVisualizeContent(this.graphs.db, scope, current).content;
    const candidate = validateStoredVisualizeContent(this.graphs.db, scope, proposed).content;
    if (!candidate.page || !candidate.form || !candidate.state) throw new ServiceError('INVALID_REQUEST', '页面生成候选不完整。');
    const revision = (before.page?.revision ?? 0) + 1;
    return this.validate(scope, current, { ...before, page: { ...candidate.page, revision }, form: { ...candidate.form, pageRevision: revision, version: (before.form?.version ?? 0) + 1 }, state: { ...candidate.state, pageRevision: revision, version: (before.state?.version ?? 0) + 1 } } as unknown as Json);
  }
  resize(scope: GraphScope, nodeId: string, content: Json): void {
    const stored = validateStoredVisualizeContent(this.graphs.db, scope, content);
    if (!stored.page) throw new ServiceError('INVALID_REQUEST', '页面生成结果不完整。');
    const size = stored.page.layout ?? VISUALIZE_DEFAULT_SIZE;
    this.graphs.db.prepare('UPDATE nodes SET width=?,height=? WHERE id=? AND graph_id=? AND deleted=0').run(size.width, size.height, nodeId, scope.graphId);
  }
  /** Public graph commands still cannot forge delivery links. These targets were
   * created in the current publication transaction and remain editable. */
  delivery(run: Run, nodeId: string): void {
    const db = this.graphs.db;
    if (!db.isTransaction) throw new Error('Visualize delivery requires a publication transaction');
    const target = db.prepare('SELECT n.*,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(nodeId, run.graphId);
    const source = db.prepare('SELECT type FROM nodes WHERE id=? AND graph_id=? AND deleted=0').get(run.nodeId, run.graphId);
    if (!target || target.type !== 'visualize' || target.schema_version !== 1 || target.read_only || source?.type !== 'execution' || nodeId === run.nodeId || db.prepare('SELECT 1 FROM edges WHERE graph_id=? AND source_id=? AND target_id=?').get(run.graphId, run.nodeId, nodeId)) throw new ServiceError('INVALID_EDGE', '可视化交付关系无效。');
    const { content } = validateStoredVisualizeContent(db, run, JSON.parse(String(target.content)));
    if (!content.page || !db.prepare('SELECT 1 FROM canvas_outputs WHERE run_id=? AND resource_id=? AND resource_version=?').get(run.id, content.page.resource.resourceId, content.page.resource.resourceVersion)) throw new ServiceError('INVALID_EDGE', '可视化交付必须属于当前任务。');
    db.prepare("INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,'delivery')").run(randomUUID(), run.graphId, run.nodeId, nodeId);
  }
  async dispose(token: PreparedVisualizePublication): Promise<void> {
    if (this.graphs.db.isTransaction) throw new Error('Visualize disposal must run outside a transaction');
    const prepared = this.preparations.get(token);
    if (!prepared) throw new ServiceError('INVALID_REQUEST', '页面发布准备记录不属于当前工作空间。');
    if (!prepared.disposed) {
      atomic(this.graphs.db, () => { for (const blob of prepared.blobs) this.resources.discardPrepared(blob); });
      prepared.disposed = true;
    }
    await this.resources.drainFileDeletions();
  }
}
