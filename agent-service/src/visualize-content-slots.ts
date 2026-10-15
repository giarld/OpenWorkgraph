import type { GraphScope, Json, VisualizeBridgeRequest } from '@openworkgraph/protocol';
import { NODE_CONTENT_SLOTS, nodeContentSlotMatches, validateNodeContentSlotParams } from '@openworkgraph/protocol';
import type { Graphs } from './graphs.js';
import type { Resources } from './resources.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';

/** Content updates use the same typed slot registry as the SDK and signal router. */
export async function prepareVisualizeContentSlot(graphs: Graphs, resources: Resources, scope: GraphScope, sourceId: string, request: Extract<VisualizeBridgeRequest, { method: 'contentSlot' }>, principal: string) {
  const { targetNodeId, invocationId, slot } = request.params;
  const update = validateNodeContentSlotParams(slot, request.params.update), definition = NODE_CONTENT_SLOTS[slot];
  const check = () => {
    const graph = graphs.snapshot(scope), target = graph.nodes.find(node => node.id === targetNodeId);
    if (!target || !nodeContentSlotMatches(slot, target) || !graph.edges.some(edge => edge.kind === 'reference' && edge.sourceId === sourceId && edge.targetId === targetNodeId)) throw new ServiceError('INPUT_BLOCKED', '内容更新槽与普通后继节点类型不匹配。');
    if (graph.archived || graph.trashed || target.readOnly) throw new ServiceError('NODE_LOCKED', '目标节点当前只读。');
    const content = target.content && typeof target.content === 'object' && !Array.isArray(target.content) ? target.content : {};
    if (content.source !== undefined) throw new ServiceError('INPUT_BLOCKED', '项目文件引用不支持通过内容槽更新，请先创建独立副本。');
    return { graph, target, content };
  };
  const { target } = check();
  const namespace = principal + ':visualize.content-slot:' + scope.graphId + ':' + sourceId;
  const payload = request.params as unknown as Json;
  const replay = graphs.repo.replay(namespace, invocationId, payload);
  if (replay !== undefined) return { commit: () => { check(); return replay as unknown as { nodeId: string; contentVersion: number; executionRevision: number }; }, dispose: async () => {} };
  graphs.assertNodeEditable(targetNodeId);
  if (update.expectedContentVersion !== undefined && update.expectedContentVersion !== target.contentVersion) throw new ServiceError('REVISION_CONFLICT', '目标节点内容已变化，请读取最新版本。');
  const originalVersion = target.contentVersion;
  return { commit: () => {
    const { graph, target: current, content } = check();
    return graphs.repo.idempotent(namespace, invocationId, payload, () => {
      graphs.assertNodeEditable(targetNodeId);
      if (current.contentVersion !== originalVersion) throw new ServiceError('REVISION_CONFLICT', '目标节点内容已变化，请读取最新版本。');
      const next: Record<string, Json> = { ...content };
      if (definition.payload === 'text' && 'text' in update) {
        next.text = update.text;
        // Match document editing: detach the immutable resource, retain it in history.
        delete next.resourceId; delete next.resourceVersion; delete next.mime; delete next.bytes;
      } else if (definition.payload === 'resource' && 'resourceId' in update) {
        const resource = resources.readCanvasVersion(scope, update.resourceId, update.resourceVersion);
        if (resource.state !== 'ready' || !resource.mime.startsWith(definition.resourceMimePrefix)) throw new ServiceError('INVALID_REQUEST', '资源内容类型与目标节点不匹配。');
        next.resourceId = update.resourceId; next.resourceVersion = update.resourceVersion; next.mime = resource.mime; next.bytes = resource.bytes;
        delete next.text;
      } else throw new ServiceError('INVALID_REQUEST', '内容更新参数与目标节点类型不匹配。');
      if (canonicalJson(next) === canonicalJson(current.content)) return { nodeId: targetNodeId, contentVersion: current.contentVersion, executionRevision: graph.executionRevision };
      graphs.applyWithoutSnapshot({ ...scope, idempotencyKey: invocationId, expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, operations: [{ type: 'node.content', nodeId: targetNodeId, expectedContentVersion: originalVersion, content: next }] }, namespace + ':content', request.cause);
      return { nodeId: targetNodeId, contentVersion: originalVersion + 1, executionRevision: graph.executionRevision + 1 };
    }) as unknown as { nodeId: string; contentVersion: number; executionRevision: number };
  }, dispose: async () => {} };
}
