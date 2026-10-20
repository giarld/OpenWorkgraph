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
  /** Current host policy for plugin-owned discovery; not Run execution authority. */
  permissions?: Readonly<import('@openworkgraph/protocol').AgentProjectPermissions>;
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
  /** Host-frozen main model, when evaluating accepted or launch-ready work.
   * Optional for older callers/plugins; never inferred from today's defaults. */
  model?: Readonly<FrozenAgentSelection['model']>;
  /** Current catalog metadata for submission preflight; not a replacement for native launch checks. */
  modelCapabilities?: Readonly<AgentModelOption>;
  skills?: readonly import('@openworkgraph/protocol').FrozenSkill[];
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
export interface AgentRestartContext {
  runId: string; attemptId: string; serviceRoot: string; projectPath: string;
  selection: Readonly<AgentExecutionSelection>; signal: AbortSignal;
}
/** Optional bridges are typed and versioned. Actual authorization, protected
 * values, command barriers and publication remain in the host. */
export interface AgentExtensions {
  /** Finite plugin-owned operations on this frozen, attached Run. */
  runOperations?: { version: 1; execute(context: AgentExtensionContext, request: Json): Promise<Json> };
  /** Reconcile only the original private attempt after host loss. A drained
   * result proves all native actions stopped; it never resubmits task input. */
  restartRecovery?: { version: 1; reconcile(context: AgentRestartContext): Promise<'drained' | 'unknown'>; operation?(context: AgentRestartContext, request: Json): Promise<Json> };
  nativeCatalog?: { version: 1; list(context: AgentQueryContext): Promise<import('@openworkgraph/protocol').AgentNativeCatalog> };
  nativeSkills?: { version: 1; list(context: AgentQueryContext): Promise<readonly AgentNativeSkill[]> };
  configuredSkills?: { version: 1; prepare(context: AgentExtensionContext): Promise<void> };
  dynamicSkillCommands?: { version: 1; dispatch(context: AgentExtensionContext, request: Json): Promise<Json> };
  historyTools?: { version: 1; install(context: AgentExtensionContext): Promise<void> };
  conversationContinuation?: { version: 1; continue(context: AgentExtensionContext, message: string): Promise<RuntimeSnapshot> };
  reattach?: { version: 1; attach(context: AgentExtensionContext): Promise<RuntimeSnapshot> };
}
export interface AgentPlugin {
  /** Native mapping; project policy never prevents writing Run inputs/outputs. */
  projectPermissions?(mode: import('@openworkgraph/protocol').SandboxMode, context: { projectPath?: string; runsPath?: string }): Record<string, AgentOptionValue>;
  descriptor: AgentDescriptor;
  createAdapter(dependencies: AgentAdapterDependencies): AgentAdapter | Promise<AgentAdapter>;
  diagnose?(context: AgentQueryContext): Promise<AgentAvailability>;
  listModels?(context: AgentQueryContext): Promise<readonly AgentModelOption[]>;
  /** Pure provider grouping for discovered, saved and custom model identities. */
  modelGroup?(modelId: string): string | null;
  /** Pure settings-editor projection. APIs and historical frozen options retain native semantics. */
  normalizeSettings?(options: Readonly<Record<string, AgentOptionValue>>, platform: AgentPlatform): Record<string, AgentOptionValue>;
  evaluateTask?(requirements: AgentTaskRequirements): AgentAvailability;
  extensions?: AgentExtensions;
}
