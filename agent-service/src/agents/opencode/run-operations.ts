import {createHash} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Json} from '@openworkgraph/protocol';
import {canonicalJson} from '../../persistence/repositories.js';
import {AgentError} from '../errors.js';
import {exactKeys,isPlainRecord} from '../configuration.js';
import type {OpenCodeTransport} from './transport.js';
import type {OpenCodeActionJournal} from './journal.js';
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value as Json)).digest('hex');
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid=():never=>{throw new AgentError('invalid_configuration');};
/** This finite API cannot forward native URLs, methods, filesystem paths,
 * credentials or arbitrary device commands. Unowned destructive operations
 * stay in native OpenCode, outside the frozen Workgraph Run. */
export class OpenCodeRunOperations{
 private readonly db:DatabaseSync;
 private queue:Promise<void>=Promise.resolve();
 constructor(private readonly transport:OpenCodeTransport,directory:string,private readonly sessionId:string,private readonly cwd:string,private readonly journal:OpenCodeActionJournal,private readonly active:()=>boolean,private readonly redact:(text:string)=>string){
  const path=join(directory,'run-operations.sqlite');this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operation(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT);');
 }
 async execute(value:Json):Promise<Json>{
  const work=this.queue.then(()=>this.perform(value));this.queue=work.then(()=>{},()=>{});return work;
 }
 private async perform(value:Json):Promise<Json>{
  if(!isPlainRecord(value)||!exactKeys(value,['type','callId','text','delivery','limit','cursor','order','messageId','from','to','context','mode','base','before','command','args','ptyId','expectedSnapshot','branch','worktreeId'])||typeof value.type!=='string')invalid();
  const input=value as Record<string,any>,s='/api/session/'+this.sessionId;
  if (input.type.startsWith('pty.') || input.type.startsWith('persistentPty.')) return this.pty(input);
  if (['session.hold','session.release'].includes(input.type)) {
    if(!this.active()||!exactKeys(input,['type','callId'])||!id(input.callId))invalid();
    return await this.transport.request('/api/workgraph/hold',{method:'POST',body:input}) as Json;
  }
  if (['session.pause','session.resume'].includes(input.type)) return this.sessionControl(input);
  if (input.type.startsWith('snapshot.')||input.type.startsWith('revert.')||input.type.startsWith('worktree.')) return this.project(input);
  const keys=(allowed:string[])=>{if(!exactKeys(input,['type',...allowed]))invalid();};
  const query=new URLSearchParams();let path:string;
  if(input.type==='history.list'){
   keys(['limit','cursor','order']);if(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>200)||input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>8192)||input.order!==undefined&&!['asc','desc'].includes(input.order)||input.cursor&&input.order)invalid();
   query.set('limit',String(input.limit??50));if(input.cursor)query.set('cursor',input.cursor);if(input.order)query.set('order',input.order);path=s+'/message?'+query;
  }else if(input.type==='history.get'){keys(['messageId']);if(!id(input.messageId))invalid();path=s+'/message/'+input.messageId;
  }else if(input.type==='context.read'){keys([]);path=s+'/context';
  }else if(input.type==='inbox.list'){keys([]);path=s+'/inbox';
  }else if(input.type==='diff.read'){
   keys(['from','to','context']);for(const key of ['from','to'])if(input[key]!==undefined){if(!id(input[key]))invalid();query.set(key,input[key]);}if(input.context!==undefined){if(!Number.isSafeInteger(input.context)||input.context<0||input.context>100)invalid();query.set('context',String(input.context));}path=s+'/diff?'+query;
  }else if(['vcs.status','vcs.diff','vcs.branches'].includes(input.type)){
   keys(input.type==='vcs.diff'?['mode','base','context']:[]);query.set('location[directory]',this.cwd);
   if(input.type==='vcs.diff'){if(!['working','branch','committed'].includes(input.mode)||input.base!==undefined&&(typeof input.base!=='string'||input.base.length>256||input.base.startsWith('-')||/[\x00-\x1f]/.test(input.base)))invalid();query.set('mode',input.mode);if(input.base)query.set('base',input.base);if(input.context!==undefined){if(!Number.isSafeInteger(input.context)||input.context<0||input.context>100)invalid();query.set('context',String(input.context));}}
   path='/api/vcs/'+(input.type==='vcs.branches'?'branch':input.type.split('.')[1])+'?'+query;
  }else if(input.type==='fork')return this.fork(input);
  else if(input.type==='input.submit'||input.type==='compact')return this.mutate(input);
  else throw new AgentError('capability_unsupported');
  const response=await this.transport.request(path) as any;
  if(input.type.startsWith('history.')||input.type==='context.read'){
   const project=(message:any)=>({id:message.id,type:message.type,time:message.time,...(message.type==='assistant'&&message.time?.completed?{text:(message.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join(String.fromCharCode(10))}:{})});
   if(Array.isArray(response.data))response.data=response.data.map(project);else if(response.data)response.data=project(response.data);
  }
  const encoded=this.redact(JSON.stringify(response));if(Buffer.byteLength(encoded)>65536)throw new AgentError('protocol_error');return JSON.parse(encoded);
 }
 private async sessionControl(input:Record<string,any>):Promise<Json>{
  if(!this.active()||!exactKeys(input,['type','callId'])||!id(input.callId))invalid();
  const fingerprint=digest(input),prior=this.db.prepare('SELECT fingerprint,result FROM operation WHERE id=?').get(input.callId);
  if(prior&&prior.fingerprint!==fingerprint)throw new AgentError('outcome_unknown');if(prior?.result)return JSON.parse(String(prior.result));
  if(!prior)this.db.prepare('INSERT INTO operation VALUES(?,?,NULL)').run(input.callId,fingerprint);
  const response=await this.transport.request(prior?'/api/workgraph/command/'+encodeURIComponent('session-control:'+input.callId):'/api/workgraph/session-control',prior?{}:{method:'POST',body:{...input,sessionId:this.sessionId}}) as any;
  if(response.status!=='completed')throw new AgentError('outcome_unknown');
  this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(response.result),input.callId);return response.result;
 }
 private async project(input:Record<string,any>):Promise<Json>{
  if (!this.active()) throw new AgentError('outcome_unknown');
  const fields:Record<string,string[]>={'snapshot.capture':[],'revert.apply':['expectedSnapshot','messageId'],'revert.undo':['expectedSnapshot'],'revert.commit':['expectedSnapshot'],'worktree.list':[],'worktree.create':['branch'],'worktree.remove':['worktreeId']};
  const keys=fields[input.type];if(!keys)throw new AgentError('capability_unsupported');
  if(!exactKeys(input,['type','callId',...keys])||!id(input.callId))invalid();
  for(const key of keys)if(key!=='branch'&&!id(input[key]))invalid();
  if(input.branch!==undefined&&(typeof input.branch!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,127}$/.test(input.branch)||input.branch.includes('..')||input.branch.endsWith('/')))invalid();
  const fingerprint=digest(input),prior=this.db.prepare('SELECT fingerprint,result FROM operation WHERE id=?').get(input.callId);
  if(prior&&prior.fingerprint!==fingerprint)throw new AgentError('outcome_unknown');if(prior?.result)return JSON.parse(String(prior.result));
  if(!prior)this.db.prepare('INSERT INTO operation VALUES(?,?,NULL)').run(input.callId,fingerprint);
  const response=await this.transport.request(prior?'/api/workgraph/command/'+encodeURIComponent('project-operation:'+input.callId):'/api/workgraph/project-operation',prior?{}:{method:'POST',body:{...input,sessionId:this.sessionId}}) as any;
  if(response.status!=='completed')throw new AgentError('outcome_unknown');
  const result=JSON.parse(this.redact(JSON.stringify(response.result)));this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(result),input.callId);return result;
 }
 private async pty(input:Record<string,any>):Promise<Json>{
  if (!this.active()) throw new AgentError('outcome_unknown');
  const type=input.type.replace('persistentPty.','pty.');
  if (!['pty.create','pty.read','pty.write','pty.stop'].includes(type)) throw new AgentError('capability_unsupported');
  if(!exactKeys(input,type==='pty.create'?['type','callId','command','args']:type==='pty.write'?['type','callId','ptyId','text']:type==='pty.read'?['type','ptyId']:['type','callId','ptyId']))invalid();
  if(type==='pty.create'){if(typeof input.command!=='string'||!input.command||input.command.length>4096||input.command.includes(String.fromCharCode(0))||!Array.isArray(input.args)||input.args.length>128||input.args.some((arg:unknown)=>typeof arg!=='string'||arg.length>16000||arg.includes(String.fromCharCode(0))))invalid();}
  else if(!id(input.ptyId))invalid();
  if(type==='pty.write'&&(typeof input.text!=='string'||Buffer.byteLength(input.text)>16384))invalid();
  if(type==='pty.read')return JSON.parse(this.redact(JSON.stringify(await this.transport.request('/api/workgraph/pty',{method:'POST',body:input}))));
  if(!id(input.callId))invalid();const fingerprint=digest(input),prior=this.db.prepare('SELECT fingerprint,result FROM operation WHERE id=?').get(input.callId);
  if(prior&&prior.fingerprint!==fingerprint)throw new AgentError('outcome_unknown');if(prior?.result)return JSON.parse(String(prior.result));
  if(!prior)this.db.prepare('INSERT INTO operation VALUES(?,?,NULL)').run(input.callId,fingerprint);
  const response=await this.transport.request(prior?'/api/workgraph/command/'+encodeURIComponent('pty-operation:'+input.callId):'/api/workgraph/pty',prior?{}:{method:'POST',body:{...input,sessionId:this.sessionId}}) as any;
  if(response.status!=='completed')throw new AgentError('outcome_unknown');
  const result=JSON.parse(this.redact(JSON.stringify(response.result)));this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(result),input.callId);return result;
 }
 private async fork(input:Record<string,any>):Promise<Json>{
  if(!exactKeys(input,['type','callId','text','before'])||!id(input.callId)||typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>65536||input.before!==undefined&&!id(input.before))invalid();
  if(!this.active())throw new AgentError('outcome_unknown');
  const fingerprint=digest(input),prior=this.db.prepare('SELECT fingerprint,result FROM operation WHERE id=?').get(input.callId);
  if(prior&&prior.fingerprint!==fingerprint)throw new AgentError('outcome_unknown');
  if(prior?.result)return JSON.parse(String(prior.result));
  if(!prior)this.db.prepare('INSERT INTO operation VALUES(?,?,NULL)').run(input.callId,fingerprint);
  const result=await this.transport.request(prior?'/api/workgraph/command/'+encodeURIComponent('fork:'+input.callId):'/api/workgraph/fork',prior?{}:{method:'POST',body:{callId:input.callId,sessionId:this.sessionId,text:input.text,...(input.before?{before:input.before}:{})}}) as any;
  if(result.status!=='completed'||!id(result.sessionId))throw new AgentError('outcome_unknown');
  const value={accepted:true,sessionId:result.sessionId,inputId:result.inputId};
  this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(value),input.callId);return value;
 }
 private async mutate(input:Record<string,any>):Promise<Json>{
  if(!this.active()||!id(input.callId))throw new AgentError('outcome_unknown');
  const isInput=input.type==='input.submit';if(!exactKeys(input,isInput?['type','callId','text','delivery']:['type','callId']))invalid();
  if(isInput&&(typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>65536||!['steer','queue'].includes(input.delivery)))invalid();
  const fingerprint=digest(input),nativeId='msg_'+digest([this.sessionId,input.callId]).slice(0,40),prior=this.db.prepare('SELECT fingerprint,result FROM operation WHERE id=?').get(input.callId);
  if(prior&&prior.fingerprint!==fingerprint)throw new AgentError('outcome_unknown');
  if(prior?.result)return JSON.parse(String(prior.result));
  const action='operation:'+input.callId;
  if(!prior){
   this.db.prepare('INSERT INTO operation VALUES(?,?,NULL)').run(input.callId,fingerprint);this.journal.register({kind:'plugin',id:action,sessionId:this.sessionId});this.journal.observe(this.journal.identity.instanceId,'plugin',action,'running');
   try{
    const response=await this.transport.request('/api/session/'+this.sessionId+(isInput?'/prompt':'/compact'),{method:'POST',body:isInput?{id:nativeId,text:input.text,delivery:input.delivery}:{id:nativeId}}) as any;
    const result={accepted:true,inputId:response?.data?.id??nativeId};this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(result),input.callId);this.journal.observe(this.journal.identity.instanceId,'plugin',action,'completed');return result;
   }catch{this.journal.observe(this.journal.identity.instanceId,'plugin',action,'unknown');}
  }
  const inbox=await this.transport.request('/api/session/'+this.sessionId+'/inbox') as any;
  const message=await this.transport.request('/api/session/'+this.sessionId+'/message/'+nativeId).catch(()=>null) as any;
  if(message?.data?.id===nativeId||inbox.data?.some((item:any)=>item.id===nativeId)){
   const result={accepted:true,inputId:nativeId};this.db.prepare('UPDATE operation SET result=? WHERE id=?').run(JSON.stringify(result),input.callId);this.journal.observe(this.journal.identity.instanceId,'plugin',action,'completed');return result;
  }
  throw new AgentError('outcome_unknown');
 }
 close(){this.db.close();}
}
