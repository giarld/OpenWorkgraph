import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from '../errors.js';
import { assertOpenCodeVersion, boundedWait, launchOpenCode, stopOpenCode, type OpenCodeDeviceOptions, type OpenCodeProcess } from './process.js';
import { OpenCodeTransport, privateEndpoint } from './transport.js';
import { openCodeSdkWorkerSource } from './sdk-worker.js';
import { fileURLToPath } from 'node:url';
import type { OpenCodeSdkBridgeOptions } from './sdk-bridge.js';

export interface OpenCodeInstanceOptions {
  /** Must be a new host-private directory, outside public Run artifacts. */
  directory: string; cwd: string; runId: string; attemptId: string;
  /** Owning frozen project is distinct from a text/visualize Run's cwd. */
  projectPath?: string;
  device?: OpenCodeDeviceOptions; signal: AbortSignal;
  /** Private native configuration, never persisted in the ownership record. */
  configuration?: Readonly<Record<string, unknown>>;
  bridge?: Pick<OpenCodeSdkBridgeOptions, 'permissionMode' | 'host' | 'runsPath' | 'recoverable' | 'selectionDigest'>;
}
export interface OpenCodeInstanceIdentity {
  version: 1; instanceId: string; runId: string; attemptId: string;
  directory: string; cwd: string; database: string; pid: number;
  /** Canonical owning configuration context, never inferred from a later Run. */
  projectPath?: string;
  runtime?: 'cli' | 'sdk';
}
/** Each Run/attempt (including a directory query) owns one private CLI/SDK
 * server and DB. No Service.ensure/stop, shared service or registration file. */
