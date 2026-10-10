import { translate } from "../i18n/translate";
import { PROTOCOL_VERSION, GRAPH_BINARY_MIME, graphBinaryParts, readGraphBinary } from "../../../packages/protocol/src/index";
import type { GraphBundle } from "../../../packages/protocol/src/index";
import type { SkillCatalog, SkillCatalogQuery, SkillCatalogItem, SkillDetail, SkillConfiguration } from "../../../packages/protocol/src/skills";
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  AUTH_ERRORS,
  checkResponse,
  ConnectionRegistry,
  TransportError,
  LifecycleCancelledError,
} from "./connections";
import type { ConnectionLease, StorageLike } from "./connections";
export {
  TransportError,
  LifecycleCancelledError,
  isLifecycleCancellation,
} from "./connections";
export interface PendingRequest {
  id: string;
  serviceId: string;
  sessionId: string;
  path: string;
  method: string;
  idempotencyKey: string;
  createdAt: string;
  persistence: "session" | "memory";
}
interface PendingRequestEntry extends PendingRequest { body: string; payload?: Blob }
export interface TransportRequestOptions { journal?: "session" | "memory"; range?: { start: number; end: number } }
export interface RangeBlob { blob: Blob; start: number; end: number; total: number; mime: string }
export interface TransportOptions {
  pendingStorage?: StorageLike | null;
  pendingPrefix?: string;
  signal?: AbortSignal;
}
function immutableMediaPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
  if (pathname.endsWith('/thumbnail') && new URLSearchParams(path.slice(pathname.length + 1)).get('video') === '1') return false;
  if (/^\/v1\/projects\/[A-Za-z0-9_-]+\/files\/thumbnail$/.test(pathname) &&
      /\.(?:mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv)$/i.test(new URLSearchParams(path.slice(pathname.length + 1)).get('path') ?? ''))
    return false;
  return /^\/v1\/projects\/[A-Za-z0-9_-]+\/(?:assets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*|graphs\/[A-Za-z0-9_-]+\/resources\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*)\/(?:thumbnail|preview|content)$/.test(pathname)
    || /^\/v1\/projects\/[A-Za-z0-9_-]+\/files\/(?:thumbnail|media|content)$/.test(pathname);
}
const memoryJournals = new WeakMap<ConnectionRegistry, Map<string, Map<string, PendingRequestEntry>>>();
/** Service-bound authenticated HTTP. No write is retried implicitly. */
export class Transport {
  private unknown = new Map<string, PendingRequestEntry>();
  private readonly memoryUnknown: Map<string, PendingRequestEntry>;
  /** Journal rows are persisted before sending, but are not unknown while an
   * active request still owns their outcome. Counts keep concurrent retries
   * from exposing the row when only one of them has settled. */
  private readonly inFlight = new Map<string, number>();
  private storage: StorageLike | null;
  private prefix: string;
  private readonly owner: ConnectionLease;
  private readonly lifecycleSignal?: AbortSignal;
  constructor(
    readonly registry: ConnectionRegistry,
    readonly serviceId: string,
    options: TransportOptions = {},
  ) {
    this.owner = registry.lease(serviceId);
    let byService = memoryJournals.get(registry);
    if (!byService) { byService = new Map(); memoryJournals.set(registry, byService); }
    this.memoryUnknown = byService.get(serviceId) ?? new Map();
    byService.set(serviceId, this.memoryUnknown);
    for (const [id, entry] of this.memoryUnknown) if (entry.sessionId !== this.owner.sessionId) this.memoryUnknown.delete(id);
    this.lifecycleSignal = options.signal;
    this.storage =
      options.pendingStorage === undefined
        ? typeof sessionStorage === "undefined"
          ? null
          : sessionStorage
        : options.pendingStorage;
    this.prefix =
      (options.pendingPrefix ?? "openworkgraph.pending.v1.") + serviceId;
    try {
      const rows: unknown = JSON.parse(
        this.storage?.getItem(this.prefix) ?? "[]",
      );
      if (Array.isArray(rows))
        for (const row of rows) {
          if (
            row?.serviceId === serviceId &&
            typeof row.id === "string" &&
            typeof row.sessionId === "string" &&
            typeof row.path === "string" &&
            typeof row.body === "string" &&
            row.method === "POST" &&
            typeof row.idempotencyKey === "string" &&
            JSON.parse(row.body)?.idempotencyKey === row.idempotencyKey
          )
            this.unknown.set(row.id, { ...row, persistence: "session" });
        }
    } catch {
      /* Invalid journal cannot authorize replay. */
    }
  }
  private persist() {
    if (!this.storage) return;
    const entries = [...this.unknown.values()];
    if (entries.length) this.storage.setItem(this.prefix, JSON.stringify(entries));
    else this.storage.removeItem(this.prefix);
  }
  private settleJournal() {
    try { this.persist(); } catch { /* A stale idempotent row is safer than hiding a committed response. */ }
  }
  pending(): PendingRequest[] {
    return [...this.unknown.values(), ...this.memoryUnknown.values()]
      .filter(entry => !this.inFlight.has(entry.id))
      .map(({ body: _body, payload: _payload, ...entry }) => structuredClone(entry));
  }
  private begin(entry: PendingRequestEntry): void {
    this.inFlight.set(entry.id, (this.inFlight.get(entry.id) ?? 0) + 1);
  }
  private end(entry: PendingRequestEntry): void {
    const count = this.inFlight.get(entry.id) ?? 0;
    if (count <= 1) this.inFlight.delete(entry.id);
    else this.inFlight.set(entry.id, count - 1);
  }
  private removeEntry(entry: PendingRequestEntry) {
    (entry.persistence === "memory" ? this.memoryUnknown : this.unknown).delete(entry.id);
  }
  private assertOwner(): void {
    if (this.lifecycleSignal?.aborted) throw new LifecycleCancelledError();
    this.registry.assertCurrent(this.owner);
  }
  private path(path: string): void {
    const parts = path.split('?');
    const pathname = parts[0] ?? '';
    const fileQuery = parts.length === 2 && parts[1] !== undefined && parts[1].length > 0 &&
      /^\/v1\/projects\/[A-Za-z0-9_-]+\/files(?:\/(?:search|content|link-content|media|thumbnail))?$/.test(pathname);
    const skillParams = new URLSearchParams(parts[1]);
    const skillsQuery = parts.length === 2 && skillParams.size > 0 &&
      /^\/v1\/projects\/[A-Za-z0-9_-]+\/skills(?:\/search)?$/.test(pathname) &&
      [...skillParams].every(([key, value]) => skillParams.getAll(key).length === 1 &&
        (key === 'source' ? ['builtin-feature', 'openworkgraph', 'codex'].includes(value) : key === 'query' && pathname.endsWith('/search') && value.length <= 100));
    const mediaQuery = parts.length === 2 && parts[1] !== undefined && parts[1].length > 0 && immutableMediaPath(pathname);
    // Stable skill identities may contain source separators and repository paths.
    // Permit exactly one encoded identity segment, never arbitrary encoded API paths.
    const skillPath = /^\/v1\/skills\/((?:[A-Za-z0-9_.!~*'()-]|%[0-9a-fA-F]{2})+)(?:\/(?:install|update|uninstall|config|files))?$/.exec(pathname);
    let encodedSkillPath = false;
    if (skillPath) {
      try {
        const identity = decodeURIComponent(skillPath[1]!);
        encodedSkillPath = identity !== '.' && identity !== '..' && !/[\u0000-\u001f\u007f]/.test(identity) && encodeURIComponent(identity) === skillPath[1];
      } catch { /* Malformed percent encoding is rejected. */ }
    }
    const catalogParams = new URLSearchParams(parts[1]);
    const catalogQuery = pathname === '/v1/skills' && catalogParams.size > 0 && [...catalogParams].every(([key, value]) => {
      if (catalogParams.getAll(key).length !== 1) return false;
      if (key === 'refresh' || key === 'installed') return value === '1';
      if (key === 'query') return value.length <= 1024;
      if (key === 'offset' || key === 'limit') return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && (key === 'offset' || (Number(value) >= 1 && Number(value) <= 100));
      return false;
    });
    const detailQuery = encodedSkillPath && !/\/(?:install|update|uninstall|config|files)$/.test(pathname) && /^locale=[A-Za-z0-9-]+$/.test(parts[1] ?? '');
    const resourceParams = new URLSearchParams(parts[1]);
    const resourcePath = resourceParams.get('path') ?? '';
    const resourceQuery = encodedSkillPath && pathname.endsWith('/files') && [...resourceParams].length === 2 &&
      resourceParams.getAll('version').length === 1 && resourceParams.getAll('path').length === 1 &&
      /^[a-f0-9]{64}$/.test(resourceParams.get('version') ?? '') && resourcePath.length > 0 &&
      !resourcePath.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(resourcePath) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(resourcePath) && !resourcePath.split('/').some(part => !part || part === '.' || part === '..');
    if (
      parts.length > 2 || path.includes('#') ||
      (!/^\/(?:health|v1(?:\/[A-Za-z0-9_.-]+)*)$/.test(pathname) && !encodedSkillPath) ||
      pathname.split("/").some((p) => p === "." || p === "..") ||
      (parts.length === 2 && !fileQuery && !skillsQuery && !mediaQuery && !catalogQuery && !detailQuery && !resourceQuery)
    )
      throw new TransportError("INVALID_REQUEST", translate("Only standard API paths for this Workspace are allowed"));
  }
  async open(
    path: string,
    options: {
      method?: string;
      body?: string | Blob;
      signal?: AbortSignal;
      cursor?: string;
      accept?: string;
      range?: { start: number; end: number };
      cache?: RequestCache;
    } = {},
  ): Promise<{ response: Response; lease: ConnectionLease }> {
    this.path(path);
    this.assertOwner();
    const lease = this.owner;
    const headers = new Headers({
      Authorization: "Bearer " + lease.token,
      "X-Workgraph-Protocol": PROTOCOL_VERSION,
      "X-Workgraph-Service-Id": this.serviceId,
    });
    if (options.body !== undefined)
      headers.set("Content-Type", options.body instanceof Blob ? options.body.type : "application/json");
    if (options.cursor) headers.set("Last-Event-ID", options.cursor);
    if (options.accept) headers.set("Accept", options.accept);
    if (options.range) headers.set("Range", `bytes=${options.range.start}-${options.range.end}`);
    const signal = AbortSignal.any([
      lease.signal,
      ...(this.lifecycleSignal ? [this.lifecycleSignal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const response = await this.registry.fetcher(lease.address + path, {
        method: options.method ?? "GET",
        body: options.body,
        headers,
        signal,
        credentials: "omit",
        redirect: "error",
        cache: options.cache ?? "no-store",
      });
      this.assertOwner();
      await checkResponse(response);
      this.assertOwner();
      if (signal.aborted) throw new LifecycleCancelledError();
      this.registry.setStatus(lease, "paired");
      return { response, lease };
    } catch (error) {
      this.assertOwner();
      if (signal.aborted) throw new LifecycleCancelledError();
      if (
        error instanceof TransportError &&
        (AUTH_ERRORS.has(error.code) ||
          [
            "SERVICE_MISMATCH",
            "PROTOCOL_INCOMPATIBLE",
            "ORIGIN_DENIED",
          ].includes(error.code))
      )
        this.registry.invalidate(this.serviceId, lease.generation);
      else if (!(error instanceof TransportError) && !options.signal?.aborted)
        this.registry.setStatus(lease, "offline");
      throw error;
    }
  }
  async request<T = unknown>(
    path: string,
    body?: unknown,
    method?: string,
    options: TransportRequestOptions = {},
  ): Promise<T> {
    this.assertOwner();
    const verb = (
      method ?? (body === undefined ? "GET" : "POST")
    ).toUpperCase();
    if (!["GET", "POST", "DELETE", "BLOB", "RANGE", "PUT"].includes(verb) ||
        (verb === 'PUT' && !/^\/v1\/skills\/[^/]+\/config$/.test(path)))
      throw new TransportError("INVALID_REQUEST", translate("The Workspace only supports GET, POST, and DELETE"));
    if ((verb === "GET" || verb === "BLOB" || verb === "RANGE") && body !== undefined)
      throw new TransportError("INVALID_REQUEST", translate("GET requests do not accept a request body"));
    if (verb === "RANGE" && (!options.range || !Number.isSafeInteger(options.range.start) || !Number.isSafeInteger(options.range.end) || options.range.start < 0 || options.range.end < options.range.start))
      throw new TransportError("INVALID_REQUEST", translate("Invalid media byte range"));
    let payload: Blob | undefined;
    let serialized: string | undefined;
    if (verb === 'POST' && /^[/]v1[/]projects[/][A-Za-z0-9_-]+[/]graphs[/]import$/.test(path) && body && typeof body === 'object' && 'bundle' in body) {
      const input = body as { bundle: GraphBundle; idempotencyKey?: string };
      if (Object.keys(input).some(key => !['bundle', 'idempotencyKey'].includes(key)))
        throw new TransportError('INVALID_REQUEST', 'Unsupported Work Graph import field');
      const parts = graphBinaryParts(input.bundle, input.idempotencyKey);
      const digest = sha256.create();
      for (const part of parts) digest.update(part);
      serialized = 'binary:' + bytesToHex(digest.digest());
      payload = new Blob(parts as BlobPart[], { type: GRAPH_BINARY_MIME });
    } else if (verb === 'POST' && /^[/]v1[/]projects[/][A-Za-z0-9_-]+[/]graphs[/][A-Za-z0-9_-]+[/]visualize[/][A-Za-z0-9_-]+[/]bridge[/][A-Za-z0-9_-]+[/]asset$/.test(path) && body && typeof body === 'object' && 'payload' in body) {
      const input = body as { payload: Blob; idempotencyKey: string };
      if (!(input.payload instanceof Blob) || input.payload.type !== 'application/vnd.openworkgraph.visualize-asset' || Object.keys(input).some(key => !['payload', 'idempotencyKey'].includes(key)))
        throw new TransportError('INVALID_REQUEST', 'Invalid asset export payload');
      const digest = sha256.create(), reader = input.payload.stream().getReader();
      try { while (true) { const part = await reader.read(); if (part.done) break; digest.update(part.value); } } finally { reader.releaseLock(); }
      serialized = 'binary:' + bytesToHex(digest.digest()); payload = input.payload;
    } else serialized = body === undefined ? undefined : JSON.stringify(body);
    const key =
      body && typeof body === "object" && "idempotencyKey" in body
        ? body.idempotencyKey
        : undefined;
    if (verb === "POST" && typeof key === "string" && key) {
      this.path(path);
      const lease = this.registry.lease(this.serviceId);
      const id = JSON.stringify([this.serviceId, lease.sessionId, path, key]);
      const existing = this.unknown.get(id) ?? this.memoryUnknown.get(id);
      if (existing && existing.body !== serialized)
        throw new TransportError(
          "IDEMPOTENCY_CONFLICT",
          translate("An unknown request must reuse its original key and body"),
        );
      const entry: PendingRequestEntry = existing ?? {
        id,
        serviceId: this.serviceId,
        sessionId: lease.sessionId,
        path,
        method: verb,
        body: serialized!,
        ...(payload ? { payload } : {}),
        idempotencyKey: key,
        createdAt: new Date().toISOString(),
        persistence: payload || options.journal === "memory" ? "memory" : "session",
      };
      (entry.persistence === "memory" ? this.memoryUnknown : this.unknown).set(id, entry);
      if (!existing && entry.persistence === "session") {
        try { this.persist(); }
        catch {
          this.unknown.delete(id);
          throw new TransportError("STORAGE_QUOTA", translate("The browser could not save the pending reconciliation request. Free site storage and try again; the request was not sent."));
        }
      }
      this.begin(entry);
      try { return await this.send<T>(path, entry.payload ?? serialized, verb, entry); }
      finally { this.end(entry); }
    }
    return this.send<T>(path, payload ?? serialized, verb, undefined, options);
  }
  private async send<T>(
    path: string,
    body: string | Blob | undefined,
    method: string,
    entry?: PendingRequestEntry,
    options: TransportRequestOptions = {},
  ): Promise<T> {
    let readingBody = false;
    try {
      const { response } = await this.open(path, {
        method: method === "BLOB" || method === "RANGE" ? "GET" : method,
        body,
        accept: method === 'GET' && path.endsWith('/export') ? GRAPH_BINARY_MIME : undefined,
        range: method === "RANGE" ? options.range : undefined,
        cache: method === "BLOB" && immutableMediaPath(path) ? "force-cache" : "no-store",
      });
      readingBody = true;
      const result =
        method === "RANGE"
          ? await (async (): Promise<RangeBlob> => {
              const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
              if (response.status !== 206 || !match) throw new TransportError("INVALID_REQUEST", translate("The Workspace did not return a valid media byte range"));
              const [, start, end, total] = match;
              const blob = await response.blob();
              if (![start,end,total].every(value => Number.isSafeInteger(Number(value))) || Number(total) <= Number(end) || Number(start) !== options.range?.start || Number(end) < Number(start) || Number(end) > options.range!.end || blob.size !== Number(end) - Number(start) + 1)
                throw new TransportError("INVALID_REQUEST", translate("The Workspace returned inconsistent media bytes"));
              return { blob, start:Number(start), end:Number(end), total:Number(total), mime:response.headers.get("Content-Type") ?? blob.type };
            })()
          : method === "BLOB"
          ? await response.blob()
          : response.status === 204
            ? undefined
            : response.headers.get('Content-Type') === GRAPH_BINARY_MIME
              ? await (async () => {
                  if (!response.body) throw new Error('Missing Work Graph response body');
                  const reader = response.body.getReader();
                  async function* chunks() {
                    try { while (true) { const value = await reader.read(); if (value.done) return; yield value.value; } }
                    finally { await reader.cancel(); reader.releaseLock(); }
                  }
                  return (await readGraphBinary(chunks())).bundle;
                })()
              : await response.json();
      this.assertOwner();
      if (entry) {
        this.removeEntry(entry);
        this.settleJournal();
      }
      return result as T;
    } catch (error) {
      // Body reads reject with native AbortError after headers have succeeded.
      // Reclassify only when our own lease/lifecycle proves cancellation.
      if (readingBody) this.assertOwner();
      // 5xx/disconnect/truncated success may follow a commit: retain the journal.
      if (
        entry &&
        error instanceof TransportError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== "HTTP_ERROR"
      ) {
        this.removeEntry(entry);
        this.settleJournal();
      }
      if (method === "POST" && body instanceof Blob && body.type === GRAPH_BINARY_MIME &&
          error instanceof TransportError && error.code === "UNSUPPORTED_MEDIA_TYPE")
        throw new TransportError(error.code, translate("This Workspace does not support Work Graph binary import. Update the Workspace and try again."), error.status, error.details);
      throw error;
    }
  }
  async retry<T = unknown>(pendingId: string): Promise<T> {
    this.assertOwner();
    const entry = this.unknown.get(pendingId) ?? this.memoryUnknown.get(pendingId);
    if (!entry) throw new TransportError("NOT_FOUND", translate("The unknown request does not exist"));
    const lease = this.registry.lease(this.serviceId);
    if (lease.sessionId !== entry.sessionId)
      throw new TransportError(
        "STALE_CONNECTION",
        translate("The idempotency key is bound to the original session and cannot be replayed after pairing again"),
      );
    this.begin(entry);
    try { return await this.send<T>(entry.path, entry.payload ?? entry.body, entry.method, entry); }
    finally { this.end(entry); }
  }
  listSkills(refresh = false, options: SkillCatalogQuery = {}): Promise<SkillCatalog> {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (options.offset !== undefined) params.set('offset', String(options.offset));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.installedOnly) params.set('installed', '1');
    if (options.query?.trim()) params.set('query', options.query.trim());
    return this.request('/v1/skills' + (params.size ? '?' + params.toString() : ''));
  }
  skillDetail(id: string, locale: string): Promise<SkillDetail> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '?locale=' + encodeURIComponent(locale));
  }
  installSkill(id: string, expectedRevision: number): Promise<SkillCatalogItem> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/install', { expectedRevision });
  }
  updateSkill(id: string, expectedRevision: number): Promise<SkillCatalogItem> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/update', { expectedRevision });
  }
  uninstallSkill(id: string, expectedRevision: number): Promise<SkillCatalogItem> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/uninstall', { expectedRevision });
  }
  readSkillConfig(id: string): Promise<SkillConfiguration> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/config');
  }
  writeSkillConfig(id: string, expectedRevision: number, values: Record<string, string | null>, expectedPackageVersion: string): Promise<SkillConfiguration> {
    // No idempotency journal: configuration values must never enter browser storage.
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/config', { expectedRevision, expectedPackageVersion, values }, 'PUT');
  }
  clearSkillConfig(id: string, expectedRevision: number): Promise<void> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/config', { expectedRevision }, 'DELETE');
  }
  readSkillFile(id: string, version: string, path: string): Promise<Blob> {
    return this.request('/v1/skills/' + encodeURIComponent(id) + '/files?' + new URLSearchParams({ version, path }), undefined, 'BLOB');
  }
}
