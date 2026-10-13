import type { Json, ModelSelection, ResourceEnvelope } from './index.js';

/** Product version is independent of this additive plugin contract. */
export const AGENT_PLUGIN_API_VERSION = '1.0' as const;
export type AgentRunKind = 'execution' | 'text_generation' | 'image_generation' | 'visualize_generation';
export type AgentPlatform = 'darwin' | 'linux' | 'win32';
export type AgentOptionValue = string | number | boolean;
export interface AgentConfigurationField {
  name: string; type: 'text' | 'boolean' | 'enum' | 'number'; label: string; description?: string;
  required?: boolean; default?: AgentOptionValue; values?: string[]; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; integer?: boolean; platforms?: AgentPlatform[];
}
export interface AgentConfigurationSchema { version: number; fields: AgentConfigurationField[] }
export interface AgentCapabilities {
  kinds: AgentRunKind[]; inputKinds: ResourceEnvelope['kind'][]; platforms?: AgentPlatform[];
  cancellation: boolean; restoredRunStart: boolean; conversationContinuation: boolean; reattach: boolean;
  approvals: boolean; userInput: boolean; historyTools: boolean; nativeSkills: boolean;
  configuredSkills: boolean; dynamicSkillCommands: boolean; visualize: boolean;
}
export interface AgentModelPolicy { type: 'dynamic' | 'suggested' | 'manual'; allowCustom: boolean; effort: boolean }
export interface AgentDescriptor {
  id: string; name: string; description: string; implementationVersion: string; apiVersion: string;
  configuration: AgentConfigurationSchema; capabilities: AgentCapabilities; models: AgentModelPolicy;
}
export type AgentFailureReason = 'capability_unsupported' | 'invalid_configuration' | 'model_unavailable' | 'runtime_unavailable' | 'protocol_error' | 'timeout' | 'outcome_unknown';
export interface AgentAvailability { status: 'available' | 'unavailable' | 'unknown'; reason: AgentFailureReason | null; message: string; runtimeVersion?: string }
export interface AgentModelOption { id: string; reasoningEfforts: string[]; defaultReasoningEffort?: string | null }
/** All options are public validated values, never environment/credentials/paths. */
export interface AgentSettings { backendId: string; revision: number; enabled: boolean; schemaVersion: number; options: Record<string, AgentOptionValue>; model: ModelSelection | null }
export interface AgentDefault { revision: number; backendId: string }
export interface AgentSelection { backendId: string; configRevision: number; schemaVersion: number; options?: Record<string, AgentOptionValue>; model?: ModelSelection }
export interface FrozenAgentSelection {
  backendId: string; apiVersion: string; schemaVersion: number; implementationVersion: string;
  runtimeVersion: string | null; configRevision: number; options: Record<string, AgentOptionValue>; model: ModelSelection;
}
export interface AgentMessageIdentity { backendId: string; attemptId: string; messageId: string; sessionId?: string; turnId?: string }
export type AgentQuestionMode = 'text' | 'single' | 'multiple';
export type AgentApprovalDetails = { version: 1; kind: 'command' | 'file_change' | 'permissions' | 'tool'; summary: string; command?: string; paths?: string[]; permissions?: Json; scope?: string };
export interface AgentNativeSkillIdentity { source: 'agent'; backendId: string; skillId: string }
