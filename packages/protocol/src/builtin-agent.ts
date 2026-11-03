import type { ResourceEnvelope } from './index.js';

export type BuiltinAgentProtocol = 'responses' | 'chat-completions';
/** Explicit declarations; null means unknown, never inferred from a model name. */
export interface BuiltinAgentModel {
  id: string; name: string; tools: boolean | null;
  inputKinds: ResourceEnvelope['kind'][];
  contextWindow: number | null; reasoningEfforts: string[];
  /** Per-request generation budget, including reasoning; absent/null uses the product default. */
  maxOutputTokens?: number | null;
}
/** Optional directory metadata seeds new model settings; absent means unknown. */
export interface BuiltinAgentDiscoveredModel {
  id: string; name: string; reasoningEfforts?: string[]; contextWindow?: number; inputKinds?: ResourceEnvelope['kind'][];
}
export interface BuiltinAgentConnectionConfiguration {
  id: string; name: string; protocol: BuiltinAgentProtocol; endpoint: string;
  /** Chat serializer override for proxies. Absent uses OpenAI for its official origin, compatible otherwise. */
  chatProvider?: 'openai' | 'openai-compatible';
  enabled: boolean; models: BuiltinAgentModel[];
}
/** Public reads/exports contain status only; authentication uses a write-only API. */
export interface BuiltinAgentConnection extends BuiltinAgentConnectionConfiguration {
  revision: number; credentialConfigured: boolean;
}
/** Workspace-local immutable reference. It conveys no credential authority elsewhere. */
export interface FrozenBuiltinAgentConnection {
  workspaceId: string; connectionId: string; revision: number; modelId: string;
}
