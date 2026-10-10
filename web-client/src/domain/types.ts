/** Phase 1 development contract. Plain serializable DTOs; no React dependency. */
export type NodeKind =
  | "preview"
  | "file"
  | "text"
  | "image"
  | "document"
  | "video"
  | "execution"
  | "visualize"
  | (string & {});
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "finalizing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface Scope {
  serviceId: string;
  projectId: string;
  graphId: string;
}
export interface AssetRef {
  serviceId: string;
  assetId: string;
  versionId: string;
}
export interface WorkNode extends Scope {
  id: string;
  nodeId: string;
  type: NodeKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  prompt: string;
  summary: string;
  readonly: boolean;
  contentRevision: number;
  assetRef?: AssetRef;
  originRunId?: string;
  copiedFromNodeId?: string;
  memberIds?: string[];
}
export type ContentNode = WorkNode;
export type ExecutionNode = WorkNode;
export interface WorkEdge extends Scope {
  id: string;
  source: string;
  target: string;
  originRunId?: string;
  /** Immutable execution-to-delivery relationship; removed only with the delivery node. */
  kind?: "execution" | "delivery";
}
export interface WorkGraph extends Scope {
  id: string;
  name: string;
  nodes: WorkNode[];
  edges: WorkEdge[];
  revision: number;
}
export interface Service {
  id: string;
  serviceId: string;
  name: string;
  capacity: number;
  connected: boolean;
  development: true;
}
export interface Project {
  id: string;
  projectId: string;
  serviceId: string;
  name: string;
}
export interface AssetVersion extends AssetRef {
  projectId: string;
  name: string;
  mimeType: string;
  size: number;
  text?: string;
  createdAt: number;
}
export interface InputSnapshot {
  prompt: string;
  inputs: Array<{
    nodeId: string;
    type: NodeKind;
    title: string;
    content: string;
    contentRevision: number;
    assetRef?: AssetRef;
  }>;
}
export interface RunInteraction {
  id: string;
  message: string;
  response?: string;
}
export interface Run extends Scope {
  id: string;
  runId: string;
  nodeId: string;
  kind: "execution" | "generation";
  status: RunStatus;
  sequence: number;
  lastEventSequence: number;
  inputSnapshot: InputSnapshot;
  createdAt: number;
  summaries: string[];
  outputNodeIds: string[];
  cancelRequested: boolean;
  occupiesSlot: boolean;
  error?: string;
  question?: RunInteraction;
  approval?: RunInteraction;
  generationRevision?: number;
  candidate?: GenerationResult;
}
export interface QueueSnapshot {
  serviceId: string;
  capacity: number;
  occupied: number;
  connected: boolean;
  stale: boolean;
  runs: Run[];
}
export interface AdapterSnapshot {
  mode: "development";
  namespace: "openworkgraph:development:v1";
  revision: number;
  services: Service[];
  projects: Project[];
  graphs: WorkGraph[];
  assets: AssetVersion[];
  runs: Run[];
  activeGraphId: string;
  activeServiceId: string;
}
export interface OutputManifest {
  markdown: { title: string; body: string; summary?: string };
  images?: Array<{ title: string; dataUrl: string; mimeType?: string }>;
}
export interface GenerationResult {
  content: string;
  assetRef?: AssetRef;
}
export type RunEventPayload =
  | { type: "summary"; message: string }
  | { type: "status"; status: "preparing" | "running" | "finalizing" }
  | { type: "question" | "approval"; interactionId: string; message: string }
  | { type: "succeeded"; output: OutputManifest }
  | { type: "failed" | "interrupted"; reason: string }
  | { type: "cancelled" }
  | { type: "generated"; result: GenerationResult };
export type RunEvent = RunEventPayload &
  Scope & { runId: string; nodeId: string; sequence: number; eventId: string };
export type NodePatch = Partial<
  Pick<
    WorkNode,
    | "title"
    | "x"
    | "y"
    | "width"
    | "height"
    | "content"
    | "prompt"
    | "summary"
    | "assetRef"
  >
>;
export interface CreateNodeInput extends NodePatch {
  type: NodeKind;
}
export interface AssetImport {
  name: string;
  mimeType: string;
  data: Blob | string;
}
export interface AssetPreview {
  url: string;
  release(): void;
}
export interface WorkgraphAdapter {
  getSnapshot(): AdapterSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: RunEvent) => void): () => void;
  selectGraph(graphId: string, serviceId?: string): void;
  createGraph(serviceId: string, projectId: string, name: string): WorkGraph;
  createNode(graphId: string, input: CreateNodeInput): WorkNode;
  updateNode(graphId: string, nodeId: string, patch: NodePatch): void;
  /** One validated layout edit and notification. Selected groups own member translation. */
  moveNodes(
    graphId: string,
    moves: Array<{ id: string; x: number; y: number }>,
  ): void;
  deleteNodes(graphId: string, nodeIds: string[]): void;
  connect(graphId: string, source: string, target: string): WorkEdge;
  disconnect(graphId: string, edgeId: string): void;
  copyNode(graphId: string, nodeId: string): WorkNode;
  getReferences(graphId: string, nodeId: string): InputSnapshot["inputs"];
  pasteNodes(
    graphId: string,
    nodes: WorkNode[],
    edges: WorkEdge[],
    position: { x: number; y: number },
  ): WorkNode[];
  undoGraph(graphId: string): boolean;
  redoGraph(graphId: string): boolean;
  canUndoGraph(graphId: string): boolean;
  canRedoGraph(graphId: string): boolean;
  groupNodes(graphId: string, nodeIds: string[]): WorkNode;
  ungroupNodes(graphId: string, groupIds: string[]): void;
  setGroupMembers(graphId: string, groupId: string, memberIds: string[]): void;
  isNodeLocked(graphId: string, nodeId: string): boolean;
  hasInputChanges(runId: string): boolean;
  submitRun(graphId: string, nodeId: string, idempotencyKey?: string): Run;
  cancelRun(runId: string): void;
  answerInput(runId: string, interactionId: string, answer: string): void;
  decideApproval(runId: string, interactionId: string, approved: boolean): void;
  getQueue(serviceId: string): QueueSnapshot;
  locateRun(runId: string): (Scope & { nodeId: string }) | undefined;
  importAsset(
    serviceId: string,
    projectId: string,
    input: AssetImport,
  ): Promise<AssetVersion>;
  readAsset(ref: AssetRef): AssetVersion;
  saveAsset(ref: AssetRef, content: string): AssetVersion;
  acquireAssetPreview(ref: AssetRef): AssetPreview;
  placeAsset(
    graphId: string,
    ref: AssetRef,
    position?: { x: number; y: number },
  ): WorkNode;
  generate(graphId: string, nodeId: string, prompt: string): Run;
  applyGenerationCandidate(runId: string): void;
  dispose(): void;
}
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
