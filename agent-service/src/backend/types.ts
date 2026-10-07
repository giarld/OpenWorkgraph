import type { ImageGenerationOptions, ModelSelection, ProjectFileInput, ResourceEnvelope, SandboxMode } from '@openworkgraph/protocol';
import type { TransportFailure } from './stdio.js';
import type { RunContextRequest, RunLineage } from '../run-context.js';
export type BackendState = 'starting' | 'running' | 'waiting_answer' | 'waiting_approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export interface BackendProgress { itemId: string; phase: 'commentary' | 'final_answer'; text: string }
export interface RuntimeSnapshot { runId: string; threadId: string | null; turnId: string | null; state: BackendState; observedAt: string; model: ModelSelection; reason: string | null; answer: string; progress?: BackendProgress; transportFailure?: TransportFailure }
export interface BackendQuestion { id: string; text: string; options: string[] }
export interface BackendInteraction { id: string; kind: 'question' | 'approval'; questions: BackendQuestion[]; reason: string; command: string | null; canApprove: boolean }
export type BackendReply = { kind: 'question'; answers: Record<string, string[]> } | { kind: 'approval'; decision: 'accept' | 'decline' };
/** Trusted service-resolved paths, never directly populated from a browser payload. */
export interface BackendRunContext { runId: string; kind: 'execution' | 'text_generation' | 'image_generation'; projectPath: string; inputPath: string; outputPath: string; serviceRoot: string; prompt: string; model: ModelSelection; imageOptions?: ImageGenerationOptions; sandboxMode?: SandboxMode; resources?: ResourceEnvelope[]; projectFiles?: ProjectFileInput[]; files?: { resourceId: string; version: number; path: string; sha256: string }[]; upstreamContext?: RunLineage; skills?: import('@openworkgraph/protocol').FrozenSkill[]; skillEnvironment?: Record<string,string> }
export interface BackendCallbacks {
  onSnapshot(snapshot: RuntimeSnapshot): void | Promise<void>;
  onInteraction(interaction: BackendInteraction): void | Promise<void>;
  /** Must authorize against this Run's project; no global graph/database endpoint. */
  queryHistory?(query: string): Promise<string>;
  /** Exact, paginated read; project scope is derived from the calling Run. */
  readRunContext?(request: RunContextRequest): Promise<string>;
  /** Private host-side resolution; its return value must never be sent as tool content. */
  skillEnvironment?(skillId: string): Promise<Record<string,string>>;
  /** Holds configuration locks through a synchronous launch/dispatch. null checks
   * all frozen revisions and supplies explicit env; a skillId activates that skill.
   * dispatch MUST spawn/send synchronously, without await. A returned RPC Promise
   * is wrapped in value and is not awaited under the lock. The second argument
   * contains only schema-declared secrets for output redaction. Values stay private. */
  withSkillEnvironment?<T>(skillId: string | null, dispatch: (environment: Record<string,string>, secrets: Record<string,string>) => T): Promise<{ value: T }>;
}
export interface BackendAdapter { start(context: BackendRunContext, callbacks: BackendCallbacks): Promise<RuntimeSnapshot>; cancel(runId: string): Promise<RuntimeSnapshot>; respond(runId: string, interactionId: string, reply: BackendReply): Promise<RuntimeSnapshot>; reconcile(runId: string): Promise<RuntimeSnapshot> }
/** Only bounded metadata; raw backend messages may contain credentials and paths. */
export interface BackendDiagnostic { reason?: 'unsupported_version' | 'invalid_handshake' | 'invalid_catalog'; method?: string; timeoutMs?: number; rpcCode?: number; version?: string }
export class BackendError extends Error { constructor(readonly code: 'UNAVAILABLE' | 'PROTOCOL' | 'TIMEOUT' | 'CONFLICT' | 'INVALID_INPUT' | 'MODEL_UNAVAILABLE' | 'ISOLATION_UNVERIFIED', message: string, readonly diagnostic?: BackendDiagnostic) { super(message); this.name = 'BackendError'; } }
