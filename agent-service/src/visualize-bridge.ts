import { randomUUID } from 'node:crypto';
import type { GraphScope, Json, VisualizeBridgeMethods, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeExpectedRevisions, VisualizeHostContext, VisualizeStoredNode } from '@openworkgraph/protocol';
import { checkedVisualizeJson, validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, visualizeProtocolError, VisualizeValidationError } from '@openworkgraph/protocol';
import { VisualizePages } from './visualize-pages.js';
import { VisualizeInputs, type VisualizeInputSession, type VisualizeInputRead } from './visualize-inputs.js';
import { atomic } from './persistence/database.js';
import { hashBytes } from './blob-store.js';
import { canonicalJson } from './persistence/repositories.js';

type Guard = <T>(work: () => T) => T;
export interface VisualizePresentation { theme: VisualizeHostContext['theme']; locale: string; viewport: VisualizeHostContext['viewport'] }
export interface PreparedVisualizeSuccessors { commit(): VisualizeBridgeMethods['createSuccessors']['result']; dispose(): Promise<void> }
export interface PreparedVisualizeAssetExport { commit(): VisualizeBridgeMethods['exportAsset']['result']; dispose(): Promise<void> }
export interface VisualizeBridgeOptions {
  prepareAssetExport?: (scope: GraphScope, nodeId: string, request: Extract<VisualizeBridgeRequest, { method: 'exportAsset' }>, bytes: Uint8Array) => Promise<PreparedVisualizeAssetExport>;
  now?: () => number;
  /** P08 supplies the real atomic creation business; no fallback creates a Run. */
  prepareSuccessors?: (scope: GraphScope, nodeId: string, request: Extract<VisualizeBridgeRequest, { method: 'createSuccessors' }>, principal: string) => Promise<PreparedVisualizeSuccessors>;
}
interface Session {
  id: string; scope: GraphScope; nodeId: string; principal: string; pageRevision: number; input: VisualizeInputSession; value: VisualizeInputRead;
  presentation: VisualizePresentation; expires: number; tail: Promise<unknown>; pending: Map<string, { payload: string; promise: Promise<VisualizeBridgeResponse> }>;
  receipts: Map<string, { payload: string; result: unknown }>;
}
const reject = (code: ConstructorParameters<typeof VisualizeValidationError>[0], message: string): never => { throw new VisualizeValidationError(code, message); };

