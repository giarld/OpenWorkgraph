import type { GraphScope, Json, Edge } from './index.js';
export const BASIC_NODE_TYPES = ['text', 'image', 'execution', 'visualize', 'file', 'document'] as const;
export type BasicNodeType = typeof BASIC_NODE_TYPES[number];
export interface BasicNodeCreate { type: 'node.create-basic'; nodeId: string; nodeType: BasicNodeType; title?: string; text?: string; prompt?: string; x?: number; y?: number }
export interface NodePatch { type: 'node.patch'; nodeId: string; expectedContentVersion: number; changes: { title?: string; text?: string; prompt?: string } }
export interface GraphCommandReceipt extends GraphScope { executionRevision: number; layoutRevision: number; nodes: { id: string; contentVersion: number }[]; createdNodeIds: string[]; createdEdgeIds: string[]; deletedNodeIds: string[]; deletedEdgeIds: string[] }
export interface GraphReadBudget { nodes: number; edges: number; regions: number; titleChars: number; textChars: number; bytes: number }
export const GRAPH_READ_DEFAULTS: GraphReadBudget = { nodes: 50, edges: 100, regions: 20, titleChars: 120, textChars: 4000, bytes: 65536 };
export const GRAPH_READ_MAX: GraphReadBudget = { nodes: 500, edges: 1000, regions: 100, titleChars: 512, textChars: 64000, bytes: 524288 };
export interface GraphNodeHeading { id: string; type: string; title: string; contentVersion: number; readOnly: boolean; snippet?: string }
export interface GraphRegion { selector: string; source: 'group' | 'structure'; title: string; memberCount: number; groupId?: string }
export interface GraphReadMeta extends GraphScope { title: string; executionRevision: number; layoutRevision: number; readVersion: string; budget: GraphReadBudget; nextCursor: string | null; coverage: { shown: number; total: number; omitted: number; filtered: boolean; boundaryEdges?: number; edgeOffset?: number; shownEdges?:number; totalEdges?:number; omittedEdges?:number } }
export interface GraphListRequest { limit?:number; cursor?:string }
export interface GraphListPage { serviceId:string; projectId:string; items:{graphId:string;title:string;executionRevision:number;layoutRevision:number;archived:boolean;trashed:boolean}[]; readVersion:string; nextCursor:string|null }
export interface GraphSummary extends GraphReadMeta { mode: 'nodes' | 'regions'; totals: { nodes: number; hiddenOutputs: number; types: Record<string, number>; edges: Record<Edge['kind'], number>; overlappingMembers: number }; nodes: GraphNodeHeading[]; edges: Edge[]; regions: GraphRegion[]; relations: { source: string; target: string; kind: Edge['kind']; count: number }[] }
export interface GraphSubgraph extends GraphReadMeta { nodes: GraphNodeHeading[]; edges: Edge[] }
export interface GraphNodePage extends GraphReadMeta { items: GraphNodeHeading[] }
export interface GraphNodeContent extends GraphReadMeta { node: GraphNodeHeading; content: Json | null; text: string; offset: number; encoding: 'json'; complete: boolean }
export const BUSINESS_CLI_EXIT = { success: 0, arguments: 2, connection: 3, conflict: 4, runFailed: 5, interaction: 6, timeout: 7, unknown: 8 } as const;
export interface GraphReadRequest { budget?: Partial<GraphReadBudget>; cursor?: string }
export interface NodeQueryRequest extends GraphReadRequest { query?: string; types?: string[]; searchFields?: ('title'|'text'|'prompt')[] }
export interface SubgraphRequest extends GraphReadRequest { nodeId?: string; region?: string; direction?: 'upstream'|'downstream'|'both'; depth?: number; edgeKinds?: Edge['kind'][] }
export interface NodeContentRequest extends GraphReadRequest { nodeId: string }
export interface CliBusinessRequest { method:'GET'|'POST'; path:string; body?:Record<string,Json>; bodyHash?:string }
export interface CliAuthorizationRequest { requestKey:string; requests:CliBusinessRequest[]; validForMs?:number }
export interface CliAuthorizationState { id:string; runId:string; attemptId:string; state:'pending'|'approved'|'declined'|'expired'|'consumed'; requestHash:string; expiresAt:number; consumed:number[] }
export interface CliApprovalDecision { kind:'approval'; decision:'accept'|'decline'; autoAuthorize?:boolean }
export interface RunOutputItem { outputKey:string; kind:'canvas'|'project-file'; resourceId?:string; version?:number; relativePath?:string; mime?:string; sha256:string; bytes:number }
export interface RunOutputPage extends GraphScope { runId:string; items:RunOutputItem[]; total:number; readVersion:string; nextCursor:string|null; projectFileNotice:string }
