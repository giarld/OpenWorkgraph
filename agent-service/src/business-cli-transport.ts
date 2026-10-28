import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdir, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@openworkgraph/protocol';
import type { PairResponse } from '@openworkgraph/protocol';
import type { CliRequest } from './cli-authorization.js';
import { selectedServiceDirectory } from './operations/cli-context.js';
import { readInstance, requestInstance, acquireOperationsLock } from './operations/lifecycle.js';
import { atomicJson, privateDir, readSafe } from './operations/files.js';
import { ServiceError } from './errors.js';

export class BusinessCliError extends Error {
  constructor(readonly code:string,message:string,readonly exitCode:number,readonly retryable=false,readonly details?:unknown){super(message);}
}
export function businessError(error:unknown):BusinessCliError {
  if(error instanceof BusinessCliError)return error;
  if(error instanceof ServiceError){const code=error.code;return new BusinessCliError(code,englishError(code),code==='INVALID_REQUEST'?2:code==='SERVICE_NOT_RUNNING'?3:4,error.retryable,error.details);}
  return new BusinessCliError('INVALID_REQUEST','Command failed. Check arguments, file permissions, and local workspace status.',2);
}
export function englishError(code:string):string {
  const messages:Record<string,string>={INVALID_REQUEST:'Invalid request. Check command help and input fields.',UNAUTHENTICATED:'Business session required. Use workspace login.',SESSION_REVOKED:'Business session revoked. Use workspace login.',SESSION_EXPIRED:'Business session expired. Use workspace login.',ORIGIN_DENIED:'Client identity does not match this session.',SERVICE_MISMATCH:'Workspace identity changed. Verify the saved workspace before login.',REVISION_CONFLICT:'Graph or content changed. Reread and resolve the conflict before using a new key.',IDEMPOTENCY_CONFLICT:'This key already identifies a different request. Restore the original request.',CURSOR_EXPIRED:'Read cursor expired. Discard accumulated pages and refresh.',NODE_LOCKED:'Node is locked by an active run or immutable output.',INVALID_EDGE:'This relationship is not allowed.',INPUT_BLOCKED:'Run inputs are unavailable or invalid.',INPUT_BUDGET_EXCEEDED:'Query exceeds budget. Reduce scope or increase the response budget.',NOT_FOUND:'The requested entity is unavailable.',ACTIVE_RUN:'An active run prevents this operation.',MODEL_UNAVAILABLE:'The selected model is unavailable.',PLUGIN_UNAVAILABLE:'The required plugin is unavailable.',PROJECT_INACTIVE:'The project is inactive.',PROJECT_UNAVAILABLE:'The project directory is unavailable.',NOT_IMPLEMENTED:'This capability is unavailable.',CONFLICT:'Operation conflicts with current workspace state.',PAYLOAD_TOO_LARGE:'Input exceeds the size limit.'};
  return messages[code]??'Workspace request failed ('+code+').';
}
interface RequestRecord { version:1; id:string; serviceId:string; sessionId:string; method:string; path:string; body:Record<string,unknown>; state:'pending'|'succeeded'|'failed'|'unknown'; createdAt:number; result?:unknown; authorizationKey?:string }
export class BusinessTransport {
  readonly home=process.env.OPENWORKGRAPH_CLI_HOME??join(homedir(),'.openworkgraph');
  private session!:PairResponse;
  private endpoint!:string;
  private dataDir!:string;
  private restricted=false;
  private planId:string|undefined;
  constructor(readonly timeoutMs=30000){}
  async connect(login=false):Promise<void> {
    if(process.env.OPENWORKGRAPH_RUN_CREDENTIAL!==undefined){
      if(login)throw new BusinessCliError('HOST_DENIED','Run instances cannot create independent user sessions.',3);
      try {
        const value=JSON.parse(process.env.OPENWORKGRAPH_RUN_CREDENTIAL);
        this.session=value;this.endpoint=value.endpoint;this.restricted=true;
        const endpoint=new URL(this.endpoint);if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error();
        const result=await this.request('/v1/cli/identity');
        if(result.sessionId!==this.session.session.id||result.serviceId!==this.session.serviceId)throw Error();
        return;
      }catch(error){if(error instanceof BusinessCliError)throw error;throw new BusinessCliError('UNAUTHENTICATED','Invalid or expired Run identity. Independent session fallback is forbidden.',3);}
    }
    try {
      this.dataDir=await selectedServiceDirectory();
      const record=await readInstance(this.dataDir);
      const status=await requestInstance(record,'status') as {serviceId:string;instanceId:string;localEndpoint:string};
      if(status.serviceId!==record.serviceId||status.instanceId!==record.instanceId)throw new BusinessCliError('SERVICE_MISMATCH','Local workspace instance changed.',3);
      const url=new URL(status.localEndpoint);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new BusinessCliError('SERVICE_MISMATCH','Local discovery returned an invalid endpoint.',3);
      this.endpoint=url.origin;
      await privateDir(this.home);
      const path=join(this.home,'business-session.json');
      if(!login){try{this.session=JSON.parse((await readSafe(path,16384)).toString());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(!this.session||login){
        let lock:Awaited<ReturnType<typeof acquireOperationsLock>>|undefined;const deadline=Date.now()+3000;
        while(!lock&&Date.now()<deadline){try{lock=await acquireOperationsLock(join(this.home,'business-auth'));}catch{await new Promise(resolve=>setTimeout(resolve,30));}}
        if(!lock)throw new BusinessCliError('CONNECTION_FAILED','Another CLI process is initializing the business identity. Retry shortly.',3,true);
        try {
          if(!login){try{this.session=JSON.parse((await readSafe(path,16384)).toString());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
          if(!this.session||login){this.session=await requestInstance(record,'native-session') as PairResponse;await atomicJson(path,this.session);}
        }finally{await lock.release();}
      }
      if(this.session.serviceId!==record.serviceId)throw new BusinessCliError('SERVICE_MISMATCH','Saved business session belongs to another workspace. Verify identity before workspace login.',3);
      const info=await fetch(this.endpoint+'/v1/info',{headers:{'X-Workgraph-Service-Id':record.serviceId},signal:AbortSignal.timeout(this.timeoutMs),redirect:'error'});
      const value=await info.json() as {serviceId:string;protocolVersion:string};if(!info.ok||value.serviceId!==record.serviceId||value.protocolVersion.split('.')[0]!==PROTOCOL_VERSION.split('.')[0])throw new BusinessCliError('SERVICE_MISMATCH','HTTP workspace identity or protocol differs from local discovery.',3);
    } catch(error){if(error instanceof BusinessCliError)throw error;throw new BusinessCliError('SERVICE_NOT_RUNNING','Cannot connect to the saved local workspace. Run status or start.',3,true);}
  }
  get identity(){return {serviceId:this.session.serviceId,sessionId:this.session.session.id};}
  private async approve(requests:CliRequest[],requestKey:string=randomUUID(),recovery?:RequestRecord):Promise<string>{
    const plan={requests,validForMs:Math.max(120000,this.timeoutMs)};
    let approved=await this.request('/v1/cli/authorizations','POST',{requestKey,...plan});
    if(recovery&&['expired','declined'].includes(approved.state)){
      // Explicit recovery may renew approval, never the business idempotency key.
      // Concurrent retries of the same expired grant share a new approval key.
      // Persist first so a disconnect can also resume that approval request.
      recovery.authorizationKey=recovery.id+':'+approved.id;
      await atomicJson(join(this.home,'requests',recovery.id+'.json'),recovery);
      approved=await this.request('/v1/cli/authorizations','POST',{requestKey:recovery.authorizationKey,...plan});
    }
    const deadline=Date.now()+this.timeoutMs;let state=approved;
    while(state.state==='pending'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,200));state=await this.request('/v1/cli/authorizations/'+approved.id);}
    if(state.state==='pending')await this.request('/v1/cli/authorizations/'+approved.id+'/cancel','POST',{});
    if(state.state!=='approved'&&state.state!=='consumed')throw new BusinessCliError(state.state==='pending'?'WAIT_TIMEOUT':'HOST_DENIED','CLI authorization was declined, expired, or timed out. No business request was sent.',state.state==='pending'?7:4,false,{authorizationId:approved.id});
    return approved.id;
  }
  async withPlan<T>(requests:CliRequest[],work:()=>Promise<T>,requestKey?:string):Promise<T>{
    if(!this.restricted)return work();
    if(this.planId)throw new BusinessCliError('INVALID_REQUEST','Nested command authorization plans are not supported.',2);
    this.planId=await this.approve(requests,requestKey);
    try{return await work();}finally{this.planId=undefined;}
  }
  async logout():Promise<unknown>{if(this.restricted)throw new BusinessCliError('HOST_DENIED','Run identities cannot manage independent sessions.',3);await requestInstance(await readInstance(this.dataDir),'revoke-session',this.session.session.id);await unlink(join(this.home,'business-session.json'));return {loggedOut:true};}
  private async prune():Promise<string>{const dir=await privateDir(join(this.home,'requests'));const names=(await readdir(dir)).filter(n=>/^[a-zA-Z0-9_-]+[.]json$/.test(n));const records=await Promise.all(names.map(async name=>({name,mtime:(await stat(join(dir,name))).mtimeMs})));records.sort((a,b)=>b.mtime-a.mtime);for(let i=0;i<records.length;i++)if(i>=1000||records[i]!.mtime<Date.now()-7*86400000)await unlink(join(dir,records[i]!.name));return dir;}
  async record(id:string):Promise<RequestRecord>{if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id))throw new BusinessCliError('INVALID_REQUEST','Invalid request record ID.',2);return JSON.parse((await readSafe(join(this.home,'requests',id+'.json'),16*1024*1024)).toString());}
  async retry(id:string):Promise<unknown>{const r=await this.record(id);if(r.serviceId!==this.identity.serviceId||r.sessionId!==this.identity.sessionId)throw new BusinessCliError('SERVICE_MISMATCH','Recovery record belongs to another workspace or business session.',3);return this.request(r.path,r.method,r.body,true,r);}
  async request(path:string,method='GET',body?:Record<string,unknown>,mutation=false,recovery?:RequestRecord,binary=false):Promise<any>{
    if(!path.startsWith('/v1/')||path.startsWith('//')||path.includes('#'))throw new BusinessCliError('INVALID_REQUEST','Invalid API path.',2);
    let record=recovery;
    if(mutation&&body){body={...body,idempotencyKey:body.idempotencyKey??randomUUID()};if(!record){record={version:1,id:randomUUID(),...this.identity,method,path,body,state:'pending',createdAt:Date.now()};await atomicJson(join(await this.prune(),record.id+'.json'),record);}}
    try {
      let authorizationId:string|undefined;
      if(this.restricted&&!path.startsWith('/v1/cli/')){
        authorizationId=this.planId??await this.approve([{method:method as 'GET'|'POST',path,...(body?{body}:{})}],record?.authorizationKey??record?.id,recovery);
      }
      const response=await fetch(this.endpoint+path,{method,redirect:'error',headers:{Authorization:'Bearer '+this.session.token,'X-Workgraph-Service-Id':this.session.serviceId,'X-Workgraph-Protocol':PROTOCOL_VERSION,...(authorizationId?{'X-Workgraph-CLI-Authorization':authorizationId}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(this.timeoutMs)});
      if(!response.ok){const value=await response.json() as {error?:{code?:string;details?:unknown;retryable?:boolean}};const code=value.error?.code??'INTERNAL_ERROR';const auth=['UNAUTHENTICATED','SESSION_REVOKED','SESSION_EXPIRED','ORIGIN_DENIED','SERVICE_MISMATCH','PROTOCOL_INCOMPATIBLE'].includes(code);throw new BusinessCliError(code,englishError(code),auth?3:code==='INVALID_REQUEST'?2:4,value.error?.retryable??false,value.error?.details);}
      const result=binary?Buffer.from(await response.arrayBuffer()):await response.json();
      if(record){record.state='succeeded';record.result=result;await atomicJson(join(this.home,'requests',record.id+'.json'),record);}
      return result;
    }catch(error){
      if(record){record.state=error instanceof BusinessCliError?'failed':'unknown';await atomicJson(join(this.home,'requests',record.id+'.json'),record);}
      if(error instanceof BusinessCliError)throw error;
      throw new BusinessCliError(mutation?'RESULT_UNKNOWN':'CONNECTION_FAILED',mutation?'Request result is unknown. Retry the saved request with its original key.':'Workspace request timed out or disconnected.',mutation?8:3,true,record?{requestId:record.id}:undefined);
    }
  }
}
