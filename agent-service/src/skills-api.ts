import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Auth } from './auth.js';
import { ServiceError } from './errors.js';
import { StdioRpc } from './backend/stdio.js';
import { initialize } from './backend/capabilities.js';
import type { WorkflowRuntime } from './runtime.js';
import type { ApiResult } from './api.js';

export interface SkillCandidate { name: string; description: string; }

const validName = (name: string) => /^[\w.:-]+$/.test(name);

function collectCodexSkills(value: unknown): SkillCandidate[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw Error('Invalid skill catalog');
  const result: SkillCandidate[] = [];
  for (const entry of (value as { data: unknown[] }).data) {
    if (!entry || typeof entry !== 'object' || !Array.isArray((entry as { skills?: unknown }).skills)) continue;
    for (const raw of (entry as { skills: unknown[] }).skills) {
      if (!raw || typeof raw !== 'object') continue;
      const skill = raw as Record<string, unknown>;
      if (skill.enabled === false || typeof skill.name !== 'string' || !validName(skill.name)) continue;
      result.push({ name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' });
    }
  }
  return result;
}

async function fallbackSkills(cwd: string): Promise<SkillCandidate[]> {
  const home = homedir();
  const roots = [join(home, '.agents', 'skills'), join(cwd, '.agents', 'skills'), join(home, '.codex', 'skills'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'skills')] : []), join(cwd, '.codex', 'skills')];
  const result: SkillCandidate[] = [];
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 500)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (!validName(name)) continue;
      try {
        const file = await fs.realpath(join(root, name, 'SKILL.md'));
        if (basename(file) !== 'SKILL.md') continue;
        if ((await fs.stat(file)).size > 128 * 1024) continue;
        const content = await fs.readFile(file, 'utf8');
        const description = /^description:\s*["']?(.+?)["']?\s*$/m.exec(content)?.[1] ?? '';
        result.push({ name, description });
      } catch { /* Ignore incomplete or unreadable skills. */ }
    }
  }
  return result;
}

export class SkillsApi {
  private readonly cache = new Map<string, { expires: number; value: Promise<SkillCandidate[]> }>();
  constructor(private readonly db: DatabaseSync, private readonly auth: Auth, private readonly runtime: WorkflowRuntime) {}

  private load(cwd: string): Promise<SkillCandidate[]> {
    const cached = this.cache.get(cwd);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = (async () => {
      const options = this.runtime.options.backendOptions ?? {};
      let rpc: StdioRpc | undefined;
      try {
        rpc = new StdioRpc({ cwd, ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { args: options.args } : {}), timeoutMs: options.timeoutMs ?? 5000 });
        await initialize(rpc);
        return collectCodexSkills(await rpc.request('skills/list', { cwds: [cwd], forceReload: false }));
      } catch {
        return fallbackSkills(cwd);
      } finally { rpc?.close(); }
    })();
    this.cache.set(cwd, { expires: Date.now() + 30_000, value });
    void value.catch(() => this.cache.delete(cwd));
    return value;
  }

  async handle(request: IncomingMessage, rawPath: string, token: string, origin: string): Promise<ApiResult> {
    const url = new URL(rawPath, 'http://localhost');
    const match = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/skills\/search$/.exec(url.pathname);
    if (!match) return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    if (request.method !== 'GET' || [...url.searchParams.keys()].some(key => key !== 'query') || url.searchParams.getAll('query').length > 1) throw new ServiceError('INVALID_REQUEST', '无效的技能查询。');
    const row = this.db.prepare("SELECT canonical_path FROM projects WHERE id=? AND state='active'").get(match[1]!);
    if (!row || typeof row.canonical_path !== 'string') throw new ServiceError('NOT_FOUND', '项目不存在或未激活。');
    const cwd = resolve(row.canonical_path);
    const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
    if (query.length > 100) throw new ServiceError('INVALID_REQUEST', '技能查询过长。');
    const candidates = await this.load(cwd);
    this.auth.withSession(token, origin, () => undefined);
    const seen = new Set<string>();
    const items = candidates.filter(item => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return !query || item.name.toLocaleLowerCase().includes(query) || item.description.toLocaleLowerCase().includes(query);
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
    return { handled: true, body: { items } };
  }
}
