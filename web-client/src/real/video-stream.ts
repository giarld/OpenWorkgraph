import type { Request } from './contracts';
import type { RangeBlob } from '../adapter/transport';

export const VIDEO_FULL_LOAD_BYTES = 50 * 1024 * 1024;
const VIDEO_RANGE_BYTES = 1024 * 1024;
const PROBE_BYTES = 128 * 1024;
const STREAM_PATH = '/__workgraph_media/';
type ConnectionHint = { saveData?: boolean; effectiveType?: string; downlink?: number };
type Stream = { request: Request; path: string; total: number };
const streams = new Map<string,Stream>();
let ready: Promise<void> | undefined;
let listening = false;

function bandwidthHint(): boolean | undefined {
  const connection = (navigator as Navigator & { connection?: ConnectionHint }).connection;
  if (!connection) return undefined;
  if (connection.saveData || ['slow-2g','2g','3g'].includes(connection.effectiveType ?? '') || (typeof connection.downlink === 'number' && connection.downlink < 2)) return true;
  if (connection.effectiveType === '4g' || (typeof connection.downlink === 'number' && connection.downlink >= 2)) return false;
  return undefined;
}

/** Size wins; otherwise use the browser's network hint or a small authenticated Range probe. */
export async function videoLoadMode(request: Request, path: string, bytes: number): Promise<'full'|'stream'> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return 'full';
  if (bytes > VIDEO_FULL_LOAD_BYTES) return 'stream';
  const hint = bandwidthHint();
  if (hint !== undefined) return hint ? 'stream' : 'full';
  if (bytes <= PROBE_BYTES) return 'stream';
  const started = performance.now();
  try {
    const range = await request<RangeBlob>(path, undefined, 'RANGE', { range:{start:0,end:Math.min(bytes,PROBE_BYTES)-1} });
    const seconds = Math.max((performance.now()-started)/1000,0.001);
    return range.blob.size * 8 / seconds < 2_000_000 ? 'stream' : 'full';
  } catch { return 'full'; }
}

function rangeFor(header: string | undefined, total: number): {start:number;end:number} | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? 'bytes=0-');
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0,total-Number(match[2]));
  const end = Math.min(total-1,match[2] && match[1] ? Number(match[2]) : total-1,start+VIDEO_RANGE_BYTES-1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) return undefined;
  return {start,end};
}

function listen() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'workgraph-media-range' || !event.ports[0]) return;
    const port = event.ports[0];
    const entry = streams.get(event.data.id);
    const range = entry && rangeFor(event.data.range,entry.total);
    if (!entry || !range) { port.postMessage({error:'Video range is unavailable'}); return; }
    void entry.request<RangeBlob>(entry.path,undefined,'RANGE',{range}).then(async result => {
      if (result.start !== range.start || result.total !== entry.total) throw Error('Video changed while streaming');
      const bytes = await result.blob.arrayBuffer();
      port.postMessage({bytes,start:result.start,end:result.end,total:result.total,mime:result.mime || result.blob.type || 'video/mp4'},[bytes]);
    }).catch(() => port.postMessage({error:'Video range request failed'}));
  });
}

async function ensureWorker(): Promise<void> {
  if (!navigator.serviceWorker) throw Error('Streaming video is unavailable in this browser');
  listen();
  ready ??= (async () => {
    await navigator.serviceWorker.register('/workgraph-media-sw.js',{scope:'/'});
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve,reject) => {
      const timeout = window.setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange',changed); reject(Error('Video streaming did not start')); },10000);
      const changed = () => { if (navigator.serviceWorker.controller) { window.clearTimeout(timeout); navigator.serviceWorker.removeEventListener('controllerchange',changed); resolve(); } };
      navigator.serviceWorker.addEventListener('controllerchange',changed);
      changed();
    });
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}

export async function registerVideoStream(request: Request, path: string, total: number): Promise<{src:string;release:()=>void}> {
  if (!Number.isSafeInteger(total) || total <= 0) throw Error('Video size is unavailable');
  await ensureWorker();
  const id = crypto.randomUUID();
  streams.set(id,{request,path,total});
  return {src:location.origin+STREAM_PATH+id,release:()=>{streams.delete(id);}};
}
