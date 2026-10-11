import type { IncomingMessage } from 'node:http';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import { VisualizeLibrary } from './visualize-library.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { Events } from './events.js';
import { VISUALIZE_LIBRARY_MAX_JSON_BYTES } from '@openworkgraph/protocol';

export class VisualizeLibraryApi {
  constructor(readonly library: VisualizeLibrary, readonly auth: Auth) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    const save = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]visualize[/]([a-zA-Z0-9_-]+)[/]save-to-library$/.exec(path);
    const install = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]visualize-assets[/]install$/.exec(path);
    const fileImport = /^[/]v1[/]projects[/]([a-zA-Z0-9_-]+)[/]graphs[/]([a-zA-Z0-9_-]+)[/]visualize-assets[/]import$/.exec(path);
    const match = save ?? install ?? fileImport;
    if (!match) return { handled: false };
    const principal = this.auth.withSession(token, origin, session => session.id);
    if (request.method !== 'POST') throw new ServiceError('NOT_FOUND', '交互资产接口不存在。');
    const body = await readJson(request, fileImport ? VISUALIZE_LIBRARY_MAX_JSON_BYTES + 16384 : 16384);
    if (['serviceId', 'projectId', 'graphId', 'nodeId'].some(key => Object.hasOwn(body, key))) throw new ServiceError('INVALID_REQUEST', '交互资产范围由当前工作空间决定。');
    const scope = { serviceId: this.library.graphs.serviceId, projectId: match[1]!, graphId: match[2]! };
    const guard = <T>(work: () => T): T => this.auth.withSession(token, origin, work);
    const value = save ? await this.library.save({ ...body, ...scope, nodeId: save[3]! }, principal, guard) : fileImport ? await this.library.importFile({ ...body, ...scope }, principal, guard) : await this.library.install({ ...body, ...scope }, principal, guard);
    return guard(() => ({ handled: true, body: !save && value && typeof value === 'object' && 'snapshot' in value
      ? { ...value, snapshot: new Events(this.library.graphs.db, scope.serviceId, this.auth).decorate(value.snapshot, principal) }
      : value }));
  }
}
