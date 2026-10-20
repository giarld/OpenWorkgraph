import type { AgentModelOption } from '@openworkgraph/protocol';
import type { AgentPlugin } from './contracts.js';
import { publicText } from './configuration.js';
import { AgentError } from './errors.js';

/** Shared plugin helper for native catalogs using provider/model identities.
 * The host and Web never infer a provider from an opaque model ID. */
export function modelProviderGroup(modelId: string): string | null {
  const separator = modelId.indexOf('/');
  return separator > 0 ? modelId.slice(0, separator) : null;
}

export function modelGroupMetadata(plugin: AgentPlugin, modelId: string): Pick<AgentModelOption, 'group'> {
  if (!plugin.modelGroup) return {};
  const group = plugin.modelGroup(modelId);
  if (group !== null && (!publicText(group, 256) || group !== group.trim())) throw new AgentError('protocol_error');
  return { group };
}
