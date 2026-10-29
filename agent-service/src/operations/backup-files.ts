import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { safePath } from './files.js';

export const BACKUP_CHUNK_BYTES = 192 * 1024;

/** Open validated regular files without imposing a backup size policy. */
export async function* backupFileChunks(path: string): AsyncGenerator<Buffer> {
  const file = await open(await safePath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Invalid backup file');
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: BACKUP_CHUNK_BYTES })) yield chunk as Buffer;
  } finally { await file.close(); }
}

export async function hashBackupFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of backupFileChunks(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

export async function writeBackupFile(path: string, chunks: AsyncIterable<Uint8Array>, mode = 0o400): Promise<number> {
  const file = await open(await safePath(path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let bytes = 0;
  try {
    for await (const chunk of chunks) { await file.writeFile(chunk); bytes += chunk.length; }
    await file.sync(); await file.chmod(mode);
    return bytes;
  } finally { await file.close(); }
}

/** Hash the bytes actually copied, not a second read of a mutable source. */
export async function copyBackupFile(source: string, destination: string, mode = 0o400): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  const chunks = async function* () {
    for await (const chunk of backupFileChunks(source)) { hash.update(chunk); yield chunk; }
  };
  const bytes = await writeBackupFile(destination, chunks(), mode);
  return { bytes, sha256: hash.digest('hex') };
}
