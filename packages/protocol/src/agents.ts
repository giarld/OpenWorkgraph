import type { Json, ModelSelection, ResourceEnvelope, SandboxMode } from './index.js';

/** Product version is independent of this additive plugin contract. */
export const AGENT_PLUGIN_API_VERSION = '1.0' as const;
export type AgentRunKind = 'execution' | 'text_generation' | 'image_generation' | 'visualize_generation';
export type AgentPlatform = 'darwin' | 'linux' | 'win32';
export type AgentOptionValue = string | number | boolean;
/** Node preference only; current configuration and permissions freeze at submission. */
export interface AgentModelPreference { backendId: string; model: ModelSelection }
export interface AgentConfigurationField {
  name: string; type: 'text' | 'boolean' | 'enum' | 'number'; label: string; description?: string;
  required?: boolean; default?: AgentOptionValue; values?: string[]; minimum?: number; maximum?: number;
  /** Plugin-owned options may remain available to APIs while hidden in settings. */
  hidden?: boolean;
  minLength?: number; maxLength?: number; integer?: boolean; platforms?: AgentPlatform[];
}
export interface AgentConfigurationSchema { version: number; fields: AgentConfigurationField[] }
export interface AgentCapabilities {
  kinds: AgentRunKind[]; inputKinds: ResourceEnvelope['kind'][]; platforms?: AgentPlatform[];
  cancellation: boolean; restoredRunStart: boolean; conversationContinuation: boolean; reattach: boolean;
  approvals: boolean; userInput: boolean; historyTools: boolean; nativeSkills: boolean;
  configuredSkills: boolean; dynamicSkillCommands: boolean; visualize: boolean;
}
export interface AgentModelPolicy { type: 'dynamic' | 'suggested' | 'manual'; allowCustom: boolean; effort: boolean; /** Native variant fallback, frozen with options. When effort is supported, a non-null reasoningEffort takes precedence and the plugin translates it. */ variantOption?: string }
export interface AgentLogo { symbol: string; color: string }
export interface AgentDescriptor {
  /** Finite text mark; never a URL, SVG payload or filesystem path. */
  logo?: AgentLogo;
  /** Supported project modes for new configuration; discovery remains independent. */
  projectPermissionModes?: SandboxMode[];
  id: string; name: string; description: string; implementationVersion: string; apiVersion: string;
  configuration: AgentConfigurationSchema; capabilities: AgentCapabilities; models: AgentModelPolicy;
}
export const AGENT_FAILURE_REASONS = ['capability_unsupported', 'invalid_configuration', 'model_unavailable', 'runtime_unavailable', 'protocol_error', 'timeout', 'outcome_unknown', 'authentication_required', 'quota_exceeded', 'permission_denied'] as const;
export type AgentFailureReason = typeof AGENT_FAILURE_REASONS[number];
/** Presence on the Workspace device; separate from authentication and execution readiness. */
export type AgentInstallationStatus = 'installed' | 'missing' | 'unknown';
export interface AgentAvailability { status: 'available' | 'unavailable' | 'unknown'; reason: AgentFailureReason | null; message: string; runtimeVersion?: string; installation?: AgentInstallationStatus }
/** reasoningEfforts use the plugin's display order: increasing strength when known, followed by other native variants. */
export interface AgentModelOption { id: string; reasoningEfforts: string[]; defaultReasoningEffort?: string | null; /** Unordered names; never interpreted as reasoning strength. */ variants?: string[]; inputKinds?: ResourceEnvelope['kind'][]; tools?: boolean; /** Plugin-provided provider group; null/absent means native. Model IDs remain opaque. */ group?: string | null }
export interface AgentNativeProfile { id: string; name: string; mode: 'primary' | 'subagent' | 'all'; hidden: boolean }
export interface AgentNativeCommand { id: string; description: string | null }
export interface AgentNativeCatalog { version: 1; revision: string; profiles: AgentNativeProfile[]; commands: AgentNativeCommand[]; /** Option in the finite configuration schema, if profiles are selectable. */ profileOption?: string }
/** All options are public validated values, never environment/credentials/paths. */
export interface AgentSettings { backendId: string; revision: number; enabled: boolean; schemaVersion: number; options: Record<string, AgentOptionValue>; model: ModelSelection | null }
export interface AgentDefault { revision: number; backendId: string }
export interface AgentSelection { settingsGeneration?: AgentSettingsGeneration; permissions?: AgentProjectPermissions; backendId: string; configRevision: number; schemaVersion: number; options?: Record<string, AgentOptionValue>; model?: ModelSelection }
export interface FrozenAgentSelection {
  settingsGeneration?: AgentSettingsGeneration; permissions?: AgentProjectPermissions;
  backendId: string; apiVersion: string; schemaVersion: number; implementationVersion: string;
  runtimeVersion: string | null; configRevision: number; options: Record<string, AgentOptionValue>; model: ModelSelection;
}
export interface AgentMessageIdentity { backendId: string; attemptId: string; messageId: string; sessionId?: string; turnId?: string }
export type AgentQuestionMode = 'text' | 'single' | 'multiple';
export type AgentApprovalDetails = { version: 1; kind: 'command' | 'file_change' | 'permissions' | 'tool'; summary: string; command?: string; paths?: string[]; permissions?: Json; scope?: string };
export interface AgentNativeSkillIdentity { source: 'agent'; backendId: string; skillId: string }

/** Independent from legacy settings; absent on historical selections. */
export type AgentSettingsGeneration = 'agent-configuration-v1';
export interface AgentProjectPermissions { revision: number; project: SandboxMode; runs: 'read-write' }
export interface AgentConfiguredModel { id: string; visible: boolean; /** Read-only settings catalog metadata; never persisted with visibility. */ group?: string | null }
export interface AgentBackendConfiguration {
  backendId: string; revision: number; enabled: boolean; schemaVersion: number;
  options: Record<string, AgentOptionValue>; models: AgentConfiguredModel[];
}
export interface AgentWorkspaceDefault { revision: number; selection: ({ backendId: string } & ModelSelection) | null }
export interface AgentBackendOrder { revision: number; backendIds: string[] }
export interface AgentWorkspaceConfiguration {
  /** Current Workspace device, returned by reads; never imported or persisted. */
  platform?: AgentPlatform;
  formatVersion: 1; settingsGeneration: AgentSettingsGeneration; workspaceId: string;
  permissions: AgentProjectPermissions; backends: AgentBackendConfiguration[];
  default: AgentWorkspaceDefault; order: AgentBackendOrder;
}
export type AgentConfigurationUpdate =
  | { section: 'permissions'; expectedRevision: number; project: SandboxMode }
  | { section: 'backend'; expectedRevision: number; backendId: string; enabled: boolean; schemaVersion: number; options: Record<string, AgentOptionValue>; models: AgentConfiguredModel[]; source?: 'settings' }
  | { section: 'default'; expectedRevision: number; selection: AgentWorkspaceDefault['selection'] }
  | { section: 'order'; expectedRevision: number; backendIds: string[] };
