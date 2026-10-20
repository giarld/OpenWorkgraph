import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

// Only bounded incremental work is safe against the live database: a full
// VACUUM also blocks foreground DatabaseSync writers even when run in a worker.
const { database } = workerData as { database: string };
const busy = (error: unknown) => {
  const code = Number((error as { errcode?: number }).errcode) & 255;
  return code === 5 || code === 6;
};
try {
  // A brief native wait avoids starving behind frequent foreground writes;
  // longer contention is retried asynchronously without pinning the write lock.
  const db = new DatabaseSync(database, { allowExtension: false, timeout: 25 });
  try {
    if (!db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) {
      if (Number(db.prepare('PRAGMA auto_vacuum').get()!['auto_vacuum']) !== 2) throw new Error('Restart to enable incremental reclamation');
      const checkpoint = async () => {
        const deadline = Date.now() + 15_000;
        do {
          // Copy WAL frames without acquiring the writer lock first. Only try
          // truncation once all frames are checkpointed, with only a brief
          // busy wait for readers before releasing foreground writers again.
          try {
            const progress = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
            if (progress['log'] === progress['checkpointed']
              && Number(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.['busy']) === 0) return;
          } catch (error) { if (!busy(error)) throw error; }
          await delay(100);
        } while (Date.now() < deadline);
        throw new Error('Database readers prevented storage reclamation');
      };
      await checkpoint();
      // Bound the cleanup to the free pages observed at its start. Each batch
      // commits and yields so HTTP authentication and task writes can progress.
      let remaining = Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']);
      let deadline = Date.now() + 5000;
      while (remaining > 0) {
        if (db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) break;
        const pages = Math.min(64, remaining);
        try {
          db.exec(`BEGIN IMMEDIATE; PRAGMA incremental_vacuum(${pages}); COMMIT`);
          remaining -= pages;
          deadline = Date.now() + 5000;
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          if (!busy(error) || Date.now() >= deadline) throw error;
        }
        await delay(1);
      }
      if (!db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup' LIMIT 1").get()) await checkpoint();
    }
  } finally { db.close(); }
  parentPort!.postMessage({ ok: true });
} catch { parentPort!.postMessage({ ok: false }); }
