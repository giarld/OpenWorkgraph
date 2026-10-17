import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { collectVisualizeAssetReferences, visualizeAssetUrl, validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, validateVisualizeForm, validateVisualizeSize, checkedVisualizeJson, visualizeProtocolError, VisualizeValidationError } from '@openworkgraph/protocol';
import type { Json, Run, InputSnapshot, VisualizePagePackage, VisualizeInputSnapshot, VisualizeHostContext, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeAssetReference } from '@openworkgraph/protocol';
import { readValidatedVisualizeOutput } from './visualize-output-validation.js';
import { runDirectories, type DataDirectories } from './directories.js';
import { hashBytes, validateResourceBytes } from './blob-store.js';
import { ProjectFiles } from './project-files.js';
import { ServiceError } from './errors.js';
import type { Runs } from './runs.js';
import type { Resources } from './resources.js';

const TTL = 30 * 60_000;
const MAX_BYTES = 300 * 1024 * 1024;
const GLOBAL_BYTES = 512 * 1024 * 1024;
type Media = 'script' | 'style' | 'image' | 'video' | 'binary';
interface Asset { key: string; reference: VisualizeAssetReference; media: Media; mime: string; bytes: Buffer }
interface Preview {
  id: string; token: string; run: Run; attemptId: string; path: string; sha256: string; expiresAt: number;
  page: VisualizePagePackage; context: VisualizeHostContext; bridgeId: string; assets: Asset[];
  diagnostics: { kind: string; message: string }[]; status: string; receiptBytes: number; inputSource: VisualizePreviewLink['inputSource'];
  effects: Json[]; receipts: Map<string, { body: string; response: VisualizeBridgeResponse }>;
}
export interface VisualizePreviewLink { sessionId: string; url: string; alternateUrls: string[]; sha256: string; expiresAt: string; warnings: string[]; inputSource: 'frozen-run' | 'run-references-with-preview-files'; unsupportedMethods: string[] }
const mediaOf = (mime: string): Media => mime.startsWith('image/') ? 'image' : /^(video|audio)[/]/.test(mime) ? 'video' : mime === 'text/css' ? 'style' : /^(text|application)[/](javascript|ecmascript)$/.test(mime) ? 'script' : 'binary';
const reject = (code: ConstructorParameters<typeof VisualizeValidationError>[0], message: string): never => { throw new VisualizeValidationError(code, message); };

