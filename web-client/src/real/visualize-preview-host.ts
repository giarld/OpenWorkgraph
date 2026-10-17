import { bindVisualizeIframe, validateVisualizeBridgeResponse, visualizeAssetHeader, VISUALIZE_ASSET_BINARY_MIME } from '../../../packages/protocol/src/index';
import type { VisualizePagePackage, VisualizeHostContext, VisualizeAssetReference } from '../../../packages/protocol/src/index';
import { prepareVisualizeHtmlDocument, VISUALIZE_HTML_SANDBOX, VISUALIZE_HTML_PERMISSIONS } from './visualize-html';
import { bindVisualizeAssetTransport, visualizeBinaryResource, type VisualizeBinaryAsset } from './visualize-assets';
declare const __VISUALIZE_PREVIEW_SDK__: string;
interface Bootstrap { page: VisualizePagePackage; context: VisualizeHostContext; sessionId: string; nodeId: string; sha256: string; assets: { key: string; reference: VisualizeAssetReference; media: VisualizeBinaryAsset['media']; mime: string; bytes: number; path: string }[] }
const base = location.pathname, storageKey = 'visualize-preview:' + base;
let credential = location.hash.slice(1);
if (credential) { sessionStorage.setItem(storageKey, credential); history.replaceState(null, '', base); }
else credential = sessionStorage.getItem(storageKey) ?? '';
const errorNode = document.querySelector<HTMLParagraphElement>('#error')!;
const loading = document.querySelector<HTMLParagraphElement>('#loading')!;
const theme = document.querySelector<HTMLSelectElement>('#theme')!;
const size = document.querySelector<HTMLSelectElement>('#size')!;
let dispose = () => {}; let generation = 0;
function showError(error: unknown) { errorNode.textContent = error instanceof Error ? error.message : '测试页面加载失败。'; errorNode.hidden = false; loading.hidden = true; }
async function request(path: string, value?: unknown, binary = false): Promise<Response> {
  const response = await fetch(path, { method: value === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Authorization: 'Bearer ' + credential, ...(value === undefined ? {} : { 'Content-Type': binary ? VISUALIZE_ASSET_BINARY_MIME : 'application/json' }) }, ...(value === undefined ? {} : { body: binary ? value as Blob : JSON.stringify(value) }) });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw Error(body.error?.message ?? '测试请求失败。'); }
  return response;
}
async function open() {
  const current = ++generation; dispose(); loading.hidden = false; errorNode.hidden = true; document.querySelector('#preview')!.replaceChildren();
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw Error('缺少测试授权，请使用生成任务返回的完整测试链接。');
  const data: Bootstrap = await (await request(base + '/bootstrap')).json(); if (current !== generation) return;
  let alive = true, reportCount = 0, reports = Promise.resolve(); const cleanups: (() => void)[] = [];
  dispose = () => { alive = false; for (const cleanup of cleanups) cleanup(); };
  const report = (kind: string, message = '') => {
    if (alive && reportCount++ < 64) reports = reports.then(async () => { if (alive) await request(base + '/diagnostics', { sessionId: data.sessionId, kind, message: message.slice(0, 1000) }); }).catch(() => {});
  };
  report('loading');
  const assets: VisualizeBinaryAsset[] = [];
  try {
    for (const asset of data.assets) {
      const bytes = await (await request(asset.path)).arrayBuffer(); if (!alive || current !== generation) return;
      if (bytes.byteLength !== asset.bytes) throw Error('测试资产大小不一致。');
      assets.push({ key: asset.key, media: asset.media, mime: asset.mime, bytes });
    }
  } catch (error) { report('error', error instanceof Error ? error.message : '测试资产加载失败。'); throw error; }
  const iframe = document.createElement('iframe'); iframe.title = '可视化测试内容'; iframe.sandbox.value = VISUALIZE_HTML_SANDBOX; iframe.allow = VISUALIZE_HTML_PERMISSIONS;
  const identity = { sessionId: data.sessionId, nodeId: data.nodeId };
  const setSize = () => { iframe.style.width = size.value === 'fit' ? '100%' : data.context.viewport.width + 'px'; iframe.style.height = size.value === 'fit' ? 'calc(100dvh - 112px)' : data.context.viewport.height + 'px'; }; setSize();
  const themeValue = { mode: theme.value as 'light' | 'dark', tokens: {} }; document.documentElement.style.colorScheme = theme.value;
  // Host-owned instrumentation runs before author scripts inside the same sandbox.
  const diagnostics = ';(' + function (identity: { sessionId: string; nodeId: string }, origin: string) {
    const send = (message: unknown) => parent.postMessage({ channel: 'openworkgraph.visualize.preview-error', ...identity, message: String(message).slice(0, 1000) }, origin);
    addEventListener('error', event => send(event.message || '资源加载失败'), true);
    addEventListener('unhandledrejection', event => send(event.reason?.message || event.reason || '未处理的异步错误'));
  }.toString() + ')(' + JSON.stringify(identity) + ',' + JSON.stringify(location.origin) + ');';
  iframe.srcdoc = await prepareVisualizeHtmlDocument({ page: data.page, hostOrigin: location.origin, ...identity, sdkSource: __VISUALIZE_PREVIEW_SDK__ + diagnostics, resources: data.assets.map(a => visualizeBinaryResource(a.reference, a.media)), theme: themeValue, locale: 'zh-CN' });
  if (!alive || current !== generation) return;
  let hasError = false;
  const status = (event: MessageEvent) => {
    if (!alive || event.source !== iframe.contentWindow || event.origin !== 'null') return;
    const value = event.data; if (!value || value.sessionId !== identity.sessionId || value.nodeId !== identity.nodeId) return;
    if (value.channel === 'openworkgraph.visualize.preview-error' && typeof value.message === 'string') { hasError = true; report('error', value.message); }
    if (value.channel === 'openworkgraph.visualize.page-status' && value.version === 1) {
      loading.hidden = true; if (value.status === 'error') { hasError = true; report('error', '页面或依赖加载失败，请查看页面中的错误提示。'); }
      else if (value.status === 'ready' && !hasError) report('ready');
    }
  }; window.addEventListener('message', status); cleanups.push(() => window.removeEventListener('message', status));
  cleanups.push(bindVisualizeAssetTransport(window, () => iframe, identity, assets));
  await new Promise<void>(resolve => { iframe.onload = () => resolve(); document.querySelector('#preview')!.append(iframe); });
  if (!alive) return; iframe.onload = null;
  const bridge = bindVisualizeIframe({ window, iframe, ...identity, dispatch: async (call, bytes) => {
    const value = call.method === 'exportAsset' ? new Blob([visualizeAssetHeader(call) as BlobPart, bytes!], { type: VISUALIZE_ASSET_BINARY_MIME }) : call;
    const response = validateVisualizeBridgeResponse(await (await request(base + (bytes ? '/asset-export' : '/bridge'), value, !!bytes)).json());
    if (response.ok && response.method === 'initialize') { response.result.theme = themeValue; response.result.viewport = { width: iframe.clientWidth, height: iframe.clientHeight }; }
    if (response.ok && response.method === 'requestLayout') { data.context.viewport = response.result.size; setSize(); }
    return response;
  } }); cleanups.push(() => bridge.dispose());
  const keepAlive = setInterval(() => { if (alive) void request(base + '/status').then(async result => { const latest: { sessionId: string } = await result.json(); if (latest.sessionId !== data.sessionId) throw Error('测试草稿已更新，请刷新页面。'); }).catch(error => { if (!alive) return; dispose(); iframe.remove(); showError(error); }); }, 15000);
  cleanups.push(() => clearInterval(keepAlive));
}
document.querySelector('#reload')!.addEventListener('click', () => void open().catch(showError));
theme.addEventListener('change', () => void open().catch(showError));
size.addEventListener('change', () => void open().catch(showError));
window.addEventListener('pagehide', () => dispose());
window.addEventListener('hashchange', () => {
  if (!location.hash) return;
  credential = location.hash.slice(1); sessionStorage.setItem(storageKey, credential); history.replaceState(null, '', base);
  void open().catch(showError);
});
void open().catch(showError);
