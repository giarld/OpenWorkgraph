/** Kahn ordering for execution dependencies only. Reference feedback is unrelated. */
export function executionOrder(edges: readonly { sourceId: string; targetId: string; kind?: string }[]): string[] | null {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'execution') continue;
    if (!indegree.has(edge.sourceId)) indegree.set(edge.sourceId, 0);
    indegree.set(edge.targetId, (indegree.get(edge.targetId) ?? 0) + 1);
    const next = outgoing.get(edge.sourceId) ?? [];
    next.push(edge.targetId); outgoing.set(edge.sourceId, next);
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const id of outgoing.get(ready[index]!) ?? []) {
      const count = indegree.get(id)! - 1; indegree.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  return ready.length === indegree.size ? ready : null;
}
