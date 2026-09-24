import { Worker } from 'node:worker_threads';
import { safePath } from './files.js';

export async function createDatabaseSnapshot(source: string, destination: string): Promise<void> {
  await safePath(source); await safePath(destination, true);
  const worker = new Worker(new URL('./snapshot-worker.js', import.meta.url), { workerData: { source, destination } });
  await new Promise<void>((done, reject) => {
    let ok = false;
    worker.on('message', result => { ok = result?.ok === true; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && ok ? done() : reject(new Error('SQLite snapshot worker failed')));
  });
}
