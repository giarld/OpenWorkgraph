import { randomUUID } from 'node:crypto';
import { parseSupportedVisualizeAsset } from './visualize-compatibility.js';
import type { BundleResource, GraphScope, GraphSnapshot, Json, Node, VisualizeAssetPackage, VisualizeNodeContent, VisualizeResourceReference } from '@openworkgraph/protocol';
import { buildVisualizeToolTemplate, checkedVisualizeJson, collectVisualizeAssetReferences, remapVisualizeAssetPackage, VISUALIZE_ASSET_MIME } from '@openworkgraph/protocol';
import type { PreparedBlob } from './blob-store.js';
import { hashBytes } from './blob-store.js';
import { Graphs } from './graphs.js';
import { Resources } from './resources.js';
import { VisualizePages } from './visualize-pages.js';
import { ProjectFiles } from './project-files.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { visualizeChecked } from './visualize-content.js';
import { commitTransferResource, insertTransferredVisualizeNode, transferResourceKey } from './visualize-transfer.js';

export type VisualizeLibrarySave = GraphScope & { nodeId: string; name: string; mode: 'new' | 'update'; assetId?: string; expectedAssetVersion?: number; expectedContentVersion: number; expectedPageRevision: number; expectedFormVersion: number; expectedStateVersion: number; expectedExecutionRevision: number; expectedLayoutRevision: number; idempotencyKey: string };
export type VisualizeLibraryInstall = GraphScope & { assetId: string; expectedAssetVersion: number; x: number; y: number; expectedExecutionRevision: number; expectedLayoutRevision: number; idempotencyKey: string };
export type VisualizeLibraryImport = Omit<VisualizeLibraryInstall, 'assetId' | 'expectedAssetVersion'>;
const invalid = (message: string): never => { throw new ServiceError('INVALID_REQUEST', message); };
const conflict = (): never => { throw new ServiceError('REVISION_CONFLICT', '交互内容、资产或工作图已变化，请重新读取。'); };
const json = (value: unknown): Json => value as Json;

