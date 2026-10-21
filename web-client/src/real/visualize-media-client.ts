export interface VisualizeMediaClient {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  stopAll(): void;
}

/** Self-contained: serialized into the opaque page before any author code. */
export function installVisualizeMediaClient(identity: { hostOrigin: string; sessionId: string; nodeId: string }): void {
  const page = window as Window & { visualizeMedia?: VisualizeMediaClient };
  if (typeof MediaStream === 'undefined' || typeof MediaStreamTrack === 'undefined' || typeof RTCPeerConnection === 'undefined' || typeof MessageChannel === 'undefined') {
    Object.defineProperty(page, 'visualizeMedia', { value: Object.freeze({ getUserMedia: () => Promise.reject(new DOMException('Media routing is unavailable in this browser.', 'NotSupportedError')), stopAll() {} }) });
    return;
  }
  type Group = { id: string; tracks: Set<MediaStreamTrack>; playback?: HTMLAudioElement };
  type Capture = { port: MessagePort; peer?: RTCPeerConnection; abort: AbortController; groups: Map<string, Group>; stream: MediaStream; starting?: boolean; settled: boolean; resolve(stream: MediaStream): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> };
  const captures = new Map<string, Capture>();
  const routed = new WeakMap<MediaStreamTrack, { capture: Capture; group: Group; stop(): void }>();
  const originalClone = MediaStream.prototype.clone;
  const trackEnabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  const ready = new Promise<void>(resolve => {
    if (document.readyState === 'complete') setTimeout(resolve, 0);
    else window.addEventListener('load', () => setTimeout(resolve, 0), { once: true });
  });
  function send(capture: Capture, message: unknown): void { try { capture.port.postMessage(message); } catch { /* The host will stop its capture on teardown. */ } }
  function error(name: string, message: string): Error { return name === 'TypeError' ? new TypeError(message) : new DOMException(message, name); }
  function stopPlayback(group: Group): void {
    const audio = group.playback; if (!audio) return;
    group.playback = undefined; audio.pause();
    (audio.srcObject as MediaStream | null)?.getTracks().forEach(track => track.stop());
    audio.srcObject = null;
  }
  function end(group: Group): void {
    stopPlayback(group);
    for (const track of [...group.tracks]) {
      group.tracks.delete(track);
      if (track.readyState === 'ended') continue;
      routed.get(track)?.stop(); track.dispatchEvent(new Event('ended'));
    }
  }
  function close(id: string, reason: Error = error('AbortError', 'Media capture stopped.')): void {
    const capture = captures.get(id); if (!capture) return;
    captures.delete(id); clearTimeout(capture.timer); capture.abort.abort();
    send(capture, { type: 'stop' });
    if (capture.peer) { capture.peer.ontrack = null; capture.peer.onconnectionstatechange = null; capture.peer.close(); }
    for (const group of capture.groups.values()) end(group);
    capture.port.onmessage = null; capture.port.onmessageerror = null; capture.port.close();
    if (!capture.settled) { capture.settled = true; capture.reject(reason); }
  }
  function wrap(track: MediaStreamTrack, capture: Capture, group: Group): MediaStreamTrack {
    const stop = track.stop.bind(track), clone = track.clone.bind(track);
    if (track.readyState === 'live') group.tracks.add(track);
    routed.set(track, { capture, group, stop });
    const enabledChanged = () => send(capture, { type: 'enabled', trackId: group.id, enabled: [...group.tracks].some(item => item.enabled) });
    Object.defineProperty(track, 'stop', { configurable: true, value: () => {
      stop(); if (!group.tracks.delete(track)) return;
      if (!group.tracks.size) { stopPlayback(group); send(capture, { type: 'stop-track', trackId: group.id }); } else enabledChanged();
    } });
    Object.defineProperty(track, 'clone', { configurable: true, value: () => {
      const result = wrap(clone(), capture, group); if (group.tracks.has(result)) enabledChanged(); return result;
    } });
    if (trackEnabled?.get && trackEnabled.set) Object.defineProperty(track, 'enabled', { configurable: true,
      get: () => trackEnabled.get!.call(track), set: value => { trackEnabled.set!.call(track, Boolean(value)); if (group.tracks.has(track)) enabledChanged(); },
    });
    track.addEventListener('ended', () => {
      if (!group.tracks.delete(track)) return;
      if (!group.tracks.size) { stopPlayback(group); send(capture, { type: 'stop-track', trackId: group.id }); } else enabledChanged();
    }, { once: true });
    return track;
  }
  // Native MediaStream.clone internally clones tracks without invoking their JS
  // clone methods. Preserve ownership for streams constructed by page code too.
  MediaStream.prototype.clone = function () {
    return this.getTracks().some(track => routed.has(track)) ? new MediaStream(this.getTracks().map(track => track.clone())) : originalClone.call(this);
  };
  function gathered(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', cancelled); };
      const cancelled = () => { cleanup(); reject(error('AbortError', 'Media request ended.')); };
      const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      peer.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled(); else changed();
    });
  }
  function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    return new Promise((resolve, reject) => {
      if (captures.size >= 2) { reject(error('NotAllowedError', 'Too many media requests from this page.')); return; }
      const id = crypto.randomUUID(), ports = new MessageChannel();
      const capture: Capture = { port: ports.port1, abort: new AbortController(), groups: new Map(), stream: new MediaStream(), settled: false, resolve, reject,
        timer: setTimeout(() => close(id, error('AbortError', 'Media request timed out.')), 60_000) };
      captures.set(id, capture);
      const connected = async () => {
        if (captures.get(id) !== capture || capture.settled || capture.starting || capture.peer?.connectionState !== 'connected' || capture.stream.getTracks().length !== capture.groups.size) return;
        capture.starting = true;
        try {
          // Chromium needs media-element playout to pull remote audio through
          // WebRTC's decoder, even when the page only uses MediaRecorder/WebAudio.
          await Promise.all([...capture.groups.values()].map(group => group.playback?.play()));
          if (captures.get(id) !== capture || capture.settled) return;
          capture.settled = true; clearTimeout(capture.timer); resolve(capture.stream);
        } catch (reason) { close(id, reason instanceof Error ? reason : error('NotReadableError', 'Unable to start received audio.')); }
      };
      capture.port.onmessageerror = () => close(id, error('OperationError', 'Invalid media response.'));
      capture.port.onmessage = async ({ data }) => {
        if (captures.get(id) !== capture) return;
        try {
          if (data?.type === 'closed') { close(id, error(typeof data.name === 'string' ? data.name : 'AbortError', typeof data.message === 'string' ? data.message : 'Media capture stopped.')); return; }
          if (data?.type === 'ended' && typeof data.trackId === 'string') { const group = capture.groups.get(data.trackId); if (group) end(group); return; }
          if (data?.type !== 'offer' || capture.peer || typeof data.sdp !== 'string' || data.sdp.length > 65_536 || !Array.isArray(data.tracks) || !data.tracks.length || data.tracks.length > 2) throw error('OperationError', 'Invalid media offer.');
          for (const track of data.tracks) {
            if (!track || typeof track.id !== 'string' || !['audio', 'video'].includes(track.kind) || capture.groups.has(track.id)) throw error('OperationError', 'Invalid media tracks.');
            capture.groups.set(track.id, { id: track.id, tracks: new Set() });
          }
          const peer = capture.peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
          peer.ontrack = ({ track }) => {
            const group = capture.groups.get(track.id);
            if (!group || group.tracks.size) { track.stop(); close(id, error('OperationError', 'Unexpected media track.')); return; }
            try {
              if (track.kind === 'audio') {
                const audio = group.playback = new Audio(); audio.muted = true;
                // This internal native clone drives decoding while page-owned
                // clones remain live. It must never count as a device consumer.
                audio.srcObject = new MediaStream([track.clone()]);
              }
              capture.stream.addTrack(wrap(track, capture, group)); void connected();
            } catch (reason) { track.stop(); close(id, reason instanceof Error ? reason : error('OperationError', 'Unable to receive media.')); }
          };
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === 'failed' || peer.connectionState === 'closed') close(id, error('NotReadableError', 'The media connection ended.'));
            else void connected();
          };
          await peer.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await peer.setLocalDescription(await peer.createAnswer());
          await gathered(peer, capture.abort.signal);
          if (captures.get(id) === capture) send(capture, { type: 'answer', sdp: peer.localDescription!.sdp });
        } catch (reason) { close(id, reason instanceof Error ? reason : error('OperationError', 'Unable to connect media.')); }
      };
      void ready.then(() => {
        if (captures.get(id) !== capture) { ports.port2.close(); return; }
        try { parent.postMessage({ channel: 'openworkgraph.visualize.media', version: 1, type: 'request', sessionId: identity.sessionId, nodeId: identity.nodeId, requestId: id, constraints }, identity.hostOrigin, [ports.port2]); }
        catch { ports.port2.close(); close(id, new TypeError('Invalid media constraints.')); }
      });
    });
  }
  const api: VisualizeMediaClient = Object.freeze({ getUserMedia, stopAll: () => { for (const id of captures.keys()) close(id); } });
  Object.defineProperty(page, 'visualizeMedia', { value: api });
  // The explicit API is always available; native method replacement is best effort.
  try {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: getUserMedia });
    else Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: Object.freeze({ getUserMedia }) });
  } catch { /* Page code can use window.visualizeMedia.getUserMedia explicitly. */ }
  window.addEventListener('pagehide', api.stopAll);
}
