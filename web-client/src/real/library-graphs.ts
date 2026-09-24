import type { GraphSnapshot, Project } from './contracts';

/** Missing timestamps from older runtimes sort last; never invent a modification time. */
export function groupLibraryGraphs(graphs: GraphSnapshot[], projects: Project[]) {
  const names = new Map(projects.map(project => [project.projectId, project.name]));
  const groups = new Map<string, { projectId: string; name: string; graphs: GraphSnapshot[] }>();
  for (const graph of graphs) {
    const group = groups.get(graph.projectId) ?? { projectId: graph.projectId, name: names.get(graph.projectId) ?? graph.projectId, graphs: [] };
    group.graphs.push(graph);
    groups.set(graph.projectId, group);
  }
  const modified = (graph: GraphSnapshot) => Date.parse(graph.updatedAt ?? '') || 0;
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId)).map(group => ({
    ...group,
    graphs: group.graphs.sort((a, b) => modified(b) - modified(a) || a.title.localeCompare(b.title) || a.graphId.localeCompare(b.graphId)),
  }));
}
