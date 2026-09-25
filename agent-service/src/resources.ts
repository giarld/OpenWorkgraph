import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BlobStore, hashBytes, supportsText, readBounded } from './blob-store.js';
import type { PreparedBlob } from './blob-store.js';
import { ServiceError } from './errors.js';
import { transaction } from './persistence/database.js';
import sharp from 'sharp';

export interface ResourceScope { projectId: string; serviceId?: string }
export interface CanvasScope extends ResourceScope { graphId: string }
export type LibraryTarget = ResourceScope & {name: string} & ({mode: 'new'} | {mode: 'update'; assetId: string; expectedVersion: number});
export type UploadTarget = LibraryTarget | (CanvasScope & {name: string; mode: 'canvas'});
export interface UploadStart extends ResourceScope { name: string; bytes: number; mime: string; sha256?: string }
export interface UploadStatus { uploadId: string; projectId: string; name: string; bytes: number; received: number; mime: string; state: string; sha256: string | null }
export interface PreparedAppend {readonly uploadId: string; readonly projectId: string; readonly offset: number; readonly bytes: number; readonly sha256: string; readonly path: string}
export interface PreparedFinish {readonly uploadId: string; readonly projectId: string; readonly blob: PreparedBlob}
export interface ResourceVersion {version: number; sha256: string; bytes: number; mime: string; state: 'ready'; representationVersion: number | null}
export interface LibraryAsset {id: string; projectId: string; name: string; shared: boolean; deleted: boolean; current: ResourceVersion & {assetId: string}}
export interface CanvasResource {id: string; projectId: string; graphId: string; name: string; current: ResourceVersion & {resourceId: string}}
export interface CanvasCreated {resource: CanvasResource; referenceId: string}
type Row = Record<string, string | number | bigint | Uint8Array | null>;
const DAY=24*60*60*1000;
export const IMAGE_THUMBNAIL_LEVELS = [320, 640, 1280, 2560, 4096] as const;
const invalid=(message: string): never => {throw new ServiceError('INVALID_REQUEST',message);};
const missing=(): never => {throw new ServiceError('NOT_FOUND','Resource not found in this scope');};
const conflict=(message='Resource changed'): never => {throw new ServiceError('REVISION_CONFLICT',message);};
function name(value: string): string {if (typeof value!=='string' || !value.trim() || value.length>512 || [...value].some(c=>c.charCodeAt(0)<32)) return invalid('Invalid resource name'); return value.trim();}
function integer(value: number): void {if (!Number.isSafeInteger(value) || value<0) invalid('Expected a nonnegative safe integer');}

