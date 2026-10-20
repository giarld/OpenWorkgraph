import { findPackageJSON } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError } from '../errors.js';
import type { OpenCodeDeviceOptions } from './process.js';
import { isSupportedOpenCodeVersion } from './version.js';

export class OpenCodeSdkMissingError extends AgentError {
  constructor() { super('runtime_unavailable'); }
}

/** Device-only resolution. Never accept executable, env, credentials or SDK
 * paths through the public finite Agent configuration. */
export async function openCodeDevice(options: OpenCodeDeviceOptions): Promise<OpenCodeDeviceOptions & { sdkVersion: string }> {
  let root = options.sdkPackageRoot ?? options.environment?.WORKGRAPH_OPENCODE_SDK_ROOT ?? process.env.WORKGRAPH_OPENCODE_SDK_ROOT;
  let sdkVersion: string;
  if (root === undefined) {
    try { const manifest = findPackageJSON('@opencode/sdk', import.meta.url); if (manifest) root = dirname(manifest); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw new AgentError('runtime_unavailable'); }
    root ??= fileURLToPath(new URL('../../../.opencode-sdk/node_modules/@opencode/sdk', import.meta.url));
  }
  if (!root || !isAbsolute(root)) throw new AgentError('invalid_configuration');
  try {
    const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (value.name !== '@opencode/sdk' || !isSupportedOpenCodeVersion(value.version)) throw new AgentError('capability_unsupported');
    sdkVersion = value.version;
  } catch (error) { throw error instanceof AgentError ? error : (error as NodeJS.ErrnoException).code === 'ENOENT' ? new OpenCodeSdkMissingError() : new AgentError('runtime_unavailable'); }
  const environment = options.environment ?? process.env;
  const home = environment.HOME ?? homedir();
  const data = join(environment.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode');
  const configured = options.credentialDatabase ?? environment.OPENCODE_DB;
  const candidate = configured === ':memory:' ? undefined : configured ? isAbsolute(configured) ? configured : join(data, configured) : join(data, 'opencode.db');
  let credentialDatabase: string | undefined;
  if (candidate) try {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(candidate) !== candidate || process.getuid && stat.uid !== process.getuid()) throw new AgentError('invalid_configuration');
    credentialDatabase = candidate;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.credentialDatabase) throw error instanceof AgentError ? error : new AgentError('authentication_required'); }
  return { ...options, sdkPackageRoot: root, sdkVersion, ...(credentialDatabase ? { credentialDatabase } : {}) };
}
