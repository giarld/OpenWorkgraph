import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from '../errors.js';
import { isSupportedOpenCodeVersion } from './version.js';

/** Evidence revisions, not the supported version range. */
export const OPENCODE_TESTED_VERSIONS = ['2.0.29'] as const;
export interface OpenCodeDeviceOptions {
  executable?: string;
  launcherArgs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  /** Optional exact native SDK package installation; host-private, never a Web option. */
  sdkPackageRoot?: string;
  /** Native device credential store only; never a public configuration field. */
  credentialDatabase?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
}
export class OpenCodeNotInstalledError extends AgentError {
  constructor() { super('runtime_unavailable'); }
}
export function assertOpenCodeVersion(value: string): string {
  const match = /^opencode v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(value.trim());
  if (!match) throw new AgentError('protocol_error');
  if (!isSupportedOpenCodeVersion(match[1])) throw new AgentError('capability_unsupported');
  return match[1]!;
}
export interface OpenCodeProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  exited: Promise<void>;
  spawnError?: Error;
  lastSignal?: NodeJS.Signals;
  draining?: Promise<void>;
}
/** Device-only executable/environment: none of these are public Agent options. */
export function launchOpenCode(options: OpenCodeDeviceOptions, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): OpenCodeProcess {
  const child = spawn(options.executable ?? 'opencode', [...(options.launcherArgs ?? []), ...args], {
    cwd, env: environment, shell: false, stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true,
  });
  const processInfo: OpenCodeProcess = { child,
    closed: new Promise(resolve => child.once('close', () => resolve())),
    exited: new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); }),
  };
  child.once('error', error => { processInfo.spawnError = error; });
  // Always consume stderr without retaining native messages or secrets.
  child.stderr.resume();
  return processInfo;
}
export function openCodeProcessAlive(processInfo: OpenCodeProcess): boolean {
  const child = processInfo.child;
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function signalOpenCode(processInfo: OpenCodeProcess, signal: NodeJS.Signals): void {
  const child = processInfo.child;
  if (!child.pid) return;
  try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); processInfo.lastSignal = signal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new AgentError('outcome_unknown'); }
}
export async function boundedWait<T>(work: Promise<T>, timeoutMs: number, reason: 'timeout' | 'outcome_unknown' = 'timeout'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError(reason)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
/** This proves only that the owned group/pipes drained. Detached native tools
 * (which may create their own process groups) require separate action evidence. */
export async function stopOpenCode(processInfo: OpenCodeProcess, timeoutMs = 2000): Promise<void> {
  if (processInfo.draining) return processInfo.draining;
  const draining = drainOpenCode(processInfo, timeoutMs);
  processInfo.draining = draining;
  try { await draining; } finally { delete processInfo.draining; }
}
async function drainOpenCode(processInfo: OpenCodeProcess, timeoutMs: number): Promise<void> {
  if (openCodeProcessAlive(processInfo)) {
    if (!processInfo.lastSignal) signalOpenCode(processInfo, 'SIGTERM');
    try { await boundedWait(processInfo.exited, Math.min(timeoutMs, 500), 'outcome_unknown'); } catch {}
    if (openCodeProcessAlive(processInfo) && processInfo.lastSignal !== 'SIGKILL') signalOpenCode(processInfo, 'SIGKILL');
  }
  await boundedWait(processInfo.closed, timeoutMs, 'outcome_unknown');
  const deadline = Date.now() + timeoutMs;
  while (openCodeProcessAlive(processInfo)) {
    if (Date.now() >= deadline) throw new AgentError('outcome_unknown');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function queryOpenCodeVersion(options: OpenCodeDeviceOptions, cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const native = launchOpenCode(options, ['--version'], cwd, options.environment ?? process.env);
  const abort = () => { try { if (!native.lastSignal) signalOpenCode(native, 'SIGKILL'); } catch { /* drain below must still prove process exit */ } };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const decoder = new StringDecoder('utf8');
    let output = '', bytes = 0, failed = false;
    const result = new Promise<string>((resolve, reject) => {
      native.child.stdout.on('data', (chunk: Buffer) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > 4096) { failed = true; abort(); reject(new AgentError('protocol_error')); return; }
        output += decoder.write(chunk);
      });
      native.child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new OpenCodeNotInstalledError() : new AgentError('runtime_unavailable')));
      native.child.once('close', (code, childSignal) => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (code !== 0 || childSignal) { reject(new AgentError('runtime_unavailable')); return; }
        try { resolve(assertOpenCodeVersion(output + decoder.end())); } catch (error) { reject(error); }
      });
    });
    return await boundedWait(result, options.startTimeoutMs ?? 10_000);
  } finally { signal.removeEventListener('abort', abort); await stopOpenCode(native, options.stopTimeoutMs); }
}
