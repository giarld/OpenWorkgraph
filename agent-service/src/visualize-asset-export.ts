import { randomUUID } from 'node:crypto';
import type { GraphScope, VisualizeBridgeRequest } from '@openworkgraph/protocol';
import { VisualizeValidationError } from '@openworkgraph/protocol';
import { VisualizePages } from './visualize-pages.js';
import type { PreparedVisualizeAssetExport } from './visualize-bridge.js';
import { atomic } from './persistence/database.js';
import { visualizeSuccessorPositions } from './visualize-layout.js';

/** The page submits a file; all asset identities, targets and graph operations are host-owned. */
export class VisualizeAssetExport {
  constructor(readonly pages: VisualizePages) {}
  async prepare(scope: GraphScope, nodeId: string, request: Extract<VisualizeBridgeRequest, { method: 'exportAsset' }>, bytes: Uint8Array): Promise<PreparedVisualizeAssetExport> {
    if (bytes.length !== request.params.bytes) throw new VisualizeValidationError('INVALID_REQUEST', '资产文件大小不一致。');
    const blob = await this.pages.resources.prepareBytes(bytes, request.params.mime);
    let disposed = false;
    return { commit: () => {
      if (disposed) throw new VisualizeValidationError('SESSION_EXPIRED', '资产导出准备已释放。');
      const current = this.pages.current(scope, nodeId);
      const resources = this.pages.resources;
      const asset = resources.createLibraryFromPrepared({ ...scope, mode: 'new', name: request.params.name }, blob);
      const created = resources.copyAssetToCanvas(scope, asset.id, asset.current.version);
      const resource = created.resource, type = resource.current.mime.startsWith('image/') ? 'image' : 'file';
      const position = visualizeSuccessorPositions(this.pages.graphs.snapshot(scope), nodeId, [type])[0]!;
      const id = randomUUID(), edgeId = randomUUID();
      const result = this.pages.graphs.command({ ...scope, idempotencyKey: request.requestId, expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: current.layoutRevision, operations: [
        { type: 'node.create', node: { id, type, schemaVersion: 1, contentVersion: 1, readOnly: false,
          ...position,
          content: { title: asset.name, prompt: '', resourceId: resource.id, resourceVersion: resource.current.version, mime: resource.current.mime, bytes: resource.current.bytes,
            visualizeSource: { nodeId, pageRevision: current.content.page!.revision, formVersion: current.content.form!.version, requestId: request.requestId, assetId: asset.id, assetVersion: asset.current.version } } } },
        { type: 'edge.create', edge: { id: edgeId, sourceId: nodeId, targetId: id, kind: 'reference' } },
      ] }, 'visualize.asset-export:' + scope.graphId + ':' + nodeId + ':' + current.content.page!.revision);
      resources.consumeGraphHolds(scope, resource.id, resource.current.version);
      return { assetId: asset.id, assetVersion: asset.current.version, resourceId: resource.id, resourceVersion: resource.current.version, nodeId: id, edgeId, mime: resource.current.mime, bytes: resource.current.bytes,
        revisions: { ...request.expected, stateVersion: current.content.state!.version, executionRevision: result.executionRevision, layoutRevision: result.layoutRevision } };
    }, dispose: async () => { if (disposed) return; disposed = true; atomic(this.pages.graphs.db, () => this.pages.resources.discardPrepared(blob)); } };
  }
}
