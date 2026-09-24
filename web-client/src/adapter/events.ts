import { translate } from "../i18n/translate";
import type { ServiceEvent } from "../../../packages/protocol/src/index";
import { AUTH_ERRORS, TransportError } from "./connections";
import type { ConnectionLease } from "./connections";
import { Transport } from "./transport";
export interface SSEFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}
/** Incremental UTF-8 SSE: CR/LF/CRLF, comments, multiline data and BOM. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    size = 0,
    event = "",
    id: string | undefined,
    retry: number | undefined;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 2 * 1024 * 1024)
        throw new TransportError("INVALID_EVENT", translate("The event buffer is too large"));
      let match: RegExpExecArray | null;
      while ((match = /[\r\n]/.exec(buffer))) {
        const position = match.index;
        if (
          buffer[position] === "\r" &&
          position === buffer.length - 1 &&
          !chunk.done
        )
          break;
        const line = buffer.slice(0, position);
        buffer = buffer.slice(
          position + (buffer.slice(position, position + 2) === "\r\n" ? 2 : 1),
        );
        if (line === "") {
          if (data.length)
            yield {
              event: event || "message",
              data: data.join("\n"),
              id,
              retry,
            };
          data = [];
          size = 0;
          event = "";
          id = undefined;
          retry = undefined;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"),
          field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") {
          data.push(value);
          size += value.length;
        } else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "retry" && /^\d+$/.test(value))
          retry = Number(value);
        if (size > 2 * 1024 * 1024)
          throw new TransportError("INVALID_EVENT", translate("The event buffer is too large"));
      }
      if (chunk.done) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export interface EventHandlers {
  onEvent(event: ServiceEvent): void | Promise<void>;
  /** Apply authoritative snapshots before returning their service/session cursor. */
  reloadSnapshot(): Promise<string>;
  onError?(error: unknown): void;
  onStatus?(
    status: "connecting" | "connected" | "reconnecting" | "stopped",
  ): void;
}
export interface EventOptions {
  cursor?: string;
  reconnectMs?: number;
  maxReconnectMs?: number;
}
export interface ServiceEventHandlers extends Omit<
  EventHandlers,
  "reloadSnapshot"
