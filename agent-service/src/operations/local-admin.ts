import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { initializeDirectories } from '../directories.js';
import { Backups } from './backups.js';
import { acquireOperationsLock, rootPath } from './lifecycle.js';
import { safePath } from './files.js';

/** Opens only an EXISTING data directory. No migration or initialization of DB
 * precedes restore verification. The entire local operation excludes serve. */
export async function withOfflineBackups<T>(dataDir: string | undefined, work: (backups: Backups) => Promise<T>): Promise<T> {
  const lock = await acquireOperationsLock(dataDir);
  try {
    await safePath(join(lock.root, 'service.sqlite'));
    const directories = initializeDirectories(lock.root);
    const db = new DatabaseSync(directories.database, { allowExtension: false, timeout: 5000 });
    try { return await work(new Backups(db, directories, { maintenance: lock })); }
    finally { db.close(); }
  } finally { await lock.release(); }
}

/** Read-only catalogue/downloads are allowed while the owning service runs. */
export async function withReadBackups<T>(dataDir: string | undefined, work: (backups: Backups) => Promise<T>): Promise<T> {
  const root = await safePath(rootPath(dataDir)), database = await safePath(join(root, 'service.sqlite'));
  const directories = { root, database, config: join(root, 'config'), blobs: join(root, 'blobs'), staging: join(root, 'staging'), runs: join(root, 'runs'), backups: join(root, 'backups') };
  const db = new DatabaseSync(database, { readOnly: true, allowExtension: false, timeout: 5000 });
  try { return await work(new Backups(db, directories)); } finally { db.close(); }
}
