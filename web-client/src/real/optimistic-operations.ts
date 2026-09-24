import type { GraphOperation, GraphSnapshot } from './contracts';

/** Replay pending intentions over the latest confirmed snapshot. Never invent revisions.
 * Replaying is tolerant of SSE already containing an in-flight command. */
export function projectOperations(source: GraphSnapshot, operations: GraphOperation[]): GraphSnapshot {
  const graph = structuredClone(source);
  const node = (id: string) => graph.nodes.find(n => n.id === id);
  for (const op of operations) {
    switch (op.type) {
      case 'node.create':
        if (!node(op.node.id)) graph.nodes.push(structuredClone(op.node));
        break;
      case 'node.delete': {
        const removed = node(op.nodeId);
        const delivery = graph.edges.find(e => e.kind === 'delivery' && e.targetId === op.nodeId);
        if (removed && delivery) {
          graph.hiddenExecutionOutputs ??= [];
          graph.hiddenExecutionOutputs.push({ executionNodeId: delivery.sourceId, node: removed });
        }
        graph.nodes = graph.nodes.filter(n => n.id !== op.nodeId);
        graph.edges = graph.edges.filter(e => e.sourceId !== op.nodeId && e.targetId !== op.nodeId);
        for (const n of graph.nodes) if (n.memberIds) n.memberIds = n.memberIds.filter(id => id !== op.nodeId);
        break;
      }
      case 'edge.create':
        if (!graph.edges.some(e => e.id === op.edge.id) && node(op.edge.sourceId) && node(op.edge.targetId)) graph.edges.push(structuredClone(op.edge));
        break;
      case 'edge.delete': graph.edges = graph.edges.filter(e => e.id !== op.edgeId); break;
      case 'layout.move': {
        const moves = new Map(op.positions.map(p => [p.nodeId, { x: p.x, y: p.y }]));
        for (const p of op.positions) {
          const group = node(p.nodeId);
          if (group?.type === 'group') for (const id of group.memberIds ?? []) {
            const member = node(id);
            if (member) moves.set(id, { x: member.x + p.x - group.x, y: member.y + p.y - group.y });
          }
        }
        for (const [id, position] of moves) { const n = node(id); if (n) Object.assign(n, position); }
        break;
      }
      case 'layout.resize':
        for (const size of op.sizes) {
          const n = node(size.nodeId);
          if (!n) continue;
          if (size.width === null) delete n.width; else n.width = size.width;
          if (size.height === null) delete n.height; else n.height = size.height;
          if (size.x !== undefined) n.x = size.x;
          if (size.y !== undefined) n.y = size.y;
        }
        break;
      case 'group.members': { const n = node(op.groupId); if (n) n.memberIds = [...op.memberIds]; break; }
      case 'group.rename': { const n = node(op.groupId); if (n) n.content = { title: op.title }; break; }
      case 'graph.rename': graph.title = op.title.trim(); break;
      case 'graph.archive': graph.archived = op.archived; break;
      case 'graph.trash': graph.trashed = op.trashed; break;
      case 'node.project-file.associate': {
        const n = node(op.nodeId);
        if (n) { n.type = op.nodeType; n.content = structuredClone(op.content); }
        break;
      }
      case 'execution.output.restore': {
        const hidden = graph.hiddenExecutionOutputs?.find(o => o.node.id === op.nodeId && o.executionNodeId === op.executionNodeId);
        if (hidden && !node(op.nodeId)) {
          graph.nodes.push({ ...hidden.node, x: op.x, y: op.y });
          graph.hiddenExecutionOutputs = graph.hiddenExecutionOutputs?.filter(o => o !== hidden);
          graph.edges.push({ id: 'optimistic-delivery:' + op.nodeId, kind: 'delivery', sourceId: op.executionNodeId, targetId: op.nodeId });
        }
        break;
      }
      // Body drafts provide their own preview; queued saves still use content-version CAS.
      case 'node.content': break;
    }
  }
  return graph;
}
