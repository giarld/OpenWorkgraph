import { constants, promises as fs } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import sharp from 'sharp';
import { videoThumbnail as extractVideoThumbnail } from './video-thumbnail.js';

const execFileAsync = promisify(execFile);

class ProjectFileIoSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active++;
    try { return await operation(); }
    finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
const projectFileIo = new ProjectFileIoSemaphore(8);
const videoThumbnailIo = new ProjectFileIoSemaphore(2);
const isVideoPath = (path: string): boolean => /[.](mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv)$/i.test(path);
export const PROJECT_FILE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const PROJECT_IMAGE_THUMBNAIL_LEVELS = [80, 160, 320, 640, 1280, 2560, 4096] as const;

export interface ProjectFileEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  hidden: boolean;
  bytes?: number;
}

export interface ProjectFileObservation {
  path: string;
  state: 'available' | 'missing' | 'unavailable';
  name: string;
  mime: string | null;
  bytes: number | null;
  changeToken: string | null;
}

export function classifyProjectFile(name: string): { mime: string; type: 'text' | 'image' | 'file' } {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime: Record<string, string> = { md:'text/markdown',markdown:'text/markdown',txt:'text/plain',json:'application/json',xml:'application/xml',yaml:'application/yaml',yml:'application/yaml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',csv:'text/csv',pdf:'application/pdf' };
  const videoMime: Record<string, string> = {mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',mkv:'video/x-matroska',avi:'video/x-msvideo'};
  const value = mime[extension] ?? videoMime[extension] ?? 'application/octet-stream';
  return { mime:value, type:['png','jpg','jpeg','gif','webp','svg'].includes(extension) ? 'image' : ['md','markdown','txt','json','xml','yaml','yml'].includes(extension) ? 'text' : 'file' };
}

export type HiddenFileReader = (directory: string) => Promise<ReadonlySet<string>>;

async function windowsHiddenFiles(directory: string): Promise<ReadonlySet<string>> {
  if (process.platform !== 'win32') return new Set();
  try {
    const { stdout } = await execFileAsync('attrib', [join(directory, '*')], { windowsHide:true, timeout:2_000, maxBuffer:1024*1024 });
    const hidden = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^([A-Z ]+?)\s{2,}(.+)$/.exec(line);
      if (match?.[1]?.includes('H')) hidden.add(basename(match[2]!.trim()).toLocaleLowerCase());
    }
    return hidden;
  } catch { return new Set(); }
}

interface ListCursor { v: 1; path: string; showHidden: boolean; fingerprint: string; offset: number }
interface SearchSession {
  projectId: string;
  query: string;
  showHidden: boolean;
  queue: string[];
  seen: Set<string>;
  currentDirectory: string | undefined;
  nextListCursor: string | null | undefined;
  pending: ProjectFileEntry[];
  pendingIndex: number;
  expiresAt: number;
}

function decodeListCursor(value: string): ListCursor {
  try {
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const cursor = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)) as Partial<ListCursor>;
    if (cursor.v !== 1 || typeof cursor.path !== 'string' || typeof cursor.showHidden !== 'boolean' || typeof cursor.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint) || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 1) throw new Error();
    return cursor as ListCursor;
  } catch { throw new ServiceError('INVALID_REQUEST', '文件分页游标无效。'); }
}

export function normalizeProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes(String.fromCharCode(0)) || value.includes(String.fromCharCode(92)) || isAbsolute(value) || value.startsWith('/') || /^[a-zA-Z]:/.test(value))
    throw new ServiceError('INVALID_REQUEST', '无效的项目相对路径。');
  if (!value) return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':')))
    throw new ServiceError('INVALID_REQUEST', '项目路径不得越界或包含空路径段。');
  return parts.join('/');
}

function inside(root: string, target: string): boolean {
  const rest = relative(root, target);
  return rest === '' || (rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest));
}

async function resizeImageThumbnail(bytes: Buffer, mime: string, size: number): Promise<{ bytes: Buffer; mime: string }> {
  const image = sharp(bytes, { animated:false });
  const info = await image.metadata();
  const maxDimension = Math.max(info.width ?? 0, info.height ?? 0);
  const target = PROJECT_IMAGE_THUMBNAIL_LEVELS.includes(size as typeof PROJECT_IMAGE_THUMBNAIL_LEVELS[number]) ? size : 320;
  if (maxDimension > 0 && maxDimension <= target) return { bytes, mime };
  return { bytes: await image.rotate().resize({ width:target, height:target, fit:'inside', withoutEnlargement:true }).webp({ quality:82 }).toBuffer(), mime:'image/webp' };
}

