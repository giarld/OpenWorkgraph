import { AgentError } from '../errors.js';

export function privateEndpoint(value: unknown): URL {
  if (typeof value !== 'string') throw new AgentError('protocol_error');
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentError('protocol_error'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new AgentError('protocol_error');
  return url;
}
/** A request is sent at most once. A failed mutation may have been accepted;
 * callers must reconcile its preallocated identity, never retry its payload. */
export class OpenCodeTransport {
  readonly #endpoint: URL;
  readonly #authorization: string;
  constructor(endpoint: string, password: string, private readonly timeoutMs = 20_000, private readonly maxBytes = 8 * 1024 * 1024) {
    this.#endpoint = privateEndpoint(endpoint);
    this.#authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  }
  async request(path: string, options: { method?: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const method = options.method ?? 'GET';
    const mutation = method !== 'GET';
    const url = new URL(path, this.#endpoint);
    if (!path.startsWith('/api/') || !url.pathname.startsWith('/api/') || url.origin !== this.#endpoint.origin || url.hash) throw new AgentError('invalid_configuration');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, { method, headers: { authorization: this.#authorization, 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal, redirect: 'error',
      });
    } catch { throw new AgentError(mutation ? 'outcome_unknown' : signal.aborted ? 'timeout' : 'runtime_unavailable'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AgentError(response.status === 401 || response.status === 403 ? 'authentication_required' : mutation ? 'outcome_unknown' : 'protocol_error');
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, raw = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > this.maxBytes) throw new AgentError('protocol_error');
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
      return raw ? JSON.parse(raw) : null;
    } catch { throw new AgentError(mutation ? 'outcome_unknown' : signal.aborted ? 'timeout' : 'protocol_error'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
