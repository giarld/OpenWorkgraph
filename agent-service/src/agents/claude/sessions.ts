import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendRunContext } from '../../backend/types.js';
import { within } from '../../backend/paths.js';
import { AgentError } from '../errors.js';
import { canonicalJsonHash } from '../../persistence/repositories.js';
import type { Json } from '@openworkgraph/protocol';

interface Session { version: 1; runId: string; fingerprint: string; sessionId: string; pid: number | null; drained: boolean }
const fingerprint = (context: BackendRunContext) => canonicalJsonHash(JSON.parse(JSON.stringify({ agent: context.agent, kind: context.kind, projectPath: context.projectPath, prompt: context.prompt, resources: context.resources, projectFiles: context.projectFiles, skills: context.skills, features: context.features, visualizeGeneration: context.visualizeGeneration })) as Json);
const sessionIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

/** Host-owned session identity, outside task inputs/outputs. It authorizes only
 * the same frozen Run; a native session id is never accepted from Web input. */
export class ClaudeSessionStore {
  private directory = '';
  private file = '';
  private value?: Session;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly context: BackendRunContext) {}
  async initialize(): Promise<string | undefined> {
    const root = await realpath(this.context.serviceRoot);
    const directory = join(root, 'config', 'agent-sessions', 'claude'); await mkdir(directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(directory); if (!within(root, this.directory)) throw new AgentError('invalid_configuration');
    this.file = join(this.directory, createHash('sha256').update(this.context.runId).digest('hex') + '.json');
    let file;
    try { file = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AgentError('invalid_configuration'); }
    try {
      const info = await file.stat(); if (!info.isFile() || info.size > 16384) throw new AgentError('invalid_configuration');
      const value = JSON.parse(await file.readFile('utf8')) as Session;
      if (!value || Object.keys(value).sort().join(',') !== 'drained,fingerprint,pid,runId,sessionId,version' || value.version !== 1 || value.runId !== this.context.runId || typeof value.drained !== 'boolean' || typeof value.sessionId !== 'string' || !sessionIdentity.test(value.sessionId) || value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid < 1)) throw new AgentError('invalid_configuration');
      if (!value.drained || value.pid && alive(value.pid)) throw new AgentError('outcome_unknown');
      if (value.fingerprint !== fingerprint(this.context)) throw new AgentError('invalid_configuration');
      this.value = value; return value.sessionId;
    } catch (error) { throw error instanceof AgentError ? error : new AgentError('invalid_configuration'); }
    finally { await file.close(); }
  }
  record(sessionId: string, pid: number | null, drained = false): Promise<void> {
    if (!this.file || !sessionIdentity.test(sessionId)) return Promise.reject(new AgentError('protocol_error'));
    this.value = { version: 1, runId: this.context.runId, fingerprint: fingerprint(this.context), sessionId, pid, drained };
    const content = JSON.stringify(this.value);
    this.writes = this.writes.then(async () => {
      const temporary = join(this.directory, randomUUID() + '.tmp');
      try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, this.file); }
      finally { await rm(temporary, { force: true }); }
    });
    return this.writes;
  }
  async closed(): Promise<void> { await this.writes; if (this.value) await this.record(this.value.sessionId, null, true); }
}
