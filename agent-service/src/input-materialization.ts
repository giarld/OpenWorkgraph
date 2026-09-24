import { constants } from 'node:fs';
import { lstat, realpath, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { InputSnapshot } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export interface MaterializedInputs { directory: string; files: { resourceId: string; version: number; path: string; sha256: string }[] }
export interface MaterializeInputOptions { inputDirectory: string; blobDirectory: string; resolveBlobPath?: (sha256: string) => string }
async function realDirectory(path: string): Promise<string> {
  const stat = await lstat(path); const canonical = await realpath(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== resolve(path)) throw new ServiceError('INPUT_BLOCKED','Input/blob directory must be canonical and cannot be a symlink');
  return canonical;
}
/** Async preparation outside SQLite transactions; only the newly created private directory is written. */
export async function materializeInputs(snapshot: InputSnapshot, options: MaterializeInputOptions): Promise<MaterializedInputs> {
  // Copy before the first await so callers cannot alter the accepted resource set during preparation.
  const resources = structuredClone(snapshot.resources);
  const inputDirectory = options.inputDirectory, blobDirectory = options.blobDirectory;
  const paths = new Map<string,string>();
  for (const envelope of resources) {
    if (!envelope.resource) continue;
    const sha = envelope.resource.sha256;
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new ServiceError('INPUT_BLOCKED','Invalid frozen resource hash');
    if (!paths.has(sha)) paths.set(sha,options.resolveBlobPath ? options.resolveBlobPath(sha) : join(blobDirectory,sha));
  }
  const input = await realDirectory(inputDirectory); const blobs = await realDirectory(blobDirectory);
  if (input === blobs || input.startsWith(blobs + sep) || blobs.startsWith(input + sep)) throw new ServiceError('INPUT_BLOCKED','Blob and input directories must be isolated');
  const directory = await mkdtemp(join(input,'prepared-'));
  const result: MaterializedInputs = {directory,files:[]}; const seen = new Map<string,string>();
  try {
    for (const envelope of resources) {
      const resource = envelope.resource; if (!resource) continue;
      if (!/^[a-f0-9]{64}$/.test(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) throw new ServiceError('INPUT_BLOCKED','Invalid frozen resource metadata');
      const key = JSON.stringify([resource.resourceId,resource.version]);
      const identity = JSON.stringify(resource);
      if (seen.has(key)) {
        if (seen.get(key) !== identity) throw new ServiceError('INPUT_BLOCKED','Conflicting frozen resource identities');
        continue;
      }
      seen.set(key,identity);
      const selected = paths.get(resource.sha256)!;
      if (typeof selected !== 'string' || !isAbsolute(selected) || !resolve(selected).startsWith(blobs + sep)) throw new ServiceError('INPUT_BLOCKED','Selected Blob path escapes Blob directory');
      const canonical = await realpath(selected);
      if (canonical !== resolve(selected) || !canonical.startsWith(blobs + sep)) throw new ServiceError('INPUT_BLOCKED','Selected Blob path contains a symlink or escapes Blob directory');
      const source = await open(canonical,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.size !== resource.bytes) throw new ServiceError('INPUT_BLOCKED','Frozen resource size/type mismatch');
        const path = join(directory,`${result.files.length}-${resource.sha256}`);
        const target = await open(path,'wx',0o600);
        try {
          const hash = createHash('sha256'); let bytes = 0;
          for await (const chunk of source.createReadStream({autoClose:false})) {
            const buffer = chunk as Buffer; bytes += buffer.length;
            if (bytes > resource.bytes) throw new ServiceError('INPUT_BLOCKED','Resource grew during preparation');
            hash.update(buffer); await target.writeFile(buffer);
          }
          if (bytes !== resource.bytes || hash.digest('hex') !== resource.sha256) throw new ServiceError('INPUT_BLOCKED','Frozen resource hash mismatch');
          await target.sync();
          await target.chmod(0o400);
        } finally { await target.close(); }
        result.files.push({resourceId:resource.resourceId,version:resource.version,path,sha256:resource.sha256});
      } finally { await source.close(); }
    }
    return result;
  } catch (error) { await rm(directory,{recursive:true,force:true}); throw error; }
}
