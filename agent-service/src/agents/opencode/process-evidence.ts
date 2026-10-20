import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentError } from '../errors.js';

const execute = promisify(execFile);
export interface OpenCodeShellProcessEvidence {
  instanceId: string; pid: number; groupId: number; started: string;
}
function validIdentity(instanceId: string, pid: number): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instanceId) || !Number.isSafeInteger(pid) || pid <= 1) throw new AgentError('invalid_configuration');
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new AgentError('capability_unsupported');
}
async function ps(args: string[]): Promise<string> {
  try {
    // OS lifecycle inspection only; never a fallback for an Agent command.
    const result = await execute('ps', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    return result.stdout;
  } catch { throw new AgentError('outcome_unknown'); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new AgentError('outcome_unknown'); }
}
async function observedProcess(instanceId: string, pid: number): Promise<OpenCodeShellProcessEvidence> {
  validIdentity(instanceId, pid);
  const identity = (await ps(['-p', String(pid), '-o', 'pid=,pgid=,lstart='])).trim().split(/\s+/);
  if (Number(identity[0]) !== pid || identity.length < 7) throw new AgentError('outcome_unknown');
  const groupId = Number(identity[1]);
  if (!Number.isSafeInteger(groupId) || groupId <= 1 || groupId === process.pid) throw new AgentError('outcome_unknown');
  // Read only the already-owned process, never log or retain its environment.
  const environment = await ps(process.platform === 'darwin' ? ['eww', '-p', String(pid), '-o', 'command='] : ['eww', '-p', String(pid), '-o', 'args=']);
  const marker = 'WORKGRAPH_OPENCODE_INSTANCE_ID=' + instanceId;
  if (!environment.split(/\s+/).includes(marker)) throw new AgentError('outcome_unknown');
  return { instanceId, pid, groupId, started: identity.slice(2).join(' ') };
}
/** Capture while the original native Shell.Info still supplies its exact PID.
 * Shell groups are detached by native OpenCode, not by the Workgraph host. */
export async function captureOpenCodeShellProcess(instanceId: string, pid: number): Promise<OpenCodeShellProcessEvidence> {
  const evidence = await observedProcess(instanceId, pid);
  if (evidence.groupId !== pid) throw new AgentError('outcome_unknown');
  return evidence;
}
async function groupMembers(groupId: number): Promise<{ pid: number; zombie: boolean }[]> {
  return (await ps(['-axo', 'pid=,pgid=,stat='])).trim().split('\n').map(line => line.trim().split(/\s+/)).filter(([, group]) => Number(group) === groupId).map(([pid, , state]) => ({ pid: Number(pid), zombie: /^[ZX]/.test(state ?? '') }));
}
export async function openCodeProcessRunning(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new AgentError('invalid_configuration');
  if (!alive(pid)) return false;
  if (process.platform === 'win32') return true;
  try { return !/^[ZX]/.test((await ps(['-p', String(pid), '-o', 'stat='])).trim()); }
  catch (error) { if (!alive(pid)) return false; throw error; }
}
export async function openCodeGroupRunning(groupId: number): Promise<boolean> {
  if (!Number.isSafeInteger(groupId) || groupId <= 1) throw new AgentError('invalid_configuration');
  return (await groupMembers(groupId)).some(member => !member.zombie);
}
/** Stop one previously observed native group after service loss. This never
 * confirms an action/Run terminal: escaped groups, remote tools and processes
 * that scrub the marker still require independent evidence and retain unknown. */
export async function stopObservedOpenCodeShellGroup(evidence: OpenCodeShellProcessEvidence, timeoutMs = 3000): Promise<{ groupExited: true; actionTerminalConfirmed: false }> {
  if (!evidence.started) throw new AgentError('invalid_configuration');
  return stopOwnedGroup(evidence, timeoutMs);
}
/** Only for an exact PID returned by this still-attached native spawner. A
 * fast leader may already be gone before its birth stamp can be captured;
 * every surviving group member must still prove this private instance. Host
 * recovery continues to require the separately persisted observed evidence. */
export async function stopOpenCodeNativeProcessGroup(instanceId: string, pid: number, timeoutMs = 3000): Promise<{ groupExited: true; actionTerminalConfirmed: false }> {
  return stopOwnedGroup({ instanceId, pid, groupId: pid }, timeoutMs);
}
async function stopOwnedGroup(evidence: Omit<OpenCodeShellProcessEvidence, 'started'> & { started?: string }, timeoutMs: number): Promise<{ groupExited: true; actionTerminalConfirmed: false }> {
  validIdentity(evidence.instanceId, evidence.pid);
  if (evidence.pid !== evidence.groupId || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new AgentError('invalid_configuration');
  if (!alive(-evidence.groupId)) return { groupExited: true, actionTerminalConfirmed: false };
  const membership = await groupMembers(evidence.groupId);
  const members = membership.filter(member => !member.zombie).map(member => member.pid);
  if (!membership.length && !alive(-evidence.groupId)) return { groupExited: true, actionTerminalConfirmed: false };
  // kill(0) also succeeds for zombies. They have already exited and cannot
  // perform work; waiting for their parent to reap them is not an exit barrier.
  if (membership.length && !members.length) return { groupExited: true, actionTerminalConfirmed: false };
  // Match the original creation stamp when its leader is still present.
  if (alive(evidence.pid) && !membership.some(member => member.pid === evidence.pid && member.zombie)) {
    let current: OpenCodeShellProcessEvidence;
    try { current = await observedProcess(evidence.instanceId, evidence.pid); }
    catch (error) { if (!alive(-evidence.groupId)) return { groupExited: true, actionTerminalConfirmed: false }; throw error; }
    if (current.groupId !== evidence.groupId || evidence.started !== undefined && current.started !== evidence.started) throw new AgentError('outcome_unknown');
  }
  if (!members.length) throw new AgentError('outcome_unknown');
  // A surviving member proves the old group is still ours even if its leader
  // has exited. Unknown/mixed members prohibit signalling that group.
  for (const pid of members) {
    if (!alive(pid)) continue;
    let current: OpenCodeShellProcessEvidence;
    try { current = await observedProcess(evidence.instanceId, pid); }
    catch (error) { if (!alive(pid)) continue; throw error; }
    if (current.groupId !== evidence.groupId) throw new AgentError('outcome_unknown');
  }
  try { process.kill(-evidence.groupId, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new AgentError('outcome_unknown'); }
  const deadline = Date.now() + timeoutMs;
  while ((await groupMembers(evidence.groupId)).some(member => !member.zombie)) {
    if (Date.now() >= deadline) throw new AgentError('outcome_unknown');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { groupExited: true, actionTerminalConfirmed: false };
}
