import { syncSkillReferences, validSkillReferences } from "./project-file-mentions";
import { limitNodeTitleOperations } from '../../../packages/protocol/src/node-title';
import { projectOperations } from './optimistic-operations';
import { randomId } from "../adapter/random";
import type { GraphSnapshot, GraphOperation, Json, Request, Run } from "./contracts";
import type { ImageRoute } from '../../../packages/protocol/src/index';
import { graphPath, errorCode, messageOf } from "./contracts";
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
export type SaveState =
  "saved" | "dirty" | "saving" | "failed" | "conflict" | "recovery";
export interface Draft {
  /** Local immutable version identity; never sent to the service. */
  draftId?: string;
  nodeId: string;
  baseVersion: number;
  content: Json;
  state: SaveState;
  error?: string;
}
export interface EditorState {
  graph: GraphSnapshot;
  drafts: Draft[];
  online: boolean;
  error: string;
  busy: boolean;
}
export interface CommandReceipt { before: GraphSnapshot; after: GraphSnapshot; operations: GraphOperation[] }
type CommandBody = { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; operations: GraphOperation[] };
type PendingCommand = { operations: GraphOperation[]; epoch: number; body?: CommandBody; before?: GraphSnapshot; resolve: (graph: GraphSnapshot) => void; reject: (error: unknown) => void };
export const COMMAND_MAX_ATTEMPTS = 3;
/** Service snapshots are authoritative. Drafts never become server state without CAS acknowledgement. */
export class GraphEditor {
  private state: EditorState;
  private confirmed: GraphSnapshot;
  private commands: PendingCommand[] = [];
  private draining = false;
  private submissionTail?: Promise<GraphSnapshot>;
  private pendingCommands = new Set<Promise<GraphSnapshot>>();
  private historyLocked = false;
  private historyRequest?: { direction: 'undo' | 'redo'; body: { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; expectedCursor: string; direction: 'undo' | 'redo' } };
  private commandListeners = new Set<(receipt: CommandReceipt) => void>();
  subscribeCommands = (listener: (receipt: CommandReceipt) => void) => {
    this.commandListeners.add(listener);
    return () => { this.commandListeners.delete(listener); };
  };
  getConfirmedSnapshot = () => this.confirmed;
  private projection() {
    return this.commands.reduce((graph, command) => projectOperations(graph, command.operations), this.confirmed);
  }
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readSequence = 0;
  private connectionEpoch = 0;
  private commandEpoch = 0;
  private writerId = randomId();
  private dismissed = new Set<string>();
  private owns(draft: Draft) {
    return draft.draftId?.startsWith(this.writerId + ':') ?? false;
  }
  private storageKey: string;
  constructor(
    private request: Request,
    graph: GraphSnapshot,
    private storage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">,
  ) {
    this.confirmed = graph;
    this.storageKey = graph.serviceId === 'browser-local'
      ? `openworkgraph:temporary:drafts:${graph.graphId}`
      : `openworkgraph:real:drafts:${graph.serviceId}:${graph.projectId}:${graph.graphId}`;
    let drafts: Draft[] = [];
    let error = '';
    try {
      const keys = [this.storageKey];
      for (let i = 0; storage && i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(this.storageKey + ':writer:')) keys.push(key);
      }
      const dismissed = new Set<string>();
      for (const key of keys) {
        const value = JSON.parse(storage?.getItem(key) ?? '[]');
        const entries = Array.isArray(value) ? value : value?.format === 2 ? value.drafts : [];
        if (value?.format === 2 && Array.isArray(value.dismissed))
          for (const id of value.dismissed) if (typeof id === 'string') dismissed.add(id);
        if (!Array.isArray(entries)) continue;
        for (const d of entries) {
          if (!d || typeof d.nodeId !== 'string' || !Number.isSafeInteger(d.baseVersion) || !('content' in d)) continue;
          const draftId = typeof d.draftId === 'string' ? d.draftId
            : 'legacy:' + JSON.stringify([d.nodeId, d.baseVersion, d.content]);
          drafts.push({ ...d, draftId, state: 'recovery' });
        }
      }
      drafts = [...new Map(drafts.filter(d => !dismissed.has(d.draftId!)).map(d => [d.draftId, d])).values()];
    } catch {
      error = translate("The browser could not read recovery drafts. Keep other editor pages open.");
    }
    this.state = { graph, drafts, online: true, error, busy: false };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(patch: Partial<EditorState> = {}) {
    if (this.disposed) return;
    const previous = this.state.drafts;
    this.state = { ...this.state, ...patch };
    try {
      // Each instance writes only its own record: no cross-tab read/modify/write.
      // GETs and clean refreshes must never write or delete draft storage.
      if (patch.drafts) {
        const retained = new Set(patch.drafts.map(d => d.draftId));
        for (const d of previous)
          if (!this.owns(d) && d.draftId && !retained.has(d.draftId)) this.dismissed.add(d.draftId);
        const drafts = patch.drafts.filter(d => this.owns(d));
        const key = this.storageKey + ':writer:' + this.writerId;
        if (drafts.length || this.dismissed.size)
          this.storage?.setItem(key, JSON.stringify({ format: 2, drafts, dismissed: [...this.dismissed] }));
        else this.storage?.removeItem(key);
      }
    } catch {
      this.state = {
        ...this.state,
        error: translate("The browser could not preserve recovery drafts. Keep this page open."),
      };
    }
    for (const listener of this.listeners) listener();
  }
  setOnline(online: boolean, cancelPending = true) {
    if (!online) {
      if (this.state.online) ++this.connectionEpoch;
      clearTimeout(this.timer);
      if (cancelPending) {
        ++this.commandEpoch;
        this.cancelCommands(Error(translate("The connection changed. Run the operation again.")));
      }
      this.emit({
        online: false,
        drafts: this.state.drafts.map((d) => ({ ...d, state: "recovery" })),
      });
    } else this.emit({ online: true });
  }
  private writable(confirmed = false) {
    if (this.disposed || (!this.state.online && !confirmed))
      throw Error(translate("The Workspace is disconnected and the cache is read-only. Reconnect, then explicitly restore the draft."));
    const graph = confirmed ? this.confirmed : this.state.graph;
    if (graph.archived || graph.trashed)
      throw Error(translate("Archived or trashed Work Graphs are read-only."));
  }
  edit(nodeId: string, content: Json) {
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    this.writable();
    const node = this.state.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.readOnly) throw Error(translate("The node does not exist or is read-only."));
    const prior = this.state.drafts.find((d) => d.nodeId === nodeId);
    if (this.state.drafts.some(d => d.nodeId === nodeId && ["conflict", "recovery"].includes(d.state)))
      throw Error(translate("Resolve the content conflict or recovery draft first."));
    const previous = prior?.content ?? node.content;
    if (previous && typeof previous === 'object' && !Array.isArray(previous) && content && typeof content === 'object' && !Array.isArray(content) && typeof previous.prompt === 'string' && typeof content.prompt === 'string' && previous.prompt !== content.prompt && previous.skillReferences !== undefined && JSON.stringify(previous.skillReferences) === JSON.stringify(content.skillReferences)) {
      content = { ...content, skillReferences: syncSkillReferences(previous.prompt, content.prompt, validSkillReferences(previous.prompt, previous.skillReferences)).map(ref => ({ ...ref })) };
    }
    const draft: Draft = {
      draftId: this.writerId + ':' + randomId(),
      nodeId,
      baseVersion: prior?.baseVersion ?? node.contentVersion,
      content: structuredClone(content),
      state: "dirty",
    };
    this.emit({
      drafts: [...this.state.drafts.filter((d) => d.nodeId !== nodeId), draft],
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, 600);
  }
  async refresh() {
    const sequence = ++this.readSequence;
    const graph = await this.request<GraphSnapshot>(
      graphPath(this.state.graph.projectId, this.state.graph.graphId),
    );
    if (this.disposed || sequence !== this.readSequence) return;
    // An older GET may finish after a command response; revisions cannot move backwards.
    if (
      graph.executionRevision < this.state.graph.executionRevision ||
      graph.layoutRevision < this.state.graph.layoutRevision
    )
      return;
    this.acceptCommitted(graph);
  }
  acceptCommitted(graph: GraphSnapshot): void {
    if (this.disposed) return;
    const current = this.state.graph;
    if (
      graph.serviceId !== current.serviceId ||
      graph.projectId !== current.projectId ||
      graph.graphId !== current.graphId
    )
      throw Error(translate("The command response scope does not match."));
    ++this.readSequence;
    if (
      graph.executionRevision < current.executionRevision ||
      graph.layoutRevision < current.layoutRevision
    )
      return;
    this.confirmed = graph;
    this.emit({ graph: this.projection() });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => undefined);
    return result;
  }
  command(operations: GraphOperation[]): Promise<GraphSnapshot> {
    return this.prepareCommand(operations)();
  }
  /** Retries retain the same immutable request body, including its idempotency key. */
  prepareCommand(operations: GraphOperation[]): () => Promise<GraphSnapshot> {
    const submit = this.prepareQueuedCommand(operations);
    let pending: Promise<GraphSnapshot> | undefined, completed: GraphSnapshot | undefined;
    return () => {
      if (pending) return pending;
      if (completed) return Promise.resolve(completed);
      if (this.historyLocked || this.historyRequest) return Promise.reject(Error(translate('Retry the pending history operation first.')));
      // A content-save dependency keeps all later user commands behind it.
      const previous = this.submissionTail;
      const needsSave = this.state.drafts.length > 0;
      const work = previous || needsSave
        ? (previous ?? Promise.resolve()).then(async () => { await this.flush(); return submit(); })
        : submit();
      pending = work.then(result => { completed = result; return result; }).finally(() => {
        if (this.submissionTail === pending) this.submissionTail = undefined;
        pending = undefined;
      });
      if (previous || needsSave) this.submissionTail = pending;
      return pending;
    };
  }
  private prepareQueuedCommand(operations: GraphOperation[]): () => Promise<GraphSnapshot> {
    const captured = structuredClone(limitNodeTitleOperations(operations));
    let pending: Promise<GraphSnapshot> | undefined;
    let completed: GraphSnapshot | undefined;
    let body: CommandBody | undefined;
    let original: GraphSnapshot | undefined;
    return () => {
      if (pending) return pending;
      if (completed) return Promise.resolve(completed);
      try { this.writable(); } catch (error) { return Promise.reject(error); }
      let entry!: PendingCommand;
      pending = new Promise<GraphSnapshot>((resolve, reject) => {
        entry = { operations: captured, epoch: this.commandEpoch, body, before: original, resolve, reject };
        this.commands.push(entry);
      }).then(result => { completed = result; return result; })
        .finally(() => { body = entry.body; original = entry.before; pending = undefined; });
      this.pendingCommands.add(pending);
      const tracked = pending;
      void tracked.finally(() => this.pendingCommands.delete(tracked)).catch(() => undefined);
      this.emit({ graph: this.projection(), busy: true, error: '' });
      void this.drainCommands();
      return pending;
    };
  }
  private cancelCommands(error: unknown) {
    const cancelled = this.commands.splice(0);
    if (!cancelled.length) return;
    this.emit({ graph: this.confirmed, busy: false, error: messageOf(error) });
    for (const command of cancelled) command.reject(error);
  }
  /** Fence all accepted edits, then ask the Runtime to move the shared document cursor. */
  async travelHistory(direction: 'undo' | 'redo'): Promise<GraphSnapshot> {
    if (this.historyLocked) throw Error(translate('Wait for undo or redo to finish.'));
    this.writable();
    this.historyLocked = true;
    clearTimeout(this.timer);
    const epoch = this.connectionEpoch;
    try {
      await Promise.all([...this.pendingCommands, ...(this.submissionTail ? [this.submissionTail] : [])]);
      await this.flush();
      this.writable();
      if (epoch !== this.connectionEpoch) throw Error(translate('The connection changed. Run the operation again.'));
      const graph = this.confirmed;
      if (this.historyRequest && this.historyRequest.direction !== direction) throw Error(translate('Retry the pending history operation first.'));
      if (!this.historyRequest) {
        if (!graph.history) throw Error(translate('This Workspace does not support document history. Update the Workspace.'));
        if (!(direction === 'undo' ? graph.history.canUndo : graph.history.canRedo) || !graph.history.cursor)
          throw Error(direction === 'undo' ? translate('There is nothing to undo.') : translate('There is nothing to redo.'));
        this.historyRequest = { direction, body: { idempotencyKey: randomId(), expectedExecutionRevision: graph.executionRevision, expectedLayoutRevision: graph.layoutRevision, expectedCursor: graph.history.cursor, direction } };
      }
      const body = this.historyRequest.body;
      let result!: GraphSnapshot;
      for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt++) {
        try { result = await this.request<GraphSnapshot>(graphPath(graph.projectId, graph.graphId) + '/history', body); break; }
        catch (error) {
          const code = errorCode(error), status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
          const uncertain = !code || status >= 500 || ['NETWORK_ERROR','TIMEOUT','INTERNAL_ERROR','SERVICE_UNAVAILABLE'].includes(code);
          if (!uncertain) { this.historyRequest = undefined; try { await this.refresh(); } catch { /* Keep the original rejection. */ } throw error; }
          if (attempt + 1 === COMMAND_MAX_ATTEMPTS) throw error;
        }
      }
      if (epoch !== this.connectionEpoch || this.disposed) throw Error(translate('The connection changed. Verify the Workspace state first.'));
      this.acceptCommitted(result);
      this.historyRequest = undefined;
      return result;
    } finally { this.historyLocked = false; }
  }
  private async drainCommands() {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (this.commands.length && !this.disposed) {
        const command = this.commands[0]!;
        try {
          let result!: GraphSnapshot;
          for (let attempt = 0; attempt < COMMAND_MAX_ATTEMPTS; attempt++) {
            this.writable(true);
            if (command.epoch !== this.commandEpoch || this.commands[0] !== command)
              throw Error(translate("The connection changed. Run the operation again."));
            const g = this.confirmed;
            command.before ??= structuredClone(g);
            command.body ??= { idempotencyKey: randomId(), expectedExecutionRevision: g.executionRevision, expectedLayoutRevision: g.layoutRevision, operations: command.operations };
            try {
              result = await this.request<GraphSnapshot>(graphPath(g.projectId, g.graphId) + '/commands', command.body);
              break;
            } catch (error) {
              const code = errorCode(error);
              const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
              const retryable = !code || status >= 500 || status === 429 || ['REVISION_CONFLICT', 'NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(code);
              if (command.epoch !== this.commandEpoch || this.disposed || this.commands[0] !== command) throw error;
              if (code === 'REVISION_CONFLICT') {
                // A rejected transaction did not commit: it is safe to create a new request.
                command.body = undefined; command.before = undefined;
                await this.refresh();
              }
              if (!retryable || attempt + 1 === COMMAND_MAX_ATTEMPTS) {
                // A lost response may have committed. Reconcile before discarding the overlay.
                if (retryable && code !== 'REVISION_CONFLICT') { try { await this.refresh(); } catch { /* Keep last confirmed state. */ } }
                throw error;
              }
              await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
            }
          }
          if (command.epoch !== this.commandEpoch || this.disposed || this.commands[0] !== command) continue;
          if (result.serviceId !== this.confirmed.serviceId || result.projectId !== this.confirmed.projectId || result.graphId !== this.confirmed.graphId)
            throw Error(translate("The command response scope does not match."));
          this.commands.shift();
          this.acceptCommitted(result);
          for (const listener of this.commandListeners) listener({ before: command.before!, after: result, operations: command.operations });
          command.resolve(result);
          this.emit({ graph: this.projection(), busy: this.commands.length > 0 });
        } catch (error) {
          if (this.commands[0] === command) this.cancelCommands(error);
        }
      }
    } finally { this.draining = false; }
  }
  flush(): Promise<void> {
    return this.flushDrafts();
  }
  private flushDrafts(onlyDraftId?: string): Promise<void> {
    clearTimeout(this.timer);
    const epoch = this.connectionEpoch;
    const candidates = () => this.state.drafts.filter(d => !onlyDraftId || d.draftId === onlyDraftId);
    return this.serial(async () => {
      this.writable();
      if (epoch !== this.connectionEpoch)
        throw Error(translate("The connection changed. Restore the draft explicitly."));
      if (
        candidates().some((d) =>
          ["conflict", "recovery", "failed"].includes(d.state),
        )
      )
        throw Error(
          translate("A failed save, conflict, or recovery draft is blocking the run. Resolve it, then click Run again."),
        );
      while (candidates().length) {
        if (
          epoch !== this.connectionEpoch ||
          candidates().some((d) =>
            ["conflict", "recovery", "failed"].includes(d.state),
          )
        )
          throw Error(translate("The connection or draft state changed. Restore it explicitly."));
        const draft = candidates()[0]!;
        this.emit({
          drafts: this.state.drafts.map((d) =>
            d === draft ? { ...d, state: "saving" } : d,
          ),
        });
        try {
          const result = await this.prepareQueuedCommand([{
            type: 'node.content', nodeId: draft.nodeId,
            expectedContentVersion: draft.baseVersion, content: draft.content,
          }])();
          if (epoch !== this.connectionEpoch)
            throw Error(translate("The connection changed. Read the Workspace state before restoring the draft."));
          ++this.readSequence;
          const accepted = result.nodes.find((n) => n.id === draft.nodeId);
          this.acceptCommitted(result);
          this.emit({
            drafts: this.state.drafts.flatMap((d) =>
              d.nodeId !== draft.nodeId || !this.owns(d)
                ? [d]
                : d.draftId === draft.draftId
                  ? []
                  : [
                      {
                        ...d,
                        baseVersion: accepted?.contentVersion ?? d.baseVersion,
                        state: "dirty" as const,
                      },
                    ],
            ),
          });
          this.writable();
        } catch (error) {
          const state: SaveState =
            !this.state.online || epoch !== this.connectionEpoch
              ? "recovery"
              : errorCode(error) === "REVISION_CONFLICT"
                ? "conflict"
                : "failed";
          this.emit({
            drafts: this.state.drafts.map((d) =>
              d.nodeId === draft.nodeId && this.owns(d)
                ? { ...d, state, error: messageOf(error) }
                : d,
            ),
            error: messageOf(error),
          });
          if (state === "conflict") {
            try {
              await this.refresh();
            } catch {
              /* Preserve draft and conflict if refresh fails. */
            }
          }
          throw error;
        }
      }
    });
  }
  async resolve(nodeId: string, content?: Json) {
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    this.writable();
    const selected = this.state.drafts.find(d => d.nodeId === nodeId);
    if (!selected) return;
    const epoch = this.connectionEpoch;
    const node = this.state.graph.nodes.find((n) => n.id === nodeId);
    // Use the version actually presented in the conflict panel. Fetching a newer
    // version here would silently turn the user's choice into an overwrite.
    if (content === undefined) {
      await this.refresh();
      if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
      this.writable();
      if (epoch !== this.connectionEpoch || !this.state.drafts.some(d => d.draftId === selected.draftId))
        throw Error(translate("The connection or draft changed. Select the recovery action again."));
      this.emit({
        drafts: this.state.drafts.filter((d) => d.draftId !== selected.draftId),
      });
      return;
    }
    if (!node || node.readOnly)
      throw Error(translate("The original node was deleted or is read-only. The draft was kept for copying."));
    const draftId = this.writerId + ':' + randomId();
    this.emit({
      drafts: this.state.drafts.map((d) =>
        d.draftId === selected.draftId
          ? {
              draftId,
              nodeId,
              baseVersion: node.contentVersion,
              content: structuredClone(content),
              state: "dirty",
            }
          : d,
      ),
    });
    await this.flushDrafts(draftId);
  }
  async run(nodeId: string, kind: string, modelOverride?: unknown, imageRoute?: ImageRoute, preserveHistoricalOutputs?: boolean) {
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    const epoch = this.connectionEpoch;
    await this.flush();
    this.writable();
    if (epoch !== this.connectionEpoch)
      throw Error(translate("The connection changed. Click Run again."));
    const g = this.state.graph;
    const preview = await this.request<{
      canSubmit: boolean;
      issues: { reason: string }[];
    }>(graphPath(g.projectId, g.graphId) + "/input-preview", { nodeId });
    if (!preview.canSubmit)
      throw Error(preview.issues.map((i) => i.reason).join("；"));
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    // No deferred auto-run: edits made while preview was in flight abort this click.
    if (
      epoch !== this.connectionEpoch ||
      this.state.drafts.length ||
      this.state.graph.executionRevision !== g.executionRevision
    )
      throw Error(translate("Inputs or the connection changed during preview. Click Run again."));
    this.writable();
    return this.request<Run>(graphPath(g.projectId, g.graphId) + "/runs", {
      nodeId,
      kind,
      idempotencyKey: randomId(),
      expectedExecutionRevision: g.executionRevision,
      ...(modelOverride ? { modelOverride } : {}),
      ...(kind === 'image_generation' && imageRoute ? { imageRoute } : {}),
      ...(kind === 'execution' && preserveHistoricalOutputs !== undefined ? { preserveHistoricalOutputs } : {}),
    });
  }
  dispose() {
    clearTimeout(this.timer);
    this.cancelCommands(Error(translate("The Work Graph changed. Remaining operations were stopped.")));
    this.disposed = true;
    this.commandListeners.clear();
    this.listeners.clear();
    ++this.readSequence;
  }
}
