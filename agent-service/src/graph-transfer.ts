import { WORKGRAPH_UPLOAD_MAX_BYTES, WORKGRAPH_TRANSFER_TOTAL_BYTES, WORKGRAPH_BUNDLE_MAX_BYTES, executionOrder, importedGraphTitle } from '@openworkgraph/protocol';
import { createHash, randomUUID } from 'node:crypto';
import type { GraphScope, GraphSnapshot, Json, Node, Edge, Scope } from '@openworkgraph/protocol';
import { previewEdgeError } from '@openworkgraph/protocol';
import { Graphs, assertProjectWritable, resourceLinks, nodeDimension } from './graphs.js';
import { Resources } from './resources.js';
import type { PreparedBlob } from './blob-store.js';
import { mimeMatchesBytes, sniffMime } from './blob-store.js';
import { checkedJson, PluginRegistry, portableSkillContent } from './plugins.js';
import { atomic } from './persistence/database.js';
import { canonicalJson, canonicalJsonHash } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { commitTransferResource, insertTransferredVisualizeNode, remapVisualizeAssetData, remapVisualizeContent, remapVisualizePage, validateVisualizeBundle, type VisualizeResourceMap } from './visualize-transfer.js';
import { ProjectFiles, classifyProjectFile } from './project-files.js';

