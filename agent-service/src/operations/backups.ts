import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { lstat, mkdtemp, rename, rm, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Backup, RestorePreview } from '@openworkgraph/protocol';
import type { DataDirectories } from '../directories.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../persistence/schema.js';
import { atomic, migrate, transaction } from '../persistence/database.js';
import { Repositories } from '../persistence/repositories.js';
import { digest, identifier, privateDir, readSafe, safePath, syncDir, writeNew } from './files.js';
import type { OperationsLock } from './lifecycle.js';
import { createDatabaseSnapshot } from './snapshot.js';
import { ServiceError } from '../errors.js';

export interface BackupOptions {
  /** Host excludes ALL blob GC until copies finish, including queued deletions. */
  withBlobLease?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Offline caller holds the same lock used by serve until DB closes. */
  maintenance?: OperationsLock;
}
interface FileEntry { path: string; sha256: string; bytes: number }
interface Manifest { format: 1; id: string; serviceId: string; schemaVersion: number; createdAt: string; files: FileEntry[] }
interface Verified { manifest: Manifest; sha256: string; bytes: number; files: Map<string, Buffer> }
const MAX_ARCHIVE = 512 * 1024 * 1024;
const pendingBackups = new WeakMap<DatabaseSync, Set<Promise<Backup>>>();
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
const validFile = (path: string): boolean => path === 'service.sqlite' || /^blobs[/][a-f0-9]{64}$/.test(path);
const hasTable = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
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
  const expected = new Map(manifest.files.filter(f => f.path !== 'service.sqlite').map(f => [f.path.slice(6), f]));
  const rows = db.prepare('SELECT sha256,bytes FROM blobs').all();
  if (rows.length !== expected.size || rows.some(row => expected.get(String(row.sha256))?.bytes !== Number(row.bytes))) throw new Error('Manifest does not cover database blobs exactly');
  for (const name of ['sessions', 'pairing_codes', 'settings', 'runs', 'backups', 'occupancy', 'interactions']) if (!hasTable(db, name)) throw new Error('Incomplete backup schema');
}
async function withTemporaryDatabase<T>(bytes: Buffer, work: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'workgraph-verify-'));
  try {
    const path = join(temporary, 'service.sqlite'); await writeNew(path, bytes, 0o600);
    const db = new DatabaseSync(path, { allowExtension: false });
    try { db.exec('PRAGMA trusted_schema=OFF'); return await work(db); } finally { db.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function verify(path: string, expectedHash?: string, schema?: string): Promise<Verified> {
  const source = await safePath(path); const files = new Map<string, Buffer>();
  let manifestBytes: Buffer;
  let archive: { format: unknown; manifest: string; files: Record<string, string> } | undefined;
  if ((await lstat(source)).isDirectory()) manifestBytes = await readSafe(join(source, 'manifest.json'), 8 * 1024 * 1024);
  else {
    archive = JSON.parse((await readSafe(source, MAX_ARCHIVE)).toString()) as typeof archive;
    if (!archive || archive.format !== 'openworkgraph-backup-1' || typeof archive.manifest !== 'string' || !archive.files || typeof archive.files !== 'object' || Array.isArray(archive.files)) throw new Error('Invalid backup download');
    manifestBytes = Buffer.from(archive.manifest, 'base64');
  }
  const hash = digest(manifestBytes);
  if (expectedHash !== undefined && hash !== expectedHash) throw new Error('Backup manifest checksum mismatch');
  const manifest = JSON.parse(manifestBytes.toString()) as Manifest;
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || typeof manifest.serviceId !== 'string' || typeof manifest.createdAt !== 'string' || !Number.isInteger(manifest.schemaVersion)) throw new Error('Invalid backup manifest');
  identifier(manifest.id); let total = manifestBytes.length;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !validFile(entry.path) || files.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Unsafe backup manifest entry');
    total += entry.bytes; if (total > MAX_ARCHIVE) throw new Error('Backup exceeds verification limit');
    const encoded = archive?.files[entry.path];
    if (archive && typeof encoded !== 'string') throw new Error('Missing backup file');
    const bytes = archive ? Buffer.from(encoded!, 'base64') : await readSafe(join(source, entry.path), entry.bytes);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256 || (entry.path.startsWith('blobs/') && entry.sha256 !== entry.path.slice(6))) throw new Error('Backup content checksum mismatch');
    files.set(entry.path, bytes);
  }
  if (!files.has('service.sqlite') || (archive && Object.keys(archive.files).length !== files.size)) throw new Error('Incomplete or extra backup content');
  await withTemporaryDatabase(files.get('service.sqlite')!, async db => {
    checkDatabase(db,manifest,schema);
    if(manifest.schemaVersion<SCHEMA_VERSION){migrate(db);checkDatabase(db,manifest,undefined,true);}
  });
  return { manifest, sha256: hash, bytes: total, files };
}

