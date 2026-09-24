import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
import type { InstanceRecord } from './lifecycle.js';
import { readInstance, requestInstance, startBackground, waitUntilStopped } from './lifecycle.js';

const PACKAGE_NAME = '@openworkgraph/agent-service';

/** Compare the running package against npm's actual global package location. */
export async function isGlobalNpmInstallation(cliPath: string, spawnProcess: SpawnProcess = spawn): Promise<boolean> {
  const invocation = process.platform === 'win32'
    ? { command: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm root -g'] }
    : { command: 'npm', args: ['root', '-g'] };
  try {
    const root = await new Promise<string>((resolve, reject) => {
      const child = spawnProcess(invocation.command, invocation.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      let output = '';
      child.stdout?.on('data', chunk => { if (output.length < 8192) output += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('npm root failed')));
    });
    if (!root) return false;
    const installedPath = join(root, PACKAGE_NAME);
    if ((await lstat(installedPath)).isSymbolicLink()) return false;
    const packagePath = await realpath(installedPath);
    const runningPath = await realpath(cliPath);
    const inside = relative(packagePath, runningPath);
    return inside !== '' && inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside);
  } catch { return false; }
}

/** The updater must outlive the Runtime that it stops. */
export async function startWebUpdate(cliPath: string, spawnProcess: SpawnProcess = spawn, onExit?: () => void): Promise<void> {
  const child = spawnProcess(process.execPath, [cliPath, 'update', '--output-json'], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  if (onExit) child.once('close', onExit);
  child.unref();
}

type RuntimeStatus = { listenHost?: string; localEndpoint: string };
type SpawnProcess = typeof spawn;
type NpmInvocation = { command: string; args: string[] };
type ParsedSemVer = { core: [bigint, bigint, bigint]; prerelease: string[] | undefined };

function parseSemVer(value: string): ParsedSemVer {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  const prerelease = match?.[4]?.split('.');
  if (!match || prerelease?.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease };
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left), b = parseSemVer(right);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index], rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart), rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function npmInstallInvocation(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): NpmInvocation {
  if (platform === 'win32') {
    // Recent Node versions reject direct .cmd execution with spawn EINVAL.
    // Invoke npm through the Windows command interpreter explicitly instead.
    return {
      command: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `npm install -g ${PACKAGE_NAME}`],
    };
  }
  return { command: 'npm', args: ['install', '-g', PACKAGE_NAME] };
}

export function npmVersionInvocation(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): NpmInvocation {
  if (platform === 'win32') {
    return {
      command: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `npm view ${PACKAGE_NAME} version --json`],
    };
  }
  return { command: 'npm', args: ['view', PACKAGE_NAME, 'version', '--json'] };
}

export async function latestAgentServiceVersion(spawnProcess: SpawnProcess = spawn): Promise<string> {
  const invocation = npmVersionInvocation();
  const child = spawnProcess(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => {
    if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', chunk => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `npm version check failed (${signal ?? code ?? 'unknown'})`));
    });
  });
  let version: unknown;
  try { version = JSON.parse(stdout); }
  catch { throw new Error('npm returned an invalid package version response.'); }
  if (typeof version !== 'string') throw new Error('npm returned an invalid package version response.');
  parseSemVer(version);
  return version;
}

export async function installGlobalAgentService(outputJson = false, spawnProcess: SpawnProcess = spawn): Promise<void> {
  const invocation = npmInstallInvocation();
  const child = spawnProcess(invocation.command, invocation.args, {
    windowsHide: true,
    stdio: outputJson ? ['ignore', 'ignore', 'pipe'] : 'inherit',
  });
  let stderr = '';
  child.stderr?.on('data', chunk => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `npm install failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}

export interface UpdateDependencies {
  latestAgentServiceVersion: typeof latestAgentServiceVersion;
  readInstance: typeof readInstance;
  requestInstance: typeof requestInstance;
  waitUntilStopped: typeof waitUntilStopped;
  installGlobalAgentService: typeof installGlobalAgentService;
  startBackground: typeof startBackground;
}

const defaultDependencies: UpdateDependencies = {
  latestAgentServiceVersion, readInstance, requestInstance, waitUntilStopped, installGlobalAgentService, startBackground,
};

export async function updateAgentService(
  dataDir: string | undefined,
  cliPath: string,
  interruptAndStop: boolean,
  outputJson: boolean,
  dependencies: UpdateDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
  const latestVersion = await dependencies.latestAgentServiceVersion();
  const updateAvailable = compareSemVer(latestVersion, SERVICE_VERSION) > 0;
  if (!updateAvailable) {
    return {
      packageName: PACKAGE_NAME, currentVersion: SERVICE_VERSION, latestVersion,
      updateAvailable: false, updated: false, restarted: false,
    };
  }

  let record: InstanceRecord | undefined;
  let status: RuntimeStatus | undefined;
  if (dataDir) {
    try { record = await dependencies.readInstance(dataDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record) try { status = await dependencies.requestInstance(record, 'status') as RuntimeStatus; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error; }
  }

  let restartArgs: string[] | undefined;
  if (record && status) {
    if (!status.listenHost) throw new Error('The older runtime did not report its listen address. Update it manually with npm install -g @openworkgraph/agent-service, then restart it with an explicit --host value. The runtime has not been stopped.');
    const port = new URL(status.localEndpoint).port || '80';
    if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('The running runtime reported an invalid listen port. The runtime has not been stopped.');
    restartArgs = ['--data-dir', dataDir!, '--host', status.listenHost, '--port', port];
    await dependencies.requestInstance(record, interruptAndStop ? 'interrupt-and-stop' : 'stop');
    await dependencies.waitUntilStopped(record);
  }

  await dependencies.installGlobalAgentService(outputJson);
  const restarted = restartArgs ? await dependencies.startBackground(cliPath, restartArgs) : undefined;
  return {
    packageName: PACKAGE_NAME, currentVersion: SERVICE_VERSION, latestVersion,
    updateAvailable: true, updated: true, restarted: Boolean(restartArgs),
    ...(restarted && typeof restarted === 'object' ? restarted : {}),
  };
}
