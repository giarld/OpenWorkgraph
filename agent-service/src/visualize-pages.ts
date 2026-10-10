import type { GraphOperation, GraphScope, Json, VisualizeNodeContent, VisualizePagePackage, VisualizeStoredNode, VisualizeWriteRequest } from '@openworkgraph/protocol';
import { checkedVisualizeJson, validateVisualizeForm, validateVisualizePagePackage, VISUALIZE_DEFAULT_SIZE } from '@openworkgraph/protocol';
import { Graphs } from './graphs.js';
import { Resources } from './resources.js';
import type { PreparedBlob } from './blob-store.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { validateStoredVisualizeContent, validateVisualizeDependencies, validateVisualizeProjectDependencies, visualizeChecked } from './visualize-content.js';

export interface PreparedVisualizeWrite { readonly nodeId: string; readonly action: VisualizeWriteRequest['action'] }
interface Preparation { request: VisualizeWriteRequest; principal: string; page: VisualizePagePackage | null; blobs: PreparedBlob[]; disposed: boolean; useCurrentGraph: boolean }
const invalid = (message: string): never => { throw new ServiceError('INVALID_REQUEST', message); };
const integer = (value: unknown, minimum: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

/** Filesystem work stays outside transactions; graph/resource/replay effects commit together. */
export class VisualizePages {
  private readonly preparations = new WeakMap<PreparedVisualizeWrite, Preparation>();
  constructor(readonly graphs: Graphs, readonly resources: Resources) {
    if (graphs.db !== resources.db) throw new Error('Visualize pages require a shared database');
  }
  private outside(): void { if (this.graphs.db.isTransaction) throw new Error('Visualize preparation/read must run outside transactions'); }
  private request(value: unknown): VisualizeWriteRequest {
    const json = visualizeChecked(() => checkedVisualizeJson(value, 6_291_456));
    if (!json || typeof json !== 'object' || Array.isArray(json)) invalid('页面保存请求无效。');
    const data = json as Record<string, Json>;
    const common = ['serviceId', 'projectId', 'graphId', 'nodeId', 'idempotencyKey', 'expectedContentVersion', 'expectedExecutionRevision', 'expectedLayoutRevision', 'expectedPageRevision', 'action'];
    const extra = data.action === 'install-page' ? ['page'] : data.action === 'update-form' ? ['expectedFormVersion', 'form'] : data.action === 'save-state' ? ['expectedStateVersion', 'state'] : invalid('页面保存操作无效。');
    if ([...common, ...extra].some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => ![...common, ...extra].includes(key))) invalid('页面保存字段缺失或包含未知字段。');
    for (const key of ['serviceId', 'projectId', 'graphId', 'nodeId']) if (typeof data[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(data[key])) invalid('页面保存标识无效。');
    if (typeof data.idempotencyKey !== 'string' || !data.idempotencyKey.trim() || data.idempotencyKey.length > 256) invalid('页面保存需要幂等键。');
    for (const key of ['expectedContentVersion', 'expectedExecutionRevision', 'expectedLayoutRevision', 'expectedPageRevision', 'expectedFormVersion', 'expectedStateVersion']) if (Object.hasOwn(data, key) && !integer(data[key], key === 'expectedContentVersion' || key === 'expectedFormVersion' || key === 'expectedStateVersion' ? 1 : 0)) invalid('页面保存版本无效。');
    return data as unknown as VisualizeWriteRequest;
  }
  private namespace(request: VisualizeWriteRequest, principal: string): string { return principal + ':visualize.write:' + request.graphId + ':' + request.nodeId; }
  current(scope: GraphScope, nodeId: string): VisualizeStoredNode {
    return atomic(this.graphs.db, () => {
      const graph = this.graphs.scope(scope);
      const node = this.graphs.db.prepare('SELECT n.type,n.schema_version,n.current_version,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(nodeId, scope.graphId);
      if (!node || node['type'] !== 'visualize') throw new ServiceError('NOT_FOUND', '可视化节点不存在。');
      if (node['schema_version'] !== 1) throw new ServiceError('SCHEMA_UNSUPPORTED', '可视化节点版本不兼容。');
      const value = validateStoredVisualizeContent(this.graphs.db, scope, JSON.parse(String(node['content'])));
      return { serviceId: scope.serviceId, projectId: scope.projectId, graphId: scope.graphId, nodeId, contentVersion: Number(node['current_version']), executionRevision: Number(graph['execution_revision']), layoutRevision: Number(graph['layout_revision']), ...value };
    });
  }
  private writable(scope: GraphScope, nodeId: string): void {
    this.graphs.writable(scope);
    const node = this.graphs.db.prepare('SELECT read_only FROM nodes WHERE id=? AND graph_id=? AND deleted=0').get(nodeId, scope.graphId);
    if (!node) throw new ServiceError('NOT_FOUND', '可视化节点不存在。');
    if (node['read_only']) throw new ServiceError('NODE_LOCKED', '当前可视化节点只读。');
  }
  replay(value: unknown, principal = 'local'): VisualizeStoredNode | undefined {
    const request = this.request(value);
    return atomic(this.graphs.db, () => {
      this.writable(request, request.nodeId);
      return this.graphs.repo.replay(this.namespace(request, principal), request.idempotencyKey, request as unknown as Json) as unknown as VisualizeStoredNode | undefined;
    });
  }
  private expected(request: VisualizeWriteRequest, useCurrentGraph = false): VisualizeStoredNode {
    this.writable(request, request.nodeId);
    const current = this.current(request, request.nodeId);
    if (current.contentVersion !== request.expectedContentVersion || !useCurrentGraph && (current.executionRevision !== request.expectedExecutionRevision || current.layoutRevision !== request.expectedLayoutRevision) || (current.content.page?.revision ?? 0) !== request.expectedPageRevision ||
      request.action === 'update-form' && current.content.form?.version !== request.expectedFormVersion || request.action === 'save-state' && current.content.state?.version !== request.expectedStateVersion) throw new ServiceError('REVISION_CONFLICT', '页面、表单、视图或工作图已变化，请读取最新内容。');
    return current;
  }
  async prepare(value: unknown, principal = 'local', useCurrentGraph = false): Promise<PreparedVisualizeWrite> {
    this.outside();
    const request = this.request(value);
    // Only atomic successor creation may rebase a staged form onto the current graph.
    if (useCurrentGraph && request.action !== 'update-form') invalid('仅后继表单保存可使用当前工作图修订。');
    const before = atomic(this.graphs.db, () => this.expected(request, useCurrentGraph));
    let page: VisualizePagePackage | null = null;
    const blobs: PreparedBlob[] = [];
    try {
      if (request.action === 'install-page') {
        page = visualizeChecked(() => validateVisualizePagePackage(request.page));
        await validateVisualizeProjectDependencies(this.graphs.db, request, page);
        const dependencies = validateVisualizeDependencies(this.graphs.db, request, page);
        // A lease protects carried files while their immutable bytes are verified.
        await this.resources.withBlobLease(async () => {
          for (const dependency of dependencies) {
            const metadata = this.resources.readCanvasVersion(request, dependency.resourceId, dependency.resourceVersion);
            const path = this.graphs.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(metadata.sha256)!;
            await this.resources.blobs.withVerifiedFile(String(path['path']), metadata, async () => undefined);
          }
        });
        blobs.push(await this.resources.prepareBytes(Buffer.from(canonicalJson(page as unknown as Json)), 'application/json'));
        blobs.push(await this.resources.prepareBytes(Buffer.from(canonicalJson(page.initialForm)), 'application/json'));
      } else {
        if (!before.page || !before.content.page || !before.content.form || !before.content.state) throw new ServiceError('INPUT_BLOCKED', '请先生成并保存交互页面。');
        if (request.action === 'update-form') {
          const form = visualizeChecked(() => validateVisualizeForm(before.page!.form.schema, request.form, 'save'));
          blobs.push(await this.resources.prepareBytes(Buffer.from(canonicalJson(form)), 'application/json'));
        } else visualizeChecked(() => checkedVisualizeJson(request.state));
      }
      const token = Object.freeze({ nodeId: request.nodeId, action: request.action });
      this.preparations.set(token, { request, principal, page, blobs, disposed: false, useCurrentGraph });
      return token;
    } catch (error) {
      if (blobs.length) atomic(this.graphs.db, () => { for (const blob of blobs) this.resources.discardPrepared(blob); });
      await this.resources.drainFileDeletions();
      throw error;
    }
  }
  commit(token: PreparedVisualizeWrite): VisualizeStoredNode {
    const prepared = this.preparations.get(token);
    if (!prepared || prepared.disposed) invalid('页面保存准备记录无效或已释放。');
    const { request, principal, blobs, page } = prepared!;
    return atomic(this.graphs.db, () => {
      this.writable(request, request.nodeId);
      return this.graphs.repo.idempotent(this.namespace(request, principal), request.idempotencyKey, request as unknown as Json, () => {
        const before = this.expected(request, prepared!.useCurrentGraph), content: VisualizeNodeContent = structuredClone(before.content);
        const operations: GraphOperation[] = [];
        if (request.action === 'install-page' && page) {
          const pageResource = content.page ? this.resources.updateCanvasFromPrepared(request, content.page.resource.resourceId, content.page.resource.resourceVersion, blobs[0]!) : this.resources.createCanvasFromPrepared(request, blobs[0]!, 'visualize-page.json');
          const formResource = content.form ? this.resources.updateCanvasFromPrepared(request, content.form.resource.resourceId, content.form.resource.resourceVersion, blobs[1]!) : this.resources.createCanvasFromPrepared(request, blobs[1]!, 'visualize-form.json');
          const revision = (content.page?.revision ?? 0) + 1;
          content.page = { revision, resource: { resourceId: pageResource.resource.id, resourceVersion: pageResource.resource.current.version }, dependencies: validateVisualizeDependencies(this.graphs.db, request, page) };
          content.form = { pageRevision: revision, schemaVersion: page.form.version, version: (content.form?.version ?? 0) + 1, data: page.initialForm, resource: { resourceId: formResource.resource.id, resourceVersion: formResource.resource.current.version } };
          content.state = { pageRevision: revision, version: (content.state?.version ?? 0) + 1, data: page.initialState };
          operations.push({ type: 'layout.resize', sizes: [{ nodeId: request.nodeId, ...(page.layout ?? VISUALIZE_DEFAULT_SIZE) }] });
        } else if (request.action === 'update-form') {
          const resource = this.resources.updateCanvasFromPrepared(request, content.form!.resource.resourceId, content.form!.resource.resourceVersion, blobs[0]!);
          content.form = { ...content.form!, version: content.form!.version + 1, data: request.form, resource: { resourceId: resource.resource.id, resourceVersion: resource.resource.current.version } };
        } else if (request.action === 'save-state') content.state = { ...content.state!, version: content.state!.version + 1, data: request.state };
        operations.unshift({ type: 'node.content', nodeId: request.nodeId, expectedContentVersion: before.contentVersion, content: content as unknown as Json });
        this.graphs.command({ serviceId: request.serviceId, projectId: request.projectId, graphId: request.graphId, idempotencyKey: request.idempotencyKey, expectedExecutionRevision: before.executionRevision, expectedLayoutRevision: before.layoutRevision, operations }, this.namespace(request, principal));
        return this.current(request, request.nodeId) as unknown as Json;
      }) as unknown as VisualizeStoredNode;
    });
  }
  async dispose(token: PreparedVisualizeWrite): Promise<void> {
    this.outside();
    const prepared = this.preparations.get(token);
    if (!prepared) invalid('页面保存准备记录不属于当前工作空间。');
    if (!prepared!.disposed) {
      atomic(this.graphs.db, () => { for (const blob of prepared!.blobs) this.resources.discardPrepared(blob); });
      prepared!.disposed = true;
    }
    await this.resources.drainFileDeletions();
  }
  async write(value: unknown, principal = 'local'): Promise<VisualizeStoredNode> {
    this.outside();
    const replay = this.replay(value, principal);
    if (replay) return replay;
    const prepared = await this.prepare(value, principal);
    try { return this.commit(prepared); }
    finally { await this.dispose(prepared); }
  }
  async read(scope: GraphScope, nodeId: string): Promise<VisualizeStoredNode> {
    this.outside();
    const value = this.current(scope, nodeId);
    for (const reference of value.content.page && value.content.form ? [value.content.page.resource, value.content.form.resource] : []) await this.resources.readContent(scope, 'canvas', reference.resourceId, reference.resourceVersion);
    return value;
  }
}
