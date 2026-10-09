import type { Point, Rect } from './geometry';

export const GRID_SIZE = 48;

/** Primary-modifier movement uses half-grid steps without sticky neighbor alignment. */
export function snapNodeMove(anchor: Rect, delta: Point): Point {
  const raw = { x: anchor.x + delta.x, y: anchor.y + delta.y };
  const step = GRID_SIZE / 2;
  const position = { x: Math.round(raw.x / step) * step, y: Math.round(raw.y / step) * step };
  return { x: position.x - anchor.x, y: position.y - anchor.y };
}
