import type { CanvasResourceVersion, GraphScope, Json, ModelSelection, ProjectFileInput, ResourceEnvelope } from './index.js';
import type { SkillReference } from './skills.js';

/** These versions evolve independently of the product, graph bundle and database. */
export const VISUALIZE_NODE_SCHEMA_VERSION = 1 as const;
export const VISUALIZE_PAGE_VERSION = 1 as const;
export const VISUALIZE_BRIDGE_VERSION = 1 as const;
export const VISUALIZE_SCHEMA_DIALECT = 'openworkgraph.visualize-form/1' as const;
export const VISUALIZE_DEFAULT_SIZE = Object.freeze({ width: 480, height: 360 });
export const VISUALIZE_GENERATION_MAX_SIZE = Object.freeze({ width: 1440, height: 1080 });
export const VISUALIZE_FEATURE_ID = 'openworkgraph:feature:visualize' as const;

/** A product feature has no package path, installation status or configuration. */
export interface VisualizeFeatureSelection {
  kind: 'builtin-feature';
  featureId: typeof VISUALIZE_FEATURE_ID;
  version: 1;
}
export function isVisualizeFeatureSelection(value: unknown): value is VisualizeFeatureSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['kind', 'featureId', 'version'].includes(key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return descriptors.kind?.value === 'builtin-feature' && descriptors.featureId?.value === VISUALIZE_FEATURE_ID &&
    descriptors.version?.value === 1 && Object.values(descriptors).every(field => 'value' in field && field.enumerable);
}
export interface VisualizeSize { width: number; height: number }
/** No refs, regexes, unions, coercion, defaults or executable validation. */
export interface VisualizeFormSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  title?: string;
  description?: string;
  properties?: Record<string, VisualizeFormSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: VisualizeFormSchema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}
export interface VisualizeSchemaDeclaration {
  dialect: typeof VISUALIZE_SCHEMA_DIALECT;
  version: number;
  schema: VisualizeFormSchema & { type: 'object' };
}
export interface VisualizeResourceReference { resourceId: string; resourceVersion: number }
export type VisualizeAssetReference = { format: 'openworkgraph.asset-reference'; version: 1 } & (
  | { kind: 'resource'; resourceId: string; resourceVersion: number }
  | { kind: 'project-file'; relativePath: string; mode: 'live' }
);
export type VisualizeDependency =
  | { kind: 'cdn'; id: string; media: 'script' | 'style' | 'image' | 'video'; url: string; version: string; integrity?: string }
  | { kind: 'resource'; id: string; media: 'script' | 'style' | 'image' | 'video'; resourceId: string; resourceVersion: number }
  | { kind: 'project-file'; id: string; media: 'image' | 'video'; relativePath: string; mode: 'live' };
