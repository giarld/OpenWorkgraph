import { isSkillName } from '@openworkgraph/protocol';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { SkillCandidate } from '@openworkgraph/protocol';
import type { AdapterOptions } from './backend/adapter.js';
import { parseSkillFrontmatter } from './builtin-skills.js';
import { Auth } from './auth.js';
import { ServiceError } from './errors.js';
import { StdioRpc } from './backend/stdio.js';
import { initialize } from './backend/capabilities.js';
import type { WorkflowRuntime } from './runtime.js';
import type { ApiResult } from './api.js';

export type { SkillCandidate } from '@openworkgraph/protocol';
export type DiscoveredSkill = SkillCandidate & {path:string};

const validName = isSkillName;
const uniqueSkills = (items: DiscoveredSkill[]) => [...new Map(items.map(item=>[item.skillId,item])).values()];

function collectCodexSkills(value: unknown): DiscoveredSkill[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw Error('Invalid skill catalog');
  const result: DiscoveredSkill[] = [];
  for (const entry of (value as { data: unknown[] }).data) {
    if (!entry || typeof entry !== 'object' || !Array.isArray((entry as { skills?: unknown }).skills)) continue;
    for (const raw of (entry as { skills: unknown[] }).skills) {
      if (!raw || typeof raw !== 'object') continue;
      const skill = raw as Record<string, unknown>;
      if (skill.enabled === false || typeof skill.name !== 'string' || !validName(skill.name)) continue;
      if (typeof skill.path !== 'string' || !isAbsolute(skill.path) || basename(skill.path) !== 'SKILL.md') continue;
      const path = resolve(skill.path);
      result.push({ skillId:'codex:' + path,source:'codex',path,name: skill.name, description: typeof skill.description === 'string' ? skill.description : '' });
    }
  }
  return result;
}

async function fallbackSkills(cwd: string): Promise<DiscoveredSkill[]> {
  const home = homedir();
  const roots = [join(home, '.agents', 'skills'), join(cwd, '.agents', 'skills'), join(home, '.codex', 'skills'), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'skills')] : []), join(cwd, '.codex', 'skills')];
  const result: DiscoveredSkill[] = [];
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
        const metadata = parseSkillFrontmatter(content);
        result.push({skillId:'codex:' + file,source:'codex',path:file,...metadata});
      } catch { /* Ignore incomplete or unreadable skills. */ }
    }
  }
  return result;
}

/** Exact paths are frozen at submission so explicit Codex identities cannot be replaced by name. */
export async function discoverCodexSkills(cwd: string, options: AdapterOptions = {}): Promise<DiscoveredSkill[]> {
  let rpc: StdioRpc | undefined;
  try {
    rpc = new StdioRpc({cwd,...(options.executable ? {executable:options.executable} : {}),...(options.args ? {args:options.args} : {}),timeoutMs:options.timeoutMs ?? 5000});
    await initialize(rpc);
    const candidates = collectCodexSkills(await rpc.request('skills/list',{cwds:[cwd],forceReload:false}));
    const result: DiscoveredSkill[] = [];
    for (const item of candidates) {
      try { const path = await fs.realpath(item.path); if (basename(path) === 'SKILL.md' && (await fs.stat(path)).isFile()) result.push({...item,path,skillId:'codex:' + path}); }
      catch { /* Unreadable skills cannot be frozen. */ }
    }
    return uniqueSkills(result);
  } catch { return uniqueSkills(await fallbackSkills(cwd)); }
  finally { rpc?.close(); }
}

export class SkillsApi {
  private readonly cache = new Map<string, { expires: number; value: Promise<SkillCandidate[]> }>();
  constructor(private readonly db: DatabaseSync, private readonly auth: Auth, private readonly runtime: WorkflowRuntime) {}

  private load(cwd: string): Promise<SkillCandidate[]> {
    const cached = this.cache.get(cwd);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = discoverCodexSkills(cwd,this.runtime.options.backendOptions ?? {});
    this.cache.set(cwd, { expires: Date.now() + 30_000, value });
    void value.catch(() => this.cache.delete(cwd));
    return value;
  }

  async handle(request: IncomingMessage, rawPath: string, token: string, origin: string): Promise<ApiResult> {
    const url = new URL(rawPath, 'http://localhost');
    const match = /^\/v1\/projects\/([a-zA-Z0-9_-]+)\/skills(\/search)?$/.exec(url.pathname);
    if (!match) return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    const search = !!match[2];
    if (request.method !== 'GET' || [...url.searchParams.keys()].some(key => !search || key !== 'query') || url.searchParams.getAll('query').length > 1) throw new ServiceError('INVALID_REQUEST', '无效的技能查询。');
    const row = this.db.prepare("SELECT canonical_path FROM projects WHERE id=? AND state='active'").get(match[1]!);
    if (!row || typeof row.canonical_path !== 'string') throw new ServiceError('NOT_FOUND', '项目不存在或未激活。');
    const cwd = resolve(row.canonical_path);
    const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
    if (query.length > 100) throw new ServiceError('INVALID_REQUEST', '技能查询过长。');
    const [codex,builtin] = await Promise.all([this.load(cwd),this.runtime.skills.installed()]);
    const candidates: SkillCandidate[] = [...builtin.map(item=>({skillId:item.skillId,source:'openworkgraph' as const,name:item.name,description:item.description})),...codex];
    this.auth.withSession(token, origin, () => undefined);
    const seen = new Set<string>();
    const items = candidates.filter(item => {
      if (seen.has(item.skillId)) return false;
      seen.add(item.skillId);
      return !query || item.name.toLocaleLowerCase().includes(query) || item.description.toLocaleLowerCase().includes(query);
    }).sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'openworkgraph' ? -1 : 1));
    // Search suggestions are bounded; existence checks need the complete catalog.
    const visible = search ? items.slice(0, 100) : items;
    return { handled: true, body: { items:visible.map(({skillId,source,name,description})=>({skillId,source,name,description})) } };
  }
}
