import { checkedVisualizeJson, validateVisualizePagePackage, VisualizeValidationError } from '../../../packages/protocol/src/visualize-validation';
import type { VisualizeDependency, VisualizeHostContext, VisualizePagePackage } from '../../../packages/protocol/src/visualize';
import { installVisualizeActivityController } from './visualize-activity';
import { isVisualizeProjectPath } from '../../../packages/protocol/src/visualize-assets';
import defaultStyles from './visualize-default.css?raw';

export const VISUALIZE_HTML_SANDBOX = 'allow-scripts';
export const VISUALIZE_HTML_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'clipboard-read', 'clipboard-write', 'display-capture', 'fullscreen', 'payment', 'usb', 'serial'].map(feature => feature + " 'none'").join('; ');
export interface VisualizeStaticResource {
  resourceId: string; resourceVersion: number; media: VisualizeDependency['media'];
  relativePath?: string;
  /** Host-owned object URL or MIME-checked data URL; never an authenticated API URL. */
  url: string;
}
export interface VisualizeHtmlOptions {
  page: VisualizePagePackage; hostOrigin: string; sessionId: string; nodeId: string;
  /** Trusted, self-contained IIFE exposing VisualizeProtocol.createVisualizePageSdk. */
  sdkSource: string; resources?: VisualizeStaticResource[];
  theme?: VisualizeHostContext['theme']; locale?: string; dependencyTimeoutMs?: number;
  expanded?: boolean;
}
export function visualizeResourceUrl(resourceId: string, resourceVersion: number): string {
  return 'visualize-resource:' + encodeURIComponent(resourceId) + '@' + resourceVersion;
}
/** Host-side preparation. Opaque documents cannot dereference a host blob URL.
 * Script/style bytes are acquired with an abortable deadline before any executable
 * element exists, preventing late execution after a timed-out static download.
 * Never pass Transport or credentials: only validated static dependency URLs. */