/** Only create/list/download may be wired to HTTP. Restore is local CLI only. */
export class Backups {
  constructor(readonly db: DatabaseSync, readonly directories: DataDirectories, readonly options: BackupOptions = {}) {}
  /** Startup only, before HTTP/runtime dispatch, under exclusive service ownership.
   * Reconcile committed directories only; incomplete staging is retained for diagnosis. */
  async recoverCreating(lock: OperationsLock): Promise<void> {
    const requireOwnership = () => {
      const file = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
      if (!lock.held || lock.root !== this.directories.root || file !== join(lock.root, 'service.sqlite') || pendingBackups.get(this.db)?.size) throw new Error('Backup recovery requires matching exclusive startup ownership and no pending backups');
    };
    requireOwnership();
    const schema = schemaSignature(this.db), serviceId = identity(this.db);
    for (const row of this.db.prepare("SELECT id,path,created_at FROM backups WHERE state='creating'").all()) {
      let recovered: Verified | undefined;
      try {
        const id = identifier(String(row.id)), path = join(this.directories.backups, id);
        if (row.path !== path) throw new Error('Backup catalogue path mismatch');
        const verified = await verify(path, undefined, schema);
        if (verified.manifest.id !== id || verified.manifest.serviceId !== serviceId || verified.manifest.createdAt !== row.created_at) throw new Error('Backup catalogue identity mismatch');
        recovered = verified;
      } catch { /* Missing/incomplete/invalid files cannot become downloadable. */ }
      requireOwnership();
      const state = recovered ? 'ready' : 'failed';
      atomic(this.db, () => {
        if (this.db.prepare('SELECT state FROM backups WHERE id=?').get(row.id!)?.state !== 'creating') throw new Error('Backup changed during startup recovery');
        this.change(String(row.id), state, () => {
          this.db.prepare('UPDATE backups SET state=?,bytes=?,sha256=? WHERE id=?').run(state, recovered?.bytes ?? null, recovered?.sha256 ?? null, row.id!);
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
  async create(idempotencyKey: string = randomUUID()): Promise<Backup> {
    if (!this.options.maintenance && this.db.prepare("SELECT value FROM settings WHERE key='acceptingRuns'").get()?.value !== 'true') throw new ServiceError('MAINTENANCE', 'Service is draining; new backups are unavailable');
    let pending = pendingBackups.get(this.db);
    if (!pending) { pending = new Set(); pendingBackups.set(this.db, pending); }
    const operation = this.createSnapshot(idempotencyKey); pending.add(operation);
    try { return await operation; } finally { pending.delete(operation); }
  }
  private async createSnapshot(idempotencyKey: string): Promise<Backup> {
    identifier(idempotencyKey);
    const id = digest(identity(this.db) + ':' + idempotencyKey);
    const old = (await this.list()).find(item => item.id === id); if (old) return old;
    const work = async (): Promise<Backup> => {
      // No asynchronous gap between the authoritative retry check and insert.
      const exists = this.db.prepare('SELECT 1 FROM backups WHERE id=?').get(id);
      if (exists) return (await this.list()).find(item => item.id === id)!;
      const createdAt = new Date().toISOString(); const final = join(this.directories.backups, id);
      const temporary = join(this.directories.backups, '.' + id + '.' + randomUUID());
      this.change(id, 'creating', () => { this.db.prepare("INSERT INTO backups(id,state,created_at,path) VALUES(?,'creating',?,?)").run(id, createdAt, final); });
      try {
        await privateDir(temporary); await privateDir(join(temporary, 'blobs'));
        const snapshot = join(temporary, 'service.sqlite');
        // One SQLite consistent snapshot including WAL, under host GC exclusion.
        await createDatabaseSnapshot(this.directories.database, snapshot);
        const copied = new DatabaseSync(snapshot, { readOnly: true, allowExtension: false });
        let total: number, manifestHash: string;
        try {
          const entries: FileEntry[] = [];
          for (const row of copied.prepare('SELECT sha256,bytes FROM blobs ORDER BY sha256').all()) {
            const sha = String(row.sha256); if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid blob hash');
            const stored = hasTable(copied, 'resource_blob_files') ? copied.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(sha) : undefined;
            if (!stored) throw new Error('Blob has no immutable file mapping');
            // Normalize Windows 8.3 aliases on both sides after rejecting links.
            const sourcePath = await realpath(await safePath(String(stored.path)));
            const objects = await realpath(await safePath(join(this.directories.blobs, 'objects')));
            if (!sourcePath.startsWith(objects + sep) || !/^[a-f0-9-]{36}$/.test(sourcePath.slice(objects.length + 1))) throw new Error('Blob mapping escapes managed storage');
            const bytes = await readSafe(sourcePath, Number(row.bytes));
            if (bytes.length !== Number(row.bytes) || digest(bytes) !== sha) throw new Error('Source blob checksum mismatch');
            await writeNew(join(temporary, 'blobs', sha), bytes); entries.push({ path: 'blobs/' + sha, sha256: sha, bytes: bytes.length });
          }
          const bytes = await readSafe(snapshot), file = await open(snapshot, 'r+');
          try { await file.sync(); await file.chmod(0o400); } finally { await file.close(); }
          entries.unshift({ path: 'service.sqlite', bytes: bytes.length, sha256: digest(bytes) });
          const manifest: Manifest = { format: 1, id, serviceId: identity(copied), schemaVersion: Number(copied.prepare('PRAGMA user_version').get()!.user_version), createdAt, files: entries };
          checkDatabase(copied, manifest); const serialized = JSON.stringify(manifest);
          const encodedBytes = 4 * Math.ceil(Buffer.byteLength(serialized) / 3) + entries.reduce((total, entry) => total + 4 * Math.ceil(entry.bytes / 3) + Buffer.byteLength(JSON.stringify(entry.path)) + 4, 0) + 128;
          if (encodedBytes > MAX_ARCHIVE) throw new Error('Backup exceeds bounded portable archive limit');
          await writeNew(join(temporary, 'manifest.json'), serialized);
          await syncDir(join(temporary, 'blobs')); await syncDir(temporary);
          total = entries.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(serialized));
          manifestHash = digest(serialized);
        } finally { copied.close(); }
        // Windows refuses renaming a directory containing an open SQLite file.
        await rename(temporary, final); await syncDir(this.directories.backups);
        this.change(id, 'ready', () => { this.db.prepare("UPDATE backups SET state='ready',bytes=?,sha256=? WHERE id=?").run(total, manifestHash, id); });
        return (await this.list()).find(item => item.id === id)!;
      } catch (error) {
        this.change(id, 'failed', () => { this.db.prepare("UPDATE backups SET state='failed' WHERE id=?").run(id); });
        // No automatic cleanup; incomplete dirs are never downloadable.
        throw error;
      }
    };
    if (this.options.maintenance) { this.requireMaintenance(); return work(); }
    if (!this.options.withBlobLease) throw new Error('Online backup requires host GC-exclusion lease');
    return this.options.withBlobLease(work);
  }
  async readDownload(id: string): Promise<{ filename: string; contentType: string; body: Buffer }> {
    identifier(id); const record = (await this.list()).find(item => item.id === id);
    if (!record || record.state !== 'ready' || !record.sha256) throw new Error('Backup is not ready');
    const path = join(this.directories.backups, id), verified = await verify(path, record.sha256, schemaSignature(this.db));
    const manifest = await readSafe(join(path, 'manifest.json'));
    const body = Buffer.from(JSON.stringify({ format: 'openworkgraph-backup-1', manifest: manifest.toString('base64'), files: Object.fromEntries([...verified.files].map(([name, bytes]) => [name, bytes.toString('base64')])) }));
    if (body.length > MAX_ARCHIVE) throw new Error('Download exceeds bounded archive limit');
    return { filename: id + '.owg-backup', contentType: 'application/vnd.openworkgraph.backup+json', body };
  }
  async previewRestore(path: string): Promise<RestorePreview & { sha256: string; serviceId: string }> {
    const verified = await verify(path, undefined, schemaSignature(this.db));
    if (verified.manifest.serviceId !== identity(this.db)) throw new Error('Restore cannot replace another service identity');
    return { backupId: verified.manifest.id, integrity: 'verified', requiresMaintenance: true, invalidatesAllSessions: true, pausesQueuedRuns: true, sha256: verified.sha256, serviceId: verified.manifest.serviceId };
  }
  async restore(path: string, expectedSha256: string): Promise<void> {
    this.requireMaintenance();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Restore requires preview manifest checksum');
    // Complete integrity/schema/blob validation BEFORE live storage writes.
    // Retain verified bytes; never reopen untrusted input after validation.
    const verified = await verify(path, expectedSha256, schemaSignature(this.db));
    if (verified.manifest.serviceId !== identity(this.db)) throw new Error('Restore cannot replace another service identity');
    await withTemporaryDatabase(verified.files.get('service.sqlite')!, async restored => {
      if(verified.manifest.schemaVersion<SCHEMA_VERSION)migrate(restored);
      const mappings: [string, string][] = [];
      await privateDir(join(this.directories.blobs, 'objects'));
      for (const [name, bytes] of verified.files) {
        if (name === 'service.sqlite') continue;
        const destination = join(this.directories.blobs, 'objects', randomUUID());
        await writeNew(destination, bytes); mappings.push([name.slice(6), destination]);
      }
      await syncDir(join(this.directories.blobs, 'objects'));
      transaction(restored, () => {
        // Every imported token is revoked on EVERY restore, even old tombstones.
        restored.prepare('UPDATE sessions SET revoked_at=?').run(Date.now());
        if (hasTable(restored,'image_provider_revoked_credentials')) {
          for (const row of restored.prepare('SELECT id,credential_counter FROM image_providers').all()) {
            for (let revision=1;revision<=Number(row.credential_counter);revision++) restored.prepare('INSERT OR IGNORE INTO image_provider_revoked_credentials(provider_id,revision) VALUES(?,?)').run(String(row.id),revision);
          }
          restored.exec('UPDATE image_providers SET credential_revision=NULL; UPDATE image_provider_models SET verified_at=NULL;');
        }
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
        // Embedded catalogue rows may describe absent/incomplete directories.
        for (const row of restored.prepare("SELECT id FROM backups WHERE state!='failed'").all()) {
          const id = String(row.id); restored.prepare("UPDATE backups SET state='failed' WHERE id=?").run(id);
          new Repositories(restored).appendEvent({ eventId: randomUUID(), type: 'backup.changed', projectId: null, graphId: null, entityId: id, revision: 2, occurredAt: new Date().toISOString(), payload: { backupId: id, state: 'failed', reason: 'restored_catalogue_requires_local_revalidation' } });
        }
      });
      checkDatabase(restored, verified.manifest,undefined,true); this.requireMaintenance();
      // SQLite replaces destination transactionally, not main-file rename over WAL.
      await backup(restored, this.directories.database);
    });
  }
}
