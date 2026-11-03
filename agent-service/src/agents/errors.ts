import type { AgentFailureReason, ErrorCode } from '@openworkgraph/protocol';
import { ServiceError } from '../errors.js';

const codes: Record<AgentFailureReason, ErrorCode> = {
  capability_unsupported: 'NOT_IMPLEMENTED', invalid_configuration: 'INVALID_REQUEST',
  model_unavailable: 'MODEL_UNAVAILABLE', runtime_unavailable: 'PLUGIN_UNAVAILABLE',
  // Native/plugin failures do not invalidate the Web client's Workspace protocol.
  protocol_error: 'PLUGIN_UNAVAILABLE', timeout: 'PLUGIN_UNAVAILABLE', outcome_unknown: 'CONFLICT',
  authentication_required: 'PLUGIN_UNAVAILABLE', quota_exceeded: 'PLUGIN_UNAVAILABLE', permission_denied: 'INPUT_BLOCKED',
  execution_limit: 'INPUT_BUDGET_EXCEEDED', context_limit: 'INPUT_BUDGET_EXCEEDED', output_limit: 'INPUT_BUDGET_EXCEEDED', input_size_limit: 'INPUT_BUDGET_EXCEEDED',
};
const messages: Record<AgentFailureReason, string> = {
  capability_unsupported: '执行器不支持此操作。', invalid_configuration: '执行器配置无效。',
  model_unavailable: '所选模型或推理强度不可用。', runtime_unavailable: '执行器运行依赖不可用。',
  protocol_error: '执行器契约或响应无效。', timeout: '执行器响应超时。', outcome_unknown: '执行结果尚未确认。',
  authentication_required: '执行器认证不可用，请在设备上重新认证后重试。', quota_exceeded: '执行器额度不足或请求受限，请检查提供商额度后重试。', permission_denied: '执行器拒绝了任务所需权限，请检查权限设置后重试。',
  execution_limit: '已达到 Agent 执行上限，请检查历史后重新提交。',
  context_limit: '输入超过所选模型的上下文预算，请缩小输入或选择更大容量模型。',
  input_size_limit: '输入文件或请求体超过大小上限，请减小文件或缩小输入后重试。',
  output_limit: '模型本轮生成达到输出上限，请在 Agent 设置中增大单次输出上限，或降低思考强度、缩小任务后重试。',
};
/** Private host diagnostic lineage; never serialized as public details/cause. */
const origins = new WeakMap<AgentError, unknown>();
export function getAgentErrorOrigin(error: unknown): unknown { return error instanceof AgentError ? origins.get(error) : undefined; }
/** Public errors contain stable bounded facts, never native messages/env/paths. */
export class AgentError extends ServiceError {
  constructor(readonly reason: AgentFailureReason, message = messages[reason]) {
    super(codes[reason], message, { details: { reason }, retryable: reason === 'timeout' || reason === 'runtime_unavailable' });
    this.name = 'AgentError';
  }
}
export function agentError(error: unknown, fallback: AgentFailureReason = 'protocol_error'): AgentError {
  // Reconstruct even an AgentError: plugins may have supplied an unsafe message.
  const normalized = new AgentError(error instanceof AgentError ? error.reason : fallback);
  origins.set(normalized, error); return normalized;
}
export function configurationError(): never { throw new AgentError('invalid_configuration'); }
