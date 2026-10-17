import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readVisualizeAssetBinary, VISUALIZE_ASSET_BINARY_MIME } from '@openworkgraph/protocol';
import { readJson, readBinary } from './http.js';
import { ServiceError } from './errors.js';
import type { VisualizePreviews } from './visualize-preview.js';
import { visualizeChecked } from './visualize-content.js';

const shell = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>可视化测试 · 万象画布</title>' +
  '<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:light-dark(#f4f5f7,#17191e);color:light-dark(#202329,#e6e8ed)}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 16px}select,button{font:inherit;min-height:44px;padding:8px;border:1px solid #8886;border-radius:6px;background:light-dark(#fff,#252830);color:inherit}main{padding:16px;max-width:100%}iframe{display:block;border:0;background:transparent;max-width:100%}[role=alert]{white-space:pre-wrap;color:light-dark(#a32121,#ffaaaa)}[hidden]{display:none!important}</style></head>' +
  '<body><header><label>主题 <select id="theme" aria-label="测试主题"><option value="light">浅色</option><option value="dark">深色</option></select></label><label>尺寸 <select id="size" aria-label="测试尺寸"><option value="node">节点尺寸</option><option value="fit">适应窗口</option></select></label><button id="reload" type="button">刷新</button></header><main><p id="loading" role="status">正在加载…</p><p id="error" role="alert" hidden></p><div id="preview"></div></main><script src="/visualize-preview/host.js" defer></script></body></html>';
let bundle: Promise<Buffer> | undefined;
/** Separate capability surface. Standard /v1 authentication and URL rules are unchanged. */
export async function handleVisualizePreview(request: IncomingMessage, response: ServerResponse, previews: VisualizePreviews): Promise<boolean> {
  const path = request.url ?? '';
  if (!path.startsWith('/visualize-preview/')) return false;
  if (path.includes('?') || path.includes('#') || path.includes('%') || path.length > 300) throw new ServiceError('INVALID_REQUEST', '测试地址无效。');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  response.setHeader('X-Frame-Options', 'DENY');
  if (request.headers.origin !== undefined && request.headers.origin !== 'http://' + request.headers.host && request.headers.origin !== 'https://' + request.headers.host) throw new ServiceError('ORIGIN_DENIED', '测试请求必须来自同一来源。');
  if (request.method === 'GET' && path === '/visualize-preview/host.js') {
    bundle ??= readFile(new URL('./visualize-preview/host.js', import.meta.url)).catch(error => { bundle = undefined; throw error; });
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(await bundle); return true;
  }
  const match = /^[/]visualize-preview[/]([0-9a-f-]{36})(?:[/](bootstrap|status|bridge|asset-export|diagnostics|assets[/]([0-9a-f-]{36})[/]([0-9]+)))?$/.exec(path);
  if (!match) throw new ServiceError('NOT_FOUND', '测试页面不存在。');
  const id = match[1]!, action = match[2];
  if (!action && request.method === 'GET') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(shell); return true; }
  const authorize = () => previews.authorize(id, request.headers.authorization);
  authorize();
  const send = (value: unknown) => response.end(JSON.stringify(value));
  if (request.method === 'GET' && action === 'bootstrap') send(previews.bootstrap(id));
  else if (request.method === 'GET' && action === 'status') send(previews.status(id));
  else if (request.method === 'GET' && action?.startsWith('assets/')) {
    if (authorize().bridgeId !== match[3]) throw new ServiceError('CONFLICT', '测试草稿已更新，请刷新页面。');
    const asset = previews.asset(id, Number(match[4])); response.setHeader('Content-Type', asset.mime); response.end(asset.bytes);
  } else if (request.method === 'POST' && action === 'bridge') {
    const value = await readJson(request, 2_097_152); authorize(); send(visualizeChecked(() => previews.dispatch(id, value)));
  } else if (request.method === 'POST' && action === 'asset-export') {
    if (request.headers['content-type'] !== VISUALIZE_ASSET_BINARY_MIME) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', '导出资产请求格式无效。');
    const bytes = await readBinary(request, 300 * 1024 * 1024 + 65540); authorize();
    const payload = visualizeChecked(() => readVisualizeAssetBinary(bytes)); send(visualizeChecked(() => previews.dispatch(id, payload.request, Buffer.from(payload.bytes))));
  } else if (request.method === 'POST' && action === 'diagnostics') {
    const value = await readJson(request, 4096); authorize(); previews.report(id, value); send({ accepted: true });
  } else throw new ServiceError('NOT_FOUND', '测试操作不存在。');
  return true;
}
