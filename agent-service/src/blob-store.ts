import { createHash, randomUUID } from 'node:crypto';
import { WORKGRAPH_UPLOAD_MAX_BYTES, isOpaqueResourceMime } from '@openworkgraph/protocol';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ServiceError } from './errors.js';

export interface PreparedBlob { readonly sha256: string; readonly bytes: number; readonly mime: string; readonly path: string; readonly text: string | null }
export const supportsText = (mime: string): boolean => ['text/plain','text/markdown','text/csv','application/json','application/xml','text/xml','text/yaml','text/x-yaml','application/yaml','application/x-yaml'].includes(mime);
export const validMime = (mime: string): boolean => /^[a-zA-Z0-9.+-]+[/][a-zA-Z0-9.+-]+$/.test(mime);
export const opaqueFileMime = isOpaqueResourceMime;
export const mimeMatchesBytes = (declared: string, sniffed: string, allowGenericOctet = false): boolean =>
 declared === sniffed ||
 (allowGenericOctet && declared === 'application/octet-stream') ||
 (sniffed === 'text/plain' && (supportsText(declared) || declared === 'application/octet-stream' || opaqueFileMime(declared))) ||
 (sniffed === 'application/octet-stream' && opaqueFileMime(declared));
export const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function blobRoot(input: string): string {
 const root = resolve(input);
 if(process.platform !== 'win32') return root;
 // Windows may supply 8.3 paths. Reject actual links before canonicalizing spelling.
 let canonical: string | undefined;
 for(let path=root;;path=dirname(path)) {
  try {
   if(lstatSync(path).isSymbolicLink()) throw new ServiceError('INVALID_REQUEST','Blob directories cannot be symlinks');
   canonical ??= join(realpathSync.native(path),relative(path,root));
  }
  catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  if(dirname(path)===path) break;
 }
 return canonical ?? root;
}
async function syncDirectory(path: string): Promise<void> {
 // Node cannot open directory handles for fsync on Windows. File data is synced above.
 if(process.platform === 'win32') return;
 const directory=await open(path,constants.O_RDONLY);
 try {await directory.sync();} finally {await directory.close();}
}
/** The source can grow after stat: never let readFile allocate without a bound. */
export async function readBounded(file: FileHandle, max: number): Promise<Buffer> {
 const parts: Buffer[]=[];let total=0;
 while(true) {const buffer=Buffer.alloc(Math.min(64*1024,max-total+1));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead) break;total+=bytesRead;if(total>max) throw new ServiceError('PAYLOAD_TOO_LARGE','File exceeds maximum');parts.push(buffer.subarray(0,bytesRead));}
 return Buffer.concat(parts,total);
}
import { sniffResourceMime as sniffMime } from '@openworkgraph/protocol';
export { sniffMime };
/** Files are generation-addressed, not overwritten by hash. A committed GC queue
 * can never unlink a later upload of the same bytes. Paths are private service data. */
