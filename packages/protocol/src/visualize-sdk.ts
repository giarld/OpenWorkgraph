import { VISUALIZE_BRIDGE_VERSION } from './visualize.js';
import type {
  VisualizeBridgeMethod, VisualizeBridgeMethods, VisualizeBridgeRequest, VisualizeBridgeResponse,
  VisualizeExpectedRevisions, VisualizeHostCapabilities, VisualizePageSdk, VisualizeProtocolError,
} from './visualize.js';
import { checkedVisualizeJson, VisualizeValidationError } from './visualize-validation.js';
import { validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, validateVisualizeCapabilityUpdate } from './visualize-bridge.js';
import type { Json } from './index.js';
import { validateNodeSignalMessage, isNodeContentSlot } from './node-signals.js';
import type { NodeSignalCause, NodeSignalEvent, NodeSignalSource, NodeSignalSdk, NodeSignalDescription } from './node-signals.js';

export interface VisualizeSdkClient extends VisualizePageSdk { dispose(): void }

function protocolError(code: VisualizeProtocolError['code'], message: string, retryable = false): Error & VisualizeProtocolError {
  return Object.assign(new Error(message), { name: 'VisualizeProtocolError', code, retryable });
}

/** The caller supplies the page window; this module never reads a global window. */
export function createVisualizePageSdk(options: {
  window: Window; hostWindow?: Window; hostOrigin: string; sessionId: string; nodeId: string;
  timeoutMs?: number; retries?: number;
}): VisualizeSdkClient {
  const { window: pageWindow, hostOrigin, sessionId, nodeId } = options;
  const hostWindow = options.hostWindow ?? pageWindow.parent;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retries = options.retries ?? 1;
  let origin: URL;
  try { origin = new URL(hostOrigin); } catch { throw protocolError('INVALID_REQUEST', 'Invalid host origin'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== hostOrigin || origin.username || origin.password) {
    throw protocolError('INVALID_REQUEST', 'A concrete HTTP(S) host origin is required');
  }
  for (const id of [sessionId, nodeId]) {
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
      throw protocolError('INVALID_REQUEST', 'Invalid bridge identity');
    }
  }
  if (!hostWindow || typeof hostWindow.postMessage !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(retries) || retries < 0 || retries > 3) {
    throw protocolError('INVALID_REQUEST', 'Invalid SDK transport or retry configuration');
  }
  // A random per-client prefix also prevents collisions when a client is recreated.
  const random = new Uint32Array(4);
  pageWindow.crypto.getRandomValues(random);
  const prefix = Array.from(random, value => value.toString(16).padStart(8, '0')).join('');
  let sequence = 0;
  let disposed = false;
  let cause: NodeSignalCause | undefined;
  let signalTail: Promise<unknown> = Promise.resolve();
  const signalListeners = new Set<{ source: NodeSignalSource; handler: (event: NodeSignalEvent) => void | Promise<void> }>();
  const signalSlots = new Map<string, (params: Json) => Json | void | Promise<Json | void>>();
  let capabilities: VisualizeHostCapabilities | undefined;
  let revisions: VisualizeExpectedRevisions = {
    pageRevision: 0, formVersion: 0, stateVersion: 0, inputVersion: 0, executionRevision: 0, layoutRevision: 0,
  };
  type Fence = { settled: boolean; error?: unknown };
  type Job = {
    method: VisualizeBridgeMethod; params: VisualizeBridgeMethods[VisualizeBridgeMethod]['params'];
    resolve(value: unknown): void; reject(reason: unknown): void; bytes?: ArrayBuffer | undefined;
    cause?: NodeSignalCause;
    inputRecovery?: boolean;
    fence: Fence;
    waitFor: Fence[];
  };
  type Pending = { job: Job; request: VisualizeBridgeRequest; attempts: number; timer?: number };
  const queue: Job[] = [];
  let pending: Pending | undefined;
  const signalQueue: Job[] = [];
  let signalPending: Pending | undefined;
  const isPending = (current: Pending) => pending === current || signalPending === current;
  const mutation = (method: VisualizeBridgeMethod) => !['initialize', 'readInputs', 'signals'].includes(method);
  const emission = (job: Pick<Job, 'method' | 'params'>) => job.method === 'signals' && (job.params as VisualizeBridgeMethods['signals']['params']).action === 'emit';

  function settle(job: Job, error?: unknown, value?: unknown): void {
    job.fence.settled = true;
    if (error !== undefined) { job.fence.error = error; job.reject(error); }
    else job.resolve(value);
  }

  function recoverInputs(): void {
    capabilities = undefined;
    if (queue[0]?.method !== 'initialize') queue.unshift({ method: 'initialize', params: {}, inputRecovery: true, fence: { settled: false }, waitFor: [], resolve: () => undefined, reject: () => undefined });
  }

  function finish(current: Pending, error?: unknown, value?: unknown): void {
    if (!isPending(current)) return;
    if (pending === current) pending = undefined;
    if (signalPending === current) signalPending = undefined;
    if (current.timer !== undefined) pageWindow.clearTimeout(current.timer);
    settle(current.job, error, value);
    pump();
  }

  function send(current: Pending): void {
    if (disposed || !isPending(current)) return;
    current.attempts++;
    const refresh = current.request.method === 'readInputs' && current.request.params.refresh;
    // Arm before posting: synchronous fake transports are supported too.
    current.timer = pageWindow.setTimeout(() => {
      if (!isPending(current)) return;
      if (current.attempts <= retries) send(current);
      else {
        // A refresh may already have advanced the host snapshot while media is
        // still loading. Resync before releasing queued calls with old revisions.
        if (refresh) recoverInputs();
        finish(current, protocolError('INTERNAL_ERROR', 'Visualize host response timed out', true));
      }
    }, current.request.method === 'exportAsset' || refresh ? Math.max(timeoutMs, 60_000) : timeoutMs);
    try {
      if (current.job.bytes) { const bytes = current.job.bytes.slice(0); hostWindow.postMessage({ request: current.request, bytes }, hostOrigin, [bytes]); }
      else hostWindow.postMessage(current.request, hostOrigin);
    }
    catch {
      if (isPending(current)) finish(current, protocolError('INTERNAL_ERROR', 'Unable to send visualize request'));
    }
  }

  function pump(): void {
    pumpQueue(false);
    pumpQueue(true);
  }
  function pumpQueue(signals: boolean): void {
    if (disposed || (signals ? signalPending : pending)) return;
    // Recovery preempts both lanes. Other dependencies are captured when called,
    // so an emission can bypass a read without overtaking a preceding save.
    if (signals && (pending?.request.method === 'initialize' || queue.some(job => job.inputRecovery))) return;
    const jobs = signals ? signalQueue : queue;
    let job: Job | undefined;
    // Drain locally rejected jobs without recursing through a potentially long queue.
    while (jobs.length) {
      if (jobs[0]!.waitFor.some(fence => !fence.settled)) return;
      job = jobs.shift()!;
      let blocked: Error | undefined;
      const failedWrite = emission(job) ? job.waitFor.find(fence => fence.error !== undefined) : undefined;
      if (failedWrite) {
        settle(job, failedWrite.error); queueMicrotask(pump); job = undefined; continue;
      }
      if (job.method !== 'initialize' && !capabilities) {
        blocked = protocolError('INVALID_REQUEST', 'Initialize the visualize SDK first');
      } else if (job.method !== 'initialize' && job.method !== 'readInputs' && job.method !== 'signals') {
        if (capabilities?.readOnly) blocked = protocolError('READ_ONLY', 'Visualize host is read only');
        else if (!capabilities?.online) blocked = protocolError('OFFLINE', 'Visualize host is offline', true);
        else if (job.method === 'createSuccessors' && !capabilities.canCreateSuccessors) {
          blocked = protocolError('INPUT_BLOCKED', 'Successor creation is unavailable');
        } else if (job.method === 'exportAsset' && !capabilities.canExportAssets) {
          blocked = protocolError('INPUT_BLOCKED', 'Asset export is unavailable');
        }
      }
      if (!blocked) {
        try { validateVisualizeBridgeRequest({ channel: 'openworkgraph.visualize', version: VISUALIZE_BRIDGE_VERSION, sessionId, nodeId, requestId: prefix + '-validate', type: 'request', method: job.method, expected: { ...revisions }, params: job.params }); }
        catch (error) { blocked = error instanceof VisualizeValidationError ? protocolError(error.code, error.message) : protocolError('INVALID_REQUEST', 'Invalid visualize parameters'); }
      }
      if (!blocked) break;
      settle(job, blocked); queueMicrotask(pump); job = undefined;
    }
    if (!job) return;
    const request = {
      channel: 'openworkgraph.visualize', version: VISUALIZE_BRIDGE_VERSION, type: 'request',
      sessionId, nodeId, requestId: `${prefix}-${++sequence}`, method: job.method,
      expected: { ...revisions }, params: job.params, ...(job.cause ? { cause: job.cause } : {}),
    } as VisualizeBridgeRequest;
    const current = { job, request, attempts: 0 };
    if (signals) signalPending = current; else pending = current;
    send(current);
  }

  function onMessage(event: MessageEvent): void {
    if (disposed || event.source !== hostWindow || event.origin !== hostOrigin) return;
    if (event.data?.channel === 'openworkgraph.node-signals') {
      let message;
      try { message = validateNodeSignalMessage(event.data); } catch { return; }
      if (message.sessionId !== sessionId || message.nodeId !== nodeId) return;
      signalTail = signalTail.catch(() => undefined).then(async () => {
        if (disposed) return;
        cause = message.type === 'event' ? message.event.cause : message.cause;
        try {
          if (message.type === 'event') {
            for (const listener of [...signalListeners]) {
              const source = listener.source, emitted = message.event;
              if (source.signal === emitted.signal && (source.nodeId === emitted.nodeId || (emitted.relations ?? [emitted.relation]).includes(source.nodeId as typeof emitted.relation))) {
                try { await listener.handler(emitted); } catch { /* One listener must not suppress other listeners. */ }
              }
            }
          } else {
            const claimed = await call('signals', { action: 'claim', invocationId: message.invocationId });
            if (claimed.value !== true || disposed) return;
            let value: Json = null, ok = true;
            try {
              if (message.slot === 'inputs.refresh' && message.targetNodeId === nodeId) {
                let refreshed: VisualizeBridgeMethods['readInputs']['result'];
                // This slot follows current state, so a predecessor changing
                // during verification can be read again. Never retry writes or
                // permission/resource/session failures as revision conflicts.
                for (let attempt = 0; ; attempt++) {
                  try { refreshed = await call('readInputs', { refresh: true }); break; }
                  catch (error) {
                    if (attempt >= 2 || (error as { code?: string } | null)?.code !== 'REVISION_CONFLICT') throw error;
                  }
                }
                value = { inputVersion: refreshed.inputs.version, digest: refreshed.inputs.digest };
              }
              else if (isNodeContentSlot(message.slot)) {
                value = await call('contentSlot', { targetNodeId: message.targetNodeId, invocationId: message.invocationId, slot: message.slot, update: message.params as unknown as VisualizeBridgeMethods['contentSlot']['params']['update'] }) as unknown as Json;
              }
              else if (message.slot === 'prompt.update') {
                // Keep malformed payloads intact for validation; never turn a missing prompt into an empty update.
                const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
                value = await call('promptSlot', { ...params, targetNodeId: message.targetNodeId, invocationId: message.invocationId } as unknown as VisualizeBridgeMethods['promptSlot']['params']) as unknown as Json;
              }
              else if (message.slot === 'run.submit' || message.slot === 'run.cancel') {
                const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
                value = await call('runSlot', { targetNodeId: message.targetNodeId, action: message.slot === 'run.submit' ? 'submit' : 'cancel', invocationId: message.invocationId, ...(message.slot === 'run.cancel' ? { runId: typeof params.runId === 'string' ? params.runId : '' } : {}) }) as unknown as Json;
              } else {
                const handler = signalSlots.get(message.slot);
                if (!handler || message.targetNodeId !== nodeId) throw protocolError('INPUT_BLOCKED', 'The node slot is unavailable');
                value = checkedVisualizeJson(await handler(message.params) ?? null);
              }
            } catch (error) { ok = false; const e = error as Error & { code?: string }; value = { code: e.code ?? 'INTERNAL_ERROR', message: String(e.message ?? 'Node slot failed').slice(0, 2000) }; }
            if (!disposed) await call('signals', { action: 'result', invocationId: message.invocationId, ok, value });
          }
        } finally { cause = undefined; }
      });
      void signalTail.catch(() => undefined);
      return;
    }
    try {
      const update = validateVisualizeCapabilityUpdate(event.data);
      if (capabilities && update.sessionId === sessionId && update.nodeId === nodeId) capabilities = { ...update.capabilities };
      return;
    } catch { /* Ordinary responses continue through their strict validator. */ }
    let response: VisualizeBridgeResponse;
    try { response = validateVisualizeBridgeResponse(event.data); } catch { return; }
    const current = pending?.request.requestId === response.requestId ? pending : signalPending?.request.requestId === response.requestId ? signalPending : undefined;
    if (!current) return;
    const request = current.request;
    if (response.channel !== request.channel || response.version !== request.version ||
        response.type !== 'response' || response.sessionId !== sessionId || response.nodeId !== nodeId ||
        response.requestId !== request.requestId || response.method !== request.method) return;
    if (!response.ok) {
      const error = protocolError(response.error.code, response.error.message, response.error.retryable);
      // Only protocol fields escape the bridge; transport/credentials are never attached.
      if (response.error.fields) error.fields = response.error.fields.map(field => ({ ...field }));
      // Media preparation follows the committed input refresh. Its failure does
      // not roll back that version, so recover before sending queued requests.
      if (request.method === 'readInputs' && request.params.refresh && response.error.code === 'RESOURCE_UNAVAILABLE') recoverInputs();
      finish(current, error);
      return;
    }
    switch (response.method) {
      case 'initialize':
        // Automatic input recovery does not deliver the form/state to page code.
        // Keep their known versions so unseen edits still cause CAS conflicts.
        revisions = { ...response.result.revisions, ...(current.job.inputRecovery ? { formVersion: revisions.formVersion, stateVersion: revisions.stateVersion } : {}) };
        capabilities = { ...response.result.capabilities };
        break;
      case 'saveState':
        // Only advance a data version when this page received that snapshot.
        // A state save can observe another session's form without returning it.
        revisions = { ...response.result.revisions, formVersion: revisions.formVersion, inputVersion: revisions.inputVersion };
        break;
      case 'updateForm': case 'createSuccessors':
        revisions = { ...response.result.revisions, stateVersion: revisions.stateVersion, inputVersion: revisions.inputVersion };
        break;
      case 'exportAsset':
        revisions = { ...response.result.revisions, formVersion: revisions.formVersion, stateVersion: revisions.stateVersion, inputVersion: revisions.inputVersion };
        break;
      case 'contentSlot': case 'promptSlot':
        revisions = { ...revisions, executionRevision: Math.max(revisions.executionRevision, response.result.executionRevision) };
        break;
      case 'readInputs': revisions.inputVersion = response.result.inputs.version; break;
      case 'requestLayout': revisions.layoutRevision = response.result.layoutRevision; break;
    }
    finish(current, undefined, response.result);
  }

  function call<M extends VisualizeBridgeMethod>(method: M, params: VisualizeBridgeMethods[M]['params'], bytes?: ArrayBuffer): Promise<VisualizeBridgeMethods[M]['result']> {
    if (disposed) return Promise.reject(protocolError('SESSION_EXPIRED', 'Visualize SDK is disposed'));
    let snapshot: VisualizeBridgeMethods[M]['params'];
    try {
      snapshot = checkedVisualizeJson(params) as unknown as VisualizeBridgeMethods[M]['params'];
    }
    catch (error) {
      const failure = error instanceof VisualizeValidationError
        ? protocolError(error.code, error.message) : protocolError('INVALID_REQUEST', 'Invalid visualize parameters');
      return Promise.reject(failure);
    }
    return new Promise((resolve, reject) => {
      const job: Job = { method, params: snapshot, bytes, fence: { settled: false }, waitFor: [], ...(cause ? { cause: structuredClone(cause) } : {}), resolve: value => resolve(value as VisualizeBridgeMethods[M]['result']), reject };
      if (method === 'signals') {
        job.waitFor = [...(pending ? [pending.job] : []), ...queue].filter(prior => prior.method === 'initialize' || emission(job) && mutation(prior.method)).map(prior => prior.fence);
      } else if (mutation(method)) {
        job.waitFor = [...(signalPending ? [signalPending.job] : []), ...signalQueue].filter(emission).map(prior => prior.fence);
      }
      (method === 'signals' ? signalQueue : queue).push(job);
      pump();
    });
  }

  pageWindow.addEventListener('message', onMessage);
  const signals: NodeSignalSdk = {
    connect: connection => call('signals', { action: 'connect', connection }).then(result => result.value),
    disconnect: id => call('signals', { action: 'disconnect', id }).then(result => result.value),
    emit: (signal, payload = null) => call('signals', { action: 'emit', signal, payload }).then(result => result.value),
    on(source, handler) {
      if (disposed) throw protocolError('SESSION_EXPIRED', 'Visualize SDK is disposed');
      const listener = { source: typeof source === 'string' ? { nodeId: 'self', signal: source } : source, handler };
      signalListeners.add(listener); return () => { signalListeners.delete(listener); };
    },
    async defineSlot(slot, handler) {
      signalSlots.set(slot, handler);
      try { await call('signals', { action: 'registerSlot', slot }); } catch (error) { signalSlots.delete(slot); throw error; }
      return async () => { if (signalSlots.get(slot) !== handler) return; signalSlots.delete(slot); await call('signals', { action: 'unregisterSlot', slot }); };
    },
    describe: () => call('signals', { action: 'describe' }).then(result => result.value as unknown as NodeSignalDescription),
  };
  return {
    signals,
    initialize: () => call('initialize', {}),
    async exportAsset(asset) {
      if (!asset || typeof asset !== 'object' || Object.keys(asset).some(key => !['name', 'mime', 'blob'].includes(key)) || !(asset.blob instanceof Blob)) throw protocolError('INVALID_REQUEST', 'Expected an asset Blob');
      const params = { name: asset.name, mime: asset.mime ?? (asset.blob.type || 'application/octet-stream'), bytes: asset.blob.size };
      validateVisualizeBridgeRequest({ channel: 'openworkgraph.visualize', version: VISUALIZE_BRIDGE_VERSION, sessionId, nodeId, requestId: prefix + '-validate', type: 'request', method: 'exportAsset', expected: { ...revisions }, params });
      return call('exportAsset', params, await asset.blob.arrayBuffer());
    },
    readInputs: (refresh = false) => call('readInputs', { refresh }),
    saveState: state => call('saveState', { state }),
    updateForm: form => call('updateForm', { form }),
    createSuccessors: (successors, form) => call('createSuccessors', form === undefined ? { successors } : { successors, form }),
    requestLayout: size => call('requestLayout', size),
    dispose() {
      if (disposed) return;
      disposed = true;
      signalListeners.clear(); signalSlots.clear();
      pageWindow.removeEventListener('message', onMessage);
      const error = protocolError('SESSION_EXPIRED', 'Visualize SDK is disposed');
      if (pending) finish(pending, error);
      if (signalPending) finish(signalPending, error);
      for (const job of queue.splice(0)) settle(job, error);
      for (const job of signalQueue.splice(0)) settle(job, error);
    },
  };
}
