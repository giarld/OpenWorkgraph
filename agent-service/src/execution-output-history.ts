import { limitNodeTitle, NODE_TITLE_MAX_LENGTH } from '@openworkgraph/protocol';
import { randomUUID } from 'node:crypto';
import type { GraphCommand, Json, SubmitRun } from '@openworkgraph/protocol';
import type { PreparedBlob } from './blob-store.js';
import { Graphs, resourceLinks } from './graphs.js';
import { ProjectFileMissingError, Resources } from './resources.js';
import { ServiceError } from './errors.js';
import { insertTransferredVisualizeNode, prepareVisualizeCopy } from './visualize-transfer.js';

/** Prepare every deleted execution before the command transaction, including hidden outputs. */
export async function prepareDeletedOutputHistory(graphs: Graphs, resources: Resources, command: GraphCommand, cleanups: (() => unknown)[]) {
  const prepared = new Map<string, () => void>();
  const copies = new Map<string, string>();
  if (!command.operations.some(op => op.type === 'node.delete')) return () => {};
  const graph = graphs.snapshot(command);
  for (const op of command.operations) {
    if (op.type !== 'node.delete' || prepared.has(op.nodeId) || !graph.nodes.some(node => node.id === op.nodeId && node.type === 'execution')) continue;
    if (!graphs.executionOutputs(command, op.nodeId).length) continue;
    const request: SubmitRun = { ...command, nodeId: op.nodeId, kind: 'execution' };
    const preserve = await prepareOutputHistory(graphs, resources, request, cleanups, copies, { skipMissingProjectFiles: true });
    prepared.set(op.nodeId, () => preserve(request, graphs));
  }
  return () => {
    copies.clear();
    for (const preserve of prepared.values()) preserve();
    return copies;
  };
}

/** Place only the new batch, avoiding nearby history without moving existing work. */
function positionHistoryGroup(graphs: Graphs, request: SubmitRun, groupId: string): void {
  const nodes = graphs.snapshot(request).nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const group = byId.get(groupId)!;
  const width = group.width ?? 300, height = group.height ?? 220;
  const groups = nodes.filter(node => {
    if (node.id === groupId || node.type !== 'group' || node.schemaVersion !== 1) return false;
    const content = node.content as Record<string, Json>;
    return typeof content.title === 'string' && /-历史输出-\d{13}$/.test(content.title)
      && node.y < group.y + height && node.y + (node.height ?? 220) > group.y;
  }).sort((a, b) => a.x - b.x);
  let x = group.x;
  for (const other of groups) {
    const right = other.x + (other.width ?? 300);
    if (x < right + 32 && x + width + 32 > other.x) x = right + 32;
  }
  const dx = x - group.x;
  if (!dx) return;
  const move = graphs.db.prepare('UPDATE nodes SET x=x+?,y=y+? WHERE id=? AND graph_id=?');
  for (const id of [group.id, ...(group.memberIds ?? [])]) {
    const node = byId.get(id)!;
    if (!Number.isFinite(node.x + dx) || Math.abs(node.x + dx) > 1e9) throw new ServiceError('INVALID_REQUEST', '历史输出分组排布超出工作图坐标范围。');
    move.run(dx, 0, id, request.graphId);
  }
}

