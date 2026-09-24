import type { InputSnapshot, Interaction, Json, Run } from '@openworkgraph/protocol';
import type { SchedulerBackend, BackendContext, ReconcileResult } from './scheduler.js';
import { Runs } from './runs.js';
import { Resources } from './resources.js';
import { ImageProviders } from './image-providers.js';
import { ImageCredentials } from './image-credentials.js';
import { ServiceError } from './errors.js';
import { planOpenAiImage, executeOpenAiImage } from './openai-image-driver.js';
import { stageApiImageOutput } from './api-image-output.js';
import { runDirectories, type DataDirectories } from './directories.js';

/** No project file/tool access: only the accepted Run's immutable canvas blobs,
 * its empty output directory and the registered frozen provider API base URL. */
export class ApiImageAgent implements SchedulerBackend {
  private readonly pending = new Map<string, AbortController>();
  constructor(readonly runs: Runs, readonly resources: Resources, readonly providers: ImageProviders, readonly credentials: ImageCredentials, readonly dirs: DataDirectories) {}
  async start(run: Run, snapshot: InputSnapshot, context: BackendContext): Promise<void> {
    const route=snapshot.imageRoute;
    if(!route || route.type!=='api')throw new ServiceError('INVALID_REQUEST','API 执行器只能运行冻结的 API 图片任务。');
    const controller=new AbortController();
    this.pending.set(run.id,controller);
    let phase:'preparing'|'provider_request'|'output_staging'='preparing';
    try {
      if(this.runs.db.prepare('SELECT 1 FROM image_provider_revoked_credentials WHERE provider_id=? AND revision=?').get(route.providerId,route.credentialRevision))throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据已撤销。');
      const secret=await this.credentials.read(route.providerId,route.credentialRevision);
      if(!secret)throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据版本不在本机。');
      const frozen=this.providers.frozen(route.providerId,route.configRevision,route.modelId);
      const references: {bytes:Buffer;mime:'image/png'|'image/jpeg'|'image/webp'}[]=[];
      for(const envelope of snapshot.resources){
        if(envelope.kind!=='image'||!envelope.resource)continue;
        const metadata=this.resources.readCanvasVersion(run,envelope.resource.resourceId,envelope.resource.version);
        if(metadata.sha256!==envelope.resource.sha256||metadata.bytes!==envelope.resource.bytes)throw new ServiceError('INPUT_BLOCKED','冻结参考图版本已变化。');
        const content=await this.resources.readContent(run,'canvas',envelope.resource.resourceId,envelope.resource.version);
        if(!['image/png','image/jpeg','image/webp'].includes(content.mime))throw new ServiceError('INPUT_BLOCKED','参考图格式不支持。');
        references.push({bytes:content.bytes,mime:content.mime as 'image/png'|'image/jpeg'|'image/webp'});
      }
      const plan=planOpenAiImage({prompt:snapshot.prompt,references:snapshot.resources,images:references,route,model:frozen.model});
      runDirectories(this.dirs,run.id);
      if(controller.signal.aborted||this.runs.get(run.id).status==='cancelling'){context.emit({type:'stopped'});return;}
      // After this point an uncertain transport outcome can represent a paid request.
      context.emit({type:'started'});
      if(this.runs.db.prepare('SELECT 1 FROM image_provider_revoked_credentials WHERE provider_id=? AND revision=?').get(route.providerId,route.credentialRevision))throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据已撤销。');
      phase='provider_request';
      const result=await executeOpenAiImage(plan,frozen.endpoint,secret,AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]));
      if(controller.signal.aborted||this.runs.get(run.id).status==='cancelling'){context.emit({type:'stopped'});return;}
      phase='output_staging';
      await stageApiImageOutput(run,this.dirs,result.bytes,{providerId:route.providerId,modelId:route.modelId,inputDigest:snapshot.inputDigest});
      if(result.requestId)context.emit({type:'progress',payload:{requestId:result.requestId,source:'image_provider'}});
      context.emit({type:'completed',result:{providerId:route.providerId,modelId:route.modelId,...(result.requestId?{requestId:result.requestId}:{})}});
    } catch(error){
      if(controller.signal.aborted){context.emit({type:'stopped'});return;}
      if(error instanceof ServiceError && error.code==='CONFLICT')throw error; // unknown acceptance: reconcile, never re-send
      if(!(error instanceof ServiceError)){
        const code=error&&typeof error==='object'&&'code' in error?String(error.code).slice(0,40):undefined;
        const name=error instanceof Error?error.name:'UnknownError';
        const message=(error instanceof Error?error.message:String(error)).replace(/Bearer\s+\S+/gi,'Bearer <redacted>').replace(/https?:\/\/\S+/gi,'<redacted-url>').replace(/[A-Za-z0-9_-]{32,}/g,'<redacted>').slice(0,500);
        this.runs.record(run.id,'api-image.error',{phase,name,...(code?{code}:{}),message});
      }
      const fallback=phase==='output_staging'?'服务商请求已成功返回，但保存图片输出失败。':phase==='provider_request'?'服务商响应处理失败。':'图片任务准备失败。';
      context.emit({type:'failed',error:error instanceof ServiceError?error.message:fallback});
    } finally {this.pending.delete(run.id);}
  }
  async cancel(run:Run,context:BackendContext):Promise<'confirmed'|'unknown'> {
    const pending=this.pending.get(run.id);
    if(pending){pending.abort();return 'confirmed';}
    // Aborting local wait is not proof of provider cancellation; no new attempt follows.
    if(this.runs.runtime(run.id).details.cancelRequested===true){context.emit({type:'stopped'});return 'confirmed';}
    return 'unknown';
  }
  async reconcile(run:Run,_context:BackendContext):Promise<ReconcileResult> {
    if(this.runs.runtime(run.id).details.cancelRequested===true)return 'interrupted';
    return 'unknown'; // No provider query/idempotency contract: preserve uncertainty after restart.
  }
}

export class RoutedImageBackend implements SchedulerBackend {
  constructor(readonly codex:SchedulerBackend,readonly api:ApiImageAgent,readonly runs:Runs) {}
  private delegate(run:Run):SchedulerBackend {return this.runs.snapshot(run.id).imageRoute?.type==='api'?this.api:this.codex;}
  start(run:Run,snapshot:InputSnapshot,context:BackendContext):Promise<void> {return (snapshot.imageRoute?.type==='api'?this.api:this.codex).start(run,snapshot,context);}
  cancel(run:Run,context:BackendContext):Promise<'confirmed'|'unknown'> {return this.delegate(run).cancel(run,context);}
  reconcile(run:Run,context:BackendContext):Promise<ReconcileResult> {return this.delegate(run).reconcile?.(run,context)??Promise.resolve('unknown');}
  reply(run:Run,interaction:Interaction,answer:Json,context:BackendContext):Promise<void> {
    const delegate=this.delegate(run);
    if(!delegate.reply)throw new ServiceError('INVALID_REQUEST','API 图片任务不支持交互。');
    return delegate.reply(run,interaction,answer,context);
  }
}
