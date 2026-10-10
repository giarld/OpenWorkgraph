import type { IncomingMessage } from 'node:http';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { readVisualizeAssetBinary, VISUALIZE_ASSET_BINARY_MIME, VISUALIZE_ASSET_MAX_BYTES, VISUALIZE_ASSET_HEADER_MAX_BYTES } from '@openworkgraph/protocol';
import { readBinary, readJson } from './http.js';
import { ServiceError } from './errors.js';
import { VisualizePages } from './visualize-pages.js';
import { VisualizeInputs } from './visualize-inputs.js';
import { VisualizeBridge } from './visualize-bridge.js';
import { visualizeChecked } from './visualize-content.js';

/** Auth is rechecked after every filesystem preparation/read before returning data. */
export class VisualizeApi {
  constructor(readonly pages: VisualizePages, readonly auth: Auth, readonly inputs: VisualizeInputs, readonly bridge: VisualizeBridge) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    const match = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]visualize[/]([a-zA-Z0-9_-]+)([/]inputs|[/]bridge(?:[/]([a-zA-Z0-9_-]+)([/]asset)?)?)?$/.exec(path);
    if (!match) return { handled: false };
    const principal = this.auth.withSession(token, origin, session => session.id);
    const scope = { serviceId: this.pages.graphs.serviceId, projectId: match[1]!, graphId: match[2]! }, nodeId = match[3]!;
    if (match[4]?.startsWith('/bridge')) {
      const guard = <T>(work: () => T): T => this.auth.withSession(token, origin, work);
      if (request.method === 'DELETE' && match[5] && !match[6]) return guard(() => { this.bridge.close(scope, nodeId, match[5]!, principal); return { handled: true, body: { closed: true } }; });
      if (request.method !== 'POST') throw new ServiceError('NOT_FOUND', '可视化页面桥接口不存在。');
      if (match[6]) {
        if (request.headers['content-type'] !== VISUALIZE_ASSET_BINARY_MIME) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', '资产导出须使用二进制协议。');
        const binary = await readBinary(request, VISUALIZE_ASSET_MAX_BYTES + VISUALIZE_ASSET_HEADER_MAX_BYTES + 4);
        const { request: body, bytes } = visualizeChecked(() => readVisualizeAssetBinary(binary));
        if (body.sessionId !== match[5]) throw new ServiceError('INVALID_REQUEST', '页面会话与接口地址不一致。');
        const value = await this.bridge.handle(scope, nodeId, principal, body, guard, bytes).catch(error => visualizeChecked(() => { throw error; }));
        return guard(() => ({ handled: true, body: value }));
      }
      const body = await readJson(request, 2_097_152);
      if (!match[5]) {
        const value = await this.bridge.open(scope, nodeId, principal, body, guard).catch(error => visualizeChecked(() => { throw error; }));
        return guard(() => ({ handled: true, body: value }));
      }
      if (body.sessionId !== match[5]) throw new ServiceError('INVALID_REQUEST', '页面会话与接口地址不一致。');
      const value = await this.bridge.handle(scope, nodeId, principal, body, guard).catch(error => visualizeChecked(() => { throw error; }));
      return guard(() => ({ handled: true, body: value }));
    }
    if (match[4]) {
      if (request.method !== 'GET') throw new ServiceError('NOT_FOUND', '可视化输入接口不存在。');
      const value = await this.inputs.capture(scope, nodeId);
      return this.auth.withSession(token, origin, () => ({ handled: true, body: value }));
    }
    if (request.method === 'GET') {
      const value = await this.pages.read(scope, nodeId);
      return this.auth.withSession(token, origin, () => ({ handled: true, body: value }));
    }
    if (request.method !== 'POST') throw new ServiceError('NOT_FOUND', '可视化节点接口不存在。');
    const body = await readJson(request, 6_291_456);
    if (['serviceId', 'projectId', 'graphId', 'nodeId'].some(key => Object.hasOwn(body, key))) throw new ServiceError('INVALID_REQUEST', '页面保存范围由当前工作空间决定。');
    const value = { ...body, ...scope, nodeId };
    const replay = this.auth.withSession(token, origin, () => this.pages.replay(value, principal));
    if (replay) return { handled: true, body: replay };
    const prepared = await this.pages.prepare(value, principal);
    try { return this.auth.withSession(token, origin, () => ({ handled: true, body: this.pages.commit(prepared) })); }
    finally { await this.pages.dispose(prepared); }
  }
}
