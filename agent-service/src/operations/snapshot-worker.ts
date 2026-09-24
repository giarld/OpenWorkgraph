import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

// Dedicated worker: a large VACUUM must not block HTTP interactions/cancellation.
const { source, destination } = workerData as { source: string; destination: string };
try {
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false, timeout: 5000 });
  try { db.prepare('VACUUM INTO ?').run(destination); } finally { db.close(); }
  parentPort!.postMessage({ ok: true });
} catch { parentPort!.postMessage({ ok: false }); }
