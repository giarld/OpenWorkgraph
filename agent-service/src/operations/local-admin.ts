import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { initializeDirectories } from '../directories.js';
import { Backups } from './backups.js';
import { acquireOperationsLock, rootPath } from './lifecycle.js';
import { safePath } from './files.js';
import { RuntimeLogger } from '../logger.js';
import { readRestoreState } from './restore-state.js';
import { ServiceError } from '../errors.js';
import { acquireDatabaseAccess } from './database-access.js';

/** A persisted recovery lock must not prevent inspecting a recovery backup.
 * Bypass it only after acquiring the stopped workspace's exclusive ownership. */
export async function previewBackupRestore(dataDir: string | undefined, path: string) {
  const preview = (backups: Backups) => backups.previewRestore(path);
  try { return await withReadBackups(dataDir, preview); }
  catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'MAINTENANCE') throw error;
    return withOfflineBackups(dataDir, preview);
  }
}

/** Opens only an EXISTING data directory. No migration or initialization of DB
 * precedes restore verification. The entire local operation excludes serve. */
export async function withOfflineBackups<T>(dataDir: string | undefined, work: (backups: Backups) => Promise<T>): Promise<T> {
  const lock = await acquireOperationsLock(dataDir);
  try {
    await safePath(join(lock.root, 'service.sqlite'));
    const directories = initializeDirectories(lock.root);
    const db = new DatabaseSync(directories.database, { allowExtension: false, timeout: 5000 });
    let logger: RuntimeLogger | undefined;
    try { logger = await RuntimeLogger.create(lock.root, false); return await work(new Backups(db, directories, { maintenance: lock, logger })); }
    finally { logger?.close(); db.close(); }
  } finally { await lock.release(); }
}

/** Read-only catalogue/downloads are allowed while the owning service runs.
 * Hold database access until the connection closes, including asynchronous work. */
export async function withReadBackups<T>(dataDir: string | undefined, work: (backups: Backups) => Promise<T>): Promise<T> {
  const root = await safePath(rootPath(dataDir)), database = await safePath(join(root, 'service.sqlite'));
  const requireReadable = () => {
    if (readRestoreState(root).blocked) throw new ServiceError('MAINTENANCE', '工作空间正在恢复或等待本机恢复，请稍后重试。');
  };
  const access = await acquireDatabaseAccess(root, requireReadable);
  try {
    // Restore may have started while this process waited for another CLI reader.
    requireReadable();
    const directories = { root, database, config: join(root, 'config'), blobs: join(root, 'blobs'), staging: join(root, 'staging'), runs: join(root, 'runs'), backups: join(root, 'backups') };
    const db = new DatabaseSync(database, { readOnly: true, allowExtension: false, timeout: 5000 });
    let logger: RuntimeLogger | undefined;
    try { logger = await RuntimeLogger.create(root, false); return await work(new Backups(db, directories, { logger })); } finally { logger?.close(); db.close(); }
  } finally { await access.release(); }
}