/** Self-contained immutable assets; preparation is outside the authenticated transaction. */
export class VisualizeLibrary {
  readonly pages: VisualizePages;
  constructor(readonly graphs: Graphs, readonly resources: Resources) { this.pages = new VisualizePages(graphs, resources); }
  private request<T>(value: unknown, mode: 'save' | 'install' | 'import'): T {
    const install = mode !== 'save';
    const data = visualizeChecked(() => checkedVisualizeJson(value, 16384));
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('无效的交互资产请求。');
    const record = data as Record<string, Json>;
    const common = ['serviceId', 'projectId', 'graphId', 'expectedExecutionRevision', 'expectedLayoutRevision', 'idempotencyKey'];
    const extra = install ? [...(mode === 'install' ? ['assetId', 'expectedAssetVersion'] : []), 'x', 'y'] : ['nodeId', 'name', 'mode', 'expectedContentVersion', 'expectedPageRevision', 'expectedFormVersion', 'expectedStateVersion', ...(record.mode === 'update' ? ['assetId', 'expectedAssetVersion'] : [])];
    const keys = [...common, ...extra];
    if (keys.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !keys.includes(key))) invalid('交互资产请求字段缺失或包含未知字段。');
    for (const key of ['serviceId', 'projectId', 'graphId', ...(mode === 'install' ? ['assetId'] : mode === 'save' ? ['nodeId'] : [])]) if (typeof record[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(record[key])) invalid('交互资产标识无效。');
    if (typeof record.idempotencyKey !== 'string' || !record.idempotencyKey.trim() || record.idempotencyKey.length > 256) invalid('交互资产请求需要幂等键。');
    for (const key of keys.filter(key => key.startsWith('expected'))) if (!Number.isSafeInteger(record[key]) || Number(record[key]) < (['expectedExecutionRevision', 'expectedLayoutRevision'].includes(key) ? 0 : 1)) invalid('交互资产版本无效。');
    if (install) { for (const key of ['x', 'y']) if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || Math.abs(record[key]) > 1e9) invalid('入图位置无效。'); }
    else if (!['new', 'update'].includes(String(record.mode)) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 512) invalid('保存名称或模式无效。');
    return record as unknown as T;
  }
  private expectedSave(request: VisualizeLibrarySave): { node: Node; content: VisualizeNodeContent } {
    this.graphs.writable(request);
    const snapshot = this.graphs.snapshot(request), node = snapshot.nodes.find(item => item.id === request.nodeId);
    if (!node || node.type !== 'visualize') throw new ServiceError('NOT_FOUND', '可视化节点不存在。');
    if (node.readOnly) throw new ServiceError('NODE_LOCKED', '可视化节点只读。');
    const stored = this.pages.current(request, request.nodeId), content = stored.content;
    if (!stored.page || !content.page || !content.form || !content.state) invalid('请先生成交互内容。');
    if (node.contentVersion !== request.expectedContentVersion || snapshot.executionRevision !== request.expectedExecutionRevision || snapshot.layoutRevision !== request.expectedLayoutRevision || content.page!.revision !== request.expectedPageRevision || content.form!.version !== request.expectedFormVersion || content.state!.version !== request.expectedStateVersion) conflict();
    return { node, content };
  }
  private expectedInstall(request: VisualizeLibraryInstall): void {
    const graph = this.graphs.writable(request);
    if (graph.execution_revision !== request.expectedExecutionRevision || graph.layout_revision !== request.expectedLayoutRevision) conflict();
    const asset = this.resources.getAsset(request, request.assetId);
    if (asset.deleted || asset.current.version !== request.expectedAssetVersion) conflict();
    if (asset.current.presentation?.kind !== 'visualize') invalid('该资产不是已校验的可视化交互内容。');
  }
  async save(value: unknown, principal = 'local', guard: <T>(work: () => T) => T = work => work()) {
    const request = this.request<VisualizeLibrarySave>(value, 'save'), namespace = principal + ':visualize.library.save:' + request.graphId + ':' + request.nodeId;
    const replay = guard(() => { this.graphs.scope(request); return this.graphs.repo.replay(namespace, request.idempotencyKey, json(request)); });
    if (replay) return replay;
    const before = guard(() => this.expectedSave(request)), stored = this.pages.current(request, request.nodeId), page = stored.page!;
    const links = new Map<string, VisualizeResourceReference>();
    const add = (ref: VisualizeResourceReference) => links.set(transferResourceKey(ref.resourceId, ref.resourceVersion), ref);
    add(before.content.page!.resource);
    const paths = new Set<string>();
    for (const dep of page.dependencies) { if (dep.kind === 'resource') add(dep); else if (dep.kind === 'project-file') paths.add(dep.relativePath); }
    for (const data of [page.form.schema, page.initialForm, page.initialState]) for (const asset of collectVisualizeAssetReferences(json(data))) { if (asset.kind === 'resource') add(asset); else paths.add(asset.relativePath); }
    if (links.size + paths.size > 256) throw new ServiceError('PAYLOAD_TOO_LARGE', '交互资产依赖过多。');
    const resources: BundleResource[] = [], projectFiles: Record<string, BundleResource> = {}, tokens = new Map<string, string>();
    const files = new ProjectFiles(this.graphs.db);
    let decoded = 0;
    const resource = (id: string, version: number, name: string, mime: string, bytes: Buffer): BundleResource => {
      decoded += bytes.length; if (decoded > 24 * 1024 * 1024) throw new ServiceError('PAYLOAD_TOO_LARGE', '交互资产解码资源总量超过 24 MiB。');
      return { resourceId: id, version, name, mime, bytes: bytes.length, sha256: hashBytes(bytes), base64: bytes.toString('base64') };
    };
    await this.resources.withBlobLease(async () => {
      for (const reference of links.values()) {
        const metadata = this.resources.readCanvasVersion(request, reference.resourceId, reference.resourceVersion);
        if (decoded + metadata.bytes > 24 * 1024 * 1024) throw new ServiceError('PAYLOAD_TOO_LARGE', '交互资产资源超过大小上限。');
        const data = await this.resources.readContent(request, 'canvas', reference.resourceId, reference.resourceVersion);
        resources.push(resource(reference.resourceId, reference.resourceVersion, this.resources.getCanvas(request, reference.resourceId).name, data.mime, data.bytes));
      }
      for (const path of paths) {
        const stat = (await files.stat(request.projectId, [path]))[0]!;
        if (stat.state !== 'available' || !stat.changeToken) throw new ServiceError('INPUT_BLOCKED', '无法读取项目依赖：' + path);
        const bytes = await files.read(request.projectId, path, Math.min(this.resources.blobs.maxBytes, 24 * 1024 * 1024 - decoded));
        const after = (await files.stat(request.projectId, [path]))[0]!;
        if (after.changeToken !== stat.changeToken) conflict();
        tokens.set(path, stat.changeToken);
        projectFiles[path] = resource('project-' + randomUUID(), 1, stat.name, stat.mime ?? 'application/octet-stream', bytes);
      }
    });
    const pkg = visualizeChecked(() => buildVisualizeToolTemplate({ node: before.node, page, resources, projectFiles }));
    const blob = await this.resources.prepareBytes(Buffer.from(canonicalJson(json(pkg))), VISUALIZE_ASSET_MIME);
    try {
      for (const [path, token] of tokens) if ((await files.stat(request.projectId, [path]))[0]?.changeToken !== token) conflict();
      return guard(() => atomic(this.graphs.db, () => this.graphs.repo.idempotent(namespace, request.idempotencyKey, json(request), () => {
        this.expectedSave(request);
        const target = request.mode === 'new' ? { ...request, mode: 'new' as const } : { ...request, mode: 'update' as const, assetId: request.assetId!, expectedVersion: request.expectedAssetVersion! };
        return json(this.resources.createLibraryFromPrepared(target, blob));
      })));
    } finally { atomic(this.graphs.db, () => this.resources.discardPrepared(blob)); await this.resources.drainFileDeletions(); }
  }
  async install(value: unknown, principal = 'local', guard: <T>(work: () => T) => T = work => work()): Promise<{ nodeId: string; snapshot: GraphSnapshot }> {
    const request = this.request<VisualizeLibraryInstall>(value, 'install'), namespace = principal + ':visualize.library.install:' + request.graphId;
    const replay = guard(() => { this.graphs.scope(request); return this.graphs.repo.replay(namespace, request.idempotencyKey, json(request)); });
    if (replay) return replay as unknown as { nodeId: string; snapshot: GraphSnapshot };
    guard(() => this.expectedInstall(request));
    const source = await this.resources.readContent(request, 'asset', request.assetId, request.expectedAssetVersion);
    const pkg = visualizeChecked(() => parseSupportedVisualizeAsset(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes))));
    return this.commitPackage(request, pkg, namespace, json(request), () => this.expectedInstall(request), guard);
  }
  async importFile(value: unknown, principal = 'local', guard: <T>(work: () => T) => T = work => work()): Promise<{ nodeId: string; snapshot: GraphSnapshot }> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'package')) invalid('缺少可视化文件内容。');
    const { package: filePackage, ...intent } = value as Record<string, unknown>;
    const request = this.request<VisualizeLibraryImport>(intent, 'import');
    const pkg = visualizeChecked(() => parseSupportedVisualizeAsset(filePackage));
    const payload = json({ ...request, packageDigest: hashBytes(Buffer.from(canonicalJson(json(pkg)))) });
    const namespace = principal + ':visualize.file.import:' + request.graphId;
    const replay = guard(() => { this.graphs.scope(request); return this.graphs.repo.replay(namespace, request.idempotencyKey, payload); });
    if (replay) return replay as unknown as { nodeId: string; snapshot: GraphSnapshot };
    const expected = () => {
      const graph = this.graphs.writable(request);
      if (graph.execution_revision !== request.expectedExecutionRevision || graph.layout_revision !== request.expectedLayoutRevision) conflict();
    };
    guard(expected);
    return this.commitPackage(request, pkg, namespace, payload, expected, guard);
  }
  private async commitPackage(request: VisualizeLibraryImport, pkg: VisualizeAssetPackage, namespace: string, payload: Json, expected: () => void, guard: <T>(work: () => T) => T): Promise<{ nodeId: string; snapshot: GraphSnapshot }> {
    const mapping = new Map(pkg.resources.map(ref => [transferResourceKey(ref.resourceId, ref.version), { resourceId: randomUUID(), resourceVersion: 1 }]));
    for (const ref of pkg.resources) {
      const bytes = Buffer.from(ref.base64, 'base64');
      if (bytes.length !== ref.bytes || hashBytes(bytes) !== ref.sha256 || bytes.toString('base64') !== ref.base64) invalid('交互资产资源校验失败。');
    }
    const mapped = visualizeChecked(() => remapVisualizeAssetPackage(pkg, mapping));
    const next = json(mapped.node.content);
    const plans: { blob: PreparedBlob; name: string; id: string }[] = [];
    try {
      for (const ref of mapped.resources) {
        const bytes = Buffer.from(ref.base64, 'base64');
        plans.push({ blob: await this.resources.prepareBytes(bytes, ref.mime), name: ref.name, id: ref.resourceId });
      }
      return guard(() => atomic(this.graphs.db, () => this.graphs.repo.idempotent(namespace, request.idempotencyKey, payload, () => {
        expected();
        const history = this.graphs.history.capture(request), nodeId = randomUUID();
        for (const plan of plans) commitTransferResource(this.resources, request, plan.blob, plan.name, plan.id);
        insertTransferredVisualizeNode(this.graphs, request, { id: nodeId, type: 'visualize', schemaVersion: 1, contentVersion: 1, content: next, x: request.x, y: request.y, width: pkg.node.width, height: pkg.node.height, readOnly: false });
        this.graphs.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1,layout_revision=layout_revision+1 WHERE id=?').run(request.graphId);
        this.graphs.history.record(request, history); this.graphs.event(request);
        return json({ nodeId, snapshot: this.graphs.snapshot(request) });
      }))) as unknown as { nodeId: string; snapshot: GraphSnapshot };
    } finally { atomic(this.graphs.db, () => { for (const plan of plans) this.resources.discardPrepared(plan.blob); }); await this.resources.drainFileDeletions(); }
  }
}
