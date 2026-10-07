import { randomId } from '../adapter/random';
import type { GraphOperation, GraphSnapshot, Request } from './contracts';
import { graphPath, messageOf } from './contracts';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export interface HistoryContext { graph: GraphSnapshot; online: boolean; busy: boolean; queued?: boolean; drafts: number; active: boolean }
export interface HistoryState { canUndo: boolean; canRedo: boolean; busy: boolean; reason: string; undoRunIds: string[] }

/** The Runtime (or local temporary store) owns all versions and the shared cursor.
 * This controller only exposes availability and coordinates the editor's write fence. */
export class GraphHistory {
  queuedCommit?: (operations: GraphOperation[]) => Promise<GraphSnapshot>;
  queuedTravel?: (direction: 'undo' | 'redo') => Promise<GraphSnapshot>;
  private listeners = new Set<() => void>();
  private state: HistoryState = { canUndo: false, canRedo: false, busy: false, reason: '', undoRunIds: [] };
  constructor(
    private request: Request,
    private read: () => HistoryContext,
    private refresh: (committed?: GraphSnapshot) => Promise<void>,
    private newId: () => string = randomId,
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  ) {
    // Old browser-local deltas cannot be imported into a Runtime-owned timeline.
    const g = read().graph;
    try { storage?.removeItem('openworkgraph:history-doc:v1:' + JSON.stringify([g.serviceId, g.projectId, g.graphId])); } catch { /* Storage is optional. */ }
    this.observe();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<HistoryState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  observe = () => {
    const c = this.read(), h = c.graph.history;
    const available = c.online && !c.graph.archived && !c.graph.trashed && !this.state.busy;
    const valid = h && (h.expiresAt === null || h.expiresAt > Date.now());
    this.emit({
      canUndo: !!(available && h && ((valid && h.canUndo) || c.queued || c.drafts)),
      canRedo: !!(available && valid && h.canRedo && !c.drafts),
      undoRunIds: available && valid ? h.undoRunIds ?? [] : [],
    });
  };
  // Kept as a notification hook for external operations; it never deletes shared history.
  clear(_reason = '') { this.observe(); }
  prepareOperations(operations: GraphOperation[]): GraphOperation[] { return structuredClone(operations); }
  recordCommitted(_before: GraphSnapshot, _after: GraphSnapshot, _operations: GraphOperation[]) { this.observe(); }
  async execute(operations: GraphOperation[]): Promise<GraphSnapshot> {
    const c = this.read();
    if (!c.online || c.graph.archived || c.graph.trashed) throw Error(translate('The current Work Graph is read-only.'));
    if (this.state.busy) throw Error(translate('Wait for undo or redo to finish.'));
    const g = c.graph;
    const result = await (this.queuedCommit ? this.queuedCommit(operations) : this.request<GraphSnapshot>(graphPath(g.projectId,g.graphId) + '/commands', {
      operations, idempotencyKey: this.newId(), expectedExecutionRevision:g.executionRevision, expectedLayoutRevision:g.layoutRevision,
    }));
    await this.refresh(result); this.observe(); return result;
  }
  prepareCommand(_operations: GraphOperation[], commit: () => Promise<GraphSnapshot>) {
    let pending: Promise<GraphSnapshot> | undefined, completed: GraphSnapshot | undefined;
    return () => {
      if (completed) return Promise.resolve(completed);
      if (pending) return pending;
      pending = commit().then(async result => { await this.refresh(result); completed = result; this.observe(); return result; }).finally(() => { pending = undefined; });
      return pending;
    };
  }
  undo = () => this.travel('undo');
  redo = () => this.travel('redo');
  private async travel(direction: 'undo' | 'redo'): Promise<void> {
    if (this.state.busy) throw Error(translate('Wait for undo or redo to finish.'));
    const c = this.read();
    if (!c.online || c.graph.archived || c.graph.trashed) throw Error(translate('The current Work Graph is read-only.'));
    this.emit({ busy: true, canUndo: false, canRedo: false, reason: '' });
    try {
      let result: GraphSnapshot;
      if (this.queuedTravel) result = await this.queuedTravel(direction);
      else {
        if (c.busy || c.drafts) throw Error(translate('Wait for the current operation and content save to finish before changing history or the Work Graph.'));
        const g = c.graph;
        if (!g.history) throw Error(translate('This Workspace does not support document history. Update the Workspace.'));
        if (!(direction === 'undo' ? g.history.canUndo : g.history.canRedo) || !g.history.cursor)
          throw Error(direction === 'undo' ? translate('There is nothing to undo.') : translate('There is nothing to redo.'));
        result = await this.request<GraphSnapshot>(graphPath(g.projectId,g.graphId) + '/history', { direction, expectedCursor:g.history.cursor, idempotencyKey:this.newId(), expectedExecutionRevision:g.executionRevision, expectedLayoutRevision:g.layoutRevision });
      }
      await this.refresh(result);
    } catch (error) { this.emit({ reason: messageOf(error) }); throw error; }
    finally { this.emit({ busy: false }); this.observe(); }
  }
}
