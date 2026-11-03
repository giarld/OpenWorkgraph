import { parseRunInput, parseNodeInputDrafts } from '@openworkgraph/protocol';
import type { IncomingMessage } from 'node:http';
import type { InteractionReply, Json, ModelSelection, SubmitRun } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { WorkflowRuntime } from './runtime.js';
import { readJson } from './http.js';
import { atomic } from './persistence/database.js';
import { ServiceError } from './errors.js';
import { Repositories, canonicalJson } from './persistence/repositories.js';
import { BackendError } from './backend/types.js';
import { AgentControl } from './agents/control.js';
import type { AgentSettingsPatch } from './agents/settings.js';
function text(value:unknown):string{if(typeof value!=='string'||!value)throw new ServiceError('INVALID_REQUEST','需要非空字符串。');return value;}
function fields(body:Record<string,unknown>,allowed:string[]):void{if(Object.keys(body).some(key=>!allowed.includes(key)))throw new ServiceError('INVALID_REQUEST','请求包含未知字段。');}
function executionInputs(value:unknown){try{return parseNodeInputDrafts(value);}catch{throw new ServiceError('INVALID_REQUEST','无效串联输入草稿。');}}
export class RunApi {
  constructor(readonly runtime:WorkflowRuntime,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const graph=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/](runs|runs-current|input-preview)$/.exec(path);
    const run=/^[/]v1[/]runs(?:[/]([a-zA-Z0-9_-]+))?(?:[/](cancel|cancel-chain|reply|history|snapshot|public-metadata|interactions|active-interaction|candidate|continue|input-changes|execution-plan|start|agent-operation))?$/.exec(path);
    const notifications=path==='/v1/notifications';
    const notificationRead=/^[/]v1[/]notifications[/]([a-zA-Z0-9_-]+)[/]read$/.exec(path);
    const notificationReadAll=path==='/v1/notifications/read-all';
    const history=/^[/]v1[/]history[/](preview|clear)$/.exec(path);
    const agent=/^[/]v1[/]agents(?:[/]([a-z][a-z0-9._-]*)(?:[/](settings|models|diagnose))?)?$/.exec(path);
    if(!graph&&!run&&!history&&!agent&&!notifications&&!notificationRead&&!notificationReadAll&&!['/v1/models','/v1/capacity','/v1/execution-settings'].includes(path))return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id);
    const body=request.method==='POST'?await readJson(request,2*1024*1024):{};
    if(request.method==='POST')this.auth.withSession(token,origin,()=>undefined);
    const read=<T>(work:()=>T)=>this.auth.withSession(token,origin,work);
    const ok=(value:unknown):ApiResult=>({handled:true,body:value});
    const rt=this.runtime,repo=new Repositories(rt.db);
    const control=new AgentControl(rt);
    const query=async<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
      const controller=new AbortController(),abort=()=>controller.abort();
      request.once?.('aborted',abort);request.socket?.once?.('close',abort);
      try {return await work(controller.signal);}
      finally {request.off?.('aborted',abort);request.socket?.off?.('close',abort);}
    };
    if(agent){
      const backendId=agent[1],action=agent[2];
      if(request.method==='GET'&&!backendId)return ok(read(()=>({items:control.descriptors(),default:control.getDefault()})));
      if(backendId==='default'&&!action){
        if(request.method==='GET')return ok(read(()=>control.getDefault()));
        if(request.method==='POST'){fields(body,['backendId','expectedRevision']);return ok(read(()=>control.setDefault(body.backendId as string,body.expectedRevision as number)));}
      }
      if(backendId&&action==='settings'){
        if(request.method==='GET')return ok(read(()=>control.getSettings(backendId)));
        if(request.method==='POST'){
          fields(body,['expectedRevision','enabled','schemaVersion','options','model']);
          const {expectedRevision,...patch}=body;
          const commit=await query(signal=>control.prepareSettings(backendId,patch as AgentSettingsPatch,expectedRevision as number,signal));
          return ok(read(commit));
        }
      }
      if(backendId&&(action==='models'&&request.method==='GET'||action==='diagnose'&&request.method==='POST')){
        fields(body,[]);
        const result=action==='models'?await query(signal=>control.listModels(backendId,signal)):await query(signal=>control.diagnose(backendId,signal));return ok(read(()=>result));
      }
      throw new ServiceError('NOT_FOUND','执行器接口不存在。');
    }
    if(notifications&&request.method==='GET')return ok(read(()=>rt.runs.notifications()));
    if(notificationRead&&request.method==='POST'){fields(body,['expectedRevision']);return ok(read(()=>rt.runs.readNotification(notificationRead[1]!,body.expectedRevision as number)));}
    if(notificationReadAll&&request.method==='POST'){fields(body,[]);return ok(read(()=>rt.runs.readAllNotifications()));}
    if(path==='/v1/execution-settings'){
      if(request.method==='GET')return ok(read(()=>rt.executionSettings.get()));
      if(request.method==='POST'){
        fields(body,['sandboxMode','expectedRevision']);
        return ok(read(()=>rt.executionSettings.set(body.sandboxMode,body.expectedRevision)));
      }
    }
    if(path==='/v1/models'){
      const pluginCatalog=rt.options.agentRegistry?.list().some(descriptor=>descriptor.id==='codex');
      const catalog=async()=>{
        // The legacy endpoint must also refresh the Runtime catalog used by old
        // callers, coalesce concurrent reads and clear stale data on failure.
        await rt.refreshModels();return rt.catalog;
      };
      if(request.method==='GET'){const models=await catalog();return ok(read(()=>rt.models.get(models)));}
      if(request.method==='POST'){
        fields(body,['selection','expectedRevision']);
        const selection=body.selection as ModelSelection|undefined;
        if(!selection||typeof selection!=='object'||Array.isArray(selection)||typeof selection.model!=='string'||!selection.model||!(selection.reasoningEffort===null||typeof selection.reasoningEffort==='string')||Object.keys(selection).some(k=>!['model','reasoningEffort'].includes(k))||!Number.isSafeInteger(body.expectedRevision))throw new ServiceError('INVALID_REQUEST','模型配置无效。');
        try{
          // Fail stale requests before directory work and repeat CAS at commit.
          if(pluginCatalog&&read(()=>rt.models.get().revision)!==body.expectedRevision)throw new ServiceError('REVISION_CONFLICT','模型设置已变化，请刷新后重试。');
          const models=await catalog();
          return ok(read(()=>rt.models.set(selection,body.expectedRevision as number,models)));
        }
        catch(error){if(error instanceof BackendError)throw new ServiceError(error.code==='CONFLICT'?'REVISION_CONFLICT':'MODEL_UNAVAILABLE',error.message);throw error;}
      }
    }
    if(path==='/v1/capacity'&&request.method==='GET')return ok(read(()=>rt.runs.capacity()));
    if(graph){
      const scope={serviceId:rt.serviceId,projectId:graph[1]!,graphId:graph[2]!};read(()=>rt.graphs.scope(scope));
      if(graph[3]==='input-preview'&&request.method==='POST'){fields(body,['nodeId','excludeFiles','inputDraft']);if(body.excludeFiles!==undefined&&typeof body.excludeFiles!=='boolean')throw new ServiceError('INVALID_REQUEST','无效输入预检选项');return ok(read(()=>{ const nodeId=text(body.nodeId); if(body.inputDraft===undefined)return rt.inputs.inputPreview(scope.graphId,nodeId,body.excludeFiles===true); rt.graphs.runInputContent(scope,nodeId,body.inputDraft); return rt.previewRunInput(scope.graphId,nodeId,parseRunInput(body.inputDraft),body.excludeFiles===true); }));}
      if(graph[3]==='runs'&&request.method==='GET')return ok(read(()=>rt.runs.list(scope.projectId).filter(value=>value.graphId===scope.graphId)));
      if(['runs','runs-current'].includes(graph[3]!)&&request.method==='POST'){
        fields(body,['nodeId','kind','idempotencyKey','expectedExecutionRevision','modelOverride','imageRoute','preserveHistoricalOutputs','agent','inputDraft','nodeInputDrafts']);
        const currentRequest=graph[3]==='runs-current'?structuredClone(body) as Json:undefined;
        const currentNamespace=principal+':run.current:'+scope.graphId;
        if(currentRequest){const prior=read(()=>repo.replay(currentNamespace,text(body.idempotencyKey),currentRequest));if(prior!==undefined)return ok(prior);}
        if(graph[3]==='runs-current'){
          if('agent' in body||'modelOverride' in body||body.kind==='image_generation')throw new ServiceError('INVALID_REQUEST','Current Agent submission does not accept legacy or explicit Agent overrides.');
          const configuration=read(()=>rt.agentConfiguration?.get()),selection=configuration?.default.selection;
          const backend=configuration?.backends.find(value=>value.backendId===selection?.backendId);
          if(!configuration||!selection)throw new ServiceError('MODEL_UNAVAILABLE','No current Agent default is configured.');
          if(!backend?.enabled)throw new ServiceError('PLUGIN_UNAVAILABLE','The current Agent is unavailable.');
          body.agent={settingsGeneration:configuration.settingsGeneration,permissions:configuration.permissions,backendId:backend.backendId,configRevision:backend.revision,schemaVersion:backend.schemaVersion,model:{model:selection.model,reasoningEffort:selection.reasoningEffort}};
        }
        if('agent' in body&&(body.kind==='image_generation'||'imageRoute' in body||'modelOverride' in body))throw new ServiceError('INVALID_REQUEST','执行器选择不能与图片或旧模型选项混用。');
        if (body.kind === 'image_generation') throw new ServiceError('NOT_IMPLEMENTED', '专用生图已移除，请使用执行节点和生图技能。');
        if ('imageRoute' in body) throw new ServiceError('INVALID_REQUEST', '图片生成方式已移除。');
        const input={...body,...scope} as unknown as SubmitRun;text(input.nodeId);text(input.idempotencyKey);
        if('agent' in body)control.validateSubmission(input,principal);
        const prior=read(()=>repo.replay(principal+':run.submit',input.idempotencyKey,input as unknown as Json));
        if(prior!==undefined)return ok(prior && typeof prior==='object' && !Array.isArray(prior) && 'executionStart' in prior ? read(()=>rt.runs.get(String(prior.id))) : prior);
        const cleanups: (() => unknown)[] = [];
        try { const commit=await rt.prepareSubmission(input, cleanups, principal);return ok(read(()=>{
          rt.graphs.scope(scope);
          if(currentRequest){const prior=repo.replay(currentNamespace,input.idempotencyKey,currentRequest);if(prior!==undefined)return prior;}
          const result=commit(principal);
          return currentRequest?repo.idempotent(currentNamespace,input.idempotencyKey,currentRequest,()=>result as unknown as Json):result;
        })); }
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
        if(request.method==='POST'&&action==='agent-operation'){
          fields(body,['attemptId','operation']);
          if(typeof body.attemptId!=='string'||!body.operation||typeof body.operation!=='object'||Array.isArray(body.operation))throw new ServiceError('INVALID_REQUEST','原生操作请求无效。');
          read(()=>{rt.graphs.scope(current);if(rt.runs.runtime(id).epoch!==body.attemptId)throw new ServiceError('REVISION_CONFLICT','任务执行身份已变化。');});
          const result=await rt.agentOperation(id,body.attemptId,body.operation as Json);
          return ok(read(()=>{rt.graphs.scope(current);return result;}));
        }
        if(request.method==='GET'&&action==='execution-plan')return ok(read(()=>rt.executionChains.forRun(id)));
        if(request.method==='POST'&&action==='execution-plan'){fields(body,['nodeInputDrafts']);return ok(read(()=>rt.executionChains.forRun(id,executionInputs(body.nodeInputDrafts))));}
        if(request.method==='POST'&&action==='start'){
          fields(body,['nodeIds','expectedExecutionRevision','idempotencyKey','preserveHistoricalOutputs','nodeInputDrafts']);
          const nodeInputDrafts=body.nodeInputDrafts===undefined?undefined:executionInputs(body.nodeInputDrafts);
          if(body.preserveHistoricalOutputs!==undefined&&typeof body.preserveHistoricalOutputs!=='boolean')throw new ServiceError('INVALID_REQUEST','无效历史输出选项。');
          const key=text(body.idempotencyKey);
          if(!Array.isArray(body.nodeIds)||body.nodeIds.some(v=>typeof v!=='string')||!Number.isSafeInteger(body.expectedExecutionRevision))throw new ServiceError('INVALID_REQUEST','无效执行范围。');
          const data={nodeIds:body.nodeIds,expectedExecutionRevision:body.expectedExecutionRevision,...(nodeInputDrafts===undefined?{}:{nodeInputDrafts}),...(body.preserveHistoricalOutputs===undefined?{}:{preserveHistoricalOutputs:body.preserveHistoricalOutputs})};
          const prior=read(()=>repo.replay(principal+':run.start:'+id,key,data as Json));
          if(prior!==undefined)return ok(read(()=>rt.runs.get(id)));
          const cleanups: (() => unknown)[] = [];
          try { const commit=await rt.prepareExecutionStart(id,body.nodeIds as string[],body.expectedExecutionRevision as number,body.preserveHistoricalOutputs as boolean|undefined,cleanups,nodeInputDrafts);
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
          // Use inputs actually frozen at launch, but exclude execution-chain outputs
          // that are not editable reference inputs. Queued form edits may already be used.
          const submitted=JSON.parse(String(rt.db.prepare('SELECT payload FROM snapshots WHERE run_id=?').get(id)!.payload)) as import('@openworkgraph/protocol').InputSnapshot;
          const snapshot=rt.runs.snapshot(id),preview=rt.inputs.inputPreview(current.graphId,current.nodeId,snapshot.imageRoute?.type==='api');
          if(preview.issues.length)return {state:'unknown',issues:preview.issues};
          const referenceIds=new Set([...submitted.resources,...(submitted.projectFiles??[])].flatMap(item=>item.sourceNodeIds));
          const references=<T extends {sourceNodeIds:string[]}>(items:T[])=>items.flatMap(item=>{const sourceNodeIds=item.sourceNodeIds.filter(source=>referenceIds.has(source));return sourceNodeIds.length?[{...item,sourceNodeIds}]:[];});
          // Re-saving identical business JSON advances its storage version, not its input value.
          // Only form backing resources are normalized; selected files/media keep fixed identities.
          const formResourceIds=new Set([...preview.sources.flatMap(source=>source.form?[source.form.resource.resourceId]:[]),...(snapshot.frozenVisualizeInputs??[]).map(source=>source.form.resource.resourceId)]);
          const businessResources=(items:import('@openworkgraph/protocol').ResourceEnvelope[])=>items.map(item=>item.kind==='text'&&item.resource&&formResourceIds.has(item.resource.resourceId)?{...item,resource:null}:item);
          // Launch-time form replacement can reorder resources without changing inputs.
          const normalize=(items:unknown[])=>items.map(item=>canonicalJson(item as Json)).sort();
          const before=canonicalJson({prompt:snapshot.prompt,resources:normalize(businessResources(references(snapshot.resources))),projectFiles:normalize(references(snapshot.projectFiles??[]))} as unknown as Json);
          const after=canonicalJson({prompt:preview.prompt,resources:normalize(businessResources(preview.resources)),projectFiles:normalize(preview.projectFiles)} as unknown as Json);
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
