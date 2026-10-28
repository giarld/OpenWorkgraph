import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mimeMatchesBytes, sniffMime } from './blob-store.js';
import { ServiceError } from './errors.js';
import type { ProjectFiles } from './project-files.js';

interface FileOutput { outputKey: string; path: string; bytes: number; sha256: string; mime: string; role?: string }
const invalid = (message: string): never => { throw new ServiceError('INVALID_REQUEST', message); };

/** Bound each read and check the opened file and its directory entry after EOF. */
export async function* publicationFileChunks(root: string, path: string, expectedBytes: number, privateFile = true): AsyncGenerator<Buffer> {
  const target = resolve(root, path), rel = relative(root, target);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) invalid('Invalid publication file path/size');
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) invalid('Output symlinks are forbidden');
  }
  if (await realpath(target) !== target) invalid('Output must have a canonical path');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || privateFile && before.nlink !== 1n || before.size !== BigInt(expectedBytes)) invalid('Output size/type mismatch');
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, expectedBytes - offset), offset);
      if (!bytesRead) invalid('Output changed during preflight');
      yield chunk.subarray(0, bytesRead);
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true }), entry = await lstat(target, { bigint: true });
    if ([after, entry].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs) || await realpath(target) !== target) invalid('Output changed during preflight');
  } finally { await file.close(); }
}

async function verify(chunks: AsyncIterable<Buffer>, output: FileOutput, write?: (chunk: Buffer) => Promise<void>): Promise<void> {
  const hash = createHash('sha256'), prefix = Buffer.alloc(Math.min(output.bytes, 64 * 1024));
  let bytes = 0;
  for await (const chunk of chunks) {
    if (bytes < prefix.length) chunk.copy(prefix, bytes, 0, Math.min(chunk.length, prefix.length - bytes));
    bytes += chunk.length;
    hash.update(chunk);
    await write?.(chunk);
  }
  if (bytes !== output.bytes || hash.digest('hex') !== output.sha256) invalid('Output size/hash mismatch');
  if (bytes && !mimeMatchesBytes(output.mime, sniffMime(prefix))) invalid('Output MIME does not match bytes');
}

/** Keep oversized deliverables in the project, using a deterministic, exclusive
 * destination so publication retries neither overwrite user files nor duplicate outputs. */
export async function preserveOversizedOutput(files: ProjectFiles, projectId: string, runId: string, outputRoot: string, output: FileOutput): Promise<{ relativePath: string; path: string }> {
  const projectRoot = (await files.resolve(projectId, '', 'directory')).path;
  if (output.role === 'project-file') {
    const file = await files.resolve(projectId, output.path, 'file');
    const fingerprint = await files.fingerprint(projectId, output.path, output.bytes);
    if (fingerprint.sha256 !== output.sha256) invalid('Project output SHA-256 mismatch: ' + output.outputKey);
    if (!mimeMatchesBytes(output.mime, sniffMime(fingerprint.prefix))) invalid('Output MIME does not match bytes');
    return { relativePath: output.path, path: file.path };
  }
  // These names are host-controlled or validated manifest identifiers.
  let directory = projectRoot;
  for (const part of ['outputs', runId, output.outputKey]) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) invalid('Output destination must be a real project directory');
  }
  const path = join(directory, basename(output.path)), temporary = join(directory, '.' + randomUUID() + '.tmp');
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await verify(publicationFileChunks(outputRoot, output.path, output.bytes), output, chunk => file.writeFile(chunk));
    await file.sync();
    await file.close();
    if (await realpath(directory) !== directory || (await files.resolve(projectId, '', 'directory')).path !== projectRoot) invalid('Project output destination changed');
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A previous attempt may have completed the file copy before its DB commit.
      // A crash between link() and unlink() can leave the verified destination
      // linked to an earlier temporary file. Never write through that entry.
      await verify(publicationFileChunks(projectRoot, relative(projectRoot, path), output.bytes, false), output);
    }
    await unlink(temporary);
    if (process.platform !== 'win32') {
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return { relativePath: relative(projectRoot, path).split(sep).join('/'), path };
  } finally {
    await file.close();
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}
