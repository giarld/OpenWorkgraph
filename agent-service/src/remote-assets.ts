import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { WORKGRAPH_UPLOAD_MAX_BYTES, importedNodeType, defaultWorkgraphNodeSize } from '@openworkgraph/protocol';
import type { DataSource, DataSourceConfig, DataSourceCredentials, Json, Node, RemoteListing, RemoteTransfer, RemoteTransferRequest, RemoteTransferTarget } from '@openworkgraph/protocol';
import { DataSourceCredentialStore, DataSourceHostTrust, remoteId } from './remote-assets-security.js';
import { createRemoteConnector, remotePath, verifiedRemoteCache } from './remote-assets-connectors.js';
import type { RemoteConnector } from './remote-assets-connectors.js';
import type { DataDirectories } from './directories.js';
import { atomic } from './persistence/database.js';
import { canonicalJson, Repositories } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { assertProjectWritable, Graphs } from './graphs.js';
import { Resources } from './resources.js';
import { sniffMime, supportsText, readBounded } from './blob-store.js';
import type { PreparedBlob } from './blob-store.js';

async function readCacheBytes(path: string): Promise<Buffer> { const file=await open(path,'r'); try { return await readBounded(file,WORKGRAPH_UPLOAD_MAX_BYTES); } finally { await file.close(); } }
const active = (state: string) => ['accepted', 'preparing', 'transferring', 'committing'].includes(state);
const invalid = (message = 'Invalid data source request.'): never => { throw new ServiceError('INVALID_REQUEST', message); };
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function text(value: unknown, max = 512): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) invalid(); return value as string; }
export function validateDataSource(input: unknown): DataSourceConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const b = input as Record<string, unknown>; const name = text(b.name).trim();
  if (b.kind === 'git') {
    if (Object.keys(b).some(k => !['name', 'kind', 'url', 'branch', 'root', 'auth'].includes(k))) invalid();
    const branch = text(b.branch, 256), url = text(b.url, 4096), root = remotePath(b.root);
    if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || /[~^:?*\[\\\s]/.test(branch) || branch.split('/').some(p => p.startsWith('.') || p.endsWith('.lock') || !p)) invalid('Invalid Git branch.');
    let parsed: URL; try { parsed = new URL(url); decodeURIComponent(parsed.pathname); decodeURIComponent(parsed.username); } catch { return invalid('Use an HTTPS or ssh:// Git URL.'); }
    if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname || parsed.password || parsed.search || parsed.hash || (parsed.protocol === 'https:' && parsed.username) || /[\x00-\x1f]/.test(decodeURIComponent(parsed.pathname))) invalid('Use a Git URL without embedded credentials or query parameters.');
    if (parsed.protocol === 'ssh:' ? b.auth !== 'key' : !['public', 'token'].includes(String(b.auth))) invalid('Git URL and authentication do not match.');
    return { kind: 'git', name, url, root, branch, auth: b.auth as 'public' | 'token' | 'key' };
  }
  if (b.kind === 'sftp') {
    if (Object.keys(b).some(k => !['name', 'kind', 'host', 'port', 'username', 'root', 'auth'].includes(k))) invalid();
    const host = text(b.host, 253).toLowerCase(), username = text(b.username, 256), root = text(b.root, 4096);
    if (/[\s/@\\?#]/.test(host) || !Number.isInteger(b.port) || Number(b.port) < 1 || Number(b.port) > 65535 || !root.startsWith('/') || root.split('/').some(p => p === '..' || p === '.') || root.includes('\\') || !['key', 'password'].includes(String(b.auth))) invalid('Invalid SFTP address, port or root directory.');
    return { kind: 'sftp', name, host, port: Number(b.port), username, root: root === '/' ? '/' : root.replace(/\/+$/, ''), auth: b.auth as 'key' | 'password' };
  }
  return invalid();
}
function location(config: DataSourceConfig): string { const { name: _, auth: __, ...value } = config; return canonicalJson(asJson(value)); }
function target(input: unknown): RemoteTransferTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(); const b = input as Record<string, unknown>;
  if (typeof b.projectId !== 'string') invalid(); remoteId(b.projectId as string);
  if (b.kind === 'library') { if (Object.keys(b).some(k => !['kind', 'projectId'].includes(k))) invalid(); return { kind: 'library', projectId: b.projectId as string }; }
  if (!['graph', 'temporary'].includes(String(b.kind)) || Object.keys(b).some(k => !['kind', 'projectId', 'graphId', 'browserId', 'x', 'y'].includes(k))) invalid();
  remoteId(text(b.graphId, 128)); if (![b.x, b.y].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9)) invalid();
  if (b.kind === 'temporary') return { kind: 'temporary', projectId: b.projectId as string, graphId: b.graphId as string, browserId: remoteId(text(b.browserId, 128)), x: Number(b.x), y: Number(b.y) };
  if (b.browserId !== undefined) invalid(); return { kind: 'graph', projectId: b.projectId as string, graphId: b.graphId as string, x: Number(b.x), y: Number(b.y) };
}
/** All source mutations/acceptance are synchronous, using the same SQLite write
 * transaction. An accepted job locks its source before any asynchronous I/O. */
