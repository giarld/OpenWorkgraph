import type { Request } from './contracts';

interface WaitingThumbnail { start(): void; }
interface Queue { active: number; waiting: WaitingThumbnail[]; }
const queues = new WeakMap<Request, Queue>();

/** Leave HTTP connections available for transfers, events and foreground reads. */
export function requestRemoteThumbnail(request: Request, path: string, signal: AbortSignal): Promise<Blob> {
  const queue = queues.get(request) ?? { active: 0, waiting: [] };
  queues.set(request, queue);
  const pump = () => {
    while (queue.active < 2 && queue.waiting.length) queue.waiting.shift()!.start();
  };
  return new Promise<Blob>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const cancel = () => {
      const index = queue.waiting.indexOf(item);
      if (index >= 0) { queue.waiting.splice(index, 1); reject(signal.reason); }
    };
    const item: WaitingThumbnail = { start() {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) { reject(signal.reason); return; }
      queue.active++;
      void (async () => {
        try { resolve(await request<Blob>(path, undefined, 'BLOB', { signal })); }
        catch (error) { reject(error); }
        finally { queue.active--; pump(); }
      })();
    } };
    queue.waiting.push(item);
    signal.addEventListener('abort', cancel, { once: true });
    pump();
  });
}
