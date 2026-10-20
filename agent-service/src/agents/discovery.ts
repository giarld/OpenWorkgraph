import type { AgentAvailability, AgentModelOption, AgentOptionValue, AgentPlatform, AgentNativeCatalog, AgentDescriptor } from '@openworkgraph/protocol';
import type { AgentQueryContext } from './contracts.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText } from './configuration.js';
import { AgentError, agentError } from './errors.js';
import { AgentRegistry, safeAvailability } from './registry.js';
import { modelGroupMetadata } from './model-groups.js';
import { validateProjectPermissions } from './workspace-configuration-validation.js';

export interface AgentDiscoveryRequest {
  options?: Record<string, AgentOptionValue>; schemaVersion?: number;
  permissions?: AgentQueryContext['permissions'];
  platform?: AgentPlatform; signal?: AbortSignal;
  /** Trusted host-resolved scope, never a public device path option. */
  projectPath?: string;
}
export interface AgentDiscoveryLimits { maxEntries?: number; maxConcurrent?: number; ttlMs?: number; timeoutMs?: number; cleanupTimeoutMs?: number }
type QueryValue = AgentModelOption[] | AgentAvailability | AgentNativeCatalog;
interface Query {
  controller: AbortController; waiters: number; settled: boolean;
  promise: Promise<QueryValue>;
}
/** The finite catalog is public data, not a raw CLI response. */
export function validateAgentModels(value: unknown, effort: boolean, variants = false): AgentModelOption[] {
  if (!Array.isArray(value) || value.length > 512) throw new AgentError('protocol_error');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['id', 'reasoningEfforts', 'defaultReasoningEffort', 'variants', 'inputKinds', 'tools', 'group']) || !publicText(entry.id, 256) || entry.id !== entry.id.trim() || ids.has(entry.id) || !Array.isArray(entry.reasoningEfforts) || entry.reasoningEfforts.length > (variants ? 64 : 32) || !entry.reasoningEfforts.every(v => publicText(v, 64)) || new Set(entry.reasoningEfforts).size !== entry.reasoningEfforts.length || (!effort && entry.reasoningEfforts.length !== 0) || (entry.defaultReasoningEffort !== undefined && entry.defaultReasoningEffort !== null && (typeof entry.defaultReasoningEffort !== 'string' || !entry.reasoningEfforts.includes(entry.defaultReasoningEffort)))) throw new AgentError('protocol_error');
    if (entry.variants !== undefined && (!variants || !Array.isArray(entry.variants) || entry.variants.length > 64 || !entry.variants.every(v => publicText(v, 64) && v === v.trim()) || new Set(entry.variants).size !== entry.variants.length) || entry.inputKinds !== undefined && (!Array.isArray(entry.inputKinds) || entry.inputKinds.length > 5 || !entry.inputKinds.every(v => ['text', 'image', 'document', 'video', 'file'].includes(String(v))) || new Set(entry.inputKinds).size !== entry.inputKinds.length) || entry.tools !== undefined && typeof entry.tools !== 'boolean') throw new AgentError('protocol_error');
    ids.add(entry.id);
    if (entry.group !== undefined && entry.group !== null && (!publicText(entry.group, 256) || entry.group !== entry.group.trim())) throw new AgentError('protocol_error');
    return { id: entry.id, reasoningEfforts: [...entry.reasoningEfforts] as string[], defaultReasoningEffort: (entry.defaultReasoningEffort ?? null) as string | null,
      ...(entry.variants === undefined ? {} : { variants: [...entry.variants as string[]] }), ...(entry.inputKinds === undefined ? {} : { inputKinds: [...entry.inputKinds as NonNullable<AgentModelOption['inputKinds']>] }), ...(entry.tools === undefined ? {} : { tools: entry.tools as boolean }), ...(entry.group === undefined ? {} : { group: entry.group as string | null }) };
  });
}
/** Plugins supporting effort use the per-task selection before the legacy
 * variant option. Frozen options remain intact for older accepted tasks. */
