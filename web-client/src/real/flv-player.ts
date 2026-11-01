import type Mpegts from 'mpegts.js';
import type { RangeBlob } from '../adapter/transport';
import type { Request } from './contracts';

export type FlvRangeSource = { request: Request; path: string; bytes: number };
export function isFlvVideo(name: string, mime = ''): boolean {
  return /[.]flv$/i.test(name) || ['video/x-flv', 'video/flv'].includes(mime.split(';')[0].trim().toLowerCase());
}

/** Keep authenticated reads in the transport and bound each read to 1 MiB. */
function rangeLoader(mpegts: typeof Mpegts, source: FlvRangeSource) {
  return class extends mpegts.BaseLoader {
    private controller?: AbortController;
    constructor() { super('workgraph-flv-range'); }
    open(_dataSource: Mpegts.MediaSegment, range: Mpegts.Range) {
      this.abort();
      const controller = this.controller = new AbortController();
      this._status = mpegts.LoaderStatus.kConnecting;
      void this.read(range, controller).catch(error => {
        if (controller.signal.aborted) return;
        this._status = mpegts.LoaderStatus.kError;
        // The library's declaration incorrectly types the error enum value as its enum object.
        (this.onError as unknown as (type: string, info: Mpegts.LoaderErrorMessage) => void)(
          'Exception', { code: -1, msg: error instanceof Error ? error.message : String(error) });
      });
    }
    private async read(range: Mpegts.Range, controller: AbortController) {
      const last = range.to >= 0 ? Math.min(range.to, source.bytes - 1) : source.bytes - 1;
      let offset = range.from;
      while (offset <= last && !controller.signal.aborted) {
        const end = Math.min(last, offset + 1024 * 1024 - 1);
        const result = await source.request<RangeBlob>(source.path, undefined, 'RANGE', {
          range: { start: offset, end }, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.start !== offset || result.total !== source.bytes || result.end < offset || result.end > end ||
            result.blob.size !== result.end - offset + 1) throw Error('Video changed while streaming');
        const chunk = await result.blob.arrayBuffer();
        if (controller.signal.aborted) return;
        this._status = mpegts.LoaderStatus.kBuffering;
        this.onDataArrival(chunk, offset, result.end - range.from + 1);
        offset = result.end + 1;
      }
      if (!controller.signal.aborted) {
        this._status = mpegts.LoaderStatus.kComplete;
        this.onComplete(range.from, last);
      }
    }
    abort() { this.controller?.abort(); this._status = mpegts.LoaderStatus.kComplete; }
    destroy() { this.abort(); super.destroy(); }
  };
}

/** Lazy-load transmuxing only for FLV; the original file remains unchanged. */
export async function attachFlvPlayer(element: HTMLVideoElement, url: string, onError: () => void,
  signal: AbortSignal, source?: FlvRangeSource): Promise<(() => void) | undefined> {
  const { default: mpegts } = await import('mpegts.js');
  if (signal.aborted) return;
  if (!mpegts.isSupported()) throw Error('FLV playback is unavailable');
  const player = mpegts.createPlayer({ type: 'flv', url, isLive: false, filesize: source?.bytes }, {
    enableWorker: false, enableStashBuffer: false,
    ...(source ? { customLoader: rangeLoader(mpegts, source) } : {}),
  });
  const fail = () => { if (!signal.aborted) onError(); };
  player.on(mpegts.Events.ERROR, fail);
  const release = () => { player.off(mpegts.Events.ERROR, fail); player.destroy(); };
  try { player.attachMediaElement(element); player.load(); }
  catch (error) { release(); throw error; }
  return release;
}
