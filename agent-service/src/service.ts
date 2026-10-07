import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  SERVICE_VERSION,
  isProtocolCompatible,
} from "@openworkgraph/protocol";
import type {
  ErrorCode,
  ErrorResponse,
  PairRequest,
  ServiceInfo,
  ProjectCandidates,
} from "@openworkgraph/protocol";
import { initializeDirectories } from "./directories.js";
import { openDatabase } from "./persistence/database.js";
import { Repositories } from "./persistence/repositories.js";
import { Auth, normalizeOrigin } from "./auth.js";
import { ServiceError } from "./errors.js";
import { readJson } from "./http.js";
import { acceptsHost, listenerInfo } from "./network.js";
import { Projects } from "./projects.js";
import { ProjectProbe } from "./project-probe.js";
import { BusinessApi } from "./api.js";
import { Events } from "./events.js";
import { WorkflowRuntime, type WorkflowRuntimeOptions } from "./runtime.js";
import { compareSemVer, latestAgentServiceVersion } from './operations/update.js';
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  ORIGIN_DENIED: 403,
  HOST_DENIED: 403,
  SERVICE_MISMATCH: 409,
  PROTOCOL_INCOMPATIBLE: 426,
  NOT_FOUND: 404,
  PAIRING_CODE_INVALID: 400,
  PAIRING_CODE_EXPIRED: 410,
  PAIRING_CODE_USED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};
