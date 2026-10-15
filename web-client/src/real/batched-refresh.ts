/** Bound refresh traffic without delaying the first read indefinitely under
 * continuous writes. A change during a read schedules one trailing read. */
export const GRAPH_REFRESH_BATCH_MS = 150;

export function createBatchedRefresh(read: () => Promise<unknown>, onError: (error: unknown) => void, delayMs = 50) {
  let dirty = false, disposed = false, active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed) return;
    dirty = true;
    if (!active && timer === undefined) timer = setTimeout(run, delayMs);
  };
  const run = async () => {
    timer = undefined;
    if (disposed || active || !dirty) return;
    dirty = false; active = true;
    try { await read(); }
    catch (error) { if (!disposed) onError(error); }
    finally {
      active = false;
      if (!disposed && dirty) schedule();
    }
  };
  return { schedule, dispose() { disposed = true; dirty = false; clearTimeout(timer); timer = undefined; } };
}
