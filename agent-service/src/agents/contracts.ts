import type { AgentAvailability, AgentDescriptor, AgentModelOption, AgentOptionValue, AgentPlatform, AgentRunKind, FrozenAgentSelection, Json, ProjectFileInput, ResourceEnvelope } from '@openworkgraph/protocol';
import type { BackendAdapter, BackendCallbacks, BackendRunContext, RuntimeSnapshot } from '../backend/types.js';

export type { AgentAvailability, AgentCapabilities, AgentConfigurationField, AgentConfigurationSchema, AgentDescriptor, AgentModelOption, AgentOptionValue, AgentPlatform, AgentSettings, AgentSelection, FrozenAgentSelection } from '@openworkgraph/protocol';
export { AGENT_PLUGIN_API_VERSION } from '@openworkgraph/protocol';
export type { AgentFailureReason, AgentRunKind, Json, ModelSelection, ProjectFileInput, ResourceEnvelope } from '@openworkgraph/protocol';
export type { BackendAdapter, BackendCallbacks, BackendRunContext, BackendReply, BackendInteraction, RuntimeSnapshot } from '../backend/types.js';

/** The router owns Run/attempt attachment and all business state transitions.
 * Release requires a persisted terminal Run and confirmation of ALL side effects.
 * Disposal closes resources only: it must never cancel or manufacture completion. */
export interface AgentAdapter extends BackendAdapter {
  releaseRun(runId: string): void | Promise<void>;
  disposeUnstarted(): void | Promise<void>;
  disposeDrained(): void | Promise<void>;
}

/** Private interpretation of a pre-plugin Codex snapshot. Nulls explicitly mean
 * that the old format never observed a plugin/configuration version. This
 * envelope is for attachment only and must never be persisted as input. */
export interface LegacyAgentSelection {
  legacy: true; backendId: string; apiVersion: string; schemaVersion: number;
  implementationVersion: null; runtimeVersion: null; configRevision: null;
  options: Readonly<Record<string, AgentOptionValue>>;
  model: FrozenAgentSelection['model'];
}
export type AgentExecutionSelection = FrozenAgentSelection | LegacyAgentSelection;

/** One factory invocation is bounded to this frozen Run/attempt. Host tools and
 * protected skill dispatch arrive through start callbacks, never a DB/global env. */
export interface AgentAdapterDependencies {
  runId: string;
  attemptId: string;
  selection: Readonly<AgentExecutionSelection>;
  platform: AgentPlatform;
  signal?: AbortSignal;
}

/** Register cleanup BEFORE opening a process/transport. The discovery service
 * calls each hook exactly once on success, failure, timeout or last-waiter abort.
 * Hooks must close queries promptly; abort must prevent late resource acquisition. */
export interface AgentQueryContext {
  platform: AgentPlatform;
  /** Host-resolved project scope for native skills; never a public option. */
  projectPath?: string;
  options: Readonly<Record<string, AgentOptionValue>>;
  signal: AbortSignal;
  deferCleanup(cleanup: () => void | Promise<void>): void;
}
export interface AgentTaskRequirements {
  kind: AgentRunKind;
  platform: AgentPlatform;
  options: Readonly<Record<string, AgentOptionValue>>;
  inputKinds: readonly ResourceEnvelope['kind'][];
  resources?: readonly ResourceEnvelope[];
  projectFiles?: readonly ProjectFileInput[];
  visualize?: boolean;
  restoredRunStart?: boolean;
}
export interface AgentExtensionContext {
  runId: string; attemptId: string; signal: AbortSignal;
  context: Readonly<BackendRunContext>; callbacks: BackendCallbacks;
}
export interface AgentNativeSkill { skillId: string; name: string; description: string }
/** Optional bridges are typed and versioned. Actual authorization, protected
 * values, command barriers and publication remain in the host. */
export interface AgentExtensions {
  nativeSkills?: { version: 1; list(context: AgentQueryContext): Promise<readonly AgentNativeSkill[]> };
  configuredSkills?: { version: 1; prepare(context: AgentExtensionContext): Promise<void> };
  dynamicSkillCommands?: { version: 1; dispatch(context: AgentExtensionContext, request: Json): Promise<Json> };
  historyTools?: { version: 1; install(context: AgentExtensionContext): Promise<void> };
  conversationContinuation?: { version: 1; continue(context: AgentExtensionContext, message: string): Promise<RuntimeSnapshot> };
  reattach?: { version: 1; attach(context: AgentExtensionContext): Promise<RuntimeSnapshot> };
}
export interface AgentPlugin {
  descriptor: AgentDescriptor;
  createAdapter(dependencies: AgentAdapterDependencies): AgentAdapter | Promise<AgentAdapter>;
  diagnose?(context: AgentQueryContext): Promise<AgentAvailability>;
  listModels?(context: AgentQueryContext): Promise<readonly AgentModelOption[]>;
  evaluateTask?(requirements: AgentTaskRequirements): AgentAvailability;
  extensions?: AgentExtensions;
}
