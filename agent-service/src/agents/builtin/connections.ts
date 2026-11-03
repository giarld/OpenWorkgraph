import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AGENT_MODEL_CATALOG_LIMIT } from '@openworkgraph/protocol';
import type { BuiltinAgentConnection, BuiltinAgentConnectionConfiguration, BuiltinAgentDiscoveredModel, BuiltinAgentModel, FrozenBuiltinAgentConnection } from '@openworkgraph/protocol';
import { atomic } from '../../persistence/database.js';
import { Repositories } from '../../persistence/repositories.js';
import { isPrivateNetworkHost } from '../../network.js';
import { ServiceError } from '../../errors.js';
import { AgentError } from '../errors.js';
import { exactKeys, isPlainRecord, publicText } from '../configuration.js';
import type { BuiltinAgentCredentials } from './credentials.js';
import { BUILTIN_AGENT_LIMITS } from './limits.js';

interface StoredConnection extends BuiltinAgentConnectionConfiguration { credentialRevision: number | null; credentialNamespace: string }
const invalid = (): never => { throw new AgentError('invalid_configuration'); };
const conflict = (): never => { throw new ServiceError('REVISION_CONFLICT', '连接配置已变化，请刷新后重试。'); };
function connectionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) invalid();
}
function revisionNumber(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) invalid();
}
function modelId(value: unknown): asserts value is string {
  if (!publicText(value, 128) || value !== value.trim() || Buffer.byteLength(value) > 128 || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
}
export function builtinModelIdentity(id: string, model: string, workspaceId: string): string {
  connectionId(id); modelId(model);
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) return invalid();
  return workspaceId + ':' + id + '/' + model;
}
export function parseBuiltinModelIdentity(value: string): { workspaceId: string; connectionId: string; modelId: string } {
  if (typeof value !== 'string') return invalid();
  const split = value.indexOf('/');
  const delimiter = value.indexOf(':'), workspaceId = value.slice(0, delimiter);
  const id = value.slice(delimiter + 1, split), model = value.slice(split + 1);
  connectionId(id);
  modelId(model);
  if (builtinModelIdentity(id, model, workspaceId) !== value) return invalid();
  return { workspaceId, connectionId: id, modelId: model };
}
export function builtinEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && isPrivateNetworkHost(url.hostname)) || url.username || url.password || url.search || url.hash || url.port === '0') return invalid();
  return url.origin + url.pathname.replace(/\/+$/, '');
}
export function validateBuiltinModel(value: unknown): BuiltinAgentModel {
  if (!isPlainRecord(value) || !exactKeys(value, ['id', 'name', 'tools', 'inputKinds', 'contextWindow', 'reasoningEfforts', 'maxOutputTokens'])) return invalid();
  modelId(value.id);
  if (!publicText(value.name, 150) || value.name !== value.name.trim() || !(value.tools === null || typeof value.tools === 'boolean') ||
      !Array.isArray(value.inputKinds) || value.inputKinds.length < 1 || value.inputKinds.length > 6 || !value.inputKinds.every(kind => ['text', 'image', 'document', 'video', 'audio', 'file'].includes(String(kind))) || new Set(value.inputKinds).size !== value.inputKinds.length || !value.inputKinds.includes('text') ||
      !(value.contextWindow === null || Number.isSafeInteger(value.contextWindow) && Number(value.contextWindow) >= 4096 && Number(value.contextWindow) <= 10000000) ||
      value.maxOutputTokens !== undefined && value.maxOutputTokens !== null && (!Number.isSafeInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1024 || Number(value.maxOutputTokens) > BUILTIN_AGENT_LIMITS.maxOutputTokens) ||
      !Array.isArray(value.reasoningEfforts) || value.reasoningEfforts.length > 16 || value.reasoningEfforts.some(effort => !publicText(effort, 64) || effort !== effort.trim()) || new Set(value.reasoningEfforts).size !== value.reasoningEfforts.length) return invalid();
  return structuredClone(value) as unknown as BuiltinAgentModel;
}
export function validateBuiltinConnection(value: unknown): BuiltinAgentConnectionConfiguration {
  if (!isPlainRecord(value) || !exactKeys(value, ['id', 'name', 'protocol', 'endpoint', 'chatProvider', 'enabled', 'models'])) return invalid();
  connectionId(value.id);
  if (!publicText(value.name, 150) || value.name !== value.name.trim() || !['responses', 'chat-completions'].includes(String(value.protocol)) || typeof value.enabled !== 'boolean' || !Array.isArray(value.models) || value.models.length > 512) return invalid();
  if (value.chatProvider !== undefined && value.chatProvider !== 'openai' && value.chatProvider !== 'openai-compatible') return invalid();
  const models = value.models.map(validateBuiltinModel);
  if (new Set(models.map(model => model.id)).size !== models.length) return invalid();
  if (value.protocol === 'chat-completions' && models.some(model => model.reasoningEfforts.some(effort => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)))) throw new AgentError('invalid_configuration', 'Chat Completions 连接包含不支持的思考强度。');
  return { id: value.id, name: value.name, protocol: value.protocol as BuiltinAgentConnectionConfiguration['protocol'], endpoint: builtinEndpoint(value.endpoint), ...(value.chatProvider === undefined ? {} : { chatProvider: value.chatProvider }), enabled: value.enabled, models };
}