export class BlobStore {
 readonly root: string; readonly maxBytes: number;
 private readonly prepared = new WeakSet<object>();
 constructor(root: string, options: {maxBytes?: number} = {}) {
  this.root=blobRoot(root); this.maxBytes=options.maxBytes ?? WORKGRAPH_UPLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes<1) throw new Error('Invalid maximum upload size');
 }
 private async directory(kind: 'objects'|'chunks'): Promise<string> {
  const directory=join(this.root,kind); await mkdir(directory,{recursive:true,mode:0o700});
  if (await realpath(this.root)!==this.root || await realpath(directory)!==directory) throw new ServiceError('INVALID_REQUEST','Blob directories cannot be symlinks');
  return directory;
 }
 private async write(bytes: Uint8Array, kind: 'objects'|'chunks'): Promise<string> {
  const directory=await this.directory(kind); const path=join(directory,randomUUID());
  const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try { await file.writeFile(bytes); await file.sync(); await file.chmod(0o400); }
  catch(error) { await file.close(); await unlink(path).catch(()=>{}); throw error; }
  try {await file.close();await syncDirectory(directory);}
  catch(error) {await unlink(path).catch(()=>{});throw error;}
  return path;
 }
 async prepare(bytes: Uint8Array, declaredMime='application/octet-stream', expectedHash?: string): Promise<PreparedBlob> {
  if (bytes.byteLength>this.maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Resource exceeds configured maximum');
  const stable=Buffer.from(bytes); const sha256=hashBytes(stable), mime=sniffMime(stable);
  if (expectedHash!==undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256!==expectedHash)) throw new ServiceError('INVALID_REQUEST','SHA-256 mismatch');
  const declared=declaredMime.toLowerCase().split(';')[0]!.trim();
  if (!validMime(declared) || !mimeMatchesBytes(declared,mime,true)) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','Declared MIME does not match content');
  if (declared==='application/json') { try { JSON.parse(stable.toString('utf8')); } catch { throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','Invalid JSON content'); } }
  const effectiveMime=supportsText(declared)||opaqueFileMime(declared)?declared:mime;
  const result=Object.freeze({sha256,bytes:stable.byteLength,mime:effectiveMime,path:await this.write(stable,'objects'),text:supportsText(effectiveMime)?new TextDecoder('utf-8',{fatal:true}).decode(stable):null});
  this.prepared.add(result); return result;
 }
 assertPrepared(blob: PreparedBlob): void { if (!this.prepared.has(blob)) throw new ServiceError('INVALID_REQUEST','Expected an immutable blob prepared by this store'); }
 async writeChunk(bytes: Uint8Array): Promise<string> {if(bytes.byteLength<1 || bytes.byteLength>Math.min(this.maxBytes,4*1024*1024)) throw new ServiceError('PAYLOAD_TOO_LARGE','Chunk exceeds maximum');return this.write(Buffer.from(bytes),'chunks');}
 private validatePath(path: string): void {
  if (!['objects','chunks'].some(kind => dirname(path)===join(this.root,kind)) || !/^[0-9a-f-]{36}$/.test(path.slice(path.lastIndexOf(sep)+1))) throw new ServiceError('INVALID_REQUEST','Unmanaged blob path');
  if (resolve(path)!==path) throw new ServiceError('INVALID_REQUEST','Unmanaged blob path');
 }
 async read(path: string): Promise<Buffer> {
  this.validatePath(path);
  if (await realpath(path)!==path) throw new ServiceError('INVALID_REQUEST','Blob symlinks are forbidden');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile()) throw new ServiceError('INVALID_REQUEST','Expected regular blob file');if (stat.size>this.maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Blob exceeds maximum'); return await readBounded(file,this.maxBytes); } finally {await file.close();}
 }
 /** Verify immutable media without allocating a full-video Buffer. */
 async withVerifiedFile<T>(path: string, expected: {bytes: number; sha256: string}, use: (path: string) => Promise<T>): Promise<T> {
  this.validatePath(path);
  if (await realpath(path)!==path) throw new ServiceError('INVALID_REQUEST','Blob symlinks are forbidden');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const before=await file.stat({bigint:true});
   if (!before.isFile() || before.size!==BigInt(expected.bytes) || before.size>BigInt(this.maxBytes)) throw new ServiceError('INTERNAL_ERROR','Stored blob integrity check failed');
   const hash=createHash('sha256');const buffer=Buffer.alloc(64*1024);let total=0;
   while (true) {
    const {bytesRead}=await file.read(buffer,0,buffer.length,null);
    if (!bytesRead) break;
    total+=bytesRead;
    if (total>expected.bytes) throw new ServiceError('INTERNAL_ERROR','Stored blob integrity check failed');
    hash.update(buffer.subarray(0,bytesRead));
   }
   if (total!==expected.bytes || hash.digest('hex')!==expected.sha256) throw new ServiceError('INTERNAL_ERROR','Stored blob integrity check failed');
   const result=await use(path);
   if (await realpath(path)!==path) throw new ServiceError('INVALID_REQUEST','Blob symlinks are forbidden');
   const current=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try {
    const after=await current.stat({bigint:true});
    if (after.dev!==before.dev || after.ino!==before.ino || after.size!==before.size || after.mtimeNs!==before.mtimeNs || after.ctimeNs!==before.ctimeNs) throw new ServiceError('INTERNAL_ERROR','Stored blob changed during preview');
   } finally {await current.close();}
   return result;
  } finally {await file.close();}
 }
 async remove(path: string): Promise<void> {
  this.validatePath(path);
  // Never traverse a replaced parent symlink, even when a deletion was queued.
  if (await realpath(join(path,'..'))!==join(path,'..')) throw new ServiceError('INVALID_REQUEST','Blob parent symlinks are forbidden');
  try { await unlink(path); } catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  // Marking the durable deletion queue completed must follow a durable unlink.
  await syncDirectory(dirname(path));
 }
}