/** Authenticated workspace capabilities, never credentials passed to page code. */
export class VisualizeBridge {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  constructor(readonly pages: VisualizePages, readonly inputs: VisualizeInputs, readonly options: VisualizeBridgeOptions = {}) { this.now = options.now ?? Date.now; }
  private sweep(): void { for (const session of this.sessions.values()) if (session.expires <= this.now()) this.drop(session); }
  private drop(session: Session): void { this.sessions.delete(session.id); this.inputs.close(session.input); }
  async open(scope: GraphScope, nodeId: string, principal: string, value: unknown, guard: Guard = work => work()): Promise<{ sessionId: string; nodeId: string }> {
    const presentation = checkedVisualizeJson(value, 65_536) as unknown as VisualizePresentation;
    // Validate presentation using the same response contract before retaining it.
    const before = guard(() => this.pages.current(scope, nodeId));
    if (!before.content.page || !before.content.form || !before.content.state) reject('INPUT_BLOCKED', '请先保存可视化交互页面。');
    await this.pages.read(scope, nodeId);
    guard(() => this.pages.current(scope, nodeId));
    const opened = await this.inputs.open(scope, nodeId);
    let accepted = false;
    try {
      return guard(() => {
        this.sweep(); if (this.sessions.size >= 64) reject('INPUT_BLOCKED', '打开的页面会话过多，请关闭旧页面。');
        const current = this.pages.current(scope, nodeId);
        if (current.content.page?.revision !== before.content.page!.revision) reject('SESSION_EXPIRED', '页面已替换，请重新打开。');
        const session: Session = { id: randomUUID(), scope: structuredClone(scope), nodeId, principal, pageRevision: before.content.page!.revision, input: opened.session, value: opened.value, presentation, expires: this.now() + 900_000, tail: Promise.resolve(), pending: new Map(), receipts: new Map() };
        const request = { channel: 'openworkgraph.visualize', version: 1, sessionId: session.id, nodeId, requestId: 'open', type: 'request', method: 'initialize', params: {}, expected: this.revisions(current, session) } as const;
        validateVisualizeBridgeResponse(this.response(request, this.context(current, session)));
        this.sessions.set(session.id, session); accepted = true; return { sessionId: session.id, nodeId };
      });
    } finally { if (!accepted) this.inputs.close(opened.session); }
  }
  close(scope: GraphScope, nodeId: string, id: string, principal: string): void {
    const session = this.sessions.get(id); if (!session) return;
    if (!this.matches(session, scope, nodeId, principal)) reject('SESSION_EXPIRED', '页面会话不属于当前节点。');
    this.drop(session);
  }
  dispose(): void { for (const session of this.sessions.values()) this.drop(session); }
  private matches(session: Session, scope: GraphScope, nodeId: string, principal: string): boolean {
    return session.principal === principal && session.nodeId === nodeId && session.scope.serviceId === scope.serviceId && session.scope.projectId === scope.projectId && session.scope.graphId === scope.graphId;
  }
  private check(session: Session): VisualizeStoredNode {
    if (this.sessions.get(session.id) !== session || session.expires <= this.now()) { this.drop(session); reject('SESSION_EXPIRED', '页面会话已关闭或过期。'); }
    let current: VisualizeStoredNode;
    try { current = this.pages.current(session.scope, session.nodeId); }
    catch (error) { this.drop(session); reject('SESSION_EXPIRED', '当前页面不可用，请重新打开。'); }
    if (current!.content.page?.revision !== session.pageRevision) { this.drop(session); reject('SESSION_EXPIRED', '页面已替换，请重新打开。'); }
    session.expires = this.now() + 900_000; return current!;
  }
  private revisions(current: VisualizeStoredNode, session: Session): VisualizeExpectedRevisions {
    return { pageRevision: current.content.page!.revision, formVersion: current.content.form!.version, stateVersion: current.content.state!.version, inputVersion: session.value.inputs.version, executionRevision: current.executionRevision, layoutRevision: current.layoutRevision };
  }
  private readOnly(session: Session): boolean {
    const row = this.pages.graphs.db.prepare('SELECT p.state,g.archived,g.trashed,n.read_only FROM projects p JOIN graphs g ON g.project_id=p.id JOIN nodes n ON n.graph_id=g.id WHERE p.id=? AND g.id=? AND n.id=?').get(session.scope.projectId, session.scope.graphId, session.nodeId)!;
    return row.state !== 'active' || !!row.archived || !!row.trashed || !!row.read_only;
  }
  private context(current: VisualizeStoredNode, session: Session): VisualizeHostContext {
    return { ...session.presentation, pageRevision: session.pageRevision, form: current.content.form!, state: current.content.state!, inputs: session.value.inputs, inputsChanged: session.value.inputsChanged, revisions: this.revisions(current, session), capabilities: { readOnly: this.readOnly(session), online: true, canCreateSuccessors: !!this.options.prepareSuccessors && !this.readOnly(session), canExportAssets: !!this.options.prepareAssetExport && !this.readOnly(session) } };
  }
  private response(request: VisualizeBridgeRequest, result: unknown): VisualizeBridgeResponse {
    return { channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId: request.nodeId, requestId: request.requestId, type: 'response', method: request.method, ok: true, result } as VisualizeBridgeResponse;
  }
  private expected(current: VisualizeStoredNode, session: Session, request: VisualizeBridgeRequest): void {
    if (request.method === 'initialize') return;
    const actual = this.revisions(current, session);
    const relevant: (keyof VisualizeExpectedRevisions)[] = ['pageRevision'];
    if (request.method === 'updateForm') relevant.push('formVersion');
    if (request.method === 'saveState') relevant.push('stateVersion');
    if (request.method === 'requestLayout') relevant.push('layoutRevision');
    if (request.method === 'readInputs' && request.params.refresh) relevant.push('inputVersion');
    if (request.method === 'createSuccessors' || request.method === 'exportAsset') relevant.push('formVersion', 'inputVersion');
    if (relevant.some(key => actual[key] !== request.expected[key])) reject('REVISION_CONFLICT', '页面内容或工作图已变化，请重新初始化。');
  }
  async handle(scope: GraphScope, nodeId: string, principal: string, value: unknown, guard: Guard = work => work(), bytes?: Uint8Array): Promise<VisualizeBridgeResponse> {
    const request = validateVisualizeBridgeRequest(value);
    const session = guard(() => this.sessions.get(request.sessionId));
    const error = (failure: unknown) => ({ channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId: request.nodeId, requestId: request.requestId, type: 'response', method: request.method, ok: false, error: visualizeProtocolError(failure) }) as VisualizeBridgeResponse;
    if (!session || request.nodeId !== nodeId || !this.matches(session, scope, nodeId, principal)) return guard(() => error(new VisualizeValidationError('SESSION_EXPIRED', '页面会话已失效。')));
    if (request.method === 'exportAsset' && (!bytes || bytes.length !== request.params.bytes)) return guard(() => error(new VisualizeValidationError('INVALID_REQUEST', '资产导出需要独立二进制文件。')));
    if (request.method !== 'exportAsset' && bytes) return guard(() => error(new VisualizeValidationError('INVALID_REQUEST', '此方法不接受文件。')));
    if (bytes) bytes = Buffer.from(bytes);
    const payload = canonicalJson({ method: request.method, expected: request.expected, params: request.params, ...(bytes ? { sha256: hashBytes(bytes) } : {}) } as unknown as Json);
    const pending = session.pending.get(request.requestId);
    if (pending) return guard(() => { this.check(session); if (pending.payload !== payload) reject('IDEMPOTENCY_CONFLICT', '同一请求标识不能使用不同内容。'); return pending.promise; });
    if (session.pending.size >= 32) return guard(() => error(new VisualizeValidationError('INPUT_BLOCKED', '页面请求过多，请稍后重试。')));
    const promise = session.tail.catch(() => undefined).then(async () => {
      let response: VisualizeBridgeResponse;
      try { response = this.response(request, await this.execute(session, request, payload, guard, bytes)); }
      catch (failure) { response = error(failure); }
      return guard(() => {
        validateVisualizeBridgeResponse(response);
        if (response.ok && (request.method === 'initialize' || request.method === 'readInputs')) {
          session.receipts.set(request.requestId, { payload, result: response.result });
          if (session.receipts.size > 8) session.receipts.delete(session.receipts.keys().next().value!);
        }
        return response;
      });
    });
    session.pending.set(request.requestId, { payload, promise }); session.tail = promise;
    try { return await promise; } finally { session.pending.delete(request.requestId); }
  }
  private async execute(session: Session, request: VisualizeBridgeRequest, payload: string, guard: Guard, bytes?: Uint8Array): Promise<unknown> {
    const current = guard(() => this.check(session));
    const receipt = session.receipts.get(request.requestId);
    if (receipt) { if (receipt.payload !== payload) reject('IDEMPOTENCY_CONFLICT', '同一请求标识不能使用不同内容。'); return receipt.result; }
    if (request.method === 'initialize') { session.value = await this.inputs.read(session.input); return guard(() => this.context(this.check(session), session)); }
    if (request.method === 'readInputs') {
      guard(() => this.expected(current, session, request));
      const value = await this.inputs.read(session.input, request.params.refresh, request.expected.inputVersion);
      return guard(() => { this.check(session); session.value = value; return { inputs: value.inputs, inputsChanged: value.inputsChanged, ...(value.inputError ? { inputError: visualizeProtocolError(value.inputError) } : {}) }; });
    }
    const namespace = principalNamespace(session), operation = { payload } as Json;
    const replay = guard(() => { if (this.readOnly(session)) reject('READ_ONLY', '当前页面只读。'); return this.pages.graphs.repo.replay(namespace, request.requestId, operation); });
    if (replay !== undefined) return replay;
    guard(() => this.expected(current, session, request));
    if (request.method === 'exportAsset') {
      if (!this.options.prepareAssetExport) reject('INPUT_BLOCKED', '当前工作空间尚未支持资产导出。');
      const prepared = await this.options.prepareAssetExport!(session.scope, session.nodeId, request, bytes!);
      try { return guard(() => atomic(this.pages.graphs.db, () => {
        this.expected(this.check(session), session, request);
        if (this.readOnly(session)) reject('READ_ONLY', '当前页面只读。');
        return this.pages.graphs.repo.idempotent(namespace, request.requestId, operation, () => {
          const result = prepared.commit(); validateVisualizeBridgeResponse(this.response(request, result)); return result as unknown as Json;
        });
      })); } finally { await prepared.dispose(); }
    }
    if (request.method === 'createSuccessors') {
      if (!this.options.prepareSuccessors) reject('INPUT_BLOCKED', '创建后继能力尚未接入当前工作空间。');
      const prepared = await this.options.prepareSuccessors!(session.scope, session.nodeId, request, session.principal);
      try { return guard(() => atomic(this.pages.graphs.db, () => { this.expected(this.check(session), session, request); if (this.readOnly(session)) reject('READ_ONLY', '当前页面只读。'); return this.pages.graphs.repo.idempotent(namespace, request.requestId, operation, () => { const result = prepared.commit(); validateVisualizeBridgeResponse(this.response(request, result)); return result as unknown as Json; }); })); }
      finally { await prepared.dispose(); }
    }
    if (request.method === 'requestLayout') return guard(() => atomic(this.pages.graphs.db, () => {
      this.expected(this.check(session), session, request);
      return this.pages.graphs.repo.idempotent(namespace, request.requestId, operation, () => {
        const graph = this.pages.graphs.command({ ...session.scope, idempotencyKey: request.requestId, expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: request.expected.layoutRevision, operations: [{ type: 'layout.resize', sizes: [{ nodeId: session.nodeId, ...request.params }] }] }, namespace);
        return { size: { width: request.params.width, height: request.params.height }, layoutRevision: graph.layoutRevision };
      });
    }));
    const write = { ...session.scope, nodeId: session.nodeId, idempotencyKey: request.requestId, expectedContentVersion: current.contentVersion, expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: current.layoutRevision, expectedPageRevision: session.pageRevision, ...(request.method === 'updateForm' ? { action: 'update-form', expectedFormVersion: request.expected.formVersion, form: request.params.form } : { action: 'save-state', expectedStateVersion: request.expected.stateVersion, state: request.params.state }) };
    const prepared = await this.pages.prepare(write, namespace);
    try {
      return guard(() => atomic(this.pages.graphs.db, () => {
        this.expected(this.check(session), session, request); if (this.readOnly(session)) reject('READ_ONLY', '当前页面只读。');
        return this.pages.graphs.repo.idempotent(namespace, request.requestId, operation, () => {
          const saved = this.pages.commit(prepared);
          return { ...(request.method === 'updateForm' ? { form: saved.content.form! } : { state: saved.content.state! }), revisions: this.revisions(saved, session) } as unknown as Json;
        });
      }));
    } finally { await this.pages.dispose(prepared); }
  }
}
function principalNamespace(session: Session): string { return session.principal + ':visualize.bridge:' + session.scope.graphId + ':' + session.nodeId + ':' + session.pageRevision; }
