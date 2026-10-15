import type { GraphSnapshot, Json, Node, Run, RunStatus, ServiceEvent, VisualizeBridgeRequest, NodeSignalCause, NodeSignalConnection, NodeSignalMessage, NodeSignalName, NodeSignalRelation } from '../../../packages/protocol/src/index';
import { NODE_SIGNALS, nodeContentSlotMatches, isNodeContentSlot, validateNodeContentSlotParams, VisualizeValidationError, validateNodeSignalCommand, validateNodeSignalCause } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';

type Binding = { nodeId: string; sessionId: string; active(): boolean; send(message: NodeSignalMessage): void; slots: Set<string>; connections: Map<string, NodeSignalConnection>; receipts: Map<string, { payload: string; value: Json }> };
type Event = { id: string; nodeId: string; signal: NodeSignalName; payload: Json; cause: NodeSignalCause; previousRelations?: Map<string, NodeSignalRelation[]> };
type Invocation = { id: string; owner: Binding; receiver: Binding; connection: NodeSignalConnection; targetId: string; event: Event; cause: NodeSignalCause; timer: ReturnType<typeof setTimeout>; claimed: boolean };
const object = (v: Json | undefined): Record<string, Json> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const fail = (message: string): never => { throw new VisualizeValidationError('INPUT_BLOCKED', message); };
function output(node: Node): string {
  const content = object(node.content);
  if (node.type === 'execution') return ''; // Execution output is its published deliveries, not its prompt.
  if (node.type === 'visualize') return JSON.stringify(object(content.form).data ?? null);
  const { title: _title, ...data } = content;
  return JSON.stringify(data);
}

/** Graph-scoped activity sessions. A future residency policy can retain a binding
 * independently of a view; this router does not depend on React or DOM visibility. */
