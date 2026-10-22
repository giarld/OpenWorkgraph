import { RUN_INPUT_FIELDS, mergeRunInput, parseRunInput, type RunInput, type NodeInputDrafts } from '../../../packages/protocol/src/run-input';
import type { AgentSelection } from '../../../packages/protocol/src/agents';
import { syncSkillReferences, validSkillReferences } from "./project-file-mentions";
import { limitNodeTitleOperations } from '../../../packages/protocol/src/node-title';
import { projectOperations } from './optimistic-operations';
import { randomId } from "../adapter/random";
import type { GraphSnapshot, GraphOperation, Json, Request, Run } from "./contracts";
import type { ExecutionPlan, ImageRoute, ModelSelection } from '../../../packages/protocol/src/index';
import { graphPath, errorCode, messageOf } from "./contracts";
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
import { mergeVisualizeConfiguration, sameVisualizeConfiguration, sameVisualizeGenerationInputs, validateVisualizeConfiguration } from './temporary-store';
import { registerClipboardRequest, takeVisualizePasteIntents, createVisualizePasteWorkflow } from './graph-clipboard';
export type SaveState =
  "saved" | "dirty" | "saving" | "failed" | "conflict" | "recovery";
export interface Draft {
  /** Local immutable version identity; never sent to the service. */
  draftId?: string;
  nodeId: string;
  baseVersion: number;
  /** Original visualize configuration, for safe rebasing across runtime saves. */
  baseContent?: Json;
  content: Json;
  state: SaveState;
  error?: string;
  errorCode?: string;
}
export interface EditorState {
  graph: GraphSnapshot;
  drafts: Draft[];
  runInputs: Record<string, { id: string; fields: RunInput }>;
  online: boolean;
  error: string;
  busy: boolean;
}
export interface CommandReceipt { before: GraphSnapshot; after: GraphSnapshot; operations: GraphOperation[] }
type CommandBody = { idempotencyKey: string; expectedExecutionRevision: number; expectedLayoutRevision: number; operations: GraphOperation[] };
type PendingCommand = { operations: GraphOperation[]; epoch: number; body?: CommandBody; before?: GraphSnapshot; visualizeDraft?: Draft; resolve: (graph: GraphSnapshot) => void; reject: (error: unknown) => void };
function sameInputValue(a:Json|undefined,b:Json|undefined):boolean {
  if(a===b)return true;
  if(!a || !b || typeof a!=='object' || typeof b!=='object')return false;
  if(Array.isArray(a) || Array.isArray(b))return Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((item,index)=>sameInputValue(item,b[index]));
  return Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(key=>Object.hasOwn(b,key) && sameInputValue(a[key],b[key]));
}
export const COMMAND_MAX_ATTEMPTS = 3;
/** Service snapshots are authoritative. Drafts never become server state without CAS acknowledgement. */
export interface RunSubmissionOptions { agent?: AgentSelection; modelOverride?: ModelSelection; imageRoute?: ImageRoute; preserveHistoricalOutputs?: boolean }
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
  private refreshRequested = 0;
  private refreshing?: Promise<void>;
  private connectionEpoch = 0;
  private commandEpoch = 0;
  private writerId = randomId();
  private dismissed = new Set<string>();
  private owns(draft: Draft) {
    return draft.draftId?.startsWith(this.writerId + ':') ?? false;
  }
  private storageKey: string;
  private acceptedInputs = new Map<string,string>();
  private runInputKey(nodeId:string) {
    const g=this.confirmed;
    return 'openworkgraph:run-input:v1:'+JSON.stringify([g.serviceId,g.projectId,g.graphId,nodeId]);
  }
  nodeContent(nodeId:string):Record<string,Json> {
    const node=this.state.graph.nodes.find(node=>node.id===nodeId);
    return mergeRunInput(this.state.drafts.find(d=>d.nodeId===nodeId)?.content ?? node?.content ?? {},this.state.runInputs[nodeId]?.fields);
  }
  editRunInput(nodeId:string, content:Json) {
    if(this.historyLocked || this.historyRequest)throw Error(translate('Retry the pending history operation first.'));
    this.writable();
    const node=this.state.graph.nodes.find(node=>node.id===nodeId);
    if(!node || node.readOnly || !['execution','text','image','visualize'].includes(node.type))throw Error(translate('The node does not exist or is read-only.'));
    const value=mergeRunInput(content),previous=this.nodeContent(nodeId);
    if(typeof value.prompt==='string' && value.prompt!==previous.prompt && value.skillReferences!==undefined && sameInputValue(previous.skillReferences,value.skillReferences))value.skillReferences=syncSkillReferences(String(previous.prompt??''),value.prompt,validSkillReferences(String(previous.prompt??''),previous.skillReferences)).map(ref=>({...ref}));
    const fields:RunInput={...this.state.runInputs[nodeId]?.fields};
    const promptChanged=typeof value.prompt==='string' && value.prompt!==previous.prompt;
    for(const key of RUN_INPUT_FIELDS)if(Object.hasOwn(value,key) && (!sameInputValue(value[key],previous[key]) || promptChanged && ['skillReferences','features'].includes(key)))fields[key]=structuredClone(value[key]);
    if(!Object.keys(fields).length)return;
    const draft={id:randomId(),fields:parseRunInput(fields)};
    try {this.storage?.setItem(this.runInputKey(nodeId),JSON.stringify(draft));}
    catch {this.emit({error:translate('The browser could not preserve recovery drafts. Keep this page open.')});}
    this.emit({runInputs:{...this.state.runInputs,[nodeId]:draft}});
  }
  private acknowledgeRunInputs(graph:GraphSnapshot) {
    const runInputs={...this.state.runInputs};let changed=false;
    for(const [nodeId,id] of this.acceptedInputs){
      const draft=runInputs[nodeId],node=graph.nodes.find(node=>node.id===nodeId);
      if(!draft || draft.id!==id){this.acceptedInputs.delete(nodeId);continue;}
      const content=mergeRunInput(node?.content??{});
      if(!node || !Object.entries(draft.fields).every(([key,value])=>sameInputValue(content[key],value)))continue;
      delete runInputs[nodeId];this.acceptedInputs.delete(nodeId);changed=true;
      try {if(JSON.parse(this.storage?.getItem(this.runInputKey(nodeId))??'null')?.id===id)this.storage?.removeItem(this.runInputKey(nodeId));}catch { /* Keep other tabs' drafts. */ }
    }
    return changed?runInputs:this.state.runInputs;
  }
  constructor(
    private request: Request,
    graph: GraphSnapshot,
    private storage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">,
  ) {
    registerClipboardRequest(graph, request);
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
    const runInputs:EditorState['runInputs']={};
    try {for(const node of graph.nodes){
      const value=JSON.parse(storage?.getItem(this.runInputKey(node.id))??'null');
      if(value && typeof value.id==='string')runInputs[node.id]={id:value.id,fields:parseRunInput(value.fields)};
    }} catch {error=translate('The browser could not read recovery drafts. Keep other editor pages open.');}
    this.state = { graph, drafts, runInputs, online: true, error, busy: false };
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
    if(this.state.runInputs[nodeId]){
      const next=mergeRunInput(content),saved=mergeRunInput(previous);
      for(const key of Object.keys(this.state.runInputs[nodeId].fields)){
        if(Object.hasOwn(saved,key))next[key]=saved[key];else delete next[key];
      }
      content=next;
    }
    if (node.type === 'visualize') validateVisualizeConfiguration(previous, content);
    if (previous && typeof previous === 'object' && !Array.isArray(previous) && content && typeof content === 'object' && !Array.isArray(content) && typeof previous.prompt === 'string' && typeof content.prompt === 'string' && previous.prompt !== content.prompt && previous.skillReferences !== undefined && JSON.stringify(previous.skillReferences) === JSON.stringify(content.skillReferences)) {
      content = { ...content, skillReferences: syncSkillReferences(previous.prompt, content.prompt, validSkillReferences(previous.prompt, previous.skillReferences)).map(ref => ({ ...ref })) };
    }
    const draft: Draft = {
      draftId: this.writerId + ':' + randomId(),
      nodeId,
      baseVersion: prior?.baseVersion ?? node.contentVersion,
      ...(node.type === 'visualize' ? { baseContent: structuredClone(prior?.baseContent ?? node.content) } : {}),
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
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    ++this.refreshRequested;
    if (this.refreshing) return this.refreshing;
    const work = Promise.resolve().then(async () => {
      for (;;) {
        if (this.disposed) return;
        const ticket = this.refreshRequested, sequence = ++this.readSequence;
        const graph = await this.request<GraphSnapshot>(graphPath(this.state.graph.projectId, this.state.graph.graphId));
        if (this.disposed) return;
        // A command may have committed while this read was in flight.
        if (sequence === this.readSequence) this.acceptCommitted(graph);
        if (ticket === this.refreshRequested) return;
      }
    });
    this.refreshing = work;
    const clear = () => { if (this.refreshing === work) this.refreshing = undefined; };
    void work.then(clear, clear);
    return work;
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
    this.emit({ graph: this.projection(), runInputs:this.acknowledgeRunInputs(graph) });
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
    const intents = takeVisualizePasteIntents(operations, this.state.graph);
    const captured = structuredClone(operations);
    const creation = captured.map(operation => {
      if (operation.type !== 'node.create' || !intents.some(intent => intent.node.id === operation.node.id)) return operation;
      const { page: _page, form: _form, state: _state, ...content } = operation.node.content as Record<string, Json>;
      return { ...operation, node: { ...operation.node, content } };
    });
    const submit = this.prepareQueuedCommand(creation);
    const workflow = intents.length ? createVisualizePasteWorkflow(intents, captured, this.state.graph, this.request, submit, () => this.confirmed, graph => this.acceptCommitted(graph)) : undefined;
    let pending: Promise<GraphSnapshot> | undefined, completed: GraphSnapshot | undefined;
    return () => {
      if (pending) return pending;
      if (completed) return Promise.resolve(completed);
      if (this.historyLocked || this.historyRequest) return Promise.reject(Error(translate('Retry the pending history operation first.')));
      // A content-save dependency keeps all later user commands behind it.
      const previous = this.submissionTail;
      const needsSave = this.state.drafts.length > 0;
      const epoch = this.connectionEpoch;
      const guard = () => { this.writable(); if (epoch !== this.connectionEpoch) throw Error(translate('The connection changed. Run the operation again.')); };
      const work = previous || needsSave || workflow
        ? (previous ?? Promise.resolve()).then(async () => {
          await this.flush();
          guard();
          if (!workflow) return submit();
          this.emit({ busy: true, error: '' });
          try { return await workflow.run(guard, operations => this.prepareQueuedCommand(operations)); }
          catch (error) {
            if (errorCode(error) === 'REVISION_CONFLICT' && epoch === this.connectionEpoch && !this.disposed) { try { await this.refresh(); } catch { /* Preserve the original rejection. */ } }
            this.emit({ error: messageOf(error) }); throw error;
          }
          finally { this.emit({ busy: this.commands.length > 0 }); }
        })
        : submit();
      pending = work.then(result => { completed = result; return result; }).finally(() => {
        if (this.submissionTail === pending) this.submissionTail = undefined;
        pending = undefined;
      });
      if (previous || needsSave || workflow) this.submissionTail = pending;
      return pending;
    };
  }
  private prepareQueuedCommand(operations: GraphOperation[], visualizeDraft?: Draft): () => Promise<GraphSnapshot> {
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
        entry = { operations: captured, epoch: this.commandEpoch, body, before: original, visualizeDraft, resolve, reject };
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
  /** The transport has settled this exact request; refresh before releasing its edit fence. */
  async reconcileRequest(idempotencyKey: string): Promise<void> {
    await this.refresh();
    if (this.historyRequest?.body.idempotencyKey === idempotencyKey) {
      this.historyRequest = undefined;
      this.emit();
    }
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
            if (!command.body && command.visualizeDraft) {
              const draft = command.visualizeDraft;
              const node = g.nodes.find(n => n.id === draft.nodeId);
              if (!node || node.readOnly || node.type !== 'visualize') throw Error(translate('The original node was deleted or is read-only. The draft was kept for copying.'));
              if (draft.baseContent === undefined || !sameVisualizeConfiguration(draft.baseContent, node.content))
                throw Object.assign(Error(translate('The visualization configuration changed. Review the latest content before saving.')), { code: 'REVISION_CONFLICT' });
              command.operations = limitNodeTitleOperations([{ type: 'node.content', nodeId: draft.nodeId, expectedContentVersion: node.contentVersion, content: mergeVisualizeConfiguration(draft.baseContent, draft.content, node.content) }]);
            }
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
          const node = this.confirmed.nodes.find(n => n.id === draft.nodeId);
          if (!node || node.readOnly) throw Error(translate('The original node was deleted or is read-only. The draft was kept for copying.'));
          if (node.type === 'visualize') validateVisualizeConfiguration(draft.baseContent ?? node.content, draft.content);
          const result = await this.prepareQueuedCommand([{
            type: 'node.content', nodeId: draft.nodeId,
            expectedContentVersion: draft.baseVersion, content: draft.content,
          }], node.type === 'visualize' ? structuredClone(draft) : undefined)();
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
                        ...(accepted?.type === 'visualize' ? { baseContent: structuredClone(accepted.content), content: mergeVisualizeConfiguration(d.baseContent ?? draft.content, d.content, accepted.content) } : {}),
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
                ? { ...d, state, error: messageOf(error), errorCode: errorCode(error) }
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
  async resolve(nodeId: string, content?: Json, selectedDraftId?: string) {
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    this.writable();
    const selected = this.state.drafts.find(d => d.nodeId === nodeId && (!selectedDraftId || d.draftId === selectedDraftId));
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
    if (node.type === 'visualize') {
      // An explicit recovery choice may retain an old runtime snapshot or use
      // the displayed latest one, but cannot author a new page/form/state.
      try { content = mergeVisualizeConfiguration(selected.content, content, node.content); }
      catch { content = mergeVisualizeConfiguration(node.content, content, node.content); }
    }
    const draftId = this.writerId + ':' + randomId();
    this.emit({
      drafts: this.state.drafts.map((d) =>
        d.draftId === selected.draftId
          ? {
              draftId,
              nodeId,
              baseVersion: node.contentVersion,
              ...(node.type === 'visualize' ? { baseContent: structuredClone(node.content) } : {}),
              content: structuredClone(content),
              state: "dirty",
            }
          : d,
      ),
    });
    await this.flushDrafts(draftId);
  }
  /** Explicitly closing the prompt editor shares prompt text and its bound mentions. */
  async savePrompt(nodeId:string) {
    const captured=this.state.runInputs[nodeId];
    const fields:RunInput=Object.fromEntries(Object.entries(captured?.fields??{}).filter(([key])=>['prompt','skillReferences','features'].includes(key)));
    if (!Object.keys(fields).length) return;
    const epoch=this.connectionEpoch;
    await this.flush();
    this.writable();
    if(epoch!==this.connectionEpoch)throw Error(translate('The connection changed. Run the operation again.'));
    const node=this.state.graph.nodes.find(node=>node.id===nodeId);
    if(!node || node.readOnly)throw Error(translate('The node does not exist or is read-only.'));
    const graph=await this.command([{type:'node.content',nodeId,expectedContentVersion:node.contentVersion,content:mergeRunInput(node.content,fields)}]);
    // Preserve models and any newer prompt typed while this save was in flight.
    const current=this.state.runInputs[nodeId];
    if(current?.id!==captured.id)return;
    const content=mergeRunInput(graph.nodes.find(node=>node.id===nodeId)?.content??{});
    if(!Object.entries(fields).every(([key,value])=>sameInputValue(content[key],value)))return;
    const remaining=Object.fromEntries(Object.entries(current.fields).filter(([key])=>!Object.hasOwn(fields,key)));
    const runInputs={...this.state.runInputs};
    try {
      const stored=JSON.parse(this.storage?.getItem(this.runInputKey(nodeId))??'null');
      if(Object.keys(remaining).length) {
        runInputs[nodeId]={id:randomId(),fields:remaining};
        if(stored?.id===captured.id)this.storage?.setItem(this.runInputKey(nodeId),JSON.stringify(runInputs[nodeId]));
      } else {
        delete runInputs[nodeId];
        if(stored?.id===captured.id)this.storage?.removeItem(this.runInputKey(nodeId));
      }
    } catch { /* The in-memory draft remains available if browser storage fails. */ }
    this.emit({runInputs});
  }
  private captureExecutionInputs(nodeId:string,selected?:string[]) {
    const ids=new Set([nodeId]),queue=[nodeId];
    for(let i=0;i<queue.length;i++)for(const edge of this.state.graph.edges)if(edge.kind==='execution'&&edge.targetId===queue[i]&&!ids.has(edge.sourceId)){ids.add(edge.sourceId);queue.push(edge.sourceId);}
    return Object.fromEntries([...ids].filter(id=>id!==nodeId&&(!selected||selected.includes(id))&&this.state.runInputs[id]).map(id=>[id,structuredClone(this.state.runInputs[id])]));
  }
  private async acceptExecutionInputs(inputs:EditorState['runInputs']) {
    for(const [id,draft] of Object.entries(inputs))this.acceptedInputs.set(id,draft.id);
    try {await this.refresh();} catch { /* Accepted inputs reconcile on the next authoritative graph. */ }
  }
  async executionPlan(run:Run):Promise<ExecutionPlan> {
    const drafts=this.captureExecutionInputs(run.nodeId);
    const nodeInputDrafts:NodeInputDrafts=Object.fromEntries(Object.entries(drafts).map(([id,draft])=>[id,draft.fields]));
    return this.request('/v1/runs/'+encodeURIComponent(run.id)+'/execution-plan',Object.keys(drafts).length?{nodeInputDrafts}:undefined,Object.keys(drafts).length?'POST':'GET');
  }
  async startExecution(run:Run,body:{nodeIds:string[];expectedExecutionRevision:number;idempotencyKey:string;preserveHistoricalOutputs?:boolean}) {
    const epoch=this.connectionEpoch;
    const drafts=this.captureExecutionInputs(run.nodeId,body.nodeIds);
    await this.flush();this.writable();
    if(epoch!==this.connectionEpoch || Object.entries(drafts).some(([id,draft])=>this.state.runInputs[id]?.id!==draft.id))throw Error(translate('Inputs or the connection changed during preview. Click Run again.'));
    const nodeInputDrafts:NodeInputDrafts=Object.fromEntries(Object.entries(drafts).map(([id,draft])=>[id,draft.fields]));
    const result=await this.request<Run>('/v1/runs/'+encodeURIComponent(run.id)+'/start',{...body,...(Object.keys(drafts).length?{nodeInputDrafts}:{})},'POST');
    if(Object.keys(drafts).length)await this.acceptExecutionInputs(drafts);
    return result;
  }
  async run(nodeId: string, kind: string, selectionOrOverride?: RunSubmissionOptions | ModelSelection, imageRoute?: ImageRoute, preserveHistoricalOutputs?: boolean) {
    const options = selectionOrOverride && typeof selectionOrOverride === 'object' && ['agent', 'modelOverride', 'imageRoute', 'preserveHistoricalOutputs'].some(key => key in selectionOrOverride)
      ? structuredClone(selectionOrOverride as RunSubmissionOptions)
      : structuredClone({ modelOverride: selectionOrOverride, imageRoute, preserveHistoricalOutputs });
    const captured = options as RunSubmissionOptions;
    if (captured.agent && captured.modelOverride) throw Error('Agent selection and legacy modelOverride cannot coexist.');
    if (kind === 'image_generation' && captured.agent) throw Error('Image runs use their existing image route.');
    const { agent, modelOverride } = captured;
    imageRoute = captured.imageRoute;
    preserveHistoricalOutputs = captured.preserveHistoricalOutputs;
    if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
    const epoch = this.connectionEpoch;
    const localInput=this.state.runInputs[nodeId];
    const inputDraft=localInput?structuredClone(localInput.fields):undefined;
    const memberInputs=kind==='execution'?this.captureExecutionInputs(nodeId):{};
    const nodeInputDrafts:NodeInputDrafts=Object.fromEntries(Object.entries(memberInputs).map(([id,draft])=>[id,draft.fields]));
    await this.flush();
    this.writable();
    if (epoch !== this.connectionEpoch)
      throw Error(translate("The connection changed. Click Run again."));
    const g = this.state.graph;
    const node = g.nodes.find(n => n.id === nodeId);
    if (!node || node.readOnly) throw Error(translate('The node does not exist or is read-only.'));
    if (node.type === 'visualize' && kind !== 'visualize_generation') throw Error(translate('Visualization nodes can only submit page generation tasks.'));
    if (kind === 'visualize_generation' && node.type !== 'visualize') throw Error(translate('Page generation requires a visualization node.'));
    if (g.serviceId === 'browser-local' && kind === 'visualize_generation') throw Object.assign(Error(translate('Connect a Workspace and import the temporary Work Graph, then explicitly submit visualization generation.')), { code: 'TEMPORARY_SERVICE_REQUIRED' });
    const visualize = kind === 'visualize_generation';
    const localInputChanged=()=>this.state.runInputs[nodeId]?.id!==localInput?.id || Object.entries(memberInputs).some(([id,draft])=>this.state.runInputs[id]?.id!==draft.id);
    const changed = () => Error(translate("Inputs or the connection changed during preview. Click Run again."));
    for (let attempt = 0; attempt < (visualize ? COMMAND_MAX_ATTEMPTS : 1); attempt++) {
      if (visualize) {
        await this.refresh();
        if (epoch !== this.connectionEpoch || localInputChanged() || this.state.drafts.length || !sameVisualizeGenerationInputs(g, this.state.graph, nodeId)) throw changed();
      }
      this.writable();
      if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
      const current = visualize ? this.state.graph : g;
      const preview = await this.request<{
        canSubmit: boolean;
        issues: { reason: string }[];
      }>(graphPath(current.projectId, current.graphId) + "/input-preview", { nodeId, ...(inputDraft?{inputDraft}:{}), ...(kind==='image_generation' && imageRoute?.type==='api'?{excludeFiles:true}:{}) });
      if (!preview.canSubmit) throw Error(preview.issues.map((i) => i.reason).join("；"));
      if (this.historyLocked || this.historyRequest) throw Error(translate('Retry the pending history operation first.'));
      // Local edits and changed generation inputs always abort this click.
      if (epoch !== this.connectionEpoch || localInputChanged() || this.state.drafts.length || visualize && !sameVisualizeGenerationInputs(g, this.state.graph, nodeId)) throw changed();
      if (this.state.graph.executionRevision !== current.executionRevision) {
        if (visualize && attempt + 1 < COMMAND_MAX_ATTEMPTS) continue;
        throw changed();
      }
      this.writable();
      try {
        const submitted=await this.request<Run>(graphPath(current.projectId, current.graphId) + "/runs", {
          nodeId, kind, idempotencyKey: randomId(), expectedExecutionRevision: current.executionRevision,
          ...(inputDraft?{inputDraft}:{}),
          ...(Object.keys(memberInputs).length?{nodeInputDrafts}:{}),
          ...(agent ? { agent } : modelOverride ? { modelOverride } : {}),
          ...(kind === 'image_generation' && imageRoute ? { imageRoute } : {}),
          ...(kind === 'execution' && preserveHistoricalOutputs !== undefined ? { preserveHistoricalOutputs } : {}),
        });
        if(localInput || Object.keys(memberInputs).length)await this.acceptExecutionInputs({...memberInputs,...(localInput?{[nodeId]:localInput}:{})});
        return submitted;
      } catch (error) {
        // Only a definite revision rejection can start a fresh submission.
        // Unknown results are returned to the caller without another Run.
        if (!visualize || errorCode(error) !== 'REVISION_CONFLICT' || attempt + 1 === COMMAND_MAX_ATTEMPTS) throw error;
      }
    }
    throw changed();
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
