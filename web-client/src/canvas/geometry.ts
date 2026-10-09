export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Point, Size {}
export interface Viewport extends Point {
  k: number;
}
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 5;
export function clampZoom(k: number): number {
  return Number.isNaN(k) ? 1 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}
export function screenToWorld(p: Point, v: Viewport): Point {
  return { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
}
export function worldToScreen(p: Point, v: Viewport): Point {
  return { x: p.x * v.k + v.x, y: p.y * v.k + v.y };
}
export function zoomAt(v: Viewport, pointer: Point, scale: number): Viewport {
  const world = screenToWorld(pointer, v),
    k = clampZoom(scale);
  return { x: pointer.x - world.x * k, y: pointer.y - world.y * k, k };
}
export function normalizeWheelDelta(
  delta: number,
  deltaMode = 0,
  pageSize = 800,
): number {
  return delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageSize : 1);
}
/** Reference infinite-canvas.tsx wheel law; sensitivity scales the normalized delta. */
export function wheelZoom(
  v: Viewport,
  p: Point,
  deltaY: number,
  deltaMode = 0,
  pageHeight = 800,
  sensitivity = 1,
): Viewport {
  const pixels = normalizeWheelDelta(deltaY, deltaMode, pageHeight);
  return zoomAt(v, p, v.k * Math.pow(1.1, -pixels * sensitivity / 100));
}
export function wheelPan(
  v: Viewport,
  deltaX: number,
  deltaY: number,
  deltaMode = 0,
  pageSize: Size = { width: 1000, height: 800 },
): Viewport {
  return {
    x: v.x - normalizeWheelDelta(deltaX, deltaMode, pageSize.width),
    y: v.y - normalizeWheelDelta(deltaY, deltaMode, pageSize.height),
    k: v.k,
  };
}
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}
export function boundsOf(rects: Rect[], padding = 0): Rect {
  if (!rects.length) return { x: -500, y: -500, width: 1000, height: 1000 };
  const x = Math.min(...rects.map((r) => r.x)) - padding,
    y = Math.min(...rects.map((r) => r.y)) - padding;
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) + padding - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) + padding - y,
  };
}
export function centerOn(point: Point, size: Size, k: number): Viewport {
  k = clampZoom(k);
  return {
    x: size.width / 2 - point.x * k,
    y: size.height / 2 - point.y * k,
    k,
  };
}
export function fitBounds(bounds: Rect, size: Size, padding = 64): Viewport {
  const k = clampZoom(
    Math.min(
      Math.max(1, size.width - padding * 2) / Math.max(1, bounds.width),
      Math.max(1, size.height - padding * 2) / Math.max(1, bounds.height),
    ),
  );
  return centerOn(
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    size,
    k,
  );
}
export function viewportRect(v: Viewport, size: Size): Rect {
  return {
    ...screenToWorld({ x: 0, y: 0 }, v),
    width: size.width / v.k,
    height: size.height / v.k,
  };
}
export function connectionPath(from: Point, to: Point, direction: 'horizontal' | 'vertical' = 'horizontal'): string {
  if (direction === 'vertical') {
    const curve = Math.max(Math.abs(to.y - from.y) * 0.5, 50);
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + curve}, ${to.x} ${to.y - curve}, ${to.x} ${to.y}`;
  }
  const curve = Math.max(Math.abs(to.x - from.x) * 0.5, 50);
  return `M ${from.x} ${from.y} C ${from.x + curve} ${from.y}, ${to.x - curve} ${to.y}, ${to.x} ${to.y}`;
}
export function outputPort(node: Rect): Point {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}
export function inputPort(node: Rect): Point {
  return { x: node.x, y: node.y + node.height / 2 };
}
export function chainOutputPort(node: Rect): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height };
}
export function chainInputPort(node: Rect): Point {
  return { x: node.x + node.width / 2, y: node.y };
}
export function resizeBy(
  size: Size,
  delta: Point,
  zoom: number,
  minimum: Size = { width: 220, height: 160 },
): Size {
  return {
    width: Math.max(minimum.width, size.width + delta.x / zoom),
    height: Math.max(minimum.height, size.height + delta.y / zoom),
  };
}
export type ResizeCorner = "nw" | "ne" | "sw" | "se";
/** Opposite corner remains fixed; media uses the reference dominant-axis ratio rule. */
export function resizeRect(
  rect: Rect,
  delta: Point,
  zoom: number,
  corner: ResizeCorner,
  keepRatio = false,
  minimum: Size = { width: 220, height: 160 },
  snapGrid?: number,
): Rect {
  const dx = delta.x / zoom,
    dy = delta.y / zoom,
    left = corner.includes("w"),
    top = corner.includes("n");
  let width = Math.max(minimum.width, rect.width + (left ? -dx : dx)),
    height = Math.max(minimum.height, rect.height + (top ? -dy : dy));
  if (keepRatio) {
    const ratio = rect.width / Math.max(1, rect.height);
    if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio;
    else width = height * ratio;
    if (height < minimum.height) {
      height = minimum.height;
      width = height * ratio;
    }
    if (width < minimum.width) {
      width = minimum.width;
      height = width / ratio;
    }
  }
  if (snapGrid && snapGrid > 0) {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    // Snap the dragged edge in world coordinates, preserving the opposite corner.
    const snapSize = (size: number, fixed: number, negative: boolean, min: number) => {
      const edge = Math.round((fixed + (negative ? -size : size)) / snapGrid) * snapGrid;
      const limit = negative
        ? Math.floor((fixed - min) / snapGrid) * snapGrid
        : Math.ceil((fixed + min) / snapGrid) * snapGrid;
      return negative ? fixed - Math.min(edge, limit) : Math.max(edge, limit) - fixed;
    };
    const ratio = rect.width / Math.max(1, rect.height);
    if (!keepRatio || Math.abs(dx) >= Math.abs(dy)) {
      width = snapSize(width, left ? right : rect.x, left,
        keepRatio ? Math.max(minimum.width, minimum.height * ratio) : minimum.width);
    }
    if (!keepRatio || Math.abs(dx) < Math.abs(dy)) {
      height = snapSize(height, top ? bottom : rect.y, top,
        keepRatio ? Math.max(minimum.height, minimum.width / ratio) : minimum.height);
    }
    if (keepRatio) {
      if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio;
      else width = height * ratio;
    }
  }
  return {
    x: left ? rect.x + rect.width - width : rect.x,
    y: top ? rect.y + rect.height - height : rect.y,
    width,
    height,
  };
}
