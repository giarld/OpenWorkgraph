import type {IncomingMessage} from 'node:http';
import type {ApiResult} from './api.js';
import {Auth} from './auth.js';
import {GraphTransfer} from './graph-transfer.js';
import {readJson} from './http.js';
import {ServiceError} from './errors.js';
export class TransferApi {
  constructor(readonly transfer:GraphTransfer,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const match=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/](import|[a-zA-Z0-9_-]+[/](?:export|copied-provenance))$/.exec(path);if(!match)return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id),scope={serviceId:this.transfer.graphs.serviceId,projectId:match[1]!};
    if(request.method==='GET'&&match[2]!=='import'){
      if(match[2]!.endsWith('/copied-provenance'))return this.auth.withSession(token,origin,()=>({handled:true,body:this.transfer.getCopiedProvenance({...scope,graphId:match[2]!.split('/')[0]!})}));
      const value=await this.transfer.exportGraph({...scope,graphId:match[2]!.split('/')[0]!});
      return this.auth.withSession(token,origin,()=>({handled:true,body:value}));
    }
    if(request.method==='POST'&&match[2]==='import'){
      const body=await readJson(request,96*1024*1024);
      if(Object.keys(body).some(k=>!['bundle','idempotencyKey'].includes(k))||typeof body.idempotencyKey!=='string'||!body.idempotencyKey||body.idempotencyKey.length>256)throw new ServiceError('INVALID_REQUEST','导入需要图包和幂等键。');
      this.auth.withSession(token,origin,()=>undefined);
      const prepared=await this.transfer.prepareImport(scope,body.bundle);
      try {return this.auth.withSession(token,origin,()=>({handled:true,body:this.transfer.commitImport(scope,prepared,{idempotencyKey:body.idempotencyKey as string,principal})}));}
      finally {await this.transfer.disposePreparedImport(prepared);}
    }
    throw new ServiceError('NOT_FOUND','图传输接口不存在。');
  }
}
