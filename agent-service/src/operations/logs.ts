import { join } from 'node:path';
import { atomicJson, readSafe } from './files.js';

const events = ['started', 'draining', 'interrupting', 'stopped', 'startup_failed', 'shutdown_failed', 'backup_ready', 'backup_failed', 'restored'] as const;
type LogEvent = typeof events[number];
interface Entry { time: string; event: LogEvent }
/** Allowlist, not regex redaction: never persist prompts, paths, tokens, backend
 * stdout or arbitrary errors. Both entry count and read size are bounded. */
export class OperationsLog {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  async read(): Promise<Entry[]> {
    try {
      const data: unknown = JSON.parse((await readSafe(join(this.root, 'operations-log.json'), 65536)).toString());
      if (!Array.isArray(data)) return [];
      return data.filter((v): v is Entry => !!v && typeof v === 'object' && events.includes(v.event as LogEvent) && typeof v.time === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v.time)).slice(-256).map(v => ({ time: v.time, event: v.event }));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  append(event: LogEvent): Promise<void> {
    if (!events.includes(event)) return Promise.reject(new Error('Unknown lifecycle event'));
    const task = this.pending.then(async () => {
      const entries = await this.read(); entries.push({ time: new Date().toISOString(), event });
      await atomicJson(join(this.root, 'operations-log.json'), entries.slice(-256));
    });
    this.pending = task.catch(() => {}); return task;
  }
}
