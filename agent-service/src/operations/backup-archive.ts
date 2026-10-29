import { ZipFile } from 'yazl';
import { open as openZip, type ZipFile as ZipReader, type Entry } from 'yauzl';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import { backupFileChunks, writeBackupFile } from './backup-files.js';

export const BACKUP_DATABASE_FILE = 'database/service.sqlite';
export const BACKUP_ZIP_FILE = 'backup.zip';
export const validBackupFile = (path: string): boolean => path === BACKUP_DATABASE_FILE || /^blobs[/][a-f0-9]{64}$/.test(path);

/** ZIP64, Deflate and lazy streams keep the package independent of JS string
 * and Buffer limits. Only paths in the owned staging directory are supplied. */
export async function createBackupArchive(manifest: Buffer, files: Map<string, string>, destination: string): Promise<number> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  output.on('error', () => {});
  zip.on('error', error => output.destroy(error));
  const writing = writeBackupFile(destination, output);
  try {
    zip.addBuffer(manifest, 'manifest.json', { mode: 0o100600 });
    zip.addEmptyDirectory('database/'); zip.addEmptyDirectory('blobs/');
    for (const [name, path] of files) {
      if (!validBackupFile(name)) throw new Error('Unsafe backup ZIP entry');
      zip.addReadStreamLazy(name, { compress: true, mode: 0o100600 }, callback => callback(null, Readable.from(backupFileChunks(path))));
    }
    zip.end({ forceZip64Format: true, comment: '' });
    return await writing;
  } catch (error) { output.destroy(error instanceof Error ? error : new Error('Backup ZIP creation failed')); await writing.catch(() => {}); throw error; }
}

/** Extract the new ZIP format only, sequentially, into a private directory.
 * Reject links, encryption, unexpected paths, duplicates and corrupt CRCs. */
export async function decodeBackupArchive(source: string, directory: string): Promise<Set<string>> {
  const zip = await new Promise<ZipReader>((resolve, reject) => openZip(source, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value!)));
  const seen = new Set<string>(), files = new Set<string>();
  let input: Readable | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => { input?.destroy(); reject(error); };
      zip.once('error', fail); zip.once('end', resolve);
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const name = entry.fileName, kind = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (seen.has(name) || (entry.generalPurposeBitFlag & 1) || (kind !== 0 && kind !== 0o100000 && kind !== 0o040000)) throw new Error('Unsafe or duplicate backup ZIP entry');
          seen.add(name);
          if (name.endsWith('/')) {
            if (!['database/', 'blobs/'].includes(name)) throw new Error('Unsafe backup ZIP directory');
          } else {
            if ((kind && kind !== 0o100000) || (name !== 'manifest.json' && !validBackupFile(name))) throw new Error('Unsafe backup ZIP file');
            if (![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize)) throw new Error('Unsupported backup ZIP entry');
            input = await new Promise<Readable>((done, failed) => zip.openReadStream(entry, (error, stream) => error ? failed(error) : done(stream!)));
            let checksum = 0;
            const chunks = async function* (stream: Readable) {
              for await (const value of stream) { const chunk = value as Buffer; checksum = crc32(chunk, checksum); yield chunk; }
            };
            const bytes = await writeBackupFile(join(directory, name), chunks(input), 0o600); input = undefined;
            if (bytes !== entry.uncompressedSize || checksum !== (entry.crc32 >>> 0)) throw new Error('Backup ZIP checksum mismatch');
            files.add(name);
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    if (!files.has('manifest.json') || !files.has(BACKUP_DATABASE_FILE)) throw new Error('Incomplete backup ZIP');
    files.delete('manifest.json'); return files;
  } finally {
    input?.destroy();
    const closed = new Promise<void>(resolve => zip.once('close', resolve)); zip.close(); await closed;
  }
}
