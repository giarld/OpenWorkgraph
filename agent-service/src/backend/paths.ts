import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { BackendError, type BackendRunContext } from './types.js';
export function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)); }
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new BackendError('INVALID_INPUT', 'Backend paths must be absolute');
  const stat = await lstat(path); const canonical = await realpath(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path)) throw new BackendError('INVALID_INPUT', 'Use canonical non-symlink directories');
  return canonical;
}
/** Runs outside DB transactions. No staging/rollback/Git operations here. */
export async function validateRunPaths(context: BackendRunContext): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(context.runId)) throw new BackendError('INVALID_INPUT', 'Invalid Run id');
  const [project, input, output, service] = await Promise.all([context.projectPath, context.inputPath, context.outputPath, context.serviceRoot].map(directory));
  if (!project || !input || !output || !service) throw new BackendError('INVALID_INPUT', 'Missing Run paths');
  if (within(project, service) || within(service, project)) throw new BackendError('INVALID_INPUT', 'Project and service data directories must not overlap');
  const expected = join(service, 'runs', context.runId);
  if (input !== join(expected, 'input') || output !== join(expected, 'output')) throw new BackendError('INVALID_INPUT', 'Input/output must belong to exactly this Run');
  // Walking ancestors detects a symlink in runs/<id>, too.
  await directory(join(service, 'runs')); await directory(expected);
  if ((await readdir(output)).length) throw new BackendError('INVALID_INPUT', 'A new Run requires an empty output directory');
}
/** Artifact paths remain untrusted even when a turn reports success. No absolute/escaping/symlink paths. */
export async function readRunOutput(outputRoot: string, name: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  if (!name || isAbsolute(name) || name.includes('\0') || name.split(/[\/\\]/).some(part => part === '..' || part === '.')) throw new BackendError('INVALID_INPUT', 'Invalid output path');
  const root = await directory(outputRoot); const path = resolve(root, name);
  if (!within(root, path) || path === root) throw new BackendError('INVALID_INPUT', 'Output escapes Run directory');
  let parent = root; const parts = relative(root, path).split(sep);
  for (const component of parts.slice(0, -1)) { parent = join(parent, component); await directory(parent); }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || before.size < 0) throw new BackendError('INVALID_INPUT', 'Output must be a bounded regular non-hardlinked file');
    const buffer = Buffer.alloc(before.size + 1); let total = 0;
    while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await realpath(path) !== path) throw new BackendError('INVALID_INPUT', 'Output changed during collection');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}
