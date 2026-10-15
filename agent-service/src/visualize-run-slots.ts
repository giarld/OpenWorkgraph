import type { AgentSelection, GraphScope, Json, ModelSelection, SubmitRun, VisualizeBridgeRequest } from '@openworkgraph/protocol';
import { isTerminalRunStatus } from '@openworkgraph/protocol';
import type { WorkflowRuntime } from './runtime.js';
import { atomic } from './persistence/database.js';
import { ServiceError } from './errors.js';
import { AgentControl } from './agents/control.js';

const object = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** The page can operate only a direct reference successor using its saved setup. */
export async function prepareVisualizeRunSlot(rt: WorkflowRuntime, scope: GraphScope, sourceId: string, request: Extract<VisualizeBridgeRequest, { method: 'runSlot' }>, principal: string) {
  const { targetNodeId, action, invocationId, runId } = request.params;
  const check = () => {
    const graph = rt.graphs.snapshot(scope), target = graph.nodes.find(n => n.id === targetNodeId);
    if (!target || target.type !== 'execution' || !graph.edges.some(e => e.kind === 'reference' && e.sourceId === sourceId && e.targetId === targetNodeId)) throw new ServiceError('INPUT_BLOCKED', '执行槽仅支持当前节点的普通执行后继。');
    if (graph.archived || graph.trashed || target.readOnly) throw new ServiceError('NODE_LOCKED', '目标执行节点当前只读。');
    if (action === 'cancel') { const run = rt.runs.get(runId!); if (run.projectId !== scope.projectId || run.graphId !== scope.graphId || run.nodeId !== targetNodeId) throw new ServiceError('INPUT_BLOCKED', '任务不属于目标执行节点。'); }
    return { graph, target };
  };
  const { graph, target } = check();
  const namespace = principal + ':visualize.run-slot:' + scope.graphId + ':' + sourceId;
  const payload = request.params as unknown as Json;
  const replay = rt.runs.repo.replay(namespace, invocationId, payload);
  if (replay !== undefined) return { commit: () => { check(); return replay as unknown as { runId: string; status: string }; }, dispose: async () => {} };
  const cleanups: (() => unknown)[] = [];
  const dispose = async () => { if (cleanups.length) atomic(rt.db, () => { for (const cleanup of cleanups.splice(0)) cleanup(); }); };
  try {
    let commit: (() => { id: string; status: string });
    if (action === 'cancel') commit = () => rt.runs.cancel(runId!, invocationId);
    else {
      if (rt.runs.list(scope.projectId).some(run => run.graphId === scope.graphId && run.nodeId === targetNodeId && !isTerminalRunStatus(run.status))) throw new ServiceError('ACTIVE_RUN', '后继节点已有待处理或执行中的任务。');
      const content = object(target.content);
      let preference = object(content.agentModelOverride), legacy = object(content.modelOverride);
      if (content.agentModelOverride === undefined && !legacy.model) {
        const previous = rt.runs.list(scope.projectId).filter(r => r.graphId === scope.graphId && r.nodeId === targetNodeId).at(-1);
        if (previous) { const snapshot = rt.runs.snapshot(previous.id); if (snapshot.agent) preference = { backendId: snapshot.agent.backendId, model: snapshot.agent.model as unknown as Json }; else if (snapshot.model) preference = { backendId: 'codex', model: snapshot.model as unknown as Json }; }
      }
      let agent: AgentSelection | undefined;
      if (rt.agentConfiguration && rt.agentDiscovery && rt.options.agentRegistry) {
        const configuration = rt.agentConfiguration.get();
        const backendId = typeof preference.backendId === 'string' ? preference.backendId : configuration.default.selection?.backendId ?? configuration.order.backendIds[0];
        if (!backendId) throw new ServiceError('MODEL_UNAVAILABLE', '工作空间默认模型不可用。');
        const backend = rt.agentConfiguration.getBackend(backendId);
        const query = rt.agentConfiguration.query(backendId);
        const models = await rt.agentDiscovery.listModels(backendId, { options: query.options, schemaVersion: query.schemaVersion });
        const first = models[0];
        const selected = object(preference.model);
        const defaultModel = configuration.default.selection;
        const model: ModelSelection | undefined = typeof selected.model === 'string' ? selected as unknown as ModelSelection
          : defaultModel ? { model: defaultModel.model, reasoningEffort: defaultModel.reasoningEffort }
          : first ? { model: first.id, reasoningEffort: first.reasoningEfforts.includes('medium') ? 'medium' : first.reasoningEfforts[0] ?? null } : undefined;
        if (!model) throw new ServiceError('MODEL_UNAVAILABLE', '目标执行节点模型不可用。');
        if (legacy.model && backendId !== 'codex') throw new ServiceError('INPUT_BLOCKED', '请先清除目标节点的旧 Codex 模型覆盖。');
        agent = { settingsGeneration: 'agent-configuration-v1', permissions: configuration.permissions, backendId, configRevision: backend.revision, schemaVersion: backend.schemaVersion, options: backend.options, model: !preference.backendId && typeof legacy.model === 'string' ? legacy as unknown as ModelSelection : model };
      }
      const input: SubmitRun = { ...scope, nodeId: targetNodeId, kind: 'execution', idempotencyKey: invocationId, expectedExecutionRevision: graph.executionRevision, preserveHistoricalOutputs: true, ...(agent ? { agent } : typeof legacy.model === 'string' ? { modelOverride: legacy as unknown as ModelSelection } : {}) };
      if (agent) new AgentControl(rt).validateSubmission(input, principal);
      const submit = await rt.prepareSubmission(input, cleanups, principal);
      commit = () => submit(principal);
    }
    return { commit: () => {
      check();
      return rt.runs.repo.idempotent(namespace, invocationId, payload, () => { const run = commit(); return { runId: run.id, status: run.status }; }) as unknown as { runId: string; status: string };
    }, dispose };
  } catch (error) { await dispose(); throw error; }
}
