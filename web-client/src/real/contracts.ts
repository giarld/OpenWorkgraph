export type {
  GraphSnapshot,
  GraphOperation,
  Node,
  Json,
  Run,
  RunNotification,
  Project,
  ServiceInfo,
  ModelDefaults,
  Interaction,
} from "../../../packages/protocol/src/index";
export type Request = <T>(
  path: string,
  body?: unknown,
  method?: string,
  options?: { journal?: "session" | "memory"; range?: { start: number; end: number } },
) => Promise<T>;
export const graphPath = (projectId: string, graphId: string) =>
  `/v1/projects/${encodeURIComponent(projectId)}/graphs/${encodeURIComponent(graphId)}`;
export const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
