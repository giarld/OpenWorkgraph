import { visualizeAssetHeader, VISUALIZE_ASSET_BINARY_MIME, validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, VisualizeValidationError } from '../../../packages/protocol/src/index';
import type { GraphScope, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeHostContext } from '../../../packages/protocol/src/index';
import type { Transport } from '../adapter/transport';

/** Only the host receives Transport; the isolated iframe gets protocol identity. */
export async function openVisualizeBridge(transport: Pick<Transport, 'request'>, scope: GraphScope, nodeId: string, presentation: Pick<VisualizeHostContext, 'theme' | 'locale' | 'viewport'>): Promise<{ sessionId: string; nodeId: string; dispatch(request: VisualizeBridgeRequest, bytes?: ArrayBuffer): Promise<VisualizeBridgeResponse>; close(): Promise<void> }> {
  const path = '/v1/projects/' + encodeURIComponent(scope.projectId) + '/graphs/' + encodeURIComponent(scope.graphId) + '/visualize/' + encodeURIComponent(nodeId) + '/bridge';
  const identity = await transport.request<{ sessionId: string; nodeId: string }>(path, presentation);
  if (!identity || identity.nodeId !== nodeId || typeof identity.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.sessionId)) throw new VisualizeValidationError('INVALID_REQUEST', '工作空间返回了无效的页面会话。');
  let closed = false;
  return { ...identity, async dispatch(value, bytes) {
    if (closed) throw new VisualizeValidationError('SESSION_EXPIRED', '页面会话已关闭。');
    const request = validateVisualizeBridgeRequest(value);
    if (request.sessionId !== identity.sessionId || request.nodeId !== nodeId) throw new VisualizeValidationError('SESSION_EXPIRED', '页面会话与当前节点不一致。');
    if (request.method === 'exportAsset' && (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== request.params.bytes)) throw new VisualizeValidationError('INVALID_REQUEST', 'Missing asset bytes');
    const body = request.method === 'exportAsset' ? { payload: new Blob([visualizeAssetHeader(request) as BlobPart, bytes!], { type: VISUALIZE_ASSET_BINARY_MIME }), idempotencyKey: request.requestId } : request;
    const result = validateVisualizeBridgeResponse(await transport.request(path + '/' + identity.sessionId + (request.method === 'exportAsset' ? '/asset' : ''), body));
    if (closed || result.sessionId !== request.sessionId || result.nodeId !== nodeId || result.requestId !== request.requestId || result.method !== request.method) throw new VisualizeValidationError('SESSION_EXPIRED', '页面响应与当前会话不一致。');
    return result;
  }, async close() { if (closed) return; closed = true; await transport.request(path + '/' + identity.sessionId, undefined, 'DELETE'); } };
}
