import { BASIC_NODE_TYPES, VISUALIZE_DEFAULT_SIZE } from '@openworkgraph/protocol';
import type { BasicNodeCreate, Node, NodePatch, Json } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export function basicNode(op: BasicNodeCreate, ordinal: number): Node {
  if (Object.keys(op).some(k => !['type','nodeId','nodeType','title','text','prompt','x','y'].includes(k)) || !BASIC_NODE_TYPES.includes(op.nodeType)) throw new ServiceError('INVALID_REQUEST', 'Unsupported basic node type or field.');
  const allowed = new Set(['title', ...(['text','document'].includes(op.nodeType) ? ['text'] : []), ...(op.nodeType === 'execution' ? ['prompt'] : [])]);
  for (const field of ['title','text','prompt'] as const) if (op[field] !== undefined && (!allowed.has(field) || typeof op[field] !== 'string')) throw new ServiceError('INVALID_REQUEST', 'Field does not apply to this node type.');
  const content: Record<string, Json> = { title: op.title ?? '' };
  if (['text','document'].includes(op.nodeType)) content.text = op.text ?? '';
  if (op.nodeType === 'execution') content.prompt = op.prompt ?? '';
  if (op.nodeType === 'visualize') Object.assign(content, { prompt: '', inputBindings: [] });
  return { id: op.nodeId, type: op.nodeType, schemaVersion: 1, contentVersion: 1, content, x: op.x ?? (ordinal % 8) * 400, y: op.y ?? Math.floor(ordinal / 8) * 340, width: op.nodeType === 'visualize' ? VISUALIZE_DEFAULT_SIZE.width : 320, height: op.nodeType === 'visualize' ? VISUALIZE_DEFAULT_SIZE.height : 240, readOnly: false };
}

export function patchContent(op: NodePatch, type: string, previous: Json): Json {
  if (Object.keys(op).some(k => !['type','nodeId','expectedContentVersion','changes'].includes(k)) || !op.changes || typeof op.changes !== 'object' || Array.isArray(op.changes) || !Object.keys(op.changes).length || !previous || typeof previous !== 'object' || Array.isArray(previous)) throw new ServiceError('INVALID_REQUEST', 'Invalid node patch.');
  const allowed = new Set(['title', ...(['text','document'].includes(type) ? ['text'] : []), ...(type === 'execution' ? ['prompt'] : [])]);
  if (!BASIC_NODE_TYPES.includes(type as never) || Object.entries(op.changes).some(([key,value]) => !allowed.has(key) || typeof value !== 'string')) throw new ServiceError('INVALID_REQUEST', 'Field does not apply to this node type.');
  // Existing references are retained and validated by the common content contract.
  return { ...previous, ...op.changes } as Json;
}
