import { visualizeAssetHeader, VISUALIZE_ASSET_BINARY_MIME, validateVisualizeBridgeRequest, validateVisualizeBridgeResponse, validateVisualizeCapabilityUpdate, VisualizeValidationError } from '../../../packages/protocol/src/index';
import type { GraphScope, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeHostContext, VisualizeStoredNode } from '../../../packages/protocol/src/index';
import type { Transport } from '../adapter/transport';

/** Only the host receives Transport; the isolated iframe gets protocol identity. */
export async function openVisualizeBridge(transport: Pick<Transport, 'request'>, scope: GraphScope, nodeId: string, presentation: Pick<VisualizeHostContext, 'theme' | 'locale' | 'viewport'>): Promise<{ sessionId: string; nodeId: string; stored?: VisualizeStoredNode; context?: VisualizeHostContext; dispatch(request: VisualizeBridgeRequest, bytes?: ArrayBuffer): Promise<VisualizeBridgeResponse>; keepAlive(): Promise<VisualizeHostContext['capabilities']>; close(): Promise<void> }> {
  const path = '/v1/projects/' + encodeURIComponent(scope.projectId) + '/graphs/' + encodeURIComponent(scope.graphId) + '/visualize/' + encodeURIComponent(nodeId) + '/bridge';
  const identity = await transport.request<{ sessionId: string; nodeId: string; stored?: VisualizeStoredNode; context?: VisualizeHostContext }>(path, presentation);
  if (!identity || identity.nodeId !== nodeId || typeof identity.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.sessionId)) throw new VisualizeValidationError('INVALID_REQUEST', '工作空间返回了无效的页面会话。');
  const sessionIdentity = { sessionId: identity.sessionId, nodeId };
  if (identity.context) validateVisualizeBridgeResponse({ channel: 'openworkgraph.visualize', version: 1, ...sessionIdentity, requestId: 'open', type: 'response', method: 'initialize', ok: true, result: identity.context });
  if (identity.stored && (identity.stored.serviceId !== scope.serviceId || identity.stored.projectId !== scope.projectId || identity.stored.graphId !== scope.graphId || identity.stored.nodeId !== nodeId)) throw new VisualizeValidationError('INVALID_REQUEST', '页面启动数据不属于当前节点。');
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
  }, async keepAlive() {
    if (closed) throw new VisualizeValidationError('SESSION_EXPIRED', '页面会话已关闭。');
    const capabilities = await transport.request(path + '/' + identity.sessionId + '/keepalive', {});
    if (closed) throw new VisualizeValidationError('SESSION_EXPIRED', '页面会话已关闭。');
    return validateVisualizeCapabilityUpdate({ channel: 'openworkgraph.visualize', version: 1, ...sessionIdentity, type: 'capabilities', capabilities }).capabilities;
  }, async close() { if (closed) return; closed = true; await transport.request(path + '/' + identity.sessionId, undefined, 'DELETE'); } };
}
