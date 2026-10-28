import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteGraph, GraphCommand, GraphHistoryTravel } from '@openworkgraph/protocol';
import { Auth } from './auth.js';
import { GraphQueries } from './graph-queries.js';
import { RunOutputsApi } from './run-outputs-api.js';
import { Graphs } from './graphs.js';
import { Events } from './events.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { ResourceApi } from './resource-api.js';
import { WorkflowRuntime } from './runtime.js';
import { RunApi } from './run-api.js';
import { AgentConfigurationApi } from './agents-api.js';
import { Backups } from './operations/backups.js';
import { BackupApi } from './backup-api.js';
import { TransferApi } from './transfer-api.js';
import { GraphTransfer } from './graph-transfer.js';
import { PluginApi } from './plugin-api.js';
import { PluginManagement } from './plugin-management.js';
import { Repositories } from './persistence/repositories.js';
import { atomic } from './persistence/database.js';
import { prepareDeletedOutputHistory } from './execution-output-history.js';
import { ProjectFilesApi } from './project-files-api.js';
import { SkillsApi } from './skills-api.js';
import { SkillsManagementApi } from './skills-management-api.js';
import { StorageApi } from './storage-api.js';
import { VisualizeApi } from './visualize-api.js';
import { VisualizeLibraryApi } from './visualize-library-api.js';
import { VisualizeLibrary } from './visualize-library.js';
import type { Json } from '@openworkgraph/protocol';
export interface ApiResult { handled:boolean; body?:unknown; status?:number; binary?:Buffer; binaryParts?:Uint8Array[]; headers?:Record<string,string> }
export class BusinessApi {
  readonly graphs:Graphs;
  private queries?:GraphQueries;
  private outputsApi?:RunOutputsApi;
  readonly resources:ResourceApi; readonly runApi:RunApi;
  readonly backups:Backups; readonly backupApi:BackupApi;
  private transferApi?:TransferApi;
  private pluginApi?:PluginApi;
  private projectFilesApi?:ProjectFilesApi;
  private skillsApi?:SkillsApi;
  private skillsManagementApi?:SkillsManagementApi;
  private storageApi?:StorageApi;
  private visualizeApi?:VisualizeApi;
  private visualizeLibraryApi?:VisualizeLibraryApi;
  private agentConfigurationApi?: AgentConfigurationApi;
  constructor(readonly db:DatabaseSync,readonly serviceId:string,readonly auth:Auth,readonly runtime:WorkflowRuntime){this.graphs=runtime.graphs;this.resources=new ResourceApi(runtime.resources,this.graphs,auth);this.runApi=new RunApi(runtime,auth);this.backups=new Backups(db,runtime.directories,{withBlobLease:work=>runtime.resources.withBlobLease(work)});this.backupApi=new BackupApi(this.backups,auth);}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    this.outputsApi??=new RunOutputsApi(this.runtime,this.auth);
    const outputs=await this.outputsApi.handle(request,path,token,origin);if(outputs.handled)return outputs;
    const query=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs(?:[/]([a-zA-Z0-9_-]+))?[/](query|summary|subgraph|nodes-query|node-content)$/.exec(path);
    if(query&&request.method==='POST'){
      this.auth.assertActive(token,origin);
      const body=await readJson(request,16*1024);
      this.queries??=new GraphQueries(this.graphs);
      return this.auth.withSession(token,origin,current=>{
        if(!query[2]&&query[3]==='query')return {handled:true,body:this.queries!.list(query[1]!,body,current.id)};
        if(!query[2]||query[3]==='query')throw new ServiceError('NOT_FOUND','Query route not found.');
        const kind=query[3]==='nodes-query'?'nodes':query[3]==='node-content'?'content':query[3] as 'summary'|'subgraph';
        return {handled:true,body:this.queries!.read({serviceId:this.serviceId,projectId:query[1]!,graphId:query[2]},kind,body,current.id)};
      });
    }
    this.visualizeLibraryApi??=new VisualizeLibraryApi(new VisualizeLibrary(this.graphs,this.runtime.resources),this.auth);
    const library=await this.visualizeLibraryApi.handle(request,path,token,origin);if(library.handled)return library;
    this.visualizeApi??=new VisualizeApi(this.runtime.visualize,this.auth,this.runtime.visualizeInputs,this.runtime.visualizeBridge);
    const visualize=await this.visualizeApi.handle(request,path,token,origin);if(visualize.handled)return visualize;
    this.storageApi??=new StorageApi(this.db,this.runtime.directories,this.runtime.resources,this.auth);
    const storage=await this.storageApi.handle(request,path,token,origin);if(storage.handled)return storage;
    this.skillsManagementApi??=new SkillsManagementApi(this.auth,this.runtime);
    const management=await this.skillsManagementApi.handle(request,path,token,origin);if(management.handled)return management;
    this.skillsApi??=new SkillsApi(this.db,this.auth,this.runtime);
    const skills=await this.skillsApi.handle(request,path,token,origin);if(skills.handled)return skills;
    this.projectFilesApi??=new ProjectFilesApi(this.db,this.auth,this.graphs,this.runtime.resources,this.runtime.directories.runs);
    const files=await this.projectFilesApi.handle(request,path,token,origin);if(files.handled)return files;
    const page=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]page$/.exec(path);
    if(page&&request.method==='POST'){
      this.auth.withSession(token,origin,()=>undefined);
      const body=await readJson(request,16*1024);
      return this.auth.withSession(token,origin,current=>{
        const result=this.graphs.page(page[1]!,body,current.id);
        // service.ts decorates the outer eventCursor; nested snapshots must also
        // carry session-bound cursors, never raw database sequence numbers.
        const events=new Events(this.db,this.serviceId,this.auth);
        return {handled:true,body:{...result,items:events.decorate(result.items,current.id)}};
      });
    }
    this.pluginApi??=new PluginApi(new PluginManagement(this.graphs,this.runtime.plugins),this.auth);
    const plugin=await this.pluginApi.handle(request,path,token,origin);if(plugin.handled)return plugin;
    this.transferApi??=new TransferApi(new GraphTransfer(this.graphs,this.runtime.resources),this.auth);
    const transfer=await this.transferApi.handle(request,path,token,origin);if(transfer.handled)return transfer;
    const backup=await this.backupApi.handle(request,path,token,origin);if(backup.handled)return backup;
    const resource=await this.resources.handle(request,path,token,origin);if(resource.handled)return resource;
    if (this.runtime.agentConfiguration && this.runtime.agentDiscovery) {
      this.agentConfigurationApi ??= new AgentConfigurationApi(this.runtime.agentConfiguration, this.runtime.agentDiscovery, this.auth, id => {
        const project = this.db.prepare('SELECT canonical_path,state FROM projects WHERE id=?').get(id);
        if (!project || project.state !== 'active') throw new ServiceError('NOT_FOUND', '项目不存在或不可用。');
        return String(project.canonical_path);
      });
      const agent = await this.agentConfigurationApi.handle(request, path, token, origin); if (agent.handled) return agent;
    }
    const run=await this.runApi.handle(request,path,token,origin);if(run.handled)return run;
    const match=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs(?:[/]([a-zA-Z0-9_-]+))?(?:[/](commands|history|all|archive|trash|restore|purge|permanent-delete))?$/.exec(path);
    if(!match)return {handled:false};
    this.auth.withSession(token,origin,()=>undefined);
    const body=request.method==='POST'?await readJson(request,16*1024*1024):undefined;
    if(request.method==='POST'&&match[2]&&match[3]==='commands'&&body){
      if(Object.keys(body).some(key=>!['idempotencyKey','expectedExecutionRevision','expectedLayoutRevision','operations','responseMode'].includes(key)))throw new ServiceError('INVALID_REQUEST','图命令包含未知字段。');
      if(body.responseMode!==undefined&&body.responseMode!=='compact')throw new ServiceError('INVALID_REQUEST','Invalid responseMode.');
      const command={...body,serviceId:this.serviceId,projectId:match[1]!,graphId:match[2]} as unknown as GraphCommand;
      if(typeof command.idempotencyKey!=='string'||!Number.isSafeInteger(command.expectedExecutionRevision)||!Number.isSafeInteger(command.expectedLayoutRevision)||!Array.isArray(command.operations)||!command.operations.length||command.operations.length>1000||command.operations.some(op=>!op||typeof op!=='object'))throw new ServiceError('INVALID_REQUEST','图命令需要幂等键、整数版本和有效操作。');
      const replay=()=>this.auth.withSession(token,origin,current=>new Repositories(this.db).replay(current.id+':graph.command:'+command.graphId,command.idempotencyKey,command as unknown as Json));
      const prior=replay();
      if(prior!==undefined){
        await this.runtime.resources.drainFileDeletions();await this.runtime.graphFiles.drain();
        this.auth.assertActive(token,origin);return {handled:true,body:prior};
      }
      const cleanups:(()=>unknown)[]=[];
      try {
        const preserve=command.operations.some(op=>op.type==='node.delete')
          ?await prepareDeletedOutputHistory(this.graphs,this.runtime.resources,command,cleanups):undefined;
        const snapshot=this.auth.withSession(token,origin,current=>{
          const result=command.responseMode==='compact'?this.graphs.commandReceipt(command,current.id,preserve):this.graphs.command(command,current.id,preserve);
          this.runtime.resources.collectGarbage();return result;
        });
        return {handled:true,body:snapshot};
      } catch(error) {
        const duplicate=replay();if(duplicate!==undefined)return {handled:true,body:duplicate};throw error;
      } finally {
        if(cleanups.length)atomic(this.db,()=>{for(const cleanup of cleanups)cleanup();});
        await this.runtime.resources.drainFileDeletions();await this.runtime.graphFiles.drain();
        this.auth.assertActive(token,origin);
      }
    }
    const result=this.auth.withSession(token,origin,current=>{
      const projectId=match[1]!,graphId=match[2],action=match[3];
      if(request.method==='GET'&&!graphId)return {handled:true,body:this.graphs.list(projectId)};
      if(request.method==='GET'&&graphId==='all')return {handled:true,body:this.graphs.list(projectId,true,true)};
      if(request.method==='GET'&&graphId==='trash'&&!action)return {handled:true,body:this.graphs.list(projectId,true,true,true)};
      if(request.method==='GET'&&graphId&&!action)return {handled:true,body:this.graphs.snapshot({serviceId:this.serviceId,projectId,graphId})};
      if(request.method==='POST'&&!graphId&&body){
        if(Object.keys(body).some(key=>!['title','idempotencyKey'].includes(key))||typeof body['title']!=='string'||typeof body['idempotencyKey']!=='string')throw new ServiceError('INVALID_REQUEST','建图请求须包含 title 和 idempotencyKey。');
        return {handled:true,body:this.graphs.create(projectId,body['title'],body['idempotencyKey'],current.id)};
      }
      if(request.method==='POST'&&graphId&&action==='permanent-delete'&&body){
        if(Object.keys(body).some(key=>!['idempotencyKey','expectedExecutionRevision','expectedLayoutRevision','confirmTitle'].includes(key))||typeof body['idempotencyKey']!=='string')throw new ServiceError('INVALID_REQUEST','无效的彻底删除请求。');
        return {handled:true,body:this.graphs.permanentDelete({...body,serviceId:this.serviceId,projectId,graphId} as unknown as DeleteGraph,this.runtime.resources,current.id)};
      }
      if(request.method==='POST'&&graphId&&action&&['archive','trash','restore','purge'].includes(action)&&body){
        const allowed=action==='purge'?['idempotencyKey','expectedExecutionRevision','confirmationTitle']:['idempotencyKey','expectedExecutionRevision'];
        if(Object.keys(body).some(key=>!allowed.includes(key))||typeof body['idempotencyKey']!=='string'||!Number.isSafeInteger(body['expectedExecutionRevision'])||Number(body['expectedExecutionRevision'])<0||(action==='purge'&&typeof body['confirmationTitle']!=='string'))throw new ServiceError('INVALID_REQUEST','生命周期请求需要幂等键、执行版本；彻底删除还需 confirmationTitle。');
        const scope={serviceId:this.serviceId,projectId,graphId};
        const value=new Repositories(this.db).idempotent(current.id+':graph.lifecycle:'+graphId,body['idempotencyKey'],{...body,...scope,action} as Json,()=>{
          const snapshot=this.graphs.snapshot(scope);
          const base={...scope,idempotencyKey:body['idempotencyKey'] as string,expectedExecutionRevision:body['expectedExecutionRevision'] as number,expectedLayoutRevision:snapshot.layoutRevision};
          if(action==='purge')return this.graphs.permanentDelete({...base,confirmTitle:body['confirmationTitle'] as string},this.runtime.resources,current.id);
          const operation:GraphCommand['operations'][number]=action==='archive'?{type:'graph.archive',archived:true}:action==='trash'?{type:'graph.trash',trashed:true}:snapshot.trashed?{type:'graph.trash',trashed:false}:{type:'graph.archive',archived:false};
          return this.graphs.command({...base,operations:[operation]},current.id) as unknown as Json;
        });
        return {handled:true,body:value};
      }
      if(request.method==='POST'&&graphId&&action==='history'&&body){
        if(Object.keys(body).some(key=>!['idempotencyKey','expectedExecutionRevision','expectedLayoutRevision','expectedCursor','direction'].includes(key))||typeof body['idempotencyKey']!=='string')throw new ServiceError('INVALID_REQUEST','无效的历史恢复请求。');
        const snapshot=this.graphs.history.travel({...body,serviceId:this.serviceId,projectId,graphId} as unknown as GraphHistoryTravel,current.id);
        this.runtime.resources.collectGarbage();
        return {handled:true,body:snapshot};
      }
      throw new ServiceError('NOT_FOUND','图接口不存在。');
    });
    if(request.method==='POST'){await this.runtime.resources.drainFileDeletions();await this.runtime.graphFiles.drain();}
    return result;
  }
}
