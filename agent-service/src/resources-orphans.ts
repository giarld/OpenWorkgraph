import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { BlobStore } from './blob-store.js';
import { ServiceError } from './errors.js';
import { transaction } from './persistence/database.js';
import { SCHEMA_VERSION } from './persistence/schema.js';
import { acquireOperationsLock, rootPath } from './operations/lifecycle.js';
import type { OperationsLock } from './operations/lifecycle.js';
import { safePath } from './operations/files.js';

/** Deliberately offline, opt-in only. A crash before SQL registration is NOT
 * covered by ordinary discardPrepared. This policy scans only current immutable
 * generation files (blobs/{objects,chunks}/UUID), never legacy staging, backups,
 * runs, unknown directories or unknown names. Default grace is 24 hours.
 * Any recorded path/hash, hardlink or unfinished backup is retained/fails closed.
 * Preview tokens are local to one uninterrupted exclusive maintenance session.
 * No schema migration, reference deletion or automatic startup sweep occurs. */
export interface OrphanOptions { minAgeMs?: number; maxEntries?: number; maxFileBytes?: number; now?: () => number }
export interface OrphanCandidate { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface OrphanPreview { readonly id: string; readonly root: string; readonly candidates: readonly OrphanCandidate[]; readonly retained: readonly {path: string; reason: string}[] }
export interface OrphanCleanup { removed: string[]; retained: string[]; failed: string[] }
export interface OrphanMaintenance { preview(): Promise<OrphanPreview>; cleanup(preview: OrphanPreview): Promise<OrphanCleanup> }
interface Candidate extends OrphanCandidate { stamp: string }
interface References { paths: Set<string>; hashes: Set<string> }
const fail=(message: string): never=>{throw new ServiceError('MAINTENANCE',message);};
const generation=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function stamp(stat: Awaited<ReturnType<typeof lstat>>): string {return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.nlink].join(':');}
function option(value: number, min: number): number {if(!Number.isSafeInteger(value) || value<min) throw new ServiceError('INVALID_REQUEST','Invalid orphan scan bound');return value;}