export class NodeSignals {
  private graph?: GraphSnapshot;
  private runs = new Map<string, Run>();
  private runsInitialized = false;
  private bindings = new Map<string, Binding>();
  private pending = new Map<string, Invocation>();
  private writeCauses = new Map<string, { kind: 'form' | 'content'; version: number; cause: NodeSignalCause }>();
  private events: Event[] = [];
  private draining = false;
  private readonly earlyChanges = new Map<string,{nodeId:string;contentVersion:number;revision:number}>();
  bind(nodeId: string, sessionId: string, send: Binding['send'], active: Binding['active']): () => void {
    this.close(nodeId);
    const binding: Binding = { nodeId, sessionId, send, active, slots: new Set(), connections: new Map(), receipts: new Map() };
    this.bindings.set(nodeId, binding);
    return () => { if (this.bindings.get(nodeId) === binding) this.close(nodeId); };
  }
  close(nodeId: string): void {
    const binding = this.bindings.get(nodeId); if (!binding) return;
    this.bindings.delete(nodeId);
    this.events = this.events.filter(event => event.nodeId !== nodeId || !event.signal.startsWith('custom.') && event.signal !== 'inputs.updated' && !event.signal.startsWith('invocation.'));
    for (const job of [...this.pending.values()]) if (job.owner === binding || job.receiver === binding || job.event.nodeId === nodeId) this.remove(job);
    binding.connections.clear(); binding.slots.clear(); binding.receipts.clear();
  }
  dispose(): void { for (const id of [...this.bindings.keys()]) this.close(id); this.events = []; this.writeCauses.clear(); this.earlyChanges.clear(); }
  /** Committed event metadata can deliver signals before any graph snapshot read. */
  observeEvent(event: ServiceEvent): void {
    if (!event || typeof event !== 'object') return;
    const graph = this.graph;
    if (!graph || event.type !== 'graph.changed' || event.serviceId !== graph.serviceId || event.projectId !== graph.projectId || event.graphId !== graph.graphId) return;
    const payload = object(event.payload), revision = payload.executionRevision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < graph.executionRevision || !Array.isArray(payload.nodeChanges) || payload.nodeChanges.length > 1000) return;
    for (const raw of payload.nodeChanges) {
      const change = object(raw), id = change.nodeId, version = change.contentVersion;
      if (typeof id !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof change.outputsChanged !== 'boolean' || (change.formVersion !== undefined && (typeof change.formVersion !== 'number' || !Number.isSafeInteger(change.formVersion) || change.formVersion < 1))) continue;
      let committedCause: NodeSignalCause | undefined;
      if (change.cause !== undefined) {
        try { committedCause = validateNodeSignalCause(change.cause); } catch { continue; }
      }
      const node = graph.nodes.find(node => node.id === id), key = revision + ':' + id + ':' + version;
      if (!node || node.contentVersion === version || this.earlyChanges.has(key)) continue;
      this.earlyChanges.set(key,{nodeId:id,contentVersion:version,revision});
      if (this.earlyChanges.size > 2048) this.earlyChanges.delete(this.earlyChanges.keys().next().value!);
      const write = this.writeCauses.get(id), observed = write?.kind === 'content' ? version : change.formVersion;
      // The transaction associates this cause with the actual committed version,
      // even when SSE arrives before its HTTP receipt or a full graph refresh.
      const cause = committedCause ?? (write && write.version === observed ? write.cause : undefined);
      this.publish(id,'content.changed',{contentVersion:version},cause);
      if (change.outputsChanged) {
        this.publish(id,'outputs.changed',{contentVersion:version},cause);
        if (node.type === 'visualize' && typeof change.formVersion === 'number') this.publish(id,'form.changed',{formVersion:change.formVersion},cause);
        for (const target of this.neighbors(id,'successors')) if (graph.nodes.some(node => node.id === target && node.type === 'visualize')) this.publish(target,'inputs.invalidated',{sourceNodeId:id},cause);
      }
    }
  }
  private neighbors(id: string, direction: 'predecessors' | 'successors', graph = this.graph): string[] {
    return [...new Set(graph?.edges.filter(e => e.kind === 'reference' && (direction === 'predecessors' ? e.targetId : e.sourceId) === id).map(e => direction === 'predecessors' ? e.sourceId : e.targetId) ?? [])];
  }
  private resolve(selector: string, owner: string): string[] {
    if (selector === 'self') return [owner];
    if (selector === 'predecessors' || selector === 'successors') return this.neighbors(owner, selector);
    return this.graph?.nodes.some(n => n.id === selector) ? [selector] : [];
  }
  private relations(owner: string, source: string, graph = this.graph): NodeSignalRelation[] {
    if (owner === source) return ['self'];
    const result: NodeSignalRelation[] = [];
    if (this.neighbors(owner, 'predecessors', graph).includes(source)) result.push('predecessors');
    if (this.neighbors(owner, 'successors', graph).includes(source)) result.push('successors');
    return result;
  }
  private related(owner: string, source: string, graph = this.graph): NodeSignalRelation | undefined {
    return this.relations(owner, source, graph)[0];
  }
  private alive(binding: Binding): boolean { return this.bindings.get(binding.nodeId) === binding && binding.active(); }
  private valid(job: Invocation): boolean {
    const slot = job.connection.target.slot;
    return this.alive(job.owner) && this.alive(job.receiver) && job.owner.connections.get(job.connection.id) === job.connection
      && (job.event.signal === 'removed' || !!this.related(job.owner.nodeId, job.event.nodeId) && this.resolve(job.connection.source.nodeId, job.owner.nodeId).includes(job.event.nodeId))
      && this.resolve(job.connection.target.nodeId, job.owner.nodeId).includes(job.targetId)
      && (job.targetId === job.owner.nodeId || this.neighbors(job.owner.nodeId, 'successors').includes(job.targetId))
      && (!isNodeContentSlot(slot) || !!this.graph?.nodes.some(node => node.id === job.targetId && nodeContentSlotMatches(slot, node)));
  }
  command(nodeId: string, request: Extract<VisualizeBridgeRequest, { method: 'signals' }>): Json {
    const binding = this.bindings.get(nodeId);
    if (!binding || binding.sessionId !== request.sessionId || !this.alive(binding)) fail('节点活动会话已结束或暂停。');
    const b = binding!, command = validateNodeSignalCommand(request.params), payload = JSON.stringify(command);
    const prior = b.receipts.get(request.requestId);
    if (prior) { if (prior.payload !== payload) throw new VisualizeValidationError('IDEMPOTENCY_CONFLICT', '同一请求标识不能使用不同内容。'); return prior.value; }
    let value: Json = null;
    switch (command.action) {
      case 'describe': {
        const nodes = (direction: 'predecessors' | 'successors') => this.neighbors(nodeId, direction).map(id => ({ nodeId: id, type: this.graph!.nodes.find(n => n.id === id)!.type }));
        value = { self: nodeId, predecessors: nodes('predecessors'), successors: nodes('successors'), signals: [...NODE_SIGNALS], slots: ['inputs.refresh', ...b.slots] }; break;
      }
      case 'connect': {
        const c = command.connection;
        if (!['self', 'predecessors', 'successors'].includes(c.source.nodeId) && !this.related(nodeId, c.source.nodeId)) fail('信号来源必须是当前节点或相邻节点。');
        if (!['self', 'successors', nodeId].includes(c.target.nodeId) && !this.neighbors(nodeId, 'successors').includes(c.target.nodeId)) fail('槽目标必须是当前节点或普通后继节点。');
        if (!b.connections.has(c.id) && b.connections.size >= 128) fail('节点连接过多。');
        const existing = b.connections.get(c.id);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(c)) {
          for (const job of [...this.pending.values()]) if (job.owner === b && job.connection.id === c.id) this.remove(job);
          b.connections.set(c.id, structuredClone(c));
        }
        value = { connectionId: c.id }; break;
      }
      case 'disconnect': {
        value = { disconnected: b.connections.delete(command.id) };
        for (const job of [...this.pending.values()]) if (job.owner === b && job.connection.id === command.id) this.remove(job);
        break;
      }
      case 'registerSlot': if (b.slots.size >= 64 && !b.slots.has(command.slot)) fail('节点槽过多。'); b.slots.add(command.slot); break;
      case 'unregisterSlot': b.slots.delete(command.slot); break;
      case 'emit': value = { eventId: this.publish(nodeId, command.signal, command.payload, request.cause) }; break;
      case 'claim': { const job = this.pending.get(command.invocationId); value = !!job && job.receiver === b && !job.claimed && this.valid(job); if (value && job) job.claimed = true; break; }
      case 'result': {
        const job = this.pending.get(command.invocationId);
        if (job && job.receiver === b && job.claimed) {
          this.remove(job);
          if (this.valid(job)) this.publish(job.owner.nodeId, command.ok ? 'invocation.completed' : 'invocation.failed', { invocationId: job.id, connectionId: job.connection.id, targetNodeId: job.targetId, slot: job.connection.target.slot, result: command.value }, job.cause);
        }
        break;
      }
    }
    b.receipts.set(request.requestId, { payload, value });
    if (b.receipts.size > 256) b.receipts.delete(b.receipts.keys().next().value!);
    return value;
  }
  noteWrite(nodeId: string, formVersion: number, cause?: NodeSignalCause): void {
    if (cause) this.writeCauses.set(nodeId, { kind: 'form', version: formVersion, cause }); else this.writeCauses.delete(nodeId);
  }
  noteContentWrite(nodeId: string, contentVersion: number | undefined, cause?: NodeSignalCause): void {
    const observed = this.graph?.nodes.find(node => node.id === nodeId)?.contentVersion ?? 0;
    // Only confirmed receipt versions may back up snapshot-based delivery.
    // Early SSE carries the transaction's cause and never needs a prediction.
    if (cause && contentVersion !== undefined && contentVersion > observed) this.writeCauses.set(nodeId, { kind: 'content', version: contentVersion, cause }); else this.writeCauses.delete(nodeId);
  }
  publish(nodeId: string, signal: NodeSignalName, payload: Json, cause?: NodeSignalCause, previous?: GraphSnapshot): string {
    const id = randomId();
    if (this.events.length >= 512) return id;
    const previousRelations = previous ? new Map([...this.bindings.keys()].flatMap(owner => { const relations = this.relations(owner, nodeId, previous); return relations.length ? [[owner, relations] as const] : []; })) : undefined;
    this.events.push({ id, nodeId, signal, payload, cause: cause ?? { traceId: id, connections: [] }, previousRelations });
    if (!this.draining) { this.draining = true; queueMicrotask(() => this.drain()); }
    return id;
  }
  private drain(): void {
    const events = this.events.splice(0); this.draining = false;
    for (const event of events) for (const owner of [...this.bindings.values()]) {
      if (!this.alive(owner)) continue;
      const currentRelations = this.relations(owner.nodeId, event.nodeId);
      const relations = currentRelations.length ? currentRelations : event.previousRelations?.get(owner.nodeId) ?? [];
      const relation = relations[0];
      const { previousRelations: _previous, ...wire } = event;
      if (relation) owner.send({ channel: 'openworkgraph.node-signals', version: 1, sessionId: owner.sessionId, nodeId: owner.nodeId, type: 'event', event: { ...wire, relation, ...(relations.length > 1 ? { relations } : {}) } });
      for (const connection of owner.connections.values()) {
        const selected = this.resolve(connection.source.nodeId, owner.nodeId).includes(event.nodeId) || event.signal === 'removed' && (connection.source.nodeId === event.nodeId || relations.includes(connection.source.nodeId as NodeSignalRelation));
        if (connection.source.signal !== event.signal || !selected || !relation) continue;
        for (const targetId of this.resolve(connection.target.nodeId, owner.nodeId)) this.invoke(owner, connection, targetId, event);
      }
    }
  }
  private invoke(owner: Binding, connection: NodeSignalConnection, targetId: string, event: Event): void {
    const key = `${owner.nodeId}:${connection.id}:${targetId}`;
    if (event.cause.connections.includes(key) || event.cause.connections.length >= 32) return;
    if (targetId !== owner.nodeId && !this.neighbors(owner.nodeId, 'successors').includes(targetId)) return;
    const target = this.graph?.nodes.find(n => n.id === targetId), slot = connection.target.slot;
    const execution = slot === 'prompt.update' || slot === 'run.submit' || slot === 'run.cancel';
    const content = isNodeContentSlot(slot);
    const hosted = execution || content;
    const receiver = hosted ? owner : this.bindings.get(targetId);
    const cause = { traceId: event.cause.traceId, connections: [...event.cause.connections, key] };
    if (!receiver || !this.alive(receiver) || (content ? !target || !nodeContentSlotMatches(slot, target) : execution ? target?.type !== 'execution' : target?.type !== 'visualize') || (!hosted && slot !== 'inputs.refresh' && !receiver.slots.has(slot))) {
      this.publish(owner.nodeId, 'invocation.failed', { connectionId: connection.id, targetNodeId: targetId, slot, result: { code: 'INPUT_BLOCKED', message: '目标节点槽未处于活动状态。' } }, cause); return;
    }
    if (content) {
      try { validateNodeContentSlotParams(slot, connection.params ?? event.payload); }
      catch { this.publish(owner.nodeId, 'invocation.failed', { connectionId: connection.id, targetNodeId: targetId, slot, result: { code: 'INVALID_REQUEST', message: '内容更新参数与目标节点类型不匹配。' } }, cause); return; }
    }
    if (this.pending.size >= 128) { this.publish(owner.nodeId, 'invocation.failed', { connectionId: connection.id, result: { code: 'INPUT_BLOCKED', message: '待处理的节点动作过多。' } }, cause); return; }
    // At most one not-yet-started refresh per target; the read takes the latest snapshot.
    if (slot === 'inputs.refresh' && [...this.pending.values()].some(job => job.owner === owner && job.connection === connection && job.receiver === receiver && !job.claimed)) return;
    const id = randomId();
    const job: Invocation = { id, owner, receiver, connection, targetId, event, cause, claimed: false, timer: setTimeout(() => {
      if (!this.pending.has(id)) return; this.remove(job);
      if (this.alive(owner)) this.publish(owner.nodeId, 'invocation.failed', { invocationId: id, connectionId: connection.id, result: { code: 'INTERNAL_ERROR', message: '节点动作确认超时。' } }, cause);
    }, 150_000) };
    this.pending.set(id, job);
    receiver.send({ channel: 'openworkgraph.node-signals', version: 1, sessionId: receiver.sessionId, nodeId: receiver.nodeId, type: 'invoke', invocationId: id, targetNodeId: targetId, slot, params: connection.params ?? event.payload, cause });
  }
  private remove(job: Invocation): void { clearTimeout(job.timer); this.pending.delete(job.id); }
  observe(graph: GraphSnapshot, runs?: Run[]): void {
    const before = this.graph;
    if (before && (graph.executionRevision < before.executionRevision || graph.layoutRevision < before.layoutRevision)) return;
    this.graph = structuredClone(graph);
    if (before) {
      for (const [old, next, connected] of [[before, graph, false], [graph, before, true]] as const) {
        for (const edge of old.edges.filter(e => e.kind === 'reference' && !next.edges.some(other => other.id === e.id && other.sourceId === e.sourceId && other.targetId === e.targetId && other.kind === e.kind))) {
          for (const [id, peerId, direction, peerPort] of [[edge.targetId, edge.sourceId, 'input', 'output'], [edge.sourceId, edge.targetId, 'output', 'input']] as const) {
            if (graph.nodes.some(n => n.id === id)) this.publish(id, `connection.${direction}.${connected ? 'connected' : 'disconnected'}`, { connectionId: edge.id, localPortId: direction, peerNodeId: peerId, peerPortId: peerPort, reason: connected ? 'connected' : graph.nodes.some(n => n.id === peerId) ? 'disconnected' : 'node_removed' });
          }
          if (graph.nodes.some(n => n.id === edge.targetId && n.type === 'visualize')) this.publish(edge.targetId, 'inputs.invalidated', { sourceNodeId: edge.sourceId });
        }
      }
      for (const old of before.nodes) {
        const node = graph.nodes.find(n => n.id === old.id);
        if (!node) { this.publish(old.id, 'removed', { nodeId: old.id }, undefined, before); this.close(old.id); this.writeCauses.delete(old.id); continue; }
        if (node.contentVersion === old.contentVersion) continue;
        if ([...this.earlyChanges.values()].some(change => change.nodeId === node.id && change.contentVersion === node.contentVersion && change.revision <= graph.executionRevision)) { this.writeCauses.delete(node.id); continue; }
        const write = this.writeCauses.get(node.id);
        const version = write?.kind === 'content' ? node.contentVersion : Number(object(object(node.content).form).version);
        const cause = write?.version === version ? write.cause : undefined;
        this.publish(node.id, 'content.changed', { contentVersion: node.contentVersion }, cause);
        if (output(node) !== output(old)) {
          this.publish(node.id, 'outputs.changed', { contentVersion: node.contentVersion }, cause);
          if (node.type === 'visualize') this.publish(node.id, 'form.changed', { formVersion: object(object(node.content).form).version ?? null }, cause);
          for (const id of this.neighbors(node.id, 'successors')) if (graph.nodes.some(n => n.id === id && n.type === 'visualize')) this.publish(id, 'inputs.invalidated', { sourceNodeId: node.id }, cause);
        }
        this.writeCauses.delete(node.id);
      }
      const delivered = (snapshot: GraphSnapshot, sourceId: string) => JSON.stringify(snapshot.edges.filter(e => e.kind === 'delivery' && e.sourceId === sourceId).map(e => {
        const node = snapshot.nodes.find(n => n.id === e.targetId); return [e.id, e.targetId, node ? output(node) : null];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      for (const node of graph.nodes.filter(n => n.type === 'execution')) {
        if (delivered(before, node.id) === delivered(graph, node.id)) continue;
        this.publish(node.id, 'outputs.changed', { executionRevision: graph.executionRevision });
        for (const id of this.neighbors(node.id, 'successors')) if (graph.nodes.some(n => n.id === id && n.type === 'visualize')) this.publish(id, 'inputs.invalidated', { sourceNodeId: node.id });
      }
      for (const job of [...this.pending.values()]) if (!this.valid(job)) this.remove(job);
    }
    for (const [key,change] of this.earlyChanges) if (change.revision <= graph.executionRevision) this.earlyChanges.delete(key);
    if (runs) {
      const current = runs.filter(r => r.graphId === graph.graphId && r.projectId === graph.projectId && r.serviceId === graph.serviceId);
      for (const run of current) {
        const prior = this.runs.get(run.id);
        if (!this.runsInitialized || prior?.status === run.status) continue;
        const signals: Partial<Record<RunStatus, NodeSignalName>> = { running: 'run.started', succeeded: 'run.succeeded', failed: 'run.failed', cancelled: 'run.cancelled', interrupted: 'run.failed' };
        const signal = signals[run.status];
        if (signal) this.publish(run.nodeId, signal, { runId: run.id, status: run.status });
      }
      this.runs = new Map(current.map(r => [r.id, r]));
      this.runsInitialized = true;
    }
  }
}
