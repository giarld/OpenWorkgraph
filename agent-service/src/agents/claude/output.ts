import type { Json } from '@openworkgraph/protocol';
import { redactSkillValues } from '../../backend/redaction.js';
import { AgentError } from '../errors.js';

/** Preserve the native output schema while masking string values before they
 * reach the model. Redacting serialized JSON could corrupt keys or escapes. */
export function redactClaudeOutput(value: unknown, secrets: Record<string, string>, depth = 0): Json {
  if (depth > 64) throw new AgentError('protocol_error');
  if (typeof value === 'string') return redactSkillValues(value, secrets);
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => redactClaudeOutput(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactClaudeOutput(item, secrets, depth + 1)]));
  throw new AgentError('protocol_error');
}
