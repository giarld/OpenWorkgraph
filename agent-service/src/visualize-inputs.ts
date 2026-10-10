import { createHash } from 'node:crypto';
import type { GraphScope, Json, VisualizeInputSnapshot, VisualizeProjectFileSnapshot } from '@openworkgraph/protocol';
import { Graphs } from './graphs.js';
import { InputPreparation } from './inputs.js';
import { Resources } from './resources.js';
import { ProjectFiles, classifyProjectFile } from './project-files.js';
import { canonicalJson } from './persistence/repositories.js';
import { atomic } from './persistence/database.js';
import { ServiceError } from './errors.js';

export interface VisualizeInputSession { readonly nodeId: string }
interface Session { scope: GraphScope; nodeId: string; pageRevision: number; inputs: VisualizeInputSnapshot }
export interface VisualizeInputRead {
  inputs: VisualizeInputSnapshot;
  inputsChanged: boolean;
  inputError?: { code: string; message: string };
}
const TEXT_INPUT_MAX_BYTES = 8 * 1024 * 1024;
const INPUT_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
/** Host-owned read capabilities; refresh changes only the session's input snapshot. */
export class VisualizeInputs {
  private readonly sessions = new WeakMap<VisualizeInputSession, Session>();
  private readonly preparation: InputPreparation;
  private readonly projectFiles: ProjectFiles;
  constructor(readonly graphs: Graphs, readonly resources: Resources) {
    if (graphs.db !== resources.db) throw new Error('Visualize inputs require a shared database');
    this.preparation = new InputPreparation(graphs.db, { readRepresentation: resource => resources.readPreparedRepresentation(resource) });
    this.projectFiles = new ProjectFiles(graphs.db);
  }
  private identity(scope: GraphScope, nodeId: string): number {
    this.graphs.scope(scope);
    const node = this.graphs.db.prepare('SELECT n.type,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(nodeId, scope.graphId);
    if (!node || node['type'] !== 'visualize') throw new ServiceError('NOT_FOUND', '可视化节点不存在。');
    return Number(JSON.parse(String(node['content'])).page?.revision ?? 0);
  }
  /** Generation reads current inputs; an interaction session retains them until refresh. */
  async capture(scope: GraphScope, nodeId: string): Promise<VisualizeInputSnapshot> {
    if (this.graphs.db.isTransaction) throw new Error('Visualize input preparation must run outside transactions');
    scope = structuredClone(scope);
    const initial = atomic(this.graphs.db, () => { this.identity(scope, nodeId); return this.preparation.visualizeInputs(scope.graphId, nodeId); });
    const inputs = structuredClone(initial.inputs);
    const verified = new Set<string>();
    for (const input of inputs) for (const envelope of input.resources) {
      const resource = envelope.resource;
      if (!resource) continue;
      const key = resource.resourceId + ':' + resource.version;
      if (verified.has(key)) continue;
      const path = this.graphs.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(resource.sha256);
      if (!path) throw new ServiceError('INPUT_BLOCKED', '资产文件不存在。');
      await this.resources.withBlobLease(() => this.resources.blobs.withVerifiedFile(String(path.path), resource, async () => undefined));
      verified.add(key);
    }
    const files = new Map<string, VisualizeProjectFileSnapshot>();
    let total = [...new Map(inputs.flatMap(input => input.resources).map(resource => [canonicalJson(resource as unknown as Json), resource])).values()].reduce((bytes, resource) => bytes + Buffer.byteLength(resource.text ?? ''), 0);
    for (const input of inputs) {
      for (const file of input.projectFiles ?? []) {
        const key = canonicalJson({ kind: file.kind, path: file.relativePath });
        if (files.has(key)) continue;
        const mime = classifyProjectFile(file.relativePath).mime;
        if ((file.kind === 'image' || file.kind === 'video') && !mime.startsWith(file.kind + '/')) throw new ServiceError('INPUT_BLOCKED', '项目文件类型与节点声明不一致。');
        const isText = file.kind === 'text' || mime.startsWith('text/') || mime === 'application/json';
        if (!isText) {
          const observation = (await this.projectFiles.stat(scope.projectId, [file.relativePath]))[0]!;
          if (observation.state !== 'available' || observation.bytes === null) throw new ServiceError('INPUT_BLOCKED', '项目资产不存在或不可读：' + file.relativePath);
          const fingerprint = await this.projectFiles.fingerprint(scope.projectId, file.relativePath, observation.bytes);
          files.set(key, { relativePath: file.relativePath, kind: file.kind, mime, bytes: observation.bytes, sha256: fingerprint.sha256, changeToken: fingerprint.changeToken, text: null,
            asset: { format: 'openworkgraph.asset-reference', version: 1, kind: 'project-file', relativePath: file.relativePath, mode: 'live' } });
          continue;
        }
        const maxBytes = Math.min(isText ? TEXT_INPUT_MAX_BYTES : INPUT_TOTAL_MAX_BYTES, Math.max(0, INPUT_TOTAL_MAX_BYTES - total));
        let bytes: Buffer;
        try { bytes = await this.projectFiles.read(scope.projectId, file.relativePath, maxBytes); }
        catch (error) {
          if (error instanceof ServiceError && error.code === 'PAYLOAD_TOO_LARGE') {
            throw new ServiceError('INPUT_BUDGET_EXCEEDED', isText && maxBytes === TEXT_INPUT_MAX_BYTES
              ? '交互页面的单项文本输入超过 8 MiB。'
              : '交互页面的参考输入合计超过 32 MiB。', { details: { relativePath: file.relativePath, maxBytes } });
          }
          throw error;
        }
        total += bytes.length;
        let text: string | null = null;
        if (isText) {
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
          catch { throw new ServiceError('INPUT_BLOCKED', '项目文件文本不是有效 UTF-8。'); }
        }
        const observation = (await this.projectFiles.stat(scope.projectId, [file.relativePath]))[0]!;
        const fingerprint = await this.projectFiles.fingerprint(scope.projectId, file.relativePath, bytes.length);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (fingerprint.sha256 !== sha256 || fingerprint.changeToken !== observation.changeToken) throw new ServiceError('REVISION_CONFLICT', '项目文件在读取过程中变化，请重试。');
        files.set(key, { relativePath: file.relativePath, kind: file.kind, mime, bytes: bytes.length, sha256, text, changeToken: fingerprint.changeToken,
          asset: { format: 'openworkgraph.asset-reference', version: 1, kind: 'project-file', relativePath: file.relativePath, mode: 'live' } });
      }
      if (input.projectFiles?.length) input.projectFileData = input.projectFiles.map(file => files.get(canonicalJson({ kind: file.kind, path: file.relativePath }))!);
    }
    // No stale graph/edge/resource selection may be accepted after asynchronous reads.
    atomic(this.graphs.db, () => {
      this.identity(scope, nodeId);
      if (this.preparation.visualizeInputs(scope.graphId, nodeId).digest !== initial.digest) throw new ServiceError('REVISION_CONFLICT', '前驱输入在读取过程中变化，请重试。');
    });
    const digest = createHash('sha256').update(canonicalJson({ graphId: scope.graphId, nodeId, inputs } as unknown as Json)).digest('hex');
    return immutable({ version: 1, digest, inputs });
  }
  async open(scope: GraphScope, nodeId: string): Promise<{ session: VisualizeInputSession; value: VisualizeInputRead }> {
    scope = structuredClone(scope);
    const pageRevision = this.identity(scope, nodeId), inputs = await this.capture(scope, nodeId);
    if (this.identity(scope, nodeId) !== pageRevision) throw new ServiceError('REVISION_CONFLICT', '页面在输入初始化期间变化。');
    const session = Object.freeze({ nodeId });
    this.sessions.set(session, { scope: structuredClone(scope), nodeId, pageRevision, inputs });
    return { session, value: { inputs, inputsChanged: false } };
  }
  async read(token: VisualizeInputSession, refresh = false, expectedInputVersion?: number): Promise<VisualizeInputRead> {
    const session = this.sessions.get(token);
    if (!session) throw new ServiceError('CONFLICT', '输入会话已失效。');
    if (typeof refresh !== 'boolean' || refresh && (!Number.isSafeInteger(expectedInputVersion) || expectedInputVersion !== session.inputs.version)) throw new ServiceError('REVISION_CONFLICT', '输入版本已变化，请读取当前会话。');
    this.check(token, session);
    const version = session.inputs.version;
    let latest: VisualizeInputSnapshot;
    try { latest = await this.capture(session.scope, session.nodeId); }
    catch (error) {
      this.check(token, session);
      if (refresh || !(error instanceof ServiceError)) throw error;
      return { inputs: session.inputs, inputsChanged: true, inputError: { code: error.code, message: error.message } };
    }
    this.check(token, session);
    if (refresh && session.inputs.version !== version) throw new ServiceError('REVISION_CONFLICT', '并发刷新已推进输入版本。');
    const changed = latest.digest !== session.inputs.digest;
    if (refresh && changed) session.inputs = immutable({ ...latest, version: version + 1 });
    return { inputs: session.inputs, inputsChanged: !refresh && changed };
  }
  private check(token: VisualizeInputSession, session: Session): void {
    if (this.sessions.get(token) !== session || this.identity(session.scope, session.nodeId) !== session.pageRevision) throw new ServiceError('CONFLICT', '页面或输入会话已变化，请重新初始化。');
  }
  close(token: VisualizeInputSession): void { this.sessions.delete(token); }
}