export function assertModelVariant(descriptor: AgentDescriptor, options: Readonly<Record<string, AgentOptionValue>>, modelId: string, catalog: readonly AgentModelOption[], reasoningEffort: string | null = null): void {
  if (descriptor.models.effort && reasoningEffort !== null) return;
  const name = descriptor.models.variantOption; if (!name) return;
  const variant = options[name]; if (variant === undefined || variant === '') return;
  if (typeof variant !== 'string' || !catalog.find(model => model.id === modelId)?.variants?.includes(variant)) throw new AgentError('model_unavailable');
}
export function validateNativeCatalog(value: unknown, descriptor: AgentDescriptor): AgentNativeCatalog {
  if (!isPlainRecord(value) || !exactKeys(value, ['version', 'revision', 'profiles', 'commands', 'profileOption']) || value.version !== 1 || !publicText(value.revision, 128) || !Array.isArray(value.profiles) || value.profiles.length > 256 || !Array.isArray(value.commands) || value.commands.length > 256) throw new AgentError('protocol_error');
  const identity = (id: unknown) => publicText(id, 256) && !/^(?:[/\\]|[A-Za-z]:|~[/\\])/.test(id as string);
  const profiles = value.profiles.map(entry => {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['id', 'name', 'mode', 'hidden']) || !identity(entry.id) || !publicText(entry.name, 256) || !['primary', 'subagent', 'all'].includes(String(entry.mode)) || typeof entry.hidden !== 'boolean') throw new AgentError('protocol_error');
    return { id: entry.id as string, name: entry.name as string, mode: entry.mode as 'primary' | 'subagent' | 'all', hidden: entry.hidden };
  });
  const commands = value.commands.map(entry => {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['id', 'description']) || !identity(entry.id) || !(entry.description === null || entry.description === '' || publicText(entry.description, 2048))) throw new AgentError('protocol_error');
    return { id: entry.id as string, description: entry.description as string | null };
  });
  if (new Set(profiles.map(entry => entry.id)).size !== profiles.length || new Set(commands.map(entry => entry.id)).size !== commands.length || value.profileOption !== undefined && !descriptor.configuration.fields.some(field => field.name === value.profileOption && field.type === 'text')) throw new AgentError('protocol_error');
  return { version: 1, revision: value.revision as string, profiles, commands, ...(value.profileOption === undefined ? {} : { profileOption: value.profileOption as string }) };
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
  nativeCatalog(backendId: string, request: AgentDiscoveryRequest = {}): Promise<AgentNativeCatalog> {
    return this.query(backendId, 'nativeCatalog', request) as Promise<AgentNativeCatalog>;
  }
  private async query(backendId: string, operation: 'models' | 'diagnose' | 'nativeCatalog', request: AgentDiscoveryRequest): Promise<QueryValue> {
    if (request.signal?.aborted) throw request.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.closed) throw new AgentError('runtime_unavailable');
    const plugin = this.registry.get(backendId); const platform = request.platform ?? process.platform as AgentPlatform;
    const options = normalizeConfiguration(plugin.descriptor.configuration, request.options ?? {}, request.schemaVersion ?? plugin.descriptor.configuration.version, platform);
    if (request.permissions !== undefined) validateProjectPermissions(request.permissions);
    const permissions = request.permissions === undefined ? undefined : Object.freeze({ ...request.permissions });
    const key = JSON.stringify([backendId, operation, platform, plugin.descriptor.configuration.version, options, request.projectPath ?? null, permissions ?? null]);
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
        if (operation === 'models') return validateAgentModels(plugin.listModels ? await plugin.listModels(context) : [], plugin.descriptor.models.effort, !!plugin.descriptor.models.variantOption).map(model => ({ ...model, ...modelGroupMetadata(plugin, model.id) }));
        if (operation === 'nativeCatalog') {
          if (!plugin.extensions?.nativeCatalog) throw new AgentError('capability_unsupported');
          return validateNativeCatalog(await plugin.extensions.nativeCatalog.list(context), plugin.descriptor);
        }
        return plugin.diagnose ? safeAvailability(await plugin.diagnose(context)) : { status: 'unknown', reason: null, message: '执行器未提供运行诊断。' };
      }, platform, options, request.projectPath, permissions).then(value => {
        // A user may install the CLI then immediately retry onboarding.
        const retryInstallation = !Array.isArray(value) && 'installation' in value && value.installation !== undefined && value.installation !== 'installed';
        if (this.ttlMs > 0 && !retryInstallation && !controller.signal.aborted && !this.closed) {
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
  private async runQuery(controller: AbortController, operation: (context: AgentQueryContext) => Promise<QueryValue>, platform: AgentPlatform, options: Record<string, AgentOptionValue>, projectPath?: string, permissions?: AgentQueryContext['permissions']): Promise<QueryValue> {
    const cleanups: (() => void | Promise<void>)[] = []; let cleaning = false; let cleanupCount = 0;
    const cleanup = async (hook: () => void | Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(hook), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError('timeout')), this.cleanupTimeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const context: AgentQueryContext = { platform, options: Object.freeze(options), ...(permissions ? { permissions } : {}), ...(projectPath ? { projectPath } : {}), signal: controller.signal, deferCleanup: hook => {
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