class Maintenance implements OrphanMaintenance {
 private readonly tokens=new WeakMap<OrphanPreview,readonly Candidate[]>();
 private chain: Promise<unknown>=Promise.resolve(); private closing=false;
 readonly minAge: number;readonly maxEntries: number;readonly maxBytes: number;readonly now:()=>number;readonly store:BlobStore;
 constructor(private readonly db:DatabaseSync,private readonly lock:OperationsLock,options:OrphanOptions) {
  this.minAge=option(options.minAgeMs ?? 86400000,0);this.maxEntries=option(options.maxEntries ?? 10000,1);this.maxBytes=option(options.maxFileBytes ?? 512*1024*1024,1);this.now=options.now ?? Date.now;this.store=new BlobStore(join(lock.root,'blobs'));
 }
 private assertOwned():void {
  if(!this.lock.held || this.lock.record.serviceId || this.db.prepare('PRAGMA database_list').all().find(row=>row['name']==='main')?.['file']!==join(this.lock.root,'service.sqlite')) fail('Matching unpublished exclusive maintenance ownership required');
  if(this.db.isTransaction) fail('Orphan filesystem operations cannot run in a transaction');
 }
 private run<T>(work:()=>Promise<T>):Promise<T> {
  if(this.closing) return Promise.reject(new ServiceError('MAINTENANCE','Maintenance session is closed'));
  const pending=this.chain.then(()=>{this.assertOwned();return work();});this.chain=pending.catch(()=>{});return pending;
 }
 async close():Promise<void> {this.closing=true;await this.chain;}
 private references():References {
  if(this.db.prepare('SELECT 1 FROM resource_maintenance_leases LIMIT 1').get() || this.db.prepare("SELECT 1 FROM backups WHERE state='creating' LIMIT 1").get()) fail('Unresolved maintenance/backup record; preserve it and recover separately before orphan cleanup');
  const result:References={paths:new Set(),hashes:new Set()};
  for(const row of this.db.prepare('SELECT path FROM resource_blob_files UNION SELECT path FROM resource_upload_chunks UNION SELECT path FROM resource_file_deletions UNION SELECT path FROM backups WHERE path IS NOT NULL').all()) result.paths.add(resolve(this.lock.root,String(row['path'])));
  for(const row of this.db.prepare("SELECT sha256 FROM blobs UNION SELECT sha256 FROM resource_upload_chunks UNION SELECT sha256 FROM resource_uploads WHERE sha256 IS NOT NULL UNION SELECT expected_sha256 AS sha256 FROM resource_uploads WHERE expected_sha256 IS NOT NULL UNION SELECT sha256 FROM resource_read_leases UNION SELECT sha256 FROM backups WHERE sha256 IS NOT NULL UNION SELECT j.value AS sha256 FROM snapshots s,json_tree(s.payload) j WHERE j.type='text' AND length(j.value)=64").all()) result.hashes.add(String(row['sha256']));
  return result;
 }
 private protected(path:string,hash:string|undefined,refs:References):boolean {return [...refs.paths].some(owned=>path===owned || path.startsWith(owned+sep)) || (hash!==undefined && refs.hashes.has(hash));}
 private async inspect(path:string):Promise<Candidate> {
  await safePath(path);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const before=await file.stat();if(!before.isFile() || before.nlink!==1 || before.size>this.maxBytes) fail('Generation file changed or is not a bounded single-link file');
   const hash=createHash('sha256');let bytes=0;const buffer=Buffer.alloc(64*1024);
   while(true) {const read=await file.read(buffer,0,buffer.length,null);if(!read.bytesRead) break;bytes+=read.bytesRead;if(bytes>this.maxBytes) fail('Generation file grew beyond scan bound');hash.update(buffer.subarray(0,read.bytesRead));}
   const after=await file.stat();if(stamp(before)!==stamp(after) || bytes!==before.size) fail('Generation file changed during preview');
   return {path,bytes,sha256:hash.digest('hex'),stamp:stamp(after)};
  } finally {await file.close();}
 }
 private async scan():Promise<{candidates:Candidate[];retained:{path:string;reason:string}[]}> {
  this.assertOwned();const refs=this.references();const result={candidates:[] as Candidate[],retained:[] as {path:string;reason:string}[]};let entries=0;const cutoff=this.now()-this.minAge;
  for(const kind of ['objects','chunks']) {
   const directory=join(this.lock.root,'blobs',kind);
   try {await safePath(directory);} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') continue;throw error;}
   for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(++entries>this.maxEntries) throw new ServiceError('PAYLOAD_TOO_LARGE','Orphan scan entry bound exceeded; no cleanup performed');
    const path=join(directory,entry.name);await safePath(path);const stat=await lstat(path);
    let reason:string|undefined;
    if(!stat.isFile() || !generation.test(entry.name)) reason='unknown-layout';
    else if(stat.nlink!==1) reason='hardlink';
    else if(this.protected(path,undefined,refs)) reason='recorded-path';
    else if(Math.max(stat.mtimeMs,stat.ctimeMs)>cutoff) reason='grace-period';
    else if(stat.size>this.maxBytes) reason='oversize';
    if(reason) {result.retained.push({path,reason});continue;}
    const candidate=await this.inspect(path);
    if(this.protected(path,candidate.sha256,refs)) result.retained.push({path,reason:'recorded-hash'});else result.candidates.push(candidate);
   }
  }
  this.assertOwned();return result;
 }
 preview():Promise<OrphanPreview> {return this.run(async()=>{
  const result=await this.scan();const preview=Object.freeze({id:randomUUID(),root:this.lock.root,candidates:Object.freeze(result.candidates.map(({path,bytes,sha256})=>Object.freeze({path,bytes,sha256}))),retained:Object.freeze(result.retained.map(row=>Object.freeze(row)))});
  this.tokens.set(preview,result.candidates);return preview;
 });}
 cleanup(preview:OrphanPreview):Promise<OrphanCleanup> {return this.run(async()=>{
  const approved=this.tokens.get(preview);if(!approved) throw new ServiceError('INVALID_REQUEST','Use an unchanged preview from this exclusive maintenance session');
  // Full rescan rejects symlinks or backup blockers before queuing any deletion.
  const current=new Map((await this.scan()).candidates.map(row=>[row.path,row]));const eligible:Candidate[]=[];
  const result:OrphanCleanup={removed:[],retained:[],failed:[]};
  for(const old of approved) {const latest=current.get(old.path);if(!latest || latest.stamp!==old.stamp || latest.sha256!==old.sha256) result.retained.push(old.path);else eligible.push(latest);}
  this.assertOwned();const claimed=transaction(this.db,()=>{
   const refs=this.references();const rows:Candidate[]=[];
   for(const candidate of eligible) {if(this.protected(candidate.path,candidate.sha256,refs)) {result.retained.push(candidate.path);continue;}
    this.db.prepare('INSERT INTO resource_file_deletions(path,created_at,completed) VALUES(?,?,0)').run(candidate.path,this.now());rows.push(candidate);
   }return rows;
  });
  this.tokens.delete(preview);
  for(const candidate of claimed) {
   try {
    this.assertOwned();await safePath(candidate.path);const current=await lstat(candidate.path);
    if(stamp(current)!==candidate.stamp) {
     // Do not let a later online drain delete a replacement file either.
     transaction(this.db,()=>this.db.prepare('UPDATE resource_file_deletions SET completed=1 WHERE path=?').run(candidate.path));result.retained.push(candidate.path);continue;
    }
    await this.store.remove(candidate.path);
    transaction(this.db,()=>this.db.prepare('UPDATE resource_file_deletions SET completed=1 WHERE path=?').run(candidate.path));result.removed.push(candidate.path);
   } catch {result.failed.push(candidate.path);}
  }
  return result;
 });}
}

