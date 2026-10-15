import type { GraphScope, Json, VisualizeBridgeRequest } from '@openworkgraph/protocol';
import { isVisualizeFeatureSelection, syncBuiltinFeatureMentions, syncSkillReferences, validSkillReferences } from '@openworkgraph/protocol';
import type { Graphs } from './graphs.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';

/** Updates only the prompt of a direct execution reference successor. */
export async function prepareVisualizePromptSlot(graphs: Graphs, scope: GraphScope, sourceId: string, request: Extract<VisualizeBridgeRequest, { method: 'promptSlot' }>, principal: string) {
  const { targetNodeId, invocationId, prompt, expectedContentVersion } = request.params;
  const check = () => {
    const graph = graphs.snapshot(scope), target = graph.nodes.find(node => node.id === targetNodeId);
    if (!target || target.type !== 'execution' || !graph.edges.some(edge => edge.kind === 'reference' && edge.sourceId === sourceId && edge.targetId === targetNodeId)) throw new ServiceError('INPUT_BLOCKED', '提示词更新仅支持当前节点的普通执行后继。');
    if (graph.archived || graph.trashed || target.readOnly) throw new ServiceError('NODE_LOCKED', '目标执行节点当前只读。');
    return { graph, target };
  };
  const { target } = check();
  const namespace = principal + ':visualize.prompt-slot:' + scope.graphId + ':' + sourceId;
  const payload = request.params as unknown as Json;
  const replay = graphs.repo.replay(namespace, invocationId, payload);
  if (replay !== undefined) return { commit: () => { check(); return replay as unknown as { nodeId: string; contentVersion: number; executionRevision: number }; }, dispose: async () => {} };
  graphs.assertNodeEditable(targetNodeId);
  if (expectedContentVersion !== undefined && expectedContentVersion !== target.contentVersion) throw new ServiceError('REVISION_CONFLICT', '目标节点提示词已变化，请读取最新版本。');
  const originalVersion = target.contentVersion;
  return { commit: () => {
    const { graph, target: current } = check();
    return graphs.repo.idempotent(namespace, invocationId, payload, () => {
      graphs.assertNodeEditable(targetNodeId);
      if (current.contentVersion !== originalVersion) throw new ServiceError('REVISION_CONFLICT', '目标节点提示词已变化，请读取最新版本。');
      const content = current.content && typeof current.content === 'object' && !Array.isArray(current.content) ? current.content : {};
      const previous = typeof content.prompt === 'string' ? content.prompt : '';
      const next: Record<string, Json> = { ...content, prompt };
      if (content.skillReferences !== undefined) next.skillReferences = syncSkillReferences(previous, prompt, validSkillReferences(previous, content.skillReferences)) as unknown as Json;
      const features = (Array.isArray(content.features) ? content.features as unknown[] : []).filter(isVisualizeFeatureSelection);
      const syncedFeatures = syncBuiltinFeatureMentions(previous, prompt, features);
      if (content.features !== undefined || syncedFeatures.length) next.features = syncedFeatures as unknown as Json;
      if (canonicalJson(next) === canonicalJson(current.content)) return { nodeId: targetNodeId, contentVersion: current.contentVersion, executionRevision: graph.executionRevision };
      const saved = graphs.command({ ...scope, idempotencyKey: invocationId, expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, operations: [{ type: 'node.content', nodeId: targetNodeId, expectedContentVersion: originalVersion, content: next }] }, namespace + ':content');
      return { nodeId: targetNodeId, contentVersion: saved.nodes.find(node => node.id === targetNodeId)!.contentVersion, executionRevision: saved.executionRevision };
    }) as unknown as { nodeId: string; contentVersion: number; executionRevision: number };
  }, dispose: async () => {} };
}
