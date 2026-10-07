import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { open, rename, unlink, mkdir, rm, readdir, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { SkillConfigSchema, SkillConfiguration, SkillConfigurationWrite, SkillEnvironmentField } from '@openworkgraph/protocol';
import type { DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { parseSkillConfig, SKILL_CONFIG_LIMITS, validateSkillValue } from './skill-schema.js';

interface StoredValue { value: string; secret: boolean }
interface Snapshot { revision: number; values: Record<string, StoredValue> }
interface Manifest { version: 1; revision: number; minimumRevision: number }
interface LockOwner { pid: number; started: string; hostname: string; token: string }
/** Omit schema to validate an automatic skill without loading its env/defaults. */
export interface SkillConfigRevisionRequest { skillId: string; revision: number; schema?: SkillConfigSchema }
const emptySchema: SkillConfigSchema = { version: 1, environment: [] };
const initial = (): Manifest => ({ version: 1, revision: 0, minimumRevision: 0 });
const storageBytes = 2 * 1024 * 1024;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const invalid = (): never => { throw new ServiceError('INVALID_REQUEST', '技能配置输入无效。'); };
const unavailable = (): never => { throw new ServiceError('INVALID_REQUEST', '技能配置修订不可用，请重新提交任务。'); };
function revisionNumber(value: number): void { if (!Number.isSafeInteger(value) || value < 0) invalid(); }
function identifier(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) invalid(); }
function schemaCopy(schema: SkillConfigSchema): SkillConfigSchema {
  try { return parseSkillConfig(JSON.stringify(schema)); } catch { return invalid(); }
}
function privateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
}
function ensureDirectory(path: string): void {
  try { privateDirectory(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw Error('Unsafe storage');
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700);
    if ((lstatSync(path).mode & 0o777) !== 0o700) throw Error('Unsafe storage');
  }
}

/** No shell, interpolated PowerShell code, or platform diagnostics in errors. */
function command(program: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', oversized = false;
    const timer = setTimeout(() => child.kill(), 10000); timer.unref();
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 64 * 1024) { oversized = true; child.kill(); } else output += chunk; });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Error('ACL command unavailable')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !oversized ? resolve(output.trim()) : reject(Error('ACL command failed')); });
    child.stdin.end(input);
  });
}
const aclCheck = '$ErrorActionPreference="Stop"; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $a=Get-Acl -LiteralPath $p.path; $sid=$p.sid; if (!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) {exit 1}; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if ($rules.Count -eq 0) {exit 1}; foreach($r in $rules) {if ($r.IsInherited -or $r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {exit 1}}; [Console]::Out.Write("ok")';
function powershell(script: string, input?: string): Promise<string> {
  return command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], input);
}

/** Workspace-private, immutable revisions. Uninstall deliberately does not call clear. */
export class SkillConfigs {
  private sid: Promise<string> | undefined;
  constructor(private readonly directories: DataDirectories, private readonly serviceId: string) { identifier(serviceId); }

  private async windowsSid(): Promise<string> {
    this.sid ??= powershell('[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)').then(sid => {
      if (!/^S-1-(?:[0-9]+-)+[0-9]+$/.test(sid)) throw Error('Invalid SID');
      return sid;
    }).catch(error => { this.sid = undefined; throw error; });
    return this.sid;
  }

  private async windowsAcl(path: string, directory: boolean, restrict: boolean): Promise<void> {
    const sid = await this.windowsSid();
    if (restrict) await command('icacls.exe', [path, '/inheritance:r', '/grant:r', '*' + sid + ':' + (directory ? '(OI)(CI)F' : 'F'), '/Q', '/L']);
    // /grant:r replaces only this SID's ACE. Refuse leftover explicit grants,
    // inherited ACEs, different ownership, or unsupported filesystems.
    if (await powershell(aclCheck, JSON.stringify({ path, sid })) !== 'ok') throw Error('Unsafe ACL');
  }

  private async directory(skillId: string): Promise<string> {
    identifier(skillId);
    if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new ServiceError('MODEL_UNAVAILABLE', '当前平台不支持受限技能配置存储。');
    const root = join(this.directories.config, 'skill-configs');
    const workspace = join(root, hash(this.serviceId));
    const skill = join(workspace, hash(skillId));
    for (const path of [this.directories.config, root, workspace, skill]) {
      ensureDirectory(path);
      if (process.platform === 'win32') await this.windowsAcl(path, true, true);
    }
    return skill;
  }

