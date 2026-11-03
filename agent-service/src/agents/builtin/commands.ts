import { constants, accessSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import type { SandboxMode } from '@openworkgraph/protocol';
import type { BackendRunContext } from '../../backend/types.js';
import type { BuiltinAgentCommandExecutor, BuiltinAgentCommandRequest, BuiltinAgentCommandOutput, PreparedBuiltinAgentCommand } from './adapter.js';
import { AgentError } from '../errors.js';
import { BUILTIN_AGENT_LIMITS } from './limits.js';
import { decodeWindowsCommandOutput } from './windows-output.js';
import { buildBuiltinSandboxLaunch, builtinCommandSearchRoots, runBuiltinSandboxedCommand, BuiltinSandboxError, type BuiltinSandboxRequest } from './sandbox.js';

// This is a convenience guard, not a parser or an OS security boundary. Scripts
// must follow the foreground-only instruction; POSIX also has native policy.
const serviceManagers = /^(?:launchctl|systemctl|systemd(?:-.*)?|loginctl|service|rc-service|rc-update|sc|schtasks)(?:\.exe)?$/i;
// cross-spawn handles Windows .cmd/.bat shims and escaping without a blanket
// shell:true. POSIX continues to use the existing native launcher unchanged.
const windowsSpawn = process.platform === 'win32'
  ? createRequire(import.meta.url)('cross-spawn') as typeof import('node:child_process').spawn : undefined;
function commandPath(command: string): string {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw new AgentError('invalid_configuration');
  if (serviceManagers.test(basename(command))) throw new AgentError('permission_denied', '一期任务不支持调用系统服务管理器，请以前台方式执行命令。');
  const check = (path: string) => {
    const canonical = realpathSync(path);
    if (serviceManagers.test(basename(path)) || serviceManagers.test(basename(canonical))) throw new AgentError('permission_denied', '一期任务不支持调用系统服务管理器，请以前台方式执行命令。');
    if (!lstatSync(canonical).isFile()) throw new AgentError('invalid_configuration');
    accessSync(canonical, constants.X_OK);
    // Preserve argv[0] for multicall binaries such as BusyBox.
    return path;
  };
  if (isAbsolute(command)) return check(command);
  if (command.includes('/') || command.includes('\\')) throw new AgentError('invalid_configuration');
  // Search only host-selected executable roots; never inherit service secrets or
  // a model-provided PATH. Explicit absolute tools remain supported.
  const names = process.platform === 'win32' && !/\.(?:exe|com|cmd|bat)$/i.test(command)
    ? [command + '.exe', command + '.com', command + '.cmd', command + '.bat', command] : [command];
  for (const root of builtinCommandSearchRoots()) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return check(candidate);
    }
  }
  throw new AgentError('runtime_unavailable', '找不到命令，请检查工作空间中的工具安装或使用绝对路径。');
}

/** Phase-one foreground execution. drain settles our command handles only;
 * it never certifies detached descendants or external services have ended. */
export class BuiltinCommands implements BuiltinAgentCommandExecutor {
  private closed = false;
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<BuiltinAgentCommandOutput>>();
  constructor(private readonly context: Readonly<BackendRunContext>, private readonly mode: SandboxMode) {}
  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) throw new AgentError('outcome_unknown');
  }
  async prepare(request: Omit<BuiltinAgentCommandRequest, 'environment'>): Promise<PreparedBuiltinAgentCommand> {
    this.check(request.signal);
    let base: BuiltinSandboxRequest;
    try {
      const timeoutMs = request.timeoutMs ?? BUILTIN_AGENT_LIMITS.commandMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BUILTIN_AGENT_LIMITS.commandMs) throw new AgentError('invalid_configuration');
      base = { mode: this.mode, network: 'allow', projectRoot: this.context.projectPath, runRoot: this.context.outputPath,
        readRoots: [this.context.inputPath, ...(this.context.skills ?? []).map(skill => dirname(skill.path))],
        serviceRoot: this.context.serviceRoot, protectedRoots: [],
        readOnlyRoots: [this.context.inputPath, ...(this.context.skills ?? []).map(skill => dirname(skill.path))],
        command: commandPath(request.command), args: [...request.args], cwd: request.cwd,
        timeoutMs, maxOutputBytes: BUILTIN_AGENT_LIMITS.toolResultBytes,
        signal: AbortSignal.any([request.signal, this.stop.signal]) };
      // Fail before resolving skill credentials; dispatch launches synchronously
      // in the configuration lease with an explicit per-command environment.
      buildBuiltinSandboxLaunch(base);
    } catch (error) { throw failure(error); }
    let dispatched = false;
    return { dispatch: environment => {
      this.check(request.signal);
      if (dispatched) throw new AgentError('protocol_error');
      dispatched = true;
      const work = runBuiltinSandboxedCommand({ ...base, env: { ...environment } }, windowsSpawn, process.platform === 'win32' ? decodeWindowsCommandOutput : undefined).then(result => {
        this.check(request.signal);
        if (result.status !== 'exited') throw new AgentError('execution_limit');
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      }).catch(error => { throw failure(error); });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work)).catch(() => {});
      return work;
    } };
  }
  async execute(request: BuiltinAgentCommandRequest): Promise<BuiltinAgentCommandOutput> {
    const prepared = await this.prepare(request);
    return prepared.dispatch(request.environment);
  }
  async drain(): Promise<'drained'> {
    this.closed = true; this.stop.abort();
    await Promise.allSettled([...this.pending]);
    return 'drained';
  }
}
function failure(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof BuiltinSandboxError) {
    if (error.code === 'invalid_request') return new AgentError('invalid_configuration');
    if (error.code === 'sandbox_unavailable') return new AgentError('runtime_unavailable', process.platform === 'darwin'
      ? '命令执行需要可用的 macOS sandbox-exec。' : process.platform === 'linux'
      ? '命令执行需要 bubblewrap 和可用的用户命名空间。' : '当前 Windows 命令执行不支持所请求的限制。');
  }
  // Never include argv, environment, native errors or credential-bearing paths.
  return new AgentError('runtime_unavailable');
}
