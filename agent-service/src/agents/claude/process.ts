import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentQueryContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { claudeDeviceEnvironment } from './environment.js';
import { claudeCommand } from './command.js';

/** Device options are never accepted from browser configuration or frozen snapshots. */
export interface ClaudeDeviceOptions { executable?: string; launcherArgs?: readonly string[]; queryTimeoutMs?: number; stopTimeoutMs?: number; runTimeoutMs?: number }
/** Private spawn evidence, never inferred from generic runtime failures. */
export class ClaudeExecutableNotFoundError extends AgentError {
  constructor() { super('runtime_unavailable'); }
}
export function launchClaude(options: ClaudeDeviceOptions, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
  const environment = claudeDeviceEnvironment(env);
  const command = claudeCommand(options.executable, [...(options.launcherArgs ?? []), ...args], environment);
  return spawn(command.executable, command.args, { cwd, env: environment, stdio: 'pipe', shell: false, detached: process.platform !== 'win32', windowsHide: true });
}
export function signalClaude(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try { if (process.platform === 'win32') return child.kill(signal); process.kill(-child.pid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
export function claudeGroupAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** Cleanup is bounded, but cannot claim success while inherited pipes or a
 * process group remain. Discovery can therefore refuse to cache the query. */
export async function drainClaude(child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void> | undefined, timeoutMs = 500): Promise<void> {
  if (!child) return;
  if (claudeGroupAlive(child)) signalClaude(child, 'SIGKILL');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError('outcome_unknown')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
  const deadline = Date.now() + timeoutMs;
  while (claudeGroupAlive(child)) {
    if (Date.now() >= deadline) throw new AgentError('outcome_unknown');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function claudeVersion(options: ClaudeDeviceOptions, context: AgentQueryContext): Promise<string> {
  let child: ChildProcessWithoutNullStreams | undefined; let closed: Promise<void> | undefined;
  const abort = () => { if (child) signalClaude(child, 'SIGKILL'); };
  context.deferCleanup(async () => { context.signal.removeEventListener('abort', abort); await drainClaude(child, closed, options.stopTimeoutMs); });
  context.signal.throwIfAborted(); context.signal.addEventListener('abort', abort, { once: true });
  child = launchClaude(options, ['--version'], context.projectPath ?? process.cwd());
  const native = child;
  closed = new Promise<void>(resolve => native.once('close', () => resolve()));
  const version = await new Promise<string>((resolve, reject) => {
    let output = ''; let bytes = 0; let failed = false;
    const timer = setTimeout(() => { failed = true; abort(); reject(new AgentError('timeout')); }, options.queryTimeoutMs ?? 5000);
    const fail = (reason: 'protocol_error' | 'runtime_unavailable') => { failed = true; clearTimeout(timer); abort(); reject(new AgentError(reason)); };
    native.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) fail('protocol_error'); else output += chunk.toString('utf8'); });
    native.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) fail('protocol_error'); });
    native.once('error', (error: NodeJS.ErrnoException) => {
      failed = true; clearTimeout(timer); abort();
      reject(error.code === 'ENOENT' ? new ClaudeExecutableNotFoundError() : new AgentError('runtime_unavailable'));
    });
    native.once('close', (code, signal) => {
      clearTimeout(timer); if (failed) return;
      if (context.signal.aborted) { reject(context.signal.reason); return; }
      const match = /^([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(output.trim());
      if (code !== 0 || signal || !match || claudeGroupAlive(native)) { reject(new AgentError(code === 0 ? 'protocol_error' : 'runtime_unavailable')); return; }
      const parts = match[1]!.split('.').map(Number);
      // Minimum accepted CLI version: 2.1.0.
      if (parts[0]! < 2 || parts[0] === 2 && parts[1]! < 1) { reject(new AgentError('capability_unsupported')); return; }
      resolve(match[1]!);
    });
  });
  context.signal.throwIfAborted(); return version;
}
