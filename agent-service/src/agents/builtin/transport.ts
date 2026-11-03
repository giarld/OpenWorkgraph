import { performance } from 'node:perf_hooks';
import { AgentError } from '../errors.js';
import { BUILTIN_AGENT_LIMITS as limits } from './limits.js';

export interface BuiltinTransportEvent {
  phase: 'started' | 'headers' | 'finished';
  elapsedMs: number; bytes: number; chunks: number;
  status?: number; firstByteMs?: number; lastByteMs?: number;
  outcome?: 'completed' | 'cancelled' | 'failed' | 'timeout';
  timeout?: 'headers' | 'idle' | 'wall';
}
export interface BuiltinTransportOptions {
  observe?(event: BuiltinTransportEvent): void;
  /** Private test seam; never taken from connection settings or tool arguments. */
  timing?: { idleMs: number; wallMs: number };
}

/** Measure network inactivity separately from total generation time. A bounded
 * pump observes bytes even while SDK tool execution waits for user approval. */
export async function builtinModelResponse(dispatch: (signal: AbortSignal) => Promise<Response>, parent: AbortSignal, options: BuiltinTransportOptions = {}): Promise<Response> {
  parent.throwIfAborted();
  const timing = options.timing ?? { idleMs: limits.requestMs, wallMs: limits.requestWallMs };
  const started = performance.now(), deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let idleTimer: ReturnType<typeof setTimeout> | undefined, wallTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false, headers = false, bytes = 0, chunks = 0, status: number | undefined;
  let firstByteMs: number | undefined, lastByteMs: number | undefined, timeout: BuiltinTransportEvent['timeout'];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const elapsed = () => Math.round(performance.now() - started);
  const report = (phase: BuiltinTransportEvent['phase'], outcome?: BuiltinTransportEvent['outcome']) => options.observe?.({
    phase, elapsedMs: elapsed(), bytes, chunks, ...(status === undefined ? {} : { status }),
    ...(firstByteMs === undefined ? {} : { firstByteMs }), ...(lastByteMs === undefined ? {} : { lastByteMs }), ...(outcome ? { outcome } : {}), ...(timeout ? { timeout } : {}),
  });
  const finish = (outcome: NonNullable<BuiltinTransportEvent['outcome']>) => {
    if (settled) return;
    settled = true; clearTimeout(idleTimer); clearTimeout(wallTimer); report('finished', outcome);
  };
  const expire = (kind: NonNullable<BuiltinTransportEvent['timeout']>) => {
    timeout = kind; deadline.abort(new DOMException('Model request timed out', 'TimeoutError'));
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire(headers ? 'idle' : 'headers'), timing.idleMs); idleTimer.unref();
  };
  try {
    report('started'); armIdle(); wallTimer = setTimeout(() => expire('wall'), timing.wallMs); wallTimer.unref();
    const response = await dispatch(signal);
    signal.throwIfAborted(); headers = true; status = response.status; report('headers'); armIdle();
    if (!response.body) { finish('completed'); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            for (;;) {
              const chunk = await reader!.read(); signal.throwIfAborted();
              if (chunk.done) { finish('completed'); controller.close(); return; }
              if (chunk.value.byteLength) {
                bytes += chunk.value.byteLength; chunks++; lastByteMs = elapsed(); firstByteMs ??= lastByteMs; armIdle();
                // The consumer may be waiting on a tool. Keep reading the HTTP
                // response without allowing an unbounded unread buffer.
                if (65536 - (controller.desiredSize ?? 0) + chunk.value.byteLength > limits.historyBytes) throw new AgentError('output_limit');
                controller.enqueue(chunk.value);
              }
            }
          } catch (error) {
            deadline.abort(error); await reader!.cancel().catch(() => {});
            try { finish(timeout ? 'timeout' : parent.aborted ? 'cancelled' : 'failed'); }
            finally { controller.error(timeout ? signal.reason : error); }
          } finally { reader!.releaseLock(); }
        })().catch(error => controller.error(error));
      },
      async cancel(reason) {
        deadline.abort(reason); await reader!.cancel(reason).catch(() => {}); finish('cancelled');
      },
    }, { highWaterMark: 65536, size: chunk => chunk.byteLength });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    deadline.abort(error); await reader?.cancel().catch(() => {});
    finish(timeout ? 'timeout' : parent.aborted ? 'cancelled' : 'failed');
    throw timeout ? signal.reason : error;
  }
}
