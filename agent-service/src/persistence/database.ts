import { DatabaseSync } from 'node:sqlite';
import { ServiceError } from '../errors.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import type { Migration } from './schema.js';
import { randomUUID } from 'node:crypto';
/** Nest safely in auth/business transactions without committing the caller's work. */
export function atomic<T>(db: DatabaseSync, work: () => T): T {
  if (!db.isTransaction) return transaction(db,work);
  const name='op_'+randomUUID().replaceAll('-',''); db.exec(`SAVEPOINT ${name}`);
  try { const result=work(); if (result && typeof (result as {then?:unknown}).then==='function') throw new Error('Transactions must be synchronous'); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Transactions must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  transaction(db, () => {
    const version = Number(db.prepare('PRAGMA user_version').get()!['user_version']);
    if (version > SCHEMA_VERSION || version < 0) throw new ServiceError('SCHEMA_UNSUPPORTED', `Unsupported database schema ${version}; expected 0..${SCHEMA_VERSION}`);
    if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new ServiceError('SCHEMA_UNSUPPORTED', 'Unversioned nonempty database; refusing to overwrite');
    if (version > 0) {
      for (const table of ['identity','settings','sessions','pairing_codes']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new ServiceError('SCHEMA_UNSUPPORTED', `Missing schema table ${table}`);
      }
    }
    for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
      const migration = migrations.find(item => item.version === next);
      if (!migration) throw new ServiceError('SCHEMA_UNSUPPORTED', `Missing migration ${next}`);
      try { db.exec(migration.sql); db.exec(`PRAGMA user_version = ${next}`); }
      catch (cause) { throw new ServiceError('MIGRATION_FAILED', `Migration ${next} failed; database unchanged`, { cause }); }
    }
    for (const table of ['identity','settings','sessions','pairing_codes','projects','graphs','nodes','node_versions','edges','blobs','assets','asset_versions','runs','snapshots','outputs','asset_references','events','interactions','occupancy','idempotency','plugin_contracts','backups','trusted_origins','canvas_resources','canvas_resource_versions','canvas_resource_references','canvas_outputs']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new ServiceError('SCHEMA_UNSUPPORTED', `Missing schema table ${table}`);
    }
    for (const table of ['execution_input_snapshots','execution_outputs','project_file_bindings','project_file_observations','project_file_outputs','node_resource_history','graph_groups','group_members','run_runtime','run_process_records','run_notifications','generation_candidates','publication_manifests','resource_uploads','resource_upload_chunks','resource_blob_files','resource_file_deletions','resource_read_leases','resource_maintenance_leases']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new ServiceError('SCHEMA_UNSUPPORTED', `Missing schema table ${table}`);
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new ServiceError('SCHEMA_UNSUPPORTED', 'Database has foreign key violations');
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_version_schemas'").get())throw new ServiceError('SCHEMA_UNSUPPORTED','Missing node version schema history');
    for (const table of ['image_providers','image_provider_models','image_provider_config_versions','image_provider_revoked_credentials']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new ServiceError('SCHEMA_UNSUPPORTED', 'Missing image provider directory');
  });
}
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000, allowExtension: false });
  try { migrate(db, migrations); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); return db; }
  catch (error) { db.close(); throw error; }
}
