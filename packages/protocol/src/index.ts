/** Public wire types. Never expose SQLite rows or backend-specific events here. */
export * from './pairing.js';
export * from './resource-mime.js';
export * from './execution-chain.js';
export * from './graph-title.js';
export * from './node-title.js';
export * from './graph-binary.js';
export const PROTOCOL_VERSION = '1.0' as const;
export const SERVICE_VERSION = '0.4.3' as const;
/** Work Graph uploads use the UI's binary MB convention. */
export const WORKGRAPH_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;
export const WORKGRAPH_TRANSFER_TOTAL_BYTES = 1024 * 1024 * 1024;
export const WORKGRAPH_BUNDLE_MAX_BYTES = 1536 * 1024 * 1024;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Scope { serviceId: string; projectId: string }
export interface GraphScope extends Scope { graphId: string }
export const RUN_STATUSES = ['accepted', 'queued', 'preparing', 'running', 'waiting_answer', 'waiting_approval', 'agent_completed', 'finalizing', 'cancelling', 'reconciling', 'paused_restore', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type RunStatus = typeof RUN_STATUSES[number];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];
/** Fail closed: unknown future states must retain locks until reconciled. */
export function isTerminalRunStatus(status: string): boolean { return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status); }
export const ERROR_CODES = ['INVALID_REQUEST', 'UNAUTHENTICATED', 'ORIGIN_DENIED', 'HOST_DENIED', 'PAIRING_CODE_INVALID', 'PAIRING_CODE_EXPIRED', 'PAIRING_CODE_USED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'SERVICE_NOT_RUNNING', 'SERVICE_MISMATCH', 'PROTOCOL_INCOMPATIBLE', 'NOT_FOUND', 'NOT_IMPLEMENTED', 'CONFLICT', 'IDEMPOTENCY_CONFLICT', 'PROJECT_INACTIVE', 'PROJECT_UNAVAILABLE', 'ACTIVE_RUN', 'REVISION_CONFLICT', 'NODE_LOCKED', 'INVALID_EDGE', 'INPUT_BLOCKED', 'INPUT_BUDGET_EXCEEDED', 'PLUGIN_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'ALREADY_HANDLED', 'CURSOR_EXPIRED', 'MAINTENANCE', 'SCHEMA_UNSUPPORTED', 'MIGRATION_FAILED', 'INTERNAL_ERROR'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export interface ErrorResponse { error: { code: ErrorCode; message: string; requestId: string; retryable: boolean; details?: Json } }
export interface Capability { status: 'available' | 'unavailable' | 'unknown'; reason: string; verifiedAt: string | null }
export interface ImageRouteCapability { route: {type:'codex'} | {type:'api';providerId:string;modelId:string}; modes: Record<ImageInputMode,Capability> }
export type CoreCapabilityName = 'pairing' | 'projects' | 'graphs' | 'assets' | 'execution' | 'imageGeneration' | 'events' | 'backups';
export type ProjectFileCapabilityName = 'projectFiles' | 'projectFileReferences';
export interface ServiceInfo { serviceId: string; version: string; protocolVersion: string; installation?: 'npm-global' | 'npx' | 'other'; capabilities: Record<CoreCapabilityName, Capability> & Partial<Record<ProjectFileCapabilityName, Capability>>; imageRoutes?: ImageRouteCapability[] }
export interface Health { status: 'ok'; version: string; protocolVersion: string }
export function isProtocolCompatible(version: string): boolean { return /^1\.\d+$/.test(version); }
export interface Session { id: string; browserName: string; pairedAt: string; lastUsedAt: string; expiresAt: string; current: boolean; origin: string; state: 'active' | 'expired' }
export interface PairRequest { code: string; browserName: string; expectedServiceId: string; clientCode?: string; proof?: string }
export interface PairResponse { serviceId: string; session: Session; token: string }
export interface ClientPairingRequest { code: string; expiresAt: string; serviceId: string }
export type ClientPairingStatus =
  | { status: 'pending'; expiresAt: string; serviceId: string }
  | ({ status: 'ready'; expiresAt: string } & PairResponse)
  | ({ status: 'paired' } & PairResponse);
export interface Project extends Scope { name: string; canonicalPath: string; state: 'active' | 'inactive'; availability: 'available' | 'unavailable' | 'unknown'; isGit: boolean }
export interface ProjectCandidate { path: string; availability: 'available' | 'unavailable' }
export interface ProjectCandidates { source: 'codex-desktop-saved-roots'; status: 'available' | 'unavailable'; reason: string; candidates: ProjectCandidate[] }
export interface ModelSelection { model: string; reasoningEffort: string | null }
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export interface ExecutionSettings { revision: number; sandboxMode: SandboxMode }
export interface ModelOption { id: string; reasoningEfforts: string[]; defaultReasoningEffort?: string | null }
export interface ModelDefaults { revision: number; selection: ModelSelection | null; available: ModelOption[] }
export interface Node { id: string; type: string; schemaVersion: number; contentVersion: number; content: Json; x: number; y: number; width?: number; height?: number; memberIds?: string[]; readOnly: boolean }
export interface ProjectFileSource { kind: 'project-file'; serviceId: string; projectId: string; relativePath: string }
export interface EmptyProjectFileSource { kind: 'project-file-empty'; relativePath: string }
export interface ProjectFileObservation { state: 'available' | 'missing' | 'unavailable'; name: string; mime: string | null; bytes: number | null; changeToken: string | null }
export interface Edge { id: string; sourceId: string; targetId: string; kind: 'reference' | 'execution' | 'delivery' }
export interface GraphDocumentHistory { cursor: string | null; canUndo: boolean; canRedo: boolean; expiresAt: number | null; undoRunIds?: string[] }
export interface GraphHistoryTravel extends GraphScope { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; expectedCursor: string; direction: 'undo' | 'redo' }
export interface GraphSnapshot extends GraphScope { updatedAt?: string; history?: GraphDocumentHistory; title: string; archived: boolean; trashed: boolean; executionRevision: number; layoutRevision: number; eventCursor: string; nodes: Node[]; edges: Edge[]; hiddenExecutionOutputs?: { executionNodeId: string; node: Node }[] }
/** Portable data shared by browser canvases and service import/export. */
export interface BundleResource { resourceId: string; version: number; name: string; mime: string; bytes: number; sha256: string; base64: string }
export interface BundlePluginRequirement { typeId: string; schemaVersion: number; contract: Json | null }
export type CopiedProvenance = {kind:'copied-delivery';sourceId:string;targetId:string;verified:false} | {kind:'copied-node';nodeId:string;metadata:Json;verified:false};
export interface ImportedGraphSnapshot extends GraphSnapshot { copiedProvenance: CopiedProvenance[] }
export interface GraphBundle { format: 'openworkgraph.graph'; version: 1; graph: { title: string; nodes: Node[]; edges: Edge[] }; resources: BundleResource[]; pluginRequirements: BundlePluginRequirement[]; copiedProvenance?: CopiedProvenance[] }
export type GraphOperation =
  | { type: 'execution.output.restore'; executionNodeId: string; nodeId: string; x: number; y: number }
  | { type: 'node.create'; node: Node } | { type: 'node.content'; nodeId: string; expectedContentVersion: number; content: Json }
  | { type: 'node.project-file.associate'; nodeId: string; expectedContentVersion: number; nodeType: 'text' | 'image' | 'file'; content: Json }
  | { type: 'node.delete'; nodeId: string; retainResourcesForUndo?: boolean } | { type: 'edge.create'; edge: Edge } | { type: 'edge.delete'; edgeId: string }
  | { type: 'layout.move'; positions: { nodeId: string; x: number; y: number }[] }
  | { type: 'layout.resize'; sizes: { nodeId: string; width: number | null; height: number | null; x?: number; y?: number }[] }
  | { type: 'group.members'; groupId: string; memberIds: string[] }
  | { type: 'group.rename'; groupId: string; title: string }
  | { type: 'graph.rename'; title: string } | { type: 'graph.archive'; archived: boolean }
  | { type: 'graph.trash'; trashed: boolean };
export interface DeleteGraph extends GraphScope { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; confirmTitle: string }
export interface GraphLifecycleRequest extends GraphScope { idempotencyKey: string; expectedExecutionRevision: number }
export interface PurgeGraph extends GraphLifecycleRequest { confirmationTitle: string }
export interface GraphCommand extends GraphScope { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; operations: GraphOperation[] }
export interface AssetVersion { assetId: string; version: number; mime: string; bytes: number; sha256: string; state: 'processing' | 'ready' | 'failed'; representationVersion: number | null }
export interface CanvasResourceVersion { resourceId: string; version: number; mime: string; bytes: number; sha256: string; representationVersion: number | null }
export interface CanvasResource extends GraphScope { id: string; name: string; current: CanvasResourceVersion }
export interface LibraryAsset extends Scope { id: string; name: string; shared: boolean; deleted: boolean; current: AssetVersion }
export interface CanvasResourceCreated { resource: CanvasResource; referenceId: string }
export interface ResourceEnvelope { kind: 'text' | 'image' | 'document' | 'video' | 'file'; sourceNodeIds: string[]; text: string | null; resource: CanvasResourceVersion | null }
export interface ProjectFileInput { kind: ResourceEnvelope['kind']; relativePath: string; sourceNodeIds: string[]; edgeIds: string[] }
/** Resource copies have no source asset binding. Upload IDs come from a future validated upload pipeline. */
export interface CanvasUploadRequest extends GraphScope { uploadId: string; name: string; idempotencyKey: string }
export type LibraryUploadRequest = Scope & { uploadId: string; name: string; idempotencyKey: string } & ({ mode: 'new' } | { mode: 'update'; assetId: string; expectedVersion: number });
export interface ResourceControl {
  uploadToCanvas(request: CanvasUploadRequest): Promise<CanvasResourceCreated>;
  copyAssetToCanvas(request: GraphScope & { assetId: string; expectedAssetVersion: number; idempotencyKey: string }): Promise<CanvasResourceCreated>;
  saveCanvasToLibrary(request: GraphScope & { resourceId: string; expectedResourceVersion: number; name: string; idempotencyKey: string }): Promise<LibraryAsset>;
  uploadToLibrary(request: LibraryUploadRequest): Promise<LibraryAsset>;
  listSameNameAssets(scope: Scope, name: string): Promise<LibraryAsset[]>;
  readCanvasVersion(scope: GraphScope, resourceId: string, version: number): Promise<CanvasResourceVersion>;
}
export interface ImageGenerationOptions { quality?: 'auto' | 'high' | 'medium' | 'low'; size?: string; aspectRatio?: string; outputFormat?: 'png' | 'jpeg' | 'webp' }
export type ImageRoute = { type: 'codex'; options?: ImageGenerationOptions } | { type: 'api'; providerId: string; modelId: string; options?: ImageGenerationOptions };
export type ImageInputMode = 'text' | 'image' | 'text_image';
export type FrozenApiImageRoute = Extract<ImageRoute, { type: 'api' }> & { configRevision: number; credentialRevision: number };
export interface ImageProviderModel { id: string; name: string; modes: ('text' | 'image' | 'text_image')[]; formats: ('png' | 'jpeg' | 'webp')[]; sizes: string[]; qualities: string[]; isDefault: boolean; verifiedAt: string | null }
export interface ImageProvider { id: string; name: string; driver: 'openai'; endpoint: string; enabled: boolean; revision: number; credentialConfigured: boolean; credentialRevision: number | null; models: ImageProviderModel[] }
export interface InputSnapshotBase { inputDigest: string; executionRevision: number; prompt: string; resources: ResourceEnvelope[]; projectFiles?: ProjectFileInput[]; skills?: import('./skills.js').FrozenSkill[] }
export type InputSnapshot = InputSnapshotBase & (
  { model: ModelSelection; imageRoute?: Extract<ImageRoute, { type: 'codex' }>; inputMode?: ImageInputMode }
  | { imageRoute: FrozenApiImageRoute; inputMode: ImageInputMode; model?: never }
);
export type SubmitRun = GraphScope & { nodeId: string; idempotencyKey: string; expectedExecutionRevision: number; preserveHistoricalOutputs?: boolean } & (
  { kind: 'execution' | 'text_generation'; modelOverride?: ModelSelection; imageRoute?: never }
  | { kind: 'image_generation'; modelOverride?: ModelSelection; imageRoute?: Extract<ImageRoute, { type: 'codex' }> }
  | { kind: 'image_generation'; imageRoute: Extract<ImageRoute, { type: 'api' }>; modelOverride?: never }
);
export interface Run extends GraphScope { id: string; nodeId: string; status: RunStatus; submissionSequence: string; inputDigest: string; createdAt: string; historyState: 'retained' | 'cleared'; executionStart?: 'manual' | 'confirm' | 'dependencies'; chainBatch?: string; chainControl?: 'active' | 'stopping' | 'stopped' }
export interface RunNotification { run: Run; revision: number; createdAt: string }
export interface ExecutionPlan { targetId: string; executionRevision: number; nodes: { id: string; title: string; required: boolean; hasRun: boolean; missingPrompt?: boolean; hasExpandedOutputs?: boolean }[]; edges: Edge[]; initialNodeIds: string[]; requiresConfirmation: boolean; preserveHistoricalOutputs?: boolean }
export interface Interaction { id: string; runId: string; epoch: string; version: number; kind: 'question' | 'approval'; status: 'pending' | 'answered' | 'expired'; payload: Json }
export interface InteractionReply { runId: string; interactionId: string; epoch: string; expectedVersion: number; idempotencyKey: string; answer: Json }
export interface ServiceEvent { serviceId: string; cursor: string; eventId: string; type: 'project.changed' | 'project.files.changed' | 'graph.changed' | 'asset.changed' | 'canvas_resource.created' | 'canvas_resource.changed' | 'canvas_resource.collected' | 'run.changed' | 'interaction.changed' | 'notification.changed' | 'session.revoked' | 'backup.changed' | 'capacity.changed'; projectId: string | null; graphId: string | null; entityId: string; revision: number; occurredAt: string; payload: Json }
export interface Backup { id: string; state: 'creating' | 'ready' | 'failed'; createdAt: string; bytes: number | null; sha256: string | null }
export interface HistoryCleanupPreview { runIds: string[]; processRecordCount: number; preserves: readonly ['runs', 'deliveries', 'assets', 'graphLinks'] }
export interface RestorePreview { backupId: string; integrity: 'verified'; requiresMaintenance: true; invalidatesAllSessions: true; pausesQueuedRuns: true }
/** Contracts only; availability is negotiated through ServiceInfo, not inferred from types. */
export interface ServiceControl {
  pair(request: PairRequest): Promise<PairResponse>;
  getSession(): Promise<Session>;
  listSessions(): Promise<Session[]>; revokeSession(id: string): Promise<void>;
  listProjects(state: 'active' | 'inactive' | 'all'): Promise<Project[]>;
  listProjectCandidates(): Promise<ProjectCandidates>;
  registerProject(path: string): Promise<Project>; setProjectState(id: string, state: 'active' | 'inactive'): Promise<Project>;
  repairProjectPath(id: string, path: string): Promise<Project>;
  getModelDefaults(): Promise<ModelDefaults>; setModelDefaults(selection: ModelSelection, expectedRevision: number): Promise<ModelDefaults>;
  getGraph(scope: GraphScope): Promise<GraphSnapshot>; commandGraph(command: GraphCommand): Promise<GraphSnapshot>;
  deleteGraph(request: DeleteGraph): Promise<{graphId: string; deleted: true}>;
  archiveGraph(request: GraphLifecycleRequest): Promise<GraphSnapshot>;
  trashGraph(request: GraphLifecycleRequest): Promise<GraphSnapshot>;
  restoreGraph(request: GraphLifecycleRequest): Promise<GraphSnapshot>;
  purgeGraph(request: PurgeGraph): Promise<{graphId: string; deleted: true}>;
  submitRun(request: SubmitRun): Promise<Run>; cancelRun(id: string, idempotencyKey: string): Promise<Run>; reply(request: InteractionReply): Promise<Interaction>;
  previewHistoryCleanup(runIds: string[]): Promise<HistoryCleanupPreview>; clearHistory(runIds: string[], idempotencyKey: string): Promise<HistoryCleanupPreview>;
  createBackup(idempotencyKey: string): Promise<Backup>; listBackups(): Promise<Backup[]>;
  getRestoreGuidance(): Promise<{ localOnly: true; command: string }>;
  continueRestoredRun(id: string, idempotencyKey: string): Promise<Run>;
}
/** Deliberately excluded from browser ServiceControl. */
export interface LocalRestoreControl { previewRestore(path: string): Promise<RestorePreview>; restore(path: string, expectedSha256: string): Promise<void> }

export { previewEdgeError } from "./preview.js";
export * from './skills.js';
