import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Json, Interaction } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import type { Runs } from './runs.js';
import { Auth } from './auth.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
export interface CliRequest { method:'GET'|'POST'; path:string; body?:Record<string,unknown>; bodyHash?:string }
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value as Json)).digest('hex');
const fingerprint=(request:CliRequest)=>digest({method:request.method,path:request.path,...(request.body!==undefined||request.bodyHash?{bodyHash:request.bodyHash??digest(request.body)}:{})});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Expire the grant and release its FIFO slot in the same transaction. */
function expireCliAuthorization(runs:Runs,id:string):void{
  atomic(runs.db,()=>{
    const row=runs.db.prepare('SELECT run_id,attempt_id FROM cli_authorizations WHERE id=?').get(id);
    if(!row)return;
    runs.db.prepare("UPDATE cli_authorizations SET state='expired' WHERE id=?").run(id);
    const runId=String(row.run_id),runtime=runs.runtime(runId),run=runs.get(runId);
    if(runtime.epoch===row.attempt_id&&['running','waiting_answer','waiting_approval'].includes(run.status)&&runtime.details.cancelRequested!==true)runs.expireInteraction(runId,runtime,id);
  });
}
/** Scheduler-owned expiry does not depend on the CLI process remaining alive. */
export function expireCliAuthorizations(runs:Runs,epoch:string):void{
  const rows=runs.db.prepare("SELECT id FROM cli_authorizations WHERE attempt_id=? AND state IN ('pending','approved','consumed') AND expires_at<=?").all(epoch,runs.now());
  for(const row of rows)expireCliAuthorization(runs,String(row.id));
}
export class CliAuthorization {
  constructor(readonly auth:Auth,readonly runs:Runs){}
  private caller(sessionId:string){
    const row=this.runs.db.prepare('SELECT c.*,r.project_id,r.graph_id,r.status,t.epoch,t.details FROM cli_run_sessions c JOIN runs r ON r.id=c.run_id JOIN run_runtime t ON t.run_id=r.id WHERE c.session_id=?').get(sessionId);
    if(!row||row.attempt_id!==row.epoch||!['running','waiting_answer','waiting_approval'].includes(String(row.status))||JSON.parse(String(row.details)).cancelRequested===true)throw new ServiceError('SESSION_REVOKED','Run CLI identity expired.');
    if(row.source_type!=='execution')throw new ServiceError('HOST_DENIED','Non-execution Run instances cannot call the business CLI.');return row;
  }
  private validatePlan(sessionId:string,plan:unknown):CliRequest[]{
    const caller=this.caller(sessionId);
    if(!Array.isArray(plan)||!plan.length||plan.length>1000||Buffer.byteLength(JSON.stringify(plan))>16*1024*1024)throw new ServiceError('INVALID_REQUEST','A bounded explicit request plan is required.');
    for(const entry of plan){
      if(!object(entry)||Object.keys(entry).some(k=>!['method','path','body','bodyHash'].includes(k))||!['GET','POST'].includes(String(entry.method))||typeof entry.path!=='string'||entry.path.length>8192||!entry.path.startsWith('/v1/')||entry.path.includes('#')||entry.path.includes('%')&&!entry.path.includes('/files/')||entry.body!==undefined&&!object(entry.body)||entry.bodyHash!==undefined&&(typeof entry.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.bodyHash)||entry.body!==undefined))throw new ServiceError('INVALID_REQUEST','Invalid CLI request plan.');
      const path=entry.path.split('?')[0]!;
      // Run sessions cannot manage devices, pairing, sessions, settings, or approvals.
      const graphRoot='/v1/projects/'+caller.project_id+'/graphs';
      const safeGraph=path===graphRoot||path===graphRoot+'/query'||path.startsWith(graphRoot+'/'+caller.graph_id+'/')||entry.method==='GET'&&path===graphRoot+'/'+caller.graph_id;
      const safeUploads=path.startsWith('/v1/projects/'+caller.project_id+'/uploads');
      const safeFiles=entry.method==='GET'&&path==='/v1/projects/'+caller.project_id+'/files/content';
      const catalog=/^[/]v1(?:[/]projects[/]([a-zA-Z0-9_-]+))?[/]agents[/]configuration[/][a-z][a-z0-9._-]*[/](models|catalog)$/.exec(path);
      const safeDiscovery=entry.method==='GET'&&(['/v1/agents/configuration','/v1/agents'].includes(path)||!!catalog&&(!catalog[1]||catalog[1]===caller.project_id));
      const runMatch=/^[/]v1[/]runs[/]([a-zA-Z0-9_-]+)(?:[/](.*))?$/.exec(path);
      let safeRun=false;
      if(runMatch&&runMatch[2]!=='reply'&&runMatch[2]!=='agent-operation'){
        const target=this.runs.db.prepare('SELECT graph_id,project_id FROM runs WHERE id=?').get(runMatch[1]!);
        safeRun=!!target&&target.graph_id===caller.graph_id&&target.project_id===caller.project_id;
      }
      if(!safeGraph&&!safeUploads&&!safeFiles&&!safeDiscovery&&!safeRun)throw new ServiceError('HOST_DENIED','CLI request is outside the calling Run business scope.');
    }
    return plan as CliRequest[];
  }
  request(sessionId:string,key:string,plan:unknown,validForMs=120000):unknown{
    return atomic(this.runs.db,()=>{
      const caller=this.caller(sessionId),requests=this.validatePlan(sessionId,plan);
      if(!Number.isSafeInteger(validForMs)||validForMs<1000||validForMs>3600000)throw new ServiceError('INVALID_REQUEST','Invalid authorization lifetime.');
      if(typeof key!=='string'||!key||key.length>256)throw new ServiceError('INVALID_REQUEST','requestKey is required.');
      const hash=digest({requests,validForMs}),prior=this.runs.db.prepare('SELECT id,request_hash FROM cli_authorizations WHERE session_id=? AND request_key=?').get(sessionId,key);
      if(prior){if(prior.request_hash!==hash)throw new ServiceError('IDEMPOTENCY_CONFLICT','Authorization key identifies another plan.');return this.get(sessionId,String(prior.id));}
      const pending=Number(this.runs.db.prepare("SELECT COUNT(*) n FROM cli_authorizations WHERE session_id=? AND state='pending' AND expires_at>?").get(sessionId,this.auth.now())!.n);
      if(pending>=16)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Too many pending CLI authorizations.');
      const id=randomUUID(),now=this.auth.now(),auto=this.runs.db.prepare('SELECT 1 FROM cli_auto_grants WHERE run_id=? AND attempt_id=? AND session_id=?').get(String(caller.run_id),String(caller.attempt_id),sessionId);
      this.runs.db.prepare('INSERT INTO cli_authorizations(id,session_id,run_id,attempt_id,request_key,request_hash,plan,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,sessionId,String(caller.run_id),String(caller.attempt_id),key,hash,canonicalJson(requests as unknown as Json),now,now+validForMs,auto?'approved':'pending');
      if(!auto){
        const recent=Number(this.runs.db.prepare('SELECT COUNT(*) n FROM cli_authorizations WHERE run_id=? AND attempt_id=? AND created_at>?').get(String(caller.run_id),String(caller.attempt_id),now-300000)!.n);
        const command=requests.map(r=>r.method+' '+r.path+' '+(r.body?JSON.stringify(r.body):r.bodyHash?'body SHA-256 '+r.bodyHash:'')).join(String.fromCharCode(10));
        this.runs.openInteraction(String(caller.run_id),this.runs.runtime(String(caller.run_id)),'approval',{kind:'cli-authorization',cliAuthorization:{id,allowAuto:recent>=3},reason:'Work Graph CLI business access for this Run. Approval is separate from native sandbox permissions.',command:command.length<=12000?command:requests.map(r=>r.method+' '+r.path).join(String.fromCharCode(10))+'; full request SHA-256 '+hash,canApprove:true},id);
      }
      return this.get(sessionId,id);
    });
  }
  get(sessionId:string,id:string):unknown{
    const caller=this.caller(sessionId),row=this.runs.db.prepare('SELECT * FROM cli_authorizations WHERE id=? AND session_id=? AND attempt_id=?').get(id,sessionId,String(caller.attempt_id));
    if(!row)throw new ServiceError('NOT_FOUND','CLI authorization not found.');
    if(Number(row.expires_at)<=this.auth.now()&&['pending','approved','consumed'].includes(String(row.state))){expireCliAuthorization(this.runs,id);row.state='expired';}
    return {id:row.id,runId:row.run_id,attemptId:row.attempt_id,state:row.state,requestHash:row.request_hash,expiresAt:Number(row.expires_at),consumed:JSON.parse(String(row.consumed))};
  }
  authorize(sessionId:string,authorizationId:unknown,request:CliRequest):void{
    atomic(this.runs.db,()=>{
      this.validatePlan(sessionId,[request]);
      if(typeof authorizationId!=='string')throw new ServiceError('HOST_DENIED','An approved command authorization is required.');
      const state=this.get(sessionId,authorizationId) as {state:string};if(!['approved','consumed'].includes(state.state))throw new ServiceError('HOST_DENIED','CLI command has not been approved.');
      const row=this.runs.db.prepare('SELECT plan,consumed FROM cli_authorizations WHERE id=?').get(authorizationId)!;
      const consumed=JSON.parse(String(row.consumed)) as number[];
      const plan=JSON.parse(String(row.plan)) as CliRequest[];
      let index=plan.findIndex((r,i)=>!consumed.includes(i)&&fingerprint(r)===fingerprint(request));
      if(index<0)index=plan.findIndex(r=>fingerprint(r)===fingerprint(request));
      if(index<0)throw new ServiceError('HOST_DENIED','CLI request parameters differ from the approved plan.');
      // Replays may only repeat idempotent writes with the exact original key.
      if(consumed.includes(index)&&!(request.method==='POST'&&typeof request.body?.idempotencyKey==='string'))throw new ServiceError('HOST_DENIED','CLI read authorization was already consumed.');
      if(!consumed.includes(index))consumed.push(index);
      this.runs.db.prepare('UPDATE cli_authorizations SET consumed=?,state=? WHERE id=?').run(JSON.stringify(consumed),consumed.length===plan.length?'consumed':'approved',authorizationId);
    });
  }
  revoke(runId:string):void{
    atomic(this.runs.db,()=>{
      this.runs.db.prepare('DELETE FROM cli_auto_grants WHERE run_id=?').run(runId);
      for(const row of this.runs.db.prepare("SELECT id FROM cli_authorizations WHERE run_id=? AND state IN ('pending','approved','consumed')").all(runId)){
        this.runs.db.prepare("UPDATE cli_authorizations SET state='expired' WHERE id=?").run(String(row.id));
        if(this.runs.db.prepare('SELECT 1 FROM interactions WHERE id=?').get(String(row.id))){try{this.runs.expireInteraction(runId,this.runs.runtime(runId),String(row.id));}catch{/* Already delivered or terminal. */}}
      }
      this.runs.record(runId,'cli.authorization.revoked',{});
    });
  }
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    if(!path.startsWith('/v1/cli/'))return {handled:false};
    const session=this.auth.withSession(token,origin,s=>s);
    const status=/^[/]v1[/]cli[/]authorizations[/]status[/]([a-zA-Z0-9_-]+)$/.exec(path);
    if(status&&request.method==='GET'){
      if(origin==='native:run')throw new ServiceError('HOST_DENIED','User session required.');
      const run=this.runs.get(status[1]!),runtime=this.runs.runtime(run.id);
      const enabled=['running','waiting_answer','waiting_approval'].includes(run.status)&&!!this.runs.db.prepare('SELECT 1 FROM cli_auto_grants a JOIN sessions s ON s.id=a.session_id WHERE a.run_id=? AND a.attempt_id=? AND s.revoked_at IS NULL').get(run.id,runtime.epoch);
      return {handled:true,body:{enabled}};
    }
    const cancel=/^[/]v1[/]cli[/]authorizations[/]([a-zA-Z0-9_-]+)[/]cancel$/.exec(path);
    if(cancel&&request.method==='POST'){
      const body=await readJson(request);if(Object.keys(body).length)throw new ServiceError('INVALID_REQUEST','Cancellation accepts no fields.');
      return this.auth.withSession(token,origin,()=>{
        const caller=this.caller(session.id);this.get(session.id,cancel[1]!);
        this.runs.db.prepare("UPDATE cli_authorizations SET state='expired' WHERE id=? AND session_id=?").run(cancel[1]!,session.id);
        this.runs.expireInteraction(String(caller.run_id),this.runs.runtime(String(caller.run_id)),cancel[1]!);
        return {handled:true,body:{cancelled:true}};
      });
    }
    if(path==='/v1/cli/identity'&&request.method==='GET'){
      const caller=this.caller(session.id);return {handled:true,body:{...{serviceId:this.auth.serviceId,sessionId:session.id},runId:caller.run_id,attemptId:caller.attempt_id}};
    }
    if(path==='/v1/cli/authorizations'&&request.method==='POST'){
      const body=await readJson(request,16*1024*1024);if(Object.keys(body).some(k=>!['requestKey','requests','validForMs'].includes(k)))throw new ServiceError('INVALID_REQUEST','Unknown authorization field.');
      return this.auth.withSession(token,origin,()=>({handled:true,body:this.request(session.id,body.requestKey as string,body.requests,body.validForMs as number|undefined)}));
    }
    if(path==='/v1/cli/authorizations/revoke'&&request.method==='POST'){
      if(origin==='native:run')throw new ServiceError('HOST_DENIED','Only an independent user session may revoke grants.');
      const body=await readJson(request);if(Object.keys(body).some(k=>k!=='runId')||typeof body.runId!=='string')throw new ServiceError('INVALID_REQUEST','runId is required.');
      return this.auth.withSession(token,origin,()=>{this.runs.get(body.runId as string);this.revoke(body.runId as string);return {handled:true,body:{revoked:true}};});
    }
    const match=/^[/]v1[/]cli[/]authorizations[/]([a-zA-Z0-9_-]+)$/.exec(path);
    if(match&&request.method==='GET')return this.auth.withSession(token,origin,()=>({handled:true,body:this.get(session.id,match[1]!)}));
    throw new ServiceError('NOT_FOUND','CLI control route not found.');
  }
}
/** Called by Runs.reply inside its user/session transaction. */
export function validateCliApproval(runs:Runs,interaction:Interaction,answer:Json,sessionId:string):void{
  const payload=interaction.payload as Record<string,Json>,cli=payload.cliAuthorization as Record<string,Json>;
  const session=runs.db.prepare('SELECT origin FROM sessions WHERE id=?').get(sessionId);
  if(!session||String(session.origin).startsWith('native:'))throw new ServiceError('HOST_DENIED','CLI authorization requires a human decision through the trusted browser interaction.');
  if(!object(answer)||Object.keys(answer).some(k=>!['kind','decision','autoAuthorize'].includes(k))||answer.kind!=='approval'||!['accept','decline'].includes(String(answer.decision))||answer.autoAuthorize!==undefined&&typeof answer.autoAuthorize!=='boolean'||answer.autoAuthorize===true&&cli.allowAuto!==true)throw new ServiceError('INVALID_REQUEST','Invalid CLI authorization decision.');
  const row=runs.db.prepare('SELECT * FROM cli_authorizations WHERE id=? AND run_id=? AND attempt_id=?').get(interaction.id,interaction.runId,interaction.epoch);
  if(!row||row.state!=='pending'||Number(row.expires_at)<=runs.now())throw new ServiceError('CONFLICT','CLI authorization is no longer pending.');
  runs.db.prepare('UPDATE cli_authorizations SET state=? WHERE id=?').run(answer.decision==='accept'?'approved':'declined',interaction.id);
  if(answer.decision==='accept'&&answer.autoAuthorize===true)runs.db.prepare('INSERT OR REPLACE INTO cli_auto_grants(run_id,attempt_id,session_id,decided_by,created_at) VALUES(?,?,?,?,?)').run(interaction.runId,interaction.epoch,String(row.session_id),sessionId,runs.now());
}
