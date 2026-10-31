const pending = new Map<string, Promise<void>>();

/** Read snapshots and register targets under one Workspace/browser lock so an
 * older full snapshot cannot remove a target registered while it was in flight. */
export async function withRemoteTemporaryTargets<T>(serviceId: string, browserId: string, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([serviceId, browserId]);
  const previous = pending.get(key) ?? Promise.resolve();
  const operation = previous.then(() => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request('openworkgraph:remote-temporary-targets:' + key, work) : work();
  });
  const settled = operation.then(() => {}, () => {});
  pending.set(key, settled);
  try { return await operation; }
  finally { if (pending.get(key) === settled) pending.delete(key); }
}
