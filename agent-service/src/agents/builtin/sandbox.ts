import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

/** POSIX native policy; Windows uses ordinary user processes by explicit product
 * choice, without OS file/network isolation. Cleanup is best effort. */
export type BuiltinSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type BuiltinSandboxNetwork = 'deny' | 'allow';
export type BuiltinSandboxBackend = 'seatbelt' | 'bubblewrap' | 'windows-process';
export type BuiltinSandboxErrorCode = 'invalid_request' | 'sandbox_unavailable' | 'launch_failed';
export class BuiltinSandboxError extends Error {
  readonly code: BuiltinSandboxErrorCode;
  constructor(code: BuiltinSandboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'BuiltinSandboxError';
  }
}

export interface BuiltinSandboxRequest {
  mode: BuiltinSandboxMode;
  network: BuiltinSandboxNetwork;
  projectRoot: string;
  /** Private current-run scratch/output directory; existing and disjoint from project. */
  runRoot: string;
  /** Absolute executable; shells require explicit arguments. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Explicit environment only; do not pass process.env or model-provider credentials. */
  env?: Readonly<Record<string, string>>;
  /** Trusted runtime/skill dependencies; POSIX grants read-only access. */
  readRoots?: readonly string[];
  /** POSIX keeps these immutable even in full mode. Windows file tools enforce
   * this contract, but ordinary Windows child processes are not isolated. */
  readOnlyRoots?: readonly string[];
  /** Host-private service credentials/config; required at integration for all modes. */
  protectedRoots: readonly string[];
  /** POSIX masks this tree, including future entries. Only runRoot and the
   * frozen readOnlyRoots within it are exposed; readRoots cannot grant access. */
  serviceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface BuiltinSandboxLaunch {
  readonly backend: BuiltinSandboxBackend;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface BuiltinSandboxResult {
  backend: BuiltinSandboxBackend;
  status: 'exited' | 'cancelled' | 'timed-out' | 'output-limit';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;

}

function invalid(message: string): never { throw new BuiltinSandboxError('invalid_request', message); }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
function canonical(path: string, directory = true): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) invalid('Paths must be absolute and contain no control characters');
  try {
    const result = realpathSync.native(path);
    if (directory && !statSync(result).isDirectory()) invalid('Expected an existing directory');
    return result;
  } catch (cause) {
    if (cause instanceof BuiltinSandboxError) throw cause;
    throw new BuiltinSandboxError('invalid_request', 'Path is missing or inaccessible', { cause });
  }
}
function executable(path: string): string {
  const result = canonical(path, false);
  if (!statSync(result).isFile()) invalid('Command must be an executable file');
  try { accessSync(result, constants.X_OK); } catch (cause) {
    throw new BuiltinSandboxError('sandbox_unavailable', 'Required executable is unavailable', { cause });
  }
  return result;
}
function optionalDirectory(path: string): string[] {
  try { return [canonical(path)]; } catch { return []; }
}
function windowsRoot(): string {
  return canonical(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows');
}
/** The resolver and child PATH share executable directories only, never the
 * complete service environment. Windows additionally uses the host PATH. */
export function builtinCommandSearchRoots(): string[] {
  if (process.platform === 'win32') {
    const root = windowsRoot();
    const hostPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const roots = [dirname(process.execPath), join(root, 'System32'), root, join(root, 'System32/WindowsPowerShell/v1.0'),
      ...hostPath.split(delimiter).map(path => path.replace(/^"|"$/g, '')).filter(isAbsolute)];
    return [...new Map(roots.flatMap(optionalDirectory).map(path => [path.toLowerCase(), path])).values()];
  }
  return [...new Set([dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])];
}
const sbString = (value: string): string => JSON.stringify(value);
interface PrivateTree { root: string; readOnly: string[]; ancestors: string[] }

function assertNoHardlinks(roots: string[]): void {
  const scan = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile() && stat.nlink > 1) throw new BuiltinSandboxError('sandbox_unavailable', 'Hardlinked files require a separate execution filesystem');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) scan(path + sep + entry);
  };
  for (const root of roots) scan(root);
}
function seatbeltProfile(read: string[], write: string[], network: BuiltinSandboxNetwork, protectedRoots: string[], readOnlyRoots: string[], run: string, service?: PrivateTree): string {
  const protectedAncestors = new Set<string>();
  for (const root of [...protectedRoots, ...(service ? [service.root] : [])]) for (let p = dirname(root); p !== dirname(p); p = dirname(p)) protectedAncestors.add(p);
  const servicePolicy: string[] = [];
  if (service) {
    const exceptions = [run, ...service.readOnly].map(p => '(subpath ' + sbString(p) + ')').concat(service.ancestors.map(p => '(literal ' + sbString(p) + ')'));
    servicePolicy.push(
      '(deny file-read* file-write* file-map-executable (require-all (subpath ' + sbString(service.root) + ') (require-not (require-any ' + exceptions.join(' ') + '))))',
      // Ancestors allow traversal metadata only, never enumeration, replacement
      // or new siblings. The predicate also covers paths created after launch.
      ...service.ancestors.map(p => '(deny file-read-data file-read-xattr file-map-executable file-write* (literal ' + sbString(p) + '))'),
    );
  }
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/"))',
    '(allow file-read* file-map-executable ' + read.map(p => '(subpath ' + sbString(p) + ')').join(' ') + ')',
    '(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write* ' + write.map(p => '(subpath ' + sbString(p) + ')').join(' ') + ')',
    ...protectedRoots.map(p => '(deny file-read* file-write* file-map-executable (subpath ' + sbString(p) + '))'),
    ...readOnlyRoots.map(p => '(deny file-write* (subpath ' + sbString(p) + '))'),
    ...servicePolicy,
    ...[...protectedAncestors].map(p => '(deny file-write-unlink (literal ' + sbString(p) + '))'),
    // IP only: do not expose host UNIX sockets or arbitrary Mach services.
    ...(network === 'allow' ? [
      '(allow network-outbound (remote ip))',
      '(allow network-bind network-inbound (local ip))',
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.networkd") (global-name "com.apple.trustd.agent"))',
    ] : []),
  ].join('\n');
}