export class OpenCodePrivateInstance {
  readonly identity: Readonly<OpenCodeInstanceIdentity>;
  readonly transport: OpenCodeTransport;
  private stopped = false;
  private constructor(private readonly native: OpenCodeProcess, identity: OpenCodeInstanceIdentity, transport: OpenCodeTransport, private readonly stopTimeoutMs?: number) {
    this.identity = Object.freeze(identity); this.transport = transport;
  }
  static async start(options: OpenCodeInstanceOptions): Promise<OpenCodePrivateInstance> {
    options.signal.throwIfAborted();
    if (!isAbsolute(options.directory) || !isAbsolute(options.cwd) || options.projectPath !== undefined && !isAbsolute(options.projectPath) || !options.runId || !options.attemptId) throw new AgentError('invalid_configuration');
    const device = options.device ?? {};
    const cwd = await realpath(options.cwd), projectPath = await realpath(options.projectPath ?? options.cwd);
    if (device.sdkPackageRoot !== undefined && !isAbsolute(device.sdkPackageRoot)) throw new AgentError('invalid_configuration');
    if ((projectPath !== cwd || options.bridge) && !device.sdkPackageRoot) throw new AgentError('capability_unsupported');
    // Exclusive directory reservation prevents a second owner from silently
    // taking over an existing attempt, even when its original process is dead.
    try { await mkdir(options.directory, { mode: 0o700 }); } catch { throw new AgentError('outcome_unknown'); }
    const directory = await realpath(options.directory);
    const database = join(directory, 'opencode.db');
    const original = device.environment ?? process.env;
    const instanceId = randomUUID();
    const password = randomBytes(32).toString('hex');
    const environment: NodeJS.ProcessEnv = { ...original,
      XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      // Leave the device config root and HOME intact: native project/global
      // configuration and symlinked ~/.agents/skills keep their normal meaning.
      OPENCODE_DB: database, OPENCODE_PASSWORD: password,
      WORKGRAPH_OPENCODE_INSTANCE_ID: instanceId,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...parseConfiguration(original.OPENCODE_CONFIG_CONTENT), ...options.configuration,
        skills: [...new Set([...configurationSkills(original.OPENCODE_CONFIG_CONTENT, options.configuration), join(original.HOME ?? homedir(), '.agents', 'skills')])],
      }),
    };
    // Override both names so an inherited shared-service password cannot win.
    delete environment.OPENCODE_SERVER_PASSWORD;
    options.signal.throwIfAborted();
    let launch = device, args = ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'];
    if (device.sdkPackageRoot) {
      const worker = join(directory, 'sdk-worker.mjs');
      await writeFile(worker, openCodeSdkWorkerSource, { flag: 'wx', mode: 0o600 });
      environment.WORKGRAPH_OPENCODE_SDK_ROOT = device.sdkPackageRoot;
      environment.WORKGRAPH_OPENCODE_PROJECT = projectPath;
      environment.WORKGRAPH_OPENCODE_CWD = cwd;
      if (device.credentialDatabase) environment.WORKGRAPH_OPENCODE_CREDENTIAL_DB = device.credentialDatabase;
      else delete environment.WORKGRAPH_OPENCODE_CREDENTIAL_DB;
      if (options.bridge) {
        environment.WORKGRAPH_OPENCODE_HOST_MODULES = fileURLToPath(new URL('.', import.meta.url));
        environment.WORKGRAPH_OPENCODE_BRIDGE = JSON.stringify({ ...options.bridge, directory, runId: options.runId, attemptId: options.attemptId, instanceId, projectPath, cwd });
      }
      launch = { ...device, executable: process.execPath, launcherArgs: [] }; args = [worker];
      if ((original.HTTP_PROXY || original.HTTPS_PROXY || original.ALL_PROXY || original.http_proxy || original.https_proxy) && original.NODE_USE_ENV_PROXY === undefined) {
        if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new AgentError('capability_unsupported');
        environment.NODE_USE_ENV_PROXY = '1';
        if (original.ALL_PROXY) {
          if (!original.HTTP_PROXY && !original.http_proxy) environment.HTTP_PROXY = original.ALL_PROXY;
          if (!original.HTTPS_PROXY && !original.https_proxy) environment.HTTPS_PROXY = original.ALL_PROXY;
        }
      }
    }
    options.signal.throwIfAborted();
    const native = launchOpenCode(launch, args, cwd, environment);
    const abort = () => { void stopOpenCode(native, device.stopTimeoutMs).catch(() => {}); };
    options.signal.addEventListener('abort', abort, { once: true });
    let rejectStart: ((error: unknown) => void) | undefined;
    const rejectAbortedStart = () => rejectStart?.(options.signal.reason);
    options.signal.addEventListener('abort', rejectAbortedStart, { once: true });
    let cleanupStartup: (() => void) | undefined;
    try {
      const endpoint = await boundedWait(new Promise<string>((resolve, reject) => {
        rejectStart = reject;
        const decoder = new StringDecoder('utf8');
        let pending = '';
        const onData = (chunk: Buffer) => {
          pending += decoder.write(chunk);
          if (Buffer.byteLength(pending) > 64 * 1024) { reject(new AgentError('protocol_error')); abort(); return; }
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            let value: unknown;
            try { value = JSON.parse(line); } catch { continue; }
            if (value && typeof value === 'object' && 'url' in value) {
              try { resolve(privateEndpoint(value.url).href); } catch (error) { reject(error); }
              return;
            }
          }
        };
        const onError = () => reject(new AgentError('runtime_unavailable'));
        const onExit = () => reject(new AgentError('runtime_unavailable'));
        native.child.stdout.on('data', onData);
        native.child.once('error', onError); native.child.once('exit', onExit);
        cleanupStartup = () => { native.child.stdout.removeListener('data', onData); native.child.stdout.resume(); native.child.removeListener('error', onError); native.child.removeListener('exit', onExit); };
      }), device.startTimeoutMs ?? 30_000);
      options.signal.throwIfAborted();
      if (!native.child.pid) throw new AgentError('runtime_unavailable');
      const identity: OpenCodeInstanceIdentity = { version: 1, instanceId, runId: options.runId, attemptId: options.attemptId, directory, cwd, projectPath, database, pid: native.child.pid, runtime: device.sdkPackageRoot ? 'sdk' : 'cli' };
      const record = await open(join(directory, 'owner.json'), 'wx', 0o600);
      try { await record.writeFile(JSON.stringify(identity)); await record.sync(); } finally { await record.close(); }
      const transport = new OpenCodeTransport(endpoint, password, device.requestTimeoutMs);
      const info = await transport.request('/api/info', { signal: options.signal });
      if (!info || typeof info !== 'object' || !('pid' in info) || info.pid !== identity.pid || !('version' in info) || typeof info.version !== 'string') throw new AgentError('protocol_error');
      assertOpenCodeVersion('opencode v' + info.version);
      options.signal.throwIfAborted();
      return new OpenCodePrivateInstance(native, identity, transport, device.stopTimeoutMs);
    } catch (error) { await stopOpenCode(native, device.stopTimeoutMs); throw error; }
    finally { cleanupStartup?.(); options.signal.removeEventListener('abort', abort); options.signal.removeEventListener('abort', rejectAbortedStart); }
  }
  get processExited(): Promise<void> { return this.native.exited; }
  get process(): OpenCodeProcess { return this.native; }
  /** Explicit stop: it is not a Run/action completion assertion. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    await stopOpenCode(this.native, this.stopTimeoutMs);
    this.stopped = true;
  }
}
function parseConfiguration(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {}
  throw new AgentError('invalid_configuration');
}
function configurationSkills(value: string | undefined, override: OpenCodeInstanceOptions['configuration']): string[] {
  const original = parseConfiguration(value).skills ?? [], additional = override?.skills ?? [];
  if (!Array.isArray(original) || !Array.isArray(additional)) throw new AgentError('invalid_configuration');
  const skills = [...original, ...additional];
  if (!skills.every(item => typeof item === 'string')) throw new AgentError('invalid_configuration');
  return skills as string[];
}
