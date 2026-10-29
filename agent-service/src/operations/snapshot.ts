import { Worker } from 'node:worker_threads';
import { safePath } from './files.js';

export async function createDatabaseSnapshot(source: string, destination: string): Promise<void> {
  await safePath(source); await safePath(destination, true);
  const worker = new Worker(new URL('./snapshot-worker.js', import.meta.url), { workerData: { source, destination } });
  await new Promise<void>((done, reject) => {
    let ok = false;
    let failure: Error | undefined;
    worker.on('message', result => {
      ok = result?.ok === true;
      if (!ok && result?.error) {
        const cause = new Error(String(result.error.message));
        cause.name = String(result.error.name);
        if (typeof result.error.stack === 'string') cause.stack = result.error.stack;
        if (typeof result.error.code === 'string') (cause as NodeJS.ErrnoException).code = result.error.code;
        failure = new Error('SQLite snapshot worker failed: ' + cause.message, { cause });
      }
    });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && ok ? done() : reject(failure ?? new Error('SQLite snapshot worker failed (exit ' + code + ')')));
  });
}
