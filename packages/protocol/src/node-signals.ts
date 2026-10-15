import type { Json } from './index.js';
import { checkedVisualizeJson, VisualizeValidationError } from './visualize-validation.js';

export const NODE_SIGNALS = ['content.changed', 'outputs.changed', 'removed',
  'connection.input.connected', 'connection.input.disconnected',
  'connection.output.connected', 'connection.output.disconnected',
  'inputs.invalidated', 'inputs.updated', 'form.changed',
  'run.started', 'run.succeeded', 'run.failed', 'run.cancelled',
  'invocation.completed', 'invocation.failed'] as const;
export type NodeSignalName = typeof NODE_SIGNALS[number] | `custom.${string}`;
/** One source of truth for target checks, payload validation and host dispatch.
 * Add a content slot here with its payload kind when extending node types. */
export const NODE_CONTENT_SLOTS = {
  'text.update': { nodeType: 'text', schemaVersion: 1, payload: 'text', resourceMimePrefix: '' },
  'image.update': { nodeType: 'image', schemaVersion: 1, payload: 'resource', resourceMimePrefix: 'image/' },
  'document.update': { nodeType: 'document', schemaVersion: 1, payload: 'text', resourceMimePrefix: '' },
  'file.update': { nodeType: 'file', schemaVersion: 1, payload: 'resource', resourceMimePrefix: '' },
} as const satisfies Record<string, { nodeType: string; schemaVersion: number; payload: 'text' | 'resource'; resourceMimePrefix: string }>;
export type NodeContentSlotName = keyof typeof NODE_CONTENT_SLOTS;
export const isNodeContentSlot = (value: unknown): value is NodeContentSlotName => typeof value === 'string' && Object.hasOwn(NODE_CONTENT_SLOTS, value);
export const nodeContentSlotMatches = (slot: NodeContentSlotName, node: { type: string; schemaVersion: number }): boolean => node.type === NODE_CONTENT_SLOTS[slot].nodeType && node.schemaVersion === NODE_CONTENT_SLOTS[slot].schemaVersion;
export type NodeContentSlotParams = { expectedContentVersion?: number } & ({ text: string } | { resourceId: string; resourceVersion: number });
export function validateNodeContentSlotParams(slot: NodeContentSlotName, value: unknown): NodeContentSlotParams {
  const params = object(checkedVisualizeJson(value, 65_536));
  const required = NODE_CONTENT_SLOTS[slot].payload === 'text' ? ['text'] : ['resourceId', 'resourceVersion'];
  keys(params, required, ['expectedContentVersion']);
  if (params.expectedContentVersion !== undefined && (!Number.isSafeInteger(params.expectedContentVersion) || Number(params.expectedContentVersion) < 1)) fail();
  if (NODE_CONTENT_SLOTS[slot].payload === 'text') { if (typeof params.text !== 'string') fail(); }
  else if (!id(params.resourceId) || !Number.isSafeInteger(params.resourceVersion) || Number(params.resourceVersion) < 1) fail();
  return params as NodeContentSlotParams;
}
export type NodeSlotName = NodeContentSlotName | 'inputs.refresh' | 'prompt.update' | 'run.submit' | 'run.cancel' | `custom.${string}`;
/** Selectors resolve against current reference edges, never execution-chain edges. */
export interface NodeSignalSource { nodeId: string; signal: NodeSignalName }
export interface NodeSignalConnection { id: string; source: NodeSignalSource; target: { nodeId: string; slot: NodeSlotName }; params?: Json }
export interface NodeSignalCause { traceId: string; connections: string[] }
export type NodeSignalRelation = 'self' | 'predecessors' | 'successors';
export interface NodeSignalEvent { id: string; nodeId: string; signal: NodeSignalName; payload: Json; cause: NodeSignalCause; relation: NodeSignalRelation; relations?: NodeSignalRelation[] }
export type NodeSignalCommand =
  | { action: 'connect'; connection: NodeSignalConnection }
  | { action: 'disconnect'; id: string }
  | { action: 'emit'; signal: `custom.${string}`; payload: Json }
  | { action: 'registerSlot'; slot: `custom.${string}` }
  | { action: 'unregisterSlot'; slot: `custom.${string}` }
  | { action: 'result'; invocationId: string; ok: boolean; value: Json }
  | { action: 'claim'; invocationId: string }
  | { action: 'describe' };
