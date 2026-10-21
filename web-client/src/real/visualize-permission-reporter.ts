/** Self-contained: observe author API requests inside the opaque page. Never
 * request permissions here or change native results, exceptions or arguments. */
export function installVisualizePermissionReporter(identity: { hostOrigin: string; sessionId: string; nodeId: string }): void {
  const reported = new Set<string>();
  const wrapped = new WeakSet<Function>();
  function note(permission: string): void {
    if (reported.has(permission)) return;
    reported.add(permission);
    parent.postMessage({ channel: 'openworkgraph.visualize.permission-use', version: 1, ...identity, permission }, identity.hostOrigin);
  }
  const safe = (read: () => unknown): any => { try { return read(); } catch { return undefined; } };
  function wrap(target: any, name: string, used: (args: any[], receiver: any) => void): void {
    try {
      const original = target?.[name]; if (typeof original !== 'function' || wrapped.has(original)) return;
      const proxy = new Proxy(original, {
        apply(fn, receiver, args) { try { used(args, receiver); } catch { /* Observation must not affect the API. */ } return Reflect.apply(fn, receiver, args); },
        construct(fn, args, constructor) { try { used(args, undefined); } catch { /* Same for constructors. */ } return Reflect.construct(fn, args, constructor); },
      });
      Object.defineProperty(target, name, { configurable: true, writable: true, value: proxy });
      wrapped.add(proxy);
    } catch { /* Some browsers do not permit replacing every native method. */ }
  }
  function network(value: unknown): void {
    const url = value instanceof Request ? value.url : String(value);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url, document.baseURI).protocol)) note('network');
  }
  function observe(): void {
    wrap(window, 'fetch', args => network(args[0]));
    wrap(XMLHttpRequest.prototype, 'open', args => network(args[1]));
    wrap(window, 'WebSocket', args => network(args[0]));
    wrap(window, 'EventSource', args => network(args[0]));
    wrap(navigator, 'sendBeacon', args => network(args[0]));
    wrap(HTMLAnchorElement.prototype, 'click', (_args, anchor) => { if (anchor.hasAttribute('download')) note('downloads'); });
    const clipboard = safe(() => navigator.clipboard);
    for (const method of ['read', 'readText']) wrap(clipboard, method, () => note('clipboardRead'));
    for (const method of ['write', 'writeText']) wrap(clipboard, method, () => note('clipboardWrite'));
    wrap(document, 'execCommand', args => {
      if (['copy', 'cut'].includes(String(args[0]).toLowerCase())) note('clipboardWrite');
      else if (String(args[0]).toLowerCase() === 'paste') note('clipboardRead');
    });
    for (const method of ['requestFullscreen', 'webkitRequestFullscreen']) wrap(Element.prototype, method, () => note('fullscreen'));
    const devices = safe(() => navigator.mediaDevices);
    wrap(devices, 'getDisplayMedia', () => note('screenCapture'));
    wrap(devices, 'getUserMedia', args => {
      if (args[0]?.audio) note('microphone'); if (args[0]?.video) note('camera');
    });
    const geolocation = safe(() => navigator.geolocation);
    for (const method of ['getCurrentPosition', 'watchPosition']) wrap(geolocation, method, () => note('geolocation'));
    wrap(window, 'PaymentRequest', () => note('payment'));
    for (const [feature, methods] of [['usb', ['requestDevice', 'getDevices']], ['serial', ['requestPort', 'getPorts']]] as const) {
      const devices = safe(() => (navigator as unknown as Record<string, unknown>)[feature]);
      for (const method of methods) wrap(devices, method, () => note(feature));
    }
  }
  observe();
  // Some browser APIs and page polyfills become available during initial load.
  window.addEventListener('load', observe, { once: true });
  document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a[download]')) note('downloads'); }, true);
}
