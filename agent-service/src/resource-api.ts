import type { IncomingMessage } from 'node:http';
import type { Json } from '@openworkgraph/protocol';
import { Auth } from './auth.js';
import { Resources } from './resources.js';
import type { ResourceScope, CanvasScope, UploadTarget } from './resources.js';
import type { PreparedBlob } from './blob-store.js';
import { Graphs, assertProjectWritable } from './graphs.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { Repositories } from './persistence/repositories.js';
import { transaction } from './persistence/database.js';
import type { ApiResult } from './api.js';

const invalid=(message: string): never => {throw new ServiceError('INVALID_REQUEST',message);};
const notFound=(): never => {throw new ServiceError('NOT_FOUND','资源接口不存在。');};
function string(value: unknown, max=512): string {if(typeof value!=='string' || !value.trim() || value.length>max || [...value].some(c=>c.charCodeAt(0)<32)) return invalid('需要有效且长度受限的字符串。');return value;}
function id(value: unknown): string {const result=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(result)) invalid('无效的标识符。');return result;}
function integer(value: unknown, min=0, max=Number.MAX_SAFE_INTEGER): number {if(typeof value!=='number' || !Number.isSafeInteger(value) || value<min || value>max) return invalid('整数超出允许范围。');return value;}
function version(value: string): number {if(!/^[1-9][0-9]*$/.test(value)) invalid('版本须为规范正整数。');return integer(Number(value),1);}
function fields(body: Record<string,unknown> | undefined, required: string[], optional: string[]=[]): Record<string,unknown> {
 if(!body || required.some(key=>!Object.hasOwn(body,key)) || Object.keys(body).some(key=>!required.includes(key) && !optional.includes(key))) return invalid('请求字段缺失或包含未知字段。');return body;
}

