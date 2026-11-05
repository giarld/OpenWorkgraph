import type { OpenCodeProcess } from './process.js';
import { AgentError } from '../errors.js';
import type { AgentFailureReason } from '@openworkgraph/protocol';
export type AcpObject = Record<string, any>;
export interface AcpRequest { id: string | number; method: string; params: AcpObject }
const newline = String.fromCharCode(10), maximumFrameBytes = 16 * 1024 * 1024;
const object = (value: unknown): value is AcpObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id: unknown): id is string | number => typeof id === 'string' && id.length <= 1024 || typeof id === 'number' && Number.isSafeInteger(id);
export class OpenCodeAcpError extends AgentError {
  constructor(readonly rpcCode: number) {
    super(rpcCode === -32000 ? 'authentication_required' : rpcCode === -32603 ? 'runtime_unavailable' : 'protocol_error');
  }
}
/** Private ACP transport. A delivered request or uncertain response is never
 * resent. Reverse requests stay independent of prompts and notifications. */
export class OpenCodeAcp {
  private serial = 0;
  private pending = new Map<number, { resolve(value: AcpObject): void; reject(error: unknown): void; cleanup(): void }>();
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private queue: Promise<void> = Promise.resolve();
  private notifications: Promise<void> = Promise.resolve();
  private failed = false;
  private ending = false;
  private incoming = new Map<string, { fingerprint: string; response?: unknown; sending?: Promise<void> }>();
  constructor(readonly native: OpenCodeProcess,
    private readonly notification: (method: string, params: AcpObject) => void | Promise<void>,
    private readonly requestFromAgent: (request: AcpRequest) => void | Promise<void>,
    private readonly failure: (error: AgentError) => void,
    private readonly writeTimeoutMs = 10000) {
    native.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failed) return;
      try {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        let end: number;
        while (!this.failed && (end = this.buffer.indexOf(newline)) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > maximumFrameBytes) throw new AgentError('protocol_error');
          if (line.trim()) this.receive(JSON.parse(line));
        }
        if (Buffer.byteLength(this.buffer) > maximumFrameBytes) throw new AgentError('protocol_error');
      } catch { this.fail(); }
    });
    native.child.stdout.once('end', () => {
      try { if ((this.buffer + this.decoder.decode()).trim()) { this.fail(); return; } }
      catch { this.fail(); return; }
      if (!this.ending) this.fail('outcome_unknown');
    });
    native.child.once('error', () => this.fail('runtime_unavailable'));
    native.child.once('close', () => { if (this.pending.size || !this.ending) this.fail('outcome_unknown'); });
    native.child.stdin.on('error', () => this.fail('outcome_unknown'));
  }
  private receive(message: unknown) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new AgentError('protocol_error');
    if ('method' in message) {
      if (typeof message.method !== 'string' || !message.method || message.method.length > 256 || 'result' in message || 'error' in message) throw new AgentError('protocol_error');
      const params = message.params ?? {};
      if (!object(params)) throw new AgentError('protocol_error');
      if (Object.hasOwn(message, 'id')) {
        if (!validId(message.id)) throw new AgentError('protocol_error');
        const key = JSON.stringify(message.id), fingerprint = JSON.stringify([message.method, params]);
        const previous = this.incoming.get(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AgentError('protocol_error');
          return;
        }
        if (this.incoming.size >= 1024) throw new AgentError('protocol_error');
        this.incoming.set(key, { fingerprint });
        void Promise.resolve().then(() => this.requestFromAgent({ id: message.id, method: message.method, params })).catch(error => this.fail(error instanceof AgentError ? error.reason : 'protocol_error'));
      } else {
        const next = this.notifications.then(() => { if (!this.failed) return this.notification(message.method, params); });
        this.notifications = next.catch(error => { this.fail(error instanceof AgentError ? error.reason : 'protocol_error'); });
      }
      return;
    }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || ('result' in message) === ('error' in message)) throw new AgentError('protocol_error');
    if ('error' in message && (!object(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) throw new AgentError('protocol_error');
    if ('result' in message && !object(message.result)) throw new AgentError('protocol_error');
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); pending.cleanup();
    if ('error' in message) pending.reject(new OpenCodeAcpError(message.error.code));
    else pending.resolve(message.result);
  }
  request(method: string, params: AcpObject, options: { signal?: AbortSignal; timeoutMs?: number; sent?: () => void } = {}): Promise<AcpObject> {
    options.signal?.throwIfAborted();
    if (this.failed || this.ending) return Promise.reject(new AgentError('outcome_unknown'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      const abort = () => { if (this.pending.delete(id)) { cleanup(); reject(new AgentError('outcome_unknown')); } };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) timer = setTimeout(abort, options.timeoutMs);
      void this.send({ jsonrpc: '2.0', id, method, params }, () => this.pending.has(id)).then(written => { if (written) options.sent?.(); }).catch(() => {
        const pending = this.pending.get(id); this.pending.delete(id); pending?.cleanup(); pending?.reject(new AgentError('outcome_unknown'));
      });
    });
  }
  async notify(method: string, params: AcpObject): Promise<void> { await this.send({ jsonrpc: '2.0', method, params }); }
  respond(id: string | number, result: unknown, error = false): Promise<void> {
    const entry = this.incoming.get(JSON.stringify(id));
    if (!entry) return Promise.reject(new AgentError('outcome_unknown'));
    const response = { jsonrpc: '2.0', id, [error ? 'error' : 'result']: result };
    if (entry.response !== undefined) {
      if (JSON.stringify(entry.response) !== JSON.stringify(response)) return Promise.reject(new AgentError('outcome_unknown'));
      return entry.sending!;
    }
    entry.response = response; entry.sending = this.send(response).then(() => {}); return entry.sending;
  }
  private send(value: unknown, admit: () => boolean = () => true): Promise<boolean> {
    const text = JSON.stringify(value) + newline;
    if (Buffer.byteLength(text) > maximumFrameBytes) return Promise.reject(new AgentError('protocol_error'));
    const work = this.queue.then(() => new Promise<boolean>((resolve, reject) => {
      if (!admit()) { resolve(false); return; }
      if (this.failed || this.ending || this.native.child.stdin.destroyed) { reject(new AgentError('outcome_unknown')); return; }
      const timer = setTimeout(() => { this.fail('outcome_unknown'); reject(new AgentError('outcome_unknown')); }, this.writeTimeoutMs);
      try {
        this.native.child.stdin.write(text, error => {
          clearTimeout(timer);
          if (error) { this.fail('outcome_unknown'); reject(new AgentError('outcome_unknown')); } else resolve(true);
        });
      } catch { clearTimeout(timer); this.fail('outcome_unknown'); reject(new AgentError('outcome_unknown')); }
    }));
    this.queue = work.then(() => {}, () => {}); return work;
  }
  private fail(reason: AgentFailureReason = 'protocol_error') {
    if (this.failed) return; this.failed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new AgentError('outcome_unknown')); }
    this.pending.clear(); this.failure(new AgentError(reason));
  }
  async flushNotifications(): Promise<void> { await this.notifications; if (this.failed) throw new AgentError('outcome_unknown'); }
  end() { this.ending = true; this.native.child.stdin.end(); }
  close() { this.ending = true; this.fail('outcome_unknown'); }
}
