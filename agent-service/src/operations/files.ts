import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { dirname, parse, resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid operations identifier');
  return value;
};
/** macOS exposes OS-owned /var and /tmp aliases. Normalize only these fixed
 * aliases; arbitrary user-created symlink parents are still forbidden. */
export function normalizeSystemPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'darwin' && /^[/](var|tmp)([/]|$)/.test(absolute) ? '/private' + absolute : absolute;
}
/** Check EVERY existing component; never follow a user supplied parent symlink. */
export async function safePath(path: string, missing = false): Promise<string> {
  const absolute = normalizeSystemPath(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Operations paths cannot contain symlinks'); }
    catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}
export async function privateDir(path: string): Promise<string> {
  path = await safePath(path, true); await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}
export async function readSafe(path: string, max = 512 * 1024 * 1024): Promise<Buffer> {
  path = await safePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('Invalid or oversized operations file');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function syncDir(path: string): Promise<void> {
  // Windows does not support opening directories through fs.open. File flushes
  // still apply; crash durability of rename must be verified on that platform.
  if (process.platform === 'win32') return;
  const file = await open(path, constants.O_RDONLY);
  try { await file.sync(); } finally { await file.close(); }
}
export async function writeNew(path: string, data: Uint8Array | string, mode = 0o400): Promise<void> {
  path = await safePath(path, true);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); await file.chmod(mode); } finally { await file.close(); }
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
  path = await safePath(path, true);
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeNew(temporary, JSON.stringify(data), 0o600);
  await rename(temporary, path); await syncDir(dirname(path));
}
