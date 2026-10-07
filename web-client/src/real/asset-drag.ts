import { randomId } from '../adapter/random';
import type { Point } from '../canvas/geometry';

const assetDragType = 'application/x-openworkgraph-library-asset';
type Context = { request: unknown; projectId: string; graphId: string };
let active: (Context & { token: string; place: (position: Point) => void }) | undefined;

/** Only a live drag from this page may invoke its pinned copy operation. */
export function beginAssetDrag(data: DataTransfer, context: Context, place: (position: Point) => void): () => void {
  const token = randomId();
  data.setData(assetDragType, token);
  data.effectAllowed = 'copy';
  active = { ...context, token, place };
  return () => { if (active?.token === token) active = undefined; };
}
export function canDropAsset(data: DataTransfer, context: Context): boolean {
  return !!active && Array.from(data.types).includes(assetDragType) && active.request === context.request && active.projectId === context.projectId && active.graphId === context.graphId;
}
export function dropAsset(data: DataTransfer, context: Context, position: Point): void {
  if (!canDropAsset(data, context) || data.getData(assetDragType) !== active?.token || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
  const drag = active!;
  active = undefined;
  drag.place(position);
}

