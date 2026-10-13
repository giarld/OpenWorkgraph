import type { AgentFailureReason, ErrorCode } from '@openworkgraph/protocol';
import { ServiceError } from '../errors.js';

const codes: Record<AgentFailureReason, ErrorCode> = {
  capability_unsupported: 'NOT_IMPLEMENTED', invalid_configuration: 'INVALID_REQUEST',
  model_unavailable: 'MODEL_UNAVAILABLE', runtime_unavailable: 'PLUGIN_UNAVAILABLE',
  // Native/plugin failures do not invalidate the Web client's Workspace protocol.
  protocol_error: 'PLUGIN_UNAVAILABLE', timeout: 'PLUGIN_UNAVAILABLE', outcome_unknown: 'CONFLICT',
};
const messages: Record<AgentFailureReason, string> = {
  capability_unsupported: '执行器不支持此操作。', invalid_configuration: '执行器配置无效。',
  model_unavailable: '所选模型或推理强度不可用。', runtime_unavailable: '执行器运行依赖不可用。',
  protocol_error: '执行器契约或响应无效。', timeout: '执行器查询超时。', outcome_unknown: '执行结果尚未确认。',
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
