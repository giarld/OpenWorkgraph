import { randomUUID } from 'node:crypto';
import { isTerminalRunStatus } from '@openworkgraph/protocol';
import type { InputSnapshot, Interaction, Json, Run } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { Runs } from './runs.js';
import type { RunToken } from './runs.js';

export type BackendEvent =
  | { type: 'started'; identity?: { [key: string]: Json } }
  | { type: 'progress'; payload: Json }
  | { type: 'question' | 'approval'; id: string; payload: Json }
  | { type: 'completed'; result: Json }
  | { type: 'failed'; error: string }
  | { type: 'stopped' };
export interface BackendContext { epoch: string; emit: (event: BackendEvent) => void }
export type ReconcileResult = 'unknown' | 'interrupted' | 'resumed';
/** A rejected transport call is NOT proof that a backend stopped. */
export interface SchedulerBackend {
  start(run: Run, snapshot: InputSnapshot, context: BackendContext): Promise<void>;
  cancel(run: Run, context: BackendContext): Promise<'confirmed' | 'unknown'>;
  reply?(run: Run, interaction: Interaction, answer: Json, context: BackendContext): Promise<void>;
  reconcile?(run: Run, context: BackendContext): Promise<ReconcileResult>;
}
export interface SchedulerOptions {
  epoch?: string;
  /** Injectable monotonic-enough wall clock for bounded publication retries. */
  now?: () => number;
  /** Must publish and transition finalizing -> succeeded in the SAME database txn.
   * Replayed after crashes; manifest/hash/publication-key validation belongs here. */
  publish?: (run: Run, token: RunToken) => Promise<void> | void;
  /** Lifetime lock, released only after durable terminal state. Undefined means busy. */
  acquireProjectLock?: (run: Run, canonicalPath: string) => Promise<(() => void) | undefined>;
}