const CORS_HEADERS = [
  "authorization",
  "content-type",
  "x-workgraph-protocol",
  "x-workgraph-service-id",
  "last-event-id",
  "range",
];
export function createService(
  dataDir?: string,
  options: {
    now?: () => number;
    codexHome?: string;
    projectProbe?: ProjectProbe;
    runtime?: WorkflowRuntimeOptions;
    npmInstallation?: () => Promise<boolean>;
    npxInstallation?: () => Promise<boolean>;
    latestNpmVersion?: () => Promise<string>;
    updateRuntime?: (onExit: () => void) => Promise<void>;
  } = {},
) {
  const directories = initializeDirectories(dataDir);
  const db = openDatabase(directories.database);
  let serviceId: string;
  try {
    serviceId = new Repositories(db).identity();
  } catch (error) {
    db.close();
    throw error;
  }
  const auth = new Auth(db, serviceId, options.now);
  const projects = new Projects(db, serviceId);
  const projectProbe = options.projectProbe ?? new ProjectProbe();
  const runtime = new WorkflowRuntime(
    db,
    serviceId,
    directories,
    options.runtime,
  );
  const api = new BusinessApi(db, serviceId, auth, runtime);
  const events = new Events(db, serviceId, auth);
  const instanceId = randomUUID();
  const npmInstallation = options.npmInstallation ?? (async () => false);
  const npxInstallation = options.npxInstallation ?? (async () => false);
  let updateQueued = false;
  const unavailable = {
    status: "unavailable" as const,
    reason: "Not implemented yet",
    verifiedAt: null,
  };
  const info: ServiceInfo = {
    serviceId,
    version: SERVICE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      pairing: {
        status: "available",
        reason: "Local pairing code and persistent revocable sessions",
        verifiedAt: "2026-09-14T00:00:00.000Z",
      },
      projects: unavailable,
      graphs: unavailable,
      assets: unavailable,
      execution: unavailable,
      imageGeneration: {
        status: "unknown",
        reason: "Real image generation has not been verified",
        verifiedAt: null,
      },
      events: unavailable,
      backups: unavailable,
      projectFiles: {
        status: "available",
        reason: "Bounded project file browsing, search, status and content access",
        verifiedAt: "2026-09-17T00:00:00.000Z",
      },
      projectFileReferences: {
        status: "available",
        reason: "Live project file references, detach-on-edit and execution path inputs",
        verifiedAt: "2026-09-17T00:00:00.000Z",
      },
    },
  };
  info.capabilities.projects = {
    status: "available",
    reason:
      "Project registration, state filters and path repair; run submission integration is pending",
    verifiedAt: "2026-09-14T00:00:00.000Z",
  };
  info.capabilities.graphs = {
    status: "available",
    reason: "Persistent graph commands, revisions and input locks",
    verifiedAt: "2026-09-14T00:00:00.000Z",
  };
  info.capabilities.events = {
    status: "available",
    reason: "Authenticated persisted SSE and scoped replay cursors",
    verifiedAt: "2026-09-14T00:00:00.000Z",
  };
  info.capabilities.assets = runtime.capabilities.assets;
  info.capabilities.backups = {
    status: "available",
    reason:
      "Manual consistent backups and authenticated download; restore is local-only",
    verifiedAt: null,
  };
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Vary", "Origin");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Range, Accept-Ranges, Content-Disposition",
    );
    const requestId = randomUUID();
    const send = (body: unknown) => response.end(JSON.stringify(body));
    void (async () => {
      const address = server.address();
      if (
        !address ||
        typeof address === "string" ||
        !acceptsHost(request.headers.host, address)
      )
        throw new ServiceError(
          "HOST_DENIED",
          "Host 请求头无效。",
        );
      const rawPath = request.url ?? "";
      const fileRoute = /^[/]v1[/]projects[/][a-zA-Z0-9_-]+[/]files(?:[/](?:search|content|link-content|media|thumbnail|stat))?(?:[?]|$)/.test(rawPath);
      const skillsRoute = /^[/]v1[/]projects[/][a-zA-Z0-9_-]+[/]skills[/]search(?:[?]|$)/.test(rawPath);
      const skillsManagementRoute = /^[/]v1[/]skills(?:[/][^/?#]+(?:[/](?:install|update|uninstall|config|files))?)?(?:[?]|$)/.test(rawPath);
      const mediaRoute = /^[/]v1[/]projects[/][a-zA-Z0-9_-]+[/](?:assets[/][a-zA-Z0-9_-]+[/]versions[/][1-9][0-9]*|graphs[/][a-zA-Z0-9_-]+[/]resources[/][a-zA-Z0-9_-]+[/]versions[/][1-9][0-9]*)[/](?:thumbnail|preview|content)(?:[?]|$)/.test(rawPath);
      const queryRoute = fileRoute || skillsRoute || skillsManagementRoute || mediaRoute;
      const path = queryRoute ? rawPath.split('?')[0]! : rawPath;
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        (!queryRoute && path.includes("?")) ||
        path.includes("#") ||
        (!skillsManagementRoute && path.includes("%")) ||
        path.includes("\\")
      )
        throw new ServiceError(
          "INVALID_REQUEST",
          "请使用标准 API 路径；凭据只能放在 Authorization 请求头，不能放入 URL。",
        );
      if (queryRoute && (rawPath.includes('#') || rawPath.length > 8192 || rawPath.split('?').length > 2))
        throw new ServiceError('INVALID_REQUEST', '项目文件查询参数无效。');
      const originHeader = request.headers.origin;
      const pairingRequest = ['/v1/pair/request', '/v1/pair/status', '/v1/pair/complete'].includes(path) && (request.method === 'POST' || request.method === 'OPTIONS');
      if (originHeader !== undefined) {
        if (pairingRequest) {
          if (normalizeOrigin(originHeader) !== originHeader) throw new ServiceError('ORIGIN_DENIED', '网页来源无效。');
        } else auth.requireOrigin(originHeader);
        response.setHeader("Access-Control-Allow-Origin", originHeader);
      }
      if (request.method === "OPTIONS") {
        if (!pairingRequest) auth.requireOrigin(originHeader);
        else if (!originHeader || request.headers['access-control-request-method'] !== 'POST') throw new ServiceError('ORIGIN_DENIED', '配对申请仅允许 POST。');
        const method = request.headers["access-control-request-method"];
        const headers = String(
          request.headers["access-control-request-headers"] ?? "",
        )
          .toLowerCase()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const allowedMethods = /^[/]v1[/]skills[/][^/]+[/]config$/.test(path) ? ["GET", "POST", "PUT", "DELETE"] : ["GET", "POST", "DELETE"];
        if (
          typeof method !== "string" ||
          !allowedMethods.includes(method) ||
          headers.some((header) => !CORS_HEADERS.includes(header))
        )
          throw new ServiceError(
            "ORIGIN_DENIED",
            "不允许的跨来源方法或请求头。",
          );
        response.setHeader("Access-Control-Allow-Methods", allowedMethods.join(", "));
        response.setHeader(
          "Access-Control-Allow-Headers",
          CORS_HEADERS.join(", "),
        );
        response.setHeader("Access-Control-Max-Age", "300");
        response.writeHead(204);
        response.end();
        return;
      }
      const protocol = request.headers["x-workgraph-protocol"];
      if (
        protocol !== undefined &&
        (typeof protocol !== "string" || !isProtocolCompatible(protocol))
      )
        throw new ServiceError(
          "PROTOCOL_INCOMPATIBLE",
          "请使用协议 1.x 的客户端。",
        );
      const expectedService = request.headers["x-workgraph-service-id"];
      if (expectedService !== undefined && expectedService !== serviceId)
        throw new ServiceError(
          "SERVICE_MISMATCH",
          "地址对应其他服务，请核对 serviceId；不会自动接管该服务的数据。",
        );
      if (request.method === "GET" && path === "/health") {
        send({
          status: "ok",
          version: SERVICE_VERSION,
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }
      if (request.method === "GET" && path === "/v1/info") {
        const runtimeInfo=runtime.serviceInfo;
        send({
          ...info,
          installation: await npmInstallation() ? 'npm-global' : await npxInstallation() ? 'npx' : 'other',
          imageRoutes:runtimeInfo.imageRoutes,
          capabilities: {
            ...info.capabilities,
            assets: runtime.capabilities.assets,
            execution: runtime.executionCapability,
            imageGeneration: runtime.imageGenerationCapability,
          },
        });
        return;
      }
      if (request.method === 'POST' && path === '/v1/pair/request') {
        if (!originHeader || !protocol) throw new ServiceError('INVALID_REQUEST', '配对申请缺少来源或协议版本。');
        const input = await readJson(request);
        if (Object.keys(input).some(key => key !== 'clientCode') || typeof input.clientCode !== 'string') throw new ServiceError('INVALID_REQUEST', '配对申请必须包含客户端公钥。');
        send(auth.requestClientPairing(input.clientCode, originHeader));
        return;
      }
      if (request.method === 'POST' && path === '/v1/pair/status') {
        if (!originHeader || !protocol) throw new ServiceError('INVALID_REQUEST', '配对状态请求缺少来源或协议版本。');
        const input = await readJson(request);
        if (Object.keys(input).some(key => !['code', 'browserName', 'expectedServiceId', 'clientCode', 'proof'].includes(key))) throw new ServiceError('INVALID_REQUEST', '配对状态请求包含未知字段。');
        send(auth.claimClientPairing(input as unknown as PairRequest, originHeader));
        return;
      }
      if (request.method === 'POST' && path === '/v1/pair/complete') {
        if (!originHeader || !protocol) throw new ServiceError('INVALID_REQUEST', '配对完成请求缺少来源或协议版本。');
        const input = await readJson(request);
        if (Object.keys(input).some(key => !['code', 'expectedServiceId'].includes(key)) || typeof input.code !== 'string' || typeof input.expectedServiceId !== 'string')
          throw new ServiceError('INVALID_REQUEST', '配对完成请求无效。');
        const bearer = request.headers.authorization;
        if (!bearer?.startsWith('Bearer ')) throw new ServiceError('UNAUTHENTICATED', '配对完成请求缺少通讯凭据。');
        send(auth.completeClientPairing(input.code, input.expectedServiceId, bearer.slice(7), originHeader));
        return;
      }
      const origin = auth.requireOrigin(originHeader);
      if (!protocol)
        throw new ServiceError(
          "PROTOCOL_INCOMPATIBLE",
          "业务请求必须携带 X-Workgraph-Protocol: 1.0。",
        );
      if (expectedService !== serviceId)
        throw new ServiceError(
          "SERVICE_MISMATCH",
          "业务请求必须携带 X-Workgraph-Service-Id。",
        );
      if (request.method === "POST" && path === "/v1/pair") {
        const input = await readJson(request);
        if (
          Object.keys(input).some(
            (key) =>
              !["code", "browserName", "expectedServiceId", "clientCode", "proof"].includes(key),
          )
        )
          throw new ServiceError("INVALID_REQUEST", "配对请求包含未知字段。");
        send(auth.pair(input as unknown as PairRequest, origin));
        return;
      }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer "))
        throw new ServiceError(
          "UNAUTHENTICATED",
          "请提供 Authorization: Bearer 会话凭据。",
        );
      const token = authorization.slice(7);
      if (request.method === 'POST' && path === '/v1/runtime/update') {
        auth.withSession(token, origin, () => undefined);
        if (!await npmInstallation() || !options.updateRuntime)
          throw new ServiceError('INVALID_REQUEST', 'This Runtime was not installed globally with npm.');
        if (updateQueued) throw new ServiceError('INVALID_REQUEST', 'Runtime update is already starting.');
        updateQueued = true;
        let latestVersion: string;
        try {
          latestVersion = await (options.latestNpmVersion ?? latestAgentServiceVersion)();
          if (compareSemVer(latestVersion, SERVICE_VERSION) <= 0)
            throw new ServiceError('INVALID_REQUEST', 'No newer npm Runtime version is available.');
          auth.withSession(token, origin, () => undefined);
          await options.updateRuntime(() => { updateQueued = false; });
          response.statusCode = 202;
          send({ accepted: true, latestVersion });
          return;
        }
        catch (error) { updateQueued = false; throw error; }
      }
      if (request.method === "GET" && path === "/v1/events/cursor") {
        send(events.currentCursor(token, origin));
        return;
      }
      if (request.method === "GET" && path === "/v1/events") {
        events.stream(request, response, token, origin);
        return;
      }
      const business = await api.handle(request, fileRoute || skillsRoute || skillsManagementRoute ? rawPath : path, token, origin);
      if (business.handled) {
        const body = auth.withSession(
          token,
          origin,
          (current) =>
            business.binary ?? (business.binaryParts ? undefined : events.decorate(business.body, current.id)),
        );
        if (business.status) response.statusCode = business.status;
        for (const [key, value] of Object.entries(business.headers ?? {}))
          response.setHeader(key, value);
        if (business.binaryParts) {
          const disconnected = new AbortController();
          const abort = () => disconnected.abort();
          response.once('close', abort);
          try {
            for (const part of business.binaryParts) {
              for (let offset = 0; offset < part.length; offset += 1024 * 1024) {
                if (!response.write(part.subarray(offset, offset + 1024 * 1024)))
                  await once(response, 'drain', { signal: disconnected.signal });
              }
            }
            response.end();
          } finally { response.off('close', abort); }
        }
        else if (business.binary) response.end(body);
        else send(body);
        return;
      }
      // Authenticate before reading request data; recheck after the asynchronous body read.
      let projectInput: Record<string, unknown> | undefined;
      if (
        request.method === "POST" &&
        (path === "/v1/projects" ||
          /^[/]v1[/]projects[/][0-9a-f-]{36}[/](state|path)$/.test(path))
      ) {
        auth.withSession(token, origin, () => undefined);
        projectInput = await readJson(request);
      }
      let projectView = projects;
      let candidates: ProjectCandidates | undefined;
      let projectListSnapshot: string | undefined;
      const listState =
        path === "/v1/projects/inactive"
          ? "inactive"
          : path === "/v1/projects/all"
            ? "all"
            : "active";
      const listRows = () =>
        db
          .prepare(
            "SELECT id,canonical_path,state FROM projects WHERE ?='all' OR state=? ORDER BY id",
          )
          .all(listState, listState);
      const unprobed = () => {
        throw new Error("Directory availability has not been probed");
      };
      if (request.method === "GET" && path === "/v1/project-candidates") {
        auth.withSession(token, origin, () => undefined);
        candidates = await projectProbe.discover(options.codexHome);
      } else if (
        projectInput ||
        (request.method === "GET" &&
          [
            "/v1/projects",
            "/v1/projects/inactive",
            "/v1/projects/all",
          ].includes(path))
      ) {
        if (projectInput && path.endsWith("/state")) {
          // A stalled old mount must never prevent deactivation/reactivation.
          projectView = new Projects(db, serviceId, unprobed);
        } else {
          const paths = auth.withSession(token, origin, () => {
            if (projectInput)
              return typeof projectInput["path"] === "string"
                ? [projectInput["path"]]
                : [];
            const rows = listRows();
            projectListSnapshot = JSON.stringify(rows);
            return rows.map((row) => String(row["canonical_path"]));
          });
          try {
            projectView = new Projects(
              db,
              serviceId,
              await projectProbe.inspect(paths),
            );
          } catch (error) {
            if (projectInput) throw error;
            // Metadata remains readable when mounted storage does not respond.
            projectView = new Projects(db, serviceId, unprobed);
          }
        }
      }
      // All nonpublic routes, including future media/event paths, pass this gate.
      const result = auth.withSession(token, origin, (current) => {
        if (
          projectListSnapshot !== undefined &&
          projectListSnapshot !== JSON.stringify(listRows())
        )
          throw new ServiceError(
            "CONFLICT",
            "项目列表在探测期间变化，请刷新后重试。",
          );
        if (request.method === "GET" && path === "/v1/project-candidates")
          return candidates;
        if (request.method === "GET" && path === "/v1/projects")
          return projectView.list("active");
        if (request.method === "GET" && path === "/v1/projects/inactive")
          return projectView.list("inactive");
        if (request.method === "GET" && path === "/v1/projects/all")
          return projectView.list("all");
        const projectMatch =
          /^[/]v1[/]projects[/]([0-9a-f-]{36})[/](state|path)$/.exec(path);
        if (projectInput) {
          const field = projectMatch?.[2] === "state" ? "state" : "path";
          if (
            Object.keys(projectInput).length !== 1 ||
            typeof projectInput[field] !== "string"
          )
            throw new ServiceError(
              "INVALID_REQUEST",
              "项目请求须只包含指定的 path 或 state 字段。",
            );
          if (path === "/v1/projects")
            return projectView.register(projectInput[field] as string);
          if (projectMatch?.[2] === "path")
            return projectView.repairPath(
              projectMatch[1]!,
              projectInput[field] as string,
            );
          if (projectMatch?.[2] === "state") {
            const state = projectInput["state"];
            if (state !== "active" && state !== "inactive")
              throw new ServiceError(
                "INVALID_REQUEST",
                "项目状态必须是 active 或 inactive。",
              );
            return projectView.setState(projectMatch[1]!, state);
          }
        }
        if (request.method === "GET" && path === "/v1/session") return current;
        if (request.method === "GET" && path === "/v1/sessions")
          return auth.list(current.id);
        const match = /^[/]v1[/]sessions[/]([0-9a-f-]{36})$/.exec(path);
        if (request.method === "DELETE" && match) {
          auth.revoke(match[1]!);
          return null;
        }
        throw new ServiceError("NOT_FOUND", "接口尚未实现。");
      });
      if (result === null) {
        response.writeHead(204);
        response.end();
      } else send(result);
    })().catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      const code: ErrorCode =
        error instanceof ServiceError ? error.code : "INTERNAL_ERROR";
      const body: ErrorResponse = {
        error: {
          code,
          message:
            error instanceof ServiceError
              ? error.message
              : "服务内部错误，请检查本机服务状态。",
          requestId,
          retryable: error instanceof ServiceError && error.retryable,
          ...(error instanceof ServiceError && error.details !== undefined ? { details: error.details } : {}),
        },
      };
      const projectStatus = {
        CONFLICT: 409,
        ACTIVE_RUN: 409,
        PROJECT_INACTIVE: 409,
        PROJECT_UNAVAILABLE: 409,
        REVISION_CONFLICT: 409,
        NODE_LOCKED: 409,
        INVALID_EDGE: 400,
        INPUT_BLOCKED: 409,
        INPUT_BUDGET_EXCEEDED: 413,
        IDEMPOTENCY_CONFLICT: 409,
        PLUGIN_UNAVAILABLE: 409,
        MODEL_UNAVAILABLE: 409,
        ALREADY_HANDLED: 409,
        CURSOR_EXPIRED: 409,
        MAINTENANCE: 503,
        NOT_IMPLEMENTED: 501,
      } as Partial<Record<ErrorCode, number>>;
      response.writeHead(HTTP_STATUS[code] ?? projectStatus[code] ?? 500);
      send(body);
      request.resume();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("listening", () => {
    const address = server.address() as AddressInfo;
    db.prepare(
      "INSERT INTO settings(key,value) VALUES('listener',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify(listenerInfo(address, serviceId, instanceId)));
  });
  let closing: Promise<void> | undefined;
  async function closeHttpServer(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      // Runs and event streams have already drained. A browser's unfinished
      // request must not hold the service's lifetime locks indefinitely.
      const timeout = setTimeout(() => server.closeAllConnections(), 1000);
      timeout.unref();
      server.close(error => {
        clearTimeout(timeout);
        if (error) reject(error); else resolve();
      });
    });
  }
  async function abortStartup(): Promise<void> {
    runtime.disposeUnstarted();
    projectProbe.close();
    events.close();
    try {
      await closeHttpServer();
    } finally {
      db.close();
    }
  }
  function close(): Promise<void> {
    closing ??= (async () => {
      await runtime.drain();
      runtime.close();
      projectProbe.close();
      events.close();
      try {
        await closeHttpServer();
        db.prepare(
          "DELETE FROM settings WHERE key='listener' AND json_extract(value,'$.instanceId')=?",
        ).run(instanceId);
      } finally {
        db.close();
      }
    })();
    return closing;
  }
  return {
    server,
    db,
    directories,
    info,
    auth,
    projects,
    api,
    events,
    runtime,
    instanceId,
    close,
    abortStartup,
  };
}
