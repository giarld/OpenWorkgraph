import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { ServiceError } from '../errors.js';
import { safePath } from './files.js';

/** Startup only, before HTTP/runtime dispatch, under exclusive service ownership. */
export function prepareStorageDatabase(db: DatabaseSync): void {
  const mode = Number(db.prepare('PRAGMA auto_vacuum').get()!['auto_vacuum']);
  if (mode === 2) return;
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  if (mode === 0) db.exec('VACUUM');
}

/** Reclaim SQLite's free pages and WAL after logical GC has committed. */
export async function compactStorageDatabase(database: string): Promise<void> {
  await safePath(database);
  const worker = new Worker(new URL('./storage-worker.js', import.meta.url), { workerData: { database } });
  await new Promise<void>((resolve, reject) => {
    let ok = false;
    worker.on('message', result => { ok = result?.ok === true; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && ok ? resolve() : reject(new ServiceError('MAINTENANCE', '存储空间回收暂未完成，请稍后重试。', { retryable: true })));
  });
}
