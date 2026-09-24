export interface RecentGraph {
  temporary: boolean;
  serviceId: string;
  projectId: string;
  graphId: string;
  title: string;
  runtimeName: string;
  projectName: string;
}

const key = 'openworkgraph:recent-graphs:v1';
const limit = 10;

export function readRecentGraphs(storage: Pick<Storage, 'getItem'>): RecentGraph[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Omit<RecentGraph, 'projectName'> & { projectName?: string } =>
      item && typeof item === 'object' && typeof item.temporary === 'boolean' &&
      ['serviceId', 'projectId', 'graphId', 'title', 'runtimeName'].every(field =>
        typeof item[field] === 'string' && item[field].length > 0),
    ).map(item => ({ ...item, projectName: typeof item.projectName === 'string' && item.projectName.length > 0 ? item.projectName : item.projectId })).slice(0, limit);
  } catch { return []; }
}

export function rememberGraph(storage: Pick<Storage, 'getItem' | 'setItem'>, graph: RecentGraph): RecentGraph[] {
  const recent = [graph, ...readRecentGraphs(storage).filter(item =>
    !(item.temporary === graph.temporary && item.serviceId === graph.serviceId &&
      item.projectId === graph.projectId && item.graphId === graph.graphId),
  )].slice(0, limit);
  try { storage.setItem(key, JSON.stringify(recent)); } catch { /* Navigation still works without storage. */ }
  return recent;
}