export async function prepareVisualizeHtmlDocument(options: VisualizeHtmlOptions, fetcher: typeof fetch = globalThis.fetch): Promise<string> {
  buildVisualizeHtmlDocument(options); // Validate every URL/identity before any I/O.
  const copy = { ...options, page: validateVisualizePagePackage(options.page), resources: (options.resources ?? []).map(value => ({ ...value })) };
  const timeout = options.dependencyTimeoutMs ?? 15_000;
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  };
  async function download(url: string, media: VisualizeDependency['media'], integrity?: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const task = (async () => {
      const response = await fetcher(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('Unavailable static resource');
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      const allowed = media === 'script' ? /^(?:text|application)\/javascript$/ : media === 'style' ? /^text\/css$/ : media === 'image' ? /^image\/[a-z0-9.+-]+$/ : /^(?:video|audio)\/[a-z0-9.+-]+$/;
      if (!allowed.test(mime)) throw new Error('Invalid static MIME');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing static bytes');
      let length = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 16_777_216) { await reader.cancel(); throw new Error('Static byte limit'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (integrity) {
        const [algorithm, expected] = integrity.split('-');
        const digest = await crypto.subtle.digest(algorithm.replace('sha', 'SHA-'), bytes);
        if (encode(new Uint8Array(digest)) !== expected) throw new Error('Invalid static integrity');
      }
      return 'data:' + mime + ';base64,' + encode(bytes);
    })();
    try {
      return await Promise.race([task, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Static timeout')); }, timeout); })]);
    } finally { clearTimeout(timer!); }
  }
  // Keep missing assets as resource declarations: bootstrap reports them without
  // trying a late remote script/style load or altering the saved business form.
  const dependencies = await Promise.all(copy.page.dependencies.map(async dependency => {
    if (dependency.kind !== 'cdn' || !['script', 'style'].includes(dependency.media)) return dependency;
    const resourceId = 'visualize-static:' + dependency.id;
    try {
      const url = await download(dependency.url, dependency.media, dependency.integrity);
      copy.resources.push({ resourceId, resourceVersion: 1, media: dependency.media, url });
    } catch { /* Missing reference is reported in the isolated document. */ }
    return { kind: 'resource' as const, id: dependency.id, media: dependency.media, resourceId, resourceVersion: 1 };
  }));
  await Promise.all(copy.resources.map(async resource => {
    if (!resource.url.startsWith('blob:')) return;
    try { resource.url = await download(resource.url, resource.media); }
    catch { resource.url = ''; }
  }));
  copy.resources = copy.resources.filter(resource => resource.url);
  copy.page.dependencies = dependencies;
  return buildVisualizeHtmlDocument(copy);
}
type Asset = { id: string; media: VisualizeDependency['media']; url: string | null; integrity?: string };
type Bootstrap = { html: string; hostOrigin: string; sessionId: string; nodeId: string; assets: Asset[]; urls: Record<string, string>; theme: VisualizeHostContext['theme']; locale: string; timeout: number; expanded: boolean };
const jsonScript = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** Low-level serializer for already prepared data resources. Product callers use
 * prepareVisualizeHtmlDocument for host blobs and bounded CDN script/style loads.
 * Caller applies sandbox/permissions and binds after load. CSP is not a CPU quota
 * or self-navigation firewall. This synchronous path cannot cancel remote scripts. */
export function buildVisualizeHtmlDocument(options: VisualizeHtmlOptions): string {
  const page = validateVisualizePagePackage(options.page);
  const fail = (message: string): never => { throw new VisualizeValidationError('INVALID_REQUEST', message); };
  let origin: URL;
  try { origin = new URL(options.hostOrigin); } catch { return fail('Invalid visualize host origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.hostOrigin || origin.username || origin.password) fail('A concrete host origin is required');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId) || typeof options.nodeId !== 'string' || !options.nodeId.trim() || options.nodeId.length > 128 || /[\u0000-\u001f\u007f]/.test(options.nodeId)) fail('Invalid visualize identity');
  if (typeof options.sdkSource !== 'string' || !options.sdkSource.trim() || options.sdkSource.length > 2_097_152) fail('A bounded trusted SDK bundle is required');
  const timeout = options.dependencyTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) fail('Invalid dependency timeout');
  const theme = checkedVisualizeJson(options.theme ?? { mode: 'light', tokens: {} }) as unknown as VisualizeHostContext['theme'];
  if (!theme || !['light', 'dark'].includes(theme.mode) || !theme.tokens || typeof theme.tokens !== 'object' || Array.isArray(theme.tokens) || Object.keys(theme.tokens).length > 64 || Object.entries(theme.tokens).some(([key, value]) => !/^(?:--)?[a-z][a-z0-9-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 256 || /[<>{};]|url\s*\(/i.test(value))) fail('Invalid theme tokens');
  const locale = options.locale ?? 'en';
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(locale)) fail('Invalid locale');
  const urls: Record<string, string> = {};
  const media = new Map<string, string>();
  const resources = options.resources ?? [];
  if (!Array.isArray(resources) || resources.length > 512) fail('Too many static resources');
  if (resources.reduce((bytes, resource) => bytes + (typeof resource?.url === 'string' ? resource.url.length : 0), 0) > 67_108_864) fail('Static resource data budget exceeded');
  for (const resource of resources) {
    if (typeof resource.resourceId !== 'string' || !resource.resourceId.trim() || resource.resourceId.length > 256 || !Number.isSafeInteger(resource.resourceVersion) || resource.resourceVersion < 1 || !['script', 'style', 'image', 'video'].includes(resource.media) || typeof resource.url !== 'string') fail('Invalid static resource');
    if (resource.relativePath !== undefined && (!isVisualizeProjectPath(resource.relativePath) || !['image', 'video'].includes(resource.media))) fail('Invalid project asset');
    const key = resource.relativePath === undefined ? visualizeResourceUrl(resource.resourceId, resource.resourceVersion) : 'visualize-project-file:' + encodeURIComponent(resource.relativePath);
    if (Object.hasOwn(urls, key)) fail('Duplicate static resource');
    const mime = { script: '(?:text|application)/javascript', style: 'text/css', image: 'image/[a-zA-Z0-9.+-]+', video: '(?:video|audio)/[a-zA-Z0-9.+-]+' }[resource.media];
    const data = new RegExp('^data:' + mime + ';base64,[A-Za-z0-9+/]*={0,2}$').test(resource.url);
    let blob = false;
    try { const url = new URL(resource.url); blob = url.protocol === 'blob:' && url.origin === origin.origin && !url.search && !url.hash && !/[\u0000- \u007f]/.test(resource.url); } catch { /* Invalid static URL. */ }
    const binary = resource.url === 'visualize-host-asset:' + encodeURIComponent(key);
    if (!data && !blob && !binary) fail('Static resources require host-owned blob URLs or MIME-matched base64 data URLs');
    urls[key] = resource.url; media.set(key, resource.media);
  }
  const assets: Asset[] = page.dependencies.map(dependency => {
    const key = dependency.kind === 'resource' ? visualizeResourceUrl(dependency.resourceId, dependency.resourceVersion) : dependency.kind === 'project-file' ? 'visualize-project-file:' + encodeURIComponent(dependency.relativePath) : '';
    const url = dependency.kind === 'cdn' ? dependency.url : media.get(key) === dependency.media ? urls[key]! : null;
    if (url) urls['visualize-dependency:' + dependency.id] = url;
    return { id: dependency.id, media: dependency.media, url, ...(dependency.kind === 'cdn' && dependency.integrity ? { integrity: dependency.integrity } : {}) };
  });
  const sources = (kind: Asset['media']) => [...new Set([
    // Refreshed inputs can introduce media after the document was created.
    ...(['image', 'video'].includes(kind) ? ['blob:'] : []),
    ...assets.filter(asset => asset.media === kind && asset.url?.startsWith('https:')).map(asset => new URL(asset.url!).origin + new URL(asset.url!).pathname),
    ...resources.filter(resource => resource.media === kind).map(resource => resource.url.startsWith('blob:') || resource.url.startsWith('visualize-host-asset:') ? 'blob:' : 'data:'),
  ])].join(' ');
  const csp = ["default-src 'none'", "script-src 'unsafe-inline' " + sources('script'), "style-src 'unsafe-inline' " + sources('style'), 'img-src data: ' + sources('image'), 'media-src data: ' + sources('video'), 'font-src data:', "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "child-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"].join('; ');
  const config: Bootstrap = { html: page.html, hostOrigin: options.hostOrigin, sessionId: options.sessionId, nodeId: options.nodeId, assets, urls, theme, locale, timeout, expanded: options.expanded === true };
  const sdk = options.sdkSource.replace(/<\/script/gi, '<\\/script');
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(csp) + '"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style data-visualize-default-styles>' + defaultStyles + '</style></head><body><script>' + sdk + '</script><script>(' + installVisualizeActivityController.toString() + ')(' + jsonScript({ hostOrigin: options.hostOrigin, sessionId: options.sessionId, nodeId: options.nodeId }) + ');(' + bootstrap.toString() + ')(' + jsonScript(config) + ');</script></body></html>';
}

/** Self-contained because this function is emitted into srcdoc. */
function bootstrap(config: Bootstrap): void {
  type PageWindow = Window & {
    VisualizeProtocol: { createVisualizePageSdk(options: unknown): { initialize(): Promise<VisualizeHostContext>; dispose(): void } };
    visualize: unknown; visualizeReady: Promise<VisualizeHostContext>; visualizeAssetsReady: Promise<void>;
    visualizeResources: Readonly<Record<string, string>>; visualizeResolveUrl(value: string): string | null;
  };
  const page = window as unknown as PageWindow;
  // Events inside an opaque iframe never reach the work graph DOM. Cancel
  // native browser zoom here, before author handlers, and relay only zoom.
  if (!config.expanded) window.addEventListener('wheel', event => {
    if (!event.ctrlKey && !(event.metaKey && /Mac|iPhone|iPad|iPod/.test(navigator.platform))) return;
    event.preventDefault();
    window.parent.postMessage({ channel: 'openworkgraph.visualize', version: 1, sessionId: config.sessionId, nodeId: config.nodeId, type: 'view-event', event: 'zoom', x: event.clientX / window.innerWidth, y: event.clientY / window.innerHeight, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey }, config.hostOrigin);
  }, { passive: false, capture: true });
  if (config.expanded) window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    window.parent.postMessage({ channel: 'openworkgraph.visualize', version: 1, sessionId: config.sessionId, nodeId: config.nodeId, type: 'view-event', event: 'dismiss' }, config.hostOrigin);
  });
  const errors = document.createElement('div');
  errors.dataset.visualizeErrors = ''; errors.setAttribute('role', 'alert'); errors.hidden = true; document.body.prepend(errors);
  function report(id: string, media: string): void {
    errors.hidden = false;
    const line = document.createElement('div');
    line.textContent = (config.locale.startsWith('zh') ? '静态资源加载失败：' : 'Static resource unavailable: ') + id;
    errors.append(line);
    window.dispatchEvent(new CustomEvent('visualize:resource-error', { detail: { id, media, code: 'RESOURCE_UNAVAILABLE' } }));
  }
  function theme(value: VisualizeHostContext['theme']): void {
    document.documentElement.dataset.theme = value.mode;
    for (const [key, color] of Object.entries(value.tokens)) {
      if (/^(?:--)?[a-z][a-z0-9-]{0,63}$/.test(key) && CSS.supports('color', color)) document.documentElement.style.setProperty(key.startsWith('--') ? key : '--' + key, color);
    }
  }
  theme(config.theme);
  const objectUrls = new Set<string>();
  function receiveAssets(event: MessageEvent): void {
    const message = event.data;
    if (event.source !== window.parent || event.origin !== config.hostOrigin || message?.channel !== 'openworkgraph.visualize.assets' || message.version !== 1 || !['response', 'update'].includes(message.type) || message.sessionId !== config.sessionId || message.nodeId !== config.nodeId || !Array.isArray(message.assets) || message.assets.length > 512) return;
    for (const asset of message.assets) {
      if (typeof asset.key !== 'string' || !/^(?:visualize-resource:|visualize-project-file:)/.test(asset.key)) continue;
      const expected = config.urls[asset.key];
      if ((message.type === 'response' && !expected?.startsWith('visualize-host-asset:')) || !(asset.bytes instanceof ArrayBuffer) || asset.bytes.byteLength > 300 * 1024 * 1024 || typeof asset.mime !== 'string') continue;
      const allowed = asset.media === 'image' ? /^image[/]/ : asset.media === 'video' ? /^(?:video|audio)[/]/ : asset.media === 'style' ? /^text[/]css$/ : asset.media === 'script' ? /^(?:text|application)[/](?:javascript|ecmascript)$/ : null;
      if (!allowed?.test(asset.mime)) continue;
      const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime })); objectUrls.add(url);
      if (expected) {
        for (const [key, value] of Object.entries(config.urls)) if (value === expected) config.urls[key] = url;
        for (const dependency of config.assets) if (dependency.url === expected) dependency.url = url;
        if (objectUrls.delete(expected)) URL.revokeObjectURL(expected);
      }
      config.urls[asset.key] = url;
    }
    page.visualizeResources = Object.freeze({ ...config.urls });
  }
  window.addEventListener('message', receiveAssets);
  const transferred = Object.entries(config.urls).filter(([, value]) => value.startsWith('visualize-host-asset:'));
  const binaryReady = transferred.length ? new Promise<void>(resolve => {
    const timer = window.setTimeout(() => finish(), config.timeout);
    function finish(): void { window.clearTimeout(timer); window.removeEventListener('message', receive); resolve(); }
    function receive(event: MessageEvent): void {
      const message = event.data;
      if (event.source !== window.parent || event.origin !== config.hostOrigin || message?.channel !== 'openworkgraph.visualize.assets' || message.version !== 1 || message.type !== 'response' || message.sessionId !== config.sessionId || message.nodeId !== config.nodeId || !Array.isArray(message.assets)) return;
      finish();
    }
    window.addEventListener('message', receive);
    window.parent.postMessage({ channel: 'openworkgraph.visualize.assets', version: 1, type: 'request', sessionId: config.sessionId, nodeId: config.nodeId }, config.hostOrigin);
  }) : Promise.resolve();
  window.addEventListener('pagehide', () => { window.removeEventListener('message', receiveAssets); for (const url of objectUrls) URL.revokeObjectURL(url); }, { once: true });
  page.visualizeResources = Object.freeze({ ...config.urls });
  page.visualizeResolveUrl = value => {
    const url = Object.hasOwn(config.urls, value) ? config.urls[value] : undefined;
    return url && !url.startsWith('visualize-host-asset:') ? url : null;
  };
  let sdk: ReturnType<PageWindow['VisualizeProtocol']['createVisualizePageSdk']>;
  try { sdk = page.VisualizeProtocol.createVisualizePageSdk({ window, hostWindow: window.parent, hostOrigin: config.hostOrigin, sessionId: config.sessionId, nodeId: config.nodeId }); }
  catch { report('SDK', 'script'); return; }
  page.visualize = sdk;
  page.visualizeReady = new Promise((resolve, reject) => {
    const initialize = () => window.setTimeout(() => {
      sdk.initialize().then(value => { theme(value.theme); resolve(value); }, error => { report('Workspace', 'bridge'); reject(error); });
    }, 0);
    if (document.readyState === 'complete') initialize(); else window.addEventListener('load', initialize, { once: true });
  });
  void page.visualizeReady.catch(() => undefined);
  window.addEventListener('pagehide', () => sdk.dispose(), { once: true });
  function mapped(value: string, kind: string): string | null {
    const replacement = page.visualizeResolveUrl(value);
    if (replacement) return replacement;
    if (config.assets.some(asset => asset.media === kind && asset.url === value)) return value;
    if (kind === 'image' && /^data:image\//.test(value) || kind === 'video' && /^data:(?:video|audio)\//.test(value)) return value;
    return null;
  }
  function css(text: string): string {
    return text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url: string) => {
      const value = mapped(url, 'image') ?? mapped(url, 'video');
      if (!value && url.startsWith('visualize-')) report(url, 'image');
      return value ? 'url("' + value.replaceAll('"', '%22') + '")' : 'url("")';
    });
  }
  function load(asset: Asset): Promise<void> {
    if (!asset.url) { report(asset.id, asset.media); return Promise.resolve(); }
    return new Promise(resolve => {
      const node = document.createElement(asset.media === 'script' ? 'script' : asset.media === 'style' ? 'link' : asset.media === 'image' ? 'img' : 'video');
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return; done = true; window.clearTimeout(timer);
        if (!ok) report(asset.id, asset.media);
        if (!ok || asset.media === 'image' || asset.media === 'video') node.remove();
        resolve();
      };
      const timer = window.setTimeout(() => finish(false), config.timeout);
      node.addEventListener(asset.media === 'video' ? 'loadedmetadata' : 'load', () => finish(true), { once: true });
      node.addEventListener('error', () => finish(false), { once: true });
      node.setAttribute('referrerpolicy', 'no-referrer');
      if (asset.media === 'script' || asset.media === 'style') {
        node.setAttribute('crossorigin', 'anonymous'); if (asset.integrity) node.setAttribute('integrity', asset.integrity);
      }
      if (asset.media === 'style') { node.setAttribute('rel', 'stylesheet'); node.setAttribute('href', asset.url!); }
      else node.setAttribute('src', asset.url!);
      if (asset.media === 'video') { node.setAttribute('preload', 'metadata'); node.setAttribute('muted', ''); }
      if (asset.media === 'script') (node as HTMLScriptElement).async = false;
      if (asset.media === 'image' || asset.media === 'video') node.hidden = true;
      (asset.media === 'script' || asset.media === 'style' ? document.head : document.body).append(node);
    });
  }
  page.visualizeAssetsReady = (async () => {
    await binaryReady;
    page.visualizeResources = Object.freeze({ ...config.urls });
    for (const asset of config.assets) await load(asset);
    const author = new DOMParser().parseFromString(config.html, 'text/html');
    author.querySelectorAll('iframe,frame,object,embed,base,meta,link').forEach(node => node.remove());
    const scripts: HTMLScriptElement[] = [];
    author.querySelectorAll('script').forEach(node => { if (!node.hasAttribute('src')) scripts.push(node); node.remove(); });
    author.querySelectorAll('*').forEach(node => {
      for (const attribute of Array.from(node.attributes)) {
        const key = attribute.name.toLowerCase();
        if (['action', 'formaction', 'target', 'srcdoc', 'ping', 'srcset'].includes(key) || key === 'href' && !attribute.value.startsWith('#')) node.removeAttribute(attribute.name);
        else if (key === 'src' || key === 'poster') {
          const kind = key === 'poster' || node.tagName === 'IMG' ? 'image' : 'video';
          const value = mapped(attribute.value, kind);
          if (value) node.setAttribute(attribute.name, value);
          else { node.removeAttribute(attribute.name); report(attribute.value, kind); }
        } else if (key === 'style') node.setAttribute(attribute.name, css(attribute.value));
      }
      if (node.tagName === 'STYLE') node.textContent = css(node.textContent ?? '');
    });
    for (const child of [...Array.from(author.head.childNodes), ...Array.from(author.body.childNodes)]) document.body.append(document.importNode(child, true));
    document.querySelectorAll('img,video,audio,source').forEach(node => node.addEventListener('error', () => report(node.getAttribute('src') ?? 'media', 'media'), { once: true }));
    for (const original of scripts) {
      const script = document.createElement('script'); if (original.type) script.type = original.type;
      script.textContent = original.textContent; document.body.append(script);
    }
  })();
  void page.visualizeAssetsReady.catch(() => report('Page', 'html'));
}
