import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { atomic } from '../persistence/database.js';
import { Repositories } from '../persistence/repositories.js';

/** Capacity changes affect future claims only, never cancel occupied work. */
export function localCapacity(db: DatabaseSync, input?: string): { capacity: number; occupied: number; available: number } {
  return atomic(db, () => {
    let changed = false;
    if (input !== undefined) {
      const value = Number(input);
      if (!/^[1-9][0-9]*$/.test(input) || !Number.isSafeInteger(value)) throw new Error('Capacity must be a positive safe integer');
      db.prepare("INSERT INTO settings(key,value) VALUES('capacity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value));
      changed = true;
    }
    const row = db.prepare("SELECT value FROM settings WHERE key='capacity'").get();
    const capacity = Number(row?.value);
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid stored capacity');
    const occupied = Number(db.prepare('SELECT count(*) AS n FROM occupancy').get()!.n);
    const result = { capacity, occupied, available: Math.max(0, capacity - occupied) };
    if (changed) new Repositories(db).appendEvent({
      eventId: randomUUID(),
      type: 'capacity.changed',
      projectId: null,
      graphId: null,
      entityId: 'capacity',
      revision: 1,
      occurredAt: new Date().toISOString(),
      payload: result,
    });
    return result;
  });
}