  private async locked<T>(skillId: string, action: (path: string) => Promise<T>): Promise<T> {
    try {
      const path = await this.directory(skillId), lock = join(path, '.lock');
      const deadline = Date.now() + 5000;
      for (;;) {
        if (await this.claim(lock)) break;
        if (await this.recover(lock)) continue;
        if (Date.now() >= deadline) throw new ServiceError('CONFLICT', '技能配置锁仍被使用，或无法确认其所属进程已退出。', { retryable: true });
        await delay(20);
      }
      try { return await action(path); }
      finally {
        const released = join(path, '.released-' + randomUUID());
        await rename(lock, released); await rm(released, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      // Filesystem diagnostics and JSON parse errors must never expose values.
      throw new ServiceError('MODEL_UNAVAILABLE', '受限技能配置存储不可用。');
    }
  }

  private async claim(lock: string): Promise<LockOwner | undefined> {
    const prepared = join(dirname(lock), '.owner-' + randomUUID());
    await mkdir(prepared, { mode: 0o700 });
    try {
      if (process.platform === 'win32') await this.windowsAcl(prepared, true, true);
      const owner: LockOwner = { pid: process.pid, started: new Date(Date.now() - process.uptime() * 1000).toISOString(), hostname: hostname(), token: randomUUID() };
      // Publish a nonempty directory only after durable owner metadata exists.
      // rename cannot replace another nonempty lock directory, on either OS.
      await this.atomic(prepared, 'owner-' + owner.token + '.json', owner);
      try { lstatSync(lock); return undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await rename(prepared, lock); return owner; }
      catch (error) {
        if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          try { if (lstatSync(lock).isDirectory()) return undefined; }
          catch (stateError) { if ((stateError as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw stateError; }
        }
        throw error;
      }
    } finally { await rm(prepared, { recursive: true, force: true }); }
  }

  private async owner(lock: string): Promise<LockOwner | undefined> {
    try {
      const stat = lstatSync(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe lock');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    let names: string[];
    try { names = (await readdir(lock)).filter(name => /^owner(?:-[a-zA-Z0-9-]+)?\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (names.length !== 1) return undefined;
    const value = await this.load(join(lock, names[0]!)) as LockOwner | undefined;
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.started !== 'string' || !Number.isFinite(Date.parse(value.started)) || typeof value.hostname !== 'string' || typeof value.token !== 'string') return undefined;
    return value;
  }

  private dead(owner: LockOwner): boolean {
    if (owner.hostname !== hostname()) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  private async recover(lock: string, depth = 0): Promise<boolean> {
    const owner = await this.owner(lock);
    if (!owner || !this.dead(owner) || depth > 4) return false;
    const recovery = join(lock, '.recovery');
    let claim: LockOwner | undefined;
    try {
      claim = await this.claim(recovery);
      if (!claim) {
        // A recovery worker can itself crash. Its owner follows the same rule.
        await this.recover(recovery, depth + 1); return false;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    let moved = false;
    try {
      const current = await this.owner(lock);
      if (!current || current.token !== owner.token || !this.dead(current)) return false;
      const retired = join(dirname(lock), '.retired-' + randomUUID());
      await rename(lock, retired); moved = true;
      await rm(retired, { recursive: true, force: true }); return true;
    } finally {
      if (!moved) {
        // A live owner may release and replace the parent while we check it.
        // Remove only our unique owner file, never another worker's claim.
        await unlink(join(recovery, 'owner-' + claim.token + '.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        await rmdir(recovery).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
      }
    }
  }

  private async load(path: string): Promise<unknown | undefined> {
    let file;
    if (process.platform === 'win32') {
      try { if (lstatSync(path).isSymbolicLink()) throw Error('Unsafe storage'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) || stat.size > storageBytes || (process.getuid && stat.uid !== process.getuid())) throw Error('Unsafe storage');
      if (process.platform === 'win32') await this.windowsAcl(path, false, false);
      return JSON.parse(await file.readFile('utf8')) as unknown;
    } finally { await file.close(); }
  }

  private async manifest(path: string): Promise<Manifest> {
    const raw = await this.load(join(path, 'current.json'));
    if (raw === undefined) {
      // Establish revision zero before a first write. A lost committed manifest
      // must not make old revision numbers eligible for reuse with new secrets.
      if ((await readdir(path)).some(name => /^[0-9]+\.json$/.test(name))) throw Error('Missing revision manifest');
      const manifest = initial(); await this.atomic(path, 'current.json', manifest); return manifest;
    }
    const value = raw as Manifest;
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.minimumRevision) || value.minimumRevision < 0 || value.minimumRevision > value.revision) throw Error('Invalid storage');
    if (value.minimumRevision > 0) await this.removeRevoked(path, value.minimumRevision);
    return value;
  }

  private async removeRevoked(path: string, minimumRevision: number): Promise<void> {
    for (const name of await readdir(path)) {
      const revision = /^([0-9]+)\.json$/.exec(name);
      if ((revision && Number(revision[1]) < minimumRevision) || /^\.[a-f0-9-]+\.tmp$/.test(name)) await unlink(join(path, name));
    }
  }

  private async snapshot(path: string, manifest: Manifest, revision: number): Promise<Snapshot> {
    revisionNumber(revision);
    if (revision < manifest.minimumRevision || revision > manifest.revision) unavailable();
    if (revision === 0) return { revision: 0, values: {} };
    const value = await this.load(join(path, String(revision) + '.json')) as Snapshot | undefined;
    if (!value) return unavailable();
    if (value.revision !== revision || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) throw Error('Invalid storage');
    for (const stored of Object.values(value.values)) {
      if (!stored || typeof stored.value !== 'string' || typeof stored.secret !== 'boolean') throw Error('Invalid storage');
      validateSkillValue(stored.value);
    }
    return value;
  }

  private async atomic(path: string, name: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > storageBytes) invalid();
    const temporary = join(path, '.' + randomUUID() + '.tmp');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (process.platform === 'win32') await this.windowsAcl(temporary, false, true);
      else await file.chmod(0o600);
      await file.writeFile(text, 'utf8'); await file.sync();
    } catch (error) { await file.close(); await unlink(temporary).catch(() => {}); throw error; }
    await file.close();
    try { await rename(temporary, join(path, name)); }
    finally { await unlink(temporary).catch(() => {}); }
    if (process.platform === 'win32') return; // Windows does not support fsync of directory handles.
    const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private effective(field: SkillEnvironmentField, snapshot: Snapshot): string | undefined {
    const stored = Object.hasOwn(snapshot.values, field.name) ? snapshot.values[field.name] : undefined;
    // Both sensitivity transitions require a fresh value; defaults cannot rescue one.
    if (stored && stored.secret !== field.secret) return undefined;
    return stored?.value ?? field.default;
  }

  private view(skillId: string, schema: SkillConfigSchema, manifest: Manifest, snapshot: Snapshot): SkillConfiguration {
    return { skillId, revision: manifest.revision, schema, values: schema.environment.map(field => {
      const value = this.effective(field, snapshot);
      const configured = value !== undefined && (!field.required || !!value.trim());
      return { name: field.name, configured, ...(value !== undefined && !field.secret && snapshot.values[field.name]?.secret !== true ? { value } : {}) };
    }) };
  }

  async read(skillId: string, schema: SkillConfigSchema): Promise<SkillConfiguration> {
    const checked = schemaCopy(schema);
    return this.locked(skillId, async path => {
      const manifest = await this.manifest(path);
      return this.view(skillId, checked, manifest, await this.snapshot(path, manifest, manifest.revision));
    });
  }

  async write(skillId: string, schema: SkillConfigSchema, body: SkillConfigurationWrite): Promise<SkillConfiguration> {
    const checked = schemaCopy(schema);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expectedRevision', 'values'].includes(key)) || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) invalid();
    revisionNumber(body.expectedRevision);
    // Copy before waiting for the lock so callers cannot mutate validation inputs.
    const updates = Object.entries(body.values);
    const fields = new Map(checked.environment.map(field => [field.name, field]));
    let bytes = 0;
    for (const [name, value] of updates) {
      if (!fields.has(name) || (value !== null && typeof value !== 'string')) invalid();
      if (value !== null) { validateSkillValue(value); bytes += Buffer.byteLength(value); }
    }
    if (bytes > SKILL_CONFIG_LIMITS.valuesBytes) invalid();
    const expectedRevision = body.expectedRevision;
    return this.locked(skillId, async path => {
      const manifest = await this.manifest(path);
      if (manifest.revision !== expectedRevision) throw new ServiceError('CONFLICT', '技能配置修订已改变。', { details: { revision: manifest.revision } });
      const previous = await this.snapshot(path, manifest, manifest.revision);
      const values: Record<string, StoredValue> = Object.create(null) as Record<string, StoredValue>;
      // Drop deleted fields, retain unchanged fields including mismatches until replaced.
      for (const field of checked.environment) if (Object.hasOwn(previous.values, field.name)) values[field.name] = previous.values[field.name]!;
      for (const [name, value] of updates) {
        if (value === null) delete values[name];
        else values[name] = { value, secret: fields.get(name)!.secret };
      }
      const nextRevision = manifest.revision + 1; revisionNumber(nextRevision);
      const snapshot: Snapshot = { revision: nextRevision, values };
      for (const field of checked.environment) {
        const value = this.effective(field, snapshot);
        if (field.required && (value === undefined || !value.trim())) throw new ServiceError('INVALID_REQUEST', '技能必填配置缺失：' + field.name);
      }
      if (Object.values(values).reduce((sum, value) => sum + Buffer.byteLength(value.value), 0) > SKILL_CONFIG_LIMITS.valuesBytes) invalid();
      const next: Manifest = { ...manifest, revision: nextRevision };
      // Publishing the manifest last is the transaction commit. Interrupted snapshots
      // are unreachable and may be replaced by the next writer at the same revision.
      await this.atomic(path, String(nextRevision) + '.json', snapshot);
      await this.atomic(path, 'current.json', next);
      return this.view(skillId, checked, next, snapshot);
    });
  }

  async clear(skillId: string, expectedRevision: number): Promise<SkillConfiguration> {
    revisionNumber(expectedRevision);
    return this.locked(skillId, async path => {
      const manifest = await this.manifest(path);
      if (manifest.revision !== expectedRevision) throw new ServiceError('CONFLICT', '技能配置修订已改变。', { details: { revision: manifest.revision } });
      const revision = manifest.revision + 1; revisionNumber(revision);
      const snapshot: Snapshot = { revision, values: {} };
      const next: Manifest = { ...manifest, revision, minimumRevision: revision };
      await this.atomic(path, String(revision) + '.json', snapshot);
      await this.atomic(path, 'current.json', next);
      // Revocation commits before deletion. A crash midway is safe, and the
      // next locked read resumes deleting the revoked private files.
      await this.removeRevoked(path, revision);
      return this.view(skillId, emptySchema, next, snapshot);
    });
  }

  async revision(skillId: string): Promise<number> { return this.locked(skillId, async path => (await this.manifest(path)).revision); }

  async hasRevision(skillId: string, revision: number): Promise<boolean> {
    revisionNumber(revision);
    return this.locked(skillId, async path => {
      const manifest = await this.manifest(path);
      if (revision < manifest.minimumRevision || revision > manifest.revision) return false;
      try { await this.snapshot(path, manifest, revision); return true; }
      catch (error) { if (error instanceof ServiceError && error.code === 'INVALID_REQUEST') return false; throw error; }
    });
  }

  async environment(skillId: string, schema: SkillConfigSchema, revision: number): Promise<Record<string, string>> {
    const checked = schemaCopy(schema); revisionNumber(revision);
    return this.locked(skillId, async path => {
      const manifest = await this.manifest(path), snapshot = await this.snapshot(path, manifest, revision);
      return this.snapshotEnvironment(checked, snapshot);
    });
  }

  private snapshotEnvironment(schema: SkillConfigSchema, snapshot: Snapshot): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const field of schema.environment) {
      const value = this.effective(field, snapshot);
      if (field.required && (value === undefined || !value.trim())) throw new ServiceError('INVALID_REQUEST', '技能必填配置缺失：' + field.name);
      if (value !== undefined) Object.defineProperty(environment, field.name, { value, enumerable: true, configurable: true, writable: true });
    }
    return environment;
  }

  /** Deterministic multi-skill locking prevents clear between the final revision
   * check, secret read, and synchronous spawn/request. No nested public store
   * methods may be awaited inside dispatch. Never await a returned command. */
  async withRevisions<T>(requests: readonly SkillConfigRevisionRequest[], dispatch: (environments: ReadonlyMap<string, Record<string,string>>) => T): Promise<{ value: T }> {
    const unique = new Map<string, SkillConfigRevisionRequest>();
    for (const request of requests) {
      identifier(request.skillId); revisionNumber(request.revision);
      if (unique.has(request.skillId)) invalid();
      unique.set(request.skillId, { skillId: request.skillId, revision: request.revision, ...(request.schema ? { schema: schemaCopy(request.schema) } : {}) });
    }
    const ids = [...unique.keys()].sort();
    const paths = new Map<string,string>();
    let dispatchFailed = false, dispatchError: unknown;
    const acquire = (index: number): Promise<{ value: T }> => {
      const id = ids[index];
      if (id !== undefined) return this.locked(id, async path => { paths.set(id, path); return acquire(index + 1); });
      return (async () => {
        const environments = new Map<string,Record<string,string>>();
        for (const skillId of ids) {
          const request = unique.get(skillId)!, path = paths.get(skillId)!;
          const manifest = await this.manifest(path);
          const snapshot = await this.snapshot(path, manifest, request.revision);
          if (request.schema) environments.set(skillId, this.snapshotEnvironment(request.schema, snapshot));
        }
        // The envelope prevents Promise assimilation from holding locks for the
        // lifetime of command/exec rather than only its synchronous dispatch.
        try { return { value: dispatch(environments) }; }
        catch (error) { dispatchFailed = true; dispatchError = error; throw error; }
      })();
    };
    try { return await acquire(0); }
    catch (error) { if (dispatchFailed) throw dispatchError; throw error; }
  }
}
