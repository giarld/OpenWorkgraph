import { performance } from 'node:perf_hooks';
import { BUILTIN_AGENT_LIMITS as limits } from './limits.js';

interface Timers {
  now(): number;
  schedule(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}
const timers: Timers = { now: () => performance.now(), schedule: (callback, ms) => setTimeout(callback, ms), clear: timer => clearTimeout(timer) };

/** Fixed product limits. The optional clock is private test infrastructure,
 * never a Run option. Waiting pauses active/tool time but not the wall limit. */
export class BuiltinTimeBudget {
  private activeLeft: number = limits.activeMs;
  private activeSince: number | undefined;
  private tool: { left: number; since?: number; onExpire?: () => void } | undefined;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  private toolTimer: ReturnType<typeof setTimeout> | undefined;
  private wallTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false; private waiting = false; private closed = false;
  constructor(private readonly onExpire: () => void, private readonly clock: Timers = timers) {}
  start(): void {
    if (this.started || this.closed) throw Error('Time budget already started or closed');
    this.started = true; this.wallTimer = this.clock.schedule(() => this.expire(), limits.wallMs); this.resume();
  }
  private expire(): void { if (!this.closed) { this.close(); this.onExpire(); } }
  private expireTool(): void {
    const onExpire = this.tool?.onExpire;
    if (!onExpire) { this.expire(); return; }
    this.endTool(); onExpire();
  }
  private stopActive(): void {
    const now = this.clock.now();
    if (this.activeSince !== undefined) { this.activeLeft -= now - this.activeSince; this.activeSince = undefined; }
    if (this.tool?.since !== undefined) { this.tool.left -= now - this.tool.since; delete this.tool.since; }
    if (this.activeTimer) this.clock.clear(this.activeTimer); this.activeTimer = undefined;
    if (this.toolTimer) this.clock.clear(this.toolTimer); this.toolTimer = undefined;
  }
  pause(): void { if (!this.started || this.closed) return; this.waiting = true; this.stopActive(); }
  resume(): void {
    if (!this.started || this.closed) return; this.waiting = false;
    if (this.activeSince === undefined) {
      this.activeSince = this.clock.now(); this.activeTimer = this.clock.schedule(() => this.expire(), Math.max(1, this.activeLeft));
    }
    if (this.tool && this.tool.since === undefined) {
      this.tool.since = this.clock.now(); this.toolTimer = this.clock.schedule(() => this.expireTool(), Math.max(1, this.tool.left));
    }
  }
  beginTool(onExpire?: () => void, durationMs: number = limits.toolMs): void {
    if (this.tool) throw Error('Concurrent tool time budget');
    if (this.closed) return;
    this.tool = { left: durationMs, ...(onExpire ? { onExpire } : {}) }; if (!this.waiting) this.resume();
  }
  endTool(): void {
    if (this.toolTimer) this.clock.clear(this.toolTimer); this.toolTimer = undefined; this.tool = undefined;
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.stopActive();
    if (this.wallTimer) this.clock.clear(this.wallTimer); this.wallTimer = undefined;
  }
}
