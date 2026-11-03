import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DataDirectories } from '../../directories.js';
import type { AgentNativeSkill } from '../contracts.js';
import { parseSkillFrontmatter } from '../../builtin-skills.js';
import { AgentError } from '../errors.js';
import { publicText } from '../configuration.js';
import { isSkillName } from '@openworkgraph/protocol';

interface Entry { path: string; sha256: string; bytes: number; executable?: true }
interface Manifest { version: 1; skillId: string; source: 'project' | 'user'; scope: string; name: string; description: string; entries: Entry[] }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (owner: string, path: string) => { const value = relative(owner, path); return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
const invalid = (): never => { throw new AgentError('invalid_configuration', '本地技能目录或冻结内容不可读取。'); };
async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) return invalid();
}
async function localFile(path: string, maximum: number): Promise<{ content: Buffer; executable: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > maximum) return invalid();
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const chunk = await file.read(bytes, length, bytes.length - length, null); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    if (length > maximum) return invalid();
    const after = await file.stat(); if (info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.size !== after.size) return invalid();
    return { content: bytes.subarray(0, length), executable: (info.mode & 0o111) !== 0 };
  } finally { await file.close(); }
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  return (await localFile(path, maximum)).content;
}

/** Local directories have content-addressed identities, not package versions.
 * Every accepted catalog entry names a durable immutable copy of its resources. */
