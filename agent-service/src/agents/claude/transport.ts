import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClaudeJsonLines } from './jsonl.js';
import { AgentError } from '../errors.js';

/** Plugin-private bidirectional native CLI protocol. No host shell fallback. */
export class ClaudeTransport {
  private serial = 0;
  private failed = false;
  private readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private readonly work = new Set<Promise<void>>();
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; failed: boolean }>;
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly event: (value: Record<string, any>) => void | Promise<void>, private readonly control: (value: Record<string, any>) => Promise<void>, private readonly failure: () => void) {
    const parser = new ClaudeJsonLines(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const value = raw as Record<string, any>;
      if (value.type === 'control_response') {
        const pending = this.pending.get(value.response?.request_id);
        if (!pending) return;
        this.pending.delete(value.response.request_id); clearTimeout(pending.timer);
        if (value.response.subtype !== 'success' || value.response.response != null && (typeof value.response.response !== 'object' || Array.isArray(value.response.response))) pending.reject(new AgentError('protocol_error'));
        else pending.resolve(value.response.response ?? {});
      } else if (value.type === 'control_request') {
        // Register the request before parsing a withdrawal in the same chunk.
        this.track(this.control(value));
      } else this.track(this.event(value));
    });
    child.stdout.on('data', chunk => { try { parser.write(chunk); } catch { this.fail(); } });
    let bytes = 0; child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) this.fail(); });
    child.stdin.on('error', () => this.fail());
    this.closed = new Promise(resolve => child.once('close', (code, signal) => {
      try { parser.end(); } catch { this.failed = true; }
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AgentError('outcome_unknown')); }
      this.pending.clear(); resolve({ code, signal, failed: this.failed });
    }));
  }
  get busy(): boolean { return this.work.size > 0 || this.pending.size > 0; }
  private track(work: void | Promise<void>): void {
    if (!work) return;
    this.work.add(work);
    void work.then(() => this.work.delete(work), () => { this.work.delete(work); this.fail(); });
  }
  async settled(): Promise<void> { while (this.work.size) await Promise.allSettled([...this.work]); }
  private fail(): void { if (!this.failed) { this.failed = true; this.failure(); } }
  send(value: unknown): Promise<void> {
    if (this.failed || this.child.stdin.destroyed || this.child.stdin.writableEnded) return Promise.reject(new AgentError('outcome_unknown'));
    let line: string; try { line = JSON.stringify(value) + String.fromCharCode(10); } catch { return Promise.reject(new AgentError('invalid_configuration')); }
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) return Promise.reject(new AgentError('invalid_configuration'));
    return new Promise((resolve, reject) => this.child.stdin.write(line, error => error ? reject(new AgentError('outcome_unknown')) : resolve()));
  }
  request(request: Record<string, unknown>, timeoutMs = 20000): Promise<Record<string, unknown>> {
    const id = 'workgraph-' + (++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError('timeout')); }, timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ type: 'control_request', request_id: id, request }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  end(): void { if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end(); }
}