/** HTML includes inline CSS/JS; carried files are immutable graph resource versions. */
export interface VisualizePagePackage {
  format: 'openworkgraph.visualize-page';
  version: typeof VISUALIZE_PAGE_VERSION;
  bridgeVersion: typeof VISUALIZE_BRIDGE_VERSION;
  html: string;
  dependencies: VisualizeDependency[];
  form: VisualizeSchemaDeclaration;
  initialForm: { [key: string]: Json };
  initialState: Json;
  layout?: VisualizeSize;
}
export interface VisualizeFormSnapshot {
  pageRevision: number;
  schemaVersion: number;
  version: number;
  data: { [key: string]: Json };
  resource: VisualizeResourceReference;
}
export interface VisualizeStateSnapshot { pageRevision: number; version: number; data: Json }
/** Empty nodes omit page/form/state together. Page and form resources stay separate. */
export interface VisualizeNodeContent {
  title?: string;
  prompt: string;
  modelOverride?: ModelSelection;
  skillReferences?: SkillReference[];
  features?: VisualizeFeatureSelection[];
  inputBindings: VisualizeInputBinding[];
  page?: { revision: number; resource: VisualizeResourceReference; dependencies: VisualizeResourceReference[] };
  form?: VisualizeFormSnapshot;
  state?: VisualizeStateSnapshot;
}
export type VisualizeWriteRequest = GraphScope & {
  nodeId: string;
  idempotencyKey: string;
  expectedContentVersion: number;
  expectedExecutionRevision: number;
  expectedLayoutRevision: number;
  /** Zero for a node without a page. */
  expectedPageRevision: number;
} & (
  | { action: 'install-page'; page: VisualizePagePackage }
  | { action: 'update-form'; expectedFormVersion: number; form: { [key: string]: Json } }
  | { action: 'save-state'; expectedStateVersion: number; state: Json }
);
export interface VisualizeStoredNode extends GraphScope {
  nodeId: string;
  contentVersion: number;
  executionRevision: number;
  layoutRevision: number;
  content: VisualizeNodeContent;
  page: VisualizePagePackage | null;
}
/** Names are stable per page, not new graph ports. Only reference edges can bind. */
export interface VisualizeInputBinding { name: string; edgeId: string }
export interface VisualizeInput {
  name: string;
  edgeId: string;
  sourceNodeId: string;
  contentVersion: number;
  resources: ResourceEnvelope[];
  /** Scoped project-relative identities; resolved by the host, never arbitrary page paths. */
  projectFiles?: ProjectFileInput[];
  projectFileData?: VisualizeProjectFileSnapshot[];
  preview?: { nodeId: string; contentVersion: number; edgeId: string };
  /** JSON business output only when the predecessor is visualize. */
  form?: VisualizeFormSnapshot;
}
export interface VisualizeInputSnapshot { version: number; digest: string; inputs: VisualizeInput[] }
export interface VisualizeProjectFileSnapshot {
  relativePath: string;
  kind: ProjectFileInput['kind'];
  mime: string;
  bytes: number;
  sha256: string;
  /** Small UTF-8 text only; binary content travels outside JSON via asset references. */
  text: string | null;
  asset: VisualizeAssetReference;
  changeToken: string;
}
/** Read once at markBackendLaunching, after project lock/dependency preparation. */
export interface VisualizeRunInputBinding {
  sourceNodeId: string;
  edgeIds: string[];
  /** Indexes in the submitted resource list; ordinary inputs remain frozen. */
  resourceIndexes: number[];
  projectFileIndexes?: number[];
}
export interface FrozenVisualizeInput {
  sourceNodeId: string;
  edgeIds: string[];
  contentVersion: number;
  page: { revision: number; resource: VisualizeResourceReference };
  schema: VisualizeSchemaDeclaration;
  form: VisualizeFormSnapshot;
}
export interface VisualizeGenerationContext {
  version: 1;
  feature: VisualizeFeatureSelection;
  inputs: VisualizeInputSnapshot;
  layout: { default: VisualizeSize; current: VisualizeSize; maximum: VisualizeSize; contentViewport: VisualizeSize };
  previous?: { page: VisualizePagePackage; formFormatReference: VisualizeFormSnapshot };
  replacementPolicy: 'new-initial-form';
}
/** Prompt identity is separate from display text; paths are project-relative identities. */
export interface VisualizePrompt {
  text: string;
  skillReferences: SkillReference[];
  features: VisualizeFeatureSelection[];
  files: { relativePath: string }[];
}
export type VisualizeSuccessor =
  | { type: 'text'; title?: string; text: string }
  | { type: 'image'; title?: string; prompt: VisualizePrompt }
  | { type: 'execution'; title?: string; prompt: VisualizePrompt };
