import type { DatabaseSync } from 'node:sqlite';
import { RUN_STATUSES } from '@openworkgraph/protocol';
import { subscribeDatabaseChanges } from './persistence/changes.js';
import type { Logger } from './logger.js';

/** Observe committed events only; never copy run inputs, outputs or error details. */
export function logRunChanges(db: DatabaseSync, logger: Logger): () => void {
  let sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM events").get()!.n);
  const flush = () => {
    try {
      // Bound this scan before reading so later commits remain for the next flush.
      const through = Number(db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM events").get()!.n);
      if (through <= sequence) return;
      const rows = db.prepare("SELECT sequence,entity_id,json_extract(payload,'$.status') status FROM events WHERE sequence>? AND sequence<=? AND type='run.changed' ORDER BY sequence").all(sequence, through);
      for (const row of rows) {
        sequence = Number(row.sequence);
        const status = String(row.status);
        if ((RUN_STATUSES as readonly string[]).includes(status)) logger.write(status === 'failed' ? 'error' : status === 'interrupted' ? 'warn' : 'info', 'run.changed', { runId: String(row.entity_id), status });
      }
      sequence = through;
    } catch { logger.write('error', 'run.logging_failed'); }
  };
  const unsubscribe = subscribeDatabaseChanges(db, flush);
  return () => { unsubscribe(); flush(); };
}
