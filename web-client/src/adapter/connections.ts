import { translate } from "../i18n/translate";
import { displayTerminology } from "../i18n/display-terminology";
import {
  PROTOCOL_VERSION,
  isProtocolCompatible,
  PAIR_AUTHORIZATION_PREFIX,
  parsePairAuthorization,
  normalizeShortPairingCode,
} from "../../../packages/protocol/src/index";
import type { PairingIdentity } from './client-pairing';
import type {
  ClientPairingRequest,
  ClientPairingStatus,
  PairResponse,
  ServiceInfo,
  Session,
} from "../../../packages/protocol/src/index";

export interface ClientPairingTicket extends ClientPairingRequest { address: string }
export const RUNTIME_NAME_MAX_LENGTH = 32;

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ConnectionStatus = "paired" | "offline" | "invalid";
export interface Connection {
  serviceId: string;
  runtimeName?: string;
  address: string;
  addresses: string[];
  info: ServiceInfo;
  session: Session;
  status: ConnectionStatus;
  generation: number;
}
interface SavedConnection extends Connection {
  token: string;
}
export interface ConnectionLease {
  serviceId: string;
  address: string;
  sessionId: string;
  generation: number;
  token: string;
  signal: AbortSignal;
}
export class TransportError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details?: unknown,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
function validateRuntimeName(name: string | undefined): void {
  if (name && name.trim().length > RUNTIME_NAME_MAX_LENGTH)
    throw new TransportError('INVALID_REQUEST', translate('Workspace name must be at most {max} characters', { max: RUNTIME_NAME_MAX_LENGTH }));
}

/** Raised only with proof that the owning connection/lifecycle was superseded. */
export class LifecycleCancelledError extends TransportError {
  constructor() {
    super("REQUEST_CANCELLED", translate("The interface or connection that owns this request has ended"));
  }
}
export function isLifecycleCancellation(
  error: unknown,
): error is LifecycleCancelledError {
  return error instanceof LifecycleCancelledError;
}
export const AUTH_ERRORS = new Set([
  "UNAUTHENTICATED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
]);
export function normalizeAddress(input: string): string {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new TransportError(
      "INVALID_ADDRESS",
      translate("The Workspace address must be an HTTP(S) origin without credentials or a path"),
    );
  return url.origin;
}
export async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  throw new TransportError(
    body?.error?.code ?? "HTTP_ERROR",
    typeof body?.error?.message === 'string' ? displayTerminology(body.error.message) : `HTTP ${response.status}`,
    response.status,
    body?.error,
  );
}
export interface RegistryOptions {
  fetch?: typeof fetch;
  storage?: StorageLike | null;
  storagePrefix?: string;
  storageEvents?: Pick<
    Window,
    "addEventListener" | "removeEventListener"
  > | null;
}
/** One persisted key per service avoids cross-service read/modify/write races.
 * Storage events invalidate only the exact session being removed/replaced.
 * Tokens never appear in public snapshots. Origin is supplied by the browser. */
