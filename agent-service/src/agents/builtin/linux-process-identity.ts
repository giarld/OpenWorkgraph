/** Private Linux birth evidence. No termination signals, census, migration or
 * ownership inferred from current PPID. A present zombie is still unconfirmed. */
import { constants, openSync, closeSync, readSync, statSync, statfsSync, readlinkSync } from 'node:fs';
import { AgentError } from '../errors.js';

export interface LinuxProcessIdentity {
  readonly version: 1;
  readonly bootId: string;
  readonly namespace: { readonly dev: string; readonly ino: string };
  readonly pid: number;
  readonly startTicks: string;
}
const invalid = (): never => { throw new AgentError('outcome_unknown'); };
const keys = (value: unknown, expected: string): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const pidValue = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;

export function checkedLinuxProcessIdentity(value: unknown): Readonly<LinuxProcessIdentity> {
  if (!keys(value, 'bootId,namespace,pid,startTicks,version') || value.version !== 1 || !pidValue(value.pid) || typeof value.bootId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bootId) || !decimal(value.startTicks) || BigInt(value.startTicks) > 18446744073709551615n ||
      !keys(value.namespace, 'dev,ino') || !decimal(value.namespace.dev) || !decimal(value.namespace.ino)) return invalid();
  return Object.freeze({ version: 1, bootId: value.bootId, pid: value.pid, startTicks: value.startTicks,
    namespace: Object.freeze({ dev: value.namespace.dev, ino: value.namespace.ino }) });
}

/** comm may itself contain whitespace, newlines and closing parentheses. The
 * final closing parenthesis precedes field3; starttime is field22, not a float. */
export function parseLinuxProcessStat(text: string, expectedPid: number): { parentPid: number; startTicks: string } {
  if (typeof text !== 'string' || text.length > 8192 || !pidValue(expectedPid) || !text.startsWith(String(expectedPid) + ' (')) return invalid();
  const closing = text.lastIndexOf(') ');
  if (closing < String(expectedPid).length + 2) return invalid();
  const fields = text.slice(closing + 2).trim().split(/\s+/);
  const parent = fields[1], start = fields[19];
  if (fields.length < 20 || !/^[RSDZTtWXxKPI]$/.test(fields[0] ?? '') || !decimal(parent) || BigInt(parent) > 2147483647n ||
      !decimal(start) || BigInt(start) > 18446744073709551615n) return invalid();
  return { parentPid: Number(parent), startTicks: start };
}
function proc(path: string, limit: number): string {
  if (process.platform !== 'linux') return invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (statfsSync('/proc/self/fd/' + fd, { bigint: true }).type !== 0x9fa0n) return invalid();
    const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    if (used > limit) return invalid();
    return bytes.subarray(0, used).toString('utf8');
  } finally { closeSync(fd); }
}
function namespace(pid: 'self' | number): { dev: string; ino: string } {
  const value = statSync('/proc/' + pid + '/ns/pid', { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino) };
}
function view(): { bootId: string; namespace: { dev: string; ino: string } } {
  if (process.platform !== 'linux' || readlinkSync('/proc/self') !== String(process.pid)) return invalid();
  const status = proc('/proc/self/status', 131072), ids = /^NSpid:\s*([^\r\n]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  // A procfs mounted from an ancestor PID namespace must not be used to prove
  // absence of a PID in this process's namespace, even on numeric coincidence.
  if (ids?.length !== 1 || ids[0] !== String(process.pid)) return invalid();
  const bootId = proc('/proc/sys/kernel/random/boot_id', 128).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) return invalid();
  return { bootId, namespace: namespace('self') };
}
function birth(pid: number, observer: ReturnType<typeof view>): { identity: Readonly<LinuxProcessIdentity>; parentPid: number } {
  const first = parseLinuxProcessStat(proc('/proc/' + pid + '/stat', 8192), pid);
  const target = namespace(pid);
  const status = proc('/proc/' + pid + '/status', 131072), ids = /^NSpid:\s*([^\r\n]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  const second = parseLinuxProcessStat(proc('/proc/' + pid + '/stat', 8192), pid);
  if (target.dev !== observer.namespace.dev || target.ino !== observer.namespace.ino || ids?.length !== 1 || ids[0] !== String(pid) || first.startTicks !== second.startTicks) return invalid();
  return { identity: checkedLinuxProcessIdentity({ version: 1, ...observer, pid, startTicks: first.startTicks }), parentPid: second.parentPid };
}
export function captureLinuxProcessIdentity(pid = process.pid, expectedParentPid?: number): Readonly<LinuxProcessIdentity> {
  if (!pidValue(pid) || expectedParentPid !== undefined && !pidValue(expectedParentPid)) return invalid();
  const result = birth(pid, view());
  // Initial parent linkage is checked before GO, never used after reparenting
  // to decide whether the original process still exists.
  if (expectedParentPid !== undefined && result.parentPid !== expectedParentPid) return invalid();
  return result.identity;
}
export function linuxProcessState(identity: LinuxProcessIdentity): 'present' | 'ended' | 'unknown' {
  try {
    const expected = checkedLinuxProcessIdentity(identity), observer = view();
    // A different kernel can be a copied directory on another host, not proof
    // that the original kernel rebooted. No cross-host placement inference.
    if (expected.bootId !== observer.bootId) return 'unknown';
    if (expected.namespace.dev !== observer.namespace.dev || expected.namespace.ino !== observer.namespace.ino) return 'unknown';
    try {
      const current = birth(expected.pid, observer).identity;
      return current.startTicks === expected.startTicks ? 'present' : 'ended';
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unknown';
      // hidepid and a dead thread-group leader can hide proc entries while
      // another thread still runs. Absence alone is not process-end evidence.
      try { process.kill(expected.pid, 0); return 'unknown'; }
      catch (probe) { return (probe as NodeJS.ErrnoException).code === 'ESRCH' ? 'ended' : 'unknown'; }
    }
  } catch { return 'unknown'; }
}
