import { groupAtCenter, insetNodePosition } from '../canvas/group-drop';
import type { WorkNode } from "../domain/types";

type Bounds = Pick<WorkNode, "x" | "y" | "width" | "height">;
type Point = Pick<WorkNode, "x" | "y">;
type PlacementNode = Bounds & Pick<WorkNode, 'id' | 'type'> & { schemaVersion?: number; memberIds?: string[] };
export type OutputPlacement = Point & { groupId?: string };

const gap = 24;

function overlaps(point: Point, output: Bounds, node: Bounds): boolean {
  return point.x < node.x + node.width + gap &&
    point.x + output.width + gap > node.x &&
    point.y < node.y + node.height + gap &&
    point.y + output.height + gap > node.y;
}

function clampToBounds(point: Point, output: Bounds, bounds?: Bounds): Point {
  if (!bounds) return point;
  const minX = bounds.x + gap, maxX = bounds.x + bounds.width - output.width - gap;
  const minY = bounds.y + gap, maxY = bounds.y + bounds.height - output.height - gap;
  return {
    x: minX <= maxX ? Math.max(minX, Math.min(point.x, maxX)) : point.x,
    y: minY <= maxY ? Math.max(minY, Math.min(point.y, maxY)) : point.y,
  };
}

function contained(point: Point, output: Bounds, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.y >= bounds.y &&
    point.x + output.width <= bounds.x + bounds.width &&
    point.y + output.height <= bounds.y + bounds.height;
}

function intersection(left: Bounds | undefined, right: Bounds): Bounds | undefined {
  if (!left) return right;
  const x = Math.max(left.x, right.x), y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function nearestPlacement(nodes: Bounds[], output: Bounds, anchor: Point, bounds?: Bounds): Point | undefined {
  const pending: Array<Point & { order: number }> = [];
  const queued = new Set<string>();
  let order = 0;
  const add = (point: Point) => {
    const next = clampToBounds(point, output, bounds);
    const key = `${next.x}:${next.y}`;
    if (queued.has(key)) return;
    queued.add(key);
    pending.push({ ...next, order: order++ });
  };
  add(anchor);

  // Every generated coordinate sits immediately beside an obstacle. Searching
  // by distance keeps restored outputs close instead of growing one long column.
  while (pending.length) {
    pending.sort((a, b) => {
      const aDistance = (a.x - anchor.x) ** 2 + (a.y - anchor.y) ** 2;
      const bDistance = (b.x - anchor.x) ** 2 + (b.y - anchor.y) ** 2;
      return aDistance - bDistance || a.order - b.order;
    });
    const candidate = pending.shift()!;
    if (bounds && !contained(candidate, output, bounds)) continue;
    const collisions = nodes.filter(node => overlaps(candidate, output, node));
    if (!collisions.length) return { x: candidate.x, y: candidate.y };
    for (const node of collisions) {
      add({ x: node.x + node.width + gap, y: candidate.y });
      add({ x: candidate.x, y: node.y + node.height + gap });
      add({ x: candidate.x, y: node.y - output.height - gap });
      add({ x: node.x - output.width - gap, y: candidate.y });
    }
  }
  return undefined;
}

/** Keep the requested point when free; otherwise find the nearest visible space around it. */
export function outputPlacement(nodes: PlacementNode[], output: Bounds, anchor: Point, visible?: Bounds): OutputPlacement {
  const groups = nodes.filter(node => node.type === 'group' && node.schemaVersion === 1);
  const obstacles = nodes.filter(node => node.type !== 'group');
  const groupAt = (point: Point) => groupAtCenter(
    { ...point, width: output.width, height: output.height },
    groups,
  );

  // A group is a container, not an obstacle. When the requested position is in
  // one, first search its visible interior so the restored node remains a member.
  const preferredGroup = groupAt(anchor);
  if (preferredGroup) {
    const inset = insetNodePosition({ ...anchor, width: output.width, height: output.height }, preferredGroup);
    const bounds = intersection(visible, preferredGroup);
    const grouped = inset && bounds ? nearestPlacement(obstacles, output, inset, bounds) : undefined;
    if (grouped && contained(grouped, output, preferredGroup)) return { ...grouped, groupId: preferredGroup.id };
  }

  const position = nearestPlacement(obstacles, output, anchor, visible) ??
    nearestPlacement(obstacles, output, anchor) ?? anchor;
  const targetGroup = groupAt(position);
  if (!targetGroup) return position;
  const inset = insetNodePosition({ ...position, width: output.width, height: output.height }, targetGroup);
  const bounds = intersection(visible, targetGroup);
  const grouped = inset && bounds ? nearestPlacement(obstacles, output, inset, bounds) : undefined;
  return grouped && contained(grouped, output, targetGroup)
    ? { ...grouped, groupId: targetGroup.id }
    : position;
}