export interface VisualizeExpectedRevisions {
  pageRevision: number;
  formVersion: number;
  stateVersion: number;
  inputVersion: number;
  executionRevision: number;
  layoutRevision: number;
}
export interface VisualizeHostCapabilities { readOnly: boolean; online: boolean; canCreateSuccessors: boolean; canExportAssets?: boolean }
export interface VisualizeHostContext {
  pageRevision: number;
  form: VisualizeFormSnapshot;
  state: VisualizeStateSnapshot;
  inputs: VisualizeInputSnapshot;
  inputsChanged: boolean;
  revisions: VisualizeExpectedRevisions;
  theme: { mode: 'light' | 'dark'; tokens: Record<string, string> };
  locale: string;
  viewport: VisualizeSize;
  capabilities: VisualizeHostCapabilities;
}
/** Full form/state replacements. Refresh is explicit and preserves current form/state. */
export interface VisualizeBridgeMethods {
  exportAsset: {
    params: { name: string; mime: string; bytes: number };
    result: { assetId: string; assetVersion: number; resourceId: string; resourceVersion: number; nodeId: string; edgeId: string; mime: string; bytes: number; revisions: VisualizeExpectedRevisions };
  };
  initialize: { params: Record<string, never>; result: VisualizeHostContext };
  readInputs: { params: { refresh: boolean }; result: { inputs: VisualizeInputSnapshot; inputsChanged: boolean; inputError?: VisualizeProtocolError } };
  saveState: { params: { state: Json }; result: { state: VisualizeStateSnapshot; revisions: VisualizeExpectedRevisions } };
  updateForm: { params: { form: { [key: string]: Json } }; result: { form: VisualizeFormSnapshot; revisions: VisualizeExpectedRevisions } };
  createSuccessors: {
    params: { successors: VisualizeSuccessor[]; form?: { [key: string]: Json } };
    result: { nodeIds: string[]; edgeIds: string[]; form: VisualizeFormSnapshot; revisions: VisualizeExpectedRevisions };
  };
  requestLayout: { params: VisualizeSize; result: { size: VisualizeSize; layoutRevision: number } };
}
export type VisualizeBridgeMethod = keyof VisualizeBridgeMethods;
export interface VisualizeBridgeIdentity {
  channel: 'openworkgraph.visualize';
  version: typeof VISUALIZE_BRIDGE_VERSION;
  sessionId: string;
  nodeId: string;
  requestId: string;
}
/** Host-only presentation change; never changes data or expected revisions. */
export interface VisualizeCapabilityUpdate {
  channel: 'openworkgraph.visualize'; version: typeof VISUALIZE_BRIDGE_VERSION;
  sessionId: string; nodeId: string; type: 'capabilities'; capabilities: VisualizeHostCapabilities;
}
export type VisualizeBridgeRequest = {
  [Method in VisualizeBridgeMethod]: VisualizeBridgeIdentity & {
    type: 'request'; method: Method; expected: VisualizeExpectedRevisions; params: VisualizeBridgeMethods[Method]['params'];
  }
}[VisualizeBridgeMethod];
export const VISUALIZE_ERROR_CODES = [
  'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'SCHEMA_UNSUPPORTED', 'FORM_INVALID',
  'FORM_REQUIRED', 'SESSION_EXPIRED', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'READ_ONLY', 'OFFLINE', 'INPUT_BLOCKED', 'RESOURCE_UNAVAILABLE', 'INTERNAL_ERROR',
] as const;
export type VisualizeErrorCode = typeof VISUALIZE_ERROR_CODES[number];
export interface VisualizeFieldError {
  /** RFC 6901 JSON pointer; empty string identifies the root. */
  path: string;
  keyword: string;
  message: string;
}
export interface VisualizeProtocolError {
  code: VisualizeErrorCode; message: string; retryable: boolean; fields?: VisualizeFieldError[];
}
export type VisualizeBridgeResponse = {
  [Method in VisualizeBridgeMethod]: VisualizeBridgeIdentity & { type: 'response'; method: Method } & (
    { ok: true; result: VisualizeBridgeMethods[Method]['result'] } | { ok: false; error: VisualizeProtocolError }
  )
}[VisualizeBridgeMethod];
/** No graph scope, credentials, filesystem handles, execution or installation API. */
export interface VisualizePageSdk {
  /** Binary bytes travel separately from the JSON bridge. No target or node operation is accepted. */
  exportAsset(asset: { name: string; mime?: string; blob: Blob }): Promise<VisualizeBridgeMethods['exportAsset']['result']>;
  initialize(): Promise<VisualizeHostContext>;
  readInputs(refresh?: boolean): Promise<VisualizeBridgeMethods['readInputs']['result']>;
  saveState(state: Json): Promise<VisualizeBridgeMethods['saveState']['result']>;
  updateForm(form: { [key: string]: Json }): Promise<VisualizeBridgeMethods['updateForm']['result']>;
  createSuccessors(successors: VisualizeSuccessor[], form?: { [key: string]: Json }): Promise<VisualizeBridgeMethods['createSuccessors']['result']>;
  requestLayout(size: VisualizeSize): Promise<VisualizeBridgeMethods['requestLayout']['result']>;
}
/** JSON resources are added to the general envelope only when input handling is ready. */
export interface VisualizeBusinessEnvelope {
  kind: 'json'; sourceNodeIds: string[]; data: { [key: string]: Json };
  resource: CanvasResourceVersion; pageRevision: number; schemaVersion: number; formVersion: number;
}