export class ResourceApi {
 constructor(readonly resources: Resources, readonly graphs: Graphs, readonly auth: Auth) {}
 private wire(value: unknown): Json {
  if(Array.isArray(value)) return value.map(item=>this.wire(item));
  if(value && typeof value==='object') {const result: Record<string,Json>={};for(const [key,item] of Object.entries(value)) {if(item!==undefined) result[key]=this.wire(item);}if(typeof result['projectId']==='string') result['serviceId']=this.graphs.serviceId;return result;}
  return value as Json;
 }
 async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
  const parts=path.split('/');
  if(parts[0]!=='' || parts[1]!=='v1' || parts[2]!=='projects' || !['uploads','assets','graphs'].includes(parts[4] ?? '')) return {handled:false};
  const section=parts[4]!;
  if(section==='graphs' && parts[6]!=='resources') return {handled:false};
  // Do not collapse empty segments, decode aliases, or ignore trailing segments.
  const projectId=id(parts[3]);const tail=parts.slice(5);for(const segment of tail) id(segment);
  const scope={serviceId:this.graphs.serviceId,projectId};
  const session=this.auth.withSession(token,origin,s=>s);
  const method=request.method;
  if(method!=='GET' && method!=='POST') return notFound();
  const body=method==='POST'?await readJson(request,6*1024*1024):undefined;
  const read=<T>(work:()=>T):T=>this.auth.withSession(token,origin,work);
  const reply=(value:unknown):ApiResult=>({handled:true,body:this.wire(value)});
  const repo=new Repositories(this.resources.db);
  const cleanups: (()=>unknown)[]=[];
  const prepare=async(promise:Promise<PreparedBlob>):Promise<PreparedBlob>=>{const blob=await promise;cleanups.push(()=>this.resources.discardPrepared(blob));return blob;};
  const mutation=async(required:string[],optional:string[],work:(input:Record<string,unknown>)=>Promise<()=>unknown>|(()=>unknown)):Promise<ApiResult>=>{
   const input=fields(body,[...required,'idempotencyKey'],optional),key=string(input['idempotencyKey'],256),namespace=session.id+':'+path;
   const replay=()=>read(()=>{assertProjectWritable(this.resources.db,projectId);return repo.replay(namespace,key,input as Json);});
   const prior=replay();if(prior!==undefined) {await this.resources.drainFileDeletions();this.auth.assertActive(token,origin);return reply(prior);}
   try {
    const commit=await work(input);
    const result=read(()=>repo.idempotent(namespace,key,input as Json,()=>{assertProjectWritable(this.resources.db,projectId);const value=commit();this.resources.collectGarbage();return this.wire(value);}));
    return reply(result);
   } catch(error) {
    const duplicate=replay();if(duplicate!==undefined) return reply(duplicate);throw error;
   } finally {
    // Capability-only cleanup still works after revocation or deactivation.
    if(cleanups.length) transaction(this.resources.db,()=>{for(const cleanup of cleanups) cleanup();});
    await this.resources.drainFileDeletions();
    this.auth.assertActive(token,origin);
   }
  };
  if(section==='uploads') {
   const [uploadId,action]=tail;
   if(method==='GET' && tail.length===1) return reply(read(()=>this.resources.uploadStatus(scope,uploadId!)));
   if(method==='POST' && tail.length===0) return mutation(['name','mime','bytes'],['sha256'],b=>{
    const name=string(b['name']),mime=string(b['mime'],128),bytes=integer(b['bytes']);const sha256=b['sha256']===undefined?undefined:string(b['sha256'],64);
    return ()=>this.resources.startUpload({...scope,name,mime,bytes,...(sha256===undefined?{}:{sha256})});
   });
   if(method==='POST' && tail.length===2 && action==='chunks') return mutation(['data','offset'],[],async b=>{
    const encoded=string(b['data'],Math.ceil(4*1024*1024/3)*4),offset=integer(b['offset']);const bytes=Buffer.from(encoded,'base64');
    if(!bytes.length || bytes.toString('base64')!==encoded) invalid('分块须为规范 Base64。');
    const prepared=await this.resources.prepareAppend(scope,uploadId!,offset,bytes);cleanups.push(()=>this.resources.discardAppend(scope,prepared));return ()=>this.resources.commitAppend(scope,prepared);
   });
   if(method==='POST' && tail.length===2 && action==='finish') {
    const mode=body?.['mode'];if(mode!=='new' && mode!=='update' && mode!=='canvas') invalid('无效的上传入口。');
    const required=mode==='canvas'?['mode','name','graphId']:mode==='update'?['mode','name','assetId','expectedVersion']:['mode','name'];
    return mutation(required,[],async b=>{
     const name=string(b['name']);const target:UploadTarget=mode==='canvas'?{...scope,mode:'canvas',graphId:id(b['graphId']),name}:mode==='update'?{...scope,mode:'update',name,assetId:id(b['assetId']),expectedVersion:integer(b['expectedVersion'],1)}:{...scope,mode:'new',name};
     if(target.mode==='canvas') read(()=>this.graphs.writable({...target,serviceId:this.graphs.serviceId}));
     const prepared=await this.resources.prepareFinish(scope,uploadId!);cleanups.push(()=>this.resources.discardPrepared(prepared.blob));return ()=>this.resources.commitFinish(scope,prepared,target);
    });
   }
   if(method==='POST' && tail.length===2 && action==='cancel') return mutation([],[],()=>()=>{this.resources.cancelUpload(scope,uploadId!);return {cancelled:true};});
  }
  if(section==='assets') {
   const [assetId,action]=tail;
   if(method==='POST' && tail.length===1 && assetId==='empty-trash') return mutation([],[],()=>()=>this.resources.emptyTrash(scope));
   if(method==='GET' && tail.length===0) return reply(read(()=>this.resources.listAssets(scope)));
   if(method==='POST' && tail.length===1 && assetId==='query') {
    const b=fields(body,[],['name','search','deleted','scope','limit','offset']);
    if(b['name']!==undefined) string(b['name']);if(b['search']!==undefined) string(b['search']);if(b['deleted']!==undefined && typeof b['deleted']!=='boolean') invalid('deleted 须为布尔值。');
    if(b['scope']!==undefined && (typeof b['scope']!=='string' || !['project','shared','available'].includes(b['scope']))) invalid('无效的查询范围。');
    if(b['limit']!==undefined) integer(b['limit'],1,1000);if(b['offset']!==undefined) integer(b['offset']);
    return reply(read(()=>this.resources.listAssets(scope,b as Parameters<Resources['listAssets']>[1])));
   }
   if(method==='POST' && tail.length===1 && assetId==='same-name') {const b=fields(body,['name']);const name=string(b['name']);return reply(read(()=>this.resources.listSameNameAssets(scope,name)));}
   if(method==='GET' && tail.length===1) return reply(read(()=>this.resources.getAsset(scope,assetId!)));
   if(method==='POST' && tail.length===2 && action==='delete') return mutation([],[],()=>()=>this.resources.softDelete(scope,assetId!));
   if(method==='POST' && tail.length===2 && action==='restore') return mutation([],[],()=>()=>this.resources.restore(scope,assetId!));
   if(method==='POST' && tail.length===2 && action==='share') return mutation(['shared'],[],b=>{const shared=b['shared'];if(typeof shared!=='boolean') return invalid('shared 须为布尔值。');return ()=>this.resources.setShared(scope,assetId!,shared);});
   if(method==='POST' && tail.length===2 && action==='copy-to-project') return mutation(['targetProjectId','expectedVersion'],['name'],b=>{
    const targetProjectId=id(b['targetProjectId']),expectedVersion=integer(b['expectedVersion'],1),name=b['name']===undefined?undefined:string(b['name']);
    return ()=>{this.resources.getAsset(scope,assetId!);return this.resources.copyAssetToProject({...scope,projectId:targetProjectId},assetId!,expectedVersion,name);};
   });
   if(method==='POST' && tail.length===1 && assetId==='import-file') return mutation(['path','mime','name'],[],async b=>{
    const path=string(b['path'],4096),mime=string(b['mime'],128),name=string(b['name']);const blob=await prepare(this.resources.prepareProjectFile(scope,path,mime));return ()=>this.resources.createLibraryFromPrepared({...scope,mode:'new',name},blob);
   });
   if(method==='GET' && (tail.length===3 || tail.length===4) && action==='versions') return this.content(request,scope,'asset',assetId!,version(tail[2]!),tail[3],read);
  }
  if(section==='graphs') {
   const graphId=tail[0]!,action=tail[2],graphScope={...scope,graphId};
   if(method==='GET' && tail.length===2) return reply(read(()=>this.resources.listCanvas(graphScope)));
   if(method==='POST' && tail.length===3 && action==='import-file') return mutation(['path','mime','name'],['sourceProjectId'],async b=>{
    const path=string(b['path'],4096),mime=string(b['mime'],128),name=string(b['name']);const sourceProjectId=b['sourceProjectId']===undefined?scope.projectId:string(b['sourceProjectId'],128);read(()=>this.graphs.writable(graphScope));const blob=await prepare(this.resources.prepareProjectFile({...scope,projectId:sourceProjectId},path,mime));return ()=>this.resources.createCanvasFromPrepared(graphScope,blob,name);
   });
   if(method==='POST' && tail.length===3 && action==='copy-asset') return mutation(['assetId','expectedVersion'],[],b=>{const assetId=id(b['assetId']),expectedVersion=integer(b['expectedVersion'],1);return ()=>this.resources.copyAssetToCanvas(graphScope,assetId,expectedVersion);});
   if(method==='POST' && tail.length===3 && action==='copy-resource') return mutation(['sourceGraphId','resourceId','version'],[],b=>{const sourceGraphId=id(b['sourceGraphId']),resourceId=id(b['resourceId']),sourceVersion=integer(b['version'],1);return ()=>this.resources.copyCanvasToCanvas(graphScope,sourceGraphId,resourceId,sourceVersion);});
   if(method==='POST' && tail.length===3 && action==='save-to-library') return mutation(['resourceId','expectedVersion','name'],[],b=>{const resourceId=id(b['resourceId']),expectedVersion=integer(b['expectedVersion'],1),name=string(b['name']);return ()=>this.resources.saveCanvasToLibrary(graphScope,resourceId,expectedVersion,name);});
   if(method==='POST' && tail.length===3 && action==='release') return mutation(['referenceId'],[],b=>{const referenceId=id(b['referenceId']);return ()=>{this.resources.releaseGraphReference(graphScope,referenceId);return {released:true};};});
   if(method==='GET' && (tail.length===5 || tail.length===6) && tail[3]==='versions') return this.content(request,graphScope,'canvas',action!,version(tail[4]!),tail[5],read);
  }
  return notFound();
 }
 private async content(request: IncomingMessage, scope: ResourceScope & {graphId?: string}, kind:'asset'|'canvas', id:string, version:number, action:string|undefined, read:<T>(work:()=>T)=>T):Promise<ApiResult> {
  const identity={...scope,serviceId:this.graphs.serviceId,...(kind==='asset'?{assetId:id}:{resourceId:id})};
  if(action===undefined) return {handled:true,body:read(()=>({...identity,...(kind==='asset'?this.resources.readAssetVersion(scope,id,version):this.resources.readCanvasVersion(scope as CanvasScope,id,version))}))};
  if(action==='representation') {const result=await this.resources.representation(scope,kind,id,version);return {handled:true,body:read(()=>({...identity,...result}))};}
  if(action==='thumbnail') {
   if(request.headers.range) invalid('缩略图不接受 Range。');
   const requestedSize = request.url ? new URL(request.url, 'http://localhost').searchParams.get('size') : null;
   const size = requestedSize === null ? 320 : integer(Number(requestedSize));
   if (![320,640,1280,2560,4096].includes(size)) invalid('无效的缩略图尺寸。');
   const result=await this.resources.thumbnail(scope,kind,id,version,size);
   return read(()=>this.binary(result,false,true));
  }
  if(action==='preview') {
   if(request.headers.range) invalid('预览表示不接受 Range；媒体范围读取请使用 content。');
   const result=await this.resources.preview(scope,kind,id,version);
   if(!('content' in result)) return {handled:true,body:read(()=>({...identity,...result}))};
   return read(()=>this.binary(result.content,false));
  }
  if(action!=='content') return notFound();
  let range:{start:number;end?:number}|undefined;
  if(request.headers.range) {const match=/^bytes=([0-9]+)-([0-9]*)$/.exec(request.headers.range);if(!match) return invalid('仅支持单个明确起点的字节范围。');range={start:integer(Number(match[1])),...(match[2]?{end:integer(Number(match[2]))}:{})};}
  const result=await this.resources.readContent(scope,kind,id,version,range);return read(()=>this.binary(result,range!==undefined,!range && (result.mime.startsWith('image/') || result.mime.startsWith('video/'))));
 }
 private binary(content:{bytes:Buffer;mime:string;total:number;start:number;end:number},ranged:boolean,cacheable=false):ApiResult {
  const svg=content.mime==='image/svg+xml';
  return {handled:true,binary:content.bytes,status:ranged?206:200,headers:{'Content-Type':content.mime,'Content-Length':String(content.bytes.length),'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',...(cacheable?{'Cache-Control':'private, max-age=31536000, immutable'}:{}),'Content-Disposition':!svg&&(content.mime.startsWith('image/')||content.mime.startsWith('video/'))?'inline':'attachment',...(svg?{'Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;"}:{}),...(ranged?{'Content-Range':'bytes '+content.start+'-'+content.end+'/'+content.total}:{})}};
 }
}
