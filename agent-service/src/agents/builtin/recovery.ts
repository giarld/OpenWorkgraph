import { constants, openSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentRestartContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { captureLinuxProcessIdentity, checkedLinuxProcessIdentity, linuxProcessState, type LinuxProcessIdentity } from './linux-process-identity.js';

interface Owner { version: 1; runId: string; attemptId: string; hostPid: number; commandsAvailable: boolean; process?: Readonly<LinuxProcessIdentity> }
const identity = (value: string) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new AgentError('invalid_configuration'); return value; };
export function builtinAttemptDirectory(serviceRoot: string, runId: string, attemptId: string): string {
  return join(serviceRoot, 'config', 'builtin-agent-runs', identity(runId), identity(attemptId));
}
function directory(path: string): void {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new AgentError('permission_denied');
  if (created && process.platform === 'linux') syncDirectory(dirname(path));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Intent is private and durable before the first request/tool. It never lives
 * under the writable Run output or model-readable input directories. */
export function prepareBuiltinAttempt(serviceRoot: string, runId: string, attemptId: string, commandsAvailable: boolean): string {
  const root = realpathSync(serviceRoot);
  directory(join(root, 'config')); directory(join(root, 'config', 'builtin-agent-runs')); directory(join(root, 'config', 'builtin-agent-runs', identity(runId)));
  const path = builtinAttemptDirectory(root, runId, attemptId); directory(path);
  const owner: Owner = { version: 1, runId, attemptId, hostPid: process.pid, commandsAvailable };
  // Supplement legacy PID-only evidence on Linux. Missing procfs evidence
  // preserves SDK availability now, but cannot release a crashed Linux host.
  if (process.platform === 'linux') { try { owner.process = captureLinuxProcessIdentity(); } catch {} }
  const file = openSync(join(path, 'owner.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(file, JSON.stringify(owner), 'utf8'); fsyncSync(file); } finally { closeSync(file); }
  if (process.platform === 'linux') syncDirectory(path);
  return path;
}
/** No replay. After the old Agent host ends, interrupt its Run without claiming
 * that detached command descendants or external services ended. Never signal
 * a recorded PID during recovery. */
export async function reconcileBuiltinAttempt(context: AgentRestartContext): Promise<'drained' | 'unknown'> {
  context.signal.throwIfAborted();
  let file: number | undefined;
  try {
    const path = builtinAttemptDirectory(context.serviceRoot, context.runId, context.attemptId);
    if (realpathSync(path) !== path) return 'unknown';
    file = openSync(join(path, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(file); if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || process.platform === 'linux' && ((info.mode & 0o777) !== 0o600 || info.uid !== process.geteuid!())) return 'unknown';
    const owner = JSON.parse(readFileSync(file, 'utf8')) as Owner;
    if (owner.version !== 1 || owner.runId !== context.runId || owner.attemptId !== context.attemptId || typeof owner.commandsAvailable !== 'boolean' || !Number.isSafeInteger(owner.hostPid) || owner.hostPid < 1) return 'unknown';
    if (owner.process !== undefined) {
      const born = checkedLinuxProcessIdentity(owner.process);
      if (born.pid !== owner.hostPid || linuxProcessState(born) !== 'ended') return 'unknown';
      return 'drained';
    }
    if (owner.hostPid <= 1) return 'unknown';
    try { process.kill(owner.hostPid, 0); return 'unknown'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'drained' : 'unknown'; }
  } catch { return 'unknown'; }
  finally { if (file !== undefined) closeSync(file); }
}
