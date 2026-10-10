import type { VisualizeBridgeRequest, VisualizeBridgeResponse } from './visualize.js';
import { validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, visualizeProtocolError } from './visualize-bridge.js';
import { VisualizeValidationError } from './visualize-validation.js';

const bindings = new WeakMap<Window, Map<string, (notify?: boolean) => void>>();
/** Pointer fractions within the iframe viewport, independent of graph scale. */
export interface VisualizeZoomGesture {
  x: number; y: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean;
}
/** Bind AFTER the initial iframe load. Any further navigation invalidates it. */
export function bindVisualizeIframe(options: {
  window: Window; iframe: HTMLIFrameElement; sessionId: string; nodeId: string;
  dispatch(request: VisualizeBridgeRequest, bytes?: ArrayBuffer): Promise<VisualizeBridgeResponse>;
  close?: () => Promise<void> | void; online?: () => boolean;
  /** A bounded view gesture can dismiss only this host-owned viewer. */
  onDismiss?: () => void;
  onZoom?: (gesture: VisualizeZoomGesture) => void;
}): { dispose(): void } {
  const source = options.iframe.contentWindow;
  if (!source || options.iframe.ownerDocument.defaultView !== options.window || !options.iframe.sandbox.contains('allow-scripts') || options.iframe.sandbox.contains('allow-same-origin')) throw new VisualizeValidationError('INVALID_REQUEST', 'Visualize requires a script-enabled opaque-origin iframe');
  const active = bindings.get(options.window) ?? new Map<string, (notify?: boolean) => void>();
  // A new view can reuse the workspace session/input snapshot. Fence the old
  // WindowProxy locally without deleting the capability the new view is using.
  active.get(options.sessionId)?.(false);
  let disposed = false, pending = 0;
  const refreshes = new Map<string, { payload: string; promise: Promise<VisualizeBridgeResponse> }>();
  let completedRefresh: { requestId: string; payload: string; promise: Promise<VisualizeBridgeResponse> } | undefined;
  const navigation = () => close();
  const close = (notify = true) => { if (disposed) return; disposed = true; refreshes.clear(); completedRefresh = undefined; options.window.removeEventListener('message', receive); options.iframe.removeEventListener('load', navigation); if (active.get(options.sessionId) === close) active.delete(options.sessionId); if (notify) try { void Promise.resolve(options.close?.()).catch(() => undefined); } catch { /* A close transport failure never keeps the local binding alive. */ } };
  function send(request: VisualizeBridgeRequest, value: unknown): void {
    if (disposed || options.iframe.contentWindow !== source || active.get(options.sessionId) !== close || !options.iframe.isConnected) return;
    const response = validateVisualizeBridgeResponse(value);
    if (response.sessionId !== request.sessionId || response.nodeId !== request.nodeId || response.requestId !== request.requestId || response.method !== request.method) throw new VisualizeValidationError('INVALID_REQUEST', 'Unexpected bridge response identity');
    // Opaque sandbox receivers require '*'; the captured WindowProxy is the sole target.
    source!.postMessage(response, '*');
  }
  async function receive(event: MessageEvent): Promise<void> {
    if (disposed || event.source !== source || event.origin !== 'null' || options.iframe.contentWindow !== source || !options.iframe.isConnected) return;
    const view = event.data;
    if (view && typeof view === 'object' && !Array.isArray(view) && Object.keys(view).sort().join(',') === 'channel,ctrlKey,deltaMode,deltaY,event,metaKey,nodeId,sessionId,type,version,x,y' && Object.values(Object.getOwnPropertyDescriptors(view)).every(field => 'value' in field) && view.channel === 'openworkgraph.visualize' && view.version === 1 && view.type === 'view-event' && view.event === 'zoom' && view.sessionId === options.sessionId && view.nodeId === options.nodeId) {
      if ([view.x, view.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) && typeof view.deltaY === 'number' && Number.isFinite(view.deltaY) && Math.abs(view.deltaY) <= 1_000_000 && [0, 1, 2].includes(view.deltaMode) && typeof view.ctrlKey === 'boolean' && typeof view.metaKey === 'boolean' && (view.ctrlKey || view.metaKey)) {
        options.onZoom?.({ x: view.x, y: view.y, deltaY: view.deltaY, deltaMode: view.deltaMode, ctrlKey: view.ctrlKey, metaKey: view.metaKey });
      }
      return;
    }
    if (view && typeof view === 'object' && !Array.isArray(view) && Object.keys(view).length === 6 && Object.keys(view).sort().join(',') === 'channel,event,nodeId,sessionId,type,version' && Object.values(Object.getOwnPropertyDescriptors(view)).every(field => 'value' in field) && view.channel === 'openworkgraph.visualize' && view.version === 1 && view.type === 'view-event' && view.event === 'dismiss' && view.sessionId === options.sessionId && view.nodeId === options.nodeId) { options.onDismiss?.(); return; }
    let request: VisualizeBridgeRequest;
    let value = event.data, bytes: ArrayBuffer | undefined;
    if (value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'bytes,request') {
      const fields = Object.getOwnPropertyDescriptors(value);
      if (!fields.bytes || !fields.request || !('value' in fields.bytes) || !('value' in fields.request) || !(fields.bytes.value instanceof ArrayBuffer) || fields.bytes.value.byteLength > 300 * 1024 * 1024) return;
      bytes = fields.bytes.value; value = fields.request.value;
    }
    try { request = validateVisualizeBridgeRequest(value); } catch { return; }
    if (request.method === 'exportAsset' ? !bytes || bytes.byteLength !== request.params.bytes : bytes !== undefined) return;
    if (request.sessionId !== options.sessionId || request.nodeId !== options.nodeId) return;
    const failure = (error: unknown): VisualizeBridgeResponse => ({ channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId: request.nodeId, requestId: request.requestId, type: 'response', method: request.method, ok: false, error: visualizeProtocolError(error) });
    if (pending >= 32) { send(request, failure(new VisualizeValidationError('INPUT_BLOCKED', '页面请求过多，请稍后重试。'))); return; }
    if (options.online?.() === false) { send(request, failure(new VisualizeValidationError('OFFLINE', '工作空间已断开，请重新连接。'))); return; }
    const refresh = request.method === 'readInputs' && request.params.refresh;
    const payload = refresh ? JSON.stringify(Object.entries(request.expected).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : '';
    const shared = refresh ? refreshes.get(request.requestId) ?? (completedRefresh?.requestId === request.requestId ? completedRefresh : undefined) : undefined;
    if (shared && shared.payload !== payload) { send(request, failure(new VisualizeValidationError('IDEMPOTENCY_CONFLICT', '同一请求标识不能使用不同内容。'))); return; }
    pending++;
    try {
      // Keep the entire refresh, including media preparation, independent of
      // workspace receipt eviction by input polling. One completed receipt also
      // covers a lost acknowledgement until the next successful refresh.
      const work = shared?.promise ?? (bytes ? options.dispatch(request, bytes) : options.dispatch(request));
      if (refresh && !shared) refreshes.set(request.requestId, { payload, promise: work });
      const result = await work;
      send(request, result);
      if (refresh && result.ok && !disposed) completedRefresh = { requestId: request.requestId, payload, promise: Promise.resolve(result) };
    }
    catch (error) { try { send(request, failure(error)); } catch { /* Drop a broken response without exposing host exceptions. */ } }
    finally { pending--; if (refresh && !shared) refreshes.delete(request.requestId); }
  }
  active.set(options.sessionId, close); bindings.set(options.window, active);
  options.window.addEventListener('message', receive); options.iframe.addEventListener('load', navigation);
  return { dispose: () => close() };
}