function linkedPath(value: unknown): { path: string; projectFallback: boolean } {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes(String.fromCharCode(0)))
    throw new ServiceError('INVALID_REQUEST', '无法查看此文件。');
  const raw = value.trim();
  if (/^file:/i.test(raw)) {
    try { return { path:fileURLToPath(new URL(raw)), projectFallback:false }; }
    catch { throw new ServiceError('INVALID_REQUEST', '无法查看此文件。'); }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !win32.isAbsolute(raw))
    throw new ServiceError('INVALID_REQUEST', '无法查看此文件。');
  const suffix = Math.min(...[raw.indexOf('?'), raw.indexOf('#')].filter(index => index >= 0), raw.length);
  let path: string;
  try { path = decodeURIComponent(raw.slice(0, suffix)); }
  catch { throw new ServiceError('INVALID_REQUEST', '无法查看此文件。'); }
  if (!path) throw new ServiceError('INVALID_REQUEST', '无法查看此文件。');
  return { path, projectFallback:!win32.isAbsolute(path) || path.startsWith('/') };
}

export class ProjectFiles {
  private readonly searches = new Map<string, SearchSession>();
  private readonly videoFrames = new Map<string, { bytes: Buffer; mime: string }>();
  constructor(private readonly db: DatabaseSync, private readonly hiddenFiles: HiddenFileReader = windowsHiddenFiles) {}

  private async root(projectId: string): Promise<string> {
    const row = this.db.prepare('SELECT canonical_path,state FROM projects WHERE id=?').get(projectId);
    if (!row) throw new ServiceError('NOT_FOUND', '项目不存在。');
    if (row['state'] !== 'active') throw new ServiceError('PROJECT_INACTIVE', '项目已停用。');
    try {
      const root = await fs.realpath(String(row['canonical_path']));
      if (root !== row['canonical_path'] || !(await fs.stat(root)).isDirectory()) throw new Error('Project root changed');
      return root;
    } catch (cause) { throw new ServiceError('PROJECT_UNAVAILABLE', '项目目录不可访问；请修复路径。', { cause }); }
  }

  async resolve(projectId: string, path: string, kind: 'file' | 'directory'): Promise<{ path: string; relativePath: string }> {
    const relativePath = normalizeProjectPath(path);
    const root = await this.root(projectId);
    let target: string;
    try { target = await fs.realpath(resolve(root, relativePath)); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('NOT_FOUND', '项目文件不存在。');
      throw new ServiceError('PROJECT_UNAVAILABLE', '项目文件不可访问。', { cause });
    }
    if (!inside(root, target)) throw new ServiceError('INVALID_REQUEST', '项目路径越界。');
    let stat;
    try { stat = await fs.stat(target); }
    catch (cause) { throw new ServiceError('PROJECT_UNAVAILABLE', '项目文件不可访问。', { cause }); }
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new ServiceError('INVALID_REQUEST', '项目路径类型不匹配。');
    return { path: target, relativePath };
  }

  async readRange(projectId: string, path: string, range?: { start: number; end?: number }, maxBytes = PROJECT_FILE_PREVIEW_MAX_BYTES): Promise<{ bytes: Buffer; start: number; end: number; total: number }> {
    return projectFileIo.run(() => this.readRangeImpl(projectId, path, range, maxBytes));
  }

