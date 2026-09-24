import type { Rect } from './geometry';

export function insetNodePosition(node: Rect, group: Rect): { x: number; y: number } | undefined {
  if (node.width > group.width || node.height > group.height) return undefined;
  const horizontal = Math.min(24, (group.width - node.width) / 2);
  const top = Math.min(48, (group.height - node.height) * 2 / 3);
  const bottom = Math.min(24, (group.height - node.height) / 3);
  return {
    x: Math.max(group.x + horizontal, Math.min(node.x, group.x + group.width - node.width - horizontal)),
    y: Math.max(group.y + top, Math.min(node.y, group.y + group.height - node.height - bottom)),
  };
}

/** Prefer the smallest containing group; stable ID order resolves overlaps. */
export function groupAtCenter<T extends Rect & { id: string }>(node: Rect, groups: T[]): T | undefined {
  const x = node.x + node.width / 2, y = node.y + node.height / 2;
  return groups.filter(g => x >= g.x && x <= g.x + g.width && y >= g.y && y <= g.y + g.height)
    .sort((a, b) => a.width * a.height - b.width * b.height || a.id.localeCompare(b.id))[0];
}
