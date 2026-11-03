import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync, readdirSync, mkdirSync, fchmodSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import type { BackendRunContext } from '../../backend/types.js';
import type { SandboxMode } from '@openworkgraph/protocol';
import { AgentError } from '../errors.js';
import { pathInside } from './project-rules.js';

export const builtinFileHash = (content: Uint8Array | string): string => createHash('sha256').update(content).digest('hex');
/** Business path/content checks for built-in file tools, not a script sandbox.
 * Windows commands deliberately run separately with the OS user's rights. */
export class BuiltinAgentFiles {
  readonly project: string; readonly input: string; readonly output: string; readonly service: string;
  private readonly aliases: { path: string; canonical: string }[];
  constructor(context: Pick<BackendRunContext, 'projectPath' | 'inputPath' | 'outputPath' | 'serviceRoot'>, readonly mode: SandboxMode, private readonly active: () => void, private readonly readRoots: readonly string[] = []) {
    this.project = realpathSync(context.projectPath); this.input = realpathSync(context.inputPath); this.output = realpathSync(context.outputPath); this.service = realpathSync(context.serviceRoot);
    this.aliases = [{ path: resolve(context.projectPath), canonical: this.project }, { path: resolve(context.inputPath), canonical: this.input }, { path: resolve(context.outputPath), canonical: this.output }, { path: resolve(context.serviceRoot), canonical: this.service }].sort((a, b) => b.path.length - a.path.length);
  }
  path(value: string, write = false): string {
    this.active();
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\0-\x1f]/.test(value)) throw new AgentError('invalid_configuration');
    let path = resolve(this.project, value);
    // Canonicalize only trusted host root aliases (e.g. macOS /var). A project
    // symlink beneath that root remains subject to the component checks below.
    const alias = this.aliases.find(root => pathInside(root.path, path));
    if (alias) path = join(alias.canonical, relative(alias.path, path));
    else if (this.mode === 'danger-full-access') {
      try { path = realpathSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !write) throw error;
        path = join(realpathSync(dirname(path)), basename(path));
      }
    }
    const ownOutput = pathInside(this.output, path), ownInput = pathInside(this.input, path), project = pathInside(this.project, path);
    const frozenDependency = this.readRoots.some(root => pathInside(root, path));
    if (pathInside(this.service, path) && !ownOutput && !ownInput && !(frozenDependency && !write)) throw new AgentError('permission_denied');
    if (write ? frozenDependency || !ownOutput && (ownInput || this.mode === 'read-only' || this.mode !== 'danger-full-access' && !project) : this.mode !== 'danger-full-access' && !ownOutput && !ownInput && !project && !frozenDependency) throw new AgentError('permission_denied');
    // Reject symlink components rather than letting canonicalization grant an
    // outside target. Run-owned tools execute serially; check again at commit.
    // Resolve from the filesystem root (including a Windows volume/share).
    let current = path; const parts: string[] = [];
    while (dirname(current) !== current) { parts.unshift(current); current = dirname(current); }
    parts.unshift(current);
    for (let index = 0; index < parts.length; index++) {
      try {
        const info = lstatSync(parts[index]!);
        if (info.isSymbolicLink()) throw new AgentError('permission_denied');
        if (index < parts.length - 1 && !info.isDirectory()) throw new AgentError('invalid_configuration');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && write && index === parts.length - 1) break; throw error; }
    }
    return path;
  }
  read(value: string, maximum = 256 * 1024): { path: string; text: string; sha256: string; bytes: number } {
    const source = this.bytes(value, maximum);
    return { path: source.path, text: new TextDecoder('utf8', { fatal: true }).decode(source.content), sha256: source.sha256, bytes: source.content.length };
  }
  readPage(value: string, offset = 0, length = 12000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 16000) throw new AgentError('invalid_configuration');
    const source = this.read(value, 1024 * 1024);
    if (offset > source.text.length) throw new AgentError('invalid_configuration');
    let end = Math.min(offset + length, source.text.length);
    if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text[end - 1]!)) end--;
    if (end === offset && end < source.text.length) end = Math.min(offset + 2, source.text.length);
    return { ...source, text: source.text.slice(offset, end), offset, nextOffset: end < source.text.length ? end : null };
  }
  bytes(value: string, maximum = 4 * 1024 * 1024): { path: string; content: Buffer; sha256: string } {
    const path = this.path(value); const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(file); if (!info.isFile() || info.nlink !== 1) throw new AgentError('invalid_configuration');
      if (info.size > maximum) throw new AgentError('input_size_limit');
      const bytes = readFileSync(file); if (bytes.length > maximum) throw new AgentError('input_size_limit');
      return { path, content: bytes, sha256: builtinFileHash(bytes) };
    } finally { closeSync(file); }
  }
  list(value: string, offset = 0): { entries: { name: string; kind: string }[]; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentError('invalid_configuration');
    const path = this.path(value), entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    return { entries: entries.slice(offset, offset + 200).map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' })), nextOffset: entries.length > offset + 200 ? offset + 200 : null };
  }
  mkdir(value: string): { path: string } {
    const path = this.path(value, true); this.active(); mkdirSync(path, { mode: 0o700 }); return { path };
  }
  write(value: string, content: string, expectedSha256: string | null): { path: string; sha256: string; bytes: number } {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || !(expectedSha256 === null || /^[a-f0-9]{64}$/.test(expectedSha256))) throw new AgentError('invalid_configuration');
    const path = this.path(value, true);
    const check = () => {
      try {
        const read = this.read(path, 1024 * 1024);
        if (expectedSha256 === null || read.sha256 !== expectedSha256) throw new AgentError('invalid_configuration', '文件内容已变化，请重新读取后编辑。');
        if (lstatSync(path).nlink !== 1) throw new AgentError('permission_denied');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || expectedSha256 !== null) throw error; }
    };
    check();
    const temporary = join(dirname(path), '.builtin-write-' + randomUUID());
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (expectedSha256 !== null) fchmodSync(file, lstatSync(path).mode & 0o777);
      writeFileSync(file, content, 'utf8'); fsyncSync(file);
    } finally { closeSync(file); }
    try { this.active(); this.path(path, true); check(); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return { path, sha256: builtinFileHash(content), bytes: Buffer.byteLength(content) };
  }
  edit(value: string, oldText: string, newText: string, expectedSha256: string): { path: string; sha256: string; bytes: number } {
    if (!oldText || typeof oldText !== 'string' || typeof newText !== 'string') throw new AgentError('invalid_configuration');
    const source = this.read(value, 1024 * 1024);
    const index = source.text.indexOf(oldText);
    if (index < 0 || source.text.indexOf(oldText, index + 1) >= 0 || source.sha256 !== expectedSha256) throw new AgentError('invalid_configuration', '编辑前提不匹配，请重新读取文件。');
    return this.write(value, source.text.slice(0, index) + newText + source.text.slice(index + oldText.length), expectedSha256);
  }
  search(value: string, query: string): { matches: { path: string; line: number; text: string }[]; truncated: boolean } {
    if (typeof query !== 'string' || !query || query.length > 1000) throw new AgentError('invalid_configuration');
    const root = this.path(value), pending = [root], matches: { path: string; line: number; text: string }[] = []; let entries = 0, resultBytes = 0;
    while (pending.length) {
      this.active(); const directory = pending.shift()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 4096 || matches.length >= 50) return { matches, truncated: true };
        if (entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue;
        const file = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) {
          try {
            const text = this.read(file, 128 * 1024).text;
            if (text.includes('\0')) continue;
            const lines = text.split('\n');
            for (const [index, line] of lines.entries()) {
              if (!line.includes(query)) continue;
              const match = { path: file, line: index + 1, text: line.slice(0, 2000) };
              const bytes = Buffer.byteLength(JSON.stringify(match)) + 1;
              // Leave room for the result envelope and scoped rule metadata.
              if (matches.length >= 50 || resultBytes + bytes > 48 * 1024) return { matches, truncated: true };
              matches.push(match); resultBytes += bytes;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES' || error instanceof AgentError || error instanceof TypeError) continue; throw error; }
        }
      }
    }
    return { matches, truncated: false };
  }
}