export interface NodeSignalDescription { self: string; predecessors: { nodeId: string; type: string }[]; successors: { nodeId: string; type: string }[]; signals: string[]; slots: string[] }
export type NodeSignalMessage = { channel: 'openworkgraph.node-signals'; version: 1; sessionId: string; nodeId: string } & (
  | { type: 'event'; event: NodeSignalEvent }
  | { type: 'invoke'; invocationId: string; targetNodeId: string; slot: NodeSlotName; params: Json; cause: NodeSignalCause }
);
export interface NodeSignalSdk {
  connect(connection: NodeSignalConnection): Promise<Json>;
  disconnect(id: string): Promise<Json>;
  emit(signal: `custom.${string}`, payload?: Json): Promise<Json>;
  on(source: NodeSignalName | NodeSignalSource, handler: (event: NodeSignalEvent) => void | Promise<void>): () => void;
  defineSlot(slot: `custom.${string}`, handler: (params: Json) => Json | void | Promise<Json | void>): Promise<() => Promise<void>>;
  describe(): Promise<NodeSignalDescription>;
}
const fail = (): never => { throw new VisualizeValidationError('INVALID_REQUEST', 'Invalid node signal contract'); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
export const isCustomNodeSignal = (v: unknown): v is `custom.${string}` => typeof v === 'string' && /^custom\.[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(v);
export const isNodeSignal = (v: unknown): v is NodeSignalName => (NODE_SIGNALS as readonly unknown[]).includes(v) || isCustomNodeSignal(v);
export const isNodeSlot = (v: unknown): v is NodeSlotName => isNodeContentSlot(v) || ['inputs.refresh', 'prompt.update', 'run.submit', 'run.cancel'].includes(v as string) || isCustomNodeSignal(v);
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Record<string, unknown>; }
function keys(v: Record<string, unknown>, required: string[], optional: string[] = []) { if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail(); }
export function validateNodeSignalCause(value: unknown): NodeSignalCause {
  const v = object(checkedVisualizeJson(value, 8192)); keys(v, ['traceId', 'connections']);
  if (!id(v.traceId) || !Array.isArray(v.connections) || v.connections.length > 32 || v.connections.some(k => typeof k !== 'string' || k.length > 384)) fail();
  return v as unknown as NodeSignalCause;
}
export function validateNodeSignalCommand(value: unknown): NodeSignalCommand {
  const v = object(checkedVisualizeJson(value, 65_536));
  switch (v.action) {
    case 'connect': {
      keys(v, ['action', 'connection']); const c = object(v.connection); keys(c, ['id', 'source', 'target'], ['params']);
      const source = object(c.source), target = object(c.target); keys(source, ['nodeId', 'signal']); keys(target, ['nodeId', 'slot']);
      if (!id(c.id) || !id(source.nodeId) || !id(target.nodeId) || !isNodeSignal(source.signal) || !isNodeSlot(target.slot) || target.nodeId === 'predecessors') fail();
      break;
    }
    case 'disconnect': keys(v, ['action', 'id']); if (!id(v.id)) fail(); break;
    case 'emit': keys(v, ['action', 'signal', 'payload']); if (!isCustomNodeSignal(v.signal)) fail(); break;
    case 'registerSlot': case 'unregisterSlot': keys(v, ['action', 'slot']); if (!isCustomNodeSignal(v.slot)) fail(); break;
    case 'result': keys(v, ['action', 'invocationId', 'ok', 'value']); if (!id(v.invocationId) || typeof v.ok !== 'boolean') fail(); break;
    case 'claim': keys(v, ['action', 'invocationId']); if (!id(v.invocationId)) fail(); break;
    case 'describe': keys(v, ['action']); break;
    default: fail();
  }
  return v as unknown as NodeSignalCommand;
}
export function validateNodeSignalMessage(value: unknown): NodeSignalMessage {
  const v = object(checkedVisualizeJson(value, 50_331_648));
  if (v.channel !== 'openworkgraph.node-signals' || v.version !== 1 || !id(v.sessionId) || !id(v.nodeId)) fail();
  if (v.type === 'event') {
    keys(v, ['channel', 'version', 'sessionId', 'nodeId', 'type', 'event']);
    const e = object(v.event); keys(e, ['id', 'nodeId', 'signal', 'payload', 'cause', 'relation'], ['relations']);
    if (!id(e.id) || !id(e.nodeId) || !isNodeSignal(e.signal) || !['self', 'predecessors', 'successors'].includes(e.relation as string)) fail();
    if (e.relations !== undefined && (!Array.isArray(e.relations) || !e.relations.length || e.relations.length > 3
      || e.relations.some(relation => !['self', 'predecessors', 'successors'].includes(relation))
      || new Set(e.relations).size !== e.relations.length || !e.relations.includes(e.relation)
      || e.relations.includes('self') && e.relations.length !== 1)) fail();
    validateNodeSignalCause(e.cause);
  } else if (v.type === 'invoke') {
    keys(v, ['channel', 'version', 'sessionId', 'nodeId', 'type', 'invocationId', 'targetNodeId', 'slot', 'params', 'cause']);
    if (!id(v.invocationId) || !id(v.targetNodeId) || !isNodeSlot(v.slot)) fail(); validateNodeSignalCause(v.cause);
  } else fail();
  return v as unknown as NodeSignalMessage;
}
