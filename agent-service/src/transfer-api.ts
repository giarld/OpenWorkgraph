import type {IncomingMessage} from 'node:http';
import type {ApiResult} from './api.js';
import {Auth} from './auth.js';
import {GraphTransfer} from './graph-transfer.js';
import {readJson} from './http.js';
import {ServiceError} from './errors.js';
import {GRAPH_BINARY_MIME, GRAPH_METADATA_MAX_BYTES, graphBinaryParts, readGraphBinary, jsonByteLength, WORKGRAPH_TRANSFER_TOTAL_BYTES} from '@openworkgraph/protocol';
export class TransferApi {
  constructor(readonly transfer:GraphTransfer,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    const match=/^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/](import|[a-zA-Z0-9_-]+[/](?:export|copied-provenance))$/.exec(path);if(!match)return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id),scope={serviceId:this.transfer.graphs.serviceId,projectId:match[1]!};
    if(request.method==='GET'&&match[2]!=='import'){
      if(match[2]!.endsWith('/copied-provenance'))return this.auth.withSession(token,origin,()=>({handled:true,body:this.transfer.getCopiedProvenance({...scope,graphId:match[2]!.split('/')[0]!})}));
      const value=await this.transfer.exportGraph({...scope,graphId:match[2]!.split('/')[0]!});
      if(request.headers.accept === GRAPH_BINARY_MIME) {
        const binaryParts = graphBinaryParts(value);
        return this.auth.withSession(token,origin,()=>({handled:true,binaryParts,headers:{'Content-Type':GRAPH_BINARY_MIME,'Content-Length':String(binaryParts.reduce((sum,part)=>sum+part.length,0))}}));
      }
      if(jsonByteLength(value) > GRAPH_METADATA_MAX_BYTES) throw new ServiceError('PAYLOAD_TOO_LARGE','大工作图需要二进制传输，请更新 Web 客户端后重试。');
      return this.auth.withSession(token,origin,()=>({handled:true,body:value}));
    }
    if(request.method==='POST'&&match[2]==='import'){
      let body: Record<string,unknown>;
      if(request.headers['content-type'] === GRAPH_BINARY_MIME) {
        if(request.headers['content-encoding']) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','不支持压缩的工作图传输请求。');
        if(Number(request.headers['content-length'] ?? 0) > WORKGRAPH_TRANSFER_TOTAL_BYTES + 8) throw new ServiceError('PAYLOAD_TOO_LARGE','工作图导入不能超过 1 GB。');
        try { body = await readGraphBinary(request); }
        catch { throw new ServiceError('INVALID_REQUEST','工作图二进制资源不完整、格式无效或超过大小限制。'); }
      } else body=await readJson(request,Math.min(this.transfer.limits.maxBundleBytes + 4096,GRAPH_METADATA_MAX_BYTES));
      if(Object.keys(body).some(k=>!['bundle','idempotencyKey'].includes(k))||typeof body.idempotencyKey!=='string'||!body.idempotencyKey||body.idempotencyKey.length>256)throw new ServiceError('INVALID_REQUEST','导入需要图包和幂等键。');
      this.auth.withSession(token,origin,()=>undefined);
      const prepared=await this.transfer.prepareImport(scope,body.bundle);
      try {return this.auth.withSession(token,origin,()=>({handled:true,body:this.transfer.commitImport(scope,prepared,{idempotencyKey:body.idempotencyKey as string,principal})}));}
      finally {await this.transfer.disposePreparedImport(prepared);}
    }
    throw new ServiceError('NOT_FOUND','图传输接口不存在。');
  }
}
