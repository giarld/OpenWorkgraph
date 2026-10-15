import type { IncomingMessage } from 'node:http';
import type { AgentConfigurationUpdate } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { AgentDiscovery } from './agents/discovery.js';
import { validateConfigurationUpdate } from './agents/workspace-configuration-validation.js';
import { AgentWorkspaceConfigurationStore } from './agents/workspace-configuration.js';

/** Mount before RunApi: its legacy route also matches /agents/configuration.
 * Composition owns store.close()/discovery.dispose(); no old settings are read. */
export class AgentConfigurationApi {
  constructor(readonly store: AgentWorkspaceConfigurationStore, readonly discovery: AgentDiscovery, readonly auth: Auth) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    const match = /^[/]v1[/]agents[/]configuration(?:[/]([a-z][a-z0-9._-]*)[/](models|diagnose))?$/.exec(path);
    if (!match) return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    const body = request.method === 'POST' ? await readJson(request, 256 * 1024) : undefined;
    if (!match[1] && request.method === 'GET') return this.auth.withSession(token, origin, () => ({ handled: true, body: this.store.get() }));
    if (!match[1] && request.method === 'POST') {
      validateConfigurationUpdate(body);
      const update: AgentConfigurationUpdate = body;
      // Metadata edits must remain possible when the CLI/catalog is unavailable.
      // New identities and explicit defaults still require model validation.
      if (update.section === 'backend') {
        const existing = this.auth.withSession(token, origin, () => this.store.getBackend(update.backendId));
        if (update.models.every(model => existing.models.some(saved => saved.id === model.id))) {
          return this.auth.withSession(token, origin, () => ({ handled: true, body: this.store.set(update) }));
        }
      }
      // Catalog queries are asynchronous and cannot run inside auth/acceptance SQL transactions.
      const captured = this.auth.withSession(token, origin, () => {
        const backendId = update.section === 'backend' ? update.backendId : update.section === 'default' ? update.selection?.backendId : undefined;
        return backendId ? { backendId, ...this.store.query(backendId, update.section === 'backend' ? update.options : undefined) } : undefined;
      });
      const catalog = captured ? await this.discovery.listModels(captured.backendId, { options: captured.options, schemaVersion: captured.schemaVersion }) : [];
      return this.auth.withSession(token, origin, () => {
        if (captured && (this.store.getBackend(captured.backendId).revision !== captured.configRevision || this.store.get().permissions.revision !== captured.permissionsRevision)) throw new ServiceError('REVISION_CONFLICT', '模型查询期间配置已变化，请刷新后重试。');
        return { handled: true, body: this.store.set(update, catalog, undefined, captured?.configRevision, captured?.permissionsRevision) };
      });
    }
    const backendId = match[1]; const action = match[2];
    if (backendId && ((action === 'models' && request.method === 'GET') || (action === 'diagnose' && request.method === 'POST'))) {
      if (body && Object.keys(body).length) throw new ServiceError('INVALID_REQUEST', '诊断请求不接受设备参数。');
      const captured = this.auth.withSession(token, origin, () => this.store.query(backendId));
      const query = { options: captured.options, schemaVersion: captured.schemaVersion };
      const result = action === 'models' ? await this.discovery.listModels(backendId, query) : await this.discovery.diagnose(backendId, query);
      return this.auth.withSession(token, origin, () => {
        if (this.store.getBackend(backendId).revision !== captured.configRevision || this.store.get().permissions.revision !== captured.permissionsRevision) throw new ServiceError('REVISION_CONFLICT', '查询期间配置已变化，请刷新后重试。');
        return { handled: true, body: action === 'models' ? { backendId, configRevision: captured.configRevision, models: result, configuredModels: this.store.modelDraft(backendId, result as import('@openworkgraph/protocol').AgentModelOption[]) } : result };
      });
    }
    throw new ServiceError('NOT_FOUND', '新版 Agent 配置接口不存在。');
  }
}
