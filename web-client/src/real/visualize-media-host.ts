import type { VisualizePagePermissions } from './visualize-permissions';

const channel = 'openworkgraph.visualize.media';
const requestTimeout = 60_000;

/** Only camera/microphone constraints, never an arbitrary host API invocation. */
export function validateVisualizeMediaConstraints(value: unknown): MediaStreamConstraints {
  const fail = (): never => { throw new TypeError('Expected camera or microphone constraints.'); };
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item));
  let fields = 0;
  const check = (item: unknown, depth: number): void => {
    if (++fields > 256 || depth > 6) fail();
    if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 4096) return;
    if (Array.isArray(item)) { if (item.length > 32) fail(); item.forEach(child => check(child, depth + 1)); return; }
    if (!object(item)) fail();
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (!('value' in descriptor) || ['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 128) fail();
      check(descriptor.value, depth + 1);
    }
  };
  if (!object(value) || Object.keys(value).some(key => !['audio', 'video'].includes(key))) fail();
  for (const key of ['audio', 'video']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || typeof descriptor.value !== 'boolean' && !object(descriptor.value)) fail();
    check(descriptor.value, 0);
  }
  const record = value as Record<string, unknown>;
  if (!record.audio && !record.video || JSON.stringify(value).length > 16_384) fail();
  return JSON.parse(JSON.stringify(value)) as MediaStreamConstraints;
}

export function waitForVisualizeMediaIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', cancelled); };
    const cancelled = () => { cleanup(); reject(new DOMException('Media request ended.', 'AbortError')); };
    const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    peer.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled(); else changed();
  });
}

