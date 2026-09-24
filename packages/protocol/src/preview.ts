/** Shared topology rule for runtime, portable graphs and the browser. */
export function previewEdgeError(sourceType: string, targetType: string, incomingCount: number): string | undefined {
  if (sourceType === 'preview' && targetType === 'preview') return '预览节点之间不能连接。';
  if (targetType === 'preview' && incomingCount >= 1) return '预览节点只能有一个前驱。';
  return undefined;
}
