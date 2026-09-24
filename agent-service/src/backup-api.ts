import type {IncomingMessage} from 'node:http';
import type {ApiResult} from './api.js';
import {Auth} from './auth.js';
import {Backups} from './operations/backups.js';
import {readJson} from './http.js';
import {ServiceError} from './errors.js';
import {createHash} from 'node:crypto';
export class BackupApi {
  constructor(readonly backups:Backups,readonly auth:Auth){}
  async handle(request:IncomingMessage,path:string,token:string,origin:string):Promise<ApiResult>{
    if(path==='/v1/restore-guidance'&&request.method==='GET')return this.auth.withSession(token,origin,()=>({handled:true,body:{localOnly:true,command:'openworkgraph restore apply <backup-path> --sha256 <verified-sha256> --data-dir <service-data-dir>'}}));
    const match=/^[/]v1[/]backups(?:[/]([a-f0-9]{64})[/](download))?$/.exec(path);if(!match)return {handled:false};
    const principal=this.auth.withSession(token,origin,s=>s.id);
    if(request.method==='GET'){
      if(match[1]){const value=await this.backups.readDownload(match[1]);return this.auth.withSession(token,origin,()=>({handled:true,binary:value.body,headers:{'Content-Type':value.contentType,'Content-Length':String(value.body.length),'Content-Disposition':'attachment; filename="'+value.filename+'"'}}));}
      const value=await this.backups.list();return this.auth.withSession(token,origin,()=>({handled:true,body:value}));
    }
    if(request.method==='POST'&&!match[1]){
      const body=await readJson(request);if(Object.keys(body).length!==1||typeof body.idempotencyKey!=='string'||!body.idempotencyKey||body.idempotencyKey.length>256)throw new ServiceError('INVALID_REQUEST','备份需要幂等键。');
      this.auth.withSession(token,origin,()=>undefined);
      const key=createHash('sha256').update(principal+':'+body.idempotencyKey).digest('hex');
      const value=await this.backups.create(key);return this.auth.withSession(token,origin,()=>({handled:true,body:value}));
    }
    throw new ServiceError('NOT_FOUND','备份接口不存在。');
  }
}
