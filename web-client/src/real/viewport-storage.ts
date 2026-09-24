import type { Viewport } from "../canvas/Canvas";

export function viewportStorageKey(temporary: boolean, serviceId: string, projectId: string, graphId: string): string {
  return "openworkgraph:viewport:v1:" + JSON.stringify([temporary, serviceId, projectId, graphId]);
}

export function readViewport(storage: Pick<Storage, "getItem">, key: string): Viewport | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { x, y, k } = value as Record<string, unknown>;
    if ([x, y, k].every(v => typeof v === "number" && Number.isFinite(v)) &&
      (k as number) >= 0.05 && (k as number) <= 5) return { x: x as number, y: y as number, k: k as number };
  } catch { /* Invalid or unavailable browser storage uses the default viewport. */ }
  return undefined;
}

export function saveViewport(storage: Pick<Storage, "setItem">, key: string, viewport: Viewport): void {
  try { storage.setItem(key, JSON.stringify(viewport)); } catch { /* Viewport remains usable without storage. */ }
}