export class ConnectionRegistry {
  readonly fetcher: typeof fetch;
  readonly storage: StorageLike | null;
  readonly storagePrefix: string;
  readonly pendingStoragePrefix: string;
  private rows = new Map<string, SavedConnection>();
  private controllers = new Map<string, AbortController>();
  private epochs = new Map<string, number>();
  private listeners = new Set<() => void>();
  private attempts = new Map<string, number>();
  private eventOffline = new Set<string>();
  private disposed = false;
  private eventTarget: RegistryOptions["storageEvents"];
  constructor(options: RegistryOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage =
      options.storage === undefined
        ? typeof localStorage === "undefined"
          ? null
          : localStorage
        : options.storage;
    this.storagePrefix =
      options.storagePrefix ?? "openworkgraph.connections.v1.";
    this.pendingStoragePrefix = this.storagePrefix + 'pending:';
    this.eventTarget =
      options.storageEvents === undefined
        ? typeof window === "undefined"
          ? null
          : window
        : options.storageEvents;
    this.eventTarget?.addEventListener(
      "storage",
      this.onStorage as EventListener,
    );
  }
  private onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== this.storage) return;
    for (const [id, row] of this.rows) {
      if (event.key !== null && event.key !== this.storagePrefix + id) continue;
      // A removed association is not merely a revoked/replaced session: drop
      // its public row too. Consult current storage, not event.newValue, so a
      // queued removal event cannot erase a subsequently re-paired session.
      if (this.storage?.getItem(this.storagePrefix + id) === null) {
        this.forget(id);
        continue;
      }
      const saved = this.readSaved(id);
      if (
        !saved ||
        saved.token !== row.token ||
        saved.session.id !== row.session.id
      )
        this.invalidate(id, row.generation);
    }
  };
  private readSaved(id: string): SavedConnection | undefined {
    try {
      const value = JSON.parse(
        this.storage?.getItem(this.storagePrefix + id) ?? "null",
      );
      if (
        value?.serviceId === id &&
        typeof value.token === "string" &&
        typeof value.session?.id === "string" &&
        Array.isArray(value.addresses)
      )
        return value;
    } catch {
      /* Corrupt storage is not an authenticated connection. */
    }
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get(serviceId: string): Connection | undefined {
    const row = this.rows.get(serviceId);
    if (!row) return;
    const { token: _token, ...view } = row;
    return structuredClone(view);
  }
  list(): Connection[] {
    return [...this.rows.keys()].map((id) => this.get(id)!);
  }
  lease(serviceId: string): ConnectionLease {
    const row = this.rows.get(serviceId);
    if (this.disposed || !row || row.status === "invalid")
      throw new TransportError("UNAUTHENTICATED", translate("Pair with the Workspace or restore its session"));
    if (this.storage) {
      const saved = this.readSaved(serviceId);
      if (
        !saved ||
        saved.token !== row.token ||
        saved.session.id !== row.session.id
      ) {
        this.invalidate(serviceId, row.generation);
        throw new TransportError(
          "STALE_CONNECTION",
          translate("Another tab removed or replaced the session"),
        );
      }
    }
    return {
      serviceId,
      address: row.address,
      sessionId: row.session.id,
      generation: row.generation,
      token: row.token,
      signal: this.controllers.get(serviceId)!.signal,
    };
  }
  assertCurrent(lease: ConnectionLease): void {
    if (this.disposed || lease.signal.aborted)
      throw new LifecycleCancelledError();
    const current = this.lease(lease.serviceId);
    if (
      current.generation !== lease.generation ||
      current.sessionId !== lease.sessionId
    )
      throw new LifecycleCancelledError();
  }
  setStatus(lease: ConnectionLease, status: "paired" | "offline"): void {
    this.assertCurrent(lease);
    const row = this.rows.get(lease.serviceId)!;
    if (status === "paired" && this.eventOffline.has(lease.serviceId)) return;
    if (row.status !== status) {
      row.status = status;
      this.emit();
    }
  }
  /** Only the event channel may release its offline fence; HTTP success cannot. */
  setEventConnected(lease: ConnectionLease, connected: boolean): void {
    this.assertCurrent(lease);
    if (connected) this.eventOffline.delete(lease.serviceId);
    else this.eventOffline.add(lease.serviceId);
    this.setStatus(lease, connected ? "paired" : "offline");
  }
  invalidate(serviceId: string, generation?: number): void {
    const row = this.rows.get(serviceId);
    if (!row || (generation !== undefined && row.generation !== generation))
      return;
    this.controllers.get(serviceId)?.abort();
    row.status = "invalid";
    row.generation = (this.epochs.get(serviceId) ?? 0) + 1;
    this.epochs.set(serviceId, row.generation);
    this.emit();
  }
  private install(row: SavedConnection, persist: boolean): Connection {
    if (this.disposed)
      throw new TransportError("STALE_CONNECTION", translate("The connection registry is closed"));
    if (persist)
      this.storage?.setItem(
        this.storagePrefix + row.serviceId,
        JSON.stringify(row),
      );
    this.controllers.get(row.serviceId)?.abort();
    this.eventOffline.delete(row.serviceId);
    row.generation = (this.epochs.get(row.serviceId) ?? 0) + 1;
    this.epochs.set(row.serviceId, row.generation);
    this.controllers.set(row.serviceId, new AbortController());
    this.rows.set(row.serviceId, row);
    this.emit();
    return this.get(row.serviceId)!;
  }
  renameRuntime(serviceId: string, name: string, expectedSessionId: string): void {
    const lease = this.lease(serviceId);
    const runtimeName = name.trim();
    validateRuntimeName(runtimeName);
    if (!runtimeName) throw new TransportError('INVALID_REQUEST', translate('Workspace name is required'));
    if (lease.sessionId !== expectedSessionId) throw new LifecycleCancelledError();
    const row = { ...this.rows.get(serviceId)!, runtimeName };
    this.storage?.setItem(this.storagePrefix + serviceId, JSON.stringify(row));
    this.rows.set(serviceId, row);
    this.emit();
  }
  async discover(
    address: string,
    expectedServiceId?: string,
    signal?: AbortSignal,
  ): Promise<ServiceInfo> {
    const headers: Record<string, string> = {
      "X-Workgraph-Protocol": PROTOCOL_VERSION,
    };
    if (expectedServiceId)
      headers["X-Workgraph-Service-Id"] = expectedServiceId;
    const response = await this.fetcher(
      normalizeAddress(address) + "/v1/info",
      { headers, credentials: "omit", redirect: "error", cache: "no-store", signal },
    );
    await checkResponse(response);
    const info = (await response.json()) as ServiceInfo;
    if (
      !info ||
      typeof info.serviceId !== "string" ||
      !info.serviceId ||
      !isProtocolCompatible(info.protocolVersion)
    )
      throw new TransportError("PROTOCOL_INCOMPATIBLE", translate("The Workspace did not return a compatible protocol"));
    if (expectedServiceId && info.serviceId !== expectedServiceId)
      throw new TransportError("SERVICE_MISMATCH", translate("The address does not belong to the expected Workspace"));
    return info;
  }
  /** Refresh metadata without replacing the session, generation or SSE fence. */
  async refreshInfo(lease: ConnectionLease, signal?: AbortSignal): Promise<void> {
    this.assertCurrent(lease);
    const requestSignal = signal ? AbortSignal.any([lease.signal, signal]) : lease.signal;
    const info = await this.discover(lease.address, lease.serviceId, requestSignal);
    this.assertCurrent(lease);
    if (requestSignal.aborted) throw new LifecycleCancelledError();
    const row = this.rows.get(lease.serviceId)!;
    if (JSON.stringify(row.info) === JSON.stringify(info)) return;
    const updated = { ...row, info };
    this.storage?.setItem(this.storagePrefix + lease.serviceId, JSON.stringify(updated));
    this.rows.set(lease.serviceId, updated);
    this.emit();
  }
  async requestClientPairing(address: string, identity: PairingIdentity): Promise<ClientPairingTicket> {
    address = normalizeAddress(address);
    const response = await this.fetcher(address + '/v1/pair/request', {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Workgraph-Protocol': PROTOCOL_VERSION },
      body: JSON.stringify({ clientCode: identity.clientCode }),
    });
    await checkResponse(response);
    const result = await response.json() as ClientPairingRequest;
    if (!result || !normalizeShortPairingCode(result.code) || typeof result.serviceId !== 'string' || !result.serviceId || Number.isNaN(Date.parse(result.expiresAt)))
      throw new TransportError('PROTOCOL_INCOMPATIBLE', translate('The Workspace returned an invalid client code.'));
    return { ...result, address };
  }
  async waitForClientPairing(
    ticket: ClientPairingTicket,
    browserName: string,
    identity: PairingIdentity,
    runtimeName?: string,
    signal?: AbortSignal,
    pollIntervalMs = 1000,
  ): Promise<Connection> {
    const address = normalizeAddress(ticket.address);
    validateRuntimeName(runtimeName);
    const name = browserName.trim();
    if (!name) throw new TransportError('INVALID_REQUEST', translate('Browser name is required'));
    const signed = await identity.sign(ticket.code, ticket.serviceId, name);
    const epoch = this.epochs.get(ticket.serviceId) ?? 0;
    const savedBefore = this.storage?.getItem(this.storagePrefix + ticket.serviceId);
    while (true) {
      if (this.disposed || signal?.aborted || (this.epochs.get(ticket.serviceId) ?? 0) !== epoch) throw new LifecycleCancelledError();
      const response = await this.fetcher(address + '/v1/pair/status', {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Workgraph-Protocol': PROTOCOL_VERSION,
          'X-Workgraph-Service-Id': ticket.serviceId,
        },
        body: JSON.stringify({ code: ticket.code, browserName: name, expectedServiceId: ticket.serviceId, ...signed }),
      });
      await checkResponse(response);
      const status = await response.json() as ClientPairingStatus;
      if (status.status === 'ready' || status.status === 'paired') {
        if (status.serviceId !== ticket.serviceId || !status.token || !status.session?.id || status.session.state !== 'active')
          throw new TransportError('SERVICE_MISMATCH', translate('The pairing response identity is invalid'));
        if ((this.epochs.get(ticket.serviceId) ?? 0) !== epoch || this.storage?.getItem(this.storagePrefix + ticket.serviceId) !== savedBefore)
          throw new TransportError('STALE_CONNECTION', translate('Another tab replaced the association. Restore the new session'));
        if (status.status === 'ready') {
          this.storage?.setItem(this.pendingStoragePrefix + ticket.serviceId, JSON.stringify({ address, serviceId: ticket.serviceId, session: status.session, token: status.token, expiresAt: ticket.expiresAt }));
          const completed = await this.fetcher(address + '/v1/pair/complete', {
            method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
            headers: {
              'Content-Type': 'application/json', Authorization: `Bearer ${status.token}`,
              'X-Workgraph-Protocol': PROTOCOL_VERSION, 'X-Workgraph-Service-Id': ticket.serviceId,
            },
            body: JSON.stringify({ code: ticket.code, expectedServiceId: ticket.serviceId }),
          });
          await checkResponse(completed);
          const result = await completed.json() as ClientPairingStatus;
          if (result.status !== 'paired' || result.serviceId !== ticket.serviceId || result.token !== status.token || result.session?.id !== status.session.id)
            throw new TransportError('SERVICE_MISMATCH', translate('The pairing response identity is invalid'));
        }
        const info = await this.discover(address, ticket.serviceId);
        const row: SavedConnection = {
          serviceId: ticket.serviceId, runtimeName: runtimeName?.trim() || this.rows.get(ticket.serviceId)?.runtimeName,
          address, addresses: [...new Set([address, ...(this.rows.get(ticket.serviceId)?.addresses ?? [])])],
          info, session: status.session, token: status.token, status: 'paired', generation: 0,
        };
        const connection = this.install(row, true);
        this.storage?.removeItem(this.pendingStoragePrefix + ticket.serviceId);
        return connection;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timeout); reject(new LifecycleCancelledError()); };
        const timeout = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, pollIntervalMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  async pair(
    address: string,
    code: string,
    browserName: string,
    expectedServiceId?: string,
    identity?: PairingIdentity,
    runtimeName?: string,
  ): Promise<Connection> {
    validateRuntimeName(runtimeName);
    address = normalizeAddress(address);
    code = code.trim();
    const grant = code.startsWith(PAIR_AUTHORIZATION_PREFIX) ? parsePairAuthorization(code) : undefined;
    const short = normalizeShortPairingCode(code);
    if (short && !identity) throw new TransportError('PAIRING_CODE_INVALID', translate("Complete pairing on the original page that generated the client code."));
    if (grant) {
      if (!identity) throw new TransportError('PAIRING_CODE_INVALID', translate("Complete pairing on the original page that generated the client code."));
      if (expectedServiceId && expectedServiceId !== grant.serviceId) throw new TransportError('SERVICE_MISMATCH', translate("The authorization code belongs to another Workspace."));
      expectedServiceId = grant.serviceId;
    }
    const epochs = new Map(this.epochs);
    const info = await this.discover(address, expectedServiceId);
    if (
      (epochs.get(info.serviceId) ?? 0) !==
      (this.epochs.get(info.serviceId) ?? 0)
    )
      throw new TransportError("STALE_CONNECTION", translate("The association changed during discovery"));
    const id = info.serviceId,
      attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const epoch = this.epochs.get(id) ?? 0;
    const savedBefore = this.storage?.getItem(this.storagePrefix + id);
    const signed = grant || short ? await identity!.sign(code, id, browserName) : undefined;
    if (this.disposed || this.attempts.get(id) !== attempt || (this.epochs.get(id) ?? 0) !== epoch || this.storage?.getItem(this.storagePrefix + id) !== savedBefore)
      throw new TransportError('STALE_CONNECTION', translate("The association changed during signing, so pairing was not submitted."));
    const response = await this.fetcher(address + "/v1/pair", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Workgraph-Protocol": PROTOCOL_VERSION,
        "X-Workgraph-Service-Id": id,
      },
      body: JSON.stringify({ code, browserName, expectedServiceId: id, ...signed }),
    });
    await checkResponse(response);
    const result = (await response.json()) as PairResponse;
    if (
      this.attempts.get(id) !== attempt ||
      (this.epochs.get(id) ?? 0) !== epoch
    )
      throw new TransportError("STALE_CONNECTION", translate("Pairing was superseded by a later operation"));
    if (this.storage?.getItem(this.storagePrefix + id) !== savedBefore)
      throw new TransportError(
        "STALE_CONNECTION",
        translate("Another tab replaced the association. Restore the new session"),
      );
    if (
      result.serviceId !== id ||
      !result.token ||
      !result.session?.id ||
      result.session.state !== "active"
    )
      throw new TransportError("SERVICE_MISMATCH", translate("The pairing response identity is invalid"));
    return this.install(
      {
        serviceId: id,
        runtimeName: runtimeName?.trim() || this.rows.get(id)?.runtimeName,
        address,
        addresses: [
          ...new Set([address, ...(this.rows.get(id)?.addresses ?? [])]),
        ],
        info,
        session: result.session,
        token: result.token,
        status: "paired",
        generation: 0,
      },
      true,
    );
  }
  /** Explicit address adoption verifies identity before sending the credential. */
  async useAddress(serviceId: string, address: string): Promise<Connection> {
    const lease = this.lease(serviceId);
    address = normalizeAddress(address);
    const info = await this.discover(address, serviceId);
    this.assertCurrent(lease);
    const row = this.rows.get(serviceId)!;
    return this.install(
      {
        ...row,
        info,
        address,
        addresses: [...new Set([...row.addresses, address])],
      },
      true,
    );
  }
  /** IDs can be supplied by the app; browser Storage also supports key enumeration. */
  async restore(serviceIds?: string[]): Promise<Connection[]> {
    const storage = this.storage as Storage | null;
    const ids =
      serviceIds ??
      (storage && typeof storage.key === "function"
        ? Array.from({ length: storage.length }, (_, i) => storage.key(i))
            .filter((key): key is string => !!key?.startsWith(this.storagePrefix) && !key.startsWith(this.pendingStoragePrefix))
            .map((key) => key.slice(this.storagePrefix.length))
        : []);
    await Promise.all(
      ids.map(async (id) => {
        const row = this.readSaved(id);
        if (!row) return;
        this.install({ ...row, status: "offline" }, false);
        const lease = this.lease(id);
        try {
          const info = await this.discover(row.address, id);
          this.assertCurrent(lease);
          const response = await this.fetcher(
            normalizeAddress(row.address) + "/v1/session",
            {
              headers: {
                Authorization: `Bearer ${lease.token}`,
                "X-Workgraph-Protocol": PROTOCOL_VERSION,
                "X-Workgraph-Service-Id": id,
              },
              signal: lease.signal,
              credentials: "omit",
              redirect: "error",
              cache: "no-store",
            },
          );
          await checkResponse(response);
          const session = (await response.json()) as Session;
          this.assertCurrent(lease);
          if (session.id !== lease.sessionId || session.state !== "active")
            throw new TransportError("SESSION_EXPIRED", translate("The saved session is invalid"));
          this.install({ ...row, info, session, status: "paired" }, true);
        } catch (error) {
          if (
            error instanceof TransportError &&
            (AUTH_ERRORS.has(error.code) ||
              [
                "SERVICE_MISMATCH",
                "PROTOCOL_INCOMPATIBLE",
                "ORIGIN_DENIED",
              ].includes(error.code))
          )
            this.invalidate(id, lease.generation);
        }
      }),
    );
    return this.list();
  }
  forget(serviceId: string): void {
    const row = this.rows.get(serviceId),
      saved = this.readSaved(serviceId);
    if (row && saved?.token === row.token)
      this.storage?.removeItem(this.storagePrefix + serviceId);
    this.invalidate(serviceId);
    this.attempts.set(serviceId, (this.attempts.get(serviceId) ?? 0) + 1);
    this.epochs.set(serviceId, (this.epochs.get(serviceId) ?? 0) + 1);
    this.rows.delete(serviceId);
    this.emit();
  }
  async revokeSession(serviceId: string, sessionId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(sessionId))
      throw new TransportError("INVALID_REQUEST", translate("Invalid session ID"));
    const lease = this.lease(serviceId);
    const response = await this.fetcher(
      lease.address + "/v1/sessions/" + sessionId,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${lease.token}`,
          "X-Workgraph-Protocol": PROTOCOL_VERSION,
          "X-Workgraph-Service-Id": serviceId,
        },
        signal: lease.signal,
        credentials: "omit",
        redirect: "error",
      },
    );
    await checkResponse(response);
    this.assertCurrent(lease);
    if (sessionId === lease.sessionId) this.forget(serviceId);
  }
  dispose(): void {
    this.disposed = true;
    for (const c of this.controllers.values()) c.abort();
    this.eventTarget?.removeEventListener(
      "storage",
      this.onStorage as EventListener,
    );
    this.listeners.clear();
  }
}
