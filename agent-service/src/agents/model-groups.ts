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

export function modelDisplayMetadata(plugin: AgentPlugin, modelId: string, catalog?: AgentModelOption): Pick<AgentModelOption, 'group' | 'label'> {
  const group = plugin.modelGroup ? plugin.modelGroup(modelId) : catalog?.group;
  const label = plugin.modelLabel ? plugin.modelLabel(modelId) ?? undefined : catalog?.label;
  if (group !== undefined && group !== null && (!publicText(group, 256) || group !== group.trim())) throw new AgentError('protocol_error');
  if (label !== undefined && (!publicText(label, 512) || label !== label.trim())) throw new AgentError('protocol_error');
  return { ...(group === undefined ? {} : { group }), ...(label === undefined ? {} : { label }) };
}
