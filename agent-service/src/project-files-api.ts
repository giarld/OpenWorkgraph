import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Auth } from './auth.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { ProjectFiles, classifyProjectFile, normalizeProjectPath, PROJECT_IMAGE_THUMBNAIL_LEVELS } from './project-files.js';
import type { ApiResult } from './api.js';
import { Graphs } from './graphs.js';
import { randomUUID } from 'node:crypto';
import type { Resources } from './resources.js';
import { Repositories } from './persistence/repositories.js';
import { atomic } from './persistence/database.js';
import type { Json } from '@openworkgraph/protocol';

export class ProjectFilesApi {
  private readonly files: ProjectFiles;
  constructor(private readonly db: DatabaseSync, private readonly auth: Auth, private readonly graphs: Graphs, private readonly resources: Resources, private readonly runsDirectory: string) { this.files = new ProjectFiles(db); }

  async handle(request: IncomingMessage, rawPath: string, token: string, origin: string): Promise<ApiResult> {
    const url = new URL(rawPath, 'http://localhost');
    const detach = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]nodes[/]([a-zA-Z0-9_-]+)[/]detach$/.exec(url.pathname);
    if (detach && request.method === 'POST') {
      const body = await readJson(request, 2 * 1024 * 1024);
      if (Object.keys(body).some(key => !['expectedContentVersion','expectedExecutionRevision','expectedLayoutRevision','expectedObservationToken','content','idempotencyKey'].includes(key))
        || !Number.isSafeInteger(body['expectedContentVersion']) || !Number.isSafeInteger(body['expectedExecutionRevision']) || !Number.isSafeInteger(body['expectedLayoutRevision'])
        || typeof body['expectedObservationToken'] !== 'string' || typeof body['idempotencyKey'] !== 'string' || !body['content'] || typeof body['content'] !== 'object' || Array.isArray(body['content']))
        throw new ServiceError('INVALID_REQUEST', '解除引用需要正文、节点版本、观察标记和幂等键。');
      const content = body['content'] as Record<string, Json>;
      if (typeof content.text !== 'string') throw new ServiceError('INVALID_REQUEST', '首版仅支持文本引用在编辑时解除引用。');
      const principal = this.auth.withSession(token, origin, current => current.id);
      const scope = { serviceId:this.graphs.serviceId, projectId:detach[1]!, graphId:detach[2]! };
      const replayScope = principal + ':project-file.detach:' + scope.graphId;
      const replay = new Repositories(this.db).replay(replayScope, body['idempotencyKey'] as string, body as Json);
      if (replay !== undefined) return { handled:true, body:replay };
      const snapshot = this.graphs.snapshot(scope);
      const node = snapshot.nodes.find(item => item.id === detach[3]);
      if (!node || node.type !== 'text' || node.contentVersion !== body['expectedContentVersion'] || !node.content || typeof node.content !== 'object' || Array.isArray(node.content)) throw new ServiceError('REVISION_CONFLICT', '引用文本节点已变化。');
      const old = node.content as Record<string, Json>, source = old.source;
      if (!source || typeof source !== 'object' || Array.isArray(source) || source.kind !== 'project-file' || source.projectId !== scope.projectId || typeof source.relativePath !== 'string') throw new ServiceError('INVALID_REQUEST', '目标节点不是当前项目的文本引用。');
      const observation = (await this.files.stat(scope.projectId, [source.relativePath]))[0]!;
      if (observation.state !== 'available') throw new ServiceError(observation.state === 'missing' ? 'NOT_FOUND' : 'PROJECT_UNAVAILABLE', observation.state === 'missing' ? '项目文件已不存在，不能基于旧内容解除引用。' : '项目文件当前不可用。');
      if (observation.changeToken !== body['expectedObservationToken']) throw new ServiceError('CONFLICT', '项目文件自预览后已变化，请重新打开后再编辑。');
      const mime = typeof old.mime === 'string' ? old.mime : observation.mime ?? 'text/plain';
      const title = typeof content.title === 'string' && content.title.trim() ? content.title : typeof old.title === 'string' ? old.title : observation.name;
      const prepared = await this.resources.prepareBytes(Buffer.from(content.text, 'utf8'), mime);
      let consumed = false;
      try {
        const result = new Repositories(this.db).idempotent(replayScope, body['idempotencyKey'] as string, body as Json, () => atomic(this.db, () => {
          const latest = this.graphs.snapshot(scope).nodes.find(item => item.id === detach[3]);
          if (!latest || latest.contentVersion !== body['expectedContentVersion'] || !latest.content || typeof latest.content !== 'object' || Array.isArray(latest.content)) throw new ServiceError('REVISION_CONFLICT', '引用文本节点已变化。');
          const latestSource = (latest.content as Record<string, Json>).source;
          const latestObservation = (latest.content as Record<string, Json>).observation;
          if (!latestSource || typeof latestSource !== 'object' || Array.isArray(latestSource) || latestSource.kind !== 'project-file' || latestSource.relativePath !== source.relativePath
            || !latestObservation || typeof latestObservation !== 'object' || Array.isArray(latestObservation) || latestObservation.changeToken !== body['expectedObservationToken'])
            throw new ServiceError('CONFLICT', '引用来源或观察标记已变化。');
          const created = this.resources.createCanvasFromPrepared(scope, prepared, title);
          consumed = true;
          const independent = { ...old, ...content, title, resourceId:created.resource.id, resourceVersion:created.resource.current.version, mime:created.resource.current.mime, bytes:created.resource.current.bytes } as Record<string, Json>;
          delete independent.source;
          delete independent.observation;
          return this.graphs.command({ ...scope, idempotencyKey:'detach-'+body['idempotencyKey'], expectedExecutionRevision:Number(body['expectedExecutionRevision']), expectedLayoutRevision:Number(body['expectedLayoutRevision']), operations:[{ type:'node.content', nodeId:detach[3]!, expectedContentVersion:Number(body['expectedContentVersion']), content:independent }] }, principal) as unknown as Json;
        }));
        if (!consumed) atomic(this.db, () => { this.resources.discardPrepared(prepared); });
        return { handled:true, body:result };
      } catch (error) {
        if (!consumed) atomic(this.db, () => { this.resources.discardPrepared(prepared); });
        throw error;
      }
    }
    const associate = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]project-files[/]associate$/.exec(url.pathname);
    if (associate && request.method === 'POST') {
      this.auth.withSession(token, origin, () => undefined);
      const body = await readJson(request, 16 * 1024);
      if (Object.keys(body).some(key => !['path','nodeId','expectedContentVersion','expectedExecutionRevision','expectedLayoutRevision','idempotencyKey'].includes(key)) || typeof body['path'] !== 'string' || typeof body['nodeId'] !== 'string' || typeof body['idempotencyKey'] !== 'string' || !Number.isSafeInteger(body['expectedContentVersion']) || !Number.isSafeInteger(body['expectedExecutionRevision']) || !Number.isSafeInteger(body['expectedLayoutRevision'])) throw new ServiceError('INVALID_REQUEST', '关联空引用需要路径、节点和版本。');
      const scope = { serviceId:this.graphs.serviceId, projectId:associate[1]!, graphId:associate[2]! };
      const snapshot = this.graphs.snapshot(scope);
      const node = snapshot.nodes.find(item => item.id === body['nodeId']);
      if (!node || node.contentVersion !== body['expectedContentVersion'] || !node.content || typeof node.content !== 'object' || Array.isArray(node.content)) throw new ServiceError('REVISION_CONFLICT', '空引用节点已变化。');
      const source = node.content.source;
      if (!source || typeof source !== 'object' || Array.isArray(source) || source.kind !== 'project-file-empty') throw new ServiceError('INVALID_REQUEST', '目标节点不是空引用节点。');
      const file = await this.files.resolve(associate[1]!, body['path'], 'file');
      const observation = (await this.files.stat(associate[1]!, [file.relativePath]))[0]!;
      if (observation.state !== 'available') throw new ServiceError('PROJECT_UNAVAILABLE', '项目文件当前不可读。');
      const name = file.relativePath.split('/').at(-1)!;
      const classified = classifyProjectFile(name);
      const content = { title:name, text:'', prompt:'', mime:classified.mime, bytes:observation.bytes, source:{ kind:'project-file', serviceId:this.graphs.serviceId, projectId:associate[1]!, relativePath:file.relativePath }, observation:{ state:'available', name, mime:classified.mime, bytes:observation.bytes, changeToken:observation.changeToken } };
      const result = this.auth.withSession(token, origin, current => this.graphs.command({ ...scope, idempotencyKey:body['idempotencyKey'] as string, expectedExecutionRevision:Number(body['expectedExecutionRevision']), expectedLayoutRevision:Number(body['expectedLayoutRevision']), operations:[{ type:'node.project-file.associate', nodeId:node.id, expectedContentVersion:node.contentVersion, nodeType:classified.type, content }] }, current.id));
      return { handled:true, body:result };
    }
    const create = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]project-files$/.exec(url.pathname);
    if (create && request.method === 'POST') {
      this.auth.withSession(token, origin, () => undefined);
      const body = await readJson(request, 16 * 1024);
      if (Object.keys(body).some(key => !['path','x','y','expectedExecutionRevision','expectedLayoutRevision','idempotencyKey'].includes(key)) || typeof body['path'] !== 'string' || typeof body['x'] !== 'number' || typeof body['y'] !== 'number' || typeof body['idempotencyKey'] !== 'string' || !Number.isSafeInteger(body['expectedExecutionRevision']) || !Number.isSafeInteger(body['expectedLayoutRevision'])) throw new ServiceError('INVALID_REQUEST', '创建项目文件引用需要路径、落点、版本和幂等键。');
      const file = await this.files.resolve(create[1]!, body['path'], 'file');
      const observation = (await this.files.stat(create[1]!, [file.relativePath]))[0]!;
      if (observation.state !== 'available') throw new ServiceError('PROJECT_UNAVAILABLE', '项目文件当前不可读。');
      const name = file.relativePath.split('/').at(-1)!;
      const classified = classifyProjectFile(name);
      const result = this.auth.withSession(token, origin, current => this.graphs.command({ serviceId:this.graphs.serviceId, projectId:create[1]!, graphId:create[2]!, idempotencyKey:body['idempotencyKey'] as string, expectedExecutionRevision:Number(body['expectedExecutionRevision']), expectedLayoutRevision:Number(body['expectedLayoutRevision']), operations:[{ type:'node.create', node:{ id:randomUUID(), type:classified.type, schemaVersion:1, contentVersion:1, content:{ title:name, text:'', prompt:'', mime:classified.mime, bytes:observation.bytes, source:{ kind:'project-file', serviceId:this.graphs.serviceId, projectId:create[1]!, relativePath:file.relativePath }, observation:{ state:'available', name, mime:classified.mime, bytes:observation.bytes, changeToken:observation.changeToken } }, x:Number(body['x']), y:Number(body['y']), width:300, height:220, readOnly:false } }] }, current.id));
      return { handled:true, body:result };
    }
    const match = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]files(?:[/](search|stat|content|media|thumbnail|link-preview))?$/.exec(url.pathname);
    if (!match) return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    const projectId = match[1]!, action = match[2] ?? 'list';
    if (action === 'link-preview' && request.method === 'POST') {
      const body = await readJson(request, 16 * 1024);
      if (typeof body['path'] !== 'string' || Object.keys(body).some(key => !['path', 'thumbnailSize'].includes(key)) || (body['thumbnailSize'] !== undefined && ![640, 1280].includes(body['thumbnailSize'] as number))) throw new ServiceError('INVALID_REQUEST', '需要有效的文件路径和缩略图尺寸。');
      const result = body['thumbnailSize'] === undefined
        ? await this.files.readLinkedFile(projectId, body['path'], this.runsDirectory)
        : await this.files.readLinkedImageThumbnail(projectId, body['path'], this.runsDirectory, body['thumbnailSize'] as number);
      this.auth.withSession(token, origin, () => undefined);
      return { handled:true, body:{ name:result.name, mime:result.mime, bytes:result.bytes.length, base64:result.bytes.toString('base64'), scope:result.scope, ...(result.relativePath ? { relativePath:result.relativePath } : {}) } };
    }
    if (action === 'stat' && request.method === 'POST') {
      const body = await readJson(request, 16 * 1024);
      if (Object.keys(body).length !== 1 || !Array.isArray(body['paths'])) throw new ServiceError('INVALID_REQUEST', '需要 paths 数组。');
      const result = await this.files.stat(projectId, body['paths'] as string[]);
      this.auth.withSession(token, origin, () => undefined);
      return { handled: true, body: result };
    }
    if (request.method !== 'GET') throw new ServiceError('NOT_FOUND', '项目文件接口不存在。');
    const allowed = action === 'search' ? ['query', 'showHidden', 'cursor', 'limit'] : ['content', 'media', 'thumbnail'].includes(action) ? ['path', 'cacheKey', ...(action === 'thumbnail' ? ['size'] : [])] : ['path', 'showHidden', 'cursor', 'limit'];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1))
      throw new ServiceError('INVALID_REQUEST', '项目文件查询参数无效。');
    const showHidden = url.searchParams.get('showHidden') === 'true';
    if (url.searchParams.has('showHidden') && !['true', 'false'].includes(url.searchParams.get('showHidden')!)) throw new ServiceError('INVALID_REQUEST', 'showHidden 必须是布尔值。');
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : action === 'search' ? 50 : 200;
    const cursor = url.searchParams.get('cursor');
    if (action === 'list') {
      const result = await this.files.list(projectId, url.searchParams.get('path') ?? '', showHidden, limit, cursor);
      this.auth.withSession(token, origin, () => undefined);
      return { handled: true, body: result };
    }
    if (action === 'content') {
      const path = normalizeProjectPath(url.searchParams.get('path'));
      if (!path) throw new ServiceError('INVALID_REQUEST', '需要文件路径。');
      const header = request.headers.range;
      let range: { start:number; end?:number } | undefined;
      if (header) {
        const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(header);
        if (!match) throw new ServiceError('INVALID_REQUEST', '仅支持单个明确起点的字节范围。');
        range = { start:Number(match[1]), ...(match[2] ? { end:Number(match[2]) } : {}) };
      }
      const content = await this.files.readRange(projectId, path, range);
      this.auth.withSession(token, origin, () => undefined);
      if (range) return { handled:true, binary:content.bytes, status:206, headers:{ 'Content-Type':classifyProjectFile(path).mime, 'Content-Length':String(content.bytes.length), 'Accept-Ranges':'bytes', 'Content-Range':'bytes '+content.start+'-'+content.end+'/'+content.total, 'X-Content-Type-Options':'nosniff' } };
      return { handled: true, body: { path, bytes: content.bytes.length, base64: content.bytes.toString('base64') } };
    }
    if (action === 'media') {
      if (request.headers.range) throw new ServiceError('INVALID_REQUEST', '图片原图不接受 Range。');
      const path = normalizeProjectPath(url.searchParams.get('path'));
      if (!path) throw new ServiceError('INVALID_REQUEST', '需要文件路径。');
      const classified = classifyProjectFile(path);
      if (!classified.mime.startsWith('image/')) throw new ServiceError('INVALID_REQUEST', '仅支持图片项目文件原图。');
      const content = await this.files.readRange(projectId, path);
      this.auth.withSession(token, origin, () => undefined);
      return { handled:true, binary:content.bytes, status:200, headers:{ 'Content-Type':classified.mime, 'Content-Length':String(content.bytes.length), 'Cache-Control':'private, max-age=31536000, immutable', 'Content-Disposition':'inline', 'X-Content-Type-Options':'nosniff' } };
    }
    if (action === 'thumbnail') {
      if (request.headers.range) throw new ServiceError('INVALID_REQUEST', '缩略图不接受 Range。');
      const path = normalizeProjectPath(url.searchParams.get('path'));
      if (!path) throw new ServiceError('INVALID_REQUEST', '需要文件路径。');
      const requestedSize = url.searchParams.get('size');
      const size = requestedSize === null ? 320 : Number(requestedSize);
      if (!(PROJECT_IMAGE_THUMBNAIL_LEVELS as readonly number[]).includes(size)) throw new ServiceError('INVALID_REQUEST', '无效的缩略图尺寸。');
      const thumbnail = await this.files.thumbnail(projectId, path, size);
      this.auth.withSession(token, origin, () => undefined);
      return { handled:true, binary:thumbnail.bytes, status:200, headers:{ 'Content-Type':thumbnail.mime, 'Content-Length':String(thumbnail.bytes.length), 'Cache-Control':'private, max-age=31536000, immutable', 'X-Content-Type-Options':'nosniff' } };
    }
    if (action === 'search') {
      const query = url.searchParams.get('query')?.trim() ?? '';
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.once('aborted', cancel);
      let result;
      try { result = await this.files.search(projectId, query, showHidden, limit, cursor, controller.signal); }
      finally { request.off('aborted', cancel); }
      this.auth.withSession(token, origin, () => undefined);
      return { handled: true, body: result };
    }
    return { handled: false };
  }
}