/** One port per capture, bound to the actual opaque iframe and current identity. */
export function bindVisualizeMediaHost(options: {
  window: Window; iframe: HTMLIFrameElement; sessionId: string; nodeId: string;
  permissions(): Pick<VisualizePagePermissions, 'camera' | 'microphone'>;
  active(): boolean;
  onRequest?(constraints: MediaStreamConstraints): void;
}): { setActive(active: boolean): void; dispose(): void } {
  const browser = options.window as Window & typeof globalThis;
  const frame = options.iframe, source = frame.contentWindow;
  if (!source || !frame.sandbox.contains('allow-scripts') || frame.sandbox.contains('allow-same-origin')) throw new TypeError('Media routing requires an opaque script-enabled iframe.');
  type Capture = { port: MessagePort; constraints: MediaStreamConstraints; abort: AbortController; tracks: Map<string, MediaStreamTrack>; peer?: RTCPeerConnection; answered: boolean; timer: ReturnType<typeof setTimeout>; disconnectTimer?: ReturnType<typeof setTimeout> };
  const captures = new Map<string, Capture>();
  let disposed = false, enabled = true;
  const active = () => !disposed && enabled && options.active() && browser.document.visibilityState !== 'hidden' && frame.isConnected && frame.contentWindow === source;
  const permitted = (constraints: MediaStreamConstraints) => {
    const permissions = options.permissions();
    return active() && (!constraints.video || permissions.camera) && (!constraints.audio || permissions.microphone);
  };
  const send = (capture: Capture, value: unknown) => { try { capture.port.postMessage(value); } catch { /* A departed page cannot keep capture alive. */ } };
  function close(id: string, name = 'AbortError', message = 'Media capture stopped.'): void {
    const capture = captures.get(id); if (!capture) return;
    captures.delete(id); clearTimeout(capture.timer); clearTimeout(capture.disconnectTimer); capture.abort.abort();
    for (const track of capture.tracks.values()) track.stop(); capture.tracks.clear();
    if (capture.peer) { capture.peer.onconnectionstatechange = null; capture.peer.close(); }
    send(capture, { type: 'closed', name, message }); capture.port.onmessage = null; capture.port.onmessageerror = null; capture.port.close();
  }
  const stopAll = () => { for (const id of captures.keys()) close(id); };
  async function start(id: string, capture: Capture): Promise<void> {
    try {
      if (!permitted(capture.constraints)) throw new DOMException('Camera or microphone access is disabled for this page.', 'NotAllowedError');
      if (!browser.navigator.mediaDevices?.getUserMedia || !browser.RTCPeerConnection) throw new DOMException('Media capture requires a supported browser and HTTPS or localhost.', 'NotSupportedError');
      const stream = await browser.navigator.mediaDevices.getUserMedia(capture.constraints);
      // Native device prompts cannot be aborted. Fence their late results.
      if (captures.get(id) !== capture || !permitted(capture.constraints)) {
        stream.getTracks().forEach(track => track.stop()); close(id, 'NotAllowedError', 'Media access is no longer available.'); return;
      }
      for (const track of stream.getTracks()) {
        if (track.kind !== 'audio' && track.kind !== 'video' || track.kind === 'audio' && !capture.constraints.audio || track.kind === 'video' && !capture.constraints.video) { track.stop(); continue; }
        capture.tracks.set(track.id, track);
        track.addEventListener('ended', () => {
          if (captures.get(id) !== capture || !capture.tracks.delete(track.id)) return;
          send(capture, { type: 'ended', trackId: track.id }); if (!capture.tracks.size) close(id);
        }, { once: true });
      }
      if (!capture.tracks.size) throw new DOMException('No media tracks are available.', 'NotFoundError');
      const peer = capture.peer = new browser.RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      for (const track of capture.tracks.values()) peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') { clearTimeout(capture.timer); clearTimeout(capture.disconnectTimer); capture.disconnectTimer = undefined; }
        else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') close(id, 'NotReadableError', 'The media connection ended.');
        else if (peer.connectionState === 'disconnected') capture.disconnectTimer ??= setTimeout(() => close(id, 'NotReadableError', 'The media connection was lost.'), 5000);
      };
      await peer.setLocalDescription(await peer.createOffer());
      await waitForVisualizeMediaIce(peer, capture.abort.signal);
      if (captures.get(id) !== capture || !permitted(capture.constraints)) { close(id); return; }
      send(capture, { type: 'offer', sdp: peer.localDescription!.sdp, tracks: [...capture.tracks.values()].map(track => ({ id: track.id, kind: track.kind })) });
    } catch (error) {
      if (captures.get(id) !== capture) return;
      const names = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError', 'NotSupportedError', 'SecurityError', 'TypeError'];
      const name = error instanceof Error && names.includes(error.name) ? error.name : 'OperationError';
      close(id, name, error instanceof Error ? error.message.slice(0, 512) : 'Unable to start media capture.');
    }
  }
  function receive(event: MessageEvent): void {
    const data = event.data;
    if (disposed || event.source !== source || event.origin !== 'null' || !frame.isConnected || frame.contentWindow !== source || !data || data.channel !== channel || data.version !== 1 || data.type !== 'request' || data.sessionId !== options.sessionId || data.nodeId !== options.nodeId || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId) || event.ports.length !== 1) return;
    const port = event.ports[0];
    const refuse = (name: string, message: string) => { port.postMessage({ type: 'closed', name, message }); port.close(); };
    if (captures.has(data.requestId) || captures.size >= 2) { refuse('NotAllowedError', 'Too many media requests from this page.'); return; }
    let constraints: MediaStreamConstraints;
    try { constraints = validateVisualizeMediaConstraints(data.constraints); }
    catch { refuse('TypeError', 'Expected camera or microphone constraints.'); return; }
    options.onRequest?.(constraints);
    const id = data.requestId;
    const capture: Capture = { port, constraints, tracks: new Map(), abort: new AbortController(), answered: false, timer: setTimeout(() => close(id, 'AbortError', 'Media request timed out.'), requestTimeout) };
    captures.set(id, capture);
    port.onmessageerror = () => close(id);
    port.onmessage = async ({ data: message }) => {
      if (captures.get(id) !== capture) return;
      if (!permitted(constraints)) { close(id, 'NotAllowedError', 'Media access is no longer available.'); return; }
      try {
        if (message?.type === 'stop') close(id);
        else if (message?.type === 'stop-track' && typeof message.trackId === 'string') {
          capture.tracks.get(message.trackId)?.stop(); capture.tracks.delete(message.trackId);
          if (!capture.tracks.size) close(id);
        } else if (message?.type === 'enabled' && typeof message.trackId === 'string' && typeof message.enabled === 'boolean') {
          const track = capture.tracks.get(message.trackId); if (track) track.enabled = message.enabled;
        } else if (message?.type === 'answer' && !capture.answered && capture.peer && typeof message.sdp === 'string' && message.sdp.length <= 65_536) {
          capture.answered = true;
          await capture.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        } else close(id, 'OperationError', 'Invalid media control message.');
      } catch { close(id, 'OperationError', 'Unable to connect media.'); }
    };
    void start(id, capture);
  }
  const visibility = () => { if (browser.document.visibilityState === 'hidden') stopAll(); };
  const dispose = () => {
    if (disposed) return; disposed = true; stopAll();
    browser.removeEventListener('message', receive); browser.removeEventListener('pagehide', stopAll);
    browser.document.removeEventListener('visibilitychange', visibility); frame.removeEventListener('load', dispose);
  };
  browser.addEventListener('message', receive); browser.addEventListener('pagehide', stopAll);
  browser.document.addEventListener('visibilitychange', visibility); frame.addEventListener('load', dispose);
  return { dispose, setActive(value) { enabled = value; if (!value) stopAll(); } };
}
