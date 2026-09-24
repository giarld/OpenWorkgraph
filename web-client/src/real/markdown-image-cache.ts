import type { Request } from './contracts';

export type MarkdownImageSize = 640 | 1280 | 'original';

type Entry = { promise: Promise<string>; url?: string; bytes?: number; expiresAt?: number };
type RequestCache = { entries: Map<string, Entry>; totalBytes: number };

/** Cache only Runtime-authorized image data, scoped to the current request/session. */
export class MarkdownImageCache {
  private readonly caches = new WeakMap<Request, RequestCache>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly maxBytes = 64 * 1024 * 1024, private readonly maxEntries = 96, private readonly ttlMs = 5 * 60 * 1000) {}

  invalidateProject(projectId: string) {
    this.revisions.set(projectId, (this.revisions.get(projectId) ?? 0) + 1);
  }

  private cache(request: Request): RequestCache {
    let cache = this.caches.get(request);
    if (!cache) { cache = { entries: new Map(), totalBytes: 0 }; this.caches.set(request, cache); }
    return cache;
  }

  private key(projectId: string, path: string, size: MarkdownImageSize): string {
    return JSON.stringify([projectId, this.revisions.get(projectId) ?? 0, path, size]);
  }

  private existing(cache: RequestCache, key: string): Entry | undefined {
    const entry = cache.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      cache.entries.delete(key); cache.totalBytes -= entry.bytes ?? 0;
      return undefined;
    }
    cache.entries.delete(key); cache.entries.set(key, entry);
    return entry;
  }

  peek(request: Request, projectId: string, path: string, size: MarkdownImageSize): string | undefined {
    return this.existing(this.cache(request), this.key(projectId, path, size))?.url;
  }

  remove(request: Request, projectId: string, path: string, size: MarkdownImageSize) {
    const cache = this.cache(request);
    const key = this.key(projectId, path, size);
    const entry = cache.entries.get(key);
    if (entry) { cache.entries.delete(key); cache.totalBytes -= entry.bytes ?? 0; }
  }

  load(request: Request, projectId: string, path: string, size: MarkdownImageSize): Promise<string> {
    const cache = this.cache(request);
    const key = this.key(projectId, path, size);
    const existing = this.existing(cache, key);
    if (existing) return existing.promise;
    const entry = {} as Entry;
    entry.promise = request<{ mime: string; base64: string }>(
      '/v1/projects/' + encodeURIComponent(projectId) + '/files/link-preview',
      { path, ...(size === 'original' ? {} : { thumbnailSize: size }) }, 'POST',
    ).then(file => {
      if (!file.mime.startsWith('image/') || !file.base64) throw Error('Not an image');
      const url = 'data:' + file.mime + ';base64,' + file.base64;
      if (cache.entries.get(key) === entry) {
        entry.url = url; entry.bytes = url.length * 2; entry.expiresAt = Date.now() + this.ttlMs;
        cache.totalBytes += entry.bytes;
        this.evict(cache);
      }
      return url;
    }).catch(error => {
      if (cache.entries.get(key) === entry) cache.entries.delete(key);
      throw error;
    });
    cache.entries.set(key, entry);
    this.evict(cache);
    return entry.promise;
  }

  private evict(cache: RequestCache) {
    while (cache.entries.size > this.maxEntries || cache.totalBytes > this.maxBytes) {
      const key = cache.entries.keys().next().value;
      if (typeof key !== 'string') break;
      const entry = cache.entries.get(key)!;
      cache.entries.delete(key); cache.totalBytes -= entry.bytes ?? 0;
    }
  }
}

export const markdownImageCache = new MarkdownImageCache();
if (typeof window !== 'undefined') window.addEventListener('openworkgraph:project-files-changed', event => {
  const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
  if (projectId) markdownImageCache.invalidateProject(projectId);
});
