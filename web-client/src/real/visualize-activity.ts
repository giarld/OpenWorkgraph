/** Serialized into the opaque iframe before author code runs. */
export function installVisualizeActivityController(identity: { hostOrigin: string; sessionId: string; nodeId: string }): void {
  const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
  let active = true, sequence = 0;
  type Timer = { callback: TimerHandler; args: unknown[]; delay: number; repeat: boolean; due: number; remaining: number; native?: number };
  const timers = new Map<number, Timer>();
  const frames = new Map<number, { callback: FrameRequestCallback; native?: number }>();
  const playing = new Set<HTMLMediaElement>(), animations = new Set<Animation>();
  const style = document.createElement('style');
  style.textContent = 'html[data-visualize-paused] *,html[data-visualize-paused] *::before,html[data-visualize-paused] *::after{animation-play-state:paused!important}';
  document.head.append(style);
  function schedule(id: number, timer: Timer): void {
    if (!active) return;
    timer.due = performance.now() + timer.remaining;
    timer.native = timeout(() => {
      if (!active || !timers.has(id)) return;
      if (!timer.repeat) timers.delete(id);
      try {
        if (typeof timer.callback === 'function') timer.callback.apply(window, timer.args);
        else timeout(timer.callback, 0);
      } finally {
        if (timer.repeat && timers.has(id)) { timer.remaining = timer.delay; schedule(id, timer); }
      }
    }, timer.remaining);
  }
  function create(callback: TimerHandler, delay = 0, repeat = false, args: unknown[] = []): number {
    const id = ++sequence, duration = Math.max(0, Number(delay) || 0);
    const timer = { callback, args, delay: duration, repeat, due: 0, remaining: duration };
    timers.set(id, timer); schedule(id, timer); return id;
  }
  window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => create(callback, delay, false, args)) as typeof window.setTimeout;
  window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => create(callback, delay, true, args)) as typeof window.setInterval;
  window.clearTimeout = window.clearInterval = ((id?: number) => {
    const timer = timers.get(id!); if (timer) { clear(timer.native); timers.delete(id!); }
  }) as typeof window.clearTimeout;
  function scheduleFrame(id: number): void {
    const frame = frames.get(id); if (!active || !frame) return;
    frame.native = raf(time => { frames.delete(id); frame.callback(time); });
  }
  window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, { callback }); scheduleFrame(id); return id; };
  window.cancelAnimationFrame = id => { const frame = frames.get(id); if (frame?.native !== undefined) cancel(frame.native); frames.delete(id); };
  document.addEventListener('play', event => {
    if (!active && event.target instanceof HTMLMediaElement) { playing.add(event.target); event.target.pause(); }
  }, true);
  window.addEventListener('message', event => {
    const value = event.data;
    if (event.source !== window.parent || event.origin !== identity.hostOrigin || value?.channel !== 'openworkgraph.visualize.visibility' || value.sessionId !== identity.sessionId || value.nodeId !== identity.nodeId || typeof value.active !== 'boolean' || value.active === active) return;
    active = value.active;
    document.documentElement.toggleAttribute('data-visualize-paused', !active);
    if (!active) {
      for (const timer of timers.values()) { clear(timer.native); timer.remaining = Math.max(0, timer.due - performance.now()); }
      for (const frame of frames.values()) if (frame.native !== undefined) cancel(frame.native);
      for (const animation of document.getAnimations()) if (animation.playState === 'running') { animations.add(animation); animation.pause(); }
      for (const media of document.querySelectorAll('video,audio')) if (media instanceof HTMLMediaElement && !media.paused) { playing.add(media); media.pause(); }
    } else {
      for (const [id, timer] of timers) schedule(id, timer);
      for (const id of frames.keys()) scheduleFrame(id);
      for (const animation of animations) animation.play(); animations.clear();
      for (const media of playing) if (media.isConnected) void media.play().catch(() => undefined); playing.clear();
    }
    window.dispatchEvent(new CustomEvent('visualize:visibility', { detail: { active } }));
  });
}
