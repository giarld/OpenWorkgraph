import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SkillSource } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { GitHubSkillSource, SKILL_LIMITS, safeSkillPath, type SkillSourceProvider, type SkillSourceSnapshot } from './skill-source.js';

const execute = promisify(execFile);
export function skillSourceFromUrl(value: string): SkillSource {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ServiceError('INVALID_REQUEST', '请输入公开 Git 仓库的 HTTPS 链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || /[\x00-\x20\x7f]/.test(value.trim())) throw new ServiceError('INVALID_REQUEST', '请输入不含凭据的公开 Git 仓库 HTTPS 链接。');
  const suppliedPath = url.pathname.replace(/\/+$/, '');
  const path = suppliedPath.replace(/\.git$/, '');
  if (!path || path === '/' || path.split('/').slice(1).some(part => !part || part === '.' || part === '..') || url.hostname === 'github.com' && path.split('/').length !== 3 || /\/-\/(tree|blob|commit|commits)\//.test(path)) throw new ServiceError('INVALID_REQUEST', '请使用仓库根链接，不要使用文件或分支页面链接。');
  url.pathname = url.hostname === 'github.com' ? path : suppliedPath;
  const repository = url.toString().replace(/\/$/, '');
  return { id: url.hostname === 'github.com' ? 'github:' + path.slice(1) : 'git:' + repository.replace(/\.git$/, ''), repository, branch: 'HEAD', directory: 'skills' };
}

/** Public HTTPS Git sources, independent of any hosting vendor API. */
export class GitSkillSource implements SkillSourceProvider {
  private readonly github = new GitHubSkillSource();
  private readonly pending = new Map<string, Promise<SkillSourceSnapshot>>();
  constructor(private readonly root: string, private readonly executeGit = execute) {}
  private directory(source: SkillSource): string {
    skillSourceFromUrl(source.repository);
    return join(this.root, createHash('sha256').update(source.repository).digest('hex'));
  }
  private async git(path: string, args: string[], bytes = 16 * 1024 * 1024): Promise<Buffer> {
    try {
      const result = await this.executeGit('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-C', path, ...args], { encoding: 'buffer', timeout: SKILL_LIMITS.catalogMs, maxBuffer: bytes, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
      return result.stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('NOT_FOUND', '读取此技能库需要在工作空间主机安装 Git。');
      throw new ServiceError('NOT_FOUND', '无法读取公开 Git 技能库，请检查仓库地址及工作空间网络。', { retryable: true });
    }
  }
  snapshot(source: SkillSource): Promise<SkillSourceSnapshot> {
    if (/^https:\/\/github\.com\//.test(source.repository)) return this.github.snapshot(source);
    const key = JSON.stringify(source);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.fetch(source).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
  private async fetch(source: SkillSource): Promise<SkillSourceSnapshot> {
    safeSkillPath(source.directory);
    const path = this.directory(source);
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await this.git(path, ['init', '--bare']);
    // Fetching without a remote name also prevents a stored remote URL from being trusted.
    await this.git(path, ['fetch', '--depth=1', '--no-tags', '--', source.repository, source.branch]);
    const commitSha = (await this.git(path, ['rev-parse', 'FETCH_HEAD'])).toString('utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new ServiceError('INVALID_REQUEST', '技能来源提交无效。');
    let kind: string;
    try { kind = (await this.git(path, ['cat-file', '-t', commitSha + ':' + source.directory])).toString('utf8').trim(); }
    catch { throw new ServiceError('INVALID_REQUEST', '技能库根目录必须包含 skills 子目录。'); }
    if (kind !== 'tree') throw new ServiceError('INVALID_REQUEST', '技能库根目录必须包含 skills 子目录。');
    // Keep pinned commits reachable when subsequent refreshes fetch a different HEAD.
    await this.git(path, ['update-ref', 'refs/openworkgraph/' + commitSha, commitSha]);
    const tree = (await this.git(path, ['ls-tree', '-r', '-l', '-z', commitSha, '--', source.directory + '/'])).toString('utf8');
    const packages = new Map<string, SkillSourceSnapshot['packages'][number]['files']>();
    for (const row of tree.split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(row);
      if (!match) throw new ServiceError('INVALID_REQUEST', '技能库目录结构无效。');
      const relative = match[5]!.slice(source.directory.length + 1), slash = relative.indexOf('/');
      if (slash < 1) continue;
      const directory = relative.slice(0, slash);
      const files = packages.get(directory) ?? [];
      files.push({ path: relative.slice(slash + 1), mode: match[1]!, sha: match[3]!, size: Number(match[4]) });
      packages.set(directory, files);
      if (packages.size > 500 || files.length > SKILL_LIMITS.files) throw new ServiceError('PAYLOAD_TOO_LARGE', '技能库目录或文件数量超过限制。');
    }
    return { commitSha, packages: [...packages].map(([directory, files]) => ({ directory, files })) };
  }
  async read(source: SkillSource, commitSha: string, path: string): Promise<Uint8Array> {
    if (/^https:\/\/github\.com\//.test(source.repository)) return this.github.read(source, commitSha, path);
    safeSkillPath(path);
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new ServiceError('INVALID_REQUEST', '技能来源提交无效。');
    return this.git(this.directory(source), ['show', commitSha + ':' + path], SKILL_LIMITS.fileBytes);
  }
}
