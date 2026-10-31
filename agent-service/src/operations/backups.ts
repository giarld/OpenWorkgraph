import { DatabaseSync } from 'node:sqlite';
import { replaceDatabase } from './replace-database.js';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { lstat, mkdtemp, rename, rm, realpath, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Backup, RestorePreview } from '@openworkgraph/protocol';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
import type { DataDirectories } from '../directories.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../persistence/schema.js';
import { atomic, migrate, transaction } from '../persistence/database.js';
import { Repositories } from '../persistence/repositories.js';
import { digest, identifier, privateDir, readSafe, safePath, syncDir } from './files.js';
import type { OperationsLock } from './lifecycle.js';
import { createDatabaseSnapshot } from './snapshot.js';
import { ServiceError } from '../errors.js';
import { errorLogFields, silentLogger, type Logger } from '../logger.js';
import { backupFileChunks, copyBackupFile, hashBackupFile, writeBackupFile } from './backup-files.js';
import { BACKUP_DATABASE_FILE, BACKUP_ZIP_FILE, createBackupArchive, decodeBackupArchive, validBackupFile } from './backup-archive.js';
import { compareSemVer } from './update.js';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export interface BackupOptions {
  logger?: Logger;
  /** Host excludes ALL blob GC until copies finish, including queued deletions. */
  withBlobLease?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Offline caller holds the same lock used by serve until DB closes. */
  maintenance?: OperationsLock;
}
interface FileEntry { path: string; sha256: string; bytes: number }
interface Manifest { format: 2; id: string; serviceId: string; serviceVersion: string; schemaVersion: number; createdAt: string; files: FileEntry[]; localStateOmitted: true }
interface Verified { manifest: Manifest; sha256: string; bytes: number; archive: string; files: Map<string, string>; directory: string; dispose: () => Promise<void> }
export interface BackupDownload { filename: string; contentType: string; bytes: number; body: Readable; dispose: () => Promise<void> }
interface BackupDeletion { backupId: string; deleted: true }
const pendingBackups = new WeakMap<DatabaseSync, Set<Promise<unknown>>>();
const pendingDeletions = new WeakMap<DatabaseSync, Map<string, Promise<BackupDeletion>>>();
const preparingDownloads = new WeakMap<DatabaseSync, Map<string, number>>();
export async function waitForBackups(db: DatabaseSync): Promise<void> {
  while (pendingBackups.get(db)?.size) await Promise.allSettled([...pendingBackups.get(db)!]);
}
/** Call BEFORE starting runtime/HTTP, only while holding exclusive root ownership. */
export function clearStaleResourceLeases(db: DatabaseSync, lock: OperationsLock): void {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!lock.held || file !== join(lock.root, 'service.sqlite')) throw new Error('Lease recovery requires matching exclusive root ownership');
  transaction(db, () => {
    for (const table of ['resource_read_leases', 'resource_maintenance_leases']) if (hasTable(db, table)) db.exec('DELETE FROM ' + table);
  });
}
const hasTable = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const localSettingNames = new Set(['executionSettings', 'agentDefault', 'listener', 'operationsInstance', 'backupRestorePending']);
const privateFieldNames = new Set(['env', 'environment', 'secret', 'secrets', 'credential', 'credentials', 'password', 'token', 'tokenhash', 'apikey', 'accesskey', 'privatekey', 'authorization', 'cookie', 'executable', 'argv', 'args', 'cwd', 'launch', 'launcher', 'session']);
const privateField = (name: string): boolean => privateFieldNames.has(name.replace(/[_-]/g, '').toLowerCase())
  || name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').split(/[:._-]/).some(part => privateFieldNames.has(part.toLowerCase()));
/** Only host configuration is stripped. Business metadata and user-authored
 * graph content/frozen facts are never traversed or rewritten. */
function localSetting(key: string, serialized: string): boolean {
  if (['capacity', 'eventFloor', 'acceptingRuns', 'modelDefaults', 'metadata'].includes(key)
    || /^(?:graph-import-requirements:|graph-copied-provenance:|metadata:)/.test(key)) return false;
  if (localSettingNames.has(key) || key.startsWith('agentSettings:')) return true;
  if (privateField(key)) return true;
  // Unknown future launch/configuration rows still cannot smuggle private host
  // fields through settings. Inspect field names, never arbitrary text values.
  const pending: unknown[] = [JSON.parse(serialized)];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Object.keys(value).some(privateField)) return true;
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
  }
  return false;
}
/** Call ONLY on an isolated writable SQLite copy, inside its transaction. Keep
 * principal IDs and idempotency scopes; authentication material is inert. */