/** Prepare live files before the auth transaction; commit copies with submission. */
export async function prepareOutputHistory(graphs: Graphs, resources: Resources, request: SubmitRun, cleanups: (() => unknown)[], sharedCopies?: Map<string, string>, options: { skipMissingProjectFiles?: boolean } = {}) {
  const outputs = graphs.executionOutputs(request, request.nodeId);
  const graph = graphs.snapshot(request);
  const visible = new Set(graph.edges.filter(edge => edge.kind === 'delivery' && edge.sourceId === request.nodeId).map(edge => edge.targetId));
  const owner = graph.nodes.find(node => node.id === request.nodeId)!;
  const files = new Map<string, PreparedBlob>();
  const visualizations = new Map<string, () => Json>();
  const skipped = new Set<string>();
  for (const output of outputs) {
    if (output.type === 'visualize') {
      visualizations.set(output.id, await prepareVisualizeCopy(graphs, resources, request, output, cleanups));
      continue;
    }
    const content = output.content as Record<string, Json>;
    const source = content.source as Record<string, Json> | undefined;
    if (source?.kind === 'project-file') {
      if (source.serviceId !== request.serviceId || source.projectId !== request.projectId || typeof source.relativePath !== 'string') throw new ServiceError('INPUT_BLOCKED', 'Invalid historical project file');
      try {
        const blob = await resources.prepareProjectFile(request, source.relativePath, typeof content.mime === 'string' ? content.mime : 'application/octet-stream');
        files.set(output.id, blob);
        cleanups.push(() => resources.discardPrepared(blob));
      } catch (error) {
        if (!options.skipMissingProjectFiles || !(error instanceof ProjectFileMissingError)) throw error;
        skipped.add(output.id);
      }
    }
  }
  const retained = outputs.filter(output => !skipped.has(output.id));
  const anchor = retained.find(node => visible.has(node.id)) ?? { x: owner.x + (owner.width ?? 300) + 80, y: owner.y };
  return (_request: SubmitRun, current: Graphs) => {
    // Keep the complete baseline so skipped files cannot bypass output CAS or locks.
    current.assertOutputPreservation(request, request.nodeId, outputs);
    const nodeCopies = new Map<string, string>();
    retained.forEach((output, index) => {
      let content = structuredClone(output.content) as Record<string, Json>;
      let type = output.type;
      const file = files.get(output.id);
      if (file) {
        const created = resources.createCanvasFromPrepared(request, file, String(content.title ?? 'Historical output'));
        delete content.source; delete content.observation;
        content.resourceId = created.resource.id; content.resourceVersion = created.resource.current.version;
        content.mime = file.mime; content.bytes = file.bytes;
        if (type === 'text') type = 'document';
      } else if (output.type === 'visualize') {
        content = visualizations.get(output.id)!() as Record<string, Json>;
      } else {
        const copies = new Map(resourceLinks(content,type).map(link => {
          const created = resources.copyCanvasToCanvas(request, request.graphId, link.resourceId, link.version);
          return [link.resourceId + ':' + link.version, created.resource];
        }));
        const remap = (value: Json): void => {
          if (!value || typeof value !== 'object') return;
          if (!Array.isArray(value) && typeof value.resourceId === 'string') {
            const copy = copies.get(value.resourceId + ':' + (value.resourceVersion ?? value.version));
            if (copy) { value.resourceId = copy.id; if ('resourceVersion' in value) value.resourceVersion = copy.current.version; else value.version = copy.current.version; }
          }
          Object.values(value).forEach(remap);
        };
        remap(content);
      }
      const id = randomUUID();
      // History stacks use the same default dimensions as Web node creation.
      const width = type === 'visualize' ? output.width ?? 480 : type === 'preview' ? 480 : 300;
      const height = type === 'visualize' ? output.height ?? 360 : type === 'preview' ? 360 : 220;
      const copy = { ...output, id, type, contentVersion: 1, content, x: anchor.x + index * 22, y: anchor.y + index * 22, width, height, readOnly: true };
      if (type === 'visualize') insertTransferredVisualizeNode(current, request, copy);
      else current.insertNode(request, copy, true);
      nodeCopies.set(output.id, id);
    });
    const allCopies = sharedCopies ?? new Map<string, string>();
    for (const [originalId, copyId] of nodeCopies) allCopies.set(originalId, copyId);
    let rewired = false;
    // Keep edge identity so presentation settings and successor connections survive
    // retirement. The execution node's incoming delivery links still retire normally.
    for (const [originalId, copyId] of nodeCopies) {
      const edges = current.db.prepare('SELECT id,target_id FROM edges WHERE graph_id=? AND source_id=?').all(request.graphId, originalId);
      for (const edge of edges) {
        current.db.prepare('UPDATE edges SET source_id=?,target_id=? WHERE id=?').run(copyId, allCopies.get(String(edge['target_id'])) ?? String(edge['target_id']), String(edge['id']));
        rewired = true;
      }
    }
    // A successor output may be copied later in the same chain batch. Finish
    // migrating links from already-created history nodes when its copy appears.
    for (const [originalId, copyId] of nodeCopies) {
      const incoming = current.db.prepare('SELECT id,source_id FROM edges WHERE graph_id=? AND target_id=?').all(request.graphId, originalId);
      const copiedSources = new Set(allCopies.values());
      for (const edge of incoming) if (copiedSources.has(String(edge['source_id']))) {
        current.db.prepare('UPDATE edges SET target_id=? WHERE id=?').run(copyId, String(edge['id']));
        rewired = true;
      }
    }
    if (nodeCopies.size) {
      const nodes = current.snapshot(request).nodes;
      const execution = nodes.find(node => node.id === request.nodeId)!;
      const executionContent = execution.content as Record<string, Json>;
      const name = typeof executionContent.title === 'string' && executionContent.title.trim() ? executionContent.title.trim() : execution.id;
      const suffix = `-历史输出-${Date.now()}`;
      // Reserve space within the node title limit for the complete batch suffix.
      const title = limitNodeTitle(name, NODE_TITLE_MAX_LENGTH - Array.from(suffix).length);
      const x = anchor.x - 24, y = anchor.y - 48;
      const copyIds = new Set(nodeCopies.values());
      const copies = nodes.filter(node => copyIds.has(node.id));
      const right = Math.max(...copies.map(copy => copy.x + copy.width!));
      const bottom = Math.max(...copies.map(copy => copy.y + copy.height!));
      const groupId = randomUUID();
      current.insertNode(request, {
        id: groupId, type: 'group', schemaVersion: 1, contentVersion: 1,
        content: { title: title + suffix }, x, y, width: right - x + 24, height: bottom - y + 24,
        memberIds: [...nodeCopies.values()], readOnly: false,
      }, true);
      positionHistoryGroup(current, request, groupId);
      current.db.prepare('UPDATE graphs SET execution_revision=execution_revision+?,layout_revision=layout_revision+1 WHERE id=?').run(Number(rewired), request.graphId);
      current.event(request);
    }
  };
}
