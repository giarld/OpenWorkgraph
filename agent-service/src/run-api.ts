import type { IncomingMessage } from 'node:http';
import type { ImageRoute, InteractionReply, Json, ModelSelection, SubmitRun } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { WorkflowRuntime } from './runtime.js';
import { readJson } from './http.js';
import { atomic } from './persistence/database.js';
import { ServiceError } from './errors.js';
import { Repositories, canonicalJson } from './persistence/repositories.js';
import { BackendError } from './backend/types.js';
function text(value:unknown):string{if(typeof value!=='string'||!value)throw new ServiceError('INVALID_REQUEST','需要非空字符串。');return value;}
function fields(body:Record<string,unknown>,allowed:string[]):void{if(Object.keys(body).some(key=>!allowed.includes(key)))throw new ServiceError('INVALID_REQUEST','请求包含未知字段。');}
function requireSecureCredentialConnection(request:IncomingMessage, origin:string):void {
  const web=new URL(origin), host=request.headers.host ?? '';
  const remote=request.socket.remoteAddress ?? '';
  const local=(value:string)=>['localhost','127.0.0.1','::1','::ffff:127.0.0.1','[::1]'].includes(value);
  const hostName=host.startsWith('[')?host.slice(0,host.indexOf(']')+1):host.split(':')[0]!;
  const forwarded=request.headers['x-forwarded-proto'];
  const forwardedProto=(Array.isArray(forwarded)?forwarded[0]:forwarded)?.split(',')[0]?.trim().toLowerCase();
  const secure=((request.socket as import('node:tls').TLSSocket).encrypted===true || forwardedProto==='https') && web.protocol==='https:';
  if (!secure && !(web.protocol==='http:' && local(web.hostname) && local(remote) && local(hostName))) throw new ServiceError('HOST_DENIED','密钥只能通过回环连接或 HTTPS 录入。');
}
function imageRoute(body:Record<string,unknown>):ImageRoute|undefined{
  if(body.kind!=='image_generation'){
    if('imageRoute' in body)throw new ServiceError('INVALID_REQUEST','只有图片任务可以指定生成方式。');
    return undefined;
  }
  if(body.imageRoute===undefined)return {type:'codex'}; // Old clients always mean Codex.
  const route=body.imageRoute;
  if(!route||typeof route!=='object'||Array.isArray(route))throw new ServiceError('INVALID_REQUEST','图片生成方式无效。');
  const value=route as Record<string,unknown>;
  const parseOptions=():ImageRoute['options']=>{
    if(value.options===undefined)return undefined;
    if(!value.options||typeof value.options!=='object'||Array.isArray(value.options))throw new ServiceError('INVALID_REQUEST','图片参数无效。');
    const raw=value.options as Record<string,unknown>;fields(raw,['size','quality','aspectRatio','outputFormat']);
    for(const key of ['size','aspectRatio'])if(raw[key]!==undefined&&(typeof raw[key]!=='string'||!(raw[key] as string).trim()||(raw[key] as string).length>60))throw new ServiceError('INVALID_REQUEST','图片参数无效。');
    if(raw.quality!==undefined&&!['auto','high','medium','low'].includes(String(raw.quality)))throw new ServiceError('INVALID_REQUEST','图片质量无效。');
    if(raw.outputFormat!==undefined&&!['png','jpeg','webp'].includes(String(raw.outputFormat)))throw new ServiceError('INVALID_REQUEST','图片格式无效。');
    return raw as ImageRoute['options'];
  };
  if(value.type==='codex'){
    fields(value,['type','options']);const options=parseOptions();return {type:'codex',...(options?{options}:{})};
  }
  if(value.type!=='api')throw new ServiceError('INVALID_REQUEST','图片生成方式无效。');
  fields(value,['type','providerId','modelId','options']);
  if(typeof value.providerId!=='string'||!value.providerId.trim()||typeof value.modelId!=='string'||!value.modelId.trim())throw new ServiceError('INVALID_REQUEST','需要有效的服务商和模型 ID。');
  if('modelOverride' in body||'reasoningEffort' in body)throw new ServiceError('INVALID_REQUEST','API 图片任务不能使用 Codex 模型或推理强度。');
  const options=parseOptions() as Extract<ImageRoute,{type:'api'}>['options'];
  return {type:'api',providerId:value.providerId,modelId:value.modelId,...(options?{options}:{})};
}
export class RunApi {
  constructor(readonly runtime:WorkflowRuntime,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const graph=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/](runs|input-preview)$/.exec(path);
    const run=/^[/]v1[/]runs(?:[/]([a-zA-Z0-9_-]+))?(?:[/](cancel|cancel-chain|reply|history|snapshot|public-metadata|interactions|active-interaction|candidate|continue|input-changes|execution-plan|start))?$/.exec(path);
    const notifications=path==='/v1/notifications';
    const notificationRead=/^[/]v1[/]notifications[/]([a-zA-Z0-9_-]+)[/]read$/.exec(path);
    const notificationReadAll=path==='/v1/notifications/read-all';
    const history=/^[/]v1[/]history[/](preview|clear)$/.exec(path);
    const providers=/^[/]v1[/]image-providers(?:[/]([a-zA-Z0-9_-]+)(?:[/](.+))?)?$/.exec(path);
    if(!graph&&!run&&!history&&!providers&&!notifications&&!notificationRead&&!notificationReadAll&&!['/v1/models','/v1/capacity','/v1/execution-settings'].includes(path))return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id);
    const body=request.method==='POST'?await readJson(request,2*1024*1024):{};
    const read=<T>(work:()=>T)=>this.auth.withSession(token,origin,work);
    const ok=(value:unknown):ApiResult=>({handled:true,body:value});
    const rt=this.runtime,repo=new Repositories(rt.db);
    if(notifications&&request.method==='GET')return ok(read(()=>rt.runs.notifications()));
    if(notificationRead&&request.method==='POST'){fields(body,['expectedRevision']);return ok(read(()=>rt.runs.readNotification(notificationRead[1]!,body.expectedRevision as number)));}
    if(notificationReadAll&&request.method==='POST'){fields(body,[]);return ok(read(()=>rt.runs.readAllNotifications()));}
    if(providers){
      if(request.method==='GET'&&!providers[1]){await rt.imageProviders.refreshCredentials();return ok(read(()=>rt.imageProviders.list()));}
      if(request.method==='POST'){
        if(providers[1]){
          if(providers[2]==='delete'){
            fields(body,['expectedRevision']);
            return ok(read(()=>{rt.imageProviders.deleteProvider(providers[1]!,body.expectedRevision);return {deleted:true};}));
          }
          if(providers[2]==='models/discover'){
            fields(body,['expectedRevision']);
            if(!Number.isSafeInteger(body.expectedRevision))throw new ServiceError('INVALID_REQUEST','需要有效的修订号。');
            this.auth.assertActive(token,origin);
            const result=await rt.discoverImageModels(providers[1]!,body.expectedRevision as number);
            return ok(read(()=>result));
          }
          if(providers[2]==='models/select'){
            fields(body,['models','expectedRevision']);
            if(!Array.isArray(body.models)||!Number.isSafeInteger(body.expectedRevision))throw new ServiceError('INVALID_REQUEST','模型选择无效。');
            return ok(read(()=>rt.imageProviders.syncDiscoveredModels(providers[1]!,body.models as import('./image-providers.js').DiscoveredModel[],body.expectedRevision)));
          }
          if(providers[2]==='models/delete'){
            fields(body,['modelId','expectedRevision']);
            if(typeof body.modelId!=='string')throw new ServiceError('INVALID_REQUEST','图片模型 ID 无效。');
            return ok(read(()=>rt.imageProviders.deleteModel(providers[1]!,body.modelId as string,body.expectedRevision)));
          }
          const modelAction=/^models[/]([^/]+)[/]delete$/.exec(providers[2]??'');
          let actionModel:string|undefined;
          if(modelAction){try{actionModel=decodeURIComponent(modelAction[1]!);}catch{throw new ServiceError('INVALID_REQUEST','图片模型 ID 无效。');}}
          if(modelAction){fields(body,['expectedRevision']);return ok(read(()=>rt.imageProviders.deleteModel(providers[1]!,actionModel!,body.expectedRevision)));}
          if(providers[2]==='credential' || providers[2]==='credential-revoke'){
            fields(body,providers[2]==='credential'?['secret','expectedRevision']:['expectedRevision']);
            requireSecureCredentialConnection(request,origin);
            if(!Number.isSafeInteger(body.expectedRevision))throw new ServiceError('INVALID_REQUEST','需要有效的修订号。');
            this.auth.assertActive(token,origin);
            const result=providers[2]==='credential'
              ?await rt.imageProviders.setCredential(providers[1]!,body.secret as string,body.expectedRevision)
              :await rt.imageProviders.revokeCredential(providers[1]!,body.expectedRevision);
            return ok(read(()=>result));
          }
          fields(body,['id','name','modes','formats','sizes','qualities','isDefault','expectedRevision']);
          return ok(read(()=>rt.imageProviders.setModel(providers[1]!,body as unknown as import('./image-providers.js').ModelConfig,body.expectedRevision)));
        }
        fields(body,['id','name','driver','endpoint','enabled','expectedRevision']);
        return ok(read(()=>rt.imageProviders.setProvider(body as unknown as import('./image-providers.js').ProviderConfig,body.expectedRevision)));
      }
    }
    if(path==='/v1/execution-settings'){
      if(request.method==='GET')return ok(read(()=>rt.executionSettings.get()));
      if(request.method==='POST'){
        fields(body,['sandboxMode','expectedRevision']);
        return ok(read(()=>rt.executionSettings.set(body.sandboxMode,body.expectedRevision)));
      }
    }
    if(path==='/v1/models'){
      if(request.method==='GET'){await rt.refreshModels();return ok(read(()=>rt.models.get(rt.catalog)));}
      if(request.method==='POST'){
        fields(body,['selection','expectedRevision']);
        const selection=body.selection as ModelSelection|undefined;
        if(!selection||typeof selection!=='object'||Array.isArray(selection)||typeof selection.model!=='string'||!selection.model||!(selection.reasoningEffort===null||typeof selection.reasoningEffort==='string')||Object.keys(selection).some(k=>!['model','reasoningEffort'].includes(k))||!Number.isSafeInteger(body.expectedRevision))throw new ServiceError('INVALID_REQUEST','模型配置无效。');
        try{return ok(read(()=>rt.models.set(selection,body.expectedRevision as number,rt.catalog)));}
        catch(error){if(error instanceof BackendError)throw new ServiceError(error.code==='CONFLICT'?'REVISION_CONFLICT':'MODEL_UNAVAILABLE',error.message);throw error;}
      }
    }
    if(path==='/v1/capacity'&&request.method==='GET')return ok(read(()=>rt.runs.capacity()));
    if(graph){
      const scope={serviceId:rt.serviceId,projectId:graph[1]!,graphId:graph[2]!};read(()=>rt.graphs.scope(scope));
      if(graph[3]==='input-preview'&&request.method==='POST'){fields(body,['nodeId','excludeFiles']);if(body.excludeFiles!==undefined&&typeof body.excludeFiles!=='boolean')throw new ServiceError('INVALID_REQUEST','无效输入预检选项');return ok(read(()=>rt.inputs.inputPreview(scope.graphId,text(body.nodeId),body.excludeFiles===true)));}
      if(graph[3]==='runs'&&request.method==='GET')return ok(read(()=>rt.runs.list(scope.projectId).filter(value=>value.graphId===scope.graphId)));
      if(graph[3]==='runs'&&request.method==='POST'){
        fields(body,['nodeId','kind','idempotencyKey','expectedExecutionRevision','modelOverride','imageRoute','preserveHistoricalOutputs']);
        const route=imageRoute(body);
        const input={...body,...scope,...(route?{imageRoute:route}:{})} as unknown as SubmitRun;text(input.nodeId);text(input.idempotencyKey);
        let prior: Json | undefined;
        try {prior=read(()=>repo.replay(principal+':run.submit',input.idempotencyKey,input as unknown as Json));}
        catch(error){
          // Old persisted request hashes predate imageRoute. Only retry the exact old
          // body for a legacy image request; all other key collisions still fail.
          if(!(error instanceof ServiceError && error.code==='IDEMPOTENCY_CONFLICT' && body.kind==='image_generation' && !('imageRoute' in body)))throw error;
          prior=read(()=>repo.replay(principal+':run.submit',input.idempotencyKey,{...body,...scope} as Json));
        }
        if(prior!==undefined)return ok(prior && typeof prior==='object' && !Array.isArray(prior) && 'executionStart' in prior ? read(()=>rt.runs.get(String(prior.id))) : prior);
        const cleanups: (() => unknown)[] = [];
        try { const commit=await rt.prepareSubmission(input, cleanups);return ok(read(()=>commit(principal))); }
        finally { if (cleanups.length) atomic(rt.db, () => { for (const cleanup of cleanups) cleanup(); }); }
      }
    }
    if(history&&request.method==='POST'){
      fields(body,history[1]==='clear'?['runIds','idempotencyKey']:['runIds']);
      return ok(read(()=>history[1]==='preview'?rt.history.preview(body.runIds as string[]):rt.history.clear(body.runIds as string[],principal+':'+text(body.idempotencyKey))));
    }
    if(run){
      const id=run[1],action=run[2];
      if(request.method==='GET'&&!id)return ok(read(()=>rt.runs.list()));
      if(id){
        const current=read(()=>rt.runs.get(id));
        if(request.method==='GET'&&action==='execution-plan')return ok(read(()=>rt.executionChains.forRun(id)));
        if(request.method==='POST'&&action==='start'){
          fields(body,['nodeIds','expectedExecutionRevision','idempotencyKey','preserveHistoricalOutputs']);
          if(body.preserveHistoricalOutputs!==undefined&&typeof body.preserveHistoricalOutputs!=='boolean')throw new ServiceError('INVALID_REQUEST','无效历史输出选项。');
          const key=text(body.idempotencyKey);
          if(!Array.isArray(body.nodeIds)||body.nodeIds.some(v=>typeof v!=='string')||!Number.isSafeInteger(body.expectedExecutionRevision))throw new ServiceError('INVALID_REQUEST','无效执行范围。');
          const data={nodeIds:body.nodeIds,expectedExecutionRevision:body.expectedExecutionRevision,...(body.preserveHistoricalOutputs===undefined?{}:{preserveHistoricalOutputs:body.preserveHistoricalOutputs})};
          const prior=read(()=>repo.replay(principal+':run.start:'+id,key,data as Json));
          if(prior!==undefined)return ok(read(()=>rt.runs.get(id)));
          const cleanups: (() => unknown)[] = [];
          try { const commit=await rt.prepareExecutionStart(id,body.nodeIds as string[],body.expectedExecutionRevision as number,body.preserveHistoricalOutputs as boolean|undefined,cleanups);
            return ok(read(()=>commit(principal,key))); }
          finally { if(cleanups.length)atomic(rt.db,()=>{for(const cleanup of cleanups)cleanup();}); }
        }
        if(request.method==='GET'&&!action)return ok(current);
        if(request.method==='GET'&&action==='history')return ok(read(()=>rt.history.records(id)));
        if(request.method==='GET'&&action==='active-interaction')return ok(read(()=>rt.runs.activeInteraction(id)));
        if(request.method==='GET'&&action==='snapshot')return ok(read(()=>rt.runs.snapshot(id)));
        if(request.method==='GET'&&action==='public-metadata')return ok(read(()=>{
          const snapshot=rt.runs.snapshot(id),details=rt.runs.runtime(id).details;
          const result=details.result;
          const publicId=result && typeof result==='object' && !Array.isArray(result) ? result.requestId : null;
          return {imageRoute:snapshot.imageRoute??{type:'codex'},inputMode:snapshot.inputMode??null,requestId:typeof publicId==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(publicId)?publicId:null};
        }));
        if(request.method==='GET'&&action==='input-changes')return ok(read(()=>{
          // Compare editable reference inputs with the submission snapshot; execution
          // outputs are bound later and must not look like user edits on every poll.
          const snapshot=JSON.parse(String(rt.db.prepare('SELECT payload FROM snapshots WHERE run_id=?').get(id)!.payload)) as import('@openworkgraph/protocol').InputSnapshot,preview=rt.inputs.inputPreview(current.graphId,current.nodeId);
          if(preview.issues.length)return {state:'unknown',issues:preview.issues};
          const before=canonicalJson({prompt:snapshot.prompt,resources:snapshot.resources,projectFiles:snapshot.projectFiles??[]} as unknown as Json);
          const after=canonicalJson({prompt:preview.prompt,resources:preview.resources,projectFiles:preview.projectFiles} as unknown as Json);
          const dependencies=rt.runs.runtime(id).details.chainDependencies;
          const bound=Array.isArray(dependencies)?dependencies.map(runId=>rt.runs.get(String(runId)).nodeId).sort():null;
          const live=bound?rt.graphs.snapshot(current).edges.filter(e=>e.kind==='execution'&&e.targetId===current.nodeId).map(e=>e.sourceId).sort():null;
          return {state:before===after&&JSON.stringify(bound)===JSON.stringify(live)?'unchanged':'changed',issues:[]};
        }));
        if(request.method==='GET'&&action==='interactions')return ok(read(()=>rt.db.prepare('SELECT id FROM interactions WHERE run_id=? ORDER BY rowid').all(id).map(row=>rt.runs.interaction(String(row.id)))));
        if(request.method==='GET'&&action==='candidate')return ok(read(()=>{const row=rt.db.prepare('SELECT base_version,content,state FROM generation_candidates WHERE run_id=?').get(id);return row?{baseVersion:row.base_version,content:JSON.parse(String(row.content)),state:row.state}:null;}));
        if(request.method==='POST'&&action==='cancel'){fields(body,['idempotencyKey']);return ok(read(()=>rt.runs.cancel(id,text(body.idempotencyKey),principal)));}
        if(request.method==='POST'&&action==='cancel-chain'){fields(body,['idempotencyKey']);return ok(read(()=>rt.executionChains.cancel(id,text(body.idempotencyKey),principal)));}
        if(request.method==='POST'&&action==='continue'){fields(body,['idempotencyKey']);const key=text(body.idempotencyKey);const commit=await rt.prepareContinuation(id);return ok(read(()=>commit(principal,key)));}
        if(request.method==='POST'&&action==='reply'){fields(body,['interactionId','epoch','expectedVersion','idempotencyKey','answer']);return ok(read(()=>rt.runs.reply({...body,runId:id} as unknown as InteractionReply,principal)));}
        if(request.method==='POST'&&action==='candidate'){
          fields(body,['idempotencyKey','decision','expectedContentVersion']);
          return ok(read(()=>repo.idempotent(principal+':candidate:'+id,text(body.idempotencyKey),body as Json,()=>rt.publication.decide({...current,runId:id,decision:body.decision as 'accept'|'discard',expectedContentVersion:body.expectedContentVersion as number}))));
        }
      }
    }
    throw new ServiceError('NOT_FOUND','运行接口不存在。');
  }
}