/** Build actual argv. Executable existence is not a successful sandbox probe. */
export function buildBuiltinSandboxLaunch(request: BuiltinSandboxRequest): BuiltinSandboxLaunch {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(request.mode)) invalid('Unknown permission mode');
  if (!['deny', 'allow'].includes(request.network)) invalid('Network policy must be explicit');
  for (const [value, max] of [[request.timeoutMs ?? 30_000, 3_600_000], [request.maxOutputBytes ?? 1_048_576, 16_777_216]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid('Invalid execution limit');
  }
  if (request.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid('Invalid command arguments');
  const project = canonical(request.projectRoot), run = canonical(request.runRoot);
  if (inside(project, run) || inside(run, project)) invalid('Project and private run directory must be disjoint');
  const dependencyRoots = (request.readRoots ?? []).map(p => canonical(p));
  const readOnlyRoots = (request.readOnlyRoots ?? []).map(p => canonical(p));
  const cwd = canonical(request.cwd ?? project);
  if (!inside(project, cwd) && !inside(run, cwd) && !dependencyRoots.some(root => inside(root, cwd))) invalid('Working directory must belong to this project, run or an approved dependency');
  if (!Array.isArray(request.protectedRoots)) invalid('Host-private protectedRoots must be explicit');
  const protectedRoots = [...new Set(request.protectedRoots.map(p => canonical(p, false)))];
  let service: PrivateTree | undefined;
  if (request.serviceRoot !== undefined) {
    const root = canonical(request.serviceRoot);
    if (root === run || !inside(root, run) || inside(root, project)) invalid('Invalid private service tree');
    const readOnly = [...new Set(readOnlyRoots.filter(p => inside(root, p)))].filter((p, _index, paths) => !paths.some(parent => parent !== p && inside(parent, p)));
    if (readOnly.some(p => p === root || inside(p, run) || inside(run, p))) invalid('Private read roots overlap writable resources');
    const ancestors = new Set<string>();
    for (const path of [run, ...readOnly]) for (let p = dirname(path); inside(root, p); p = dirname(p)) {
      ancestors.add(p); if (p === root) break;
    }
    service = { root, readOnly, ancestors: [...ancestors] };
  }
  const command = executable(request.command);
  if (protectedRoots.some(p => inside(p, run) || inside(run, p) || inside(p, command))) invalid('Protected resources overlap execution resources');
  if (service && inside(service.root, command) && !service.readOnly.some(p => inside(p, command))) invalid('Private executable is not a frozen dependency');
  const windows = process.platform === 'win32';
  const env: Record<string, string> = { PATH: builtinCommandSearchRoots().join(delimiter), LANG: 'en_US.UTF-8' };
  const supplied = new Set<string>();
  for (const [name, value] of Object.entries(request.env ?? {})) {
    const key = windows ? name.toUpperCase() : name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) invalid('Invalid environment');
    if (/^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV)$/u.test(key)) invalid('Loader environment is not supported');
    if (supplied.has(key)) invalid('Duplicate environment variable');
    supplied.add(key); env[key] = value;
  }
  Object.assign(env, { HOME: run, TMPDIR: run, TMP: run, TEMP: run });
  if (windows) {
    // No AppContainer, ACL mutation, driver, WSL or sandbox fallback. Modes
    // govern host file tools/approvals; child scripts retain OS user rights.
    if (request.network !== 'allow') throw new BuiltinSandboxError('sandbox_unavailable', 'Windows process execution cannot enforce network denial');
    const root = windowsRoot();
    Object.assign(env, { SYSTEMROOT: root, WINDIR: root, SYSTEMDRIVE: parse(root).root.replace(/[\\/]$/, ''),
      COMSPEC: join(root, 'System32/cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: run, APPDATA: run, LOCALAPPDATA: run, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    return { backend: 'windows-process', executable: command, args: [...request.args ?? []], cwd, env };
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new BuiltinSandboxError('sandbox_unavailable', 'Command execution is unavailable on this platform');
  }
  const full = request.mode === 'danger-full-access';
  // Script launchers such as npm need both bin and sibling lib resources. Grant
  // only known installation prefixes; the private service policy still applies.
  const runtimeRoots = [dirname(dirname(realpathSync(process.execPath))), '/usr/local', '/opt/homebrew'].flatMap(optionalDirectory);
  const read = full ? ['/'] : [...new Set([project, run, dirname(command), ...dependencyRoots, ...runtimeRoots])];
  const write = full ? ['/'] : request.mode === 'workspace-write' ? [project, run] : [run];
  const systemPaths = ['/System', '/usr', '/bin', '/sbin', '/Library', '/dev', '/proc', '/etc', '/private/etc'];
  if (!full && write.some(w => systemPaths.some(s => inside(w, s) || inside(s, w)))) invalid('Writable roots overlap system paths');
  // Scanning is only an initial-state check, never a concurrent-host mutation guarantee.
  assertNoHardlinks([...protectedRoots, ...(service ? [service.root] : []), ...(full ? [] : write)]);
  if (process.platform === 'darwin') {
    const systemRead = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/etc', '/private/var/db/timezone'].flatMap(optionalDirectory);
    let launcher: string;
    try { launcher = executable('/usr/bin/sandbox-exec'); } catch (cause) {
      throw new BuiltinSandboxError('sandbox_unavailable', 'macOS requires a working sandbox-exec', { cause });
    }
    return { backend: 'seatbelt', executable: launcher, args: ['-p', seatbeltProfile([...read, ...systemRead], write, request.network, protectedRoots, readOnlyRoots, run, service), command, ...request.args ?? []], cwd, env };
  }
  let launcher: string;
  try { launcher = executable('/usr/bin/bwrap'); } catch (cause) {
    throw new BuiltinSandboxError('sandbox_unavailable', 'Linux requires /usr/bin/bwrap and unprivileged user namespaces', { cause });
  }
  // No --*-try fallback: missing kernel permissions must fail before the payload.
  const args = ['--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
  if (request.network === 'allow') args.push('--share-net');
  // Never --ro-bind / /: that exposes host IPC and credentials.
  const systemRead = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'].filter(p => optionalDirectory(p).length);
  if (full) args.push('--bind', '/', '/');
  else {
    for (const root of [...new Set([...systemRead, ...read])]) args.push('--ro-bind', root, root);
    for (const root of write) args.push('--bind', root, root);
  }
  // Do not expose systemd's runtime sockets or writable cgroup controls. This
  // deliberately avoids service-manager integration; it is not a daemon proof.
  if (full) {
    for (const path of ['/run', '/sys/fs/cgroup']) if (optionalDirectory(path).length) args.push('--tmpfs', path, '--remount-ro', path);
  }
  if (service) {
    // Overlay the whole tree before exposing the finite accepted resources. A
    // later host-created Run or database journal never appears in this mount.
    args.push('--tmpfs', service.root, '--bind', run, run);
    for (const root of service.readOnly) args.push('--ro-bind', root, root);
    args.push('--remount-ro', service.root);
  }
  for (const root of readOnlyRoots) args.push('--ro-bind', root, root);
  for (const root of protectedRoots) if ([...systemRead, ...read].some(mount => inside(mount, root))) {
    if (statSync(root).isDirectory()) args.push('--tmpfs', root, '--remount-ro', root);
    else args.push('--ro-bind', '/dev/null', root);
  }
  // Keep the validated canonical executable, but preserve the caller's argv[0].
  // Resolving /bin/sh to BusyBox must not turn sh -c into busybox -c.
  args.push('--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--argv0', request.command, '--', command, ...request.args ?? []);
  return { backend: 'bubblewrap', executable: launcher, args, cwd, env };
}

/** Stops our foreground handle and makes a bounded attempt to kill its group.
 * Detached workers or broker-created work may survive. Never claims otherwise. */
export async function runBuiltinSandboxedCommand(request: BuiltinSandboxRequest, spawnCommand: typeof spawn = spawn, decodeOutput?: (bytes: Buffer) => Promise<string>): Promise<BuiltinSandboxResult> {
  const launch = buildBuiltinSandboxLaunch(request);
  if (request.signal?.aborted) throw new BuiltinSandboxError('launch_failed', 'Execution cancelled before launch');
  return captureLaunch(request, launch, spawnCommand, decodeOutput);
}

function captureLaunch(request: BuiltinSandboxRequest, launch: BuiltinSandboxLaunch, spawnCommand: typeof spawn, decodeOutput?: (bytes: Buffer) => Promise<string>): Promise<BuiltinSandboxResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(launch.executable, [...launch.args], { cwd: launch.cwd, env: { ...launch.env }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let status: BuiltinSandboxResult['status'] = 'exited', size = 0, truncated = false, settled = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const limit = request.maxOutputBytes ?? 1_048_576;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsStop = false;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          // Do not signal a historical PID after normal exit. taskkill is a
          // best-effort tree stop, not a Job Object or a containment guarantee.
          if (windowsStop || child.exitCode !== null || child.signalCode !== null) return;
          windowsStop = true;
          const killer = spawn(join(launch.env.SYSTEMROOT!, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'],
            { env: { SYSTEMROOT: launch.env.SYSTEMROOT, WINDIR: launch.env.WINDIR }, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); });
          killer.once('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
          killer.unref();
        }
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* Best effort only; do not replace the original stop reason. */ }
    };
    const clean = () => { clearTimeout(timer); clearTimeout(settleTimer); request.signal?.removeEventListener('abort', cancel); };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true; clean();
      if (process.platform === 'win32' && status !== 'exited' && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      // Decode complete captured bytes after enforcing the original byte cap.
      // Stopped/truncated commands need no encoding probe during cancellation.
      if (!decodeOutput || status !== 'exited') {
        resolve({ backend: launch.backend, status, exitCode, signal, stdout: out.toString('utf8'), stderr: err.toString('utf8'), outputTruncated: truncated });
        return;
      }
      void Promise.all([decodeOutput(out), decodeOutput(err)]).then(([stdout, stderr]) => {
        resolve({ backend: launch.backend, status, exitCode, signal, stdout, stderr, outputTruncated: truncated });
      }, cause => reject(new BuiltinSandboxError('launch_failed', 'Command output decoding failed', { cause })));
    };
    const boundedFinish = () => { settleTimer ??= setTimeout(() => finish(child.exitCode, child.signalCode), 250); };
    const stop = (reason: BuiltinSandboxResult['status']) => {
      if (settled) return;
      if (status === 'exited') status = reason;
      killGroup(); boundedFinish();
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed-out'), request.timeoutMs ?? 30_000);
    const collect = (parts: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      const remaining = Math.max(0, limit - size);
      if (remaining) parts.push(Buffer.from(chunk.subarray(0, remaining)));
      size += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) { truncated = true; stop('output-limit'); }
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();
    child.once('error', cause => {
      if (settled) return;
      settled = true; killGroup(); clean(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      reject(new BuiltinSandboxError('launch_failed', 'Sandbox launcher failed', { cause }));
    });
    child.once('exit', () => { if (!settled) { killGroup(); boundedFinish(); } });
    child.once('close', finish);
  });
}
