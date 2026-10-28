import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isTerminalRunStatus, BASIC_NODE_TYPES, WORKGRAPH_UPLOAD_MAX_BYTES } from '@openworkgraph/protocol';
import type { Json } from '@openworkgraph/protocol';
import type { CliRequest } from './cli-authorization.js';
import { canonicalJson } from './persistence/repositories.js';
import { readSafe, writeNew } from './operations/files.js';
import { BusinessTransport, BusinessCliError, businessError } from './business-cli-transport.js';
import { formatBusinessOutput } from './business-cli-render.js';
import { BUSINESS_COMMAND_HELP, formatHelp } from './cli-help.js';
export const BUSINESS_GROUPS=Object.keys(BUSINESS_COMMAND_HELP);
const BUSINESS_ACTIONS:Record<string,string[]>=Object.fromEntries(Object.entries(BUSINESS_COMMAND_HELP).map(([group,commands])=>[group,Object.keys(commands)]));
const fail=(message:string):never=>{throw new BusinessCliError('INVALID_REQUEST',message,2);};
export async function runBusinessCli(args:string[]):Promise<void>{
  const json=args.includes('--output-json')||args.includes('--json');
  try {
    const strings=['project','graph','file','title','text','text-file','prompt','prompt-file','type','types','query','node','region','direction','depth','edge-kinds','source','target','kind','content-version','execution-revision','layout-revision','idempotency-key','cursor','limit','edge-limit','region-limit','text-chars','bytes','timeout','output-bytes','output','path','sha256','mime','upload-id','version','output-key','run'];
    const options:Record<string,{type:'string'|'boolean'}>=Object.fromEntries(strings.map(key=>[key,{type:'string' as const}]));for(const key of ['output-json','json','stdin','help'])options[key]={type:'boolean'};
    const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options});
    if(v.help||p.length<2){console.log(formatHelp());return;}
    const [group,action,id]=p;if(p.length>3)fail('Unexpected positional arguments.');
    if(!BUSINESS_ACTIONS[group!]?.includes(action!))fail('Unknown business action. Use '+group+' --help.');
    const needsId=group==='graph'&&['summary','view','rename','commands'].includes(action!)||group==='node'&&['get','update','delete'].includes(action!)||group==='edge'&&action==='delete'||group==='agent'&&action==='models'||group==='run'&&!['preview','submit','list'].includes(action!)||group==='resource'&&action!=='upload'||group==='request'||group==='authorization'&&action==='get';
    if(needsId&&!id)fail('This command requires an entity ID.');
    const optionalId=group==='project'&&action==='resolve'||['node','edge'].includes(group!)&&action==='create';
    if(!needsId&&!optionalId&&id!==undefined&&!(group==='project'&&action==='file'&&id==='read'))fail('Unexpected entity ID.');
    const number=(key:string,fallback?:number):number=>{const value=v[key];if(value===undefined){if(fallback===undefined)fail('--'+key+' is required.');return fallback!;}if(typeof value!=='string'||!value.length||Array.from(value).some(c=>c<'0'||c>'9')||!Number.isSafeInteger(Number(value)))fail('--'+key+' must be a nonnegative integer.');return Number(value);};
    const required=(key:string):string=>{const value=v[key];if(typeof value!=='string'||!value)fail('--'+key+' is required.');return value as string;};
    const identifier=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))fail('A full valid entity ID is required.');return value as string;};
    const project=()=>identifier(required('project')),graph=()=>identifier(required('graph'));
    let body:Record<string,unknown>={};
    if(v.file&&v.stdin)fail('--file and --stdin are mutually exclusive.');
    if(v.file||v.stdin){let bytes:Buffer;if(v.file)bytes=await readSafe(String(v.file),16*1024*1024);else{const parts:Buffer[]=[];let size=0;for await(const part of process.stdin){size+=part.length;if(size>16*1024*1024)fail('stdin exceeds 16 MiB.');parts.push(part);}bytes=Buffer.concat(parts);}try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();body=value;}catch{fail('Input must be a UTF-8 JSON object.');}}
    const timeout=number('timeout',30000);if(timeout<1||timeout>3600000)fail('--timeout must be 1..3600000 milliseconds.');
    const outputBytes=number('output-bytes',1048576);if(outputBytes<4096||outputBytes>32*1024*1024)fail('--output-bytes must be 4096..33554432.');
    const transport=new BusinessTransport(timeout);await transport.connect(group==='workspace'&&action==='login');
    const get=(path:string)=>transport.request(path),post=(path:string,data:Record<string,unknown>,mutation=false)=>transport.request(path,'POST',data,mutation);
    const gp=(gid?:string)=>'/v1/projects/'+project()+'/graphs/'+identifier(gid??graph());
    const budget:Record<string,number>={};for(const [flag,key] of [['limit','nodes'],['edge-limit','edges'],['region-limit','regions'],['text-chars','textChars'],['bytes','bytes']])if(v[flag!]!==undefined)budget[key!]=number(flag!);
    const queryBody=()=>({...body,...(Object.keys(budget).length?{budget}:{}),...(v.cursor?{cursor:v.cursor}:{})});
    const revisions=()=>({expectedExecutionRevision:body.expectedExecutionRevision??number('execution-revision'),expectedLayoutRevision:body.expectedLayoutRevision??number('layout-revision')});
    const key=()=>({...(v['idempotency-key']||body.idempotencyKey?{idempotencyKey:v['idempotency-key']??body.idempotencyKey}:{})});
    const command=(operations:unknown[],gid?:string)=>post(gp(gid)+'/commands',{...revisions(),...key(),responseMode:'compact',operations},true);
    let result:any,isGraph=false;
    if(group==='workspace'){
      if(action==='info')result={...await get('/v1/info'),businessSession:transport.identity.sessionId};
      else if(action==='login')result={...transport.identity,authenticated:true};else if(action==='logout')result=await transport.logout();else fail('Unknown workspace action.');
    }else if(group==='project'){
      if(action==='list')result=await get('/v1/projects');
      else if(action==='resolve'){const path=await realpath(id??process.cwd());const projects=await get('/v1/projects') as {canonicalPath:string;projectId:string}[];const candidates=projects.filter(item=>{const child=relative(item.canonicalPath,path);return child===''||child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child);});if(candidates.length!==1)throw new BusinessCliError('CONFLICT','Directory does not uniquely resolve to a registered project.',4,false,{candidates});result=candidates[0];}
      else if(action==='file'&&id==='read'){result=await get('/v1/projects/'+project()+'/files/content?path='+encodeURIComponent(required('path')));const bytes=Buffer.from(result.base64,'base64');const hash=createHash('sha256').update(bytes).digest('hex');if(v.sha256&&v.sha256!==hash)throw new BusinessCliError('CONFLICT','Project file hash differs from the expected output.',4);if(v.output){await writeNew(String(v.output),bytes,0o600);result={output:v.output,sha256:hash,bytes:bytes.length};}else result={...result,sha256:hash};}
      else fail('Unknown project action.');
    }else if(group==='graph'){
      if(action==='list')result=await post('/v1/projects/'+project()+'/graphs/query',{...body,...(v.limit?{limit:number('limit')}:{}) ,...(v.cursor?{cursor:v.cursor}:{})});
      else if(action==='summary'||action==='view'){const data:Record<string,unknown>=queryBody();if(action==='view'){if(v.node)data.nodeId=identifier(v.node);if(v.region)data.region=v.region;if(v.direction)data.direction=v.direction;if(v.depth!==undefined)data.depth=number('depth');if(v['edge-kinds'])data.edgeKinds=String(v['edge-kinds']).split(',');}result=await post(gp(identifier(id))+'/'+(action==='view'?'subgraph':'summary'),data);isGraph=true;}
      else if(action==='commands'){if(!Array.isArray(body.operations))fail('graph commands requires operations in --file or --stdin.');result=await post(gp(identifier(id))+'/commands',{...body,...key(),responseMode:'compact'},true);}
      else if(action==='create')result=await post('/v1/projects/'+project()+'/graphs',{title:required('title'),...key()},true);
      else if(action==='rename')result=await command([{type:'graph.rename',title:required('title')}],identifier(id));else fail('Unknown graph action.');
    }else if(group==='node'){
      if(['list','search','get'].includes(action!)){const data:Record<string,unknown>=queryBody();if(action==='get')data.nodeId=identifier(id);else{if(v.query)data.query=v.query;if(v.types)data.types=String(v.types).split(',');if(action==='search'&&!data.query)fail('node search requires --query.');}result=await post(gp()+'/'+(action==='get'?'node-content':'nodes-query'),data);}
      else if(action==='create'||action==='update'){
        const allowed=['expectedExecutionRevision','expectedLayoutRevision','idempotencyKey',...(action==='create'?['nodeType','nodeId','title','text','prompt','x','y']:['expectedContentVersion','changes'])];
        if(Object.keys(body).some(k=>!allowed.includes(k)))fail('Unknown node convenience input field. Use graph commands for atomic operations.');
        const initial=action==='create'?Object.fromEntries(['title','text','prompt'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]])):body.changes??{};
        if(!initial||typeof initial!=='object'||Array.isArray(initial)||Object.entries(initial).some(([k,value])=>!['title','text','prompt'].includes(k)||typeof value!=='string'))fail('Node fields must contain title, text or prompt strings.');
        const fields:Record<string,string>={...initial as Record<string,string>};for(const field of ['title','text','prompt']){if(v[field]!==undefined&&v[field+'-file'])fail('Use only one source for '+field+'.');if(v[field]!==undefined)fields[field]=String(v[field]);else if(v[field+'-file'])fields[field]=new TextDecoder('utf-8',{fatal:true}).decode(await readSafe(String(v[field+'-file']),2*1024*1024));}
        if(action==='create'){const type=String(v.type??body.nodeType??'');if(!(BASIC_NODE_TYPES as readonly string[]).includes(type))fail('Unsupported basic node type.');result=await command([{type:'node.create-basic',nodeId:id?identifier(id):body.nodeId?identifier(body.nodeId):randomUUID(),nodeType:type,...fields,...(body.x!==undefined?{x:body.x}:{}),...(body.y!==undefined?{y:body.y}:{})}]);}
        else result=await command([{type:'node.patch',nodeId:identifier(id),expectedContentVersion:body.expectedContentVersion??number('content-version'),changes:fields}]);
      }else if(action==='delete')result=await command([{type:'node.delete',nodeId:identifier(id)}]);else fail('Unknown node action.');
    }else if(group==='edge'){
      if(action==='create'){const kind=required('kind');if(!['reference','execution'].includes(kind))fail('Only reference and execution edges can be created.');result=await command([{type:'edge.create',edge:{id:id?identifier(id):randomUUID(),sourceId:identifier(required('source')),targetId:identifier(required('target')),kind}}]);}
      else if(action==='delete')result=await command([{type:'edge.delete',edgeId:identifier(id)}]);else fail('Unknown edge action.');
    }else if(group==='agent'){
      if(action==='configuration')result=await get('/v1/agents/configuration');else if(action==='list')result=await get('/v1/agents');else if(action==='models')result=await get((v.project?'/v1/projects/'+project():'/v1')+'/agents/configuration/'+identifier(id)+'/models');else fail('Unknown agent action.');
    }else if(group==='run'){
      if(action==='preview')result=await post(gp()+'/input-preview',{...body,...(v.node?{nodeId:identifier(v.node)}:{})});
      else if(action==='submit'){
        const route=body.agent===undefined&&!('modelOverride' in body)&&body.kind!=='image_generation'?'runs-current':'runs';
        result=await post(gp()+'/'+route,{...body,...key()},true);
      }else if(action==='list')result=await get(v.project&&v.graph?gp()+'/runs':'/v1/runs');
      else if(action==='wait'){
        const path='/v1/runs/'+identifier(id),pollMs=Math.max(300,Math.ceil(timeout/998));
        await transport.withPlan(Array.from({length:Math.ceil(timeout/pollMs)+1},()=>({method:'GET' as const,path})),async()=>{
          const deadline=Date.now()+timeout;while(true){result=await get(path);if(isTerminalRunStatus(result.status)){if(result.status!=='succeeded')process.exitCode=5;break;}if(['waiting_answer','waiting_approval'].includes(result.status)){process.exitCode=6;break;}if(Date.now()>=deadline)throw new BusinessCliError('WAIT_TIMEOUT','Run wait timed out. The Run was not cancelled.',7,true,{runId:id});await delay(Math.min(pollMs,Math.max(1,deadline-Date.now())));}
        });
      }else{
        const path='/v1/runs/'+identifier(id),readActions:Record<string,string>={get:'',plan:'execution-plan',interaction:'active-interaction',interactions:'interactions',candidate:'candidate'};
        if(action! in readActions)result=await get(path+(readActions[action!]?'/'+readActions[action!] :''));
        else if(action==='outputs')result=await post(path+'/outputs',queryBody());
        else if(action==='output-file'){result=await post(path+'/output-file',{outputKey:required('output-key')});if(v.output){await writeNew(String(v.output),Buffer.from(result.base64,'base64'),0o600);result={...result,base64:undefined,output:v.output};}}
        else if(['start','reply','cancel','cancel-chain','continue','accept','discard'].includes(action!)){let data:Record<string,unknown>={...body,...key()};let route=action!;if(action==='accept'||action==='discard'){data={...data,decision:action,expectedContentVersion:number('content-version')};route='candidate';}result=await post(path+'/'+route,data,true);}else fail('Unknown run action.');
      }
    }else if(group==='resource'){
      const root='/v1/projects/'+project();
      if(action==='upload-status')result=await get(root+'/uploads/'+identifier(id));
      else if(action==='upload-cancel')result=await post(root+'/uploads/'+identifier(id)+'/cancel',key(),true);
      else if(action==='upload'){
        const bytes=await readSafe(required('path'),WORKGRAPH_UPLOAD_MAX_BYTES),sha256=createHash('sha256').update(bytes).digest('hex'),name=basename(required('path')),mime=required('mime');
        const uploadId=v['upload-id']?identifier(v['upload-id']):randomUUID(),chunk=1024*1024;
        const startBody={uploadId,name,mime,bytes:bytes.length,sha256,idempotencyKey:v['idempotency-key']??uploadId+':start:'+sha256};
        const finishBody={mode:'canvas',graphId:graph(),name,idempotencyKey:uploadId+':finish:'+sha256};
        const chunkBody=(offset:number)=>({offset,data:bytes.subarray(offset,offset+chunk).toString('base64'),idempotencyKey:uploadId+':'+offset+':'+sha256});
        const requests:CliRequest[]=[...(!v['upload-id']?[{method:'POST' as const,path:root+'/uploads',body:startBody}]:[]),{method:'GET',path:root+'/uploads/'+uploadId}];
        for(let offset=0;offset<bytes.length;offset+=chunk)requests.push({method:'POST',path:root+'/uploads/'+uploadId+'/chunks',bodyHash:createHash('sha256').update(canonicalJson(chunkBody(offset) as Json)).digest('hex')});
        requests.push({method:'POST',path:root+'/uploads/'+uploadId+'/finish',body:finishBody});
        result=await transport.withPlan(requests,async()=>{
          if(!v['upload-id'])await post(root+'/uploads',startBody,true);
          const status=await get(root+'/uploads/'+uploadId);
          if(status.sha256&&status.sha256!==sha256||status.bytes!==bytes.length||status.mime!==mime||status.name!==name)throw new BusinessCliError('CONFLICT','Resumed upload does not match this file.',4);
          if(status.received!==bytes.length&&status.received%chunk!==0)throw new BusinessCliError('CONFLICT','Resumed upload has a different chunk boundary. Use the API with an explicit matching plan.',4);
          for(let offset=Number(status.received);offset<bytes.length;offset+=chunk)await post(root+'/uploads/'+uploadId+'/chunks',chunkBody(offset),true);
          return post(root+'/uploads/'+uploadId+'/finish',finishBody,true);
        });
      }else if(action==='get'||action==='download'){
        const path=gp()+'/resources/'+identifier(id)+'/versions/'+number('version');
        await transport.withPlan([{method:'GET',path},...(action==='download'?[{method:'GET' as const,path:path+'/content'}]:[])],async()=>{
          result=await get(path);
          if(action==='download'){const bytes=await transport.request(path+'/content','GET',undefined,false,undefined,true);if(bytes.length!==result.bytes||createHash('sha256').update(bytes).digest('hex')!==result.sha256)throw new BusinessCliError('CONFLICT','Resource integrity verification failed.',4);await writeNew(required('output'),bytes,0o600);result={...result,output:v.output};}
        });
      }else fail('Unknown resource action.');
    }else if(group==='request'){
      if(action==='get'){const record=await transport.record(identifier(id));const {body:_,...metadata}=record;result=metadata;}else if(action==='retry')result=await transport.retry(identifier(id));else fail('Unknown request action.');
    }else if(group==='authorization'){
      if(action==='request')result=await post('/v1/cli/authorizations',body);
      else if(action==='get')result=await get('/v1/cli/authorizations/'+identifier(id));
      else if(action==='revoke')result=await post('/v1/cli/authorizations/revoke',{runId:identifier(required('run'))});else fail('Unknown authorization action.');
    }else fail('Unknown business command group.');
    console.log(formatBusinessOutput(result,json,isGraph,outputBytes));
  }catch(error){const value=businessError(error);console.error(json?JSON.stringify({error:{code:value.code,message:value.message,retryable:value.retryable,...(value.details?{details:value.details}:{})}}):value.message);process.exitCode=value.exitCode;}
}