/** The service DB serializes accept/delete across processes. No secret value
 * belongs here; immutable revisions reference protected credential revisions. */
export class BuiltinAgentConnections {
  readonly workspaceId: string;
  constructor(private readonly db: DatabaseSync, private readonly credentials?: BuiltinAgentCredentials) {
    const identity = db.prepare('SELECT service_id FROM identity WHERE singleton=1').get();
    this.workspaceId = identity ? String(identity.service_id) : new Repositories(db).identity();
  }
  private row(id: string, includeDeleted = false): { revision: number; value: StoredConnection } {
    connectionId(id);
    const row = this.db.prepare('SELECT revision,payload,deleted FROM builtin_agent_connections WHERE id=?').get(id);
    if (!row || row.deleted && !includeDeleted) throw new ServiceError('NOT_FOUND', '连接不存在。');
    try {
      const raw = JSON.parse(String(row.payload)) as StoredConnection;
      const { credentialRevision, credentialNamespace, ...configuration } = raw;
      if (!(credentialRevision === null || Number.isSafeInteger(credentialRevision) && Number(credentialRevision) > 0)) return invalid();
      if (typeof credentialNamespace !== 'string' || !/^[a-f0-9-]{36}$/.test(credentialNamespace)) return invalid();
      const value = { ...validateBuiltinConnection(configuration), credentialRevision, credentialNamespace };
      if (value.id !== id) return invalid();
      return { revision: Number(row.revision), value };
    } catch { throw new ServiceError('MAINTENANCE', '连接配置不可读取。'); }
  }
  private public(value: StoredConnection, revision: number): BuiltinAgentConnection {
    const { credentialRevision, credentialNamespace: _namespace, ...configuration } = value;
    return { ...structuredClone(configuration), revision, credentialConfigured: credentialRevision !== null };
  }
  get(id: string): BuiltinAgentConnection { const row = this.row(id); return this.public(row.value, row.revision); }
  list(): BuiltinAgentConnection[] {
    return this.db.prepare('SELECT id FROM builtin_agent_connections WHERE deleted=0 ORDER BY id').all().map(row => this.get(String(row.id)));
  }
  async listConfigured(): Promise<BuiltinAgentConnection[]> {
    const items = this.list();
    const result = await Promise.all(items.map(async item => {
      const row = this.row(item.id);
      const configured = row.value.credentialRevision !== null && !!await this.credentials?.available(item.id + '.' + row.value.credentialNamespace, row.value.credentialRevision);
      if (this.row(item.id).revision !== item.revision) return conflict();
      return { ...item, credentialConfigured: configured };
    }));
    return result;
  }
  private persist(value: StoredConnection, expected: number): BuiltinAgentConnection {
    const payload = JSON.stringify(value), next = expected + 1;
    const changed = expected === 0
      ? this.db.prepare('INSERT OR IGNORE INTO builtin_agent_connections(id,revision,payload) VALUES(?,?,?)').run(value.id, next, payload)
      : this.db.prepare('UPDATE builtin_agent_connections SET revision=?,payload=? WHERE id=? AND revision=? AND deleted=0').run(next, payload, value.id, expected);
    if (changed.changes !== 1) return conflict();
    this.db.prepare('INSERT INTO builtin_agent_connection_versions(connection_id,revision,payload) VALUES(?,?,?)').run(value.id, next, payload);
    return this.public(value, next);
  }
  set(configuration: BuiltinAgentConnectionConfiguration, expected: number): BuiltinAgentConnection {
    const value = validateBuiltinConnection(configuration); revisionNumber(expected);
    return atomic(this.db, () => {
      const old = expected === 0 ? undefined : this.row(value.id);
      if (old && old.revision !== expected) return conflict();
      const totals = this.db.prepare("SELECT count(*) AS connections,coalesce(sum(json_array_length(payload,'$.models')),0) AS models FROM builtin_agent_connections WHERE deleted=0").get()!;
      if ((!old && Number(totals.connections) >= 64) || Number(totals.models) - (old?.value.models.length ?? 0) + value.models.length > AGENT_MODEL_CATALOG_LIMIT) throw new AgentError('invalid_configuration', '连接或模型目录已达到数量上限。');
      return this.persist({ ...value, credentialRevision: old?.value.credentialRevision ?? null, credentialNamespace: old?.value.credentialNamespace ?? randomUUID() }, expected);
    });
  }
  async setCredential(id: string, value: string, expected: number): Promise<BuiltinAgentConnection> {
    return (await this.prepareCredential(id, value, expected))();
  }
  async prepareCredential(id: string, value: string, expected: number): Promise<() => BuiltinAgentConnection> {
    connectionId(id); revisionNumber(expected);
    const before = this.row(id);
    if (before.revision !== expected) return conflict();
    if (!this.credentials) throw new AgentError('authentication_required');
    // An orphan revision after failed CAS is never reused or selected.
    const credentialRevision = await this.credentials.write(id + '.' + before.value.credentialNamespace, value);
    return () => atomic(this.db, () => {
      const current = this.row(id);
      if (current.revision !== expected || current.value.credentialNamespace !== before.value.credentialNamespace) return conflict();
      return this.persist({ ...current.value, credentialRevision }, expected);
    });
  }
  freeze(identity: string): FrozenBuiltinAgentConnection {
    const selected = parseBuiltinModelIdentity(identity);
    if (selected.workspaceId !== this.workspaceId) throw new AgentError('model_unavailable');
    const row = this.row(selected.connectionId);
    if (!row.value.enabled) throw new AgentError('runtime_unavailable');
    if (!row.value.models.some(model => model.id === selected.modelId)) throw new AgentError('model_unavailable');
    if (row.value.credentialRevision === null) throw new AgentError('authentication_required');
    return { ...selected, revision: row.revision };
  }
  assertCurrent(reference: FrozenBuiltinAgentConnection): void {
    if (reference.workspaceId !== this.workspaceId) throw new AgentError('model_unavailable');
    const row = this.row(reference.connectionId);
    if (!row.value.enabled) throw new AgentError('runtime_unavailable');
    if (row.revision !== reference.revision) return conflict();
    if (!row.value.models.some(model => model.id === reference.modelId)) throw new AgentError('model_unavailable');
  }
  withCurrent<T>(reference: FrozenBuiltinAgentConnection, accept: () => T): T {
    return atomic(this.db, () => { this.assertCurrent(reference); return accept(); });
  }
  frozen(reference: FrozenBuiltinAgentConnection): { configuration: BuiltinAgentConnectionConfiguration; model: BuiltinAgentModel; credentialRevision: number; credentialNamespace: string } {
    if (reference.workspaceId !== this.workspaceId) throw new AgentError('model_unavailable');
    connectionId(reference.connectionId); revisionNumber(reference.revision); modelId(reference.modelId);
    const row = this.db.prepare('SELECT payload FROM builtin_agent_connection_versions WHERE connection_id=? AND revision=?').get(reference.connectionId, reference.revision);
    if (!row) throw new AgentError('invalid_configuration');
    try {
      const { credentialRevision, credentialNamespace, ...raw } = JSON.parse(String(row.payload)) as StoredConnection;
      const configuration = validateBuiltinConnection(raw), model = configuration.models.find(item => item.id === reference.modelId);
      if (configuration.id !== reference.connectionId) throw new AgentError('invalid_configuration');
      if (!model) throw new AgentError('model_unavailable');
      if (!credentialRevision || typeof credentialNamespace !== 'string' || !/^[a-f0-9-]{36}$/.test(credentialNamespace)) throw new AgentError('authentication_required');
      return { configuration, model, credentialRevision, credentialNamespace };
    } catch (error) { if (error instanceof AgentError) throw error; throw new AgentError('invalid_configuration'); }
  }
  private inUse(id: string): boolean {
    const prefix = this.workspaceId + ':' + id + '/';
    return !!this.db.prepare(`SELECT 1 FROM runs r JOIN snapshots s ON s.run_id=r.id
      WHERE r.status NOT IN ('succeeded','failed','cancelled','interrupted')
      AND json_extract(s.payload,'$.agent.backendId')='builtin'
      AND substr(json_extract(s.payload,'$.agent.model.model'),1,?)=? LIMIT 1`).get(prefix.length, prefix);
  }
  private credentialVersions(id: string): { namespace: string; revision: number }[] {
    return this.db.prepare(`SELECT json_extract(payload,'$.credentialNamespace') AS namespace, max(CAST(json_extract(payload,'$.credentialRevision') AS INTEGER)) AS revision
      FROM builtin_agent_connection_versions WHERE connection_id=? AND json_extract(payload,'$.credentialRevision') IS NOT NULL GROUP BY namespace`).all(id).map(row => ({ namespace: String(row.namespace), revision: Number(row.revision) }));
  }
  private revokeVersions(id: string): { namespace: string; revision: number }[] {
    const versions = this.credentialVersions(id);
    for (const value of versions) this.db.prepare('INSERT INTO builtin_agent_credential_revocations(connection_id,credential_namespace,through_revision) VALUES(?,?,?) ON CONFLICT(connection_id,credential_namespace) DO UPDATE SET through_revision=max(through_revision,excluded.through_revision)').run(id, value.namespace, value.revision);
    return versions;
  }
  delete(id: string, expected: number): void {
    connectionId(id); revisionNumber(expected);
    atomic(this.db, () => {
      const row = this.row(id); if (row.revision !== expected) return conflict();
      if (this.inUse(id)) throw new ServiceError('CONFLICT', '连接仍被未结束任务使用；可先停用，待任务结束后删除。');
      this.revokeVersions(id);
      this.db.prepare('UPDATE builtin_agent_connections SET deleted=1,revision=revision+1 WHERE id=?').run(id);
    });
  }
  async cleanupDeleted(id: string): Promise<void> {
    connectionId(id);
    if (!this.db.prepare('SELECT 1 FROM builtin_agent_connections WHERE id=? AND deleted=1').get(id)) throw new AgentError('invalid_configuration');
    for (const version of this.credentialVersions(id)) await this.credentials?.revokeLatest(id + '.' + version.namespace);
  }
  revokeCredentialCommit(id: string, expected: number): { value: BuiltinAgentConnection; cleanup: () => Promise<void> } {
    connectionId(id); revisionNumber(expected);
    let revoked: { namespace: string; revision: number }[] = [];
    const value = atomic(this.db, () => {
      const current = this.row(id); if (current.revision !== expected) return conflict();
      if (current.value.credentialRevision === null) return this.get(id);
      revoked = this.revokeVersions(id);
      return this.persist({ ...current.value, credentialRevision: null }, expected);
    });
    return { value, cleanup: async () => { for (const version of revoked) await this.credentials?.revoke(id + '.' + version.namespace, version.revision); } };
  }
  async revokeCredential(id: string, expected: number): Promise<BuiltinAgentConnection> {
    const committed = this.revokeCredentialCommit(id, expected); await committed.cleanup().catch(() => {}); return committed.value;
  }
  async dispatch<T>(reference: FrozenBuiltinAgentConnection, request: (config: BuiltinAgentConnectionConfiguration, model: BuiltinAgentModel, key: string) => T): Promise<{ value: T }> {
    const frozen = this.frozen(reference);
    if (!this.credentials) throw new AgentError('authentication_required');
    return this.credentials.dispatch(reference.connectionId + '.' + frozen.credentialNamespace, frozen.credentialRevision, key => atomic(this.db, () => {
      const revoked = this.db.prepare('SELECT through_revision FROM builtin_agent_credential_revocations WHERE connection_id=? AND credential_namespace=?').get(reference.connectionId, frozen.credentialNamespace);
      if (revoked && frozen.credentialRevision <= Number(revoked.through_revision)) throw new AgentError('authentication_required');
      // Request dispatch is synchronous under the same writer lock as revoke.
      return { value: request(frozen.configuration, frozen.model, key) };
    }).value);
  }
  async discover(id: string, expected: number, signal: AbortSignal): Promise<BuiltinAgentDiscoveredModel[]> {
    const row = this.row(id);
    return this.discoverDraft({ id, expectedRevision: expected, endpoint: row.value.endpoint, protocol: row.value.protocol }, signal);
  }
  async discoverDraft(draft: unknown, signal: AbortSignal): Promise<BuiltinAgentDiscoveredModel[]> {
    if (!isPlainRecord(draft) || !exactKeys(draft, ['protocol', 'endpoint', 'value', 'id', 'expectedRevision']) || draft.protocol !== 'responses' && draft.protocol !== 'chat-completions') return invalid();
    const endpoint = builtinEndpoint(draft.endpoint), protocol = draft.protocol;
    let dispatch: (bounded: AbortSignal) => Promise<Response>, assertCurrent = () => {};
    if (draft.value !== undefined) {
      if (draft.id !== undefined || draft.expectedRevision !== undefined || typeof draft.value !== 'string' || !draft.value.trim() || draft.value.length > 16384 || /[\r\n\0]/.test(draft.value)) return invalid();
      const key = draft.value;
      dispatch = async bounded => {
        bounded.throwIfAborted();
        return fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: bounded, redirect: 'error' });
      };
    } else {
      connectionId(draft.id); revisionNumber(draft.expectedRevision);
      const id = draft.id, expected = draft.expectedRevision, row = this.row(id);
      if (row.revision !== expected) return conflict();
      if (endpoint !== row.value.endpoint) throw new AgentError('invalid_configuration', 'API 地址已更改，请填写此地址的 API 密钥以获取模型列表。');
      if (!row.value.credentialRevision || !this.credentials) throw new AgentError('authentication_required');
      assertCurrent = () => {
        if (this.row(id).revision !== expected) return conflict();
        const revoked = this.db.prepare('SELECT through_revision FROM builtin_agent_credential_revocations WHERE connection_id=? AND credential_namespace=?').get(id, row.value.credentialNamespace);
        if (revoked && row.value.credentialRevision! <= Number(revoked.through_revision)) throw new AgentError('authentication_required');
      };
      dispatch = async bounded => {
        const { value } = await this.credentials!.dispatch(id + '.' + row.value.credentialNamespace, row.value.credentialRevision!, key => {
          bounded.throwIfAborted();
          return atomic(this.db, () => {
            assertCurrent();
            return { value: fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: bounded, redirect: 'error' }) };
          }).value;
        });
        return value;
      };
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    try {
      const response = await dispatch(bounded);
      if (!response.ok) { await response.body?.cancel(); throw new AgentError(response.status === 401 || response.status === 403 ? 'authentication_required' : response.status === 429 ? 'quota_exceeded' : 'model_unavailable'); }
      if (!response.body) throw new AgentError('protocol_error');
      let bytes = 0; const parts: Uint8Array[] = [];
      const reader = response.body.getReader();
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new AgentError('protocol_error'); parts.push(chunk.value); }
      } finally { await reader.cancel().catch(() => {}); }
      const raw = JSON.parse(Buffer.concat(parts).toString('utf8')) as { data?: unknown };
      if (!Array.isArray(raw.data) || raw.data.length > 4096) throw new AgentError('protocol_error');
      const seen = new Set<string>();
      const models = raw.data.map(value => {
        if (!isPlainRecord(value)) return invalid(); modelId(value.id);
        if (seen.has(value.id)) throw new AgentError('protocol_error'); seen.add(value.id);
        const model: BuiltinAgentDiscoveredModel = { id: value.id, name: publicText(value.name, 150) && value.name === value.name.trim() ? value.name : value.id };
        const reasoning = isPlainRecord(value.reasoning) ? value.reasoning : undefined;
        const efforts = reasoning?.supported_efforts ?? value.reasoning_efforts ?? value.supported_reasoning_efforts ?? value.reasoningEfforts;
        if (Array.isArray(efforts) && efforts.length <= 16 && efforts.every(effort => publicText(effort, 64) && effort === effort.trim())) {
          model.reasoningEfforts = [...new Set<string>(efforts)];
          if (protocol === 'chat-completions') model.reasoningEfforts = model.reasoningEfforts.filter(effort => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort));
        }
        const capacity = value.context_length ?? value.context_window ?? value.contextWindow ?? value.max_model_len;
        if (Number.isSafeInteger(capacity) && Number(capacity) >= 4096 && Number(capacity) <= 10000000) model.contextWindow = Number(capacity);
        const architecture = isPlainRecord(value.architecture) ? value.architecture : undefined;
        const modalities = architecture?.input_modalities ?? value.input_modalities ?? value.inputKinds;
        if (Array.isArray(modalities) && modalities.length <= 16 && modalities.every(kind => typeof kind === 'string')) {
          model.inputKinds = ['text', ...new Set(modalities.filter((kind): kind is 'image' | 'video' | 'audio' => ['image', 'video', 'audio'].includes(kind)))];
        }
        return model;
      });
      bounded.throwIfAborted();
      assertCurrent();
      return models;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (bounded.aborted) throw new AgentError('timeout');
      if (error instanceof AgentError || error instanceof ServiceError && error.code === 'REVISION_CONFLICT') throw error;
      throw new AgentError('model_unavailable');
    }
  }
}
