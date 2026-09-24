import type { ResourceRequest } from './ResourcesPanel';

type CacheEntry = { promise: Promise<Blob>; bytes?: number };
type RequestCache = { entries: Map<string, CacheEntry>; totalBytes: number };

export class ImagePreviewCache {
  private readonly caches = new WeakMap<ResourceRequest, RequestCache>();
  constructor(private readonly maxBytes = 64 * 1024 * 1024, private readonly maxEntries = 96) {}

  load(request: ResourceRequest, path: string): Promise<Blob> {
    let cache = this.caches.get(request);
    if (!cache) { cache = { entries:new Map(), totalBytes:0 }; this.caches.set(request, cache); }
    const existing = cache.entries.get(path);
    if (existing) {
      cache.entries.delete(path);
      cache.entries.set(path, existing);
      return existing.promise;
    }
    const entry = {} as CacheEntry;
    entry.promise = request<Blob>(path, undefined, 'BLOB').then(blob => {
      if (cache!.entries.get(path) === entry) {
        entry.bytes = blob.size;
        cache!.totalBytes += blob.size;
        this.evict(cache!);
      }
      return blob;
    }, error => {
      if (cache!.entries.get(path) === entry) cache!.entries.delete(path);
      throw error;
    });
    cache.entries.set(path, entry);
    this.evict(cache);
    return entry.promise;
  }

  private evict(cache: RequestCache) {
    while (cache.entries.size > this.maxEntries || cache.totalBytes > this.maxBytes) {
      const oldest = cache.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      const entry = cache.entries.get(oldest)!;
      cache.entries.delete(oldest);
      cache.totalBytes -= entry.bytes ?? 0;
    }
  }
}

const defaultCache = new ImagePreviewCache();
export const cachedImageBlob = (request: ResourceRequest, path: string) => defaultCache.load(request, path);