export class Scheduler {
  readonly epoch: string;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();
  private readonly lockAcquisitions = new Map<string, Promise<boolean>>();
  private readonly pendingReplies = new Set<string>();
  private readonly replyBuffers = new Map<string, BackendEvent[]>();
  private readonly contendedProjects = new Set<string>();
  private readonly publicationRetries = new Map<string, { attempts: number; nextAt: number; message: string; recordedAt: number }>();
  private ticking = false;
  private dispatched = false;
  get isUnstarted(): boolean { return !this.dispatched && !this.ticking && !this.jobs.size && !this.releases.size && !this.lockAcquisitions.size; }
  constructor(readonly runs: Runs, readonly backend: SchedulerBackend, readonly options: SchedulerOptions = {}) { this.epoch = options.epoch ?? randomUUID(); }
  private context(id: string): BackendContext { return { epoch: this.epoch, emit: event => this.emit(id, event) }; }
  private owned(id: string): boolean { return this.runs.db.prepare('SELECT epoch FROM run_runtime WHERE run_id=?').get(id)?.['epoch'] === this.epoch; }
  private lockScope(run: Run): { key: string; canonicalPath: string } | undefined {
    const runtime = this.runs.runtime(run.id);
    if (runtime.details.kind !== 'execution' || !this.options.acquireProjectLock) return undefined;
    const canonicalPath = String(runtime.details.canonicalPath);
    // The kernel lock excludes other runtimes, not independent runs in this
    // scheduler. Concurrent runs (including different batches) share it.
    return { key: canonicalPath, canonicalPath };
  }
  private activeProjectRuns(canonicalPath: string): boolean {
    return Boolean(this.runs.db.prepare(`SELECT 1 FROM occupancy o JOIN run_runtime rt ON rt.run_id=o.run_id
      WHERE rt.epoch=? AND json_extract(rt.details,'$.kind')='execution'
        AND json_extract(rt.details,'$.canonicalPath')=? LIMIT 1`).get(this.epoch, canonicalPath));
  }
  private release(id: string): void {
    const run = this.runs.get(id), scope = this.lockScope(run);
    if (!scope || this.activeProjectRuns(scope.canonicalPath)) return;
    const release = this.releases.get(scope.key);
    if (release) {
      release(); this.releases.delete(scope.key);
    }
  }
  private launch(key: string, work: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const job = Promise.resolve().then(work).catch(error => {
      const id = key.split(':')[1];
      if (id && this.owned(id)) this.runs.record(id, 'scheduler.error', { message: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
  }
  private deferPublication(id: string, error: unknown): void {
    if (!this.owned(id)) return;
    const now = this.options.now?.() ?? Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.publicationRetries.get(id);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, 16);
    const recordedAt = previous?.recordedAt ?? now;
    if (!previous || previous.message !== message || now - previous.recordedAt >= 30_000) {
      this.runs.record(id, 'scheduler.error', { message });
    }
    this.publicationRetries.set(id, {
      attempts,
      nextAt: now + Math.min(30_000, 250 * 2 ** (attempts - 1)),
      message,
      recordedAt: !previous || previous.message !== message || now - previous.recordedAt >= 30_000 ? now : recordedAt,
    });
  }
  private uncertain(id: string, error: unknown): void {
    if (!this.owned(id)) return;
    const run = this.runs.get(id);
    if (isTerminalRunStatus(run.status) || ['reconciling', 'finalizing'].includes(run.status)) return;
    this.runs.transition(id, this.runs.runtime(id), 'reconciling', { uncertainty: error instanceof Error ? error.message : String(error) });
  }
  /** Epoch fencing plus state checks discard late success after cancellation/recovery. */
  private emit(id: string, event: BackendEvent): void {
    if (!this.owned(id)) return;
    const run = this.runs.get(id); const runtime = this.runs.runtime(id);
    if (isTerminalRunStatus(run.status)) return;
    if (runtime.details.cancelRequested === true && event.type !== 'stopped' && event.type !== 'progress') return;
    const buffer = this.replyBuffers.get(id);
    if (buffer && ['started', 'completed'].includes(event.type)) { buffer.push(event); return; }
    switch (event.type) {
      case 'started':
        if (run.status === 'preparing') this.runs.transition(id, runtime, 'running', { backendIdentity: event.identity ?? {} });
        break;
      case 'progress': this.runs.record(id, 'backend.progress', event.payload); break;
      case 'question': case 'approval':
        if (['running', 'waiting_answer', 'waiting_approval'].includes(run.status)) this.runs.openInteraction(id, runtime, event.type === 'question' ? 'question' : 'approval', event.payload, event.id);
        break;
      case 'completed':
        if (this.runs.activeInteraction(id)) this.runs.transition(id, runtime, 'reconciling', { uncertainty: 'Backend completed with unresolved independent actions', unresolvedCompletion: true });
        else if (run.status === 'running') this.runs.transition(id, runtime, 'agent_completed', { result: event.result });
        break;
      case 'failed':
        if (['preparing', 'running', 'waiting_answer', 'waiting_approval'].includes(run.status)) this.runs.transition(id, runtime, 'failed', { error: event.error });
        break;
      case 'stopped':
        if (run.status === 'cancelling') this.runs.transition(id, runtime, 'cancelled');
        else if (run.status === 'reconciling' && runtime.details.cancelRequested === true) {
          this.runs.transition(id, runtime, 'cancelling'); this.runs.transition(id, this.runs.runtime(id), 'cancelled');
        }
        break;
    }
    if (isTerminalRunStatus(this.runs.get(id).status)) this.release(id);
  }
  private async start(run: Run): Promise<void> {
    try {
      if (!await this.ensureProjectLock(run)) {
        if (!this.owned(run.id)) return;
        if (this.runs.get(run.id).status === 'cancelling') this.emit(run.id, { type: 'stopped' });
        else if (this.runs.get(run.id).status === 'preparing') this.runs.requeueUnstarted(run.id, this.runs.runtime(run.id));
        this.contendedProjects.add(run.projectId);
        // Refill immediately even with capacity=1; retry this project next tick.
        this.dispatch();
        return;
      }
      if (!this.owned(run.id) || this.runs.get(run.id).status !== 'preparing') {
        if (this.owned(run.id) && this.runs.get(run.id).status === 'cancelling') this.emit(run.id, { type: 'stopped' });
        return;
      }
      this.runs.markBackendLaunching(run.id, this.runs.runtime(run.id));
      await this.backend.start(this.runs.get(run.id), this.runs.snapshot(run.id), this.context(run.id));
    } catch (error) {
      if (this.owned(run.id) && this.runs.get(run.id).status === 'preparing' && this.runs.runtime(run.id).details.backendLaunchAttempted !== true) {
        this.runs.transition(run.id, this.runs.runtime(run.id), 'failed', {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof ServiceError ? { errorCode: error.code, errorDetails: error.details ?? null } : {}),
        });
        this.release(run.id);
      } else this.uncertain(run.id, error);
    }
  }
  private dispatch(): void {
    let claimed: Run | null;
    while ((claimed = this.runs.claimNext(this.epoch, [...this.contendedProjects]))) {
      const run = claimed;
      if (this.jobs.has('start:' + run.id)) {
        this.runs.requeueUnstarted(run.id, this.runs.runtime(run.id)); this.contendedProjects.add(run.projectId); continue;
      }
      this.launch('start:' + run.id, () => this.start(run));
    }
  }
  private async cancel(run: Run): Promise<void> {
    // A start call may still be acquiring a lock or spawning. Do not confirm stop
    // until that call settles, otherwise it could launch after capacity is freed.
    const start = this.jobs.get('start:' + run.id); if (start) return;
    if (this.runs.runtime(run.id).details.backendLaunchAttempted !== true) { this.emit(run.id, { type: 'stopped' }); return; }
    try { if (await this.backend.cancel(run, this.context(run.id)) === 'confirmed') this.emit(run.id, { type: 'stopped' }); }
    catch (error) { this.uncertain(run.id, error); }
  }
  private async reconcile(run: Run): Promise<void> {
    try {
      if (!await this.ensureProjectLock(run)) return;
      if (!this.backend.reconcile) return;
      const result = await this.backend.reconcile(run, this.context(run.id));
      if (!this.owned(run.id) || this.runs.get(run.id).status !== 'reconciling') return;
      const runtime = this.runs.runtime(run.id);
      if (result === 'interrupted') {
        if (runtime.details.cancelRequested === true) { this.runs.transition(run.id, runtime, 'cancelling'); this.emit(run.id, { type: 'stopped' }); }
        else { this.runs.transition(run.id, runtime, 'interrupted'); this.release(run.id); }
      } else if (result === 'resumed' && runtime.details.unresolvedCompletion !== true) this.runs.transition(run.id, runtime, runtime.details.cancelRequested === true ? 'cancelling' : 'running');
    } catch (error) { this.runs.record(run.id, 'reconcile.error', { message: String(error) }); }
  }
  private async ensureProjectLock(run: Run): Promise<boolean> {
    if (!this.owned(run.id) || isTerminalRunStatus(this.runs.get(run.id).status)) return false;
    const scope = this.lockScope(run);
    if (!scope || this.releases.has(scope.key)) return true;
    let acquisition = this.lockAcquisitions.get(scope.key);
    if (!acquisition) {
      acquisition = (async () => {
        const release = await this.options.acquireProjectLock!(run, scope.canonicalPath);
        if (!release) return false;
        const needed = this.activeProjectRuns(scope.canonicalPath);
        if (!needed) { release(); return false; }
        this.releases.set(scope.key, release);
        return true;
      })().finally(() => { this.lockAcquisitions.delete(scope.key); });
      this.lockAcquisitions.set(scope.key, acquisition);
    }
    return acquisition;
  }
  private async deliverReply(run: Run, interaction: Interaction, answer: Json): Promise<void> {
    if (!this.backend.reply || this.pendingReplies.has(interaction.id)) return;
    this.pendingReplies.add(interaction.id);
    const token = this.runs.runtime(run.id);
    // Some adapters synchronously emit the next action before their reply promise
    // resolves. Buffer those callbacks until delivery is acknowledged, rather than
    // dropping completion/questions while the durable Run still says waiting.
    const events: BackendEvent[] = []; this.replyBuffers.set(run.id, events);
    try {
      await this.backend.reply(run, interaction, answer, this.context(run.id));
      if (!this.owned(run.id)) return;
      const status = this.runs.get(run.id).status;
      if (['waiting_answer', 'waiting_approval'].includes(status)) this.runs.acknowledgeReply(run.id, token.epoch, interaction.id);
      this.replyBuffers.delete(run.id); for (const event of events) this.emit(run.id, event);
    } catch (error) { this.uncertain(run.id, error); }
    finally { this.replyBuffers.delete(run.id); this.pendingReplies.delete(interaction.id); }
  }
  /** Nonblocking dispatch. Host calls on events/timer; it never awaits a full turn. */
  async tick(): Promise<void> {
    if (this.runs.db.isTransaction) throw new ServiceError('CONFLICT', 'Scheduler cannot dispatch inside a database transaction');
    this.dispatched = true;
    if (this.ticking) return; this.ticking = true;
    this.contendedProjects.clear();
    try {
      for (const run of this.runs.list()) {
        if (!this.owned(run.id)) continue;
        if (isTerminalRunStatus(run.status)) { this.publicationRetries.delete(run.id); this.release(run.id); continue; }
        if (run.status === 'cancelling') this.launch('cancel:' + run.id, () => this.cancel(run));
        if (run.status === 'reconciling') this.launch('reconcile:' + run.id, () => this.reconcile(run));
        if (run.status === 'agent_completed') this.runs.transition(run.id, this.runs.runtime(run.id), 'finalizing');
        const publicationRetry = this.publicationRetries.get(run.id);
        const publicationReady = !publicationRetry || (this.options.now?.() ?? Date.now()) >= publicationRetry.nextAt;
        if (this.runs.get(run.id).status === 'finalizing' && this.options.publish && publicationReady) this.launch('publish:' + run.id, async () => {
          if (!await this.ensureProjectLock(run)) return;
          if (!this.owned(run.id) || this.runs.get(run.id).status !== 'finalizing') return;
          try { await this.options.publish!(this.runs.get(run.id), this.runs.runtime(run.id)); this.publicationRetries.delete(run.id); }
          catch (error) {
            // Invalid output is permanent. Transport/filesystem faults remain
            // finalizing for manifest-based recovery instead of backend reruns.
            const permanent = (error instanceof ServiceError && ['INVALID_REQUEST', 'INPUT_BLOCKED', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'NOT_FOUND', 'PROJECT_INACTIVE'].includes(error.code)) || error instanceof SyntaxError || (error instanceof Error && ['ENOENT', 'ELOOP', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)));
            if (permanent && this.owned(run.id) && this.runs.get(run.id).status === 'finalizing') {
              this.publicationRetries.delete(run.id);
              this.runs.transition(run.id, this.runs.runtime(run.id), 'failed', { error: error instanceof Error ? error.message : 'Invalid output', failurePhase: 'publication' });
            } else this.deferPublication(run.id, error);
          }
          if (isTerminalRunStatus(this.runs.get(run.id).status)) this.release(run.id);
        });
        if (['waiting_answer', 'waiting_approval'].includes(run.status)) {
          const interaction = this.runs.activeInteraction(run.id);
          if (interaction?.status === 'answered') {
            const row = this.runs.db.prepare('SELECT answer FROM interactions WHERE id=?').get(interaction.id)!;
            this.launch('reply:' + run.id, () => this.deliverReply(run, interaction, JSON.parse(String(row.answer)) as Json));
          }
        }
      }
      this.dispatch();
    } finally { this.ticking = false; }
  }
  /** Only invoke after host verifies previous instance lost ownership. */
  async recover(): Promise<void> { this.runs.recover(this.epoch); await this.tick(); }
  /** Test/controlled-adapter drain; not used by production request handlers. */
  async settled(): Promise<void> { while (this.jobs.size) await Promise.all([...this.jobs.values()]); }
}
