import { randomUUID } from 'node:crypto';
import type { DataSource } from '@openworkgraph/protocol';
import type { RemoteConnector, RemotePreviewReader } from './remote-assets-connectors.js';
import { remotePath } from './remote-assets-connectors.js';
import { classifyProjectFile } from './project-files.js';
import { ServiceError } from './errors.js';

export const REMOTE_PREVIEW_RANGE_BYTES = 1024 * 1024;
interface Preview {
  id: string; owner: string; source: DataSource; mime: string; reader: RemotePreviewReader;
  connector: RemoteConnector; abort: AbortController; timer: ReturnType<typeof setTimeout>; tail: Promise<void>;
}
const expired = () => new ServiceError('NOT_FOUND', 'Remote preview expired. Open it again.');

/** Session-bound, short-lived readers; previewing never imports or saves a file. */
export class RemoteAssetPreviews {
  private readonly entries = new Map<string, Preview>();
  private readonly opening = new Map<string, { owner: string; abort: AbortController }>();
  private readonly cancelled = new Map<string, number>();
  private closed = false;
  constructor(private readonly source: (id: string) => DataSource, private readonly connect: (source: DataSource, signal: AbortSignal) => RemoteConnector, private readonly idleMs = 5 * 60_000) {}
  async open(sourceId: string, locationRevision: number, path: string, owner: string, signal: AbortSignal, id: string = randomUUID()): Promise<{ id: string; bytes: number; mime: string }> {
    remotePath(path, false); signal.throwIfAborted();
    if (this.closed) throw expired();
    for (const [key, expiry] of this.cancelled) if (expiry <= Date.now()) this.cancelled.delete(key);
    if (this.cancelled.has(JSON.stringify([owner, id]))) throw expired();
    if (this.entries.has(id) || this.opening.has(id)) throw new ServiceError('CONFLICT', 'Remote preview is unavailable.');
    if (this.entries.size + this.opening.size >= 32) throw new ServiceError('CONFLICT', 'Close another remote preview and try again.');
    const source = this.source(sourceId);
    if (source.locationRevision !== locationRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source location changed. Browse it again.');
    const abort = new AbortController(), cancelled = () => abort.abort();
    this.opening.set(id, { owner, abort }); signal.addEventListener('abort', cancelled, { once: true });
    const timeout = setTimeout(cancelled, 120_000); timeout.unref();
    let connector: RemoteConnector | undefined, retained = false;
    try {
      connector = this.connect(source, abort.signal);
      if (!connector.preview) throw new ServiceError('NOT_IMPLEMENTED', 'Remote preview is unavailable.');
      const reader = await connector.preview(path);
      abort.signal.throwIfAborted(); signal.throwIfAborted();
      if (!Number.isSafeInteger(reader.bytes) || reader.bytes < 0) throw new ServiceError('CONFLICT', 'Unsupported remote entry.');
      if (this.closed || this.source(sourceId).revision !== source.revision) throw new ServiceError('REVISION_CONFLICT', 'Data source changed. Reload settings.');
      const mime = classifyProjectFile(path).mime;
      const timer = setTimeout(() => this.remove(id), this.idleMs); timer.unref();
      this.entries.set(id, { id, owner, source, mime, reader, connector, abort, timer, tail: Promise.resolve() }); retained = true;
      return { id, bytes: reader.bytes, mime };
    } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('CONFLICT', 'Remote preview could not be read. Try again.'); }
    finally { clearTimeout(timeout); this.opening.delete(id); signal.removeEventListener('abort', cancelled); if (!retained) { abort.abort(); connector?.close(); } }
  }
  private lookup(id: string, owner: string): Preview {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) throw expired();
    try { if (this.source(entry.source.id).revision !== entry.source.revision) throw new ServiceError('REVISION_CONFLICT', 'Data source changed. Reload settings.'); }
    catch (error) { this.remove(id); throw error; }
    entry.timer.refresh(); return entry;
  }
  async read(id: string, owner: string, start: number, end: number, signal: AbortSignal): Promise<{ bytes: Buffer; total: number; start: number; end: number; mime: string }> {
    const entry = this.lookup(id, owner);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > REMOTE_PREVIEW_RANGE_BYTES) throw new ServiceError('INVALID_REQUEST', 'Invalid remote preview byte range.');
    if (start >= entry.reader.bytes) throw new ServiceError('INVALID_REQUEST', 'Invalid remote preview byte range.');
    end = Math.min(end, entry.reader.bytes - 1);
    const operation = entry.tail.then(async () => {
      signal.throwIfAborted(); this.lookup(id, owner);
      try {
        const bytes = await entry.reader.read(start, end, AbortSignal.any([signal, entry.abort.signal, AbortSignal.timeout(30_000)]));
        signal.throwIfAborted(); this.lookup(id, owner);
        if (bytes.length !== end - start + 1) throw new ServiceError('CONFLICT', 'Remote file changed during preview. Open it again.');
        return { bytes, total: entry.reader.bytes, start, end, mime: entry.mime };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        this.remove(id);
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('CONFLICT', 'Remote preview could not be read. Try again.');
      }
    });
    entry.tail = operation.then(() => {}, () => {}); return operation;
  }
  remove(id: string, owner?: string): void {
    const opening = this.opening.get(id);
    if (opening && (owner === undefined || opening.owner === owner)) opening.abort.abort();
    const entry = this.entries.get(id);
    if (owner !== undefined) {
      // A close can arrive before its queued open request. Remember that intent
      // without retaining a file path, secret or source configuration.
      while (this.cancelled.size >= 256) this.cancelled.delete(this.cancelled.keys().next().value!);
      this.cancelled.set(JSON.stringify([owner, id]), Date.now() + 5 * 60_000);
    }
    if (!entry || owner !== undefined && entry.owner !== owner) return;
    this.entries.delete(id); clearTimeout(entry.timer); entry.abort.abort(); entry.connector.close();
  }
  close(): void { this.closed = true; for (const { abort } of this.opening.values()) abort.abort(); for (const id of this.entries.keys()) this.remove(id); this.cancelled.clear(); }
}
