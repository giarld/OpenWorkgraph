import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
export interface PasteQueueState {
  count: number;
  running: boolean;
  error?: string;
  warning?: string;
  progress?: { completed: number; total: number };
}

/** One immutable clipboard snapshot per intent, one placement at a time.
 * A failure aborts the failed intent and all later queued work. */
export class PasteQueue {
  private jobs: Array<(progress: (completed: number, total: number) => void) => Promise<void>> = [];
  private listeners = new Set<() => void>();
  private disposed = false;
  private state: PasteQueueState = { count: 0, running: false };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<PasteQueueState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, count: this.jobs.length };
    for (const listener of this.listeners) listener();
  }
  enqueue(job: (progress: (completed: number, total: number) => void) => Promise<void>) {
    if (this.disposed) return;
    if (this.jobs.length >= 20) { this.emit({ warning: translate("The paste queue is full. Wait for the current batch to finish.") }); return; }
    this.jobs.push(job);
    this.emit({ error: undefined });
    void this.drain();
  }
  dispose() { this.disposed = true; this.jobs = []; this.listeners.clear(); }
  private async drain() {
    if (this.disposed || this.state.running) return;
    this.emit({ running: true });
    try {
      while (this.jobs.length && !this.disposed) {
        this.emit({ progress: undefined, warning: undefined });
        await this.jobs[0]((completed, total) => this.emit({ progress: { completed, total } }));
        if (this.disposed) return;
        this.jobs.shift();
        this.emit({});
      }
    } catch (error) {
      this.jobs = [];
      this.emit({ error: error instanceof Error ? error.message : String(error) });
    } finally { this.emit({ running: false, ...(this.jobs.length ? {} : { progress: undefined, warning: undefined }) }); }
  }
}
