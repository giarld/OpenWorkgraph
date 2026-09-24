import type { DatabaseSync } from 'node:sqlite';
import type { ImageProvider, ImageProviderModel } from '@openworkgraph/protocol';
import { atomic } from './persistence/database.js';
import { ServiceError } from './errors.js';
import { ImageCredentials } from './image-credentials.js';
import { isPrivateNetworkHost } from './network.js';

const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ServiceError('INVALID_REQUEST','服务商或模型 ID 无效。');
  return value;
};
const modelIdentity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) || value==='.' || value==='..' || value.startsWith('/') || value.endsWith('/') || value.includes('//')) throw new ServiceError('INVALID_REQUEST','图片模型 ID 无效。');
  return value;
};
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 150) throw new ServiceError('INVALID_REQUEST','显示名称无效。');
  return value.trim();
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) throw new ServiceError('INVALID_REQUEST','配置修订号无效。');
  return value as number;
};
function endpoint(value: unknown): string {
  if (typeof value !== 'string') throw new ServiceError('INVALID_REQUEST','服务商地址无效。');
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError('INVALID_REQUEST','服务商地址无效。'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isPrivateNetworkHost(url.hostname))) || url.username || url.password || url.search || url.hash || url.port === '0') throw new ServiceError('INVALID_REQUEST','服务商地址必须是 HTTPS；局域网或回环 IP 地址可使用 HTTP，且不得含凭据、查询或片段。');
  const path = url.pathname.replace(/\/+$/, '');
  return url.origin + (path && path !== '/' ? path : '');
}
function choices(value: unknown, allowed: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 30 || value.some(item => typeof item !== 'string' || !allowed.includes(item)) || new Set(value).size !== value.length) throw new ServiceError('INVALID_REQUEST',field + ' 能力列表无效。');
  return value as string[];
}
export interface ProviderConfig { id: string; name: string; driver: 'openai'; endpoint: string; enabled: boolean }
export interface ModelConfig { id: string; name: string; modes: ImageProviderModel['modes']; formats: ImageProviderModel['formats']; sizes: string[]; qualities: string[]; isDefault: boolean }
export interface DiscoveredModel { id: string; name: string }
export interface FrozenProviderConfig { endpoint: string; driver: 'openai'; model: ImageProviderModel }

function inferredModel(model: DiscoveredModel, isDefault: boolean): ModelConfig {
  const id=modelIdentity(model.id),name=label(model.name);
  if(id==='dall-e-2')return {id,name,modes:['text','image'],formats:['png'],sizes:['256x256','512x512','1024x1024'],qualities:['auto'],isDefault};
  if(id==='dall-e-3')return {id,name,modes:['text'],formats:['png'],sizes:['1024x1024','1792x1024','1024x1792'],qualities:['auto','high'],isDefault};
  return {id,name,modes:['text','text_image'],formats:['png','jpeg','webp'],sizes:['auto','1024x1024','1536x1024','1024x1536'],qualities:['auto','high','medium','low'],isDefault};
}

