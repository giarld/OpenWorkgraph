import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAvailability, SandboxMode } from '@openworkgraph/protocol';
import type { AgentQueryContext } from '../contracts.js';
import type { BackendRunContext } from '../../backend/types.js';
import type { BuiltinAgentCommandOutput } from './adapter.js';
import { AgentError } from '../errors.js';
import { BuiltinCommands } from './commands.js';

const marker = 'openworkgraph-command-probe';
/** Fixed host-owned probes, never project/skill code. Optional task tools such
 * as Python/Git remain checked by the actual command resolver when requested. */
export function builtinCommandProbes(platform: string): { label: string; command: string; args: string[] }[] {
  const probes = [{ label: 'Node.js / 原生命令执行器', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("probe.txt","ready");process.stdout.write("' + marker + '")'] }];
  if (platform === 'win32') probes.push(
    { label: 'Windows 命令解释器', command: 'cmd.exe', args: ['/d', '/s', '/c', 'echo ' + marker] },
    { label: 'PowerShell', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write("' + marker + '")'] },
  );
  else probes.push({ label: '系统 Shell', command: '/bin/sh', args: ['-c', 'printf %s ' + marker] });
  return probes;
}

/** Verify the real foreground launch path in disposable directories. Discovery
 * cleanup is registered before acquisition and joins the original operations. */
export async function diagnoseBuiltinCommands(context: AgentQueryContext): Promise<AgentAvailability | null> {
  context.signal.throwIfAborted();
  if (context.platform !== process.platform || !['win32', 'darwin', 'linux'].includes(context.platform)) return { status: 'unavailable', reason: 'capability_unsupported', message: '当前设备不支持所选命令执行平台。', installation: 'installed' };
  const mode = (context.permissions?.project ?? context.options.sandboxMode ?? 'read-only') as SandboxMode;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new AgentError('invalid_configuration');
  const stop = new AbortController(), signal = AbortSignal.any([context.signal, stop.signal]);
  let ownedRoot: string | undefined, commands: BuiltinCommands | undefined;
  let preparing: Promise<BackendRunContext> | undefined, executing: Promise<BuiltinAgentCommandOutput> | undefined, cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    stop.abort();
    await preparing?.catch(() => {}); await executing?.catch(() => {}); await commands?.drain();
    if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  })();
  context.deferCleanup(cleanup);
  let label = '临时执行目录';
  try {
    signal.throwIfAborted();
    preparing = (async () => {
      ownedRoot = await mkdtemp(join(tmpdir(), 'openworkgraph-command-probe-'));
      const root = await realpath(ownedRoot), projectPath = join(root, 'project'), serviceRoot = join(root, 'service');
      const inputPath = join(serviceRoot, 'runs/probe/input'), outputPath = join(serviceRoot, 'runs/probe/output');
      await Promise.all([projectPath, inputPath, outputPath].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
      signal.throwIfAborted();
      return { runId: 'probe', attemptId: 'probe', kind: 'execution', prompt: '', projectPath, serviceRoot, inputPath, outputPath, model: { model: 'probe', reasoningEffort: null } };
    })();
    const input = await preparing;
    commands = new BuiltinCommands(input, mode);
    for (const probe of builtinCommandProbes(context.platform)) {
      signal.throwIfAborted(); label = probe.label;
      executing = commands.execute({ command: probe.command, args: probe.args, cwd: input.outputPath, environment: {}, signal, timeoutMs: 2000 });
      const result = await executing; signal.throwIfAborted();
      if (result.exitCode !== 0 || result.stdout.trim() !== marker) throw new AgentError('runtime_unavailable', context.platform === 'linux' ? '请检查 bubblewrap 安装和用户命名空间权限。' : context.platform === 'darwin' ? '请检查 sandbox-exec 是否可执行。' : '请检查命令是否可执行及访问权限。');
    }
    return null;
  } catch (error) {
    context.signal.throwIfAborted();
    return { status: 'unavailable', reason: 'runtime_unavailable', message: '命令环境检查失败（' + label + '）：' + (error instanceof AgentError ? error.message : '请检查工作空间临时目录和命令安装。'), installation: 'installed' };
  } finally { await cleanup(); }
}