import type { BundleResource, BundlePluginRequirement, CopiedProvenance, ImportedGraphSnapshot, GraphBundle } from '@openworkgraph/protocol';
export type { BundleResource, BundlePluginRequirement, CopiedProvenance, ImportedGraphSnapshot, GraphBundle } from '@openworkgraph/protocol';
/** Opaque instance-bound token. Contains no filesystem paths or mutable payload. */
export interface PreparedGraphImport { readonly digest: string; readonly projectId: string; readonly serviceId: string }
export interface DisposedGraphImport { retired: number; retained: number; removed: number; failed: number }
interface ImportData {bundle: GraphBundle; blobs: PreparedBlob[]; resourceMap: VisualizeResourceMap; trustedTopology: boolean; disposed: boolean; disposal: Promise<DisposedGraphImport> | null}
export interface GraphTransferLimits { maxBundleBytes: number; maxResourceBytes: number; maxTotalResourceBytes: number; maxNodes: number; maxResources: number }
const DEFAULT_LIMITS: GraphTransferLimits = {maxBundleBytes:WORKGRAPH_BUNDLE_MAX_BYTES,maxResourceBytes:WORKGRAPH_UPLOAD_MAX_BYTES,maxTotalResourceBytes:WORKGRAPH_TRANSFER_TOTAL_BYTES,maxNodes:2000,maxResources:256};
const core = new Set(['text','image','document','video','file','preview','execution','group','visualize']);
const key = (id: string, version: number) => JSON.stringify([id,version]);
function portableNode(node: Node): Node {
  const result = structuredClone(node);
  if (core.has(node.type)) result.content = portableSkillContent(result.content);
  // Visualize exports already own an immutable graph resource. Library IDs in
  // their provenance are local metadata, not dependencies of the portable copy.
  if (['image','file'].includes(node.type) && record(result.content) &&
      typeof result.content.resourceId === 'string' && record(result.content.visualizeSource)) {
    delete result.content.visualizeSource.assetId;
    delete result.content.visualizeSource.assetVersion;
  }
  return result;
}
function invalid(message: string): never {throw new ServiceError('INVALID_REQUEST',message);}
function record(value: unknown): value is Record<string,unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function id(value: unknown): asserts value is string {if(typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) invalid('Invalid bundle identity');}
function positive(value: unknown): asserts value is number {if(typeof value !== 'number' || !Number.isSafeInteger(value) || value<1) invalid('Invalid bundle version');}
function keys(value: object, allowed: string[]): void {if(Object.keys(value).some(k=>!allowed.includes(k))) invalid('Unsupported bundle field');}
function text(value: unknown, max: number, allowEmpty = false): asserts value is string {if(typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length>max || [...value].some(character => character.charCodeAt(0) < 32)) invalid('Invalid bundle title/name');}
function hash(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}
/** Portable graph data only: no Run records, thread identities, filesystem paths or executable plugin activation. */
export class GraphTransfer {
  private readonly prepared = new WeakMap<PreparedGraphImport,ImportData>();
  readonly limits: Readonly<GraphTransferLimits>;
  constructor(readonly graphs: Graphs, readonly resources: Resources, limits: Partial<GraphTransferLimits> = {}, readonly projectFiles = new ProjectFiles(graphs.db)) {
    if(graphs.db !== resources.db) throw new Error('Graph transfer requires one shared database');
    this.limits = {...DEFAULT_LIMITS,...limits};
    if(Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1)) invalid('Invalid transfer limits');
  }
  private target(scope: Scope): void {
    if(scope.serviceId!==this.graphs.serviceId) throw new ServiceError('SERVICE_MISMATCH','Wrong target service');
    assertProjectWritable(this.graphs.db,scope.projectId);
  }
  private outside(): void {if(this.graphs.db.isTransaction) throw new Error('Graph transfer preparation must run outside transactions');}
  getCopiedProvenance(scope:GraphScope):CopiedProvenance[] {
    this.graphs.scope(scope);
    const value=this.graphs.repo.setting('graph-copied-provenance:'+scope.graphId);
    const live=new Set(this.graphs.db.prepare('SELECT id FROM nodes WHERE graph_id=? AND deleted=0').all(scope.graphId).map(r=>String(r['id'])));
    return (Array.isArray(value)?value as unknown as CopiedProvenance[]:[]).filter(p=>p.kind==='copied-delivery'?live.has(p.sourceId)&&live.has(p.targetId):live.has(p.nodeId));
  }
  async exportGraph(scope: GraphScope): Promise<GraphBundle> {
    this.outside();
    const bundle = atomic(this.graphs.db,()=>{
      const snapshot=this.graphs.snapshot(scope);
      const portableNodes=snapshot.nodes.map(portableNode);
      const links=new Map<string,{resourceId:string;version:number}>();
      for(const node of snapshot.nodes) for(const link of resourceLinks(node.content,node.type)) links.set(key(link.resourceId,link.version),link);
      // Include explicit unplaced graph resources, not unrelated Run/history versions.
      for(const row of this.graphs.db.prepare("SELECT resource_id,resource_version FROM canvas_resource_references WHERE graph_id=? AND owner_kind='graph' ORDER BY resource_id,resource_version").all(scope.graphId)) {
        const link={resourceId:String(row['resource_id']),version:Number(row['resource_version'])};links.set(key(link.resourceId,link.version),link);
      }
      const resources=[...links.values()].map(link=>{
        const version=this.resources.readCanvasVersion(scope,link.resourceId,link.version);
        return {...link,name:this.resources.getCanvas(scope,link.resourceId).name,mime:version.mime,bytes:version.bytes,sha256:version.sha256,base64:''};
      });
      const requirements=new Map<string,BundlePluginRequirement>();
      const retained=this.graphs.repo.setting('graph-import-requirements:'+scope.graphId);
      if(Array.isArray(retained)) for(const item of retained) {const r=item as unknown as BundlePluginRequirement;requirements.set(key(r.typeId,r.schemaVersion),r);}
      for(const node of snapshot.nodes) if(!core.has(node.type)) {
        const k=key(node.type,node.schemaVersion); if(requirements.has(k)) continue;
        const row=this.graphs.db.prepare('SELECT contract FROM plugin_contracts WHERE type=? AND schema_version=?').get(node.type,node.schemaVersion);
        requirements.set(k,{typeId:node.type,schemaVersion:node.schemaVersion,contract:row ? JSON.parse(String(row['contract'])) as Json : null});
      }
      return {format:'openworkgraph.graph' as const,version:1 as const,graph:{title:snapshot.title,nodes:portableNodes,edges:snapshot.edges},resources,pluginRequirements:[...requirements.values()],copiedProvenance:this.getCopiedProvenance(scope)};
    });
    const projectNodes = bundle.graph.nodes.filter(node => {
      const content = record(node.content) ? node.content : undefined;
      const source = content && record(content.source) ? content.source : undefined;
      return source?.kind === 'project-file';
    });
    if (bundle.graph.nodes.length > this.limits.maxNodes || bundle.resources.length + projectNodes.length > this.limits.maxResources)
      throw new ServiceError('PAYLOAD_TOO_LARGE','Graph exceeds export budget');
    const projectPlans: Array<{ node: Node; relativePath: string; classified: ReturnType<typeof classifyProjectFile>; bytes: number }> = [];
    let totalResourceBytes = bundle.resources.reduce((sum, resource) => sum + resource.bytes, 0);
    const maxResourceBytes = Math.min(this.limits.maxResourceBytes, this.resources.blobs.maxBytes);
    if (bundle.resources.some(resource => resource.bytes > maxResourceBytes) || totalResourceBytes > this.limits.maxTotalResourceBytes)
      throw new ServiceError('PAYLOAD_TOO_LARGE','Graph exceeds export budget');
    for (let offset = 0; offset < projectNodes.length; offset += 100) {
      const batch = projectNodes.slice(offset, offset + 100).map(node => {
        const content = record(node.content) ? node.content : undefined;
        const source = content && record(content.source) ? content.source : undefined;
        const relativePath = source && typeof source.relativePath === 'string' ? source.relativePath : '';
        if (!relativePath || source?.serviceId !== scope.serviceId || source?.projectId !== scope.projectId) throw new ServiceError('INVALID_REQUEST', '图中项目文件引用不属于当前运行时项目。');
        return { node, relativePath, classified:classifyProjectFile(relativePath) };
      });
      const observations = await this.projectFiles.stat(scope.projectId, batch.map(item => item.relativePath));
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index]!, observation = observations[index];
        if (!observation || observation.state !== 'available') throw new ServiceError(observation?.state === 'missing' ? 'NOT_FOUND' : 'PROJECT_UNAVAILABLE', observation?.state === 'missing' ? '引用文件已不存在，工作图导出失败。' : '引用文件当前不可用，工作图导出失败。');
        if (observation.bytes === null || !Number.isSafeInteger(observation.bytes) || observation.bytes < 0) throw new ServiceError('PROJECT_UNAVAILABLE', '无法确认引用文件大小，工作图导出失败。');
        if (observation.bytes > maxResourceBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', '引用文件超过 300 MB，工作图导出失败。');
        totalResourceBytes += observation.bytes;
        if (totalResourceBytes > this.limits.maxTotalResourceBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Graph exceeds export budget');
        projectPlans.push({ ...item, bytes:observation.bytes });
      }
    }
    const resourceIds = new Set(bundle.resources.map(resource => resource.resourceId));
    const projectResourceIds = new Set<string>();
    for (const plan of projectPlans) {
      const { node, relativePath, classified } = plan;
      const content = record(node.content) ? node.content : undefined;
      const bytes = await this.projectFiles.read(scope.projectId, relativePath, maxResourceBytes);
      if (bytes.length !== plan.bytes) throw new ServiceError('CONFLICT', '引用文件在导出期间已变化，请重试。');
      let resourceId = 'project-file-' + node.id;
      let suffix = 1;
      while (resourceIds.has(resourceId)) resourceId = 'project-file-' + node.id + '-' + suffix++;
      resourceIds.add(resourceId);
      const title = content && typeof content.title === 'string' && content.title.trim() ? content.title : relativePath.split('/').at(-1) ?? '项目文件';
      const resource = { resourceId, version:1, name:title, mime:classified.mime, bytes:bytes.length, sha256:hash(bytes), base64:bytes.toString('base64') };
      bundle.resources.push(resource);
      projectResourceIds.add(resourceId);
      node.type = classified.type;
      const decoded = classified.type === 'text' ? new TextDecoder('utf-8',{fatal:true}).decode(bytes) : '';
      const text = classified.type === 'text' && Buffer.byteLength(JSON.stringify(decoded)) <= 2 * 1024 * 1024 - 2048 ? decoded : '';
      node.content = { title, text, prompt:'', resourceId, resourceVersion:1, mime:classified.mime, ...(classified.type === 'file' ? { bytes:bytes.length } : {}) };
    }
    for(const resource of bundle.resources) {
      if (projectResourceIds.has(resource.resourceId)) continue;
      const content=await this.resources.readContent(scope,'canvas',resource.resourceId,resource.version);
      if(content.bytes.length!==resource.bytes || hash(content.bytes)!==resource.sha256 || content.mime!==resource.mime) throw new ServiceError('CONFLICT','Resource changed during export');
      resource.base64=content.bytes.toString('base64');
    }
    // Reuse import validation so exported data is portable and structurally complete.
    return this.validate(bundle,true).bundle;
  }
  private validate(input: unknown, trustedTopology: boolean): {bundle: GraphBundle; bytes: Buffer[]} {
    const bundle=checkedJson(input,this.limits.maxBundleBytes,40) as unknown as GraphBundle;
    if(!record(bundle) || bundle.format!=='openworkgraph.graph' || bundle.version!==1 || !record(bundle.graph)) invalid('Unsupported graph bundle');
    keys(bundle,['format','version','graph','resources','pluginRequirements','copiedProvenance']);keys(bundle.graph,['title','nodes','edges']);text(bundle.graph.title,1024);
    if(!Array.isArray(bundle.graph.nodes)||bundle.graph.nodes.length>this.limits.maxNodes || !Array.isArray(bundle.graph.edges)||bundle.graph.edges.length>this.limits.maxNodes*9 || !Array.isArray(bundle.resources)||bundle.resources.length>this.limits.maxResources || !Array.isArray(bundle.pluginRequirements)||bundle.pluginRequirements.length>this.limits.maxNodes) invalid('Invalid bundle collection limits');
    const nodes=new Map<string,Node>();
    for(const n of bundle.graph.nodes) {
      if(!record(n)) invalid('Invalid node');keys(n,['id','type','schemaVersion','contentVersion','content','x','y','width','height','memberIds','readOnly']);id(n.id);id(n.type);positive(n.schemaVersion);positive(n.contentVersion);
      if(nodes.has(n.id)||typeof n.readOnly!=='boolean'||!Number.isFinite(n.x)||!Number.isFinite(n.y)||Math.abs(n.x)>1e9||Math.abs(n.y)>1e9) invalid('Invalid or duplicate node');
      checkedJson(n.content,2*1024*1024,32);
      if (core.has(n.type)) n.content = portableSkillContent(n.content);
      if(n.width!==undefined)nodeDimension(n.width);if(n.height!==undefined)nodeDimension(n.height);
      if(n.type!=='group'&&n.memberIds!==undefined)invalid('Only layout groups have members');
      if(n.type==='group'){
        if(n.readOnly||new PluginRegistry(this.graphs.db).inspect(n.type,n.schemaVersion,n.content).state!=='available')invalid('Invalid layout group');
        if(record(n.content)&&n.content['title']!==undefined)text(n.content['title'],1024,true);
        if(n.memberIds!==undefined&&(!Array.isArray(n.memberIds)||n.memberIds.some(value=>typeof value!=='string')||new Set(n.memberIds).size!==n.memberIds.length))invalid('Invalid group members');
      }
      let values=0;const count=(v:Json):void=>{if(++values>100000)invalid('Node content has too many values');if(v&&typeof v==='object')for(const item of Object.values(v))count(item);};count(n.content);
      nodes.set(n.id,n);
    }
    const members=new Set<string>();
    for(const n of nodes.values())if(n.type==='group')for(const memberId of n.memberIds??[]){
      const member=nodes.get(memberId);
      if(!member||member.type==='group'||members.has(memberId))invalid('Missing, nested or overlapping group member');
      members.add(memberId);
    }
    const pairs=new Set<string>(),edges=new Set<string>(),counts=new Map<string,number>(),deliveryTargets=new Set<string>();
    for(const edge of bundle.graph.edges) {
      if(!record(edge)) invalid('Invalid edge');keys(edge,['id','sourceId','targetId','kind']);id(edge.id);
      const source=nodes.get(edge.sourceId),target=nodes.get(edge.targetId),pair=JSON.stringify([edge.sourceId,edge.targetId]);
      if(!source||!target||source.id===target.id||edges.has(edge.id)||pairs.has(pair)) throw new ServiceError('INVALID_EDGE','Missing, self or duplicate edge endpoint');
      if(source.type==='group'||target.type==='group')throw new ServiceError('INVALID_EDGE','Layout groups cannot be edge endpoints');
      edges.add(edge.id);pairs.add(pair);
      if(edge.kind==='delivery') {
        if(source.type!=='execution'||['execution','group','preview'].includes(target.type)||(!target.readOnly&&target.type!=='visualize')||deliveryTargets.has(target.id)) throw new ServiceError('INVALID_EDGE','Delivery topology requires one execution source to a readonly output or editable visualize');
        deliveryTargets.add(target.id);
      } else if(edge.kind==='execution') {
        if(source.type!=='execution'||target.type!=='execution') throw new ServiceError('INVALID_EDGE','Execution chain edges require execution endpoints');
      } else if(edge.kind==='reference') {
        if(source.type==='execution') throw new ServiceError('INVALID_EDGE','Execution cannot be a reference source');
        const previewError=previewEdgeError(source.type,target.type,counts.get(target.id)??0);
        if(previewError)throw new ServiceError('INVALID_EDGE',previewError);
        const count=(counts.get(target.id)??0)+1;counts.set(target.id,count);if(count>8) throw new ServiceError('INVALID_EDGE','More than 8 direct predecessors');
      } else throw new ServiceError('INVALID_EDGE','Unknown edge kind');
    }
    if(!executionOrder(bundle.graph.edges)) throw new ServiceError('INVALID_EDGE','Execution chain contains a cycle');
    if(bundle.copiedProvenance!==undefined) {
      if(!Array.isArray(bundle.copiedProvenance)||bundle.copiedProvenance.length>this.limits.maxNodes*10)invalid('Invalid copied provenance collection');
      for(const p of bundle.copiedProvenance) {
        if(!record(p)||p.verified!==false)invalid('Imported provenance is always unverified');
        if(p.kind==='copied-delivery') {
          keys(p,['kind','sourceId','targetId','verified']);
          if(nodes.get(p.sourceId)?.type!=='execution'||!nodes.has(p.targetId)||['execution','group'].includes(nodes.get(p.targetId)!.type)||p.sourceId===p.targetId)invalid('Invalid copied delivery endpoints');
        } else if(p.kind==='copied-node') {
          keys(p,['kind','nodeId','metadata','verified']);if(!nodes.has(p.nodeId))invalid('Missing copied provenance node');checkedJson(p.metadata);
        } else invalid('Unknown copied provenance kind');
      }
    }
    const requirements=new Set<string>();
    for(const r of bundle.pluginRequirements) {
      if(!record(r)) invalid('Invalid plugin requirement');id(r.typeId);positive(r.schemaVersion);keys(r,['typeId','schemaVersion','contract']);
      const k=key(r.typeId,r.schemaVersion);if(requirements.has(k)) invalid('Duplicate plugin requirement');requirements.add(k);
      if(r.contract!==null) checkedJson(r.contract,65_536,24); // Preserve opaque requirements; never register or evaluate them.
    }
    for(const n of nodes.values()) if(!core.has(n.type)&&!requirements.has(key(n.type,n.schemaVersion))) invalid('Missing plugin requirement');
    const resources=new Set<string>(),buffers:Buffer[]=[];let total=0;
    for(const r of bundle.resources) {
      if(!record(r)) invalid('Invalid resource');keys(r,['resourceId','version','name','mime','bytes','sha256','base64']);id(r.resourceId);positive(r.version);text(r.name,512);
      if(typeof r.mime!=='string'||! /^[a-zA-Z0-9.+-]+[/][a-zA-Z0-9.+-]+$/.test(r.mime)||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<0||r.bytes>Math.min(this.limits.maxResourceBytes,this.resources.blobs.maxBytes)) invalid('Invalid resource metadata');
      total+=r.bytes;if(total>this.limits.maxTotalResourceBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Bundle resources exceed total budget');
      const k=key(r.resourceId,r.version);if(resources.has(k)) invalid('Duplicate resource version');resources.add(k);
      if(typeof r.base64!=='string'||r.base64.length!==4*Math.ceil(r.bytes/3)||! /^[A-Za-z0-9+/]*={0,2}$/.test(r.base64)) invalid('Invalid base64 encoding');
      const bytes=Buffer.from(r.base64,'base64');if(bytes.length!==r.bytes||bytes.toString('base64')!==r.base64||hash(bytes)!==r.sha256) invalid('Resource hash/size mismatch');
      const sniffed=sniffMime(bytes),declared=r.mime.toLowerCase();
      if(!mimeMatchesBytes(declared,sniffed)) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','Bundle MIME does not match bytes');
      if(declared==='application/json') {try {JSON.parse(bytes.toString('utf8'));}catch {invalid('Invalid JSON resource');}}
      buffers.push(bytes);
    }
    for(const n of nodes.values()) {
      for(const link of resourceLinks(n.content,n.type)) if(!resources.has(key(link.resourceId,link.version))) invalid('Referenced canvas resource/version is missing from bundle');
      const rejectAssets=(value:Json):void=>{if(!value||typeof value!=='object')return;if(!Array.isArray(value)&&Object.hasOwn(value,'assetId')) invalid('Legacy/remote asset references are not portable canvas resources');for(const v of Object.values(value))rejectAssets(v);};if(n.type!=='visualize')rejectAssets(n.content);
    }
    validateVisualizeBundle(bundle.graph.nodes, bundle.resources, buffers);
    for (const node of nodes.values()) if(node.type==='visualize') {
      const content=node.content as Record<string,Json>;
      for(const binding of content['inputBindings'] as {edgeId:string}[]) if(!bundle.graph.edges.some(edge=>edge.id===binding.edgeId&&edge.targetId===node.id&&edge.kind==='reference')) invalid('Visualize input binding must name an incoming reference edge');
    }
    return {bundle,bytes:buffers};
  }
  /** trustedTopology is a local authorization decision, NEVER a field accepted from an HTTP bundle. */
  async prepareImport(scope: Scope, input: unknown, options: {trustedTopology?: boolean} = {}): Promise<PreparedGraphImport> {
    this.outside();this.target(scope);const stableScope={serviceId:scope.serviceId,projectId:scope.projectId};
    const trustedTopology=options.trustedTopology===true;const {bundle,bytes}=this.validate(input,trustedTopology);
    const digest=canonicalJsonHash(bundle as unknown as Json);const blobs:PreparedBlob[]=[];
    const resourceMap: VisualizeResourceMap = new Map(bundle.resources.map(r => [key(r.resourceId,r.version),{resourceId:randomUUID(),resourceVersion:1}]));
    const pages=validateVisualizeBundle(bundle.graph.nodes,bundle.resources,bytes);
    const forms = new Set(bundle.graph.nodes.filter(node => node.type === 'visualize').flatMap(node => {
      const form = (node.content as Record<string, Json>).form as Record<string, Json> | undefined;
      const ref = form?.resource as Record<string, Json> | undefined;
      return ref ? [key(String(ref.resourceId), Number(ref.resourceVersion))] : [];
    }));
    const transferredBytes=bundle.resources.map((r,index)=>{
      const page=pages.get(key(r.resourceId,r.version));
      return page ? Buffer.from(canonicalJson(remapVisualizePage(page,resourceMap) as unknown as Json)) : forms.has(key(r.resourceId,r.version)) ? Buffer.from(canonicalJson(remapVisualizeAssetData(JSON.parse(bytes[index]!.toString('utf8')), resourceMap))) : bytes[index]!;
    });
    if(transferredBytes.some(content=>content.length>Math.min(this.limits.maxResourceBytes,this.resources.blobs.maxBytes)) || transferredBytes.reduce((total,content)=>total+content.length,0)>this.limits.maxTotalResourceBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','Remapped visualize resources exceed transfer budget');
    try {
      for(let i=0;i<bundle.resources.length;i++) {
        const r=bundle.resources[i]!,page=pages.get(key(r.resourceId,r.version));
        const content=transferredBytes[i]!;
        blobs.push(await this.resources.prepareBytes(content,r.mime,page || forms.has(key(r.resourceId,r.version)) ? undefined : r.sha256));
      }
    } catch(error) {
      // A token cannot be returned on partial preparation failure. Retire the
      // already prepared generations durably before attempting physical cleanup.
      atomic(this.graphs.db,()=>{for(const blob of blobs)this.resources.discardPrepared(blob);});
      for(const blob of blobs) {
        try {
          await this.resources.blobs.remove(blob.path);
          atomic(this.graphs.db,()=>this.graphs.db.prepare('UPDATE resource_file_deletions SET completed=1 WHERE path=?').run(blob.path));
        } catch {} // Explicit file tombstone remains pending for Resources cleanup.
      }
      throw error;
    }
    const token=Object.freeze({digest,...stableScope});this.prepared.set(token,{bundle,blobs,resourceMap,trustedTopology,disposed:false,disposal:null});return token;
  }
  /** Call from API finally AFTER the surrounding authorization transaction settles,
   * on success, failure and replay. No active session/project access is needed to
   * release this instance-owned token. Durable tombstones fence late commits;
   * deletion failure remains queued for Resources cleanup, never an orphan scan. */
  async disposePreparedImport(token: PreparedGraphImport): Promise<DisposedGraphImport> {
    this.outside();
    const data=this.prepared.get(token);if(!data) invalid('Invalid prepared graph import');
    if(data.disposal) return data.disposal;
    data.disposed=true;
    const work=async():Promise<DisposedGraphImport>=>{
      const retired:PreparedBlob[]=[];
      const result:DisposedGraphImport={retired:0,retained:0,removed:0,failed:0};
      atomic(this.graphs.db,()=>{
        for(const blob of data.blobs) {
          // Skip the live physical mapping even if this import just committed it.
          if(this.resources.discardPrepared(blob)) retired.push(blob);else result.retained++;
        }
      });
      result.retired=retired.length;
      for(const blob of retired) {
        try {
          await this.resources.blobs.remove(blob.path);
          atomic(this.graphs.db,()=>this.graphs.db.prepare('UPDATE resource_file_deletions SET completed=1 WHERE path=?').run(blob.path));
          result.removed++;
        } catch {result.failed++;} // Remains durable and retryable by normal resource cleanup.
      }
      return result;
    };
    const disposal=work();data.disposal=disposal;
    try {return await disposal;}catch(error){data.disposal=null;throw error;}
  }
  /** Recheck auth outside this helper, in the same surrounding transaction as this synchronous commit. */
  commitImport(scope: Scope, token: PreparedGraphImport, options: {idempotencyKey: string; principal?: string}): ImportedGraphSnapshot {
    const data=this.prepared.get(token);
    if(!data||data.disposed||scope.serviceId!==token.serviceId||scope.projectId!==token.projectId) invalid('Invalid or disposed prepared graph import');
    return atomic(this.graphs.db,()=>{
      this.target(scope);
      return this.graphs.repo.idempotent((options.principal??'local')+':graph.import:'+scope.projectId,options.idempotencyKey,{digest:token.digest,trustedTopology:data.trustedTopology},()=>{
        const graphId=randomUUID(),target={...scope,graphId};
        const existingTitles=this.graphs.db.prepare('SELECT title FROM graphs WHERE project_id=?').all(scope.projectId).map(row=>String(row['title']));
        const graphTitle=importedGraphTitle(data.bundle.graph.title,existingTitles);
        this.graphs.db.prepare('INSERT INTO graphs(id,project_id,title) VALUES(?,?,?)').run(graphId,scope.projectId,graphTitle);
        const ids=new Map<string,string>(),resourceIds=new Map<string,{id:string;bytes:number;mime:string}>();
        for(const n of data.bundle.graph.nodes) ids.set(n.id,randomUUID());
        for(let i=0;i<data.bundle.resources.length;i++) {
          const r=data.bundle.resources[i]!;const resource=commitTransferResource(this.resources,target,data.blobs[i]!,r.name,data.resourceMap.get(key(r.resourceId,r.version))!.resourceId);
          resourceIds.set(key(r.resourceId,r.version),{id:resource.id,bytes:resource.current.bytes,mime:resource.current.mime});
        }
        const remap=(value:Json):Json=>{
          if(Array.isArray(value)) return value.map(remap);
          if(value===null||typeof value!=='object') return value;
          const result:Record<string,Json>={};for(const [k,v] of Object.entries(value))result[k]=remap(v);
          if(typeof value['resourceId']==='string') {
            const v=value['resourceVersion']??value['version'];const mapped=resourceIds.get(key(value['resourceId'],v as number));if(!mapped) invalid('Missing resource remapping');
            result['resourceId']=mapped.id;result['bytes']=mapped.bytes;result['mime']=mapped.mime;if(Object.hasOwn(value,'resourceVersion'))result['resourceVersion']=1;if(Object.hasOwn(value,'version'))result['version']=1;
          }
          return result;
        };
        const copiedProvenance:CopiedProvenance[]=(data.bundle.copiedProvenance??[]).map(p=>p.kind==='copied-delivery'?{...p,sourceId:ids.get(p.sourceId)!,targetId:ids.get(p.targetId)!}:{...p,nodeId:ids.get(p.nodeId)!});
        const edgeIds=new Map(data.bundle.graph.edges.map(edge=>[edge.id,randomUUID()]));
        for(const n of data.bundle.graph.nodes) {
          const nodeId=ids.get(n.id)!,content=n.type==='visualize' ? remapVisualizeContent(n.content,data.resourceMap,edgeIds) : remap(n.content);
          if (core.has(n.type) && record(content) && record(content.visualizeSource) &&
              typeof content.visualizeSource.nodeId === 'string' && ids.has(content.visualizeSource.nodeId))
            content.visualizeSource.nodeId = ids.get(content.visualizeSource.nodeId)!;
          // Public import copies content, not publication privileges. Preserve
          // source runtime identifiers only as explicitly non-authoritative data.
          if(!data.trustedTopology&&core.has(n.type)&&content!==null&&typeof content==='object'&&!Array.isArray(content)) {
            const metadata:Record<string,Json>={};
            for(const field of ['runId','originRunId','outputKey']) if(Object.hasOwn(content,field)){metadata[field]=content[field]!;delete content[field];}
            if(n.readOnly)metadata['sourceReadOnly']=true;
            if(Object.keys(metadata).length)copiedProvenance.push({kind:'copied-node',nodeId,metadata,verified:false});
          }
          const node={...n,...(n.type==='group'?{memberIds:[]}:{}),id:nodeId,contentVersion:1,content,readOnly:!data.trustedTopology&&core.has(n.type)?false:n.readOnly};
          if(n.type==='visualize')insertTransferredVisualizeNode(this.graphs,target,node);
          else this.graphs.insertNode(target,node,true);
        }
        for(const n of data.bundle.graph.nodes)if(n.type==='group')this.graphs.setGroupMembers(target,ids.get(n.id)!, (n.memberIds??[]).map(id=>ids.get(id)!));
        for(const e of data.bundle.graph.edges) {
          if(e.kind==='delivery'&&!data.trustedTopology) {
            copiedProvenance.push({kind:'copied-delivery',sourceId:ids.get(e.sourceId)!,targetId:ids.get(e.targetId)!,verified:false});continue;
          }
          const edge={...e,id:edgeIds.get(e.id)!,sourceId:ids.get(e.sourceId)!,targetId:ids.get(e.targetId)!};this.graphs.validateEdge(target,edge,data.trustedTopology);
          this.graphs.db.prepare('INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,?)').run(edge.id,graphId,edge.sourceId,edge.targetId,edge.kind);
        }
        this.graphs.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('graph-import-requirements:'+graphId,JSON.stringify(data.bundle.pluginRequirements));
        this.graphs.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('graph-copied-provenance:'+graphId,JSON.stringify(copiedProvenance));
        this.graphs.event(target);return {...this.graphs.snapshot(target),copiedProvenance} as unknown as Json;
      }) as unknown as ImportedGraphSnapshot;
    });
  }
}
