import type { Json } from '@openworkgraph/protocol';
import type { StdioRpc } from './stdio.js';
import { BackendError } from './types.js';
import { MINIMUM_CODEX_VERSION } from './capabilities.js';

export type CodexStage = 'initialize' | 'model/list' | 'thread/start' | 'turn/start';
const stages: Record<CodexStage, string> = { initialize: '连接握手', 'model/list': '读取模型列表', 'thread/start': '启动任务会话', 'turn/start': '启动任务' };
/** Explain observed failures without forwarding stderr, backend messages, accounts or paths. */
export function describeCodexFailure(error: unknown, rpc?: StdioRpc, fallbackStage: CodexStage = 'initialize'): { message: string; details: Record<string, Json>; retryable: boolean } {
  const diagnostic = error instanceof BackendError ? error.diagnostic : undefined;
  const method = diagnostic?.method;
  const stage = method && Object.hasOwn(stages, method) ? method as CodexStage : fallbackStage;
  const details: Record<string, Json> = { source: 'codex', stage };
  let reason = diagnostic?.reason as string | undefined;
  let explanation: string;
  let retryable = false;
  const failure = rpc?.failure;
  if (reason === 'unsupported_version') {
    explanation = `Codex CLI ${diagnostic?.version ?? ''} 不支持任务执行所需协议，请升级到 ${MINIMUM_CODEX_VERSION} 或更高稳定版本。`;
    details.minimumVersion = MINIMUM_CODEX_VERSION;
    if (diagnostic?.version) details.version = diagnostic.version;
  } else if (reason === 'invalid_handshake') explanation = 'Codex 返回的连接握手数据无效，请检查 CLI 版本兼容性。';
  else if (reason === 'invalid_catalog') explanation = 'Codex 返回的模型目录、推理强度或分页数据格式无效，请检查 CLI 版本兼容性。';
  else if (error instanceof BackendError && error.code === 'MODEL_UNAVAILABLE') {
    reason = 'model_unavailable'; explanation = '所选模型或推理强度在当前 Codex 目录中不可用，请重新选择。';
  }
  else if (error instanceof BackendError && error.code === 'TIMEOUT') {
    reason = 'rpc_timeout'; retryable = true;
    explanation = `Codex 在 ${diagnostic?.timeoutMs ?? 15000} 毫秒内未响应。`;
    if (diagnostic?.timeoutMs !== undefined) details.timeoutMs = diagnostic.timeoutMs;
  } else if (failure?.kind === 'spawn_error') {
    reason = failure.spawnCode === 'ENOENT' ? 'executable_not_found' : ['EACCES', 'EPERM'].includes(failure.spawnCode ?? '') ? 'execution_denied' : 'spawn_error';
    explanation = reason === 'executable_not_found' ? '找不到 Codex 可执行程序，请在工作空间设备上安装 Codex CLI，并确认启动工作空间的进程能找到该命令。'
      : reason === 'execution_denied' ? '操作系统拒绝执行 Codex，请检查工作空间账户的执行权限。'
      : 'Codex 进程无法启动，请检查可执行程序及工作空间目录是否可用。';
    if (failure.spawnCode) details.spawnCode = failure.spawnCode;
  } else if (failure?.kind === 'process_exit') {
    reason = 'process_exit'; retryable = true;
    explanation = 'Codex 进程在请求完成前退出' + (failure.exitCode != null ? `，退出码 ${failure.exitCode}` : failure.exitSignal ? `，信号 ${failure.exitSignal}` : '') + '。';
    if (failure.exitCode !== undefined) details.exitCode = failure.exitCode;
    if (failure.exitSignal !== undefined) details.exitSignal = failure.exitSignal;
  } else if (failure?.kind === 'invalid_frame' || failure?.kind === 'frame_too_large') {
    reason = failure.kind;
    explanation = reason === 'invalid_frame' ? 'Codex 输出了无效的 JSON-RPC 消息。' : 'Codex 输出消息超过工作空间支持的大小限制。';
  } else if (diagnostic?.rpcCode !== undefined) {
    const code = diagnostic.rpcCode; details.rpcCode = code;
    reason = code === -32601 ? 'unsupported_method' : code === -32602 ? 'invalid_arguments' : 'request_rejected';
    explanation = code === -32601 ? `Codex 不支持此协议请求（${code}），请检查 CLI 版本兼容性。`
      : code === -32602 ? `Codex 拒绝了请求参数（${code}），请检查 CLI 版本兼容性。`
      : `Codex 拒绝了请求，协议错误码 ${code}。`;
  } else if (error instanceof BackendError && error.code === 'PROTOCOL') {
    reason = 'invalid_response'; explanation = 'Codex 返回的协议响应无效。';
  } else if (failure?.kind === 'stdin_error' || failure?.kind === 'host_close' || error instanceof BackendError && error.code === 'UNAVAILABLE') {
    reason = failure?.kind ?? 'disconnected'; retryable = true; explanation = 'Codex 连接在请求完成前关闭。';
  } else {
    reason = 'unknown_error'; explanation = '发生未分类的连接错误，请检查工作空间设备上的 Codex 状态。';
  }
  details.reason = reason;
  return { message: `Codex ${stages[stage]}失败：${explanation}`, details, retryable };
}
