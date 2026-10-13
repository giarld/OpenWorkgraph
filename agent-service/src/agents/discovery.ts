import type { AgentAvailability, AgentModelOption, AgentOptionValue, AgentPlatform } from '@openworkgraph/protocol';
import type { AgentQueryContext } from './contracts.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText } from './configuration.js';
import { AgentError, agentError } from './errors.js';
import { AgentRegistry, safeAvailability } from './registry.js';

export interface AgentDiscoveryRequest {
  options?: Record<string, AgentOptionValue>; schemaVersion?: number;
  platform?: AgentPlatform; signal?: AbortSignal;
}
export interface AgentDiscoveryLimits { maxEntries?: number; maxConcurrent?: number; ttlMs?: number; timeoutMs?: number; cleanupTimeoutMs?: number }
type QueryValue = AgentModelOption[] | AgentAvailability;
interface Query {
  controller: AbortController; waiters: number; settled: boolean;
  promise: Promise<QueryValue>;
}
/** The finite catalog is public data, not a raw CLI response. */
export function validateAgentModels(value: unknown, effort: boolean): AgentModelOption[] {
  if (!Array.isArray(value) || value.length > 512) throw new AgentError('protocol_error');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['id', 'reasoningEfforts', 'defaultReasoningEffort']) || !publicText(entry.id, 256) || entry.id !== entry.id.trim() || ids.has(entry.id) || !Array.isArray(entry.reasoningEfforts) || entry.reasoningEfforts.length > 32 || !entry.reasoningEfforts.every(v => publicText(v, 64)) || new Set(entry.reasoningEfforts).size !== entry.reasoningEfforts.length || (!effort && entry.reasoningEfforts.length !== 0) || (entry.defaultReasoningEffort !== undefined && entry.defaultReasoningEffort !== null && (typeof entry.defaultReasoningEffort !== 'string' || !entry.reasoningEfforts.includes(entry.defaultReasoningEffort)))) throw new AgentError('protocol_error');
    ids.add(entry.id);
    return { id: entry.id, reasoningEfforts: [...entry.reasoningEfforts] as string[], defaultReasoningEffort: (entry.defaultReasoningEffort ?? null) as string | null };
  });
}
function limit(value: number | undefined, fallback: number, maximum: number, zero = false): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < (zero ? 0 : 1) || selected > maximum) throw new AgentError('invalid_configuration');
  return selected;
}
/** Catalog and diagnosis use independent keys and NEVER call one another. */
export class AgentDiscovery {
  private readonly cache = new Map<string, { expires: number; value: QueryValue }>();
  private readonly queries = new Map<string, Query>();
  private readonly maxEntries: number; private readonly maxConcurrent: number;
  private readonly ttlMs: number; private readonly timeoutMs: number; private readonly cleanupTimeoutMs: number;
  private closed = false;
  constructor(private readonly registry: AgentRegistry, limits: AgentDiscoveryLimits = {}) {
    this.maxEntries = limit(limits.maxEntries, 64, 1024); this.maxConcurrent = limit(limits.maxConcurrent, 16, 256);
    this.ttlMs = limit(limits.ttlMs, 30_000, 3_600_000, true); this.timeoutMs = limit(limits.timeoutMs, 10_000, 120_000);
    // Native stdio drain has its own 3s deadline; the host must allow it to settle.
    this.cleanupTimeoutMs = limit(limits.cleanupTimeoutMs, 5_000, 30_000);
  }
  listModels(backendId: string, request: AgentDiscoveryRequest = {}): Promise<AgentModelOption[]> {
    return this.query(backendId, 'models', request) as Promise<AgentModelOption[]>;
  }
  diagnose(backendId: string, request: AgentDiscoveryRequest = {}): Promise<AgentAvailability> {
    return this.query(backendId, 'diagnose', request) as Promise<AgentAvailability>;
  }
  private async query(backendId: string, operation: 'models' | 'diagnose', request: AgentDiscoveryRequest): Promise<QueryValue> {
    if (request.signal?.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.closed) throw new AgentError('runtime_unavailable');
    const plugin = this.registry.get(backendId); const platform = request.platform ?? process.platform as AgentPlatform;
    const options = normalizeConfiguration(plugin.descriptor.configuration, request.options ?? {}, request.schemaVersion ?? plugin.descriptor.configuration.version, platform);
    const key = JSON.stringify([backendId, operation, platform, plugin.descriptor.configuration.version, options]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return structuredClone(cached.value); }
    if (cached) this.cache.delete(key);
    let job = this.queries.get(key);
    if (job?.controller.signal.aborted) {
      await this.wait(job, request.signal).catch(error => { if (request.signal?.aborted) throw error; });
      return this.query(backendId, operation, request);
    }
    if (!job) {
      if (this.queries.size >= this.maxConcurrent) throw new AgentError('runtime_unavailable');
      const controller = new AbortController();
      job = { controller, waiters: 0, settled: false, promise: Promise.resolve([]) };
      const active = job;
      this.queries.set(key, active);
      active.promise = this.runQuery(controller, async context => {
        if (operation === 'models') return validateAgentModels(plugin.listModels ? await plugin.listModels(context) : [], plugin.descriptor.models.effort);
        return plugin.diagnose ? safeAvailability(await plugin.diagnose(context)) : { status: 'unknown', reason: null, message: '执行器未提供运行诊断。' };
      }, platform, options).then(value => {
        if (this.ttlMs > 0 && !controller.signal.aborted && !this.closed) {
          this.cache.set(key, { expires: Date.now() + this.ttlMs, value: structuredClone(value) });
          while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
        }
        return value;
      }).finally(() => { active.settled = true; if (this.queries.get(key) === active) this.queries.delete(key); });
      // If every waiter leaves, cleanup still runs; no unhandled shared rejection.
      void active.promise.catch(() => {});
    }
    return this.wait(job, request.signal);
  }
  private wait(job: Query, signal: AbortSignal | undefined): Promise<QueryValue> {
    job.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: QueryValue) => {
        if (done) return; done = true; signal?.removeEventListener('abort', abort);
        job.waiters--;
        if (job.waiters === 0 && !job.settled) job.controller.abort(new DOMException('Aborted', 'AbortError'));
        if (error !== undefined) reject(error); else resolve(structuredClone(value!));
      };
      const abort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      job.promise.then(value => finish(undefined, value), error => finish(error));
    });
  }
  private async runQuery(controller: AbortController, operation: (context: AgentQueryContext) => Promise<QueryValue>, platform: AgentPlatform, options: Record<string, AgentOptionValue>): Promise<QueryValue> {
    const cleanups: (() => void | Promise<void>)[] = []; let cleaning = false; let cleanupCount = 0;
    const cleanup = async (hook: () => void | Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(hook), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError('timeout')), this.cleanupTimeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const context: AgentQueryContext = { platform, options: Object.freeze(options), signal: controller.signal, deferCleanup: hook => {
      if (typeof hook !== 'function') throw new AgentError('protocol_error');
      if (++cleanupCount > 32) throw new AgentError('protocol_error');
      if (cleaning) { void cleanup(hook).catch(() => {}); } else cleanups.push(hook);
    } };
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const timer = setTimeout(() => controller.abort(new AgentError('timeout')), this.timeoutMs);
    let value: QueryValue | undefined; let failure: unknown;
    try {
      value = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return operation(context);
      }), aborted]);
    } catch (error) { failure = controller.signal.aborted ? controller.signal.reason : agentError(error); }
    finally {
      clearTimeout(timer); if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      cleaning = true;
      const results = await Promise.allSettled(cleanups.map(cleanup));
      if (failure === undefined && results.some(result => result.status === 'rejected')) failure = new AgentError('protocol_error');
    }
    if (failure !== undefined) throw failure;
    return value!;
  }
  /** Discovery disposal only closes queries; no execution adapter is touched. */
  async dispose(): Promise<void> {
    this.closed = true; this.cache.clear();
    const pending = [...this.queries.values()];
    for (const query of pending) query.controller.abort(new AgentError('runtime_unavailable'));
    await Promise.allSettled(pending.map(query => query.promise));
  }
}