/** Existing data only. Acquires the same kernel lock as serve BEFORE opening DB;
 * never accepts caller-forged held flags, never migrates, never publishes a server.
 * Escaped controller handles reject after this callback and in-flight calls drain
 * before the DB/lock are closed. Cleanup must be explicitly requested in callback. */
export async function withOfflineResourceOrphans<T>(dataDir:string,work:(maintenance:OrphanMaintenance)=>Promise<T>,options:OrphanOptions={}):Promise<T> {
 const root=await safePath(rootPath(dataDir));if(!(await lstat(root)).isDirectory()) fail('Existing data directory required');
 const lock=await acquireOperationsLock(root);let db:DatabaseSync|undefined;let maintenance:Maintenance|undefined;
 try {
  const path=await safePath(join(lock.root,'service.sqlite'));if(!(await lstat(path)).isFile()) fail('Existing regular database required');
  db=new DatabaseSync(path,{allowExtension:false,timeout:5000,enableForeignKeyConstraints:true});
  if(db.prepare('PRAGMA user_version').get()?.['user_version']!==SCHEMA_VERSION) fail('Matching resource schema required; orphan maintenance never migrates');
  if(db.prepare('PRAGMA quick_check').get()?.['quick_check']!=='ok' || db.prepare('PRAGMA foreign_key_check').get()) fail('Database integrity check failed');
  for(const table of ['blobs','resource_blob_files','resource_uploads','resource_upload_chunks','resource_file_deletions','resource_read_leases','resource_maintenance_leases','backups','snapshots']) if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail('Incomplete resource schema');
  maintenance=new Maintenance(db,lock,options);return await work(maintenance);
 } finally {try {await maintenance?.close();db?.close();} finally {await lock.release();}}
}
