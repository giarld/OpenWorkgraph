import { randomId } from '../adapter/random';
import type { Point } from '../canvas/geometry';

const type = 'application/x-openworkgraph-project-file';
let active: { token: string; projectId: string; relativePath: string; place: (position?: Point) => void } | undefined;
export function beginProjectFileDrag(data: DataTransfer, projectId: string, relativePath: string, place: (position?: Point) => void): () => void {
  const token = randomId(); data.setData(type, token); data.effectAllowed = 'copy'; active = { token, projectId, relativePath, place };
  return () => { if (active?.token === token) active = undefined; };
}
export function canDropProjectFile(data: DataTransfer, projectId: string): boolean { return !!active && active.projectId === projectId && Array.from(data.types).includes(type); }
export function takeProjectFileDrag(data: DataTransfer, projectId: string): string | undefined {
  if (!canDropProjectFile(data, projectId) || data.getData(type) !== active?.token) return;
  const relativePath = active!.relativePath;
  active = undefined;
  return relativePath;
}
export function dropProjectFile(data: DataTransfer, projectId: string, position: Point, targetNodeId?: string, associate?: (nodeId: string, relativePath: string) => void): void {
  if (!canDropProjectFile(data, projectId) || data.getData(type) !== active?.token) return;
  const drag = active!; active = undefined;
  if (targetNodeId && associate) associate(targetNodeId, drag.relativePath); else drag.place(position);
}
