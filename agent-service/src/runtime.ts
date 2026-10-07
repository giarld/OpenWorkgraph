import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, SERVICE_VERSION, isTerminalRunStatus } from '@openworkgraph/protocol';
import type { Capability, CanvasResourceVersion, FrozenApiImageRoute, Json, Run, ServiceInfo, SubmitRun } from '@openworkgraph/protocol';
import { BlobStore } from './blob-store.js';
import { Graphs } from './graphs.js';
import { GraphFiles } from './graph-files.js';
import { Resources } from './resources.js';
import { PluginRegistry } from './plugins.js';
import { InputPreparation, type PreparedRepresentation } from './inputs.js';
import { ModelDefaultsStore, freezeModelSelection, type BackendModel } from './backend/models.js';
import { CodexBackendAdapter, type AdapterOptions } from './backend/adapter.js';
import { connect, listModels } from './backend/capabilities.js';
import { describeCodexFailure, type CodexStage } from './backend/diagnostics.js';
import { StdioRpc } from './backend/stdio.js';
import { Runs, type RunsDependencies } from './runs.js';
import { ExecutionChains } from './execution-chains.js';
import { History } from './history.js';
import { Scheduler, type SchedulerBackend } from './scheduler.js';
import { Publication } from './publication.js';
import { RuntimeBackend, backendReply } from './runtime-backend.js';
import { acquireProjectLock } from './project-lock.js';
import { ProjectProbe } from './project-probe.js';
import { ProjectFiles } from './project-files.js';
import type { DataDirectories } from './directories.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { ExecutionSettingsStore } from './execution-settings.js';
import { ImageProviders } from './image-providers.js';
import { ImageCredentials } from './image-credentials.js';
import { ApiImageAgent, RoutedImageBackend } from './api-image-agent.js';
import { planOpenAiImage, discoverOpenAiModels } from './openai-image-driver.js';

export interface WorkflowRuntimeOptions {
  backend?: SchedulerBackend; models?: BackendModel[];
  /** Default: discover on model reads/submission. True also probes at startup; false disables execution and discovery. */
  enableBackend?: boolean; backendOptions?: AdapterOptions;
}
class RuntimeRuns extends Runs {
  constructor(db: DatabaseSync, serviceId: string, dependencies: RunsDependencies, private readonly available: (run: Run, snapshot: import('@openworkgraph/protocol').InputSnapshot) => boolean) { super(db, serviceId, dependencies); }
  override claimNext(epoch: string, excludedProjects: readonly string[] = [], eligible?: Parameters<Runs['claimNext']>[2]): Run | null {
    // Capability discovery must never turn a persisted queue into failed/reconciling work.
    return super.claimNext(epoch, excludedProjects, (run, snapshot) => this.available(run, snapshot) && (!eligible || eligible(run, snapshot)));
  }
}
const capability = (status: Capability['status'], reason: string, verifiedAt: string | null = null): Capability => ({ status, reason, verifiedAt });
const resourceKey = (resource: CanvasResourceVersion) => JSON.stringify([resource.resourceId, resource.version, resource.sha256, resource.representationVersion]);

