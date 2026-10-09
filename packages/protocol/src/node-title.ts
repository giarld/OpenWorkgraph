import type { GraphOperation, Json } from './index.js';

export const NODE_TITLE_MAX_LENGTH = 32;

/** Count Unicode code points, so supplementary characters stay intact. */
export function limitNodeTitle(value: string, maxLength = NODE_TITLE_MAX_LENGTH): string {
  return Array.from(value).slice(0, maxLength).join('');
}

/** Only the node's top-level title is bounded; body and resource names are preserved. */
export function limitNodeContentTitle(content: Json): Json {
  if (!content || typeof content !== 'object' || Array.isArray(content) || typeof content.title !== 'string') return content;
  const title = limitNodeTitle(content.title);
  return title === content.title ? content : { ...content, title };
}

export function limitNodeTitleOperations(operations: GraphOperation[]): GraphOperation[] {
  return operations.map(op => {
    switch (op.type) {
      case 'node.create': return { ...op, node: { ...op.node, content: limitNodeContentTitle(op.node.content) } };
      case 'node.content':
      case 'node.project-file.associate': return { ...op, content: limitNodeContentTitle(op.content) };
      case 'group.rename': return typeof op.title === 'string' ? { ...op, title: limitNodeTitle(op.title) } : op;
      default: return op;
    }
  });
}
