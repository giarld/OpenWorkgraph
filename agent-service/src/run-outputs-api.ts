import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Auth } from './auth.js';
import { WorkflowRuntime } from './runtime.js';
import { RunContexts } from './run-context.js';
import { ProjectFiles } from './project-files.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import type { ApiResult } from './api.js';
export class RunOutputsApi {
  private key=randomBytes(32);
  private contexts:RunContexts;
  constructor(readonly runtime:WorkflowRuntime,readonly auth:Auth){this.contexts=new RunContexts(runtime.runs,runtime.directories);}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const match=/^[/]v1[/]runs[/]([a-zA-Z0-9_-]+)[/](outputs|output-file)$/.exec(path);if(!match||!['GET','POST'].includes(request.method??''))return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id);
    const body=request.method==='POST'?await readJson(request,16384):{};
    const read=<T>(work:()=>T)=>this.auth.withSession(token,origin,work);
    const run=read(()=>{const run=this.runtime.runs.get(match[1]!);this.runtime.graphs.scope(run);if(run.historyState==='cleared')throw new ServiceError('NOT_FOUND','Run output history was cleared.');return run;});
    if(match[2]==='output-file'){
      if(Object.keys(body).some(k=>k!=='outputKey')||typeof body.outputKey!=='string')throw new ServiceError('INVALID_REQUEST','outputKey is required.');
      const output=read(()=>this.contexts.outputs(run).projectFiles.find(f=>f.outputKey===body.outputKey));if(!output)throw new ServiceError('NOT_FOUND','Published project output not found.');
      if(Number(output.bytes)>16*1024*1024)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Project output exceeds the 16 MiB verified download budget.');
      const bytes=await new ProjectFiles(this.runtime.db).read(run.projectId,String(output.relativePath),16*1024*1024);
      if(bytes.length!==Number(output.bytes)||createHash('sha256').update(bytes).digest('hex')!==output.sha256)throw new ServiceError('CONFLICT','Live project file differs from this Run output.');
      return read(()=>({handled:true,body:{...output,runId:run.id,semantics:'verified-live-working-tree',base64:bytes.toString('base64')}}));
    }
    if(Object.keys(body).some(k=>!['budget','cursor'].includes(k)))throw new ServiceError('INVALID_REQUEST','Unknown output query field.');
    const budget=body.budget as Record<string,unknown>|undefined;
    if(budget!==undefined&&(!budget||typeof budget!=='object'||Array.isArray(budget)||Object.keys(budget).some(k=>!['nodes','bytes'].includes(k))))throw new ServiceError('INVALID_REQUEST','Invalid output budget.');
    const limit=Number(budget?.nodes??50),maxBytes=Number(budget?.bytes??65536);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>524288)throw new ServiceError('INVALID_REQUEST','Invalid output budget.');
    return read(()=>{
      const outputs=this.contexts.outputs(run),items=[...outputs.canvas.map(o=>({...o,kind:'canvas'})),...outputs.projectFiles.map(o=>({...o,kind:'project-file'}))];
      const version=createHash('sha256').update(JSON.stringify(items)).digest('hex'),identity=JSON.stringify([principal,run.id,version,limit,maxBytes]);
      let offset=0;
      if(body.cursor!==undefined){try{if(typeof body.cursor!=='string'||body.cursor.length>8192)throw Error();const [data,signature]=body.cursor.split('.');const mac=createHmac('sha256',this.key).update(data!).digest(),actual=Buffer.from(signature!,'base64url');if(mac.length!==actual.length||!timingSafeEqual(mac,actual))throw Error();const c=JSON.parse(Buffer.from(data!,'base64url').toString());if(c.identity!==identity||!Number.isSafeInteger(c.offset)||c.offset<0)throw Error();offset=c.offset;}catch{throw new ServiceError('CURSOR_EXPIRED','Output cursor expired.');}}
      const slice=items.slice(offset,offset+limit);
      const build=()=>{const end=offset+slice.length,data=Buffer.from(JSON.stringify({identity,offset:end})).toString('base64url');return {serviceId:run.serviceId,projectId:run.projectId,graphId:run.graphId,runId:run.id,items:slice,total:items.length,readVersion:version,projectFileNotice:outputs.projectFileNotice,nextCursor:end<items.length?data+'.'+createHmac('sha256',this.key).update(data).digest('base64url'):null};};
      while(Buffer.byteLength(JSON.stringify(build()))>maxBytes&&slice.length>1)slice.pop();if(Buffer.byteLength(JSON.stringify(build()))>maxBytes)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Output metadata exceeds budget.');
      return {handled:true,body:build()};
    });
  }
}
