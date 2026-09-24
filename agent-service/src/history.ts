import type { DatabaseSync } from 'node:sqlite';
import type { HistoryCleanupPreview, Json } from '@openworkgraph/protocol';
import { isTerminalRunStatus } from '@openworkgraph/protocol';
import { randomUUID } from 'node:crypto';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import { Repositories } from './persistence/repositories.js';

export class History {
  readonly repo: Repositories;
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) { this.repo = new Repositories(db); }
  preview(runIds: string[]): HistoryCleanupPreview {
    return atomic(this.db, () => {
      if (!Array.isArray(runIds) || !runIds.length || runIds.length > 1000 || runIds.some(id => typeof id !== 'string' || !id)) throw new ServiceError('INVALID_REQUEST', 'Select 1..1000 run IDs');
      const unique = [...new Set(runIds)]; let count = 0;
      for (const id of unique) {
        const run = this.db.prepare('SELECT status FROM runs WHERE id=?').get(id);
        if (!run) throw new ServiceError('NOT_FOUND', 'Run not found');
        if (!isTerminalRunStatus(String(run.status))) throw new ServiceError('ACTIVE_RUN', 'Cannot clear unfinished run history');
        count += Number(this.db.prepare('SELECT COUNT(*) AS n FROM run_process_records WHERE run_id=?').get(id)!.n);
      }
      return { runIds: unique, processRecordCount: count, preserves: ['runs', 'deliveries', 'assets', 'graphLinks'] };
    });
  }
  clear(runIds: string[], idempotencyKey: string): HistoryCleanupPreview {
    return this.repo.idempotent('history.clear', idempotencyKey, { runIds }, () => {
      const preview = this.preview(runIds);
      for (const id of preview.runIds) {
        const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)!;
        const graph=this.db.prepare('SELECT g.archived,g.trashed,p.state FROM graphs g JOIN projects p ON p.id=g.project_id WHERE g.id=?').get(String(run.graph_id))!;
        if(graph.state!=='active')throw new ServiceError('PROJECT_INACTIVE','Inactive project history is read-only');
        if(graph.archived||graph.trashed)throw new ServiceError('CONFLICT','Archived or trashed graph history is read-only');
        if (run.history_state === 'cleared') continue;
        this.db.prepare('DELETE FROM run_process_records WHERE run_id=?').run(id);
        this.db.prepare("UPDATE interactions SET payload='null',answer=NULL WHERE run_id=?").run(id);
        this.db.prepare("UPDATE runs SET history_state='cleared' WHERE id=?").run(id);
        this.db.prepare('UPDATE run_runtime SET revision=revision+1 WHERE run_id=?').run(id);
        const runtime = this.db.prepare('SELECT revision FROM run_runtime WHERE run_id=?').get(id);
        this.repo.appendEvent({ eventId: randomUUID(), type: 'run.changed', projectId: String(run.project_id), graphId: String(run.graph_id), entityId: id, revision: Number(runtime?.revision ?? 0), occurredAt: new Date(this.now()).toISOString(), payload: { id, historyState: 'cleared' } });
      }
      return preview as unknown as Json;
    }) as unknown as HistoryCleanupPreview;
  }
  records(id: string): { historyState: 'retained' | 'cleared'; records: { id: number; occurredAt: string; kind: string; payload: Json }[] } {
    const run = this.db.prepare('SELECT history_state FROM runs WHERE id=?').get(id);
    if (!run) throw new ServiceError('NOT_FOUND', 'Run not found');
    return { historyState: run.history_state as 'retained' | 'cleared', records: this.db.prepare('SELECT * FROM run_process_records WHERE run_id=? ORDER BY id').all(id).map(row => ({ id: Number(row.id), occurredAt: String(row.occurred_at), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Json })) };
  }
}
