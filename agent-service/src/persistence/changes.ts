import type { DatabaseSync } from 'node:sqlite';

const listeners = new WeakMap<DatabaseSync, Set<() => void>>();
const pending = new WeakSet<DatabaseSync>();

/** Wake readers after the current synchronous transaction has committed or rolled back.
 * Notifications carry no uncommitted data: consumers reread durable rows/watermarks. */
export function notifyDatabaseChange(db: DatabaseSync): void {
  if (pending.has(db) || !listeners.has(db)) return;
  pending.add(db);
  queueMicrotask(() => {
    pending.delete(db);
    for (const listener of [...(listeners.get(db) ?? [])]) {
      try { listener(); } catch { /* One consumer cannot suppress another durable reader. */ }
    }
  });
}

export function subscribeDatabaseChanges(db: DatabaseSync, listener: () => void): () => void {
  const current = listeners.get(db) ?? new Set<() => void>();
  listeners.set(db, current); current.add(listener);
  return () => { current.delete(listener); if (!current.size) listeners.delete(db); };
}
