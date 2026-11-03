import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentError } from '../errors.js';

export interface BuiltinProjectRule { directory: string; path: string; content: string; sha256: string }
export const pathInside = (root: string, path: string): boolean => {
  const child = relative(root, path); return child === '' || !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
};
async function source(directory: string, name: string): Promise<BuiltinProjectRule | null> {
  const path = join(directory, name); let file;
  try {
    // Windows has no O_NOFOLLOW guarantee. Refuse linked/reparse entries before
    // opening, and keep the handle check for hardlinks on every platform.
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new AgentError('invalid_configuration');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024) throw new AgentError('invalid_configuration');
    const buffer = Buffer.alloc(128 * 1024 + 1); let size = 0;
    while (size < buffer.length) { const chunk = await file.read(buffer, size, buffer.length - size, null); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
    if (size > 128 * 1024) throw new AgentError('invalid_configuration');
    const bytes = buffer.subarray(0, size), content = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    return { directory, path, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AgentError('invalid_configuration', '项目协作规则不可读取。');
  } finally { await file?.close(); }
}
/** Root-to-leaf scope. Missing AGENTS alone allows CLAUDE fallback; unreadable
 * AGENTS is an error. @references stay literal and never expand host authority. */
export async function builtinProjectRules(projectPath: string, targetPath = projectPath, signal?: AbortSignal): Promise<BuiltinProjectRule[]> {
  const root = await realpath(projectPath);
  let target = targetPath;
  try { target = await realpath(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AgentError('permission_denied');
    // A new file still belongs to its canonical existing parent, including OS
    // aliases such as /var -> /private/var. No nonexistent child rules exist.
    try { target = join(await realpath(dirname(target)), basename(target)); } catch { throw new AgentError('invalid_configuration'); }
  }
  // Text/visualize cwd may live under Run; ownership still loads project root.
  if (!pathInside(root, target)) target = root;
  else { try { if (!(await stat(target)).isDirectory()) target = dirname(target); } catch { target = dirname(target); } }
  const directories: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    if (!pathInside(root, current) || directories.length >= 128) throw new AgentError('invalid_configuration');
    directories.unshift(current); if (current === root) break;
  }
  const rules: BuiltinProjectRule[] = []; let bytes = 0;
  for (const directory of directories) {
    signal?.throwIfAborted();
    const rule = await source(directory, 'AGENTS.md') ?? await source(directory, 'CLAUDE.md');
    if (rule) { bytes += Buffer.byteLength(rule.content); if (bytes > 256 * 1024) throw new AgentError('invalid_configuration'); rules.push(rule); }
  }
  return rules;
}
