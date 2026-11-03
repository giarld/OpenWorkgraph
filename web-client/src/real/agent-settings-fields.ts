import type { AgentBackendConfiguration, AgentConfiguredModel, AgentOptionValue } from '../../../packages/protocol/src/agents';

export interface BackendConfigurationFields {
  options: Record<string, AgentOptionValue>; enabled: boolean; models: AgentConfiguredModel[];
}

/** Manual visibility preserves saved flags; automatic visibility follows discovery. */
export function backendConfigurationFields(saved: AgentBackendConfiguration, discovered: readonly AgentConfiguredModel[], automaticVisibility = false): BackendConfigurationFields {
  return { options: { ...saved.options }, enabled: saved.enabled,
    models: automaticVisibility ? discovered.map(model => ({ ...model, visible: true })) : [...saved.models.map(model => ({ ...model })), ...discovered.filter(model => !saved.models.some(item => item.id === model.id)).map(model => ({ ...model, visible: false }))] };
}
