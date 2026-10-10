import { validSkillReferences } from "./project-file-mentions";
import type { GraphOperation, GraphSnapshot, Json, Node } from './contracts';
import type { Rect } from '../canvas/geometry';
import { groupAtCenter, insetNodePosition } from '../canvas/group-drop';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
import { defaultWorkgraphNodeSize } from '../../../packages/protocol/src/node-layout';

export function moveWithMembershipOperations(graph: GraphSnapshot, moves: { id: string; x: number; y: number }[]): GraphOperation[] {
  const moving = new Set(moves.map(m => m.id));
  const groups = graph.nodes.filter(visualGroup);
  const carried = new Set(groups.filter(g => moving.has(g.id)).flatMap(g => g.memberIds ?? []));
  const destinations = new Map<string, string | undefined>();
  const positions = new Map(moves.map(m => [m.id, { ...m }]));
  for (const move of moves) {
    const node = find(graph, move.id);
    if (node.type === 'group' || carried.has(node.id)) continue;
    const target = groupAtCenter({ ...nodeBounds(node), ...move }, groups.filter(g => !moving.has(g.id)).map(g => ({ ...nodeBounds(g), id: g.id })));
    destinations.set(node.id, target?.id);
    if (target) {
      const position = insetNodePosition({ ...nodeBounds(node), ...move }, target);
      if (!position) throw Error(translate("The node is larger than the group and cannot fit inside it. Resize the node or group first."));
      positions.set(node.id, { id: node.id, ...position });
    }
  }
  const removals: GraphOperation[] = [], additions: GraphOperation[] = [];
  for (const group of groups) {
    const before = group.memberIds ?? [];
    const kept = before.filter(id => !destinations.has(id) || destinations.get(id) === group.id);
    const added = [...destinations].filter(([id, target]) => target === group.id && !kept.includes(id)).map(([id]) => id);
    if (kept.length !== before.length) removals.push({ type: 'group.members', groupId: group.id, memberIds: kept });
    if (added.length) additions.push({ type: 'group.members', groupId: group.id, memberIds: [...kept, ...added] });
  }
  // Move with the old membership, then release every source before acquiring targets.
  return [{ type: 'layout.move', positions: [...positions.values()].map(m => ({ nodeId: m.id, x: m.x, y: m.y })) }, ...removals, ...additions];
}

export function defaultNodeSize(type: string): Pick<Rect, 'width' | 'height'> {
  return defaultWorkgraphNodeSize(type);
}

export const nodeBounds = (node: Node): Rect => {
  const defaults = defaultNodeSize(node.type);
  const width = node.width ?? defaults.width, height = node.height ?? defaults.height;
  return {
    x: node.x,
    y: node.y,
    width,
    height,
  };
};
const visualGroup = (node: Node) => node.type === 'group' && node.schemaVersion === 1;
function find(graph: GraphSnapshot, id: string): Node {
  const node = graph.nodes.find(n => n.id === id);
  if (!node) throw Error(translate("The node no longer exists. Refresh and try again."));
  return node;
}
export function assertLayoutEditable(graph: GraphSnapshot, ids: string[], readonly: boolean, active: (id: string) => boolean): void {
  if (readonly || graph.archived || graph.trashed) throw Error(translate("The current Work Graph is read-only."));
  for (const id of new Set(ids)) {
    const node = find(graph, id);
    if (active(id)) throw Error(translate("An active node cannot be moved, resized, or deleted."));
    if (node.type === 'group') {
      if (!visualGroup(node)) throw Error(translate("Unknown group schema. It will not be migrated automatically."));
      for (const memberId of node.memberIds ?? []) {
        const member = find(graph, memberId);
        if (member.type === 'group') throw Error(translate("Nested groups are not supported."));
        if (active(memberId)) throw Error(translate("The group contains an active node and cannot be modified."));
      }
    }
  }
}
export function resizeOperation(nodeId: string, bounds: Rect): GraphOperation {
  if (![bounds.x, bounds.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1e9) ||
      ![bounds.width, bounds.height].every(v => Number.isFinite(v) && v > 0 && v <= 1e9)) throw Error(translate("The node size or position is invalid."));
  return { type: 'layout.resize', sizes: [{ nodeId, ...bounds }] };
}
export function assertGeometryEditable(graph: GraphSnapshot, ids: string[], readonly: boolean): void {
  if (readonly || graph.archived || graph.trashed) throw Error(translate("The current Work Graph is read-only."));
  for (const id of new Set(ids)) {
    const node = find(graph, id);
    if (node.type === 'group' && !visualGroup(node)) throw Error(translate("Unknown group schema. It will not be migrated automatically."));
  }
}

