import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteGraph, GraphCommand, GraphHistoryTravel } from '@openworkgraph/protocol';
import { Auth } from './auth.js';
import { Graphs } from './graphs.js';
import { Events } from './events.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { ResourceApi } from './resource-api.js';
import { WorkflowRuntime } from './runtime.js';
import { RunApi } from './run-api.js';
import { Backups } from './operations/backups.js';
import { BackupApi } from './backup-api.js';
import { TransferApi } from './transfer-api.js';
import { GraphTransfer } from './graph-transfer.js';
import { PluginApi } from './plugin-api.js';
import { PluginManagement } from './plugin-management.js';
import { Repositories } from './persistence/repositories.js';
import { ProjectFilesApi } from './project-files-api.js';
import type { Json } from '@openworkgraph/protocol';
export interface ApiResult { handled:boolean; body?:unknown; status?:number; binary?:Buffer; headers?:Record<string,string> }
export class BusinessApi {
  readonly graphs:Graphs;
  readonly resources:ResourceApi; readonly runApi:RunApi;
  readonly backups:Backups; readonly backupApi:BackupApi;
  private transferApi?:TransferApi;
  private pluginApi?:PluginApi;
  private projectFilesApi?:ProjectFilesApi;
  constructor(readonly db:DatabaseSync,readonly serviceId:string,readonly auth:Auth,readonly runtime:WorkflowRuntime){this.graphs=runtime.graphs;this.resources=new ResourceApi(runtime.resources,this.graphs,auth);this.runApi=new RunApi(runtime,auth);this.backups=new Backups(db,runtime.directories,{withBlobLease:work=>runtime.resources.withBlobLease(work)});this.backupApi=new BackupApi(this.backups,auth);}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
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
    const run=await this.runApi.handle(request,path,token,origin);if(run.handled)return run;
    const match=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs(?:[/]([a-zA-Z0-9_-]+))?(?:[/](commands|history|all|archive|trash|restore|purge|permanent-delete))?$/.exec(path);
    if(!match)return {handled:false};
    this.auth.withSession(token,origin,()=>undefined);
    const body=request.method==='POST'?await readJson(request,16*1024*1024):undefined;
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
      if(request.method==='POST'&&graphId&&action==='commands'&&body){
        if(Object.keys(body).some(key=>!['idempotencyKey','expectedExecutionRevision','expectedLayoutRevision','operations'].includes(key)))throw new ServiceError('INVALID_REQUEST','图命令包含未知字段。');
        const command={...body,serviceId:this.serviceId,projectId,graphId} as unknown as GraphCommand;
        if(typeof command.idempotencyKey!=='string'||!Number.isSafeInteger(command.expectedExecutionRevision)||!Number.isSafeInteger(command.expectedLayoutRevision))throw new ServiceError('INVALID_REQUEST','图命令需要幂等键和整数版本。');
        const snapshot=this.graphs.command(command,current.id);this.runtime.resources.collectGarbage();return {handled:true,body:snapshot};
      }
      throw new ServiceError('NOT_FOUND','图接口不存在。');
    });
    if(request.method==='POST'){await this.runtime.resources.drainFileDeletions();await this.runtime.graphFiles.drain();}
    return result;
  }
}
