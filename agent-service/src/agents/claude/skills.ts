import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { isSkillName } from '@openworkgraph/protocol';
import type { FrozenSkill } from '@openworkgraph/protocol';
import type { AgentNativeSkill, AgentQueryContext } from '../contracts.js';
import { publicText } from '../configuration.js';
import { AgentError } from '../errors.js';

/** Device-private discovery options, never a browser configuration schema.
 * configDir is the same private configuration home used by the native launch. */
export interface ClaudeSkillDiscoveryOptions { cwd?: string; configDir?: string }
interface PrivateSkill extends AgentNativeSkill { path: string }
const maximumBytes = 128 * 1024;
const identity = (path: string) => 'claude-' + createHash('sha256').update(path).digest('hex');
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
const reserved = (name: string) => name.toLowerCase() === 'synced' || name.toLowerCase() === 'anthropic-skills' || name.toLowerCase().startsWith('anthropic-skills:');

async function readEntry(directory: string, folderName: string, signal: AbortSignal): Promise<PrivateSkill | undefined> {
  signal.throwIfAborted();
  try {
    // Directory symlinks are supported; entry files must stay inside the
    // declared skill directory's canonical target.
    const base = await realpath(directory), path = await realpath(join(base, 'SKILL.md'));
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || basename(path) !== 'SKILL.md') return;
    const info = await lstat(path);
    if (!info.isFile() || info.size > maximumBytes) return;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let content: string;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > maximumBytes || opened.dev !== info.dev || opened.ino !== info.ino) return;
      const buffer = Buffer.alloc(maximumBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > maximumBytes) return;
      content = buffer.subarray(0, size).toString('utf8');
    } finally { await file.close(); }
    signal.throwIfAborted();
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    let metadata: Record<string, unknown> = {};
    if (match) {
      const document = parseDocument(match[1]!, { uniqueKeys: true });
      // Fail closed for malformed metadata rather than guessing visibility.
      if (document.errors.length) return;
      const value = document.toJS({ maxAliasCount: 32 });
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      metadata = value;
    }
    const name = metadata.name === undefined ? folderName : metadata.name;
    if (!isSkillName(name) || reserved(name) || metadata['user-invocable'] === false) return;
    const body = match ? content.slice(match[0].length) : content;
    const rawDescription = typeof metadata.description === 'string' ? metadata.description.trim() : body.trim().split(/\r?\n/)[0] ?? '';
    const description = publicText(rawDescription, 4096) ? rawDescription : '';
    return { skillId: identity(path), name, description, path };
  } catch {
    signal.throwIfAborted();
    // Incomplete/unreadable entries cannot provide a usable native identity.
    return;
  }
}

async function projectDirectories(cwd: string, signal: AbortSignal): Promise<string[]> {
  const result: string[] = [];
  let directory = cwd;
  while (true) {
    signal.throwIfAborted();
    result.push(join(directory, '.claude', 'skills'));
    try { await lstat(join(directory, '.git')); break; } catch (error) { if (!missing(error)) throw new AgentError('runtime_unavailable'); }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // Root commands win over nested unqualified commands. Directory-qualified
  // aliases are outside this catalog until the host supports their names.
  return result.reverse();
}

async function catalog(options: ClaudeSkillDiscoveryOptions, context: AgentQueryContext): Promise<PrivateSkill[]> {
  context.signal.throwIfAborted();
  const cwd = context.projectPath ?? options.cwd ?? process.cwd();
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (!isAbsolute(cwd) || !isAbsolute(configDir)) throw new AgentError('invalid_configuration');
  let canonicalCwd: string;
  try { canonicalCwd = await realpath(cwd); if (!(await stat(canonicalCwd)).isDirectory()) throw new Error(); }
  catch { context.signal.throwIfAborted(); throw new AgentError('runtime_unavailable'); }
  // Official precedence: enterprise > personal > project. This filesystem
  // discovery covers personal and project SKILL.md only; it does not claim
  // managed settings, plugin commands or synced account skills are loaded.
  const roots = [join(configDir, 'skills'), ...await projectDirectories(canonicalCwd, context.signal)];
  const result: PrivateSkill[] = [], names = new Set<string>(), paths = new Set<string>();
  let inspected = 0;
  for (const root of roots) {
    context.signal.throwIfAborted();
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (missing(error)) continue; context.signal.throwIfAborted(); throw new AgentError('runtime_unavailable'); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      context.signal.throwIfAborted();
      if (!entry.isDirectory() && !entry.isSymbolicLink() || !isSkillName(entry.name) || reserved(entry.name)) continue;
      if (++inspected > 4096) throw new AgentError('protocol_error');
      const skill = await readEntry(join(root, entry.name), entry.name, context.signal);
      if (!skill || names.has(skill.name) || paths.has(skill.path)) continue;
      names.add(skill.name); paths.add(skill.path); result.push(skill);
      if (result.length > 512) throw new AgentError('protocol_error');
    }
  }
  context.signal.throwIfAborted();
  return result;
}

/** Wire into extensions.nativeSkills.list. No CLI, inference or host spawn. */
export async function claudeNativeSkills(options: ClaudeSkillDiscoveryOptions, context: AgentQueryContext): Promise<AgentNativeSkill[]> {
  return (await catalog(options, context)).map(({ skillId, name, description }) => ({ skillId, name, description }));
}

/** Re-resolve the exact private identity at launch; no same-name substitution.
 * Resolution provides readable entries, not proof of native dynamic dispatch. */
export async function resolveClaudeSkills(skills: readonly FrozenSkill[], options: ClaudeSkillDiscoveryOptions, context: AgentQueryContext): Promise<FrozenSkill[]> {
  if (skills.some(skill => skill.source === 'codex' || skill.source === 'agent' && skill.backendId !== 'claude-code')) throw new AgentError('invalid_configuration');
  const native = skills.some(skill => skill.source === 'agent') ? await catalog(options, context) : [];
  return skills.map(skill => {
    context.signal.throwIfAborted();
    if (skill.source !== 'agent') return structuredClone(skill);
    const item = native.find(item => item.skillId === skill.skillId && item.name === skill.name);
    if (!item || skill.path && skill.path !== item.path) throw new AgentError('invalid_configuration');
    return { ...structuredClone(skill), path: item.path };
  });
}
