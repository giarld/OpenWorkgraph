import { join } from 'node:path';
import type { DataDirectories } from '../../directories.js';
import type { SkillConfigSchema } from '@openworkgraph/protocol';
import { SkillConfigs } from '../../skill-configs.js';
import { AgentError } from '../errors.js';

const schema: SkillConfigSchema = { version: 1, environment: [{ name: 'API_KEY', label: 'API key', description: 'Model request authentication', secret: true, required: true }] };
/** Reuse OS ownership/ACL, immutable revisions, revocation and dispatch leases.
 * A separate root prevents skill APIs from resolving model authentication. */
export class BuiltinAgentCredentials {
  private readonly storage: SkillConfigs;
  private dispatching: Promise<void> = Promise.resolve();
  constructor(directories: DataDirectories, serviceId: string) {
    this.storage = new SkillConfigs({ ...directories, config: join(directories.config, 'builtin-agent-credentials') }, serviceId);
  }
  async write(id: string, value: string): Promise<number> {
    if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\r\n\0]/.test(value)) throw new AgentError('invalid_configuration');
    const current = await this.storage.revision(id);
    return (await this.storage.write(id, schema, { expectedRevision: current, values: { API_KEY: value } })).revision;
  }
  async revoke(id: string, expectedRevision: number): Promise<void> {
    await this.storage.clear(id, expectedRevision);
  }
  async revokeLatest(id: string): Promise<void> { await this.storage.clear(id, await this.storage.revision(id)); }
  async available(id: string, revision: number): Promise<boolean> {
    try { return !!(await this.storage.environment(id, schema, revision)).API_KEY; } catch { return false; }
  }
  async dispatch<T>(id: string, revision: number, request: (key: string) => T): Promise<{ value: T }> {
    // The cross-process filesystem lease already serializes dispatch. Avoid
    // making this process contend with itself (notably Windows directory
    // rename vs owner reads) when the main model and naming start together.
    // Only credential validation + synchronous dispatch is queued; never HTTP.
    const previous = this.dispatching;
    let release!: () => void;
    this.dispatching = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.storage.withRevisions([{ skillId: id, revision, schema }], values => {
        const key = values.get(id)?.API_KEY;
        if (!key) throw new AgentError('authentication_required');
        return request(key);
      });
    } catch (error) { throw new AgentError(error instanceof AgentError ? error.reason : 'authentication_required'); }
    finally { release(); }
  }
}
