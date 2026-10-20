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
  constructor(readonly store: AgentWorkspaceConfigurationStore, readonly discovery: AgentDiscovery, readonly auth: Auth, private readonly resolveProject?: (id: string) => string) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    const scoped = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]agents[/]configuration[/]([a-z][a-z0-9._-]*)[/](models|diagnose|catalog)$/.exec(path);
    if (scoped) path = '/v1/agents/configuration/' + scoped[2] + '/' + scoped[3];
    const match = /^[/]v1[/]agents[/]configuration(?:[/]([a-z][a-z0-9._-]*)[/](models|diagnose|catalog))?$/.exec(path);
    if (!match) return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    const projectPath = scoped ? this.auth.withSession(token, origin, () => {
      if (!this.resolveProject) throw new ServiceError('NOT_FOUND', '项目不存在。');
      return this.resolveProject(scoped[1]!);
    }) : undefined;
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
        return backendId ? { backendId, ...this.store.query(backendId, update.section === 'backend' ? update.options : undefined, undefined, update.section === 'backend' ? update.source : undefined) } : undefined;
      });
      const catalog = captured ? await this.discovery.listModels(captured.backendId, { options: captured.options, schemaVersion: captured.schemaVersion, permissions: captured.permissions }) : [];
      return this.auth.withSession(token, origin, () => {
        if (captured && (this.store.getBackend(captured.backendId).revision !== captured.configRevision || this.store.get().permissions.revision !== captured.permissionsRevision)) throw new ServiceError('REVISION_CONFLICT', '模型查询期间配置已变化，请刷新后重试。');
        return { handled: true, body: this.store.set(update, catalog, undefined, captured?.configRevision, captured?.permissionsRevision) };
      });
    }
    const backendId = match[1]; const action = match[2];
    if (backendId && ((['models', 'catalog'].includes(action ?? '') && request.method === 'GET') || (action === 'diagnose' && request.method === 'POST'))) {
      if (body && Object.keys(body).length) throw new ServiceError('INVALID_REQUEST', '诊断请求不接受设备参数。');
      const captured = this.auth.withSession(token, origin, () => this.store.query(backendId));
      const query = { options: captured.options, schemaVersion: captured.schemaVersion, permissions: captured.permissions, ...(projectPath ? { projectPath } : {}) };
      const result = action === 'models' ? await this.discovery.listModels(backendId, query) : action === 'catalog' ? await this.discovery.nativeCatalog(backendId, query) : await this.discovery.diagnose(backendId, query);
      return this.auth.withSession(token, origin, () => {
        if (scoped && this.resolveProject!(scoped[1]!) !== projectPath) throw new ServiceError('REVISION_CONFLICT', '目录查询期间项目已变化。');
        if (this.store.getBackend(backendId).revision !== captured.configRevision || this.store.get().permissions.revision !== captured.permissionsRevision) throw new ServiceError('REVISION_CONFLICT', '查询期间配置已变化，请刷新后重试。');
        return { handled: true, body: action === 'models' ? { backendId, configRevision: captured.configRevision, models: result, configuredModels: this.store.modelDraft(backendId, result as import('@openworkgraph/protocol').AgentModelOption[]) } : result };
      });
    }
    throw new ServiceError('NOT_FOUND', '新版 Agent 配置接口不存在。');
  }
}