export class RemoteAssets {
  readonly credentials: DataSourceCredentialStore; readonly trust: DataSourceHostTrust;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closed = false;
  private readonly readers = new Map<string, number>();
  readonly cacheRoot: string;
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly dirs: DataDirectories, readonly resources: Resources, readonly graphs: Graphs, readonly options: { connector?: typeof createRemoteConnector; keyPath?: string; gitCaFile?: string } = {}) {
    this.credentials = new DataSourceCredentialStore(dirs.config, serviceId); this.trust = new DataSourceHostTrust(db); this.cacheRoot = join(dirs.staging, 'remote-assets');
  }
  private event(type: 'data-source.changed' | 'remote-transfer.changed', id: string, revision: number, projectId: string | null = null, state?: RemoteTransfer['state']): void {
    new Repositories(this.db).appendEvent({ eventId: randomUUID(), type, projectId, graphId: null, entityId: id, revision, occurredAt: new Date().toISOString(), payload: state ? {state} : {} });
  }
  private sourceRow(id: string) { const row = this.db.prepare('SELECT * FROM data_sources WHERE id=?').get(remoteId(id)); if (!row) throw new ServiceError('NOT_FOUND', 'Data source was removed. Select another source.'); return row; }
  source(id: string): DataSource { const row = this.sourceRow(id); return { id, serviceId: this.serviceId, revision: Number(row.revision), locationRevision: Number(row.location_revision), config: JSON.parse(String(row.config)) as DataSourceConfig, credentials: this.credentials.status(id, row.credential_generation as string | null), busy: this.busy(id) }; }
  sources(): DataSource[] { return this.db.prepare('SELECT id FROM data_sources ORDER BY id').all().map(row => this.source(String(row.id))); }
  private busy(id: string): boolean { return !!this.db.prepare("SELECT 1 FROM remote_transfers WHERE source_id=? AND json_extract(payload,'$.state') IN ('accepted','preparing','transferring','committing') LIMIT 1").get(id); }
  private editable(id: string, expectedRevision: number): DataSource { const source = this.source(id); if (source.revision !== expectedRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source changed. Reload settings.'); if (source.busy) throw new ServiceError('CONFLICT', 'Wait for this source’s transfers to finish, or cancel them before editing or removing it.'); return source; }
  save(input: { id?: string; expectedRevision?: number; config: unknown; credentials?: unknown }): DataSource {
    const config = validateDataSource(input.config), patch = input.credentials === undefined ? undefined : this.credentials.validate(input.credentials);
    const id = input.id ? remoteId(input.id) : randomUUID();
    return atomic(this.db, () => {
      const previous = input.id ? this.editable(id, input.expectedRevision!) : undefined;
      const oldGeneration = previous ? this.sourceRow(id).credential_generation as string | null : null;
      const old = patch ? this.credentials.read(id, oldGeneration) : undefined;
      try {
        const generation = patch ? randomUUID() : previous ? this.sourceRow(id).credential_generation : null;
        if (patch) { if (previous && this.sourceRow(id).credential_generation === null) this.credentials.remove(id); this.credentials.write(id, patch, generation as string); }
        this.db.prepare('INSERT INTO data_sources VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,revision=excluded.revision,location_revision=excluded.location_revision,credential_generation=excluded.credential_generation').run(id, JSON.stringify(config), (previous?.revision ?? 0) + 1, previous ? previous.locationRevision + Number(location(previous.config) !== location(config)) : 1, generation ?? null);
        this.db.prepare('DELETE FROM data_source_host_challenges WHERE source_id=?').run(id);
        const result = this.source(id); this.event('data-source.changed', id, result.revision); if(previous && previous.locationRevision !== result.locationRevision) queueMicrotask(() => { void this.pruneCaches().catch(() => {}); }); return result;
      } catch (error) { if (patch && old) { this.credentials.remove(id); if (Object.keys(old).length && oldGeneration) this.credentials.write(id, old, oldGeneration); } throw error; }
    });
  }
  remove(id: string, expectedRevision: number): void { atomic(this.db, () => { const source = this.editable(id, expectedRevision); this.db.prepare('DELETE FROM data_sources WHERE id=?').run(id); this.event('data-source.changed', id, source.revision + 1); this.credentials.remove(id); }); void this.pruneCaches().catch(() => {}); }
  private connector(source: DataSource, signal: AbortSignal, progress?: (received: number, total: number | null) => void): RemoteConnector {
    const connector = (this.options.connector ?? createRemoteConnector)(source, { credentials: this.credentials.read(source.id, this.sourceRow(source.id).credential_generation as string | null), trust: this.trust, signal, cacheRoot: join(this.cacheRoot, 'git'), ...(progress ? { progress } : {}), ...(this.options.keyPath ? { keyPath: this.options.keyPath } : {}), ...(this.options.gitCaFile ? { gitCaFile: this.options.gitCaFile } : {}) });
    const key = source.id + '-' + source.locationRevision; this.readers.set(key, (this.readers.get(key) ?? 0) + 1); let released = false;
    return { list: path => connector.list(path), pin: (path, destination, max, original) => connector.pin(path, destination, max, original), close: () => { connector.close(); if (!released) { released = true; this.readers.set(key, (this.readers.get(key) ?? 1) - 1); if (!this.closed) void this.pruneCaches().catch(() => {}); } } };
  }
  async list(id: string, locationRevision: number, path: string): Promise<RemoteListing> {
    const source = this.source(id); if (source.locationRevision !== locationRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source location changed. Browse it again.');
    remotePath(path); const signal = AbortSignal.timeout(120_000), connector = this.connector(source, signal);
    try { const entries = await connector.list(path); if (this.source(id).locationRevision !== locationRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source location changed. Browse it again.'); return { serviceId: this.serviceId, sourceId: id, locationRevision, path, entries, observedAt: new Date().toISOString() }; } finally { connector.close(); }
  }
  async test(id: string, revision: number): Promise<{ ok: boolean; error?: string; challenges: ReturnType<DataSourceHostTrust['challenges']> }> {
    const source = this.source(id); if (source.revision !== revision) throw new ServiceError('REVISION_CONFLICT', 'Reload data source settings.');
    try { await this.list(id, source.locationRevision, ''); if (this.source(id).revision !== revision) throw new ServiceError('REVISION_CONFLICT','Reload data source settings.'); return { ok: true, challenges: [] }; } catch (e) { return { ok: false, error: e instanceof ServiceError ? e.message : 'Connection test failed.', challenges: this.trust.challenges(id) }; }
  }
  private rawTransfer(id: string): RemoteTransfer { const row = this.db.prepare('SELECT payload FROM remote_transfers WHERE id=?').get(remoteId(id)); if (!row) throw new ServiceError('NOT_FOUND', 'Transfer not found.'); return JSON.parse(String(row.payload)) as RemoteTransfer; }
  transfer(id: string): RemoteTransfer {
    const job = this.rawTransfer(id), row = this.db.prepare('SELECT location_revision FROM data_sources WHERE id=?').get(job.sourceId);
    const retryable = ['failed','interrupted'].includes(job.state) && !!job.version && row?.location_revision === job.locationRevision;
    const blocked = ['failed','interrupted'].includes(job.state) && !retryable ? !row ? 'Data source was removed. Select another source.' : row.location_revision !== job.locationRevision ? 'Data source location changed. Browse it again.' : 'Select the file again after resolving the problem.' : undefined;
    return { ...job, retryable, ...(blocked ? { retryBlockedReason: blocked } : {}) };
  }
  transfers(): RemoteTransfer[] { return this.db.prepare('SELECT id FROM remote_transfers ORDER BY rowid DESC').all().map(row => this.transfer(String(row.id))); }
  private update(job: RemoteTransfer): void { delete job.retryBlockedReason; job.retryable = false; job.revision++; job.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE remote_transfers SET payload=? WHERE id=?').run(JSON.stringify(job), job.id); this.event('remote-transfer.changed', job.id, job.revision, job.target.projectId, job.state); }
  private assertTarget(value: RemoteTransferTarget): void { assertProjectWritable(this.db, value.projectId); if (value.kind === 'graph') this.graphs.writable({ serviceId: this.serviceId, projectId: value.projectId, graphId: value.graphId }); if (value.kind === 'temporary' && this.db.prepare('SELECT writable FROM remote_temporary_targets WHERE browser_id=? AND graph_id=? AND project_id=?').get(value.browserId,value.graphId,value.projectId)?.writable !== 1) throw new ServiceError('CONFLICT','The temporary Work Graph target was removed or is read-only.'); }
  registerTemporaryTarget(browserId: string, graphId: string, projectId: string, revision = 0): void {
    remoteId(browserId); remoteId(graphId); remoteId(projectId); if (!Number.isSafeInteger(revision) || revision < 0) invalid();
    atomic(this.db, () => {
      assertProjectWritable(this.db,projectId);
      if(this.db.prepare('SELECT 1 FROM remote_temporary_targets WHERE browser_id=? AND graph_id=? AND (removed=1 OR local_revision>? OR (local_revision=? AND writable=0))').get(browserId,graphId,revision,revision)) throw new ServiceError('CONFLICT','The temporary Work Graph target was removed or is read-only.');
      this.db.prepare('INSERT INTO remote_temporary_targets VALUES(?,?,?,1,?,0) ON CONFLICT(browser_id,graph_id,project_id) DO UPDATE SET writable=1,local_revision=excluded.local_revision').run(browserId,graphId,projectId,revision);
    });
  }
  syncTemporaryTargets(browserId: string, graphs: { graphId: string; writable: boolean; revision?: number }[]): void {
    remoteId(browserId); if (!Array.isArray(graphs) || graphs.length > 10000) invalid();
    for (const graph of graphs) { remoteId(graph.graphId); if (typeof graph.writable !== 'boolean' || !Number.isSafeInteger(graph.revision ?? 0) || (graph.revision ?? 0) < 0) invalid(); }
    const current = new Map(graphs.map(graph=>[graph.graphId,graph]));
    atomic(this.db, () => {
      for(const row of this.db.prepare('SELECT graph_id,project_id,local_revision,removed FROM remote_temporary_targets WHERE browser_id=?').all(browserId)) {
        const graph = current.get(String(row.graph_id));
        if(!graph) this.db.prepare('UPDATE remote_temporary_targets SET writable=0,removed=1 WHERE browser_id=? AND graph_id=? AND project_id=?').run(browserId,row.graph_id!,row.project_id!);
        else if(!row.removed && (graph.revision ?? 0) >= Number(row.local_revision)) this.db.prepare('UPDATE remote_temporary_targets SET writable=?,local_revision=? WHERE browser_id=? AND graph_id=? AND project_id=?').run(Number(graph.writable),graph.revision ?? 0,browserId,row.graph_id!,row.project_id!);
      }
      // A deleted local graph can never acknowledge its pending delivery. End
      // that operation without claiming the node was placed; read-only graphs
      // keep their delivery so receiving can resume after they are restored.
      const discarded = this.db.prepare(`SELECT d.id FROM remote_temporary_deliveries d
        JOIN remote_temporary_targets t ON t.browser_id=d.browser_id AND t.graph_id=d.graph_id AND t.project_id=d.project_id
        WHERE d.browser_id=? AND t.removed=1`).all(browserId);
      for (const row of discarded) {
        const job = this.rawTransfer(String(row.id));
        job.state = 'cancelled'; job.error = null; job.result = null; this.update(job);
        this.db.prepare('DELETE FROM remote_temporary_deliveries WHERE id=?').run(job.id);
      }
      if (discarded.length) this.resources.collectGarbage();
    });
  }
  acknowledgeDelivery(id: string, browserId: string): void {
    atomic(this.db, () => {
      const job = this.rawTransfer(id); if (job.state !== 'succeeded' || job.target.kind !== 'temporary' || job.target.browserId !== browserId) invalid();
      if (job.result?.deliveryAcknowledged) return;
      job.result = { ...job.result!, deliveryAcknowledged: true }; this.update(job);
      this.db.prepare('DELETE FROM remote_temporary_deliveries WHERE id=? AND browser_id=?').run(id, browserId);
      this.db.prepare("DELETE FROM remote_resource_provenance WHERE kind='delivery' AND resource_id=?").run(id);
      this.resources.collectGarbage();
    });
  }
  accept(input: RemoteTransferRequest): RemoteTransfer {
    const path = remotePath(input.path, false), to = target(input.target), key = text(input.idempotencyKey, 256), sourceId = remoteId(input.sourceId);
    const signature = createHash('sha256').update(canonicalJson(asJson({ ...input, path, target: to }))).digest('hex');
    const job = atomic(this.db, () => {
      const prior = this.db.prepare('SELECT id,request_hash FROM remote_transfers WHERE request_key=?').get(key);
      if (prior) { if (prior.request_hash !== signature) throw new ServiceError('IDEMPOTENCY_CONFLICT', 'Transfer request key was used for different parameters.'); return this.transfer(String(prior.id)); }
      if (this.closed || new Repositories(this.db).setting('acceptingRuns') === false) throw new ServiceError('MAINTENANCE', 'Workspace is stopping.');
      const source = this.source(sourceId); if (source.locationRevision !== input.locationRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source location changed. Browse it again.'); this.assertTarget(to);
      const now = new Date().toISOString(); const value: RemoteTransfer = { id: randomUUID(), serviceId: this.serviceId, sourceId, sourceName: source.config.name, locationRevision: source.locationRevision, path, target: to, state: 'accepted', attempt: 1, revision: 1, received: 0, bytes: null, version: null, createdAt: now, updatedAt: now, error: null, retryable: false, result: null };
      this.db.prepare('INSERT INTO remote_transfers VALUES(?,?,?,NULL,?,?)').run(value.id, sourceId, JSON.stringify(value), key, signature); this.event('remote-transfer.changed', value.id, 1, to.projectId, 'accepted'); return value;
    });
    if (job.state === 'accepted') this.launch(job.id); return job;
  }
  cancel(id: string): RemoteTransfer {
    const result = atomic(this.db, () => { const job = this.rawTransfer(id); if (active(job.state)) { job.state = 'cancelled'; job.error = null; this.update(job); } return this.transfer(id); });
    this.running.get(id)?.abort.abort(); return result;
  }
  retry(id: string, expectedAttempt: number): RemoteTransfer {
    const job = atomic(this.db, () => {
      const value = this.transfer(id); if (value.attempt !== expectedAttempt) { if (value.attempt === expectedAttempt + 1) return value; throw new ServiceError('REVISION_CONFLICT', 'Transfer attempt changed.'); }
      if (!value.retryable) throw new ServiceError('CONFLICT', 'Original version is unavailable or the source location changed. Select the file again.');
      if (this.closed || new Repositories(this.db).setting('acceptingRuns') === false) throw new ServiceError('MAINTENANCE', 'Workspace is stopping.'); this.assertTarget(value.target);
      value.attempt++; value.state = 'accepted'; value.error = null; value.received = 0; this.update(value); return value;
    }); if (job.state === 'accepted') this.launch(id); return job;
  }
  recover(): void { atomic(this.db, () => { for (const row of this.db.prepare('SELECT id FROM remote_transfers').all()) { const job = this.rawTransfer(String(row.id)); if (active(job.state)) { job.state = 'interrupted'; job.error = 'Workspace restarted. Retry manually.'; this.update(job); } } }); }
  private launch(id: string): void {
    if (this.running.has(id) || this.closed || this.running.size >= 2) return; const abort = new AbortController();
    const done = Promise.resolve().then(() => this.execute(id, abort.signal)).finally(() => { this.running.delete(id); if (!this.closed) for (const job of this.transfers()) if (job.state === 'accepted') this.launch(job.id); });
    this.running.set(id, { abort, done }); void done.catch(() => {});
  }
  async pruneCaches(): Promise<void> {
    if (this.closed) return;
    const retained = new Set<string>();
    for (const row of this.db.prepare('SELECT id,source_id,payload,cache_path FROM remote_transfers WHERE cache_path IS NOT NULL').all()) {
      const job = JSON.parse(String(row.payload)) as RemoteTransfer;
      const source = this.db.prepare('SELECT location_revision FROM data_sources WHERE id=?').get(row.source_id!);
      if ((active(job.state) || ['failed','interrupted'].includes(job.state)) && source?.location_revision === job.locationRevision) retained.add(String(row.cache_path));
      else { await rm(String(row.cache_path), {force:true}).catch(() => {}); if (this.closed) return; atomic(this.db, () => this.db.prepare('UPDATE remote_transfers SET cache_path=NULL WHERE id=?').run(row.id!)); }
    }
    // Only startup clears unrecorded preparations; concurrent downloads own UUID files too.
    const gitRoot = join(this.cacheRoot,'git');
    const entries = await readdir(gitRoot, {withFileTypes:true}).catch(() => []);
    if (this.closed) return;
    const sources = new Set(this.db.prepare('SELECT id,location_revision FROM data_sources').all().map(row => String(row.id)+'-'+row.location_revision));
    for (const entry of entries) if (entry.isDirectory() && /^[a-f0-9-]{36}-[1-9][0-9]*$/.test(entry.name) && !sources.has(entry.name) && !this.readers.get(entry.name)) await rm(join(gitRoot,entry.name), {recursive:true,force:true}).catch(() => {});
  }
  async cleanStartupCaches(): Promise<void> {
    await this.pruneCaches();
    if (this.closed) return;
    const retained = new Set(this.db.prepare('SELECT cache_path FROM remote_transfers WHERE cache_path IS NOT NULL').all().map(row => String(row.cache_path)));
    for (const entry of await readdir(this.cacheRoot,{withFileTypes:true}).catch(() => [])) if (entry.isFile() && /^[a-f0-9-]{36}$/.test(entry.name) && !retained.has(join(this.cacheRoot,entry.name))) await rm(join(this.cacheRoot,entry.name),{force:true});
    for (const entry of await readdir(join(this.cacheRoot,'git'),{withFileTypes:true}).catch(() => [])) if (entry.isFile() && /^askpass-[a-f0-9-]{36}\.(sh|cmd)$/.test(entry.name)) await rm(join(this.cacheRoot,'git',entry.name),{force:true});
  }
  async settled(): Promise<void> { while (this.running.size) await Promise.allSettled([...this.running.values()].map(x => x.done)); }
  disposeUnstarted(): void { this.closed = true; for (const value of this.running.values()) value.abort.abort(); }
  close(): void { if (this.closed) return; this.recover(); this.closed = true; for (const value of this.running.values()) value.abort.abort(); }
  private async execute(id: string, signal: AbortSignal): Promise<void> {
    let prepared: PreparedBlob | undefined, connector: RemoteConnector | undefined, cache: string | undefined;
    const check = () => { signal.throwIfAborted(); if (this.closed || !active(this.rawTransfer(id).state)) throw new Error('cancelled'); };
    try {
      check(); let job = this.rawTransfer(id); const source = this.source(job.sourceId);
      atomic(this.db, () => { job.state = 'preparing'; this.update(job); });
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 }); check();
      const old = this.db.prepare('SELECT cache_path FROM remote_transfers WHERE id=?').get(id)?.cache_path;
      if (old && job.version && await verifiedRemoteCache(String(old), job.version, signal)) cache = String(old);
      else {
        cache = join(this.cacheRoot, randomUUID()); let last = 0;
        connector = this.connector(source, AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]), (received, total) => { if (this.closed || signal.aborted || Date.now() - last < 150) return; last = Date.now(); atomic(this.db, () => { const current = this.rawTransfer(id); if (active(current.state)) { current.state = 'transferring'; current.received = received; current.bytes = total; this.update(current); } }); });
        const pin = await connector.pin(job.path, cache, WORKGRAPH_UPLOAD_MAX_BYTES, job.version ?? undefined); check();
        atomic(this.db, () => { const current = this.rawTransfer(id); current.version = pin.version; current.bytes = pin.version.bytes; current.received = pin.version.bytes; this.db.prepare('UPDATE remote_transfers SET cache_path=? WHERE id=?').run(cache!, id); this.update(current); });
      }
      check(); job = this.rawTransfer(id); const version = job.version!;
      const file = await open(cache!, 'r'); let prefix: Buffer; try { prefix = Buffer.alloc(Math.min(version.bytes, 65536)); await file.read(prefix, 0, prefix.length, 0); } finally { await file.close(); }
      let mime = sniffMime(prefix);
      if (mime === 'application/octet-stream' && version.bytes > prefix.length) {
        // Prefix sampling can stop inside a UTF-8 character. Full text validation
        // still happens in prepareBytes before any resource is committed.
        try { mime = sniffMime(Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true }))); }
        catch { /* Invalid bytes inside the sample remain binary. */ }
      }
      if (mime === 'text/plain') {
        if (/\.(md|markdown)$/i.test(job.path)) mime = 'text/markdown';
        else if (/\.svg$/i.test(job.path)) mime = 'image/svg+xml';
      }
      prepared = supportsText(mime) || version.bytes === 0 ? await this.resources.prepareBytes(await readCacheBytes(cache!), mime) : await this.resources.blobs.prepareStream(createReadStream(cache!), mime, { bytes: version.bytes, sha256: version.sha256 });
      if (prepared.sha256 !== version.sha256 || prepared.bytes !== version.bytes) throw new ServiceError('CONFLICT','Remote transfer content integrity check failed. Select the file again.');
      check();
      atomic(this.db, () => {
        const current = this.rawTransfer(id); if (!active(current.state)) throw new Error('cancelled'); this.assertTarget(current.target); current.state = 'committing';
        const name = basename(current.path), to = current.target;
        const provenance = { sourceName: current.sourceName, relativePath: current.path, importedAt: new Date().toISOString(), ...(version.kind === 'git' ? { commit: version.commit } : {}) };
        let kind: string, resourceId: string;
        if (to.kind === 'library') {
          const asset = this.resources.createLibraryFromPrepared({ projectId: to.projectId, name, mode: 'new' }, prepared!); current.result = { assetId: asset.id }; resourceId = asset.id; kind = 'asset';
        } else {
          const importedType = importedNodeType(name, mime);
          // Keep oversized text as a complete file rather than truncate node content.
          const type = importedType === 'text' && (prepared!.text === null || prepared!.bytes > 8 * 1024 * 1024) ? 'file' : importedType;
          const node: Node = { id: randomUUID(), type, schemaVersion: 1, contentVersion: 1, content: { title: name, text: type === 'text' ? prepared!.text! : '', prompt: '', mime, bytes: version.bytes, remoteProvenance: provenance }, x: to.x, y: to.y, ...defaultWorkgraphNodeSize(type), readOnly: false };
          if (to.kind === 'temporary') {
            this.resources.registerRemoteDelivery(prepared!);
            this.db.prepare('INSERT INTO remote_temporary_deliveries VALUES(?,?,?,?,?,?,?,?)').run(id, to.browserId, to.graphId, to.projectId, JSON.stringify(node), prepared!.sha256, mime, name);
            current.result = { nodeId: node.id, deliveryId: id }; resourceId = id; kind = 'delivery';
          } else {
            const scope = { serviceId: this.serviceId, projectId: to.projectId, graphId: to.graphId };
            const created = this.resources.createCanvasFromPrepared(scope, prepared!, name); resourceId = created.resource.id; kind = 'canvas';
            node.content = { ...node.content as Record<string, Json>, resourceId, resourceVersion: 1 };
            const graph = this.graphs.snapshot(scope);
            this.graphs.command({ ...scope, idempotencyKey: 'remote-transfer-' + id, expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, operations: [{ type: 'node.create', node }] }, 'remote-transfer');
            current.result = { nodeId: node.id, resourceId };
          }
        }
        this.db.prepare('INSERT INTO remote_resource_provenance VALUES(?,?,?)').run(kind, resourceId, JSON.stringify(provenance));
        current.state = 'succeeded'; current.error = null; current.received = version.bytes; this.update(current); this.db.prepare('UPDATE remote_transfers SET cache_path=NULL WHERE id=?').run(id);
      });
      await rm(cache!, { force: true }); cache = undefined;
    } catch (error) {
      if (!this.closed) atomic(this.db, () => { const job = this.rawTransfer(id); if (active(job.state)) { job.state = signal.aborted ? 'cancelled' : 'failed'; job.error = error instanceof ServiceError ? error.message : 'Remote transfer failed. Check the connection and retry manually.'; this.update(job); } });
    } finally {
      connector?.close();
      if (!this.closed) {
        if (prepared) atomic(this.db, () => this.resources.discardPrepared(prepared!));
        const job = this.rawTransfer(id); const saved = this.db.prepare('SELECT cache_path FROM remote_transfers WHERE id=?').get(id)?.cache_path;
        if (cache && (job.state === 'cancelled' || !job.version || saved !== cache)) { await rm(cache, { force: true }).catch(() => {}); if (!this.closed) atomic(this.db, () => this.db.prepare('UPDATE remote_transfers SET cache_path=NULL WHERE id=?').run(id)); }
        if (!this.closed) await this.resources.drainFileDeletions();
      }
    }
  }
  async download(sourceId: string, locationRevision: number, path: string, signal: AbortSignal, maxBytes = Number.MAX_SAFE_INTEGER): Promise<{ path: string; bytes: number; name: string; dispose: () => Promise<void> }> {
    const source = this.source(sourceId); if (source.locationRevision !== locationRevision) throw new ServiceError('REVISION_CONFLICT', 'Data source location changed. Browse it again.'); remotePath(path, false);
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 }); const destination = join(this.cacheRoot, randomUUID()), connector = this.connector(source, signal);
    try { const result = await connector.pin(path, destination, maxBytes); return { path: destination, bytes: result.version.bytes, name: basename(path), dispose: () => rm(destination, { force: true }) }; }
    catch (e) { await rm(destination, { force: true }); throw e; } finally { connector.close(); }
  }
}