> {
  onCursorExpired(): Promise<string>;
}
export class EventSubscription {
  private controller?: AbortController;
  private task?: Promise<void>;
  private lease?: ConnectionLease;
  private cursor: string;
  private seen = new Set<string>();
  private connected = false;
  private reconnectRequested = false;
  private attemptController?: AbortController;
  private wakeDelay?: () => void;
  constructor(
    readonly transport: Transport,
    readonly serviceId: string,
    readonly handlers: EventHandlers,
    readonly options: EventOptions = {},
  ) {
    if (transport.serviceId !== serviceId)
      throw new TransportError(
        "SERVICE_MISMATCH",
        translate("The event Runtime does not match the Transport Runtime"),
      );
    this.cursor = options.cursor ?? "";
  }
  get lastEventId(): string {
    return this.cursor;
  }
  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const reconnect = () => {
      if (controller.signal.aborted) return;
      this.reconnectRequested = true;
      this.attemptController?.abort();
      this.wakeDelay?.();
    };
    const offline = () => {
      this.connected = false;
      try { if (this.lease) this.transport.registry.setEventConnected(this.lease, false); } catch { /* Owner already ended. */ }
      reconnect();
    };
    const unsubscribe = this.transport.registry.subscribe(() => {
      const row = this.transport.registry.get(this.serviceId);
      if (this.connected && row?.generation === this.lease?.generation && row?.status === 'offline') {
        this.connected = false;
        reconnect();
      }
    });
    const network = typeof window === 'undefined' ? undefined : window;
    network?.addEventListener('online', reconnect);
    network?.addEventListener('offline', offline);
    this.task = this.run(controller)
      .catch((error) => this.handlers.onError?.(error))
      .finally(() => {
        unsubscribe();
        network?.removeEventListener('online', reconnect);
        network?.removeEventListener('offline', offline);
        this.connected = false;
        if (this.controller === controller) {
          this.controller = undefined;
          this.handlers.onStatus?.("stopped");
        }
      });
  }
  async stop(): Promise<void> {
    if (this.controller) {
      this.controller.abort();
      try {
        if (this.lease)
          this.transport.registry.setEventConnected(this.lease, false);
      } catch {
        /* Already invalidated; never change a replacement connection. */
      }
    }
    await this.task;
  }
  private async run(controller: AbortController): Promise<void> {
    const lease = this.transport.registry.lease(this.serviceId);
    this.lease = lease;
    const signal = AbortSignal.any([controller.signal, lease.signal]);
    this.transport.registry.setEventConnected(lease, false);
    let delay = this.options.reconnectMs ?? 1000,
      reload = false;
    while (!signal.aborted) {
      const attempt = new AbortController();
      this.attemptController = attempt;
      const requestSignal = AbortSignal.any([signal, attempt.signal]);
      if (this.reconnectRequested) { reload = true; this.reconnectRequested = false; delay = this.options.reconnectMs ?? 1000; }
      try {
        this.transport.registry.assertCurrent(lease);
        if (reload) {
          const cursor = await this.handlers.reloadSnapshot();
          this.transport.registry.assertCurrent(lease);
          if (signal.aborted) return;
          if (!cursor)
            throw new TransportError(
              "CURSOR_EXPIRED",
              translate("The snapshot did not return a new event cursor"),
            );
          this.cursor = cursor;
          this.seen.clear();
          reload = false;
        }
        this.handlers.onStatus?.("connecting");
        const { response } = await this.transport.open("/v1/events", {
          signal: requestSignal,
          cursor: this.cursor,
          accept: "text/event-stream",
        });
        if (
          !response.body ||
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        )
          throw new TransportError("INVALID_EVENT", translate("The Runtime did not return an SSE stream"));
        this.handlers.onStatus?.("connected");
        this.transport.registry.setEventConnected(lease, true);
        this.connected = true;
        for await (const frame of parseSSE(response.body, requestSignal)) {
          if (requestSignal.aborted) break;
          this.transport.registry.assertCurrent(lease);
          if (frame.event === "stream-error") {
            const error = JSON.parse(frame.data);
            throw new TransportError(
              error.code ?? "INVALID_EVENT",
              translate("The Runtime terminated the event stream"),
            );
          }
          if (frame.event !== "workgraph") continue;
          const event = JSON.parse(frame.data) as ServiceEvent;
          this.validate(event, frame, lease);
          if (!this.seen.has(event.eventId)) {
            await this.handlers.onEvent(event);
            this.transport.registry.assertCurrent(lease);
            if (signal.aborted) return;
            this.seen.add(event.eventId);
            if (this.seen.size > 2048)
              this.seen.delete(this.seen.values().next().value!);
          }
          this.cursor = event.cursor;
          delay = this.options.reconnectMs ?? 1000;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!attempt.signal.aborted) {
        this.handlers.onError?.(error);
        if (error instanceof SyntaxError) reload = true;
        if (error instanceof TransportError) {
          if (AUTH_ERRORS.has(error.code)) {
            this.transport.registry.invalidate(
              this.serviceId,
              lease.generation,
            );
            return;
          }
          if (
            [
              "STALE_CONNECTION",
              "SERVICE_MISMATCH",
              "PROTOCOL_INCOMPATIBLE",
              "ORIGIN_DENIED",
            ].includes(error.code)
          )
            return;
          if (
            ["CURSOR_EXPIRED", "INVALID_REQUEST", "INVALID_EVENT"].includes(
              error.code,
            )
          )
            reload = true;
        }
        }
      }
      if (signal.aborted) return;
      this.connected = false;
      this.transport.registry.setEventConnected(lease, false);
      this.handlers.onStatus?.("reconnecting");
      if (this.reconnectRequested) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          if (this.wakeDelay === done) this.wakeDelay = undefined;
          resolve();
        };
        const timer = setTimeout(done, delay);
        this.wakeDelay = done;
        signal.addEventListener("abort", done, { once: true });
      });
      delay = Math.min(delay * 2, this.options.maxReconnectMs ?? 30000);
    }
  }
  private validate(
    event: ServiceEvent,
    frame: SSEFrame,
    lease: ConnectionLease,
  ): void {
    if (!event || event.serviceId !== lease.serviceId)
      throw new TransportError("SERVICE_MISMATCH", translate("Ignoring an event from another Runtime"));
    if (
      typeof event.eventId !== "string" ||
      !event.eventId ||
      typeof event.cursor !== "string" ||
      event.cursor !== frame.id ||
      typeof event.type !== "string" ||
      !Number.isSafeInteger(event.revision)
    )
      throw new TransportError("INVALID_EVENT", translate("The event format is invalid"));
    try {
      const cursor = JSON.parse(
        atob(event.cursor.replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 3 ||
        cursor[0] !== lease.serviceId ||
        cursor[1] !== lease.sessionId ||
        !/^\d+$/.test(cursor[2])
      )
        throw new Error();
    } catch {
      throw new TransportError("INVALID_EVENT", translate("The event cursor does not belong to the current session"));
    }
    if (
      event.type === "session.revoked" &&
      event.entityId === lease.sessionId
    ) {
      this.transport.registry.invalidate(lease.serviceId, lease.generation);
      throw new TransportError("SESSION_REVOKED", translate("The current session has been revoked"));
    }
  }
}
export class ServiceEventStream extends EventSubscription {
  constructor(
    transport: Transport,
    handlers: ServiceEventHandlers,
    options: EventOptions = {},
  ) {
    super(
      transport,
      transport.serviceId,
      { ...handlers, reloadSnapshot: handlers.onCursorExpired },
      options,
    );
  }
}
