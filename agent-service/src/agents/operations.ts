import type { BackendCallbacks } from '../backend/types.js';
import { ServiceError } from '../errors.js';

export type AgentOperationPhase = 'queued' | 'resolving' | 'dispatched' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface AgentOperation { callId: string; phase: AgentOperationPhase }
/** Tracks independent native side effects; it never changes a Run or publishes. */
export class AgentOperations {
  private readonly entries = new Map<string, AgentOperation>();
  private cancelled = false;
  constructor(private readonly limit = 64) { if (!Number.isSafeInteger(limit) || limit < 1) throw new ServiceError('INVALID_REQUEST', 'Invalid independent operation limit'); }
  list(): AgentOperation[] { return [...this.entries.values()].map(entry => ({ ...entry })); }
  get unresolved(): boolean { return [...this.entries.values()].some(entry => ['queued', 'resolving', 'dispatched', 'unknown'].includes(entry.phase)); }
  get outcomeUnknown(): boolean { return [...this.entries.values()].some(entry => entry.phase === 'unknown'); }
  enqueue(callId: string): void {
    if (typeof callId !== 'string' || !callId || callId.length > 200 || this.entries.has(callId) || this.entries.size >= this.limit) throw new ServiceError('CONFLICT', 'Invalid or duplicate independent call');
    this.entries.set(callId, { callId, phase: this.cancelled ? 'cancelled' : 'queued' });
  }
  private entry(callId: string): AgentOperation { const entry = this.entries.get(callId); if (!entry) throw new ServiceError('NOT_FOUND', 'Independent call not found'); return entry; }
  async dispatch<T>(callId: string, skillId: string | null, lease: NonNullable<BackendCallbacks['withSkillEnvironment']>, nativeDispatch: (environment: Record<string, string>, secrets: Record<string, string>) => Promise<T>): Promise<T> {
    const entry = this.entry(callId);
    if (entry.phase !== 'queued') throw new ServiceError('CONFLICT', 'Independent call is not queued');
    entry.phase = 'resolving'; let launched: Promise<T> | undefined;
    try {
      const result = await lease(skillId, (environment, secrets) => {
        if (this.cancelled || entry.phase !== 'resolving') throw new ServiceError('CONFLICT', 'Independent call cancelled before dispatch');
        // Mark before invoking native code: a synchronous throw can still follow a send.
        entry.phase = 'dispatched';
        launched = Promise.resolve(nativeDispatch(environment, secrets));
        // Observe immediately even if lease release fails after the actual send.
        void launched.catch(() => {});
        return launched;
      });
      const value = await result.value;
      // Reconciliation may already have supplied stronger native exit evidence.
      const current = this.entry(callId);
      if (current.phase === 'dispatched') current.phase = 'completed';
      return value;
    } catch (error) {
      const current = this.entry(callId);
      if (current.phase === 'dispatched') current.phase = 'unknown';
      else if (current.phase === 'resolving') current.phase = this.cancelled ? 'cancelled' : 'failed';
      throw error;
    }
  }
  /** ACK is not independent exit evidence. Dispatched operations remain unresolved. */
  cancelPending(): void { this.cancelled = true; for (const entry of this.entries.values()) if (['queued', 'resolving'].includes(entry.phase)) entry.phase = 'cancelled'; }
  /** Use only an observed native terminal result, not transport loss/interrupt ACK. */
  confirm(callId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
    if (!['completed', 'failed', 'cancelled'].includes(outcome)) throw new ServiceError('INVALID_REQUEST', 'Invalid independent terminal outcome');
    const entry = this.entry(callId); if (!['dispatched', 'unknown'].includes(entry.phase)) throw new ServiceError('CONFLICT', 'Independent call is not awaiting a result'); entry.phase = outcome;
  }
}
