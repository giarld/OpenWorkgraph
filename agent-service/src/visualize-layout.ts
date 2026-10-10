import type { GraphSnapshot } from '@openworkgraph/protocol';
import { defaultWorkgraphNodeSize, VisualizeValidationError } from '@openworkgraph/protocol';

const COORDINATE_LIMIT = 1e9;
const OUTPUT_GAP = 60;

/** Match execution outputs' right-hand column and reserve actual node bounds across requests. */
export function visualizeSuccessorPositions(graph: GraphSnapshot, sourceId: string, types: readonly string[]): { x: number; y: number; width: number; height: number }[] {
  const source = graph.nodes.find(node => node.id === sourceId)!;
  const x = Math.min(COORDINATE_LIMIT, source.x + (source.width ?? defaultWorkgraphNodeSize(source.type).width) + 100);
  // Groups contain nodes; their enclosing rectangles are not occupied output slots.
  const occupied = graph.nodes.filter(node => node.type !== 'group').map(node => ({
    x: node.x, y: node.y, width: node.width ?? defaultWorkgraphNodeSize(node.type).width, height: node.height ?? defaultWorkgraphNodeSize(node.type).height,
  }));
  let nextY = source.y;
  return types.map(type => {
    const size = defaultWorkgraphNodeSize(type);
    const column = occupied.filter(node => x < node.x + node.width && x + size.width > node.x);
    const collides = (y: number) => column.filter(node => y < node.y + node.height + OUTPUT_GAP && y + size.height + OUTPUT_GAP > node.y);
    let y = nextY;
    let collisions = collides(y);
    while (collisions.length) {
      const next = Math.max(...collisions.map(node => node.y + node.height + OUTPUT_GAP));
      if (next > COORDINATE_LIMIT) break;
      y = next; collisions = collides(y);
    }
    // At the lower coordinate boundary, use the free space above the source.
    if (collisions.length) {
      y = source.y; collisions = collides(y);
      while (collisions.length) {
        y = Math.min(...collisions.map(node => node.y - size.height - OUTPUT_GAP));
        if (y < -COORDINATE_LIMIT) throw new VisualizeValidationError('INVALID_REQUEST', '工作图中没有可放置后继节点的位置。');
        collisions = collides(y);
      }
    }
    const position = { x, y, ...size };
    nextY = Math.min(COORDINATE_LIMIT, y + size.height + OUTPUT_GAP);
    occupied.push(position);
    return position;
  });
}
