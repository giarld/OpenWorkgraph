import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Json } from '@openworkgraph/protocol';
import type { AgentRestartContext } from '../contracts.js';
import { canonicalJson } from '../../persistence/repositories.js';
import { OpenCodeActionJournal } from './journal.js';
import { OpenCodeTransport } from './transport.js';
import type { OpenCodeInstanceIdentity } from './instance.js';
import { AgentError } from '../errors.js';
import { stopObservedOpenCodeShellGroup, openCodeProcessRunning, openCodeGroupRunning } from './process-evidence.js';
import { exactKeys, isPlainRecord } from '../configuration.js';
import { isSupportedOpenCodeVersion } from './version.js';
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value as Json)).digest('hex');
async function record(path: string): Promise<Record<string, any>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new AgentError('outcome_unknown');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile()));
  } finally { await file.close(); }
}
const alive = (pid: number) => pid > 0 ? openCodeProcessRunning(pid) : openCodeGroupRunning(-pid);
async function recoveryOwner(context: AgentRestartContext) {
  context.signal.throwIfAborted();
  if (await realpath(context.serviceRoot) !== resolve(context.serviceRoot)) throw new AgentError('outcome_unknown');
  const directory = join(context.serviceRoot, 'config', 'agent-sessions', 'opencode', digest([context.runId, context.attemptId]));
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new AgentError('outcome_unknown');
  const owner = await record(join(directory, 'bootstrap.json'));
  if (owner.version !== 1 || owner.runtime !== 'sdk' || owner.runId !== context.runId || owner.attemptId !== context.attemptId || owner.directory !== directory || owner.projectPath !== context.projectPath || owner.selectionDigest !== digest(context.selection) || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.database !== join(directory, 'opencode.db')) throw new AgentError('outcome_unknown');
  const file = await lstat(join(directory, 'workgraph-native.sqlite'));
  if (!file.isFile() || file.isSymbolicLink()) throw new AgentError('outcome_unknown');
  return { directory, owner: owner as OpenCodeInstanceIdentity };
}
/** Operator resolution is explicit evidence, never an automatic inference from
 * a dead PID. It is scoped to the authenticated original attempt and exact
 * unresolved revision; known surviving processes prevent confirmation. */
export async function openCodeRecoveryOperation(context: AgentRestartContext, input: Json): Promise<Json> {
  if (!isPlainRecord(input) || typeof input.type !== 'string' || !['recovery.inspect', 'recovery.stopObserved', 'recovery.confirmStopped'].includes(input.type)) throw new AgentError('capability_unsupported');
  if (!exactKeys(input, ['type', 'expectedRevision', 'acknowledgement']) || input.type === 'recovery.confirmStopped' && input.acknowledgement !== 'all-independent-work-stopped' || input.type !== 'recovery.inspect' && typeof input.expectedRevision !== 'string') throw new AgentError('invalid_configuration');
  const { directory, owner } = await recoveryOwner(context), journal = new OpenCodeActionJournal(directory, owner);
  try {
    const actions = journal.list().filter(action => !['completed', 'failed', 'cancelled'].includes(action.phase));
    const revision = digest([owner.instanceId, owner.pid, actions]);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) throw new AgentError('outcome_unknown');
    if (input.type === 'recovery.inspect') return { revision, workerAlive: await alive(owner.pid), unresolved: await Promise.all(actions.map(async action => ({ kind: action.kind, id: action.id, phase: action.phase, processEvidence: !!journal.shellProcess(action.id), processAlive: action.pid ? await alive(action.pid) : null }))) };
    if (await alive(owner.pid)) throw new AgentError('outcome_unknown');
    if (input.type === 'recovery.stopObserved') {
      let stopped = 0;
      for (const action of actions) { context.signal.throwIfAborted(); const evidence = journal.shellProcess(action.id); if (evidence) { await stopObservedOpenCodeShellGroup(evidence); stopped++; } }
      return { stopped, confirmed: false, revision };
    }
    for (const action of actions) {
      context.signal.throwIfAborted();
      const evidence = journal.shellProcess(action.id);
      if (evidence && await alive(-evidence.groupId) || action.pid && await alive(action.pid)) throw new AgentError('outcome_unknown');
    }
    if (await alive(owner.pid)) throw new AgentError('outcome_unknown');
    journal.confirmStopped(revision); return { confirmed: true, evidence: 'explicit-operator-confirmation' };
  } finally { journal.close(); }
}
/** Recovery owns only the persisted Run/attempt and authenticated original
 * instance. It never launches a replacement SDK, resumes or resends a prompt. */
export async function recoverOpenCodeRun(context: AgentRestartContext): Promise<'drained' | 'unknown'> {
  let journal: OpenCodeActionJournal | undefined;
  try {
    context.signal.throwIfAborted();
    if (await realpath(context.serviceRoot) !== resolve(context.serviceRoot)) return 'unknown';
    const directory = join(context.serviceRoot, 'config', 'agent-sessions', 'opencode', digest([context.runId, context.attemptId]));
    try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) return 'unknown'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'drained' : 'unknown'; }
    const owner = await record(join(directory, 'bootstrap.json'));
    if (owner.version !== 1 || owner.runtime !== 'sdk' || owner.runId !== context.runId || owner.attemptId !== context.attemptId || owner.directory !== directory || owner.projectPath !== context.projectPath || owner.selectionDigest !== digest(context.selection) || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.database !== join(directory, 'opencode.db')) return 'unknown';
    const identity = owner as OpenCodeInstanceIdentity;
    // Opening a fresh empty journal would fabricate evidence. Require the
    // original durable file and its matching owner before any observation.
    const stat = await lstat(join(directory, 'workgraph-native.sqlite'));
    if (!stat.isFile() || stat.isSymbolicLink()) return 'unknown';
    journal = new OpenCodeActionJournal(directory, identity);
    if (!await alive(owner.pid)) return journal.unresolved ? 'unknown' : 'drained';
    const connection = await record(join(directory, 'private-transport.json'));
    if (connection.version !== 1 || connection.instanceId !== owner.instanceId || typeof connection.password !== 'string' || !/^[a-f0-9]{64}$/.test(connection.password)) return 'unknown';
    const transport = new OpenCodeTransport(connection.endpoint, connection.password, 10000);
    const info = await transport.request('/api/info', { signal: context.signal }) as Record<string, unknown>;
    const state = await transport.request('/api/workgraph/state', { signal: context.signal }) as Record<string, unknown>;
    if (info.pid !== owner.pid || !isSupportedOpenCodeVersion(info.version) || state.instanceId !== owner.instanceId || state.runId !== context.runId || state.attemptId !== context.attemptId) return 'unknown';
    while (!context.signal.aborted) {
      const result = await transport.request('/api/workgraph/drain', { method: 'POST', signal: context.signal }) as Record<string, unknown>;
      if (result.instanceId !== owner.instanceId) return 'unknown';
      if (result.drained === true && !journal.unresolved) break;
      await new Promise(done => setTimeout(done, 50));
    }
    context.signal.throwIfAborted();
    await transport.request('/api/workgraph/shutdown', { method: 'POST', signal: context.signal });
    while (await alive(owner.pid)) { context.signal.throwIfAborted(); await new Promise(done => setTimeout(done, 25)); }
    return journal.unresolved ? 'unknown' : 'drained';
  } catch { return 'unknown'; }
  finally { journal?.close(); }
}
