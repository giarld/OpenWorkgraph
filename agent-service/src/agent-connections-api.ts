import type { IncomingMessage } from 'node:http';
import type { Json } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import type { AgentWorkspaceConfigurationStore } from './agents/workspace-configuration.js';
import type { Auth } from './auth.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { exactKeys, isPlainRecord } from './agents/configuration.js';

/** Settings-only plugin bridge. No SDK, provider routing, or model generation
 * exists in the public API. Credentials use write-only, post-IO commits. */
export class AgentConnectionsApi {
  constructor(private readonly store: AgentWorkspaceConfigurationStore, private readonly auth: Auth, private readonly onChanged: (backendId: string) => void = () => {}) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    const route = /^[/]v1[/]agents[/]configuration[/]([a-z][a-z0-9._-]*)[/]connections(?:[/]([A-Za-z0-9_-]+)(?:[/](credentials|revoke|delete|discover))?)?$/.exec(path);
    if (!route || route[2] && !route[3] && route[2] !== 'discover') return { handled: false };
    const authorized = <T>(work: () => T) => this.auth.withSession(token, origin, work);
    const changed = <T>(work: () => T) => authorized(() => { const value = work(); this.onChanged(route[1]!); return value; });
    const settings = authorized(() => this.store.connectionSettings(route[1]!));
    if (!settings) throw new ServiceError('NOT_IMPLEMENTED', '此 Agent 不支持供应商连接配置。');
    if (request.method === 'GET' && !route[2]) { const items = await settings.list(); return authorized(() => ({ handled: true, body: { items } })); }
    if (request.method !== 'POST') throw new ServiceError('NOT_FOUND', '连接配置接口不存在。');
    const body = await readJson(request, 256 * 1024); authorized(() => undefined);
    const discover = async (work: (signal: AbortSignal) => Promise<Json>): Promise<ApiResult> => {
      const controller = new AbortController(), abort = () => controller.abort();
      request.once('aborted', abort); request.socket?.once('close', abort);
      if (request.aborted || request.socket?.destroyed) abort();
      try {
        const models = await work(controller.signal);
        controller.signal.throwIfAborted();
        return authorized(() => ({ handled: true, body: { models } }));
      } finally { request.off('aborted', abort); request.socket?.off('close', abort); }
    };
    if (route[2] === 'discover' && !route[3]) {
      if (!isPlainRecord(body)) throw new ServiceError('INVALID_REQUEST', '模型列表请求无效。');
      if (!settings.discoverDraft) throw new ServiceError('NOT_IMPLEMENTED', '此 Agent 不支持使用未保存的配置获取模型列表。');
      return discover(signal => settings.discoverDraft!(body as Json, signal));
    }
    if (!isPlainRecord(body) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new ServiceError('INVALID_REQUEST', '连接配置请求无效。');
    const expected = Number(body.expectedRevision);
    if (!route[2]) { const { expectedRevision: _revision, ...configuration } = body; return changed(() => ({ handled: true, body: settings.save(configuration as Json, expected) })); }
    const id = route[2], action = route[3];
    if (action === 'credentials') {
      if (!exactKeys(body, ['expectedRevision', 'value']) || typeof body.value !== 'string' || !body.value || body.value.length > 16384) throw new ServiceError('INVALID_REQUEST', '认证输入无效。');
      const commit = await settings.prepareCredential(id, body.value, expected);
      return changed(() => ({ handled: true, body: commit() }));
    }
    if (!exactKeys(body, ['expectedRevision'])) throw new ServiceError('INVALID_REQUEST', '连接配置请求包含无效字段。');
    if (action === 'delete') return changed(() => { settings.remove(id, expected); return { handled: true, body: { deleted: true } }; });
    if (action === 'revoke') {
      const committed = changed(() => settings.revokeCredential(id, expected));
      await committed.cleanup().catch(() => { /* Revocation already committed; unreachable private bytes are not authority. */ });
      return authorized(() => ({ handled: true, body: committed.value }));
    }
    return discover(signal => settings.discover(id, expected, signal));
  }
}