export class WorkflowRuntime {
  readonly blobs: BlobStore; readonly graphs: Graphs; readonly resources: Resources; readonly plugins: PluginRegistry;
  readonly inputs: InputPreparation; readonly models: ModelDefaultsStore; readonly runs: Runs; readonly history: History;
  readonly scheduler: Scheduler; readonly publication: Publication;
  readonly executionChains: ExecutionChains;
  readonly graphFiles:GraphFiles;
  readonly executionSettings: ExecutionSettingsStore;
  readonly imageProviders: ImageProviders;
  readonly imageCredentials: ImageCredentials;
  private readonly probe = new ProjectProbe();
  private readonly adapter: CodexBackendAdapter | undefined;
  private availableModels: BackendModel[];
  private timer: NodeJS.Timeout | undefined;
  private starting: Promise<void> | undefined;
  private catalogRefresh: Promise<void> | undefined;
  private catalogRpc: StdioRpc | undefined;
  private recovering = false;
  private closed = false; private closing = false; private stopping = false;
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly directories: DataDirectories, readonly options: WorkflowRuntimeOptions = {}) {
    this.availableModels = structuredClone(options.models ?? []);
    this.blobs = new BlobStore(directories.blobs); this.resources = new Resources(db, this.blobs);
    this.graphs = new Graphs(db, serviceId); this.plugins = new PluginRegistry(db);
    this.graphs.history.backfillActiveGates();
    this.graphFiles = new GraphFiles(db,directories.runs);
    this.executionSettings = new ExecutionSettingsStore(db);
    this.imageCredentials = new ImageCredentials(directories,serviceId);
    this.imageProviders = new ImageProviders(db,this.imageCredentials);
    this.inputs = new InputPreparation(db, { plugins: this.plugins, readRepresentation: resource => this.resources.readPreparedRepresentation(resource) }); this.models = new ModelDefaultsStore(db);
    this.runs = new RuntimeRuns(db, serviceId, { freeze: () => { throw new ServiceError('INPUT_BLOCKED', 'Use prepareSubmission outside the auth transaction'); }, ...(!options.backend ? { validateReply: (interaction, answer) => { backendReply(interaction, answer); } } : {}) }, (_run,snapshot) => snapshot.imageRoute?.type === 'api'
      ? this.imageProviders.credentialAvailable(snapshot.imageRoute.providerId,snapshot.imageRoute.credentialRevision)
      : this.executionCapability.status === 'available');
    this.history = new History(db); this.publication = new Publication(db, directories, this.resources, this.graphs, this.runs);
    this.executionChains = new ExecutionChains(this.runs,this.graphs,this.resources);
    this.adapter = options.backend ? undefined : new CodexBackendAdapter(options.backendOptions);
    const codexBackend = options.backend ?? new RuntimeBackend(this.runs, directories, this.adapter!, this.probe);
    const backend = new RoutedImageBackend(codexBackend,new ApiImageAgent(this.runs,this.resources,this.imageProviders,this.imageCredentials,directories),this.runs);
    this.scheduler = new Scheduler(this.runs, backend, { publish: (run, token) => this.publication.publish(run, token), acquireProjectLock: (_run, path) => acquireProjectLock(path) });
  }
  get catalog(): BackendModel[] { return structuredClone(this.availableModels); }
  /** Catalog reads require only the wire handshake, never login or execution self-checks. */
  async refreshModels(): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', '运行时正在关闭。');
    if (this.options.backend || this.options.enableBackend === false) return;
    if (this.catalogRefresh) return this.catalogRefresh;
    this.catalogRefresh = (async () => {
      const options = this.options.backendOptions ?? {};
      let rpc: StdioRpc | undefined;
      let stage: CodexStage = 'initialize';
      try {
        rpc = this.catalogRpc = new StdioRpc({ cwd: this.directories.root, ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { args: options.args } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}) });
        await connect(rpc);
        stage = 'model/list';
        const models = await listModels(rpc);
        if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', '运行时正在关闭。');
        this.availableModels = models;
      } catch (error) {
        this.availableModels = [];
        if (error instanceof ServiceError) throw error;
        const failure = describeCodexFailure(error, rpc, stage);
        throw new ServiceError('MODEL_UNAVAILABLE', failure.message, { details: failure.details, retryable: failure.retryable });
      } finally { rpc?.close(); this.catalogRpc = undefined; }
    })();
    try { await this.catalogRefresh; } finally { this.catalogRefresh = undefined; }
  }
  get executionCapability(): Capability {
    if (this.closed || this.closing) return capability('unavailable', 'Runtime is closing; accepted tasks are retained');
    if (this.options.backend) return capability('available', 'Host-injected controlled backend; not evidence of real Codex execution');
    if (this.options.enableBackend === false) return capability('unavailable', 'Backend discovery explicitly disabled by host');
    return capability('available', '执行由 Codex app-server 提供，沙盒权限使用工作空间设置；提交时检查模型，认证由 Codex 自身处理');
  }
  get imageGenerationCapability(): Capability {
    const execution = this.executionCapability;
    if (this.options.backend || execution.status !== 'available') return this.imageProviders.list().some(item=>item.enabled&&item.credentialConfigured&&item.models.length) ? capability('available','已配置的 API 生图服务商可执行，Codex 图片路径不可用。') : execution;
    return capability('available', '图片生成由 Codex 内置 imagegen 执行；成功后校验实际图片文件并发布到工作图。');
  }
  get capabilities(): ServiceInfo['capabilities'] {
    const local = capability('available', 'Durable local business implementation; authenticated HTTP integration required');
    return { pairing: local, projects: local, graphs: local, assets: local, execution: this.executionCapability, imageGeneration: this.imageGenerationCapability, events: local, backups: capability('unknown', 'Backup availability is supplied by host operations integration'), projectFiles:local, projectFileReferences:local };
  }
  get serviceInfo(): ServiceInfo {
    const modes=['text','image','text_image'] as const;
    const codex=this.executionCapability;
    const imageRoutes:NonNullable<ServiceInfo['imageRoutes']>=[{route:{type:'codex'},modes:{text:codex,image:codex,text_image:codex}}];
    for(const provider of this.imageProviders.list())for(const model of provider.models){
      const state=Object.fromEntries(modes.map(mode=>[mode,!provider.enabled?capability('unavailable','服务商已停用。')
        : !provider.credentialConfigured?capability('unavailable','本机凭据未配置或已撤销。')
        : !model.modes.includes(mode)?capability('unavailable','模型未声明支持 '+mode+' 输入。')
        : capability('available','此模型已从服务商目录启用；实际生成结果由服务商响应确认。')])) as Record<(typeof modes)[number],Capability>;
      imageRoutes.push({route:{type:'api',providerId:provider.id,modelId:model.id},modes:state});
    }
    return { serviceId:this.serviceId,version:SERVICE_VERSION,protocolVersion:PROTOCOL_VERSION,capabilities:this.capabilities,imageRoutes };
  }
  /** An explicitly initiated, potentially billable request. No catalog probe or fixture marks availability. */
  async discoverImageModels(providerId:string,expectedRevision:number):Promise<{models:{id:string;name:string;selected:boolean}[];revision:number}> {
    await this.imageProviders.refreshCredentials();
    const provider=this.imageProviders.list().find(item=>item.id===providerId);
    if(!provider||provider.revision!==expectedRevision)throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
    if(!provider.enabled)throw new ServiceError('MODEL_UNAVAILABLE','服务商已停用。');
    if(!provider.credentialConfigured||!provider.credentialRevision)throw new ServiceError('MODEL_UNAVAILABLE','请先保存服务商 API Key。');
    const credentialRevision=provider.credentialRevision;
    const secret=await this.imageCredentials.read(provider.id,credentialRevision);
    if(!secret)throw new ServiceError('MODEL_UNAVAILABLE','服务商 API Key 在本机不可用。');
    const discovered=await discoverOpenAiModels(provider.endpoint,secret,AbortSignal.timeout(30000));
    await this.imageProviders.refreshCredentials();
    const current=this.imageProviders.list().find(item=>item.id===provider.id);
    if(!current||current.revision!==expectedRevision||current.credentialRevision!==credentialRevision||!current.credentialConfigured)throw new ServiceError('REVISION_CONFLICT','服务商或 API Key 在拉取模型期间发生变化。');
    const selected=new Set(current.models.map(item=>item.id));
    return {models:discovered.map(item=>({...item,selected:selected.has(item.id)})),revision:current.revision};
  }
  private requireAvailable(request: SubmitRun): void {
    const state = request.kind === 'image_generation' && request.imageRoute?.type==='api' ? this.imageGenerationCapability : this.executionCapability;
    if (state.status !== 'available') throw new ServiceError('NOT_IMPLEMENTED', state.reason);
  }
  /** Returns a request-scoped synchronous commit closure; no shared mutable cache. */
  async prepareSubmission(input: SubmitRun): Promise<(principal: string) => Run> {
    if(input.kind!=='execution')return this.prepareSingleSubmission(input);
    const graph=this.graphs.snapshot(input);
    if(!graph.edges.some(e=>e.kind==='execution'&&(e.sourceId===input.nodeId||e.targetId===input.nodeId)))return this.prepareSingleSubmission(input,false);
    const plan=this.executionChains.plan(graph,input.nodeId);
    const outgoing=graph.edges.some(e=>e.kind==='execution'&&e.sourceId===input.nodeId);
    const commit=await this.prepareSingleSubmission(input);
    const auto=!outgoing&&!plan.requiresConfirmation&&!plan.nodes.some(n=>n.required&&n.missingPrompt);
    const members=auto?await this.executionChains.prepareMembers(graph,plan,this.executionChains.selection(plan,plan.initialNodeIds),undefined,request=>this.prepareSingleSubmission(request)):undefined;
    return principal=>atomic(this.db,()=>{
      const run=this.runs.get(commit(principal).id);
      if(run.status!=='accepted'||run.executionStart==='dependencies')return run;
      if(members)return members(principal,run);
      this.executionChains.setMode(run.id,outgoing?'manual':'confirm');
      return this.runs.get(run.id);
    });
  }
  async prepareExecutionStart(id:string,nodeIds:string[],expectedExecutionRevision:number):Promise<(principal:string,key:string)=>Run>{
    const run=this.runs.get(id);
    if(run.status!=='accepted'||!['manual','confirm'].includes(run.executionStart??''))throw new ServiceError('CONFLICT','任务已开始或不可启动。');
    const graph=this.graphs.snapshot(run),plan=this.executionChains.plan(graph,run.nodeId,id);
    if(plan.executionRevision!==expectedExecutionRevision)throw new ServiceError('REVISION_CONFLICT','工作图已变化，请重新选择执行深度。');
    const members=await this.executionChains.prepareMembers(graph,plan,this.executionChains.selection(plan,nodeIds),id,request=>this.prepareSingleSubmission(request));
    return (principal,key)=>this.runs.repo.idempotent(principal+':run.start:'+id,key,{nodeIds,expectedExecutionRevision},()=>members(principal) as unknown as Json) as unknown as Run;
  }
  private async prepareSingleSubmission(input: SubmitRun, holdExecution = true): Promise<(principal: string) => Run> {
    if (this.db.isTransaction) throw new ServiceError('CONFLICT', 'Preflight must precede the auth transaction');
    const request = structuredClone(input);
    if(request.imageRoute && request.kind!=='image_generation')throw new ServiceError('INVALID_REQUEST','Only image tasks can select an image route');
    let apiRoute: FrozenApiImageRoute | undefined;
    if(request.kind==='image_generation'){
      if(request.imageRoute?.type==='api'){
        if(request.modelOverride)throw new ServiceError('INVALID_REQUEST','API image route cannot use a Codex model');
        const selected=request.imageRoute;
        await this.imageProviders.refreshCredentials();
        const provider=this.imageProviders.list().find(item=>item.id===selected.providerId);
        if(!provider || !provider.enabled)throw new ServiceError('MODEL_UNAVAILABLE','所选生图服务商不存在或已停用。');
        const model=provider.models.find(item=>item.id===selected.modelId);
        if(!model)throw new ServiceError('MODEL_UNAVAILABLE','所选生图模型不存在。');
        if(!provider.credentialConfigured || !provider.credentialRevision)throw new ServiceError('MODEL_UNAVAILABLE','服务商凭据未配置或本机不可用。');
        apiRoute={...selected,configRevision:provider.revision,credentialRevision:provider.credentialRevision};
      }
      else { if(request.imageRoute && request.imageRoute.type!=='codex')throw new ServiceError('INVALID_REQUEST','Invalid image route');request.imageRoute={type:'codex',...(request.imageRoute?.options?{options:request.imageRoute.options}:{})}; }
    }
    if(!apiRoute){this.requireAvailable(request);await this.refreshModels();}
    const executionSettings = apiRoute?null:this.executionSettings.get();
    if (request.serviceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', 'Wrong service');
    const project = this.db.prepare('SELECT canonical_path,state FROM projects WHERE id=?').get(request.projectId);
    if (!project) throw new ServiceError('NOT_FOUND', 'Project not found');
    if (project.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', 'Project is inactive');
    const path = String(project.canonical_path); const inspected = await this.probe.inspect([path]);
    if (inspected(path).canonicalPath !== path) throw new ServiceError('PROJECT_UNAVAILABLE', 'Stored project path no longer resolves to itself');
    const versions = new Map<string, CanvasResourceVersion>();
    // Discover only direct input resources using the same declarative mappings.
    const discovery = new InputPreparation(this.db, { plugins: this.plugins, readRepresentation: resource => { versions.set(resourceKey(resource), resource); return { state: 'ready', resourceSha256: resource.sha256, representationVersion: resource.representationVersion, text: null, contentHash: null }; } });
    const preview = discovery.inputPreview(request.graphId, request.nodeId, !!apiRoute);
    if (preview.executionRevision !== request.expectedExecutionRevision) throw new ServiceError('REVISION_CONFLICT', 'Graph changed before preflight');
    const unsupportedProjectFile = preview.issues.find(item => item.reason.startsWith('API 生图不能读取项目文件引用'));
    if (unsupportedProjectFile) throw new ServiceError(unsupportedProjectFile.code, unsupportedProjectFile.reason);
    if (preview.projectFiles.length) {
      const states = await new ProjectFiles(this.db).stat(request.projectId, preview.projectFiles.map(item => item.relativePath));
      const unavailable = states.find(item => item.state !== 'available');
      if (unavailable) throw new ServiceError(unavailable.state === 'missing' ? 'INPUT_BLOCKED' : 'PROJECT_UNAVAILABLE', '项目文件引用当前不可读：' + unavailable.path);
    }
    if(apiRoute){
      const hasImage=preview.resources.some(item=>item.kind==='image' && item.resource);
      const mode=hasImage?(preview.prompt.trim()?'text_image':'image'):'text';
      const frozen=this.imageProviders.frozen(apiRoute.providerId,apiRoute.configRevision,apiRoute.modelId);
      if(!frozen.model.modes.includes(mode))throw new ServiceError('INPUT_BLOCKED','所选模型不支持 '+mode+' 输入。');
      const options=apiRoute.options;
      if((options?.size && options.size!=='auto' && !frozen.model.sizes.includes(options.size) && !frozen.model.sizes.includes('auto')) || (options?.quality && options.quality!=='auto' && !frozen.model.qualities.includes(options.quality) && !frozen.model.qualities.includes('auto')) || (options?.outputFormat && !frozen.model.formats.includes(options.outputFormat)))throw new ServiceError('INPUT_BLOCKED','所选模型不支持图片参数。');
    }
    const prepared = new Map<string, PreparedRepresentation>();
    const fileIds = new Set(preview.resources.filter(item => item.kind === 'file').map(item => item.resource?.resourceId));
    for (const [key, resource] of versions) {
      let text: string | null = null;
      if (resource.mime.startsWith('image/') || fileIds.has(resource.resourceId)) await this.resources.readContent(request, 'canvas', resource.resourceId, resource.version);
      else {
        const representation = await this.resources.representation(request, 'canvas', resource.resourceId, resource.version);
        if (representation.state !== 'ready' || (resource.representationVersion !== null && representation.version !== resource.representationVersion)) throw new ServiceError('INPUT_BLOCKED', representation.reason ?? 'Required immutable representation unavailable');
        text = representation.text;
      }
      prepared.set(key, Object.freeze({ state: 'ready', resourceSha256: resource.sha256, representationVersion: resource.representationVersion, text, contentHash: text === null ? null : createHash('sha256').update(text).digest('hex') }));
    }
    const scopedInputs = new InputPreparation(this.db, { plugins: this.plugins, readRepresentation: resource => prepared.get(resourceKey(resource)) ?? null });
    const scopedPreview = scopedInputs.inputPreview(request.graphId,request.nodeId,!!apiRoute);
    if(apiRoute){
      const references: {bytes:Buffer;mime:'image/png'|'image/jpeg'|'image/webp'}[]=[];
      for(const envelope of scopedPreview.resources){
        if(envelope.kind!=='image'||!envelope.resource)continue;
        const content=await this.resources.readContent(request,'canvas',envelope.resource.resourceId,envelope.resource.version);
        if(!['image/png','image/jpeg','image/webp'].includes(content.mime))throw new ServiceError('INPUT_BLOCKED','参考图格式不支持。');
        references.push({bytes:content.bytes,mime:content.mime as 'image/png'|'image/jpeg'|'image/webp'});
      }
      const frozen=this.imageProviders.frozen(apiRoute.providerId,apiRoute.configRevision,apiRoute.modelId);
      planOpenAiImage({route:apiRoute,model:frozen.model,prompt:scopedPreview.prompt,references:scopedPreview.resources,images:references});
    }
    const scoped = new Runs(this.db, this.serviceId, {
      validate: (_request, context) => {
        if(apiRoute){
          const current=this.imageProviders.list().find(item=>item.id===apiRoute.providerId);
          if(!current?.enabled || current.revision!==apiRoute.configRevision || current.credentialRevision!==apiRoute.credentialRevision || !this.imageProviders.credentialAvailable(apiRoute.providerId,apiRoute.credentialRevision))throw new ServiceError('REVISION_CONFLICT','生图服务商或凭据配置已变化，请重新提交。');
        } else {
          this.requireAvailable(request);
          if (this.executionSettings.get().revision !== executionSettings!.revision) throw new ServiceError('REVISION_CONFLICT', '权限设置已变化，请重新提交任务。');
          context.sandboxMode = executionSettings!.sandboxMode;
          try { this.models.freeze(request.modelOverride, this.availableModels); } catch { throw new ServiceError('MODEL_UNAVAILABLE', 'Selected model/effort is unavailable; choose explicitly'); }
        }
        if (context.canonicalPath !== path) throw new ServiceError('REVISION_CONFLICT', 'Project path changed while preparing inputs');
      },
      freeze: () => scopedInputs.build(request.graphId, request.nodeId, apiRoute
        ? {expectedExecutionRevision:request.expectedExecutionRevision,imageRoute:apiRoute}
        : {expectedExecutionRevision:request.expectedExecutionRevision,model:this.models.freeze(request.modelOverride,this.availableModels),...(request.kind==='image_generation'?{imageRoute:request.imageRoute?.type==='codex'?request.imageRoute:{type:'codex' as const}}:{})}),
    });
    return principal => scoped.submit(request, principal, request.kind==='execution' && holdExecution);
  }
  async prepareContinuation(id: string): Promise<(principal: string, idempotencyKey: string) => Run> {
    if (this.db.isTransaction) throw new ServiceError('CONFLICT', 'Continuation preflight must precede auth transaction');
    const run = this.runs.get(id); const token = this.runs.runtime(id);
    const replay = (work: () => Run) => (principal: string, key: string): Run => this.runs.repo.idempotent(principal + ':run.continue:' + id, key, { id }, () => work() as unknown as Json) as unknown as Run;
    if (run.status !== 'paused_restore') return replay(() => { throw new ServiceError('CONFLICT', 'Only explicitly paused restored Runs can continue'); });
    const snapshot = this.runs.snapshot(id); const snapshotJson = canonicalJson(snapshot as unknown as Json);
    const api=snapshot.imageRoute?.type==='api'?snapshot.imageRoute:null;
    if(api){await this.imageProviders.refreshCredentials();if(!this.imageProviders.credentialAvailable(api.providerId,api.credentialRevision))throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据已撤销或本机不可用。');}
    else {this.requireAvailable({ kind: token.details.kind } as SubmitRun);await this.refreshModels();}
    const project = this.db.prepare('SELECT state,canonical_path FROM projects WHERE id=?').get(run.projectId);
    if (!project || project.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', 'Restored project is inactive');
    const path = String(project.canonical_path);
    if (path !== token.details.canonicalPath) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored Run cannot be reassigned to another project path');
    const inspect = await this.probe.inspect([path]);
    if (inspect(path).canonicalPath !== path) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored project path no longer resolves to itself');
    if ((snapshot.projectFiles ?? []).length) {
      const states = await new ProjectFiles(this.db).stat(run.projectId, snapshot.projectFiles!.map(item => item.relativePath));
      const unavailable = states.find(item => item.state !== 'available');
      if (unavailable) throw new ServiceError(unavailable.state === 'missing' ? 'INPUT_BLOCKED' : 'PROJECT_UNAVAILABLE', '项目文件引用当前不可读：' + unavailable.path);
    }
    const validateFrozen = () => {
      const hasImage = snapshot.resources.some(item=>item.kind==='image' && item.resource) || (snapshot.projectFiles ?? []).some(item=>item.kind==='image');
      if (snapshot.inputDigest !== run.inputDigest || (!snapshot.prompt.trim() && !(token.details.kind==='image_generation' && hasImage))) throw new ServiceError('INPUT_BLOCKED', 'Invalid restored input snapshot');
      if(api){
        if(snapshot.model || snapshot.inputMode!==(snapshot.resources.some(item=>item.kind==='image'&&item.resource)?(snapshot.prompt.trim()?'text_image':'image'):'text'))throw new ServiceError('INPUT_BLOCKED','冻结 API 输入模式无效。');
        this.imageProviders.frozen(api.providerId,api.configRevision,api.modelId);
        if(this.db.prepare('SELECT 1 FROM image_provider_revoked_credentials WHERE provider_id=? AND revision=?').get(api.providerId,api.credentialRevision))throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据已撤销。');
        return;
      }
      if (!snapshot.model) throw new ServiceError('INPUT_BLOCKED','Codex model is missing from restored snapshot');
      try {
        const frozen = freezeModelSelection(snapshot.model, this.availableModels);
        if (canonicalJson(frozen as unknown as Json) !== canonicalJson(snapshot.model as unknown as Json)) throw Error('Changed model defaults');
      } catch { throw new ServiceError('MODEL_UNAVAILABLE', 'Frozen model/effort unavailable; no substitution is permitted'); }
    };
    validateFrozen();
    for (const envelope of snapshot.resources) {
      const resource = envelope.resource; if (!resource) continue;
      const metadata = this.resources.readCanvasVersion(run, resource.resourceId, resource.version);
      if (metadata.sha256 !== resource.sha256 || metadata.bytes !== resource.bytes || metadata.representationVersion !== resource.representationVersion) throw new ServiceError('INPUT_BLOCKED', 'Frozen resource version changed');
      await this.resources.readContent(run, 'canvas', resource.resourceId, resource.version);
    }
    return replay(() => {
      if (this.runs.repo.setting('acceptingRuns') !== true) throw new ServiceError('MAINTENANCE', 'Service is not accepting continuations');
      if(api){if(!this.imageProviders.credentialAvailable(api.providerId,api.credentialRevision))throw new ServiceError('MODEL_UNAVAILABLE','冻结凭据不可用。');}
      else this.requireAvailable({ kind: token.details.kind } as SubmitRun); validateFrozen();
      const current = this.runs.runtime(id);
      const target = this.db.prepare('SELECT p.state,p.canonical_path,g.archived,g.trashed,n.deleted,n.read_only FROM projects p JOIN graphs g ON g.project_id=p.id JOIN nodes n ON n.graph_id=g.id WHERE p.id=? AND g.id=? AND n.id=?').get(run.projectId, run.graphId, run.nodeId);
      if (!target || target.state !== 'active' || target.canonical_path !== path || target.archived || target.trashed || target.deleted || target.read_only) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored target changed or is read-only');
      if (current.epoch !== token.epoch || current.revision !== token.revision || canonicalJson(this.runs.snapshot(id) as unknown as Json) !== snapshotJson) throw new ServiceError('REVISION_CONFLICT', 'Restored Run changed during preflight');
      const pendingChain = token.details.executionStart && !this.db.prepare('SELECT 1 FROM execution_input_snapshots WHERE run_id=?').get(id);
      return this.runs.transition(id, token, pendingChain ? 'accepted' : 'queued');
    });
  }
  get ready(): Promise<void> { return this.starting ?? this.start(); }
  private active(): Run[] { return this.runs.list().filter(run => !isTerminalRunStatus(run.status) && !['queued', 'accepted', 'paused_restore'].includes(run.status)); }
  private async pump(): Promise<void> {
    if (this.closed) return;
    if(!this.closing)await this.executionChains.pump();
    await this.scheduler.tick();
    if (this.closing && !this.active().length) this.finishClose();
  }
  async start(): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', 'Runtime closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.options.enableBackend && !this.options.backend) {
        await this.refreshModels().catch(() => { /* Catalog reads expose retryable errors. */ });
      }
      await this.imageProviders.refreshCredentials();
      if (this.closed || this.closing) return;
      await this.graphFiles.drain();
      if (!this.stopping) atomic(this.db, () => this.db.prepare("UPDATE settings SET value='true' WHERE key='acceptingRuns'").run());
      this.timer = setInterval(() => { void this.pump().catch(() => { /* preserve durable state; host can inspect */ }); }, 100); this.timer.unref();
      await this.pump();
    })();
    return this.starting;
  }
  /** Host must hold its service-root instance lock before transferring epochs. */
  async recover(): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', 'Runtime closed');
    this.recovering = true;
    atomic(this.db, () => {
      if (this.runs.repo.setting('backupRestorePending') === true) {
        this.db.prepare("DELETE FROM settings WHERE key='backupRestorePending'").run();
        this.runs.recover(this.scheduler.epoch);
      } else this.runs.abandonOnRestart(this.scheduler.epoch);
    });
    await this.start();
  }
  /** Bind/startup failure only: never drain or mutate persisted service state. */
  disposeUnstarted(): void {
    if (this.starting || this.recovering || this.timer || !this.scheduler.isUnstarted || this.closing || this.stopping) throw new ServiceError('CONFLICT', 'Runtime has already entered its lifecycle');
    if (this.closed) return;
    this.closed = true; this.executionChains.stop(); this.probe.close();
  }
  stopAccepting(): void { this.stopping = true; this.executionChains.stop(); atomic(this.db, () => this.db.prepare("UPDATE settings SET value='false' WHERE key='acceptingRuns'").run()); }
  /** A host shutdown cancels durable queued work as well as active responders. */
  stopRuns(): void {
    this.stopAccepting();
    for (const run of this.runs.list()) {
      if (!isTerminalRunStatus(run.status)) this.runs.cancel(run.id, randomUUID(), 'host');
    }
  }
  async drain(options: { interrupt?: boolean } = {}): Promise<void> {
    this.stopAccepting();
    while (this.active().length) {
      if (options.interrupt) for (const run of this.active()) this.runs.cancel(run.id, 'runtime-drain', 'host');
      await this.pump(); await delay(25);
    }
    await this.scheduler.settled();
  }
  private finishClose(): void {
    if (this.closed) return; this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.probe.close();
    this.catalogRpc?.close();
    // No adapter.close(): disconnecting unresolved child processes is not cancellation.
  }
  close(): void {
    if (this.closed) return; this.stopAccepting(); this.closing = true;
    if (!this.active().length) this.finishClose();
    else if (!this.timer) { this.timer = setInterval(() => { void this.pump().catch(() => {}); }, 100); this.timer.unref(); }
  }
}
