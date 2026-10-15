import type { AgentBackendConfiguration, AgentConfiguredModel, AgentOptionValue } from '../../../packages/protocol/src/agents';

export interface BackendConfigurationFields {
  options: Record<string, AgentOptionValue>; enabled: boolean; models: AgentConfiguredModel[];
}

/** Saved values own the editor; newly discovered models only add hidden choices. */
export function backendConfigurationFields(saved: AgentBackendConfiguration, discovered: readonly AgentConfiguredModel[]): BackendConfigurationFields {
  return { options: { ...saved.options }, enabled: saved.enabled,
    models: [...saved.models.map(model => ({ ...model })), ...discovered.filter(model => !saved.models.some(item => item.id === model.id)).map(model => ({ ...model, visible: false }))] };
}
