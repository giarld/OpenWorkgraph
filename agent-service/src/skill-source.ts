import { createHash } from 'node:crypto';
import type { SkillSource } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
export const DEFAULT_SKILL_SOURCE: SkillSource = { id: 'github:giarld/workgraph-skills', repository: 'https://github.com/giarld/workgraph-skills', branch: 'master', directory: 'skills' };
export const SKILL_LIMITS = { files: 2000, packageBytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, metadataBytes: 1024 * 1024, requestMs: 15_000, catalogMs: 60_000, installMs: 180_000 };
export interface SkillSourceFile { path: string; sha: string; size: number; mode: string }
export interface SkillSourcePackage { directory: string; files: SkillSourceFile[] }
export interface SkillSourceSnapshot { commitSha: string; packages: SkillSourcePackage[] }
export interface SkillSourceProvider {
  snapshot(source: SkillSource): Promise<SkillSourceSnapshot>;
  read(source: SkillSource, commitSha: string, path: string): Promise<Uint8Array>;
}
export function safeSkillPath(path: string): string {
  if (!path || path.length > 1024 || path.includes('\\') || path.includes('\0') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f]/.test(part))) throw new ServiceError('INVALID_REQUEST', '技能包包含无效或越界路径。');
  return path;
}
export function gitBlobSha(bytes: Uint8Array): string { return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'); }
export function packageDigest(files: SkillSourceFile[]): string {
  return createHash('sha256').update(JSON.stringify([...files].sort((a,b) => a.path.localeCompare(b.path)).map(({path,sha,mode,size}) => [path,sha,mode,size]))).digest('hex');
}
export function validatePackageFiles(pkg: SkillSourcePackage): void {
  safeSkillPath(pkg.directory);
  if (pkg.directory.includes('/') || pkg.files.length > SKILL_LIMITS.files) throw new ServiceError('INVALID_REQUEST', '技能包目录或文件数量无效。');
  const paths = new Set<string>(); let total = 0;
  for (const file of pkg.files) {
    safeSkillPath(file.path);
    if (paths.has(file.path) || !['100644','100755'].includes(file.mode) || !/^[a-f0-9]{40}$/.test(file.sha) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > SKILL_LIMITS.fileBytes) throw new ServiceError('INVALID_REQUEST', '技能包包含重复文件、链接或无效文件元数据。');
    paths.add(file.path); total += file.size;
  }
  if (total > SKILL_LIMITS.packageBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', '技能包超过大小限制。');
  for (const path of paths) for (let parent = path.substring(0,path.lastIndexOf('/')); parent; parent = parent.substring(0,parent.lastIndexOf('/'))) if (paths.has(parent)) throw new ServiceError('INVALID_REQUEST', '技能包文件与目录冲突。');
  if (!['SKILL.md','README.md','config.json'].every(path => paths.has(path))) throw new ServiceError('INVALID_REQUEST', '技能包必须包含 SKILL.md、README.md 和 config.json。');
}
async function boundedFetch(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SKILL_LIMITS.requestMs), redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenWorkgraph' } });
  if (!response.ok) throw new ServiceError('NOT_FOUND', response.status === 403 || response.status === 429 ? '技能来源限流，请稍后重试。' : '无法读取技能来源，请检查来源或网络。', { retryable: true });
  if (Number(response.headers.get('content-length')) > limit) throw new ServiceError('PAYLOAD_TOO_LARGE', '技能下载超过大小限制。');
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new ServiceError('INVALID_REQUEST', '技能下载响应为空。');
  const reader = response.body.getReader();
  try { for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new ServiceError('PAYLOAD_TOO_LARGE', '技能下载超过大小限制。'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
function repository(source: SkillSource): string {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(source.repository);
  if (!match) throw new ServiceError('INVALID_REQUEST', '技能来源必须是公开 GitHub 仓库。');
  safeSkillPath(source.directory);
  return match[1] + '/' + match[2];
}
export class GitHubSkillSource implements SkillSourceProvider {
  async snapshot(source: SkillSource): Promise<SkillSourceSnapshot> {
    const repo = repository(source);
    const commit = JSON.parse((await boundedFetch('https://api.github.com/repos/' + repo + '/commits/' + encodeURIComponent(source.branch), 1024 * 1024)).toString()) as {sha?: unknown};
    if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new ServiceError('INVALID_REQUEST', '技能来源提交无效。');
    const tree = JSON.parse((await boundedFetch('https://api.github.com/repos/' + repo + '/git/trees/' + commit.sha + '?recursive=1', 16 * 1024 * 1024)).toString()) as {truncated?: boolean; tree?: Array<{path: string; sha: string; mode: string; size?: number; type: string}>};
    if (tree.truncated || !Array.isArray(tree.tree)) throw new ServiceError('INVALID_REQUEST', '技能来源目录不完整，不能安装截断的包。');
    const packages = new Map<string, SkillSourceFile[]>();
    for (const file of tree.tree) {
      if (!file.path.startsWith(source.directory + '/') || file.type === 'tree') continue;
      const relative = file.path.slice(source.directory.length + 1); const slash = relative.indexOf('/');
      if (slash < 1) continue;
      const directory = relative.slice(0,slash); const files = packages.get(directory) ?? []; packages.set(directory,files);
      files.push({path: relative.slice(slash+1),sha:file.sha,mode:file.mode,size:file.size ?? -1});
    }
    if (packages.size > 500) throw new ServiceError('PAYLOAD_TOO_LARGE', '技能来源目录数量超过限制。');
    return {commitSha:commit.sha,packages:[...packages].map(([directory,files]) => ({directory,files}))};
  }
  async read(source: SkillSource, commitSha: string, path: string): Promise<Uint8Array> {
    const repo = repository(source); safeSkillPath(path);
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new ServiceError('INVALID_REQUEST', '技能来源提交无效。');
    return boundedFetch('https://raw.githubusercontent.com/' + repo + '/' + commitSha + '/' + path.split('/').map(encodeURIComponent).join('/'), SKILL_LIMITS.fileBytes);
  }
}
