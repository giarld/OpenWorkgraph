import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Json, ServiceEvent } from "@openworkgraph/protocol";
import { Auth } from "./auth.js";
import { ServiceError } from "./errors.js";
import { atomic } from "./persistence/database.js";
export class Events {
  private readonly closers = new Map<() => void, string>();
  constructor(
    readonly db: DatabaseSync,
    readonly serviceId: string,
    readonly auth: Auth,
  ) {}
  connectedClientCount(): number {
    return new Set(this.closers.values()).size;
  }
  watermark(): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n",
        )
        .get()!["n"],
    );
  }
  cursor(sessionId: string, sequence: number | string): string {
    return Buffer.from(
      JSON.stringify([this.serviceId, sessionId, String(sequence)]),
    ).toString("base64url");
  }
  /** Capture before reading lists: authenticate and read the watermark in one transaction. */
  currentCursor(token: string, origin: string): { cursor: string } {
    return this.auth.withSession(token, origin, (session) => ({
      cursor: this.cursor(session.id, this.watermark()),
    }));
  }
  decode(sessionId: string, cursor?: string): number {
    if (!cursor) return 0;
    try {
      const value: unknown = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== this.serviceId ||
        value[1] !== sessionId ||
        typeof value[2] !== "string" ||
        !/^\d+$/.test(value[2])
      )
        throw new Error();
      const n = Number(value[2]);
      if (!Number.isSafeInteger(n)) throw new Error();
      return n;
    } catch {
      throw new ServiceError(
        "INVALID_REQUEST",
        "事件游标不属于当前服务/会话或格式无效，请重读快照。",
      );
    }
  }
  replay(sessionId: string, sequence: number, limit = 256): ServiceEvent[] {
    return atomic(this.db, () => {
      const floor = Number(
        JSON.parse(
          String(
            this.db
              .prepare("SELECT value FROM settings WHERE key='eventFloor'")
              .get()?.["value"] ?? "0",
          ),
        ),
      );
      if (sequence < floor)
        throw new ServiceError(
          "CURSOR_EXPIRED",
          "事件游标已过期，请读取权威快照后重新订阅。",
        );
      if (sequence > this.watermark())
        throw new ServiceError("INVALID_REQUEST", "事件游标超过当前水位。");
      return this.db
        .prepare(
          "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(sequence, limit)
        .map((row) => ({
          serviceId: this.serviceId,
          cursor: this.cursor(sessionId, String(row["sequence"])),
          eventId: String(row["id"]),
          type: row["type"] as ServiceEvent["type"],
          projectId: row["project_id"] as string | null,
          graphId: row["graph_id"] as string | null,
          entityId: String(row["entity_id"]),
          revision: Number(row["revision"]),
          occurredAt: String(row["occurred_at"]),
          payload: JSON.parse(String(row["payload"])) as Json,
        }));
    });
  }
  decorate(value: unknown, sessionId: string): unknown {
    if (Array.isArray(value))
      return value.map((v) => this.decorate(v, sessionId));
    if (value && typeof value === "object" && "eventCursor" in value) {
      const row = value as Record<string, unknown>;
      return {
        ...row,
        eventCursor: this.cursor(sessionId, String(row["eventCursor"])),
      };
    }
    return value;
  }
  stream(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    origin: string,
  ): void {
    const session = this.auth.withSession(token, origin, (current) => current);
    let sequence = this.decode(
      session.id,
      request.headers["last-event-id"] as string | undefined,
    );
    this.replay(session.id, sequence);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    let stopped = false;
    let lastHeartbeat = 0;
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.closers.delete(close);
      response.end();
    };
    const flush = () => {
      if (stopped || response.destroyed) {
        close();
        return;
      }
      try {
        this.auth.assertActive(token, origin);
        if (response.writableLength > 1024 * 1024) {
          close();
          return;
        }
        for (const event of this.replay(session.id, sequence)) {
          this.auth.assertActive(token, origin);
          response.write(
            "id: " +
              event.cursor +
              "\nevent: workgraph\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          );
          sequence = this.decode(session.id, event.cursor);
        }
        if (Date.now() - lastHeartbeat > 5000) {
          this.auth.assertActive(token, origin);
          response.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
      } catch (error) {
        if (!response.destroyed) {
          response.write(
            "event: stream-error\ndata: " +
              JSON.stringify({
                code:
                  error instanceof ServiceError ? error.code : "INTERNAL_ERROR",
                reloadSnapshot: true,
              }) +
              "\n\n",
          );
        }
        close();
      }
    };
    const timer = setInterval(flush, 100);
    timer.unref();
    this.closers.set(close, session.id);
    response.on("close", close);
    flush();
  }
  close(): void {
    for (const close of [...this.closers.keys()]) close();
  }
}