/** Ephemeral test data only. This class never publishes resources or executes graph commands. */
export class VisualizePreviews {
  private readonly sessions = new Map<string, Preview>();
  private readonly creating = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(readonly runs: Runs, readonly directories: DataDirectories, readonly resources: Resources, private readonly now = Date.now) {
    this.timer = setInterval(() => this.sweep(), 15_000); this.timer.unref();
  }
  private active(runId: string, attemptId: string): boolean {
    if (this.stopped) return false;
    try {
      const run = this.runs.get(runId), runtime = this.runs.runtime(runId);
      return runtime.epoch === attemptId && runtime.details.cancelRequested !== true && ['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(run.status)
        && !!this.runs.db.prepare("SELECT 1 FROM projects p JOIN graphs g ON g.project_id=p.id WHERE p.id=? AND p.state='active' AND g.id=? AND g.archived=0 AND g.trashed=0").get(run.projectId, run.graphId);
    } catch { return false; }
  }
  private check(runId: string, attemptId: string): void { if (!this.active(runId, attemptId)) throw new ServiceError('CONFLICT', '测试所属任务已结束或发生变化。'); }
  sweep(): void { for (const [id, session] of this.sessions) if (session.expiresAt <= this.now() || !this.active(session.run.id, session.attemptId)) this.sessions.delete(id); }
  close(): void { this.stopped = true; clearInterval(this.timer); this.sessions.clear(); }
  private get(id: string): Preview {
    this.sweep(); const session = this.sessions.get(id);
    if (!session) throw new ServiceError('SESSION_EXPIRED', '测试链接已失效，请在生成任务中重新创建。');
    return session;
  }
  authorize(id: string, authorization: string | undefined): Preview {
    const session = this.get(id), token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (Buffer.byteLength(token) !== Buffer.byteLength(session.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))) throw new ServiceError('UNAUTHENTICATED', '测试会话授权无效。');
    return session;
  }
  private owned(runId: string, attemptId: string, id: string): Preview {
    this.check(runId, attemptId); const session = this.get(id);
    if (session.run.id !== runId || session.attemptId !== attemptId) throw new ServiceError('NOT_FOUND', '测试会话不属于当前任务。');
    return session;
  }
  private endpoints(): string[] {
    const row = this.runs.db.prepare("SELECT value FROM settings WHERE key='listener'").get();
    if (!row) throw new ServiceError('NOT_IMPLEMENTED', '工作空间尚未监听测试请求。');
    const value = JSON.parse(String(row.value)) as { endpoints: string[] };
    if (!value.endpoints?.length) throw new ServiceError('NOT_IMPLEMENTED', '工作空间没有可用测试地址。');
    return value.endpoints;
  }
  async create(runId: string, attemptId: string, path: string, checkDelivery: () => void = () => undefined): Promise<VisualizePreviewLink> {
    this.check(runId, attemptId); this.sweep();
    const key = JSON.stringify([runId, attemptId, path]);
    if (this.creating.has(key)) throw new ServiceError('CONFLICT', '同一草稿正在准备测试，请稍后重试。');
    if (this.creating.size >= 4) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '测试准备数量已达上限。');
    this.creating.add(key);
    try {
      const endpoints = this.endpoints();
      const prior = [...this.sessions.values()].find(s => s.run.id === runId && s.attemptId === attemptId && s.path === path);
      if (!prior && (this.sessions.size >= 16 || [...this.sessions.values()].filter(s => s.run.id === runId).length >= 4)) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '请关闭已有测试会话后再创建。');
      const run = this.runs.get(runId), snapshot = this.runs.snapshot(runId);
      const kind = this.runs.runtime(runId).details.kind;
      if (kind !== 'execution' && kind !== 'visualize_generation') throw new ServiceError('INVALID_REQUEST', '当前任务不支持可视化测试。');
      const prepared = await readValidatedVisualizeOutput(runDirectories(this.directories, runId).output, path, kind, 'preview-' + randomUUID() + '-');
      const inputs = this.inputs(snapshot);
      const inputSource = inputs.inputs.some(input => input.projectFiles?.some(file => !input.projectFileData?.some(data => data.relativePath === file.relativePath))) ? 'run-references-with-preview-files' : 'frozen-run';
      const assets = await this.assets(run, prepared.page, inputs, prepared.assets);
      this.check(runId, attemptId); checkDelivery();
      if (prior && (this.sessions.get(prior.id) !== prior || prior.expiresAt <= this.now())) throw new ServiceError('CONFLICT', '原测试会话已关闭或过期，请重新创建。');
      if (!prior && [...this.sessions.values()].filter(s => s.run.id === runId).length >= 4) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '请关闭已有测试会话后再创建。');
      // Concurrent preparations also count against the committed global budget.
      if (this.sessions.size >= 16 && !prior || this.bytes(assets) + [...this.sessions.values()].filter(s => s !== prior).reduce((n, s) => n + this.bytes(s.assets), 0) > GLOBAL_BYTES) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '测试数据超过工作空间临时存储上限。');
      const revision = (prior?.context.pageRevision ?? 0) + 1;
      const id = prior?.id ?? randomUUID();
      const session: Preview = { id, token: prior?.token ?? randomBytes(32).toString('base64url'), run, attemptId, path, sha256: prepared.validation.sha256, expiresAt: this.now() + TTL, page: prepared.page, bridgeId: randomUUID(), assets, diagnostics: [], status: 'not-opened', receiptBytes: 0, inputSource, effects: [], receipts: new Map(), context: {
        pageRevision: revision, form: { pageRevision: revision, schemaVersion: prepared.page.form.version, version: 1, data: structuredClone(prepared.page.initialForm), resource: { resourceId: 'preview-form-' + id, resourceVersion: 1 } },
        state: { pageRevision: revision, version: 1, data: structuredClone(prepared.page.initialState) }, inputs, inputsChanged: false,
        revisions: { pageRevision: revision, formVersion: 1, stateVersion: 1, inputVersion: inputs.version, executionRevision: 1, layoutRevision: 1 },
        theme: { mode: 'light', tokens: {} }, locale: 'zh-CN', viewport: prepared.page.layout ?? { width: 480, height: 360 }, capabilities: { readOnly: false, online: true, canCreateSuccessors: true, canExportAssets: true },
      } };
      validateVisualizeBridgeResponse({ channel: 'openworkgraph.visualize', version: 1, sessionId: session.bridgeId, nodeId: id, requestId: 'preview-preparation', type: 'response', method: 'initialize', ok: true, result: session.context });
      this.sessions.set(id, session);
      const urls = endpoints.map(endpoint => endpoint + '/visualize-preview/' + id + '#' + session.token);
      return { sessionId: id, url: urls[0]!, alternateUrls: urls.slice(1), sha256: session.sha256, expiresAt: new Date(session.expiresAt).toISOString(), warnings: [...prepared.validation.warnings, ...(inputSource === 'frozen-run' ? [] : ['Project file references without frozen byte fingerprints were captured when this test draft was prepared.'])], inputSource, unsupportedMethods: ['signals', 'runSlot', 'promptSlot', 'contentSlot'] };
    } finally { this.creating.delete(key); }
  }
  private inputs(snapshot: InputSnapshot): VisualizeInputSnapshot {
    if (snapshot.visualizeGeneration) return structuredClone(snapshot.visualizeGeneration.inputs);
    const ids = [...new Set([...snapshot.resources.flatMap(r => r.sourceNodeIds), ...(snapshot.projectFiles ?? []).flatMap(f => f.sourceNodeIds)])];
    return { version: 1, digest: snapshot.inputDigest, inputs: ids.map((id, index) => ({ name: ids.length === 1 ? 'default' : 'input-' + (index + 1), edgeId: 'preview-edge-' + index, sourceNodeId: id, contentVersion: snapshot.frozenVisualizeInputs?.find(f => f.sourceNodeId === id)?.contentVersion ?? 1, resources: structuredClone(snapshot.resources.filter(r => r.sourceNodeIds.includes(id))), projectFiles: structuredClone((snapshot.projectFiles ?? []).filter(f => f.sourceNodeIds.includes(id))), ...(snapshot.frozenVisualizeInputs?.find(f => f.sourceNodeId === id)?.form ? { form: structuredClone(snapshot.frozenVisualizeInputs.find(f => f.sourceNodeId === id)!.form) } : {}) })) };
  }
  private bytes(assets: Asset[]): number { return assets.reduce((n, a) => n + a.bytes.length, 0); }
  private async assets(run: Run, page: VisualizePagePackage, inputs: VisualizeInputSnapshot, generated: Map<string, { bytes: Buffer; mime: string }>): Promise<Asset[]> {
    const declarations = new Map<string, { reference: VisualizeAssetReference; media?: Media; sha256?: string; changeToken?: string }>();
    const add = (reference: VisualizeAssetReference, extra = {}) => { const key = visualizeAssetUrl(reference); declarations.set(key, { ...declarations.get(key), reference, ...extra }); };
    for (const d of page.dependencies) {
      if (d.kind === 'resource') add({ format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: d.resourceId, resourceVersion: d.resourceVersion }, { media: d.media });
      if (d.kind === 'project-file') add({ format: 'openworkgraph.asset-reference', version: 1, kind: 'project-file', relativePath: d.relativePath, mode: 'live' }, { media: d.media });
    }
    for (const reference of collectVisualizeAssetReferences({ schema: page.form.schema as unknown as Json, form: page.initialForm, state: page.initialState })) add(reference);
    for (const input of inputs.inputs) {
      for (const { resource: r } of input.resources) if (r) add({ format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: r.resourceId, resourceVersion: r.version }, { sha256: r.sha256 });
      for (const file of input.projectFiles ?? []) { const frozen = input.projectFileData?.find(f => f.relativePath === file.relativePath); add({ format: 'openworkgraph.asset-reference', version: 1, kind: 'project-file', relativePath: file.relativePath, mode: 'live' }, frozen ? { sha256: frozen.sha256, changeToken: frozen.changeToken } : {}); }
      for (const file of input.projectFileData ?? []) add(file.asset, { sha256: file.sha256, changeToken: file.changeToken });
    }
    if (declarations.size > 256) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '测试资产数量超过上限。');
    const files = new ProjectFiles(this.runs.db), assets: Asset[] = []; let total = 0;
    for (const [key, d] of declarations) {
      let bytes: Buffer, mime: string;
      if (d.reference.kind === 'resource') {
        const ref = d.reference, output = ref.resourceVersion === 1 ? generated.get(ref.resourceId) : undefined;
        if (output) ({ bytes, mime } = output);
        else { const metadata = this.resources.readCanvasVersion(run, ref.resourceId, ref.resourceVersion); if (metadata.bytes + total > MAX_BYTES) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '测试资产超过 300 MB。'); ({ bytes, mime } = await this.resources.readContent(run, 'canvas', ref.resourceId, ref.resourceVersion)); }
      } else {
        const ref = d.reference, stat = (await files.stat(run.projectId, [ref.relativePath]))[0]!;
        if (stat.state !== 'available' || d.changeToken && d.changeToken !== stat.changeToken) throw new ServiceError('REVISION_CONFLICT', '项目输入已变化，请重新生成。');
        mime = stat.mime ?? 'application/octet-stream';
        const textMime = mime.startsWith('text/') || mime === 'application/json';
        const isText = textMime || inputs.inputs.some(input => input.projectFiles?.some(file => file.relativePath === ref.relativePath && file.kind === 'text'));
        bytes = await files.read(run.projectId, ref.relativePath, Math.min(isText ? 8 * 1024 * 1024 : MAX_BYTES, MAX_BYTES - total));
        const after = (await files.stat(run.projectId, [ref.relativePath]))[0]!;
        if (after.changeToken !== stat.changeToken) throw new ServiceError('REVISION_CONFLICT', '项目输入在测试准备期间变化。');
        for (const input of inputs.inputs) if (input.projectFiles?.some(f => f.relativePath === ref.relativePath) && !input.projectFileData?.some(f => f.relativePath === ref.relativePath)) {
          const file = input.projectFiles.find(f => f.relativePath === ref.relativePath)!;
          (input.projectFileData ??= []).push({ relativePath: ref.relativePath, kind: file.kind, mime, bytes: bytes.length, sha256: hashBytes(bytes), changeToken: stat.changeToken!, text: file.kind === 'text' || textMime ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null, asset: ref });
        }
      }
      total += bytes.length; if (total > MAX_BYTES) throw new ServiceError('INPUT_BUDGET_EXCEEDED', '测试资产超过 300 MB。');
      if (d.sha256 && hashBytes(bytes) !== d.sha256) throw new ServiceError('REVISION_CONFLICT', '输入字节与冻结快照不一致。');
      const media = mediaOf(mime); if (d.media && d.media !== media) throw new ServiceError('INVALID_REQUEST', '资产类型与页面声明不一致。');
      assets.push({ key, reference: d.reference, media, mime, bytes });
    }
    return assets;
  }
  bootstrap(id: string) {
    const s = this.get(id);
    return { page: s.page, context: s.context, sessionId: s.bridgeId, nodeId: s.id, sha256: s.sha256, assets: s.assets.map((a, index) => ({ key: a.key, reference: a.reference, media: a.media, mime: a.mime, bytes: a.bytes.length, path: '/visualize-preview/' + id + '/assets/' + s.bridgeId + '/' + index })) };
  }
  asset(id: string, index: number): Asset { const asset = this.get(id).assets[index]; if (!asset) throw new ServiceError('NOT_FOUND', '测试资产不存在。'); return asset; }
  status(id: string) { const s = this.get(id); return { sessionId: s.bridgeId, expiresAt: new Date(s.expiresAt).toISOString() }; }
  report(id: string, value: Record<string, unknown>): void {
    const s = this.get(id);
    if (value.sessionId !== s.bridgeId) throw new ServiceError('CONFLICT', '测试草稿已更新，请刷新页面。');
    if (!['ready', 'loading', 'error', 'sdk-error'].includes(String(value.kind)) || typeof value.message !== 'string' || value.message.length > 1000) throw new ServiceError('INVALID_REQUEST', '测试诊断无效。');
    if (value.kind === 'loading') { s.status = 'loading'; s.diagnostics = []; }
    else if (value.kind === 'ready') s.status = s.diagnostics.length ? 'error' : 'ready';
    else { s.status = 'error'; s.diagnostics.push({ kind: String(value.kind), message: value.message }); if (s.diagnostics.length > 30) s.diagnostics.shift(); }
  }
  inspect(runId: string, attemptId: string, id: string) {
    const s = this.owned(runId, attemptId, id);
    const bounded = (value: Json) => { const json = JSON.stringify(value); return Buffer.byteLength(json) <= 12000 ? { data: value } : { truncated: true, bytes: Buffer.byteLength(json), preview: json.slice(0, 2000) }; };
    return { sessionId: id, sha256: s.sha256, status: s.status, expiresAt: new Date(s.expiresAt).toISOString(), diagnostics: s.diagnostics.slice(-10).map(d => ({ kind: d.kind, message: d.message.slice(0, 400) })), diagnosticsTruncated: s.diagnostics.length > 10, form: bounded(s.context.form.data), state: bounded(s.context.state.data), effects: bounded(s.effects), revisions: s.context.revisions, inputSource: s.inputSource };
  }
  release(runId: string, attemptId: string, id: string) { this.owned(runId, attemptId, id); this.sessions.delete(id); return { closed: true }; }
  dispatch(id: string, value: unknown, bytes?: Buffer): VisualizeBridgeResponse {
    const s = this.get(id), r = validateVisualizeBridgeRequest(value);
    const identity = { channel: r.channel, version: r.version, sessionId: r.sessionId, nodeId: r.nodeId, requestId: r.requestId, type: 'response' as const, method: r.method };
    try {
      if (r.sessionId !== s.bridgeId || r.nodeId !== s.id) reject('SESSION_EXPIRED', '测试草稿已更新，请刷新页面。');
      const body = hashBytes(Buffer.from(JSON.stringify(r) + (bytes ? hashBytes(bytes) : '')));
      const prior = s.receipts.get(r.requestId);
      if (prior) { if (prior.body !== body) reject('IDEMPOTENCY_CONFLICT', '重复请求内容不一致。'); return prior.response; }
      if (s.receipts.size >= 256 && r.method !== 'initialize' && r.method !== 'readInputs') reject('INPUT_BLOCKED', '测试调用数量已达上限，请重新生成测试链接。');
      const relevant: (keyof typeof r.expected)[] = r.method === 'initialize' ? [] : ['pageRevision'];
      if (r.method === 'updateForm') relevant.push('formVersion');
      if (r.method === 'saveState') relevant.push('stateVersion');
      if (r.method === 'requestLayout') relevant.push('layoutRevision');
      if (r.method === 'readInputs' && r.params.refresh) relevant.push('inputVersion');
      if (r.method === 'createSuccessors' || r.method === 'exportAsset') relevant.push('formVersion', 'inputVersion');
      if (relevant.some(key => r.expected[key] !== s.context.revisions[key])) reject('REVISION_CONFLICT', '测试状态已变化，请刷新页面。');
      if (r.method === 'initialize' || r.method === 'readInputs') return validateVisualizeBridgeResponse({ ...identity, ok: true, result: this.operation(s, r) });
      const before = structuredClone(s.context), effects = s.effects.length, assets = s.assets.length;
      try {
        const result = this.operation(s, r, bytes);
        const response = validateVisualizeBridgeResponse({ ...identity, ok: true, result });
        const size = Buffer.byteLength(JSON.stringify(response));
        if (s.receiptBytes + size > 8 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(s.effects)) > 4 * 1024 * 1024) reject('INPUT_BLOCKED', '测试记录已达上限，请重新创建测试草稿。');
        s.receipts.set(r.requestId, { body, response: structuredClone(response) }); s.receiptBytes += size;
        return response;
      } catch (error) { s.context = before; s.effects.length = effects; s.assets.length = assets; throw error; }
    } catch (error) {
      const failure = visualizeProtocolError(error);
      s.diagnostics.push({ kind: 'sdk-error', message: r.method + ': ' + failure.message }); if (s.diagnostics.length > 30) s.diagnostics.shift();
      return validateVisualizeBridgeResponse({ ...identity, ok: false, error: failure });
    }
  }
  private operation(s: Preview, r: VisualizeBridgeRequest, bytes?: Buffer): unknown {
    const c = s.context;
    const checkReferences = (data: Json) => { for (const reference of collectVisualizeAssetReferences(data)) if (!s.assets.some(asset => asset.key === visualizeAssetUrl(reference))) reject('RESOURCE_UNAVAILABLE', '引用不属于当前测试资产，请先在草稿中声明后重新测试。'); };
    switch (r.method) {
      case 'initialize': return structuredClone(c);
      case 'readInputs': return { inputs: c.inputs, inputsChanged: false };
      case 'updateForm':
        validateVisualizeForm(s.page.form.schema, r.params.form, 'save'); checkReferences(r.params.form); c.form = { ...c.form, version: c.form.version + 1, data: structuredClone(r.params.form), resource: { ...c.form.resource, resourceVersion: c.form.version + 1 } }; c.revisions.formVersion = c.form.version; c.revisions.executionRevision++;
        return { form: c.form, revisions: c.revisions };
      case 'saveState':
        checkedVisualizeJson(r.params.state); checkReferences(r.params.state); c.state = { ...c.state, version: c.state.version + 1, data: structuredClone(r.params.state) }; c.revisions.stateVersion = c.state.version;
        return { state: c.state, revisions: c.revisions };
      case 'requestLayout':
        validateVisualizeSize(r.params, 'manual', { width: 1000000000, height: 1000000000 }); c.viewport = { ...r.params }; c.revisions.layoutRevision++; return { size: c.viewport, layoutRevision: c.revisions.layoutRevision };
      case 'createSuccessors': {
        if (s.effects.length >= 64) reject('INPUT_BLOCKED', '测试产物数量已达上限。');
        if (r.params.form !== undefined) this.operation(s, { ...r, method: 'updateForm', params: { form: r.params.form } });
        const nodeIds = r.params.successors.map(() => randomUUID()), edgeIds = nodeIds.map(() => randomUUID());
        c.revisions.executionRevision++; s.effects.push({ method: r.method, successors: r.params.successors as unknown as Json, nodeIds, edgeIds, executed: false });
        return { nodeIds, edgeIds, form: c.form, revisions: c.revisions };
      }
      case 'exportAsset': {
        if (!bytes || bytes.length !== r.params.bytes) reject('INVALID_REQUEST', '导出资产字节与声明不一致。');
        const { mime } = validateResourceBytes(bytes!, r.params.mime);
        if (s.effects.length >= 64 || this.bytes(s.assets) + bytes!.length > MAX_BYTES || [...this.sessions.values()].reduce((n, v) => n + this.bytes(v.assets), 0) + bytes!.length > GLOBAL_BYTES) reject('PAYLOAD_TOO_LARGE', '测试产物超过临时存储上限。');
        const resourceId = randomUUID(), nodeId = randomUUID(), edgeId = randomUUID();
        const reference: VisualizeAssetReference = { format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId, resourceVersion: 1 };
        s.assets.push({ key: visualizeAssetUrl(reference), reference, media: mediaOf(mime), mime, bytes: Buffer.from(bytes!) });
        c.revisions.executionRevision++; c.revisions.layoutRevision++;
        const result = { resourceId, resourceVersion: 1, nodeId, edgeId, mime, bytes: bytes!.length, revisions: c.revisions };
        s.effects.push({ method: r.method, name: r.params.name, sha256: hashBytes(bytes!), resourceId, nodeId, bytes: bytes!.length, mime }); return result;
      }
      default: return reject('INPUT_BLOCKED', '临时测试不支持此跨节点操作；没有执行正式工作图操作。');
    }
  }
}
