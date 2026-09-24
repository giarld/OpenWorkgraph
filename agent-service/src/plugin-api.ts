import type {IncomingMessage} from 'node:http';
import type {PluginNodeChange,PluginNodeMigration} from './plugin-management.js';
import type {ApiResult} from './api.js';
import {Auth} from './auth.js';
import {PluginManagement} from './plugin-management.js';
import {readJson} from './http.js';
import {ServiceError} from './errors.js';
export class PluginApi {
  constructor(readonly plugins:PluginManagement,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const match=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]nodes[/]([a-zA-Z0-9_-]+)[/](plugin|restore-plugin|migrate-plugin|versions[/][1-9][0-9]*)$/.exec(path);
    if(!match)return {handled:false};
    this.auth.withSession(token,origin,()=>undefined);
    const scope={serviceId:this.plugins.graphs.serviceId,projectId:match[1]!,graphId:match[2]!},nodeId=match[3]!,action=match[4]!;
    const body=request.method==='POST'?await readJson(request):{};
    return this.auth.withSession(token,origin,current=>{
      this.plugins.graphs.scope(scope);
      if(request.method==='GET'&&action.startsWith('versions/'))return {handled:true,body:this.plugins.readVersion(scope,nodeId,Number(action.split('/')[1]))};
      if(request.method==='GET'&&action==='plugin'){
        const node=this.plugins.graphs.snapshot(scope).nodes.find(n=>n.id===nodeId);if(!node)throw new ServiceError('NOT_FOUND','节点不存在。');
        return {handled:true,body:this.plugins.registry.inspect(node.type,node.schemaVersion,node.content)};
      }
      if(request.method==='POST'&&['restore-plugin','migrate-plugin'].includes(action)){
        const keys=['expectedExecutionRevision','expectedContentVersion','expectedSchemaVersion','idempotencyKey',...(action==='migrate-plugin'?['toSchemaVersion']:[])];
        if(Object.keys(body).some(k=>!keys.includes(k)))throw new ServiceError('INVALID_REQUEST','插件变更包含未知字段。');
        const input={...body,...scope,nodeId};
        return {handled:true,body:action==='restore-plugin'?this.plugins.restoreNode(input as PluginNodeChange,current.id):this.plugins.migrateNode(input as PluginNodeMigration,current.id)};
      }
      throw new ServiceError('NOT_FOUND','插件节点接口不存在。');
    });
  }
}