/** All commit methods require the caller's synchronous authenticated transaction. */
export class Resources {
 readonly db: DatabaseSync; readonly blobs: BlobStore; readonly now: () => number;
 private readonly appends=new WeakSet<object>(); private readonly finishes=new WeakSet<object>();
 constructor(db: DatabaseSync, blobs: BlobStore, options: {now?: () => number} = {}) {this.db=db;this.blobs=blobs;this.now=options.now ?? Date.now;}
 private tx(): void {if (!this.db.isTransaction) throw new Error('Resource commit requires caller transaction');}
 private outside(): void {if (this.db.isTransaction) throw new Error('Filesystem preparation must run outside a transaction');}
 private project(scope: ResourceScope): void {
  if (scope.serviceId!==undefined && this.db.prepare('SELECT service_id FROM identity WHERE singleton=1').get()?.['service_id']!==scope.serviceId) throw new ServiceError('SERVICE_MISMATCH','Wrong service');
  if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(scope.projectId)) missing();
 }
 private graph(scope: CanvasScope): void {this.project(scope);if (!this.db.prepare('SELECT 1 FROM graphs WHERE id=? AND project_id=?').get(scope.graphId,scope.projectId)) missing();}
 private writable(scope: ResourceScope): void {this.project(scope);if(this.db.prepare('SELECT state FROM projects WHERE id=?').get(scope.projectId)!['state']!=='active') throw new ServiceError('PROJECT_INACTIVE','Project is inactive');}
 private writableGraph(scope: CanvasScope): void {this.writable(scope);this.graph(scope);const graph=this.db.prepare('SELECT archived,trashed FROM graphs WHERE id=?').get(scope.graphId)!;if(graph['archived']||graph['trashed']) throw new ServiceError('CONFLICT','Graph is archived or trashed');}
 private event(type: 'asset.changed'|'canvas_resource.created'|'canvas_resource.changed'|'canvas_resource.collected', scope: ResourceScope, graphId: string | null, id: string, revision: number, action: string): void {
  this.tx();this.db.prepare('INSERT INTO events(id,type,project_id,graph_id,entity_id,revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),type,scope.projectId,graphId,id,revision,new Date(this.now()).toISOString(),JSON.stringify({action}));
 }
 startUpload(request: UploadStart): UploadStatus {
  this.tx();this.writable(request);integer(request.bytes);name(request.name);
  if (request.bytes>this.blobs.maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Resource exceeds configured maximum');
  if (typeof request.mime!=='string' || !/^[a-zA-Z0-9.+-]+[/][a-zA-Z0-9.+-]+$/.test(request.mime)) invalid('Invalid MIME');
  if (request.sha256!==undefined && !/^[a-f0-9]{64}$/.test(request.sha256)) invalid('Invalid SHA-256');
  const id=randomUUID();
  this.db.prepare('INSERT INTO resource_uploads(id,project_id,name,mime,bytes,expected_sha256,created_at) VALUES(?,?,?,?,?,?,?)').run(id,request.projectId,name(request.name),request.mime,request.bytes,request.sha256 ?? null,this.now());
  return this.uploadStatus(request,id);
 }
 uploadStatus(scope: ResourceScope, uploadId: string): UploadStatus {
  this.project(scope);const row=this.db.prepare('SELECT * FROM resource_uploads WHERE id=? AND project_id=?').get(uploadId,scope.projectId);if (!row) return missing();
  return {uploadId,projectId:scope.projectId,name:String(row['name']),bytes:Number(row['bytes']),received:Number(row['received']),mime:String(row['mime']),state:String(row['state']),sha256:row['sha256']===null?null:String(row['sha256'])};
 }
 async prepareAppend(scope: ResourceScope, uploadId: string, offset: number, bytes: Uint8Array): Promise<PreparedAppend> {
  this.outside();integer(offset);const status=this.uploadStatus(scope,uploadId);
  if (status.state!=='uploading' || offset!==status.received) conflict('Upload offset or state changed');
  if (!bytes.byteLength || bytes.byteLength>4*1024*1024 || offset+bytes.byteLength>status.bytes) invalid('Invalid chunk size');
  const stable=Buffer.from(bytes);const result=Object.freeze({uploadId,projectId:scope.projectId,offset,bytes:stable.length,sha256:hashBytes(stable),path:await this.blobs.writeChunk(stable)});this.appends.add(result);return result;
 }
 commitAppend(scope: ResourceScope, prepared: PreparedAppend): UploadStatus {
  this.tx();this.writable(scope);if (!this.appends.has(prepared) || prepared.projectId!==scope.projectId) invalid('Invalid prepared chunk');
  if(this.db.prepare('SELECT 1 FROM resource_file_deletions WHERE path=?').get(prepared.path)) conflict('Prepared chunk retired');
  const result=this.db.prepare("UPDATE resource_uploads SET received=received+? WHERE id=? AND project_id=? AND state='uploading' AND received=? AND received+?<=bytes").run(prepared.bytes,prepared.uploadId,scope.projectId,prepared.offset,prepared.bytes);
  if (!result.changes) conflict('Upload offset changed; query upload status before retry');
  this.db.prepare('INSERT INTO resource_upload_chunks VALUES(?,?,?,?,?)').run(prepared.uploadId,prepared.offset,prepared.bytes,prepared.sha256,prepared.path);
  return this.uploadStatus(scope,prepared.uploadId);
 }
 async prepareFinish(scope: ResourceScope, uploadId: string): Promise<PreparedFinish> {
  this.outside();const status=this.uploadStatus(scope,uploadId);
  if (status.state!=='uploading' || status.bytes!==status.received) conflict('Upload is incomplete or already finished');
  const row=this.db.prepare('SELECT expected_sha256 FROM resource_uploads WHERE id=?').get(uploadId)!;
  const chunks=this.db.prepare('SELECT * FROM resource_upload_chunks WHERE upload_id=? ORDER BY offset').all(uploadId);
  const buffers: Buffer[]=[];let offset=0;
  for (const chunk of chunks) {const bytes=await this.blobs.read(String(chunk['path']));if (Number(chunk['offset'])!==offset || bytes.length!==chunk['bytes'] || hashBytes(bytes)!==chunk['sha256']) invalid('Corrupt upload chunk');buffers.push(bytes);offset+=bytes.length;}
  if (offset!==status.bytes) invalid('Incomplete upload chunks');
  const blob=await this.blobs.prepare(Buffer.concat(buffers,offset),status.mime,row['expected_sha256']===null?undefined:String(row['expected_sha256']));
  const result=Object.freeze({uploadId,projectId:scope.projectId,blob});this.finishes.add(result);return result;
 }
 async prepareBytes(bytes: Uint8Array, mime='application/octet-stream', sha256?: string): Promise<PreparedBlob> {this.outside();return this.blobs.prepare(bytes,mime,sha256);}
 async prepareProjectFile(scope: ResourceScope, path: string, mime='application/octet-stream'): Promise<PreparedBlob> {
  this.outside();this.project(scope);const registeredRoot=String(this.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(scope.projectId)!['canonical_path']);const root=await realpath(registeredRoot);
  if(root!==registeredRoot) throw new ServiceError('PROJECT_UNAVAILABLE','Registered project path was replaced by a symlink');
  const resolved=await realpath(resolve(root,path));const rel=relative(root,resolved);
  if (!rel || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel)) invalid('File is outside project');
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
   const before=await file.stat();
   if (!before.isFile()) invalid('Expected a regular file');
   if(before.size>this.blobs.maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','File exceeds maximum');
   const bytes=await readBounded(file,this.blobs.maxBytes);
   const after=await file.stat();
   let current;
   try {
    const currentResolved=await realpath(resolve(root,path));
    if(currentResolved!==resolved) throw new ServiceError('CONFLICT','File changed during import');
    const currentFile=await open(currentResolved,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {current=await currentFile.stat();if(!current.isFile()) throw new ServiceError('CONFLICT','File changed during import');} finally {await currentFile.close();}
   } catch (cause) {
    if(cause instanceof ServiceError) throw cause;
    throw new ServiceError('CONFLICT','File changed during import',{cause});
   }
   if(bytes.length!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.dev!==after.dev || before.ino!==after.ino ||
      before.size!==current.size || before.mtimeMs!==current.mtimeMs || before.dev!==current.dev || before.ino!==current.ino)
    throw new ServiceError('CONFLICT','File changed during import');
   return await this.blobs.prepare(bytes,mime);
  } finally {await file.close();}
 }
 private register(blob: PreparedBlob): void {
  this.tx();this.blobs.assertPrepared(blob);
  if(this.db.prepare('SELECT 1 FROM resource_file_deletions WHERE path=?').get(blob.path)) conflict('Prepared file was retired; prepare again');
  const prior=this.db.prepare('SELECT b.bytes,f.path FROM blobs b LEFT JOIN resource_blob_files f USING(sha256) WHERE b.sha256=?').get(blob.sha256);
  if (prior && Number(prior['bytes'])!==blob.bytes) invalid('Blob hash metadata mismatch');
  this.db.prepare('INSERT OR IGNORE INTO blobs(sha256,bytes) VALUES(?,?)').run(blob.sha256,blob.bytes);
  if (!prior?.['path']) this.db.prepare('INSERT INTO resource_blob_files VALUES(?,?)').run(blob.sha256,blob.path);
  else if(prior['path']!==blob.path) this.queueFile(blob.path);
  if(blob.text!==null) this.db.prepare("INSERT OR IGNORE INTO resource_representations VALUES(?,'builtin-utf8',1,'ready','text/plain',?,NULL)").run(blob.sha256,blob.text);
 }
 private queueFile(path: string): void {this.db.prepare('INSERT OR IGNORE INTO resource_file_deletions(path,created_at) VALUES(?,?)').run(path,this.now());}
 /** Explicit cleanup of a known failed preparation; never scan unknown files.
  * The permanent tombstone prevents any later commit from reusing this path. */
 discardPrepared(blob: PreparedBlob): boolean {
  this.tx();this.blobs.assertPrepared(blob);
  if(this.db.prepare('SELECT 1 FROM resource_blob_files WHERE path=?').get(blob.path)) return false;
  this.queueFile(blob.path);return true;
 }
 discardAppend(scope: ResourceScope, prepared: PreparedAppend): boolean {
  this.tx();this.project(scope);if(!this.appends.has(prepared) || prepared.projectId!==scope.projectId) invalid('Invalid prepared chunk');
  if(this.db.prepare('SELECT 1 FROM resource_upload_chunks WHERE path=?').get(prepared.path)) return false;
  this.queueFile(prepared.path);return true;
 }
 cancelUpload(scope: ResourceScope, uploadId: string): void {
  this.tx();this.writable(scope);const status=this.uploadStatus(scope,uploadId);if(status.state!=='uploading') conflict('Finished upload cannot be cancelled');
  for(const row of this.db.prepare('SELECT path FROM resource_upload_chunks WHERE upload_id=?').all(uploadId)) this.queueFile(String(row['path']));
  this.db.prepare('DELETE FROM resource_upload_chunks WHERE upload_id=?').run(uploadId);this.db.prepare('DELETE FROM resource_uploads WHERE id=?').run(uploadId);
 }
 commitFinish(scope: ResourceScope, prepared: PreparedFinish, target: UploadTarget): LibraryAsset | CanvasCreated {
  this.tx();this.writable(scope);if (!this.finishes.has(prepared) || prepared.projectId!==scope.projectId || target.projectId!==scope.projectId) invalid('Invalid prepared upload');
  const status=this.uploadStatus(scope,prepared.uploadId);if(status.state!=='uploading' || status.received!==status.bytes) conflict('Upload no longer committable');
  const result=target.mode==='canvas'?this.createCanvasFromPrepared(target,prepared.blob,target.name):this.createLibraryFromPrepared(target,prepared.blob);
  this.db.prepare("UPDATE resource_uploads SET state='finished',sha256=? WHERE id=?").run(prepared.blob.sha256,prepared.uploadId);
  for (const row of this.db.prepare('SELECT path FROM resource_upload_chunks WHERE upload_id=?').all(prepared.uploadId)) this.queueFile(String(row['path']));
  this.db.prepare('DELETE FROM resource_upload_chunks WHERE upload_id=?').run(prepared.uploadId);
  return result;
 }
 createLibraryFromPrepared(target: LibraryTarget, blob: PreparedBlob): LibraryAsset {this.tx();this.writable(target);this.register(blob);return this.libraryFromBlob(target,blob.sha256,blob.mime);}
 private libraryFromBlob(target: LibraryTarget, sha256: string, mime: string): LibraryAsset {
  if(target.mode!=='new' && target.mode!=='update') invalid('Choose new or explicit update target');
  if(!this.db.prepare('SELECT 1 FROM resource_blob_files WHERE sha256=?').get(sha256)) throw new ServiceError('NOT_IMPLEMENTED','Legacy blob storage has not been registered');
  this.writable(target);const title=name(target.name);let id: string,version: number;
  if(target.mode==='new') {id=randomUUID();version=1;this.db.prepare('INSERT INTO assets(id,project_id,name,current_version) VALUES(?,?,?,1)').run(id,target.projectId,title);}
  else {
   id=target.assetId;const old=this.db.prepare('SELECT * FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL').get(id,target.projectId);if(!old) return missing();
   if(old['current_version']!==target.expectedVersion) conflict();version=target.expectedVersion+1;
   this.db.prepare('UPDATE assets SET name=?,current_version=? WHERE id=?').run(title,version,id);
  }
  this.db.prepare("INSERT INTO asset_versions(asset_id,version,sha256,mime,state,representation_version) VALUES(?,?,?,?,'ready',?)").run(id,version,sha256,mime,this.representationVersion(sha256,mime));
  this.event('asset.changed',target,null,id,version,target.mode==='new'?'created':'updated');
  return this.getAsset(target,id);
 }
 createCanvasFromPrepared(scope: CanvasScope, blob: PreparedBlob, title: string): CanvasCreated {this.tx();this.writableGraph(scope);this.register(blob);return this.createCanvasFromReadyBlob(scope,blob.sha256,blob.mime,title);}
 private representationVersion(sha256: string, mime: string): number | null {return supportsText(mime) && this.db.prepare("SELECT 1 FROM resource_representations WHERE sha256=? AND processor='builtin-utf8' AND version=1 AND state='ready'").get(sha256)?1:null;}
 /** Editing is separate from canvas upload (which always creates an identity).
  * Existing node/history refs stay pinned; caller explicitly attaches the new hold. */
 updateCanvasFromPrepared(scope: CanvasScope, resourceId: string, expectedVersion: number, blob: PreparedBlob, title?: string): CanvasCreated {
  this.tx();this.writableGraph(scope);const old=this.getCanvas(scope,resourceId);if(old.current.version!==expectedVersion) conflict();
  this.register(blob);const version=expectedVersion+1;
  this.db.prepare('INSERT INTO canvas_resource_versions(resource_id,version,sha256,mime,representation_version) VALUES(?,?,?,?,?)').run(resourceId,version,blob.sha256,blob.mime,this.representationVersion(blob.sha256,blob.mime));
  this.db.prepare('UPDATE canvas_resources SET current_version=?,name=? WHERE id=?').run(version,name(title ?? old.name),resourceId);
  this.event('canvas_resource.changed',scope,scope.graphId,resourceId,version,'updated');
  return {resource:this.getCanvas(scope,resourceId),referenceId:this.holdCanvasResource(scope,resourceId,version)};
 }
 /** Trusted helper: caller authorizes source; never expose as a public hash API. */
 createCanvasFromReadyBlob(scope: CanvasScope, sha256: string, mime: string, title: string): CanvasCreated {
  this.tx();this.writableGraph(scope);name(title);
  if(!this.db.prepare('SELECT 1 FROM resource_blob_files WHERE sha256=?').get(sha256)) missing();
  const id=randomUUID();
  this.db.prepare('INSERT INTO canvas_resources(id,project_id,graph_id,name,current_version) VALUES(?,?,?,?,1)').run(id,scope.projectId,scope.graphId,name(title));
  this.db.prepare('INSERT INTO canvas_resource_versions(resource_id,version,sha256,mime,representation_version) VALUES(?,1,?,?,?)').run(id,sha256,mime,this.representationVersion(sha256,mime));
  this.event('canvas_resource.created',scope,scope.graphId,id,1,'created');
  const referenceId=this.holdCanvasResource(scope,id,1);return {resource:this.getCanvas(scope,id),referenceId};
 }
 holdCanvasResource(scope: CanvasScope, resourceId: string, version: number): string {
  this.tx();this.writableGraph(scope);this.readCanvasVersion(scope,resourceId,version);const id=randomUUID();
  this.db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind) VALUES(?,?,?,?,'graph')").run(id,resourceId,version,scope.graphId);return id;
 }
 attachNodeReference(scope: CanvasScope, resourceId: string, version: number, nodeId: string, releaseGraphHold?: string): string {
  this.tx();this.writableGraph(scope);this.readCanvasVersion(scope,resourceId,version);
  if(!this.db.prepare('SELECT 1 FROM nodes WHERE id=? AND graph_id=? AND deleted=0').get(nodeId,scope.graphId)) missing();
  const id=randomUUID();this.db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind,node_id) VALUES(?,?,?,?,'node',?)").run(id,resourceId,version,scope.graphId,nodeId);
  if(releaseGraphHold!==undefined) this.db.prepare("DELETE FROM canvas_resource_references WHERE id=? AND graph_id=? AND resource_id=? AND owner_kind='graph'").run(releaseGraphHold,scope.graphId,resourceId);
  this.event('canvas_resource.changed',scope,scope.graphId,resourceId,version,'attached');return id;
 }
 releaseCanvasReference(scope: CanvasScope, referenceId: string): void {
  this.tx();this.writableGraph(scope);const row=this.db.prepare("SELECT resource_id,resource_version FROM canvas_resource_references WHERE id=? AND graph_id=? AND owner_kind IN ('graph','node')").get(referenceId,scope.graphId);
  if(row) {this.db.prepare('DELETE FROM canvas_resource_references WHERE id=?').run(referenceId);this.event('canvas_resource.changed',scope,scope.graphId,String(row['resource_id']),Number(row['resource_version']),'reference_released');}
 }
 /** Public temp-upload release cannot remove node/snapshot/history ownership. */
 releaseGraphReference(scope: CanvasScope, referenceId: string): void {
  this.tx();this.writableGraph(scope);
  if(!this.db.prepare("SELECT 1 FROM canvas_resource_references WHERE id=? AND graph_id=? AND owner_kind='graph'").get(referenceId,scope.graphId)) missing();
  this.releaseCanvasReference(scope,referenceId);this.collectGarbage();
 }
 /** Called after Graphs inserts node/history ownership, in the same transaction.
  * Consume only the attached immutable version's temporary graph holds. */
 consumeGraphHolds(scope: CanvasScope, resourceId: string, version: number): number {
  this.tx();this.writableGraph(scope);this.readCanvasVersion(scope,resourceId,version);
  if(!this.db.prepare("SELECT 1 FROM canvas_resource_references WHERE resource_id=? AND resource_version=? AND owner_kind='node' UNION ALL SELECT 1 FROM node_resource_history WHERE resource_id=? AND resource_version=? LIMIT 1").get(resourceId,version,resourceId,version)) invalid('Attach node/history ownership before consuming graph holds');
  return Number(this.db.prepare("DELETE FROM canvas_resource_references WHERE graph_id=? AND resource_id=? AND resource_version=? AND owner_kind='graph'").run(scope.graphId,resourceId,version).changes);
 }
 copyAssetToCanvas(scope: CanvasScope, assetId: string, expectedAssetVersion: number): CanvasCreated {
  this.tx();this.writableGraph(scope);const asset=this.getAsset(scope,assetId);if(asset.deleted) missing();if(asset.current.version!==expectedAssetVersion) conflict();
  return this.createCanvasFromReadyBlob(scope,asset.current.sha256,asset.current.mime,asset.name);
 }
 /** Clipboard copies a pinned, authorized canvas version into a new identity.
  * Never expose an arbitrary blob-hash copy API or resurrect a collected source. */
 copyCanvasToCanvas(scope: CanvasScope, sourceGraphId: string, resourceId: string, version: number): CanvasCreated {
  this.tx();this.writableGraph(scope);
  const source={...scope,graphId:sourceGraphId};
  const resource=this.getCanvas(source,resourceId);
  const pinned=this.readCanvasVersion(source,resourceId,version);
  return this.createCanvasFromReadyBlob(scope,pinned.sha256,pinned.mime,resource.name);
 }
 saveCanvasToLibrary(scope: CanvasScope, resourceId: string, expectedResourceVersion: number, title: string): LibraryAsset {
  this.tx();this.writableGraph(scope);const resource=this.getCanvas(scope,resourceId);if(resource.current.version!==expectedResourceVersion) conflict();
  return this.libraryFromBlob({...scope,mode:'new',name:title},resource.current.sha256,resource.current.mime);
 }
 copyAssetToProject(scope: ResourceScope, assetId: string, expectedVersion: number, title?: string): LibraryAsset {
  this.tx();this.writable(scope);const asset=this.getAsset(scope,assetId);if(asset.deleted) missing();if(asset.current.version!==expectedVersion) conflict();
  return this.libraryFromBlob({...scope,mode:'new',name:title ?? asset.name},asset.current.sha256,asset.current.mime);
 }
 private version(row: Row): ResourceVersion {return {version:Number(row['version']),sha256:String(row['sha256']),bytes:Number(row['bytes']),mime:String(row['mime']),state:'ready',representationVersion:row['representation_version']===null?null:Number(row['representation_version'])};}
 getAsset(scope: ResourceScope, id: string): LibraryAsset {
  this.project(scope);const row=this.db.prepare('SELECT * FROM assets WHERE id=? AND (project_id=? OR (shared=1 AND deleted_at IS NULL))').get(id,scope.projectId);if(!row) return missing();
  const current=this.readAssetVersion(scope,id,Number(row['current_version']));return {id,projectId:String(row['project_id']),name:String(row['name']),shared:row['shared']===1,deleted:row['deleted_at']!==null,current:{...current,assetId:id}};
 }
 listAssets(scope: ResourceScope, options: {name?: string; search?: string; deleted?: boolean; scope?: 'project'|'shared'|'available'; limit?: number; offset?: number} = {}): LibraryAsset[] {
  if(options.deleted!==undefined && typeof options.deleted!=='boolean') invalid('Invalid deleted filter');
   if(options.name!==undefined) name(options.name);
   if(options.search!==undefined) name(options.search);
  this.project(scope);const limit=options.limit ?? 100,offset=options.offset ?? 0;integer(limit);integer(offset);if(limit<1 || limit>1000) invalid('Invalid page size');
  const selection=options.scope ?? 'available';if(!['project','shared','available'].includes(selection)) invalid('Invalid library scope');
  const where=selection==='project'?'project_id=?':selection==='shared'?'shared=1 AND (project_id=? OR deleted_at IS NULL)':'(project_id=? OR (shared=1 AND deleted_at IS NULL))';
   const sql='SELECT id FROM assets WHERE '+where+' AND deleted_at IS '+(options.deleted?'NOT ':'')+'NULL AND (? IS NULL OR name=?) AND (? IS NULL OR instr(lower(name),lower(?))>0) ORDER BY name,id LIMIT ? OFFSET ?';
   return this.db.prepare(sql).all(scope.projectId,options.name ?? null,options.name ?? null,options.search ?? null,options.search ?? null,limit,offset).map(row=>this.getAsset(scope,String(row['id'])));
 }
 listSameNameAssets(scope: ResourceScope, title: string): LibraryAsset[] {return this.listAssets(scope,{name:name(title),scope:'project'});}
 setShared(scope: ResourceScope, id: string, shared: boolean): LibraryAsset {this.tx();this.writable(scope);if(typeof shared!=='boolean') invalid('Invalid shared flag');if(!this.db.prepare('UPDATE assets SET shared=? WHERE id=? AND project_id=? AND deleted_at IS NULL').run(shared?1:0,id,scope.projectId).changes) missing();const asset=this.getAsset(scope,id);this.event('asset.changed',scope,null,id,asset.current.version,'sharing_changed');return asset;}
 emptyTrash(scope: ResourceScope): { removed: number; retained: number } {
  this.tx();this.writable(scope);
  if(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) throw new ServiceError('CONFLICT','正在备份，请稍后清空回收站。');
  let removed=0,retained=0;
  for(const row of this.db.prepare('SELECT id,current_version FROM assets WHERE project_id=? AND deleted_at IS NOT NULL').all(scope.projectId)) {
   const id=String(row['id']);
   if(this.assetReferenced(id)) {retained++;continue;}
   this.db.prepare('DELETE FROM asset_versions WHERE asset_id=?').run(id);
   this.db.prepare('DELETE FROM assets WHERE id=?').run(id);
   this.event('asset.changed',scope,null,id,Number(row['current_version']),'collected');removed++;
  }
  return {removed,retained};
 }
 softDelete(scope: ResourceScope, id: string): LibraryAsset {
  this.tx();this.writable(scope);const asset=this.getAsset(scope,id);if(asset.projectId!==scope.projectId) missing();
  if(!asset.deleted) {this.db.prepare('UPDATE assets SET deleted_at=?,unreferenced_since=? WHERE id=?').run(this.now(),this.assetReferenced(id)?null:this.now(),id);this.event('asset.changed',scope,null,id,asset.current.version,'deleted');}return this.getAsset(scope,id);
 }
 restore(scope: ResourceScope, id: string): LibraryAsset {this.tx();this.writable(scope);if(!this.db.prepare('UPDATE assets SET deleted_at=NULL,unreferenced_since=NULL WHERE id=? AND project_id=?').run(id,scope.projectId).changes) missing();const asset=this.getAsset(scope,id);this.event('asset.changed',scope,null,id,asset.current.version,'restored');return asset;}
 getCanvas(scope: CanvasScope, id: string): CanvasResource {this.graph(scope);const row=this.db.prepare('SELECT * FROM canvas_resources WHERE id=? AND graph_id=?').get(id,scope.graphId);if(!row) return missing();return {id,projectId:scope.projectId,graphId:scope.graphId,name:String(row['name']),current:{...this.readCanvasVersion(scope,id,Number(row['current_version'])),resourceId:id}};}
 listCanvas(scope: CanvasScope): CanvasResource[] {this.graph(scope);return this.db.prepare('SELECT id FROM canvas_resources WHERE graph_id=? ORDER BY id').all(scope.graphId).map(row=>this.getCanvas(scope,String(row['id'])));}
 readCanvasVersion(scope: CanvasScope, id: string, version: number): ResourceVersion {
  this.graph(scope);integer(version);const row=this.db.prepare('SELECT v.*,b.bytes FROM canvas_resource_versions v JOIN canvas_resources r ON r.id=v.resource_id JOIN blobs b USING(sha256) WHERE r.id=? AND r.graph_id=? AND v.version=?').get(id,scope.graphId,version);if(!row) return missing();return this.version(row);
 }
 readAssetVersion(scope: ResourceScope, id: string, version: number): ResourceVersion {
  this.project(scope);integer(version);
  const row=this.db.prepare("SELECT v.*,b.bytes FROM asset_versions v JOIN assets a ON a.id=v.asset_id JOIN blobs b USING(sha256) WHERE a.id=? AND v.version=? AND v.state='ready' AND (a.project_id=? OR (a.shared=1 AND a.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM asset_references ar LEFT JOIN runs r ON r.id=ar.run_id LEFT JOIN nodes n ON n.id=ar.node_id LEFT JOIN graphs g ON g.id=n.graph_id WHERE ar.asset_id=a.id AND ar.asset_version=v.version AND (r.project_id=? OR g.project_id=?)) OR EXISTS(SELECT 1 FROM outputs o JOIN runs r ON r.id=o.run_id WHERE o.asset_id=a.id AND o.asset_version=v.version AND r.project_id=?))").get(id,version,scope.projectId,scope.projectId,scope.projectId,scope.projectId);
  if(!row) return missing();return this.version(row);
 }
 async readContent(scope: ResourceScope | CanvasScope, kind: 'asset'|'canvas', id: string, version: number, range?: {start: number; end?: number}): Promise<{bytes: Buffer; mime: string; total: number; start: number; end: number}> {
  this.outside();const lease=randomUUID();let metadata!: ResourceVersion;let path='';
  transaction(this.db,()=>{metadata=kind==='asset'?this.readAssetVersion(scope,id,version):this.readCanvasVersion(scope as CanvasScope,id,version);const file=this.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(metadata.sha256);if(!file) throw new ServiceError('NOT_IMPLEMENTED','Legacy blob storage has not been registered');path=String(file['path']);this.db.prepare('INSERT INTO resource_read_leases VALUES(?,?)').run(lease,metadata.sha256);});
  try {
   const bytes=await this.blobs.read(path);if(bytes.length!==metadata.bytes || hashBytes(bytes)!==metadata.sha256) throw new ServiceError('INTERNAL_ERROR','Stored blob integrity check failed');
   const start=range?.start ?? 0,end=range?.end ?? bytes.length-1;integer(start);if(range && (start>=bytes.length || !Number.isSafeInteger(end) || end<start || end>=bytes.length)) invalid('Unsatisfiable byte range');
   return {bytes:bytes.subarray(start,end+1),mime:metadata.mime,total:bytes.length,start,end};
  } finally {transaction(this.db,()=>this.db.prepare('DELETE FROM resource_read_leases WHERE id=?').run(lease));}
 }
 async thumbnail(scope: ResourceScope | CanvasScope, kind: 'asset'|'canvas', id: string, version: number, size: number = IMAGE_THUMBNAIL_LEVELS[0]): Promise<{bytes: Buffer; mime: string; total: number; start: number; end: number}> {
  const metadata=kind==='asset'?this.readAssetVersion(scope,id,version):this.readCanvasVersion(scope as CanvasScope,id,version);
  if(!['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'].includes(metadata.mime)) throw new ServiceError('INVALID_REQUEST','仅支持图片资源缩略图。');
  const original=await this.readContent(scope,kind,id,version);
  const image=sharp(original.bytes,{animated:false});
  const info=await image.metadata();
  const maxDimension=Math.max(info.width ?? 0, info.height ?? 0);
  const target=IMAGE_THUMBNAIL_LEVELS.includes(size as typeof IMAGE_THUMBNAIL_LEVELS[number]) ? size : IMAGE_THUMBNAIL_LEVELS[0];
  if (maxDimension > 0 && maxDimension <= target) return original;
  const bytes=await image.rotate().resize({width:target,height:target,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
  return {bytes,mime:'image/webp',total:bytes.length,start:0,end:Math.max(0,bytes.length-1)};
 }
 async representation(scope: ResourceScope | CanvasScope, kind: 'asset'|'canvas', id: string, version: number): Promise<{state: 'ready'|'unsupported'; processor: string; version: number; mime: string; text: string | null; reason: string | null}> {
  this.outside();const metadata=kind==='asset'?this.readAssetVersion(scope,id,version):this.readCanvasVersion(scope as CanvasScope,id,version);
  const supported=supportsText(metadata.mime);
  const result={state:supported?'ready' as const:'unsupported' as const,processor:'builtin-utf8',version:1,mime:'text/plain',text:null as string|null,reason:supported?null:'No extractor installed for '+metadata.mime};
  if(supported) result.text=new TextDecoder('utf-8',{fatal:true}).decode((await this.readContent(scope,kind,id,version)).bytes);
  transaction(this.db,()=>{if(this.db.prepare('SELECT 1 FROM blobs WHERE sha256=?').get(metadata.sha256)) this.db.prepare('INSERT OR REPLACE INTO resource_representations VALUES(?,?,?,?,?,?,?)').run(metadata.sha256,result.processor,result.version,result.state,result.mime,result.text,result.reason);});return result;
 }
 /** DB-only resolver for InputPreparation; caller already selected a scoped version.
  * No extraction or file I/O is performed in the snapshot transaction. */
 readPreparedRepresentation(resource: {resourceId: string; version: number; sha256: string; mime: string; bytes: number; representationVersion: number | null}): {state: 'ready'|'failed'; resourceSha256: string; representationVersion: number | null; text: string | null; contentHash: string | null} | null {
  const row=this.db.prepare('SELECT v.*,b.bytes FROM canvas_resource_versions v JOIN blobs b USING(sha256) JOIN resource_blob_files f USING(sha256) WHERE resource_id=? AND version=?').get(resource.resourceId,resource.version);
  if(!row || row['sha256']!==resource.sha256 || row['mime']!==resource.mime || row['bytes']!==resource.bytes || row['representation_version']!==resource.representationVersion) return null;
  const common={resourceSha256:resource.sha256,representationVersion:resource.representationVersion};
  if(['image/png','image/jpeg','image/gif','image/webp'].includes(resource.mime)) return {...common,state:'ready',text:null,contentHash:resource.sha256};
  if(!supportsText(resource.mime)) return {...common,state:'ready',text:null,contentHash:resource.sha256};
  const representation=this.db.prepare("SELECT text,state FROM resource_representations WHERE sha256=? AND processor='builtin-utf8' AND version=?").get(resource.sha256,resource.representationVersion);
  if(!supportsText(resource.mime) || representation?.['state']!=='ready' || typeof representation['text']!=='string') return {...common,state:'failed',text:null,contentHash:null};
  const text=representation['text'];return {...common,state:'ready',text,contentHash:hashBytes(Buffer.from(text))};
 }
 async preview(scope: ResourceScope | CanvasScope, kind: 'asset'|'canvas', id: string, version: number) {
  const metadata=kind==='asset'?this.readAssetVersion(scope,id,version):this.readCanvasVersion(scope as CanvasScope,id,version);
  if(['image/png','image/jpeg','image/gif','image/webp','image/svg+xml','video/mp4','video/webm'].includes(metadata.mime)) return {state:'ready' as const,processor:'original-media',version:1,content:await this.readContent(scope,kind,id,version)};
  return this.representation(scope,kind,id,version);
 }
 /** Preserve exact ID/hash leaves in legacy snapshot JSON without rewriting it. */
 private snapshotMentions(value: string): boolean {return !!this.db.prepare("SELECT 1 FROM snapshots s,json_tree(s.payload) j WHERE j.type='text' AND j.value=? LIMIT 1").get(value);}
 /** Typed snapshots protect only their named identity; shared hashes protect bytes. */
 private snapshotUnboundHash(value: string): boolean {
  return !!this.db.prepare("SELECT 1 FROM snapshots s,json_tree(s.payload) j WHERE j.type='text' AND j.value=? AND NOT EXISTS(SELECT 1 FROM json_each(s.payload,j.path) member WHERE member.key IN ('resourceId','assetId','resource_id','asset_id','legacyAsset') AND member.type='text' AND length(member.value)>0) LIMIT 1").get(value);
 }
 private assetReferenced(id: string): boolean {
  if(this.db.prepare('SELECT 1 FROM asset_references WHERE asset_id=? UNION ALL SELECT 1 FROM outputs WHERE asset_id=? LIMIT 1').get(id,id) || this.snapshotMentions(id)) return true;
  return this.db.prepare('SELECT sha256 FROM asset_versions WHERE asset_id=?').all(id).some(row=>this.snapshotUnboundHash(String(row['sha256'])));
 }
 private canvasReferenced(id: string, includeUnboundHash=true): boolean {
  if(this.db.prepare('SELECT 1 FROM graph_document_resources WHERE resource_id=? LIMIT 1').get(id)) return true;
  if(this.db.prepare('SELECT 1 FROM canvas_resource_references WHERE resource_id=? UNION ALL SELECT 1 FROM canvas_outputs WHERE resource_id=? LIMIT 1').get(id,id) || this.snapshotMentions(id)) return true;
  if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_resource_history'").get() && this.db.prepare('SELECT 1 FROM node_resource_history WHERE resource_id=? LIMIT 1').get(id)) return true;
  return includeUnboundHash && this.db.prepare('SELECT sha256 FROM canvas_resource_versions WHERE resource_id=?').all(id).some(row=>this.snapshotUnboundHash(String(row['sha256'])));
 }
 collectGarbage(only?:{graphId:string;blobHashes:string[]}, canvasOnly=false): {canvas: number; assets: number; blobs: number} {
  this.tx();const counts={canvas:0,assets:0,blobs:0};const now=this.now();
  if(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) return counts;
  this.db.prepare('DELETE FROM graph_document_heads WHERE expires_at<=?').run(now);
  this.db.prepare('DELETE FROM graph_document_versions WHERE graph_id NOT IN (SELECT graph_id FROM graph_document_heads)').run();
  this.db.prepare('DELETE FROM node_resource_history WHERE node_id IN (SELECT id FROM nodes WHERE deleted=1 AND undo_expires_at<=?)').run(now);
  this.db.prepare('UPDATE nodes SET undo_expires_at=NULL WHERE deleted=1 AND undo_expires_at<=?').run(now);
  for(const row of this.db.prepare('SELECT r.id,r.project_id,r.graph_id,r.current_version FROM canvas_resources r JOIN graphs g ON g.id=r.graph_id WHERE (? IS NULL AND g.archived=0 AND g.trashed=0) OR r.graph_id=?').all(only?.graphId??null,only?.graphId??null)) {const id=String(row['id']);if(this.canvasReferenced(id,!only)) continue;this.db.prepare('DELETE FROM canvas_resource_versions WHERE resource_id=?').run(id);this.db.prepare('DELETE FROM canvas_resources WHERE id=?').run(id);this.event('canvas_resource.collected',{projectId:String(row['project_id'])},String(row['graph_id']),id,Number(row['current_version']),'collected');counts.canvas++;}
  for(const row of only||canvasOnly?[]:this.db.prepare('SELECT id,project_id,current_version,unreferenced_since FROM assets WHERE deleted_at IS NOT NULL').all()) {
   const id=String(row['id']);if(this.assetReferenced(id)) {this.db.prepare('UPDATE assets SET unreferenced_since=NULL WHERE id=?').run(id);continue;}
   if(row['unreferenced_since']===null) {this.db.prepare('UPDATE assets SET unreferenced_since=? WHERE id=?').run(now,id);continue;}
   if(Number(row['unreferenced_since'])>now-30*DAY) continue;
   this.db.prepare('DELETE FROM asset_versions WHERE asset_id=?').run(id);this.db.prepare('DELETE FROM assets WHERE id=?').run(id);this.event('asset.changed',{projectId:String(row['project_id'])},null,id,Number(row['current_version']),'collected');counts.assets++;
  }
  const candidates=this.db.prepare('SELECT b.sha256,f.path FROM blobs b JOIN resource_blob_files f USING(sha256) WHERE NOT EXISTS(SELECT 1 FROM asset_versions WHERE sha256=b.sha256) AND NOT EXISTS(SELECT 1 FROM canvas_resource_versions WHERE sha256=b.sha256) AND NOT EXISTS(SELECT 1 FROM resource_read_leases WHERE sha256=b.sha256)').all();
  for(const row of candidates) {
   const hash=String(row['sha256']);if((only&&!only.blobHashes.includes(hash))||this.snapshotMentions(hash)) continue;
   this.db.exec('SAVEPOINT resource_gc_blob');
   try {
    this.db.prepare("DELETE FROM resource_uploads WHERE sha256=? AND state='finished'").run(hash);this.db.prepare('DELETE FROM resource_representations WHERE sha256=?').run(hash);
    this.db.prepare('DELETE FROM resource_blob_files WHERE sha256=?').run(hash);this.db.prepare('DELETE FROM blobs WHERE sha256=?').run(hash);this.queueFile(String(row['path']));
    this.db.exec('RELEASE resource_gc_blob');counts.blobs++;
   } catch(error) {this.db.exec('ROLLBACK TO resource_gc_blob; RELEASE resource_gc_blob');if(!String(error).includes('FOREIGN KEY')) throw error;}
  }
  return counts;
 }
 async drainFileDeletions(): Promise<{removed: number; failed: number}> {
  this.outside();let removed=0,failed=0;
  const lease=randomUUID();const acquired=transaction(this.db,()=>{
   if(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) return false;
   this.db.prepare("INSERT INTO resource_maintenance_leases VALUES(?,'drain',?)").run(lease,this.now());return true;
  });
  if(!acquired) return {removed,failed};
  try {
  for(const row of this.db.prepare('SELECT path FROM resource_file_deletions WHERE completed=0 ORDER BY created_at').all()) {
   const path=String(row['path']);
   if(this.db.prepare('SELECT 1 FROM resource_blob_files WHERE path=? UNION ALL SELECT 1 FROM resource_upload_chunks WHERE path=? LIMIT 1').get(path,path)) {failed++;continue;}
   try {await this.blobs.remove(path);transaction(this.db,()=>this.db.prepare('UPDATE resource_file_deletions SET completed=1 WHERE path=?').run(path));removed++;} catch {failed++;}
  }return {removed,failed};
  } finally {transaction(this.db,()=>this.db.prepare('DELETE FROM resource_maintenance_leases WHERE id=?').run(lease));}
 }
 /** Global cross-connection GC barrier for online SQLite + immutable-file copies.
  * Existing drains finish first; new drains and logical GC stop at the barrier.
  * Crashed leases fail closed; only an exclusive offline owner may clear them. */
 async withBlobLease<T>(work: () => Promise<T>): Promise<T> {
  this.outside();const lease=randomUUID();
  transaction(this.db,()=>this.db.prepare("INSERT INTO resource_maintenance_leases VALUES(?,'backup',?)").run(lease,this.now()));
  try {
   const deadline=Date.now()+5000;
   while(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='drain' LIMIT 1").get()) {
    if(Date.now()>=deadline) throw new ServiceError('MAINTENANCE','File drain did not quiesce; retry backup after checking maintenance leases');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   return await work();
  } finally {transaction(this.db,()=>this.db.prepare('DELETE FROM resource_maintenance_leases WHERE id=?').run(lease));}
 }
}