function omitLocalState(db: DatabaseSync, revokedAt: number): number {
  let changes = 0;
  for (const row of db.prepare('SELECT key,value FROM settings').all()) {
    if (localSetting(String(row.key), String(row.value))) changes += Number(db.prepare('DELETE FROM settings WHERE key=?').run(row.key!).changes);
  }
  changes += Number(db.prepare("UPDATE settings SET value='null' WHERE key='modelDefaults' AND value!='null'").run().changes);
  changes += Number(db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('modelDefaults','null')").run().changes);
  for (const row of db.prepare('SELECT id,token_hash,revoked_at FROM sessions').all()) {
    const inert = 'portable-revoked:' + digest(String(row.id));
    if (row.token_hash !== inert || row.revoked_at === null) changes += Number(db.prepare('UPDATE sessions SET token_hash=?,revoked_at=coalesce(revoked_at,?) WHERE id=?').run(inert, revokedAt, row.id!).changes);
  }
  changes += Number(db.prepare('DELETE FROM pairing_codes').run().changes);
  if (hasTable(db, 'image_provider_revoked_credentials')) {
    for (const row of db.prepare('SELECT id,credential_counter FROM image_providers').all()) {
      for (let revision = 1; revision <= Number(row.credential_counter); revision++) changes += Number(db.prepare('INSERT OR IGNORE INTO image_provider_revoked_credentials(provider_id,revision) VALUES(?,?)').run(row.id!, revision).changes);
    }
    changes += Number(db.prepare('UPDATE image_providers SET credential_revision=NULL WHERE credential_revision IS NOT NULL').run().changes);
    changes += Number(db.prepare('UPDATE image_provider_models SET verified_at=NULL WHERE verified_at IS NOT NULL').run().changes);
  }
  if (hasTable(db, 'data_sources')) {
    changes += Number(db.prepare('UPDATE data_sources SET credential_generation=NULL WHERE credential_generation IS NOT NULL').run().changes);
    db.exec('UPDATE remote_temporary_targets SET writable=0; DELETE FROM data_source_host_challenges; DELETE FROM data_source_host_trust; UPDATE remote_transfers SET cache_path=NULL;');
    for (const row of db.prepare('SELECT id,payload FROM remote_transfers').all()) {
      const job = JSON.parse(String(row.payload));
      if (['accepted','preparing','transferring','committing'].includes(job.state)) { job.state='interrupted'; job.error='Backup restored. Retry manually.'; job.revision++; db.prepare('UPDATE remote_transfers SET payload=? WHERE id=?').run(JSON.stringify(job), row.id!); changes++; }
    }
  }
  return changes;
}
function portableJournal(db: DatabaseSync): void {
  // Exclusive temporary copy: finish/checkpoint WAL before changing journal
  // mode. DELETE leaves no persistent journal/WAL carrying removed values.
  if (db.isTransaction) throw new Error('Backup sanitization requires an isolated copy outside a transaction');
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
}
function identity(db: DatabaseSync): string {
  const row = db.prepare('SELECT service_id FROM identity WHERE singleton=1').get();
  if (!row || typeof row.service_id !== 'string') throw new Error('Missing service identity');
  return row.service_id;
}
function schemaSignature(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
}
function historicalSchema(version: number): string {
  const db=new DatabaseSync(':memory:',{enableForeignKeyConstraints:true});
  try {for(const migration of MIGRATIONS.filter(item=>item.version<=version))db.exec(migration.sql);return schemaSignature(db);}
  finally {db.close();}
}
function checkDatabase(db: DatabaseSync, manifest: Manifest, schema?: string, upgraded=false): void {
  if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion<11 || manifest.schemaVersion>SCHEMA_VERSION) throw new Error('Backup schema unsupported; use matching service version');
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version!==(upgraded?SCHEMA_VERSION:manifest.schemaVersion))throw new Error('Backup database schema version does not match manifest');
  if(!upgraded && schema!==undefined && schemaSignature(db)!==(version===SCHEMA_VERSION?schema:historicalSchema(version)))throw new Error('Backup schema differs from trusted local schema');
  if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Backup database failed integrity checks');
  if (identity(db) !== manifest.serviceId) throw new Error('Backup identity mismatch');
  const expected = new Map(manifest.files.filter(f => f.path !== BACKUP_DATABASE_FILE).map(f => [f.path.slice(6), f]));
  const rows = db.prepare('SELECT sha256,bytes FROM blobs').all();
  if (rows.length !== expected.size || rows.some(row => expected.get(String(row.sha256))?.bytes !== Number(row.bytes))) throw new Error('Manifest does not cover database blobs exactly');
  for (const name of ['sessions', 'pairing_codes', 'settings', 'runs', 'backups', 'occupancy', 'interactions']) if (!hasTable(db, name)) throw new Error('Incomplete backup schema');
}
async function withTemporaryDatabase<T>(source: string, work: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'workgraph-verify-'));
  try {
    const path = join(temporary, 'service.sqlite'); await copyBackupFile(source, path, 0o600);
    const db = new DatabaseSync(path, { allowExtension: false });
    try { db.exec('PRAGMA trusted_schema=OFF'); return await work(db); } finally { db.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function verify(path: string, expectedHash?: string, schema?: string): Promise<Verified> {
  const source = await safePath(path), files = new Map<string, string>();
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'workgraph-backup-verify-'));
  const dispose = () => rm(directory, { recursive: true, force: true, maxRetries: 5 });
  try {
    await privateDir(join(directory, 'blobs')); await privateDir(join(directory, 'database'));
    const archive = join(directory, 'verified.zip');
    const sourceZip = (await lstat(source)).isDirectory() ? join(source, BACKUP_ZIP_FILE) : source;
    const copiedZip = await copyBackupFile(sourceZip, archive, 0o600);
    let archived: Set<string>;
    try { archived = await decodeBackupArchive(archive, directory); }
    catch (cause) { throw new ServiceError('INVALID_REQUEST', '备份 ZIP 无效或已损坏；仅支持当前 ZIP 备份格式。', { cause }); }
    const manifestBytes = await readSafe(join(directory, 'manifest.json'), Infinity);
    const hash = digest(manifestBytes);
    if (expectedHash !== undefined && hash !== expectedHash) throw new Error('Backup manifest checksum mismatch');
    const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
    if (manifest.format !== 2 || !Array.isArray(manifest.files) || typeof manifest.serviceId !== 'string' || typeof manifest.serviceVersion !== 'string' || typeof manifest.createdAt !== 'string' || !Number.isInteger(manifest.schemaVersion) || manifest.localStateOmitted !== true) throw new ServiceError('INVALID_REQUEST', '备份清单无效；不支持旧备份格式。');
    let newer: boolean;
    try { newer = compareSemVer(manifest.serviceVersion, SERVICE_VERSION) > 0; }
    catch (cause) { throw new ServiceError('INVALID_REQUEST', '备份中的工作空间版本无效。', { cause }); }
    if (newer || manifest.schemaVersion > SCHEMA_VERSION) throw new ServiceError('SCHEMA_UNSUPPORTED', '备份来自更新版本的工作空间，请先升级当前工作空间。');
    identifier(manifest.id);
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !validBackupFile(entry.path) || files.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Unsafe backup manifest entry');
      if (archived && !archived.has(entry.path)) throw new Error('Missing backup file');
      const target = join(directory, entry.path);
      const actual = await hashBackupFile(target);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || (entry.path.startsWith('blobs/') && entry.sha256 !== entry.path.slice(6))) throw new Error('Backup content checksum mismatch');
      files.set(entry.path, target);
    }
    if (!files.has(BACKUP_DATABASE_FILE) || archived.size !== files.size) throw new Error('Incomplete or extra backup content');
    await withTemporaryDatabase(files.get(BACKUP_DATABASE_FILE)!, async db => {
      checkDatabase(db,manifest,schema);
      if(manifest.schemaVersion<SCHEMA_VERSION){migrate(db);checkDatabase(db,manifest,undefined,true);}
    });
    return { manifest, sha256: hash, bytes: copiedZip.bytes, archive, files, directory, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** Online restore is coordinated by WorkspaceRestore under exclusive ownership. */
export class Backups {
  constructor(readonly db: DatabaseSync, readonly directories: DataDirectories, readonly options: BackupOptions = {}) {}
  private async diagnose<T>(operation: string, work: (progress: (stage: string, backupId?: string) => void) => Promise<T>, backupId?: string): Promise<T> {
    let stage = 'validate';
    try { return await work((value, id) => { stage = value; if (id) backupId = id; }); }
    catch (error) { this.logFailure(operation, stage, error, backupId); throw error; }
  }
  private logFailure(operation: string, stage: string, error: unknown, backupId?: string): void {
    (this.options.logger ?? silentLogger).write('error', 'backup.failed', { operation, stage, ...(backupId ? { backupId } : {}), ...errorLogFields(error) });
  }
  /** Startup only, before HTTP/runtime dispatch, under exclusive service ownership.
   * Repair interrupted/failed catalogue rows and discover committed archives lost
   * by earlier restores. Incomplete staging is retained for diagnosis. */
  async recoverCreating(lock: OperationsLock): Promise<void> {
    const requireOwnership = () => {
      const file = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
      if (!lock.held || lock.root !== this.directories.root || file !== join(lock.root, 'service.sqlite') || pendingBackups.get(this.db)?.size) throw new Error('Backup recovery requires matching exclusive startup ownership and no pending backups');
    };
    requireOwnership();
    const schema = schemaSignature(this.db), serviceId = identity(this.db);
    const deleted = new Set(this.db.prepare("SELECT key FROM idempotency WHERE scope='backup.delete'").all().map(row => String(row.key)));
    const known = new Set(this.db.prepare('SELECT id FROM backups').all().map(row => String(row.id)));
    const rows: { id: string; state: Backup['state'] | null; path: string; createdAt: string | null; sha256: string | null }[] = this.db.prepare("SELECT id,state,path,created_at,sha256 FROM backups WHERE state IN ('creating','failed')").all().map(row => ({ id: String(row.id), state: row.state as Backup['state'], path: String(row.path), createdAt: String(row.created_at), sha256: row.sha256 === null ? null : String(row.sha256) }));
    // An earlier restore may have lost catalogue rows for newer local archives.
    // Only committed, ID-named directories are candidates; staging stays private.
    for (const entry of await readdir(await safePath(this.directories.backups), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{64}$/.test(entry.name) && !known.has(entry.name) && !deleted.has(entry.name)) rows.push({ id: entry.name, state: null, path: join(this.directories.backups, entry.name), createdAt: null, sha256: null });
    }
    for (const row of rows) {
      if (deleted.has(row.id)) continue;
      let recovered: Verified | undefined;
      let candidate: Verified | undefined;
      try {
        const id = identifier(row.id), path = join(this.directories.backups, id);
        if (row.path !== path) throw new Error('Backup catalogue path mismatch');
        const verified = candidate = await verify(path, row.sha256 ?? undefined, schema);
        if (verified.manifest.id !== id || verified.manifest.serviceId !== serviceId || (row.createdAt !== null && verified.manifest.createdAt !== row.createdAt)) throw new Error('Backup catalogue identity mismatch');
        recovered = verified;
      } catch (error) { this.logFailure('recover', 'verify', error, String(row.id)); }
      finally { await candidate?.dispose(); }
      requireOwnership();
      if (!recovered && row.state !== 'creating') continue;
      const state = recovered ? 'ready' : 'failed';
      atomic(this.db, () => {
        const current = this.db.prepare('SELECT state FROM backups WHERE id=?').get(row.id);
        if (row.state === null ? current !== undefined : current?.state !== row.state) throw new Error('Backup changed during startup recovery');
        this.change(row.id, state, () => {
          if (row.state === null) this.db.prepare('INSERT INTO backups(id,state,created_at,bytes,sha256,path) VALUES(?,?,?,?,?,?)').run(row.id, state, recovered!.manifest.createdAt, recovered!.bytes, recovered!.sha256, row.path);
          else this.db.prepare('UPDATE backups SET state=?,bytes=?,sha256=? WHERE id=?').run(state, recovered?.bytes ?? null, recovered?.sha256 ?? null, row.id);
        });
      });
    }
  }
  private change(id: string, state: Backup['state'], write: () => void): void {
    atomic(this.db, () => {
      write();
      const row = this.db.prepare('SELECT created_at,bytes,sha256 FROM backups WHERE id=?').get(id)!;
      new Repositories(this.db).appendEvent({ eventId: randomUUID(), type: 'backup.changed', projectId: null, graphId: null, entityId: id, revision: state === 'creating' ? 0 : 1, occurredAt: new Date().toISOString(), payload: { backupId: id, state, createdAt: String(row.created_at), bytes: row.bytes === null ? null : Number(row.bytes), sha256: row.sha256 === null ? null : String(row.sha256) } });
    });
  }
  private requireMaintenance(): OperationsLock {
    const lock = this.options.maintenance;
    if (!lock?.held || lock.root !== this.directories.root) throw new Error('Restore requires exclusive local maintenance; stop service first');
    return lock;
  }
  async list(): Promise<(Backup & { location?: string })[]> {
    // Display metadata only: download continues to resolve a validated ID under
    // directories.backups, never a client-provided location.
    return this.db.prepare('SELECT id,state,created_at,bytes,sha256,path FROM backups ORDER BY created_at DESC,id').all().map(row => ({ id: String(row.id), state: row.state as Backup['state'], createdAt: String(row.created_at), bytes: row.bytes === null ? null : Number(row.bytes), sha256: row.sha256 === null ? null : String(row.sha256), ...(typeof row.path === 'string' && row.path ? { location: row.path } : {}) }));
  }
  private requireNotDeleted(id: string): void {
    if (pendingDeletions.get(this.db)?.has(id)) throw new ServiceError('CONFLICT', '备份正在删除，请稍后重试。');
    if (new Repositories(this.db).replay('backup.delete', id, { backupId: id })) throw new ServiceError('NOT_FOUND', '备份已删除，请使用新请求创建备份。', { details: { backupId: id, reason: 'backup_deleted' } });
  }
  async delete(id: string): Promise<BackupDeletion> {
    let deletions = pendingDeletions.get(this.db);
    if (!deletions) { deletions = new Map(); pendingDeletions.set(this.db, deletions); }
    const previous = deletions.get(id); if (previous) return previous;
    const operation = this.diagnose('delete', progress => this.deleteFiles(id, progress), id);
    deletions.set(id, operation);
    let pending = pendingBackups.get(this.db);
    if (!pending) { pending = new Set(); pendingBackups.set(this.db, pending); }
    pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); deletions.delete(id); }
  }
  private async deleteFiles(id: string, progress: (stage: string) => void): Promise<BackupDeletion> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ServiceError('INVALID_REQUEST', '备份标识无效。');
    if (this.options.maintenance) this.requireMaintenance();
    else if (!this.options.withBlobLease) throw new Error('Backup deletion requires the owning service or exclusive local maintenance');
    const row = this.db.prepare('SELECT state,path FROM backups WHERE id=?').get(id);
    if (row?.state === 'creating') throw new ServiceError('CONFLICT', '备份正在创建，请完成后再删除。');
    if (preparingDownloads.get(this.db)?.get(id)) throw new ServiceError('CONFLICT', '备份正在准备下载，请稍后重试删除。');
    const root = await realpath(await safePath(this.directories.backups));
    if (row && row.path !== join(this.directories.backups, id)) throw new ServiceError('INVALID_REQUEST', '备份目录记录不匹配。');
    try {
      progress('remove_files');
      const staging = new RegExp('^\\.' + id + '\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$');
      const targets: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name !== id && !staging.test(entry.name)) continue;
        // Validate all targets before removing any. Catalogue paths never
        // select filesystem targets; only the validated ID under backups does.
        const target = await safePath(join(root, entry.name));
        if (!(await lstat(target)).isDirectory()) throw new ServiceError('INVALID_REQUEST', '备份路径不是目录。');
        targets.push(target);
      }
      for (const target of targets) await rm(target, { recursive: true, force: true, maxRetries: 5 });
      await syncDir(root);
      progress('commit');
      return new Repositories(this.db).idempotent('backup.delete', id, { backupId: id }, () => {
        this.db.prepare('DELETE FROM backups WHERE id=?').run(id);
        if (row) new Repositories(this.db).appendEvent({ eventId: randomUUID(), type: 'backup.changed', projectId: null, graphId: null, entityId: id, revision: 2, occurredAt: new Date().toISOString(), payload: { backupId: id, deleted: true } });
        return { backupId: id, deleted: true };
      }) as unknown as BackupDeletion;
    } catch (error) {
      if (row) {
        try { this.change(id, 'failed', () => { this.db.prepare("UPDATE backups SET state='failed' WHERE id=?").run(id); }); }
        catch (stateError) { this.logFailure('delete', 'mark_failed', stateError, id); }
      }
      throw error;
    }
  }
  async create(idempotencyKey: string = randomUUID()): Promise<Backup> {
    if (!this.options.maintenance && this.db.prepare("SELECT value FROM settings WHERE key='acceptingRuns'").get()?.value !== 'true') throw new ServiceError('MAINTENANCE', 'Service is draining; new backups are unavailable');
    let pending = pendingBackups.get(this.db);
    if (!pending) { pending = new Set(); pendingBackups.set(this.db, pending); }
    const operation = this.diagnose('create', progress => this.createSnapshot(idempotencyKey, progress)); pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  }
  private async createSnapshot(idempotencyKey: string, progress: (stage: string, backupId?: string) => void): Promise<Backup> {
    identifier(idempotencyKey);
    const id = digest(identity(this.db) + ':' + idempotencyKey);
    progress('catalogue', id);
    this.requireNotDeleted(id);
    const old = (await this.list()).find(item => item.id === id); if (old) return old;
    const work = async (): Promise<Backup> => {
      // No asynchronous gap between the authoritative retry check and insert.
      this.requireNotDeleted(id);
      const exists = this.db.prepare('SELECT 1 FROM backups WHERE id=?').get(id);
      if (exists) return (await this.list()).find(item => item.id === id)!;
      const createdAt = new Date().toISOString(); const final = join(this.directories.backups, id);
      const temporary = join(this.directories.backups, '.' + id + '.' + randomUUID());
      this.change(id, 'creating', () => { this.db.prepare("INSERT INTO backups(id,state,created_at,path) VALUES(?,'creating',?,?)").run(id, createdAt, final); });
      try {
        progress('prepare');
        await privateDir(temporary); await privateDir(join(temporary, 'blobs')); await privateDir(join(temporary, 'database'));
        const snapshot = join(temporary, BACKUP_DATABASE_FILE);
        // One SQLite consistent snapshot including WAL, under host GC exclusion.
        progress('snapshot'); await createDatabaseSnapshot(this.directories.database, snapshot);
        const portable = new DatabaseSync(snapshot, { allowExtension: false });
        try {
          progress('sanitize'); portableJournal(portable);
          transaction(portable, () => omitLocalState(portable, Date.parse(createdAt)));
        } finally { portable.close(); }
        // Compact in the existing worker, so large VACUUMs do not block HTTP.
        // All SQLite handles close before replacing the file on Windows.
        const compacted = snapshot + '.portable';
        progress('compact'); await createDatabaseSnapshot(snapshot, compacted);
        await rename(compacted, snapshot);
        const copied = new DatabaseSync(snapshot, { readOnly: true, allowExtension: false });
        let total: number, manifestHash: string;
        try {
          const entries: FileEntry[] = [];
          progress('copy_blobs');
          for (const row of copied.prepare('SELECT sha256,bytes FROM blobs ORDER BY sha256').all()) {
            const sha = String(row.sha256); if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid blob hash');
            const stored = hasTable(copied, 'resource_blob_files') ? copied.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(sha) : undefined;
            if (!stored) throw new Error('Blob has no immutable file mapping');
            // Normalize Windows 8.3 aliases on both sides after rejecting links.
            const sourcePath = await realpath(await safePath(String(stored.path)));
            const objects = await realpath(await safePath(join(this.directories.blobs, 'objects')));
            if (!sourcePath.startsWith(objects + sep) || !/^[a-f0-9-]{36}$/.test(sourcePath.slice(objects.length + 1))) throw new Error('Blob mapping escapes managed storage');
            const actual = await copyBackupFile(sourcePath, join(temporary, 'blobs', sha));
            if (actual.bytes !== Number(row.bytes) || actual.sha256 !== sha) throw new Error('Source blob checksum mismatch');
            entries.push({ path: 'blobs/' + sha, ...actual });
          }
          progress('manifest');
          const actual = await hashBackupFile(snapshot), file = await open(snapshot, 'r+');
          try { await file.sync(); await file.chmod(0o400); } finally { await file.close(); }
          entries.unshift({ path: BACKUP_DATABASE_FILE, ...actual });
          const manifest: Manifest = { format: 2, id, serviceId: identity(copied), serviceVersion: SERVICE_VERSION, schemaVersion: Number(copied.prepare('PRAGMA user_version').get()!.user_version), createdAt, files: entries, localStateOmitted: true };
          checkDatabase(copied, manifest); const serialized = JSON.stringify(manifest);
          progress('compress');
          total = await createBackupArchive(Buffer.from(serialized), new Map(entries.map(entry => [entry.path, join(temporary, entry.path)])), join(temporary, BACKUP_ZIP_FILE));
          manifestHash = digest(serialized);
        } finally { copied.close(); }
        await rm(join(temporary, 'database'), { recursive: true, force: true, maxRetries: 5 });
        await rm(join(temporary, 'blobs'), { recursive: true, force: true, maxRetries: 5 });
        // Windows refuses renaming a directory containing an open SQLite file.
        progress('commit'); await rename(temporary, final); await syncDir(this.directories.backups);
        this.change(id, 'ready', () => { this.db.prepare("UPDATE backups SET state='ready',bytes=?,sha256=? WHERE id=?").run(total, manifestHash, id); });
        return (await this.list()).find(item => item.id === id)!;
      } catch (error) {
        try { this.change(id, 'failed', () => { this.db.prepare("UPDATE backups SET state='failed' WHERE id=?").run(id); }); }
        catch (stateError) { this.logFailure('create', 'mark_failed', stateError, id); }
        // No automatic cleanup; incomplete dirs are never downloadable.
        throw error;
      }
    };
    if (this.options.maintenance) { this.requireMaintenance(); return work(); }
    if (!this.options.withBlobLease) throw new Error('Online backup requires host GC-exclusion lease');
    return this.options.withBlobLease(work);
  }
  async readDownload(id: string): Promise<{ filename: string; contentType: string; body: Buffer }> {
    // Convenience for existing in-process consumers. HTTP and CLI use the
    // streaming path below and never collect the complete archive in memory.
    const download = await this.openDownload(id);
    try { return { filename: download.filename, contentType: download.contentType, body: Buffer.concat(await download.body.toArray()) }; }
    finally { await download.dispose(); }
  }
  async writeDownload(id: string, destination: string): Promise<number> {
    const download = await this.openDownload(id);
    try {
      return await this.diagnose('download', async progress => {
        progress('write_output'); return writeBackupFile(destination, download.body);
      }, id);
    } finally { await download.dispose(); }
  }
  async openDownload(id: string): Promise<BackupDownload> {
    return this.diagnose('download', async progress => {
      this.requireNotDeleted(id);
      let downloads = preparingDownloads.get(this.db);
      if (!downloads) { downloads = new Map(); preparingDownloads.set(this.db, downloads); }
      downloads.set(id, (downloads.get(id) ?? 0) + 1);
      try { return await this.prepareDownload(id, progress); }
      finally { const count = downloads.get(id)! - 1; if (count) downloads.set(id, count); else downloads.delete(id); }
    }, id);
  }
  private async prepareDownload(id: string, progress: (stage: string) => void): Promise<BackupDownload> {
    identifier(id); const record = (await this.list()).find(item => item.id === id);
    if (!record || record.state !== 'ready' || !record.sha256) throw new Error('Backup is not ready');
    progress('verify');
    const verified = await verify(join(this.directories.backups, id), record.sha256, schemaSignature(this.db));
    let disposed: Promise<void> | undefined;
    const cleanup = () => disposed ??= verified.dispose();
    const owner = this;
    const chunks = async function* () {
      try { yield* backupFileChunks(verified.archive); }
      catch (error) { owner.logFailure('download', 'stream', error, id); throw error; }
      finally { await cleanup(); }
    };
    const body = Readable.from(chunks(), { objectMode: false });
    body.once('close', () => { void cleanup().catch(error => this.logFailure('download', 'cleanup', error, id)); });
    return { filename: id + '.owg-backup.zip', contentType: 'application/zip', bytes: verified.bytes, body, dispose: async () => {
      const stopped = finished(body, { cleanup: true }); body.destroy();
      await stopped.catch(() => undefined); await cleanup();
    } };
  }
  async previewRestore(path: string): Promise<RestorePreview & { sha256: string; serviceId: string }> {
    return this.diagnose('preview_restore', async progress => {
      progress('verify'); const verified = await verify(path, undefined, schemaSignature(this.db));
      try {
        progress('identity', verified.manifest.id);
        if (verified.manifest.serviceId !== identity(this.db)) throw new Error('Restore cannot replace another service identity');
        return { serviceVersion: verified.manifest.serviceVersion, schemaVersion: verified.manifest.schemaVersion, targetServiceVersion: SERVICE_VERSION, targetSchemaVersion: SCHEMA_VERSION, requiresUpgrade: verified.manifest.schemaVersion < SCHEMA_VERSION, backupId: verified.manifest.id, integrity: 'verified', requiresMaintenance: true, invalidatesAllSessions: true, pausesQueuedRuns: true, sha256: verified.sha256, serviceId: verified.manifest.serviceId };
      } finally { await verified.dispose(); }
    });
  }
  async restore(path: string, expectedSha256: string): Promise<void> {
    return this.diagnose('restore', progress => this.restoreVerified(path, expectedSha256, progress));
  }
  private async restoreVerified(path: string, expectedSha256: string, progress: (stage: string, backupId?: string) => void): Promise<void> {
    this.requireMaintenance();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Restore requires preview manifest checksum');
    // Complete integrity/schema/blob validation BEFORE live storage writes.
    // Retain isolated verified files; never reopen untrusted input after validation.
    progress('verify'); const verified = await verify(path, expectedSha256, schemaSignature(this.db));
    try {
      progress('identity', verified.manifest.id);
      if (verified.manifest.serviceId !== identity(this.db)) throw new Error('Restore cannot replace another service identity');
      // Archive files belong to this installation, outside the restored business
      // snapshot. Keep their current catalogue and deletion replay records.
      const catalogue = this.db.prepare('SELECT id,state,created_at,bytes,sha256,path FROM backups').all();
      const deletedBackups = this.db.prepare("SELECT key,request_hash,response,invalidated FROM idempotency WHERE scope='backup.delete'").all();
      await withTemporaryDatabase(verified.files.get(BACKUP_DATABASE_FILE)!, async restored => {
        progress('prepare_database');
        if(verified.manifest.schemaVersion<SCHEMA_VERSION)migrate(restored);
        portableJournal(restored);
        const mappings: [string, string][] = [];
        await privateDir(join(this.directories.blobs, 'objects'));
        progress('restore_blobs');
        for (const [name, source] of verified.files) {
          if (name === BACKUP_DATABASE_FILE) continue;
          const destination = join(this.directories.blobs, 'objects', randomUUID());
          await copyBackupFile(source, destination); mappings.push([name.slice(6), destination]);
        }
        await syncDir(join(this.directories.blobs, 'objects'));
        progress('restore_state'); transaction(restored, () => {
          // Reapply local-state omission before installing the database.
          omitLocalState(restored, Date.now());
          restored.exec("DELETE FROM pairing_codes; UPDATE interactions SET status='expired',version=version+1 WHERE status='pending'; DELETE FROM settings WHERE key IN ('listener','operationsInstance','backupRestorePending'); INSERT INTO settings(key,value) VALUES('backupRestorePending','true'); UPDATE settings SET value='true' WHERE key='acceptingRuns';");
          restored.exec("UPDATE runs SET status=CASE WHEN status IN ('accepted','queued') THEN 'paused_restore' WHEN status IN ('agent_completed','finalizing') THEN 'finalizing' ELSE 'reconciling' END WHERE status NOT IN ('succeeded','failed','cancelled','interrupted','paused_restore');");
          // Persisted backend completion is not backend uncertainty. Continue the
          // local idempotent publication path from retained result/manifest; never
          // ask a fresh unattached backend to reconcile or replay completed work.
          // Unknown active work keeps capacity until reconciled. The scheduler
          // reacquires one shared cross-runtime project lock for active executions.
          // Never make an uncertain backend disappear merely by clearing occupancy.
          restored.exec("DELETE FROM occupancy WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('reconciling','finalizing'));");
          const slots = new Set(restored.prepare('SELECT slot FROM occupancy').all().map(row => Number(row.slot)));
          for (const row of restored.prepare("SELECT id,kind,project_id FROM runs WHERE status IN ('reconciling','finalizing') AND id NOT IN (SELECT run_id FROM occupancy) ORDER BY sequence").all()) {
            let slot = 0; while (slots.has(slot)) slot++; slots.add(slot);
            restored.prepare('INSERT INTO occupancy(run_id,slot,project_id) VALUES(?,?,NULL)').run(String(row.id), slot);
          }
          if (hasTable(restored, 'run_runtime')) restored.prepare('UPDATE run_runtime SET epoch=?,revision=revision+1').run(randomUUID());
          for (const table of ['resource_upload_chunks', 'resource_uploads', 'resource_file_deletions', 'resource_read_leases', 'resource_maintenance_leases']) if (hasTable(restored, table)) restored.exec('DELETE FROM ' + table);
          if (hasTable(restored, 'resource_blob_files')) {
            restored.exec('DELETE FROM resource_blob_files');
            for (const [sha, file] of mappings) restored.prepare('INSERT INTO resource_blob_files(sha256,path) VALUES(?,?)').run(sha, file);
          }
          restored.exec("DELETE FROM backups; DELETE FROM idempotency WHERE scope='backup.delete';");
          for (const row of deletedBackups) {
            restored.prepare("INSERT INTO idempotency(scope,key,request_hash,response,invalidated) VALUES('backup.delete',?,?,?,?)").run(row.key!, row.request_hash!, row.response!, row.invalidated!);
          }
          const localBackups = new Backups(restored, this.directories);
          for (const row of catalogue) {
            const id = String(row.id);
            localBackups.change(id, row.state as Backup['state'], () => {
              restored.prepare('INSERT INTO backups(id,state,created_at,bytes,sha256,path) VALUES(?,?,?,?,?,?)').run(id, row.state!, row.created_at!, row.bytes!, row.sha256!, row.path!);
            });
          }
        });
        checkDatabase(restored, verified.manifest,undefined,true); this.requireMaintenance();
        const source = String(restored.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file), compacted = source + '.portable';
        progress('compact'); await createDatabaseSnapshot(source, compacted);
        // Replace only after checkpointing and closing the owned destination.
        const portable = new DatabaseSync(compacted, { readOnly: true, allowExtension: false });
        progress('apply_database'); try { await replaceDatabase(this.db, this.directories.database, portable); } finally { portable.close(); }
        const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(checkpoint?.busy) !== 0) throw new Error('Restored backup could not clear the destination WAL');
      });
    } finally { await verified.dispose(); }
  }
}
