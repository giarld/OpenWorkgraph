import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { GraphOperation, GraphScope, Json, VisualizeBridgeRequest, VisualizePrompt } from '@openworkgraph/protocol';
import { validateVisualizeBridgeRequest, VisualizeValidationError } from '@openworkgraph/protocol';
import { VisualizePages, type PreparedVisualizeWrite } from './visualize-pages.js';
import type { PreparedVisualizeSuccessors } from './visualize-bridge.js';
import { ProjectFiles } from './project-files.js';
import { validSkillContent } from './plugins.js';
import { ServiceError } from './errors.js';
import { visualizeSuccessorPositions } from './visualize-layout.js';

/** Preflight identity/bytes outside auth transactions; the bridge commits atomically. */
export class VisualizeSuccessors {
  constructor(readonly pages: VisualizePages, readonly validateSkills: (prompt: VisualizePrompt, projectId: string) => Promise<void> = async prompt => {
    if (prompt.skillReferences.length) throw new ServiceError('INPUT_BLOCKED', '当前工作空间无法校验技能身份。');
  }) {}
  async prepare(scope: GraphScope, nodeId: string, value: Extract<VisualizeBridgeRequest, { method: 'createSuccessors' }>, principal: string): Promise<PreparedVisualizeSuccessors> {
    const request = validateVisualizeBridgeRequest(value) as typeof value;
    const before = this.pages.current(scope, nodeId);
    if (!before.content.page || !before.content.form) throw new VisualizeValidationError('INPUT_BLOCKED', '请先保存交互页面。');
    const files = new ProjectFiles(this.pages.graphs.db);
    const operations: GraphOperation[] = [], nodeIds: string[] = [], edgeIds: string[] = [];
    for (const successor of request.params.successors) {
      let content: Record<string, Json>;
      if (successor.type === 'text') content = { text: successor.text };
      else {
        const prompt = successor.prompt;
        if (!validSkillContent({ prompt: prompt.text, skillReferences: prompt.skillReferences as unknown as Json })) throw new VisualizeValidationError('INVALID_REQUEST', '技能提及与提示词不一致。');
        await this.validateSkills(prompt, scope.projectId);
        const references: { relativePath: string }[] = [];
        const links: string[] = [];
        for (const file of prompt.files) {
          const resolved = await files.resolve(scope.projectId, file.relativePath, 'file');
          if (references.some(item => item.relativePath === resolved.relativePath)) continue;
          references.push({ relativePath: resolved.relativePath });
          const label = basename(resolved.relativePath).replace(/[\[\]`*_<>!&]/g, '\\$&');
          const destination = resolved.relativePath.replace(/[<>\\&]/g, '\\$&');
          links.push('[' + label + '](<' + destination + '>)');
        }
        content = { prompt: prompt.text + (links.length ? '\n\n' + links.join('\n') : ''), skillReferences: prompt.skillReferences as unknown as Json, features: prompt.features as unknown as Json, projectFileReferences: references as unknown as Json };
      }
      if (successor.title !== undefined) content.title = successor.title;
      content.visualizeSource = { nodeId, pageRevision: before.content.page.revision, formVersion: before.content.form.version + (request.params.form === undefined ? 0 : 1), requestId: request.requestId };
      const id = randomUUID(), edgeId = randomUUID(); nodeIds.push(id); edgeIds.push(edgeId);
      operations.push({ type: 'node.create', node: { id, type: successor.type, schemaVersion: 1, contentVersion: 1, content, readOnly: false, x: 0, y: 0 } }, { type: 'edge.create', edge: { id: edgeId, sourceId: nodeId, targetId: id, kind: 'reference' } });
    }
    let write: PreparedVisualizeWrite | undefined;
    if (request.params.form !== undefined) write = await this.pages.prepare({ ...scope, nodeId, idempotencyKey: request.requestId, expectedContentVersion: before.contentVersion, expectedExecutionRevision: request.expected.executionRevision, expectedLayoutRevision: request.expected.layoutRevision, expectedPageRevision: request.expected.pageRevision, action: 'update-form', expectedFormVersion: request.expected.formVersion, form: request.params.form }, principal + ':visualize.successor.form:' + nodeId + ':' + request.expected.pageRevision, true);
    let disposed = false;
    return { commit: () => {
      if (disposed) throw new VisualizeValidationError('SESSION_EXPIRED', '后继创建准备已释放。');
      const current = write ? this.pages.commit(write) : this.pages.current(scope, nodeId);
      const positions = visualizeSuccessorPositions(this.pages.graphs.snapshot(scope), nodeId, request.params.successors.map(successor => successor.type));
      let index = 0;
      const placed = operations.map(operation => operation.type === 'node.create' ? { ...operation, node: { ...operation.node, ...positions[index++]! } } : operation);
      const result = this.pages.graphs.command({ ...scope, idempotencyKey: request.requestId, expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: current.layoutRevision, operations: placed }, principal + ':visualize.successors:' + nodeId + ':' + request.expected.pageRevision);
      return { nodeIds, edgeIds, form: current.content.form!, revisions: { pageRevision: current.content.page!.revision, formVersion: current.content.form!.version, stateVersion: current.content.state!.version, inputVersion: request.expected.inputVersion, executionRevision: result.executionRevision, layoutRevision: result.layoutRevision } };
    }, dispose: async () => { if (disposed) return; disposed = true; if (write) await this.pages.dispose(write); } };
  }
}
