import type { IncomingMessage } from 'node:http';
import type { SkillCatalog, SkillCatalogItem, SkillConfigurationWrite } from '@openworkgraph/protocol';
import type { WorkflowRuntime } from './runtime.js';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { ServiceError } from './errors.js';
import { readJson } from './http.js';
export class SkillsManagementApi {
  constructor(private readonly auth: Auth, private readonly runtime: WorkflowRuntime) {}
  private async decorate(item: SkillCatalogItem): Promise<SkillCatalogItem> {
    if (!item.installed) return item;
    const entry = await this.runtime.skills.packageMetadata(item.skillId,item.packageVersion);
    if (!entry.config.environment.length) return {...item,configuration:'none'};
    const config = await this.runtime.skillConfigs.read(item.skillId,entry.config);
    const ready = entry.config.environment.filter(field=>field.required).every(field=>config.values.some(value=>value.name===field.name && value.configured));
    return {...item,configuration:ready ? 'ready' : 'required'};
  }
  async handle(request: IncomingMessage, rawPath: string, token: string, origin: string): Promise<ApiResult> {
    const pathname = rawPath.split('?')[0]!;
    if (pathname !== '/v1/skills' && !pathname.startsWith('/v1/skills/')) return {handled:false};
    this.auth.withSession(token,origin,()=>undefined);
    const url = new URL(rawPath,'http://localhost');
    const match = /^\/v1\/skills(?:\/([^/]+)(?:\/(install|update|uninstall|config|files))?)?$/.exec(pathname);
    if (!match) throw new ServiceError('NOT_FOUND','技能管理接口不存在。');
    let id: string | undefined;
    if (match[1]) {
      try { id = decodeURIComponent(match[1]); } catch { throw new ServiceError('INVALID_REQUEST','技能身份编码无效。'); }
      if (!id || id.length > 1024 || /[\x00-\x1f\x7f]/.test(id)) throw new ServiceError('INVALID_REQUEST','技能身份无效。');
    }
    const action = match[2];
    const allowed = !id ? ['refresh','offset','limit','installed','query'] : !action ? ['locale'] : action === 'files' ? ['version','path'] : [];
    if ([...url.searchParams.keys()].some(key=>!allowed.includes(key) || url.searchParams.getAll(key).length!==1)) throw new ServiceError('INVALID_REQUEST','技能查询参数无效。');
    let result: unknown;
    if (request.method === 'GET' && !id) {
      if (url.searchParams.has('refresh') && url.searchParams.get('refresh') !== '1') throw new ServiceError('INVALID_REQUEST','refresh 必须为 1。');
      const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
        const raw = url.searchParams.get(name);
        if (raw === null) return fallback;
        const value = Number(raw);
        if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ServiceError('INVALID_REQUEST','技能分页参数无效。');
        return value;
      };
      const offset = integer('offset',0,0,Number.MAX_SAFE_INTEGER);
      const limit = integer('limit',100,1,offset === 0 ? 100 : 50);
      const installed = url.searchParams.get('installed');
      if (installed !== null && installed !== '1') throw new ServiceError('INVALID_REQUEST','installed 必须为 1。');
      if (installed && (url.searchParams.has('offset') || url.searchParams.has('limit'))) throw new ServiceError('INVALID_REQUEST','已安装技能列表不接受分页参数。');
      const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
      if (query.length > 1024) throw new ServiceError('INVALID_REQUEST','技能搜索内容过长。');
      // Installed browsing only reads the host's installation records and schemas.
      // Remote source availability must never delay this view, including refresh.
      const catalog: SkillCatalog = installed
        ? await this.runtime.skills.installedCatalog()
        : await this.runtime.skills.catalog(url.searchParams.get('refresh')==='1');
      const filtered = catalog.items.filter(item => (!installed || item.installed) && (item.name + ' ' + item.description).toLocaleLowerCase().includes(query));
      // Unpaged calls remain compatible with welcome setup and skill suggestions.
      const paged = !installed && (url.searchParams.has('offset') || url.searchParams.has('limit'));
      const items = paged ? filtered.slice(offset,offset + limit) : filtered;
      const installedSignature = JSON.stringify(catalog.items.filter(item=>item.installed).map(item=>[item.skillId,item.packageVersion,item.revision]).sort());
      result = {...catalog,installedSignature,total:filtered.length,...(paged && offset + items.length < filtered.length ? {nextOffset:offset + items.length} : {}),items:await Promise.all(items.map(async item=>{
        try { return await this.decorate(item); }
        catch { return {...item,error:'已安装技能或配置不可用，请检查工作空间。'}; }
      }))};
    } else if (request.method === 'GET' && id && !action) {
      const detail = await this.runtime.skills.detail(id,url.searchParams.get('locale') ?? 'en');
      result = {...detail,item:await this.decorate(detail.item)};
    } else if (request.method === 'GET' && id && action === 'files') {
      const version = url.searchParams.get('version'); const path = url.searchParams.get('path');
      if (!version || !path) throw new ServiceError('INVALID_REQUEST','技能资源需要固定版本与包内路径。');
      const bytes = await this.runtime.skills.readPackageFile(id,version,path);
      this.auth.withSession(token,origin,()=>undefined);
      const mime:Record<string,string> = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif'};
      const type = mime[path.split('.').pop()!.toLowerCase()];
      return {handled:true,binary:bytes,headers:{'Content-Type':type ?? 'application/octet-stream','Content-Disposition':(type ? 'inline' : 'attachment'),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}};
    } else if (id && action === 'config' && ['GET','PUT','DELETE'].includes(request.method ?? '')) {
      if (request.method === 'DELETE') {
        const body = await readJson(request,256*1024); this.revisionBody(body);
        this.auth.withSession(token,origin,()=>undefined);
        result = await this.runtime.skillConfigs.clear(id,body.expectedRevision as number);
      } else {
        if (request.method === 'GET') {
          const entry = await this.runtime.skills.packageMetadata(id);
          result = {...await this.runtime.skillConfigs.read(id,entry.config),packageVersion:entry.item.packageVersion};
        } else {
          const body = await readJson(request,256*1024);
          if (typeof body.expectedPackageVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedPackageVersion) || Object.keys(body).some(key=>!['expectedPackageVersion','expectedRevision','values'].includes(key))) throw new ServiceError('INVALID_REQUEST','保存技能配置需要固定的 expectedPackageVersion。');
          this.auth.withSession(token,origin,()=>undefined);
          const {expectedPackageVersion,...write} = body;
          result = await this.runtime.skills.withPackageEntry(id,expectedPackageVersion,async entry=>({
            ...await this.runtime.skillConfigs.write(id!,entry.config,write as unknown as SkillConfigurationWrite),packageVersion:entry.item.packageVersion,
          }));
        }
      }
    } else if (request.method === 'POST' && id && ['install','update','uninstall'].includes(action ?? '')) {
      const body = await readJson(request,16*1024); this.revisionBody(body);
      this.auth.withSession(token,origin,()=>undefined);
      const item = action === 'uninstall' ? await this.runtime.skills.uninstall(id,body.expectedRevision as number) : await this.runtime.skills.install(id,body.expectedRevision as number);
      result = await this.decorate(item);
    } else throw new ServiceError('NOT_FOUND','技能管理接口不存在。');
    this.auth.withSession(token,origin,()=>undefined);
    return {handled:true,body:result};
  }
  private revisionBody(body: Record<string,unknown>): void {
    if (Object.keys(body).length !== 1 || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<0) throw new ServiceError('INVALID_REQUEST','技能操作只接受有效的 expectedRevision。');
  }
}