  private async readRangeImpl(projectId: string, path: string, range?: { start: number; end?: number }, maxBytes = PROJECT_FILE_PREVIEW_MAX_BYTES): Promise<{ bytes: Buffer; start: number; end: number; total: number }> {
    const file = await this.resolve(projectId, path, 'file');
    const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ServiceError('INVALID_REQUEST', '项目路径不是普通文件。');
      const start = range?.start ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || (range?.end !== undefined && (!Number.isSafeInteger(range.end) || range.end < start))) throw new ServiceError('INVALID_REQUEST', '无效的文件读取范围。');
      if (range && start >= before.size) throw new ServiceError('INVALID_REQUEST', '文件读取范围超出内容长度。');
      const end = before.size === 0 ? -1 : Math.min(range?.end ?? before.size - 1, before.size - 1);
      const length = end < start ? 0 : end - start + 1;
      if (length > maxBytes || (!range && before.size > maxBytes)) throw new ServiceError('PAYLOAD_TOO_LARGE', '项目文件超过 50 MiB，无法预览。');
      const current = await this.resolve(projectId, path, 'file');
      const linked = await fs.stat(current.path);
      if (current.path !== file.path || linked.dev !== before.dev || linked.ino !== before.ino)
        throw new ServiceError('CONFLICT', '文件在读取前已变化，请重试。');
      const bytes = Buffer.alloc(length);
      if (length) {
        const result = await handle.read(bytes, 0, length, start);
        if (result.bytesRead !== length) throw new ServiceError('CONFLICT', '文件在读取期间已变化，请重试。');
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new ServiceError('CONFLICT', '文件在读取期间已变化，请重试。');
      return { bytes, start, end, total:before.size };
    } finally { await handle.close(); }
  }

  async read(projectId: string, path: string, maxBytes = PROJECT_FILE_PREVIEW_MAX_BYTES): Promise<Buffer> {
    return (await this.readRange(projectId, path, undefined, maxBytes)).bytes;
  }

  /** Verify a live binary deliverable without retaining its entire contents. */
  async fingerprint(projectId: string, path: string, expectedBytes: number): Promise<{ sha256: string; prefix: Buffer; changeToken: string }> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new ServiceError('INVALID_REQUEST', 'Invalid project output size');
    return projectFileIo.run(async () => {
      const file = await this.resolve(projectId, path, 'file');
      const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint:true });
        if (!before.isFile() || before.size !== BigInt(expectedBytes)) throw new ServiceError('INVALID_REQUEST', 'Project output size mismatch');
        const hash = createHash('sha256');
        const chunk = Buffer.alloc(1024 * 1024);
        const prefix = Buffer.alloc(Math.min(expectedBytes, 64 * 1024));
        let offset = 0;
        while (offset < expectedBytes) {
          const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expectedBytes - offset), offset);
          if (!bytesRead) throw new ServiceError('CONFLICT', 'Project output changed during verification');
          hash.update(chunk.subarray(0, bytesRead));
          if (offset < prefix.length) chunk.copy(prefix, offset, 0, Math.min(bytesRead, prefix.length - offset));
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint:true });
        const current = await this.resolve(projectId, path, 'file');
        const linked = await fs.stat(current.path, { bigint:true });
        if (current.path !== file.path || [after, linked].some(info => info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs))
          throw new ServiceError('CONFLICT', 'Project output changed during verification');
        return { sha256:hash.digest('hex'), prefix, changeToken:[before.dev,before.ino,before.size,before.mtimeNs].join(':') };
      } finally { await handle.close(); }
    });
  }

  async readLinkedFile(projectId: string, rawPath: unknown, runsDirectory: string, options: { metadataOnly?:boolean; range?:{start:number;end:number} } = {}): Promise<{ name:string; mime:string; bytes:Buffer; total:number; start:number; end:number; scope:'project'|'run'; relativePath?:string }> {
    return projectFileIo.run(async () => {
      const projectRoot = await this.root(projectId);
      let runsRoot: string;
      try { runsRoot = await fs.realpath(runsDirectory); }
      catch (cause) { throw new ServiceError('PROJECT_UNAVAILABLE', '无法查看此文件。', { cause }); }
      const input = linkedPath(rawPath);
      const candidates: string[] = [];
      if (isAbsolute(input.path) || win32.isAbsolute(input.path)) candidates.push(input.path);
      if (input.projectFallback) {
        const relativePath = input.path.replace(/^[\/]+/, '').replaceAll('\\', '/');
        try { candidates.push(resolve(projectRoot, normalizeProjectPath(relativePath))); }
        catch (error) { if (!candidates.length) throw error; }
      }
      if (!candidates.length) {
        const relativePath = input.path.replaceAll('\\', '/');
        candidates.push(resolve(projectRoot, normalizeProjectPath(relativePath)));
      }

      let target: string | undefined;
      let scope: 'project' | 'run' | undefined;
      for (const candidate of candidates) {
        try {
          const canonical = await fs.realpath(candidate);
          if (inside(projectRoot, canonical)) { target = canonical; scope = 'project'; break; }
          if (inside(runsRoot, canonical)) { target = canonical; scope = 'run'; break; }
          throw new ServiceError('INVALID_REQUEST', '无法查看此文件。');
        } catch (cause) {
          if (cause instanceof ServiceError) throw cause;
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new ServiceError('PROJECT_UNAVAILABLE', '无法查看此文件。', { cause });
        }
      }
      if (!target || !scope) throw new ServiceError('NOT_FOUND', '无法查看此文件。');

      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(cause => {
        throw new ServiceError('PROJECT_UNAVAILABLE', '无法查看此文件。', { cause });
      });
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new ServiceError('INVALID_REQUEST', '无法查看此文件。');
        if (!options.metadataOnly && !options.range && before.size > PROJECT_FILE_PREVIEW_MAX_BYTES) throw new ServiceError('PAYLOAD_TOO_LARGE', '文件超过 50 MiB，无法预览。');
        const canonical = await fs.realpath(target);
        const linked = await fs.stat(canonical);
        const allowed = scope === 'project' ? inside(projectRoot, canonical) : inside(runsRoot, canonical);
        if (!allowed || canonical !== target || linked.dev !== before.dev || linked.ino !== before.ino)
          throw new ServiceError('CONFLICT', '文件在读取前已变化，请重试。');
        const start = options.range?.start ?? 0;
        const end = Math.min(options.range?.end ?? before.size - 1, before.size - 1);
        if (options.range && (!Number.isSafeInteger(start) || !Number.isSafeInteger(options.range.end) || start < 0 || start >= before.size || end < start || end - start + 1 > 4 * 1024 * 1024)) throw new ServiceError('INVALID_REQUEST', '文件字节范围无效或超过 4 MiB。');
        const bytes = Buffer.alloc(options.metadataOnly ? 0 : Math.max(0, end - start + 1));
        if (bytes.length) {
          const result = await handle.read(bytes, 0, bytes.length, start);
          if (result.bytesRead !== bytes.length) throw new ServiceError('CONFLICT', '文件在读取期间已变化，请重试。');
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new ServiceError('CONFLICT', '文件在读取期间已变化，请重试。');
        const name = basename(target);
        return { name, mime:classifyProjectFile(name).mime, bytes, total:before.size, start, end, scope, ...(scope === 'project' ? { relativePath:relative(projectRoot,target).split(sep).join('/') } : {}) };
      } finally { await handle.close(); }
    });
  }

  async readLinkedImageThumbnail(projectId: string, rawPath: unknown, runsDirectory: string, size: number) {
    const file = await this.readLinkedFile(projectId, rawPath, runsDirectory);
    if (!file.mime.startsWith('image/')) throw new ServiceError('INVALID_REQUEST', '仅支持图片文件缩略图。');
    try {
      const thumbnail = await resizeImageThumbnail(file.bytes, file.mime, size);
      return { ...file, ...thumbnail };
    } catch (cause) {
      throw new ServiceError('INVALID_REQUEST', '无法生成图片缩略图。', { cause });
    }
  }

  async thumbnail(projectId: string, path: string, size: number = 320): Promise<{ bytes: Buffer; mime: string }> {
    const file = await this.resolve(projectId, path, 'file');
    if (isVideoPath(file.relativePath)) return videoThumbnailIo.run(() => this.videoThumbnail(projectId, file.relativePath, size));
    const classified = classifyProjectFile(file.relativePath);
    if (!classified.mime.startsWith('image/')) throw new ServiceError('INVALID_REQUEST', '仅支持图片或视频项目文件缩略图。');
    const bytes = await this.read(projectId, file.relativePath);
    return resizeImageThumbnail(bytes, classified.mime, size);
  }

  private async videoThumbnail(projectId: string, path: string, requestedSize: number): Promise<{ bytes: Buffer; mime: string }> {
    const size = [80, 160, 320].includes(requestedSize) ? requestedSize : 320;
    // Download tools commonly save an identically named cover alongside a video.
    // Resolve every candidate through the same project-boundary checks.
    const stem = path.slice(0, path.lastIndexOf('.'));
    for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
      try {
        const cover = await this.read(projectId, stem + '.' + extension, 8 * 1024 * 1024);
        return { bytes:await sharp(cover).rotate().resize({ width:size, height:size, fit:'inside', withoutEnlargement:true }).webp({ quality:75 }).toBuffer(), mime:'image/webp' };
      } catch { /* Missing, invalid or inaccessible covers fall back to a frame. */ }
    }
    const file = await this.resolve(projectId, path, 'file');
    const before = await fs.stat(file.path, { bigint:true });
    const key = [file.path,before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs,size].join(':');
    const cached = this.videoFrames.get(key);
    if (cached) return cached;
    try {
      // ffmpeg reads the local file directly; no full-video Buffer or HTTP download.
      const bytes = await extractVideoThumbnail(file.path, size);
      const current = await this.resolve(projectId, path, 'file');
      const after = await fs.stat(current.path, { bigint:true });
      if (current.path !== file.path || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
        throw new ServiceError('CONFLICT', '视频文件在生成封面时已变化，请重试。');
      const result = { bytes, mime:'image/webp' };
      if (this.videoFrames.size >= 32) this.videoFrames.delete(this.videoFrames.keys().next().value!);
      this.videoFrames.set(key, result);
      return result;
    } catch (cause) {
      throw new ServiceError('INVALID_REQUEST', '无法生成视频封面；请提供同名图片封面，或确认运行时可使用 FFmpeg。', { cause });
    }
  }

  async list(projectId: string, path: string, showHidden: boolean, limit = 200, cursor?: string | null): Promise<{ path: string; items: ProjectFileEntry[]; nextCursor: string | null }> {
    return projectFileIo.run(() => this.listImpl(projectId, path, showHidden, limit, cursor));
  }

  private async listImpl(projectId: string, path: string, showHidden: boolean, limit = 200, cursor?: string | null): Promise<{ path: string; items: ProjectFileEntry[]; nextCursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (cursor !== undefined && cursor !== null && typeof cursor !== 'string')) throw new ServiceError('INVALID_REQUEST', '无效的文件分页参数。');
    const { path: directory, relativePath } = await this.resolve(projectId, path, 'directory');
    const names = await fs.readdir(directory, { withFileTypes: true });
    const entries: ProjectFileEntry[] = [];
    const fingerprints: string[] = [];
    const root = await this.root(projectId);
    const platformHidden = await this.hiddenFiles(directory);
    for (const entry of names) {
      const hidden = entry.name.startsWith('.') || platformHidden.has(entry.name.toLocaleLowerCase());
      if (hidden && !showHidden) continue;
      const childPath = relativePath ? relativePath + '/' + entry.name : entry.name;
      try {
        const target = await fs.realpath(join(directory, entry.name));
        if (!inside(root, target)) continue;
        const stat = await fs.stat(target);
        if (!stat.isFile() && !stat.isDirectory()) continue;
        entries.push({ name: entry.name, relativePath: childPath, kind: stat.isDirectory() ? 'directory' : 'file', hidden, ...(stat.isFile() ? { bytes: stat.size } : {}) });
        fingerprints.push([entry.name,stat.isDirectory()?'d':'f',Number(hidden),stat.size,stat.mtimeMs].join('\u0000'));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new ServiceError('PROJECT_UNAVAILABLE', '项目目录读取失败，请重试。', { cause });
      }
    }
    entries.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
    fingerprints.sort();
    const fingerprint = createHash('sha256').update(fingerprints.join('\u0001')).digest('hex');
    const decoded = cursor ? decodeListCursor(cursor) : undefined;
    if (decoded && (decoded.path !== relativePath || decoded.showHidden !== showHidden)) throw new ServiceError('INVALID_REQUEST', '文件分页游标不属于当前目录或筛选条件。');
    if (decoded && decoded.fingerprint !== fingerprint) throw new ServiceError('CURSOR_EXPIRED', '目录内容已变化，请从第一页重新读取。');
    const offset = decoded?.offset ?? 0;
    if (offset > entries.length) throw new ServiceError('CURSOR_EXPIRED', '目录内容已变化，请从第一页重新读取。');
    const next = offset + limit;
    const nextCursor = next < entries.length ? Buffer.from(JSON.stringify({ v:1,path:relativePath,showHidden,fingerprint,offset:next } satisfies ListCursor)).toString('base64url') : null;
    return { path: relativePath, items: entries.slice(offset, next), nextCursor };
  }

  async search(projectId: string, query: string, showHidden: boolean, limit = 50, cursor?: string | null, signal?: AbortSignal): Promise<{ items: ProjectFileEntry[]; hasMore: boolean; nextCursor: string | null }> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery || normalizedQuery.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && cursor !== null && typeof cursor !== 'string'))
      throw new ServiceError('INVALID_REQUEST', '无效的文件搜索参数。');
    const now = Date.now();
    for (const [key, value] of this.searches) if (value.expiresAt <= now) this.searches.delete(key);
    let token = cursor ?? randomUUID();
    let session = cursor ? this.searches.get(cursor) : undefined;
    if (cursor && !session) throw new ServiceError('CURSOR_EXPIRED', '文件搜索游标已过期，请重新搜索。');
    if (session && (session.projectId !== projectId || session.query !== normalizedQuery || session.showHidden !== showHidden))
      throw new ServiceError('INVALID_REQUEST', '文件搜索游标不属于当前查询。');
    if (!session) {
      session = { projectId, query:normalizedQuery, showHidden, queue:[''], seen:new Set(), currentDirectory:undefined, nextListCursor:undefined, pending:[], pendingIndex:0, expiresAt:now + 120_000 };
      this.searches.set(token, session);
    }
    const items: ProjectFileEntry[] = [];
    const startedAt = Date.now();
    let scanned = 0;
    try {
      while (items.length < limit && scanned < 2_000 && Date.now() - startedAt < 100) {
        if (signal?.aborted) throw new ServiceError('CONFLICT', '项目文件搜索已取消。');
        if (session.pendingIndex < session.pending.length) {
          const item = session.pending[session.pendingIndex++]!;
          scanned++;
          if (item.kind === 'directory') session.queue.push(item.relativePath);
          if (item.name.toLocaleLowerCase().includes(session.query) || item.relativePath.toLocaleLowerCase().includes(session.query)) items.push(item);
          if (session.pendingIndex >= session.pending.length && session.nextListCursor === null) session.currentDirectory = undefined;
          continue;
        }
        session.pending = [];
        session.pendingIndex = 0;
        if (session.currentDirectory !== undefined && session.nextListCursor) {
          const page = await this.list(projectId, session.currentDirectory, showHidden, 200, session.nextListCursor);
          session.pending = page.items;
          session.nextListCursor = page.nextCursor;
          continue;
        }
        session.currentDirectory = undefined;
        session.nextListCursor = undefined;
        let directory: string | undefined;
        while (session.queue.length && directory === undefined) {
          const candidate = session.queue.shift()!;
          const canonical = (await this.resolve(projectId, candidate, 'directory')).path;
          if (!session.seen.has(canonical)) { session.seen.add(canonical); directory = candidate; }
        }
        if (directory === undefined) break;
        session.currentDirectory = directory;
        const page = await this.list(projectId, directory, showHidden, 200);
        session.pending = page.items;
        session.nextListCursor = page.nextCursor;
        if (!session.pending.length && session.nextListCursor === null) session.currentDirectory = undefined;
      }
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'CURSOR_EXPIRED') this.searches.delete(token);
      throw error;
    }
    session.expiresAt = Date.now() + 120_000;
    const hasMore = session.pendingIndex < session.pending.length || session.currentDirectory !== undefined || session.queue.length > 0;
    if (!hasMore) this.searches.delete(token);
    return { items, hasMore, nextCursor:hasMore ? token : null };
  }

  async stat(projectId: string, paths: string[]): Promise<ProjectFileObservation[]> {
    return projectFileIo.run(() => this.statImpl(projectId, paths));
  }

  private async statImpl(projectId: string, paths: string[]): Promise<ProjectFileObservation[]> {
    if (!Array.isArray(paths) || paths.length > 100) throw new ServiceError('INVALID_REQUEST', '最多校验 100 个路径。');
    const observations = await Promise.all(paths.map(async path => {
      const normalized = normalizeProjectPath(path);
      if (!normalized) throw new ServiceError('INVALID_REQUEST', '状态校验需要文件路径。');
      const name = normalized.split('/').at(-1)!;
      const mime = classifyProjectFile(name).mime;
      try {
        const resolved = await this.resolve(projectId, normalized, 'file');
        const info = await fs.stat(resolved.path, { bigint: true });
        return { path:normalized, state:'available' as const, name, mime, bytes:Number(info.size), changeToken:[info.dev,info.ino,info.size,info.mtimeNs].join(':') };
      } catch (error) {
        if (error instanceof ServiceError && (error.code === 'NOT_FOUND' || error.code === 'INVALID_REQUEST' && error.message === '项目路径类型不匹配。')) return { path:normalized, state:'missing' as const, name, mime, bytes:null, changeToken:null };
        if (error instanceof ServiceError && error.code === 'INVALID_REQUEST') throw error;
        return { path:normalized, state:'unavailable' as const, name, mime, bytes:null, changeToken:null };
      }
    }));
    atomic(this.db, () => {
      const statement = this.db.prepare('INSERT INTO project_file_observations(project_id,relative_path,state,name,mime,bytes,change_token,observed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,relative_path) DO UPDATE SET state=excluded.state,name=excluded.name,mime=excluded.mime,bytes=excluded.bytes,change_token=excluded.change_token,observed_at=excluded.observed_at');
      const observedAt = Date.now();
      for (const item of observations) statement.run(projectId,item.path,item.state,item.name,item.mime,item.bytes,item.changeToken,observedAt);
    });
    return observations;
  }
}
