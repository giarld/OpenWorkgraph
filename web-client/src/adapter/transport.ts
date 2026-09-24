import { translate } from "../i18n/translate";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/index";
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
interface PendingRequestEntry extends PendingRequest { body: string }
export interface TransportRequestOptions { journal?: "session" | "memory" }
export interface TransportOptions {
  pendingStorage?: StorageLike | null;
  pendingPrefix?: string;
  signal?: AbortSignal;
}
function immutableMediaPath(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
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
      .map(({ body: _body, ...entry }) => structuredClone(entry));
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
      /^\/v1\/projects\/[A-Za-z0-9_-]+\/files(?:\/(?:search|content|media|thumbnail))?$/.test(pathname);
    const mediaQuery = parts.length === 2 && parts[1] !== undefined && parts[1].length > 0 && immutableMediaPath(path);
    if (
      parts.length > 2 || path.includes('#') ||
      !/^\/(?:health|v1(?:\/[A-Za-z0-9_.-]+)*)$/.test(pathname) ||
      pathname.split("/").some((p) => p === "." || p === "..") ||
      (parts.length === 2 && !fileQuery && !mediaQuery)
    )
      throw new TransportError("INVALID_REQUEST", translate("Only standard API paths for this Runtime are allowed"));
  }
  async open(
    path: string,
    options: {
      method?: string;
      body?: string;
      signal?: AbortSignal;
      cursor?: string;
      accept?: string;
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
      headers.set("Content-Type", "application/json");
    if (options.cursor) headers.set("Last-Event-ID", options.cursor);
    if (options.accept) headers.set("Accept", options.accept);
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
    if (!["GET", "POST", "DELETE", "BLOB"].includes(verb))
      throw new TransportError("INVALID_REQUEST", translate("The Runtime only supports GET, POST, and DELETE"));
    if ((verb === "GET" || verb === "BLOB") && body !== undefined)
      throw new TransportError("INVALID_REQUEST", translate("GET requests do not accept a request body"));
    const serialized = body === undefined ? undefined : JSON.stringify(body);
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
        idempotencyKey: key,
        createdAt: new Date().toISOString(),
        persistence: options.journal === "memory" ? "memory" : "session",
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
      try { return await this.send<T>(path, serialized, verb, entry); }
      finally { this.end(entry); }
    }
    return this.send<T>(path, serialized, verb);
  }
  private async send<T>(
    path: string,
    body: string | undefined,
    method: string,
    entry?: PendingRequestEntry,
  ): Promise<T> {
    let readingBody = false;
    try {
      const { response } = await this.open(path, {
        method: method === "BLOB" ? "GET" : method,
        body,
        cache: method === "BLOB" && immutableMediaPath(path) ? "force-cache" : "no-store",
      });
      readingBody = true;
      const result =
        method === "BLOB"
          ? await response.blob()
          : response.status === 204
            ? undefined
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
    try { return await this.send<T>(entry.path, entry.body, entry.method, entry); }
    finally { this.end(entry); }
  }
}
