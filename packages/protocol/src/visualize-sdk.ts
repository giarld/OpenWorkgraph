import { VISUALIZE_BRIDGE_VERSION } from './visualize.js';
import type {
  VisualizeBridgeMethod, VisualizeBridgeMethods, VisualizeBridgeRequest, VisualizeBridgeResponse,
  VisualizeExpectedRevisions, VisualizeHostCapabilities, VisualizePageSdk, VisualizeProtocolError,
} from './visualize.js';
import { checkedVisualizeJson, VisualizeValidationError } from './visualize-validation.js';
import { validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, validateVisualizeCapabilityUpdate } from './visualize-bridge.js';

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
  let capabilities: VisualizeHostCapabilities | undefined;
  let revisions: VisualizeExpectedRevisions = {
    pageRevision: 0, formVersion: 0, stateVersion: 0, inputVersion: 0, executionRevision: 0, layoutRevision: 0,
  };
  type Job = {
    method: VisualizeBridgeMethod; params: VisualizeBridgeMethods[VisualizeBridgeMethod]['params'];
    resolve(value: unknown): void; reject(reason: unknown): void; bytes?: ArrayBuffer | undefined;
  };
  type Pending = { job: Job; request: VisualizeBridgeRequest; attempts: number; timer?: number };
  const queue: Job[] = [];
  let pending: Pending | undefined;

  function finish(error?: unknown, value?: unknown): void {
    const current = pending;
    if (!current) return;
    pending = undefined;
    if (current.timer !== undefined) pageWindow.clearTimeout(current.timer);
    if (error !== undefined) current.job.reject(error); else current.job.resolve(value);
    pump();
  }

  function send(current: Pending): void {
    if (disposed || pending !== current) return;
    current.attempts++;
    const refresh = current.request.method === 'readInputs' && current.request.params.refresh;
    // Arm before posting: synchronous fake transports are supported too.
    current.timer = pageWindow.setTimeout(() => {
      if (pending !== current) return;
      if (current.attempts <= retries) send(current);
      else {
        // A refresh may already have advanced the host snapshot while media is
        // still loading. Resync before releasing queued calls with old revisions.
        if (refresh) {
          capabilities = undefined;
          if (queue[0]?.method !== 'initialize') queue.unshift({ method: 'initialize', params: {}, resolve: () => undefined, reject: () => undefined });
        }
        finish(protocolError('INTERNAL_ERROR', 'Visualize host response timed out', true));
      }
    }, current.request.method === 'exportAsset' || refresh ? Math.max(timeoutMs, 60_000) : timeoutMs);
    try {
      if (current.job.bytes) { const bytes = current.job.bytes.slice(0); hostWindow.postMessage({ request: current.request, bytes }, hostOrigin, [bytes]); }
      else hostWindow.postMessage(current.request, hostOrigin);
    }
    catch {
      if (pending === current) finish(protocolError('INTERNAL_ERROR', 'Unable to send visualize request'));
    }
  }

  function pump(): void {
    if (disposed || pending) return;
    let job: Job | undefined;
    // Drain locally rejected jobs without recursing through a potentially long queue.
    while ((job = queue.shift())) {
      let blocked: Error | undefined;
      if (job.method !== 'initialize' && !capabilities) {
        blocked = protocolError('INVALID_REQUEST', 'Initialize the visualize SDK first');
      } else if (job.method !== 'initialize' && job.method !== 'readInputs') {
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
      job.reject(blocked);
    }
    if (!job) return;
    const request = {
      channel: 'openworkgraph.visualize', version: VISUALIZE_BRIDGE_VERSION, type: 'request',
      sessionId, nodeId, requestId: `${prefix}-${++sequence}`, method: job.method,
      expected: { ...revisions }, params: job.params,
    } as VisualizeBridgeRequest;
    pending = { job, request, attempts: 0 };
    send(pending);
  }

  function onMessage(event: MessageEvent): void {
    if (disposed || event.source !== hostWindow || event.origin !== hostOrigin) return;
    try {
      const update = validateVisualizeCapabilityUpdate(event.data);
      if (capabilities && update.sessionId === sessionId && update.nodeId === nodeId) capabilities = { ...update.capabilities };
      return;
    } catch { /* Ordinary responses continue through their strict validator. */ }
    if (!pending) return;
    let response: VisualizeBridgeResponse;
    try { response = validateVisualizeBridgeResponse(event.data); } catch { return; }
    const request = pending.request;
    if (response.channel !== request.channel || response.version !== request.version ||
        response.type !== 'response' || response.sessionId !== sessionId || response.nodeId !== nodeId ||
        response.requestId !== request.requestId || response.method !== request.method) return;
    if (!response.ok) {
      const error = protocolError(response.error.code, response.error.message, response.error.retryable);
      // Only protocol fields escape the bridge; transport/credentials are never attached.
      if (response.error.fields) error.fields = response.error.fields.map(field => ({ ...field }));
      finish(error);
      return;
    }
    switch (response.method) {
      case 'initialize':
        revisions = { ...response.result.revisions };
        capabilities = { ...response.result.capabilities };
        break;
      case 'saveState': case 'updateForm': case 'createSuccessors': case 'exportAsset':
        revisions = { ...response.result.revisions };
        break;
      case 'readInputs': revisions.inputVersion = response.result.inputs.version; break;
      case 'requestLayout': revisions.layoutRevision = response.result.layoutRevision; break;
    }
    finish(undefined, response.result);
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
      queue.push({ method, params: snapshot, bytes, resolve: value => resolve(value as VisualizeBridgeMethods[M]['result']), reject });
      pump();
    });
  }

  pageWindow.addEventListener('message', onMessage);
  return {
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
      pageWindow.removeEventListener('message', onMessage);
      const error = protocolError('SESSION_EXPIRED', 'Visualize SDK is disposed');
      finish(error);
      for (const job of queue.splice(0)) job.reject(error);
    },
  };
}