/** Public directory only: no credential value and no inferred model availability. */
export class ImageProviders {
  private readonly configured = new Set<string>();
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly db: DatabaseSync, readonly credentials?: ImageCredentials) {}
  async refreshCredentials(): Promise<void> {
    this.configured.clear();
    for (const row of this.db.prepare('SELECT id,credential_revision FROM image_providers WHERE deleted=0 AND credential_revision IS NOT NULL').all()) {
      if (await this.credentials?.read(String(row.id), Number(row.credential_revision))) this.configured.add(String(row.id));
    }
  }
  credentialAvailable(providerId: string, revision: number): boolean {
    const row = this.db.prepare('SELECT 1 FROM image_provider_revoked_credentials WHERE provider_id=? AND revision=?').get(identity(providerId),revision);
    return !row && this.configured.has(providerId);
  }
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => {});
    return next;
  }
  async setCredential(providerId: string, value: string, expected: unknown): Promise<ImageProvider> {
    const id = identity(providerId), prev = revision(expected);
    if(typeof value!=='string'||!value.trim()||value.length>16*1024||value.includes(String.fromCharCode(10))||value.includes(String.fromCharCode(13)))throw new ServiceError('INVALID_REQUEST','凭据格式无效。');
    if (!this.credentials) throw new ServiceError('MODEL_UNAVAILABLE', '本机凭据存储不可用。');
    return this.serialize(id, async () => {
      const before = this.db.prepare('SELECT revision,credential_counter,deleted FROM image_providers WHERE id=?').get(id);
      if (!before || before.deleted) throw new ServiceError('NOT_FOUND', '服务商不存在。');
      if (Number(before.revision) !== prev) throw new ServiceError('REVISION_CONFLICT', '服务商配置已变化，请刷新后重试。');
      const next = Number(before.credential_counter) + 1;
      await this.credentials!.store(id, next, value);
      try {
        const provider = atomic(this.db, () => {
          const changed = this.db.prepare('UPDATE image_providers SET credential_revision=?,credential_counter=?,revision=revision+1 WHERE id=? AND revision=? AND deleted=0').run(next,next,id,prev);
          if (!changed.changes) throw new ServiceError('REVISION_CONFLICT', '服务商配置已变化，请刷新后重试。');
          this.db.prepare('UPDATE image_provider_models SET verified_at=NULL WHERE provider_id=?').run(id);
          this.saveVersion(id);
          return this.get(id);
        });
        this.configured.add(id);
        return { ...provider, credentialConfigured: true };
      } catch (error) { await this.credentials!.revoke(id,next).catch(() => {}); throw error; }
    });
  }
  async revokeCredential(providerId: string, expected: unknown): Promise<ImageProvider> {
    const id = identity(providerId), prev = revision(expected);
    return this.serialize(id, async () => {
      const before = this.db.prepare('SELECT revision,credential_counter,deleted FROM image_providers WHERE id=?').get(id);
      if (!before || before.deleted) throw new ServiceError('NOT_FOUND', '服务商不存在。');
      if (Number(before.revision) !== prev) throw new ServiceError('REVISION_CONFLICT', '服务商配置已变化，请刷新后重试。');
      const count = Number(before.credential_counter);
      const provider = atomic(this.db, () => {
        for (let rev = 1; rev <= count; rev++) this.db.prepare('INSERT OR IGNORE INTO image_provider_revoked_credentials(provider_id,revision) VALUES(?,?)').run(id,rev);
        this.db.prepare('UPDATE image_providers SET credential_revision=NULL,revision=revision+1 WHERE id=? AND revision=?').run(id,prev);
        this.db.prepare('UPDATE image_provider_models SET verified_at=NULL WHERE provider_id=?').run(id);
        this.saveVersion(id);
        return this.get(id);
      });
      this.configured.delete(id);
      for (let rev = 1; rev <= count; rev++) await this.credentials?.revoke(id,rev).catch(() => {});
      return {...provider,credentialConfigured:false};
    });
  }
  /** Public config only. Previous accepted Runs can resolve this even after an edit or disable. */
  frozen(providerId: string, configRevision: number, modelId: string): FrozenProviderConfig {
    const row=this.db.prepare('SELECT payload FROM image_provider_config_versions WHERE provider_id=? AND revision=?').get(identity(providerId),configRevision);
    if(!row)throw new ServiceError('MODEL_UNAVAILABLE','冻结服务商配置版本不存在。');
    const payload=JSON.parse(String(row.payload)) as { endpoint:string; driver:'openai'; models:ImageProviderModel[] };
    const model=payload.models.find(item=>item.id===modelIdentity(modelId));
    if(!model)throw new ServiceError('MODEL_UNAVAILABLE','冻结配置中没有所选模型。');
    return {endpoint:payload.endpoint,driver:payload.driver,model:{...model,verifiedAt:null}};
  }
  private saveVersion(id: string): void {
    const provider=this.get(id);
    this.db.prepare('INSERT INTO image_provider_config_versions(provider_id,revision,payload) VALUES(?,?,?)').run(id,provider.revision,JSON.stringify({endpoint:provider.endpoint,driver:provider.driver,models:provider.models.map(({verifiedAt: _verifiedAt,...model})=>model)}));
  }
  list(): ImageProvider[] {
    const providers = this.db.prepare('SELECT * FROM image_providers WHERE deleted=0 ORDER BY id').all();
    return providers.map(row => {
      const models = this.db.prepare('SELECT * FROM image_provider_models WHERE provider_id=? ORDER BY id').all(String(row.id)).map(model => ({
        id:String(model.id), name:String(model.name), modes:JSON.parse(String(model.modes)),formats:JSON.parse(String(model.formats)),sizes:JSON.parse(String(model.sizes)),qualities:JSON.parse(String(model.qualities)),isDefault:Boolean(model.is_default),verifiedAt:model.verified_at===null?null:String(model.verified_at),
      })) as ImageProviderModel[];
      return {id:String(row.id),name:String(row.name),driver:'openai',endpoint:String(row.endpoint),enabled:Boolean(row.enabled),revision:Number(row.revision),credentialConfigured:this.configured.has(String(row.id)),credentialRevision:row.credential_revision===null?null:Number(row.credential_revision),models};
    });
  }
  private get(id: string): ImageProvider {
    const provider = this.list().find(item => item.id === id);
    if (!provider) throw new ServiceError('NOT_FOUND','生图服务商不存在。');
    return provider;
  }
  setProvider(raw: ProviderConfig, expected: unknown): ImageProvider {
    const id=identity(raw?.id), name=label(raw.name), target=endpoint(raw.endpoint), prev=revision(expected);
    if (raw.driver !== 'openai' || typeof raw.enabled !== 'boolean') throw new ServiceError('INVALID_REQUEST','服务商配置无效。');
    return atomic(this.db,()=>{
      const current=this.db.prepare('SELECT revision,deleted,endpoint FROM image_providers WHERE id=?').get(id);
      if (current?.deleted) throw new ServiceError('CONFLICT','已删除服务商不能重新使用原 ID。');
      if (current ? Number(current.revision)!==prev : prev!==0) throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
      if (current) this.db.prepare('UPDATE image_providers SET name=?,endpoint=?,enabled=?,revision=revision+1 WHERE id=? AND revision=?').run(name,target,Number(raw.enabled),id,prev);
      else this.db.prepare('INSERT INTO image_providers(id,name,driver,endpoint,enabled,revision) VALUES(?,?,?,?,?,1)').run(id,name,raw.driver,target,Number(raw.enabled));
      if(current && current.endpoint!==target)this.db.prepare('UPDATE image_provider_models SET verified_at=NULL WHERE provider_id=?').run(id);
      this.saveVersion(id);
      return this.get(id);
    });
  }
  deleteProvider(providerId:string,expected:unknown):void {
    const id=identity(providerId),prev=revision(expected);
    atomic(this.db,()=>{
      const row=this.db.prepare('SELECT revision,deleted FROM image_providers WHERE id=?').get(id);
      if(!row || row.deleted)throw new ServiceError('NOT_FOUND','生图服务商不存在。');
      if(Number(row.revision)!==prev)throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
      this.db.prepare('UPDATE image_providers SET deleted=1,enabled=0,revision=revision+1 WHERE id=? AND revision=?').run(id,prev);
      this.db.prepare('UPDATE image_provider_models SET verified_at=NULL WHERE provider_id=?').run(id);
    });
  }
  setModel(providerId: string, raw: ModelConfig, expected: unknown): ImageProvider {
    const id=identity(providerId), modelId=modelIdentity(raw?.id), name=label(raw.name), prev=revision(expected);
    const modes=choices(raw.modes,['text','image','text_image'],'输入模式');
    const formats=choices(raw.formats,['png','jpeg','webp'],'格式');
    const sizes=choices(raw.sizes,raw.sizes ?? [],'尺寸');
    const qualities=choices(raw.qualities,raw.qualities ?? [],'质量');
    if (sizes.some(item=>item.length>60)||qualities.some(item=>item.length>60)||typeof raw.isDefault!=='boolean') throw new ServiceError('INVALID_REQUEST','模型参数无效。');
    return atomic(this.db,()=>{
      const current=this.db.prepare('SELECT revision,deleted FROM image_providers WHERE id=?').get(id);
      if (!current||current.deleted) throw new ServiceError('NOT_FOUND','生图服务商不存在。');
      if (Number(current.revision)!==prev) throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
      if (raw.isDefault) this.db.prepare('UPDATE image_provider_models SET is_default=0 WHERE provider_id=?').run(id);
      // An edited capability or model identity loses any prior real verification.
      this.db.prepare('INSERT INTO image_provider_models(provider_id,id,name,modes,formats,sizes,qualities,is_default) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider_id,id) DO UPDATE SET name=excluded.name,modes=excluded.modes,formats=excluded.formats,sizes=excluded.sizes,qualities=excluded.qualities,is_default=excluded.is_default,verified_at=NULL').run(id,modelId,name,JSON.stringify(modes),JSON.stringify(formats),JSON.stringify(sizes),JSON.stringify(qualities),Number(raw.isDefault));
      this.db.prepare('UPDATE image_providers SET revision=revision+1 WHERE id=? AND revision=?').run(id,prev);
      this.saveVersion(id);
      return this.get(id);
    });
  }
  syncDiscoveredModels(providerId:string,discovered:DiscoveredModel[],expected:unknown):ImageProvider {
    const id=identity(providerId),prev=revision(expected);
    if(!Array.isArray(discovered)||discovered.length>1000)throw new ServiceError('INVALID_REQUEST','模型选择无效。');
    const unique=new Map<string,DiscoveredModel>();
    for(const item of discovered){const modelId=modelIdentity(item?.id),name=label(item?.name);if(unique.has(modelId))throw new ServiceError('INVALID_REQUEST','模型选择包含重复项。');unique.set(modelId,{id:modelId,name});}
    return atomic(this.db,()=>{
      const provider=this.db.prepare('SELECT revision,deleted FROM image_providers WHERE id=?').get(id);
      if(!provider||provider.deleted)throw new ServiceError('NOT_FOUND','生图服务商不存在。');
      if(Number(provider.revision)!==prev)throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
      const existing=this.db.prepare('SELECT * FROM image_provider_models WHERE provider_id=?').all(id);
      const currentDefault=existing.find(row=>Boolean(row.is_default)&&unique.has(String(row.id)));
      const defaultId=currentDefault?String(currentDefault.id):unique.keys().next().value as string|undefined;
      this.db.prepare('DELETE FROM image_provider_models WHERE provider_id=?').run(id);
      for(const item of unique.values()){
        const config=inferredModel(item,item.id===defaultId);
        const old=existing.find(row=>String(row.id)===config.id);
        const same=old&&String(old.name)===config.name&&String(old.modes)===JSON.stringify(config.modes)&&String(old.formats)===JSON.stringify(config.formats)&&String(old.sizes)===JSON.stringify(config.sizes)&&String(old.qualities)===JSON.stringify(config.qualities);
        this.db.prepare('INSERT INTO image_provider_models(provider_id,id,name,modes,formats,sizes,qualities,is_default,verified_at) VALUES(@provider,@id,@name,@modes,@formats,@sizes,@qualities,@isDefault,@verifiedAt)').run({provider:id,id:config.id,name:config.name,modes:JSON.stringify(config.modes),formats:JSON.stringify(config.formats),sizes:JSON.stringify(config.sizes),qualities:JSON.stringify(config.qualities),isDefault:Number(config.isDefault),verifiedAt:same?(old.verified_at??null):null});
      }
      this.db.prepare('UPDATE image_providers SET revision=revision+1 WHERE id=? AND revision=?').run(id,prev);
      this.saveVersion(id);
      return this.get(id);
    });
  }
  deleteModel(providerId:string,modelId:string,expected:unknown):ImageProvider {
    const id=identity(providerId),model=modelIdentity(modelId),prev=revision(expected);
    return atomic(this.db,()=>{
      const provider=this.db.prepare('SELECT revision,deleted FROM image_providers WHERE id=?').get(id);
      if(!provider || provider.deleted)throw new ServiceError('NOT_FOUND','服务商不存在。');
      if(Number(provider.revision)!==prev)throw new ServiceError('REVISION_CONFLICT','服务商配置已变化，请刷新后重试。');
      const removed=this.db.prepare('DELETE FROM image_provider_models WHERE provider_id=? AND id=?').run(id,model);
      if(!removed.changes)throw new ServiceError('NOT_FOUND','图片模型不存在。');
      this.db.prepare('UPDATE image_providers SET revision=revision+1 WHERE id=? AND revision=?').run(id,prev);
      this.saveVersion(id);
      return this.get(id);
    });
  }
}