export class BuiltinLocalSkills {
  private readonly root: string;
  constructor(directories: DataDirectories, private readonly userHome = homedir()) { this.root = join(directories.config, 'builtin-local-skills'); }
  async list(projectPath: string, signal?: AbortSignal): Promise<AgentNativeSkill[]> {
    const project = await realpath(projectPath), home = await realpath(this.userHome);
    const all: AgentNativeSkill[] = [];
    for (const [source, owner, priority] of [['project', project, 1], ['user', home, 2]] as const) {
      const directory = join(owner, '.agents', 'skills'); let entries, canonical: string;
      try {
        canonical = await realpath(directory);
        // User skill managers commonly link .agents/skills to a directory in
        // the same home. Canonical scope and frozen bytes retain its identity.
        if (!inside(owner, canonical)) continue;
        entries = await readdir(canonical, { withFileTypes: true });
      } catch (error) { if (absent(error)) continue; return invalid(); }
      if (entries.length > 512) return invalid();
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        let manifest: Manifest;
        try {
          const path = join(canonical, entry.name), target = await realpath(path);
          if (!inside(owner, target) || !(await lstat(target)).isDirectory()) continue;
          manifest = await this.capture(target, source, hash(owner), signal);
          if (await realpath(directory) !== canonical || await realpath(path) !== target) continue;
        } catch (error) {
          signal?.throwIfAborted();
          // Invalid or unreadable unselected entries do not disable the whole
          // Agent. Explicit references must still match this usable catalog.
          if (error instanceof AgentError || ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        all.push({ skillId: manifest.skillId, name: manifest.name, description: manifest.description, priority });
        if (all.length > 512) return invalid();
      }
    }
    return all;
  }
  private async capture(directory: string, source: Manifest['source'], scope: string, signal?: AbortSignal): Promise<Manifest> {
    const entries: Entry[] = [], content = new Map<string, Buffer>(); let total = 0;
    const walk = async (path: string, depth = 0): Promise<void> => {
      signal?.throwIfAborted(); if (depth > 16) return invalid();
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        if (['.git', 'node_modules', '.DS_Store'].includes(child.name) || /^\.env(?:[.]|$)/.test(child.name)) continue;
        if (child.name.includes('\\') || child.name.includes(':') || child.isSymbolicLink()) return invalid();
        const file = join(path, child.name);
        if (child.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!child.isFile() || entries.length >= 256) return invalid();
        const { content: bytes, executable } = await localFile(file, 2 * 1024 * 1024); total += bytes.length; if (total > 8 * 1024 * 1024) return invalid();
        const name = relative(directory, file).split(sep).join('/'); content.set(name, bytes); entries.push({ path: name, sha256: hash(bytes), bytes: bytes.length, ...(executable ? { executable: true as const } : {}) });
      }
    };
    try { await walk(directory); } catch (error) { if (signal?.aborted) throw error; return invalid(); }
    const skill = content.get('SKILL.md'); if (!skill) return invalid();
    let metadata; try { metadata = parseSkillFrontmatter(new TextDecoder('utf8', { fatal: true }).decode(skill)); } catch { return invalid(); }
    metadata.description = metadata.description.replace(/\s+/gu, ' ').trim();
    if (!isSkillName(metadata.name) || !publicText(metadata.description, 4096)) return invalid();
    const digest = hash(JSON.stringify(entries));
    const skillId = 'local.' + source + '.' + scope + '.' + digest;
    const manifest: Manifest = { version: 1, skillId, source, scope, ...metadata, entries };
    await privateDirectory(this.root); const target = join(this.root, hash(skillId));
    try { const existing = await this.load(skillId); if (JSON.stringify(existing) !== JSON.stringify(manifest)) return invalid(); return existing; }
    catch (error) { if (!absent(error)) throw error; }
    const temporary = join(this.root, '.capture-' + randomUUID()); await mkdir(temporary, { mode: 0o700 });
    try {
      const packagePath = join(temporary, 'content'); await mkdir(packagePath, { mode: 0o700 });
      for (const entry of entries) { const file = join(packagePath, entry.path); await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, content.get(entry.path)!, { mode: 0o400, flag: 'wx' }); }
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o400, flag: 'wx' });
      try { await rename(temporary, target); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await this.load(skillId); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return manifest;
  }
  private async load(skillId: string): Promise<Manifest> {
    if (!/^local[.](?:project|user)[.][a-f0-9]{64}[.][a-f0-9]{64}$/.test(skillId)) return invalid();
    const directory = join(this.root, hash(skillId));
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) return invalid();
    const manifest = JSON.parse((await boundedFile(join(directory, 'manifest.json'), 128 * 1024)).toString('utf8')) as Manifest;
    if (manifest.version !== 1 || manifest.skillId !== skillId || !Array.isArray(manifest.entries) || manifest.entries.length > 256) return invalid();
    const prefix = 'local.' + manifest.source + '.' + manifest.scope + '.';
    if (prefix + hash(JSON.stringify(manifest.entries)) !== skillId) return invalid();
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.path !== 'string' || entry.path.split('/').some(part => !part || part === '.' || part === '..') || entry.path.includes('\\') || entry.path.includes(':') || entry.executable !== undefined && entry.executable !== true) return invalid();
      const path = join(directory, 'content', entry.path);
      const bytes = await boundedFile(path, 2 * 1024 * 1024);
      if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) return invalid();
    }
    return manifest;
  }
  async frozen(skillId: string, projectPath: string): Promise<{ name: string; description: string; source: Manifest['source'] }> {
    const manifest = await this.load(skillId);
    const owner = manifest.source === 'project' ? await realpath(projectPath) : await realpath(this.userHome);
    if (manifest.scope !== hash(owner)) return invalid();
    return { name: manifest.name, description: manifest.description, source: manifest.source };
  }
  async materialize(skillId: string, projectPath: string, inputPath: string): Promise<{ path: string; name: string; description: string; source: Manifest['source'] }> {
    const metadata = await this.frozen(skillId, projectPath), manifest = await this.load(skillId);
    const directory = join(inputPath, 'builtin-skills', hash(skillId));
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const destination = await lstat(directory); if (!destination.isDirectory() || destination.isSymbolicLink()) return invalid();
    for (const entry of manifest.entries) {
      const source = join(this.root, hash(skillId), 'content', entry.path), target = join(directory, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = await boundedFile(source, 2 * 1024 * 1024);
      try { await writeFile(target, bytes, { flag: 'wx', mode: entry.executable ? 0o500 : 0o400 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await localFile(target, 2 * 1024 * 1024);
        if (hash(existing.content) !== entry.sha256 || process.platform !== 'win32' && existing.executable !== (entry.executable === true)) return invalid();
      }
    }
    return { path: join(directory, 'SKILL.md'), ...metadata };
  }
}
