import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AgentError } from '../errors.js';
import { boundedWait, forceStopOpenCode, launchOpenCode, OpenCodeNotInstalledError, queryOpenCodeVersion, stopOpenCode, type OpenCodeDeviceOptions } from './process.js';

export type OpenCodeCliOptions = Omit<OpenCodeDeviceOptions, 'sdkPackageRoot' | 'credentialDatabase'>;
export async function resolveOpenCodeCli(options: OpenCodeCliOptions = {}): Promise<OpenCodeCliOptions> {
  if ('sdkPackageRoot' in options || 'credentialDatabase' in options) throw new AgentError('invalid_configuration');
  const environment = options.environment ?? process.env;
  const command = options.executable ?? 'opencode';
  const paths = isAbsolute(command) || command.includes('/') || command.includes(String.fromCharCode(92))
    ? [resolve(command)] : (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean).flatMap(path => process.platform === 'win32'
      ? [join(path, command + '.exe'), join(path, command + '.cmd'), join(path, command)] : [join(path, command)]);
  for (let path of paths) {
    try {
      await access(path, constants.X_OK);
      if (process.platform === 'win32' && ['.cmd', '.bat', '.ps1'].some(extension => path.toLowerCase().endsWith(extension))) {
        // Invoke the native binary directly. npm shims otherwise require a
        // shell and can alter argv or truncate a large ACP message.
        const native = join(dirname(path), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
        await access(native, constants.X_OK); path = native;
      }
      return { ...options, executable: path, ...(options.environment ? { environment: { ...options.environment } } : {}) };
    } catch { /* Try the next executable candidate. */ }
  }
  throw new OpenCodeNotInstalledError();
}
export async function openCodeCliDevice(options: OpenCodeCliOptions, signal: AbortSignal): Promise<OpenCodeCliOptions & { runtimeVersion: string }> {
  const device = await resolveOpenCodeCli(options);
  const runtimeVersion = await queryOpenCodeVersion(device, device.environment?.HOME ?? device.environment?.USERPROFILE ?? homedir(), signal);
  const original = device.environment ?? process.env;
  let configuration: Record<string, any> = {};
  if (original.OPENCODE_CONFIG_CONTENT) {
    try { configuration = JSON.parse(original.OPENCODE_CONFIG_CONTENT); } catch { throw new AgentError('invalid_configuration'); }
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new AgentError('invalid_configuration');
  }
  if (configuration.skills !== undefined && (!Array.isArray(configuration.skills) || configuration.skills.some((value: unknown) => typeof value !== 'string'))) throw new AgentError('invalid_configuration');
  const common = join(original.HOME ?? original.USERPROFILE ?? homedir(), '.agents', 'skills');
  return { ...device, runtimeVersion, environment: { ...original, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...configuration, skills: [...new Set([...(configuration.skills ?? []), common])], update: 'disable', share: 'disabled', warming: false }) } };
}
/** Official V2 CLI/API supplement. It may inspect/update only an explicitly
 * owned native identity; a fresh server's empty active list is never used as
 * evidence that an earlier ACP execution stopped. No model prompt is sent. */
export async function openCodeCliRequest(device: OpenCodeCliOptions, cwd: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<any> {
  signal.throwIfAborted();
  if (!path.startsWith('/api/') || !['GET', 'PATCH', 'POST', 'DELETE', 'PUT'].includes(method)) throw new AgentError('invalid_configuration');
  const args = ['api', method, path, '--standalone', ...(body === undefined ? [] : ['--data', JSON.stringify(body)])];
  const native = launchOpenCode(device, args, cwd, device.environment ?? process.env);
  const abort = () => { void forceStopOpenCode(native, device.stopTimeoutMs).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let output = '', bytes = 0;
  try {
    const work = new Promise<any>((resolve, reject) => {
      native.child.stdout.setEncoding('utf8');
      native.child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) { abort(); reject(new AgentError('protocol_error')); return; }
        output += chunk;
      });
      native.child.once('error', () => reject(new AgentError('runtime_unavailable')));
      native.child.once('close', (code, killed) => {
        if (signal.aborted || code !== 0 || killed) { reject(new AgentError(method === 'GET' ? 'runtime_unavailable' : 'outcome_unknown')); return; }
        try { resolve(output.trim() ? JSON.parse(output) : null); } catch { reject(new AgentError('protocol_error')); }
      });
      native.child.stdin.end();
    });
    return await boundedWait(work, device.requestTimeoutMs ?? 30000);
  } finally { signal.removeEventListener('abort', abort); await stopOpenCode(native, device.stopTimeoutMs); }
}
