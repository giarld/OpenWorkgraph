import { isSkillName } from '@openworkgraph/protocol';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument } from 'yaml';
import type { SkillCatalog, SkillCatalogItem, SkillConfigSchema, SkillDetail, SkillSource } from '@openworkgraph/protocol';
import type { DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { parseSkillConfig } from './skill-schema.js';
import { DEFAULT_SKILL_SOURCE, GitHubSkillSource, SKILL_LIMITS, gitBlobSha, packageDigest, validatePackageFiles, safeSkillPath, type SkillSourcePackage, type SkillSourceProvider, type SkillSourceFile } from './skill-source.js';

export interface BuiltinSkillsOptions { root?: string; source?: SkillSource; provider?: SkillSourceProvider }
interface RemotePackage extends SkillSourcePackage { item: SkillCatalogItem; config?: SkillConfigSchema }
interface CatalogCache { source: SkillSource; fetchedAt: number; packages: RemotePackage[] }
interface InstallState { version: 1; items: Record<string, SkillCatalogItem> }
interface LockOwner {pid:number;hostname:string;token:string}
interface Manifest { version: 1; item: SkillCatalogItem; files: SkillSourceFile[]; installedAt: string }
const key = (id: string) => createHash('sha256').update(id).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
class SkillDeadline {
  private readonly expires: number;
  constructor(duration: number) { this.expires = Date.now() + duration; }
  check(): void { if (Date.now() >= this.expires) throw new ServiceError('CONFLICT','技能操作超过总时限，请稍后重试。',{retryable:true}); }
  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve,reject) => { timer = setTimeout(()=>reject(new ServiceError('CONFLICT','技能操作超过总时限，请稍后重试。',{retryable:true})),Math.max(1,this.expires-Date.now())); });
      const result = await Promise.race([work(),timeout]); this.check(); return result;
    } finally { if (timer) clearTimeout(timer); }
  }
}
export function parseSkillFrontmatter(text: string): {name: string; description: string} {
  if (Buffer.byteLength(text) > SKILL_LIMITS.metadataBytes) throw new ServiceError('INVALID_REQUEST', 'SKILL.md 超过大小限制。');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new ServiceError('INVALID_REQUEST', 'SKILL.md 缺少 YAML frontmatter。');
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw Error('yaml');
    const value = document.toJS({maxAliasCount: 32}) as Record<string, unknown>;
    if (!value || !isSkillName(value.name) || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 16_384) throw Error('metadata');
    return {name:value.name, description:value.description.trim()};
  } catch { throw new ServiceError('INVALID_REQUEST', 'SKILL.md 的名称或 YAML 简介无效。'); }
}
/** Shared packages, workspace-independent installation pointers, immutable versions. */
export class BuiltinSkills {
  readonly root: string;
  readonly source: SkillSource;
  private readonly provider: SkillSourceProvider;
  private ready?: Promise<void>;
  private refreshing: Promise<CatalogCache> | undefined;
  constructor(_directories: DataDirectories, _serviceId: string, options: BuiltinSkillsOptions = {}) {
    this.root = resolve(options.root ?? join(homedir(), '.openworkgraph', 'skills'));
    this.source = {...(options.source ?? DEFAULT_SKILL_SOURCE)};
    this.provider = options.provider ?? new GitHubSkillSource();
  }
  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await fs.mkdir(this.root, {recursive:true,mode:0o700});
      const stat = await fs.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServiceError('INVALID_REQUEST', '技能管理目录不能是链接。');
      await fs.chmod(this.root,0o700);
      await this.directory('versions'); await this.directory('staging');
    })();
  }
  private async checked(relative: string): Promise<string> {
    const parts = relative.split('/'); let path = this.root;
    const rootStat = await fs.lstat(path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ServiceError('INVALID_REQUEST', '技能管理目录无效。');
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) throw new ServiceError('INVALID_REQUEST','技能管理路径无效。');
      path = join(path,part);
      try { if ((await fs.lstat(path)).isSymbolicLink()) throw new ServiceError('INVALID_REQUEST','技能管理路径不能是链接。'); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    return path;
  }
  private async directory(relative: string): Promise<string> {
    const path = await this.checked(relative);
    await fs.mkdir(path,{recursive:true,mode:0o700});
    if (!(await fs.lstat(path)).isDirectory()) throw new ServiceError('INVALID_REQUEST','技能管理目录无效。');
    await fs.chmod(path,0o700); return path;
  }
  private async readJson<T>(relative: string): Promise<T | undefined> {
    try {
      const path = await this.checked(relative);
      if ((await fs.stat(path)).size > 16 * 1024 * 1024) throw new ServiceError('INVALID_REQUEST','技能管理记录过大。');
      return JSON.parse(await fs.readFile(path,'utf8')) as T;
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
  private async atomicJson(relative: string, value: unknown): Promise<void> {
    const target = await this.checked(relative); const temp = target + '.' + randomUUID() + '.tmp';
    try {
      const file = await fs.open(temp,'wx',0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temp,target);
      if (process.platform !== 'win32') { const parent = await fs.open(dirname(target),'r'); try { await parent.sync(); } finally { await parent.close(); } }
    }
    finally { await fs.rm(temp,{force:true}); }
  }
  private async state(): Promise<InstallState> {
    const value = await this.readJson<InstallState>('installed.json');
    if (!value) return {version:1,items:{}};
    if (value.version !== 1 || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) throw new ServiceError('INVALID_REQUEST','技能安装记录损坏。');
    for (const [id,item] of Object.entries(value.items)) if (item.skillId !== id || !Number.isSafeInteger(item.revision) || item.revision < 0 || (item.packageVersion && !/^[a-f0-9]{64}$/.test(item.packageVersion))) throw new ServiceError('INVALID_REQUEST','技能安装记录损坏。');
    return value;
  }
  private async claimLock(relative: string): Promise<boolean> {
    const target = await this.checked(relative);
    const parent = relative.includes('/') ? relative.slice(0,relative.lastIndexOf('/')) + '/' : '';
    const prepared = parent + '.owner-' + randomUUID();
    await this.directory(prepared);
    try {
      const owner: LockOwner = {pid:process.pid,hostname:hostname(),token:randomUUID()};
      await this.atomicJson(prepared + '/owner.json',owner);
      try { await fs.lstat(target); return false; }
      catch (error) { if (!isMissing(error)) throw error; }
      try { await fs.rename(await this.checked(prepared),target); return true; }
      catch (error) {
        if (['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          try { if ((await fs.lstat(target)).isDirectory()) return false; }
          catch (error) { if (isMissing(error)) return false; throw error; }
        }
        throw error;
      }
    } finally { await fs.rm(await this.checked(prepared),{recursive:true,force:true}); }
  }
  private async lockOwner(relative: string): Promise<LockOwner | undefined> {
    const owner = await this.readJson<LockOwner>(relative + '/owner.json');
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || typeof owner.hostname !== 'string') return undefined;
    return owner;
  }
  private deadOwner(owner: LockOwner): boolean {
    if (owner.hostname !== hostname()) return false;
    try { process.kill(owner.pid,0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  private async recoverLock(relative: string, depth = 0): Promise<boolean> {
    const owner = await this.lockOwner(relative);
    if (!owner || !this.deadOwner(owner) || depth > 4) return false;
    const recovery = relative + '/.recovery';
    try {
      if (!await this.claimLock(recovery)) { await this.recoverLock(recovery,depth+1); return false; }
    } catch (error) { if (isMissing(error)) return false; throw error; }
    let moved = false;
    try {
      const current = await this.lockOwner(relative);
      if (!current || current.token !== owner.token || !this.deadOwner(current)) return false;
      const retired = relative + '.retired-' + randomUUID();
      await fs.rename(await this.checked(relative),await this.checked(retired)); moved = true;
      await fs.rm(await this.checked(retired),{recursive:true,force:true}); return true;
    } finally { if (!moved) await fs.rm(await this.checked(recovery),{recursive:true,force:true}); }
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    await this.initialize(); const started = Date.now();
    for (;;) {
      if (await this.claimLock('installation.lock')) break;
      if (await this.recoverLock('installation.lock')) continue;
      if (Date.now()-started > 30_000) throw new ServiceError('CONFLICT','技能操作正在其他工作空间进行，或无法确认锁进程已退出，请稍后重试。',{retryable:true});
      await delay(50);
    }
    try {
      // Only the lock holder may clean interrupted downloads. Published versions are retained.
      for (const entry of await fs.readdir(await this.checked('staging'))) if (/^install-[a-f0-9-]+$/.test(entry)) await fs.rm(await this.checked('staging/' + entry),{recursive:true,force:true});
      return await work();
    } finally {
      const retired = 'installation.lock.retired-' + randomUUID();
      await fs.rename(await this.checked('installation.lock'),await this.checked(retired));
      await fs.rm(await this.checked(retired),{recursive:true,force:true});
    }
  }
  private async download(pkg: SkillSourcePackage, commitSha: string, file: SkillSourceFile, deadline?: SkillDeadline): Promise<Buffer> {
    const read = () => this.provider.read(this.source,commitSha,this.source.directory + '/' + pkg.directory + '/' + file.path);
    const bytes = Buffer.from(await (deadline ? deadline.wait(read) : read()));
    if (bytes.length !== file.size || bytes.length > SKILL_LIMITS.fileBytes || gitBlobSha(bytes) !== file.sha) throw new ServiceError('INVALID_REQUEST','技能文件大小或内容摘要校验失败。');
    return bytes;
  }
  private async metadata(pkg: SkillSourcePackage, commitSha: string, deadline: SkillDeadline): Promise<{name:string;description:string;config:SkillConfigSchema}> {
    validatePackageFiles(pkg);
    const read = async (name: string) => {
      const file = pkg.files.find(file => file.path === name)!;
      if (file.size > SKILL_LIMITS.metadataBytes) throw new ServiceError('INVALID_REQUEST','技能说明或配置超过大小限制。');
      return (await this.download(pkg,commitSha,file,deadline)).toString('utf8');
    };
    const [skill,config,readme] = await Promise.all([read('SKILL.md'),read('config.json'),read('README.md')]);
    if (!readme.trim()) throw new ServiceError('INVALID_REQUEST','技能包 README.md 不能为空。');
    return {...parseSkillFrontmatter(skill),config:parseSkillConfig(config)};
  }
  private refresh(): Promise<CatalogCache> {
    return this.refreshing ??= (async () => {
      const deadline = new SkillDeadline(SKILL_LIMITS.catalogMs);
      const snapshot = await deadline.wait(()=>this.provider.snapshot(this.source));
      if (!/^[a-f0-9]{40}$/.test(snapshot.commitSha) || snapshot.packages.length > 500) throw new ServiceError('INVALID_REQUEST','技能来源目录无效。');
      const packages: RemotePackage[] = []; const seen = new Set<string>();
      for (const pkg of snapshot.packages) {
        deadline.check();
        if (seen.has(pkg.directory)) throw new ServiceError('INVALID_REQUEST','技能来源含重复目录。'); seen.add(pkg.directory);
        const item: SkillCatalogItem = {skillId:this.source.id + ':' + pkg.directory,source:this.source,directory:pkg.directory,name:pkg.directory,description:'',installed:false,revision:0,packageVersion:packageDigest(pkg.files),commitSha:snapshot.commitSha,updateAvailable:false,configuration:'none'};
        try { const metadata = await this.metadata(pkg,snapshot.commitSha,deadline); item.name = metadata.name; item.description = metadata.description; item.configuration = metadata.config.environment.length ? 'required' : 'none'; packages.push({...pkg,item,config:metadata.config}); }
        catch (error) { item.error = error instanceof ServiceError ? error.message : '无法读取技能包，请刷新重试。'; packages.push({...pkg,item}); }
      }
      deadline.check();
      const cache = {source:this.source,fetchedAt:Date.now(),packages};
      await this.atomicJson('catalog-' + key(JSON.stringify(this.source)) + '.json',cache); return cache;
    })().finally(() => { this.refreshing = undefined; });
  }
  private async cached(refresh = false): Promise<{cache:CatalogCache | undefined;error?:string}> {
    await this.initialize(); const cache = await this.readJson<CatalogCache>('catalog-' + key(JSON.stringify(this.source)) + '.json');
    if (!refresh && cache && Date.now()-cache.fetchedAt < 5*60_000) return {cache};
    try { return {cache:await this.refresh()}; }
    catch (error) { return {cache,error:error instanceof ServiceError ? error.message : '技能来源暂时不可用，请检查网络后重试。'}; }
  }
  async catalog(refresh = false): Promise<SkillCatalog> {
    const {cache,error} = await this.cached(refresh); const state = await this.state(); const result = new Map<string,SkillCatalogItem>();
    for (const pkg of cache?.packages ?? []) {
      const local = state.items[pkg.item.skillId];
      result.set(pkg.item.skillId,local?.installed ? {...local,updateAvailable:local.packageVersion !== pkg.item.packageVersion,...(pkg.item.error ? {error:pkg.item.error} : {})} : {...pkg.item,revision:local?.revision ?? 0});
    }
    for (const item of Object.values(state.items)) if (item.installed && !result.has(item.skillId)) result.set(item.skillId,item);
    return {items:[...result.values()].sort((a,b)=>a.name.localeCompare(b.name)),stale:!!error,...(error ? {error} : {})};
  }
  async installed(): Promise<SkillCatalogItem[]> { await this.initialize(); return Object.values((await this.state()).items).filter(item=>item.installed); }
  /** Local records plus already-known update information; never refresh the source. */
  async installedCatalog(): Promise<SkillCatalog> {
    const items = await this.installed();
    const cache = await this.readJson<CatalogCache>('catalog-' + key(JSON.stringify(this.source)) + '.json');
    const versions = new Map((cache?.packages ?? []).map(pkg=>[pkg.item.skillId,pkg.item.packageVersion]));
    return {items:items.map(item=>({...item,updateAvailable:versions.has(item.skillId) && versions.get(item.skillId)!==item.packageVersion})).sort((a,b)=>a.name.localeCompare(b.name)),stale:false};
  }
  private versionDirectory(id: string, version: string): string {
    if (!id || id.length > 1024 || !/^[a-f0-9]{64}$/.test(version)) throw new ServiceError('INVALID_REQUEST','技能身份或包版本无效。');
    return 'versions/' + key(id) + '/' + version;
  }
  /** UI reads only the installed schema and manifest, without hashing package contents. */
  async packageMetadata(skillId: string, packageVersion?: string): Promise<{config:SkillConfigSchema;item:SkillCatalogItem}> {
    const {config,item} = await this.readPackageEntry(skillId,packageVersion,false);
    return {config,item};
  }
  async packageEntry(skillId: string, packageVersion?: string): Promise<{path:string;config:SkillConfigSchema;item:SkillCatalogItem}> {
    return this.readPackageEntry(skillId,packageVersion,false);
  }
  private async readPackageEntry(skillId: string, packageVersion: string | undefined, verifyIntegrity: boolean): Promise<{path:string;config:SkillConfigSchema;item:SkillCatalogItem}> {
    await this.initialize(); const current = (await this.state()).items[skillId];
    const version = packageVersion ?? (current?.installed ? current.packageVersion : undefined);
    if (!version) throw new ServiceError('NOT_FOUND','技能尚未安装或已卸载。');
    const relative = this.versionDirectory(skillId,version); const manifest = await this.readJson<Manifest>(relative + '/manifest.json');
    if (!manifest || manifest.version !== 1 || manifest.item.skillId !== skillId || manifest.item.packageVersion !== version) throw new ServiceError('NOT_FOUND','技能固定包版本不可用。');
    validatePackageFiles({directory:manifest.item.directory,files:manifest.files});
    if (verifyIntegrity) {
      if (packageDigest(manifest.files) !== version) throw new ServiceError('INVALID_REQUEST','技能包元数据摘要无效。');
      for (const file of manifest.files) {
        const path = await this.checked(relative + '/package/' + file.path); const stat = await fs.stat(path);
        if (!stat.isFile() || stat.size !== file.size || gitBlobSha(await fs.readFile(path)) !== file.sha) throw new ServiceError('INVALID_REQUEST','已安装技能包完整性校验失败。');
      }
    }
    const config = parseSkillConfig(await fs.readFile(await this.checked(relative + '/package/config.json'),'utf8'));
    return {path:await this.checked(relative + '/package/SKILL.md'),config,item:current?.installed && current.packageVersion === version ? current : manifest.item};
  }
  /** Holds the same cross-process lock as updates while a configuration write uses its schema. */
  async withPackageEntry<T>(skillId: string, expectedVersion: string, work: (entry: {path:string;config:SkillConfigSchema;item:SkillCatalogItem}) => Promise<T>): Promise<T> {
    return this.lock(async () => {
      const entry = await this.packageEntry(skillId);
      if (entry.item.packageVersion !== expectedVersion) throw new ServiceError('REVISION_CONFLICT','技能包已更新，请重新打开设置后保存。');
      return work(entry);
    });
  }
  /** Only files declared in a validated immutable manifest or pinned source snapshot are readable. */
  async readPackageFile(skillId: string, packageVersion: string, path: string): Promise<Buffer> {
    safeSkillPath(path); await this.initialize();
    const relative = this.versionDirectory(skillId,packageVersion);
    const manifest = await this.readJson<Manifest>(relative + '/manifest.json');
    if (manifest) {
      if (manifest.version !== 1 || manifest.item.skillId !== skillId || manifest.item.packageVersion !== packageVersion) throw new ServiceError('INVALID_REQUEST','技能包元数据无效。');
      validatePackageFiles({directory:manifest.item.directory,files:manifest.files});
      const file = manifest.files.find(file=>file.path===path);
      if (!file) throw new ServiceError('NOT_FOUND','技能包资源不存在。');
      const target = await this.checked(relative + '/package/' + path);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new ServiceError('INVALID_REQUEST','技能资源不是普通文件。');
      if (stat.size > SKILL_LIMITS.fileBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','技能资源超过大小限制。');
      const bytes = await fs.readFile(target);
      if (bytes.length > SKILL_LIMITS.fileBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','技能资源超过大小限制。');
      return bytes;
    }
    const {cache,error} = await this.cached();
    const pkg = cache?.packages.find(pkg=>pkg.item.skillId===skillId && pkg.item.packageVersion===packageVersion);
    if (!pkg || pkg.item.error) throw new ServiceError('NOT_FOUND',error ?? '技能固定包版本或资源不可用，请刷新详情。');
    validatePackageFiles(pkg);
    const file = pkg.files.find(file=>file.path===path);
    if (!file) throw new ServiceError('NOT_FOUND','技能包资源不存在。');
    return this.download(pkg,pkg.item.commitSha!,file);
  }
  async detail(skillId: string, locale = 'en'): Promise<SkillDetail> {
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) throw new ServiceError('INVALID_REQUEST','技能说明语言无效。');
    const names = [...new Set(['README.' + locale + '.md','README.' + locale.split('-')[0] + '.md','README.md'])];
    const current = (await this.installed()).find(item => item.skillId === skillId);
    if (current) {
      const entry = await this.packageEntry(skillId); const relative = this.versionDirectory(skillId,current.packageVersion!);
      const manifest = (await this.readJson<Manifest>(relative + '/manifest.json'))!;
      const name = names.find(name => manifest.files.some(file => file.path === name))!;
      const cached = await this.readJson<CatalogCache>('catalog-' + key(JSON.stringify(this.source)) + '.json');
      const remote = cached?.packages.find(pkg=>pkg.item.skillId===skillId);
      return {item:{...entry.item,updateAvailable:!!remote && remote.item.packageVersion !== entry.item.packageVersion},config:entry.config,readme:await fs.readFile(join(dirname(entry.path),name),'utf8')};
    }
    const {cache,error} = await this.cached(); const pkg = cache?.packages.find(pkg=>pkg.item.skillId === skillId);
    if (!pkg) throw new ServiceError('NOT_FOUND',error ?? '技能不存在。');
    if (pkg.item.error || !pkg.config) throw new ServiceError('INVALID_REQUEST',pkg.item.error ?? '技能包配置无效。');
    const file = pkg.files.find(file=>file.path === names.find(name=>pkg.files.some(file=>file.path===name)))!;
    if (file.size > SKILL_LIMITS.metadataBytes) throw new ServiceError('PAYLOAD_TOO_LARGE','技能说明超过大小限制。');
    return {item:{...pkg.item,revision:(await this.state()).items[skillId]?.revision ?? 0},config:pkg.config,readme:(await this.download(pkg,pkg.item.commitSha!,file)).toString('utf8')};
  }
  async install(skillId: string, expectedRevision: number): Promise<SkillCatalogItem> {
    const deadline = new SkillDeadline(SKILL_LIMITS.installMs);
    return this.lock(async () => {
      deadline.check();
      const state = await this.state(); const current = state.items[skillId]; this.checkRevision(current,expectedRevision);
      const {cache,error} = await deadline.wait(()=>this.cached(true));
      // A stale catalog may be shown, but must never be used to publish an installation.
      if (error) throw new ServiceError('NOT_FOUND',error,{retryable:true});
      const pkg = cache?.packages.find(pkg=>pkg.item.skillId===skillId);
      if (!pkg) throw new ServiceError('NOT_FOUND','技能不存在。');
      if (pkg.item.error) throw new ServiceError('INVALID_REQUEST',pkg.item.error);
      if (current?.installed && current.packageVersion === pkg.item.packageVersion) return current;
      const item = {...pkg.item,installed:true,revision:(current?.revision ?? 0)+1,updateAvailable:false};
      const target = this.versionDirectory(skillId,item.packageVersion!); const staging = 'staging/install-' + randomUUID();
      await this.directory(staging + '/package');
      try {
        for (const file of pkg.files) {
          const bytes = await this.download(pkg,item.commitSha!,file,deadline); deadline.check(); const path = await this.checked(staging + '/package/' + file.path);
          await fs.mkdir(dirname(path),{recursive:true,mode:0o700}); await fs.writeFile(path,bytes,{flag:'wx',mode:file.mode === '100755' ? 0o700 : 0o600});
        }
        parseSkillFrontmatter(await fs.readFile(await this.checked(staging + '/package/SKILL.md'),'utf8'));
        parseSkillConfig(await fs.readFile(await this.checked(staging + '/package/config.json'),'utf8'));
        deadline.check();
        await this.atomicJson(staging + '/manifest.json',{version:1,item,files:pkg.files,installedAt:new Date().toISOString()});
        await this.directory('versions/' + key(skillId));
        const existing = await this.readJson<Manifest>(target + '/manifest.json');
        deadline.check();
        if (!existing) await fs.rename(await this.checked(staging),await this.checked(target));
        else await this.readPackageEntry(skillId,item.packageVersion!,true);
        deadline.check();
        state.items[skillId] = item; await this.atomicJson('installed.json',state); return item;
      } finally { await fs.rm(await this.checked(staging),{recursive:true,force:true}); }
    });
  }
  async uninstall(skillId: string, expectedRevision: number): Promise<SkillCatalogItem> {
    return this.lock(async () => {
      const state = await this.state(); const current = state.items[skillId]; this.checkRevision(current,expectedRevision);
      if (!current) throw new ServiceError('NOT_FOUND','技能不存在。');
      if (!current.installed) return current;
      const item = {...current,installed:false,revision:current.revision+1,updateAvailable:false}; state.items[skillId]=item;
      await this.atomicJson('installed.json',state); return item;
    });
  }
  private checkRevision(item: SkillCatalogItem | undefined, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new ServiceError('INVALID_REQUEST','技能操作需要有效的 expectedRevision。');
    if ((item?.revision ?? 0) !== expected) throw new ServiceError('REVISION_CONFLICT','技能安装状态已改变，请刷新后重试。');
  }
}
