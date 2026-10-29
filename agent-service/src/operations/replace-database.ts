import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { copyBackupFile } from './backup-files.js';
import { syncDir } from './files.js';
import { acquireDatabaseAccess } from './database-access.js';

/** Exclusive root ownership and drained HTTP/runtime are mandatory. Stage a
 * complete flushed database on the same volume, checkpoint/close the owned
 * connection, then atomically replace it. Never rename over a live WAL. The
 * DatabaseSync object is reopened so callers retain their existing reference. */
export async function replaceDatabase(db: DatabaseSync, path: string, source: DatabaseSync): Promise<void> {
  if (db.isTransaction || source.isTransaction) throw new Error('Database replacement requires no active transaction');
  if (source.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new Error('Database replacement requires an isolated database without WAL');
  const file = String(source.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file);
  const staged = path + '.restore-' + randomUUID() + '.tmp';
  const access = await acquireDatabaseAccess(dirname(path));
  try {
    await copyBackupFile(file, staged, 0o600);
    if (Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy) !== 0) throw new Error('Database replacement could not checkpoint the destination WAL');
    db.close();
    try { await rename(staged, path); await syncDir(dirname(path)); }
    finally { db.open(); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); }
  } finally {
    try { await rm(staged, { force: true, maxRetries: 5 }); }
    finally { await access.release(); }
  }
}