/** Resizing only releases existing members; covering another node never adopts it. */
export function resizeWithMembershipOperations(graph: GraphSnapshot, nodeId: string, bounds: Rect): GraphOperation[] {
  const node = find(graph, nodeId);
  if (node.type === 'visualize' && (bounds.width < 480 || bounds.height < 360)) throw Error(translate("Visualize nodes must be at least 480 × 360."));
  const operations = [resizeOperation(nodeId, bounds)];
  if (!visualGroup(node)) return operations;
  const before = node.memberIds ?? [];
  const memberIds = before.filter(id => {
    const member = nodeBounds(find(graph, id));
    return member.x >= bounds.x && member.y >= bounds.y &&
      member.x + member.width <= bounds.x + bounds.width &&
      member.y + member.height <= bounds.y + bounds.height;
  });
  if (memberIds.length !== before.length) operations.push({ type: 'group.members', groupId: nodeId, memberIds });
  return operations;
}
export function createGroupOperation(graph: GraphSnapshot, ids: string[], groupId: string): GraphOperation {
  if (!ids.length || new Set(ids).size !== ids.length) throw Error(translate("Select distinct nodes."));
  const nodes = ids.map(id => find(graph, id));
  if (nodes.some(n => n.type === 'group')) throw Error(translate("Nested groups are not supported. Ungroup first."));
  if (graph.nodes.some(n => n.type === 'group' && n.memberIds?.some(id => ids.includes(id)))) throw Error(translate("The node already belongs to another group. Remove it or ungroup first."));
  const bounds = nodes.map(nodeBounds);
  const x = Math.min(...bounds.map(b => b.x)) - 24;
  const y = Math.min(...bounds.map(b => b.y)) - 48;
  const width = Math.max(...bounds.map(b => b.x + b.width)) - x + 24;
  const height = Math.max(...bounds.map(b => b.y + b.height)) - y + 24;
  resizeOperation(groupId, { x, y, width, height });
  return { type: 'node.create', node: { id: groupId, type: 'group', schemaVersion: 1, contentVersion: 1, content: { title: translate("Group") }, x, y, width, height, memberIds: [...ids], readOnly: false } };
}
export function groupMembersOperation(graph: GraphSnapshot, groupId: string, memberIds: string[]): GraphOperation {
  if (!visualGroup(find(graph, groupId))) throw Error(translate("Select a supported group."));
  if (new Set(memberIds).size !== memberIds.length) throw Error(translate("Group members cannot be duplicated."));
  for (const id of memberIds) {
    if (find(graph, id).type === 'group') throw Error(translate("Nested groups are not supported."));
    if (graph.nodes.some(n => n.id !== groupId && n.type === 'group' && n.memberIds?.includes(id))) throw Error(translate("The node already belongs to another group."));
  }
  return { type: 'group.members', groupId, memberIds: [...memberIds] };
}
export function ungroupOperations(graph: GraphSnapshot, ids: string[]): GraphOperation[] {
  if (!ids.length || ids.some(id => !visualGroup(find(graph, id)))) throw Error(translate("Select a group to ungroup."));
  return [...new Set(ids)].map(nodeId => ({ type: 'node.delete', nodeId }));
}
export function groupRenameOperation(groupId: string, title: string): GraphOperation {
  if (title.length > 1024) throw Error(translate("The group name must contain 1–1024 characters."));
  return { type: 'group.rename', groupId, title };
}

/** Only copy a whitelist of textual values. Never copy a resource identity,
 * output provenance, plugin JSON, or delivery relation into a new identity. */
export function textCopyContent(node: Node, content: Json = node.content): Record<string, Json> {
  if (node.schemaVersion !== 1 || !['text', 'document', 'execution'].includes(node.type)) throw Error(translate("This node does not support a safe text copy."));
  const c = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  if (c.resourceId !== undefined || c.resourceVersion !== undefined || c.assetRef !== undefined) throw Error(translate("Resource nodes require the separate resource copy flow. Their references cannot be copied."));
  return { ...(c.skillReferences !== undefined ? { skillReferences: validSkillReferences(typeof c.prompt === 'string' ? c.prompt : '', c.skillReferences).map(ref => ({ ...ref })) } : {}), title: String(c.title ?? node.type) + translate(" Copy"), text: typeof c.text === 'string' ? c.text : '', prompt: typeof c.prompt === 'string' ? c.prompt : '', summary: typeof c.summary === 'string' ? c.summary : '' };
}
