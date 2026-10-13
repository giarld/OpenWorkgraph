export function nodeEditorStorageKey(temporary: boolean, serviceId: string, projectId: string, graphId: string, nodeId: string): string {
  return 'openworkgraph:node-editor:v1:' + JSON.stringify([temporary, serviceId, projectId, graphId, nodeId]);
}

export function readNodeEditorState(key: string): boolean | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return typeof value === 'boolean' ? value : undefined;
  } catch { return undefined; }
}

export function saveNodeEditorState(key: string, open: boolean): void {
  try { localStorage.setItem(key, JSON.stringify(open)); } catch { /* Keep the in-memory state when browser storage is unavailable. */ }
}
