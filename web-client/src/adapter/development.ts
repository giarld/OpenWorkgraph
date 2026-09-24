import { translate } from "../i18n/translate";
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import { isTerminal } from "../domain/types";
import { fileMime, isTextMime, hasTextContent } from "../domain/file-types";
import type {
  AdapterSnapshot,
  AssetImport,
  AssetPreview,
  AssetRef,
  AssetVersion,
  CreateNodeInput,
  GenerationResult,
  InputSnapshot,
  NodePatch,
  OutputManifest,
  QueueSnapshot,
  Run,
  RunEvent,
  RunEventPayload,
  Scope,
  WorkEdge,
  WorkGraph,
  WorkNode,
  WorkgraphAdapter,
} from "../domain/types";

export interface DevelopmentAdapterOptions {
  seed?: boolean;
  autoAdvance?: boolean;
  delayMs?: number;
  now?: () => number;
  /** Fixture configuration representing service-owned capacity; never a UI setter. */
  serviceCapacities?: Partial<
    Record<"service-local" | "service-studio", number>
  >;
}
export type DemoScenario =
  | "success"
  | "question"
  | "approval"
  | "failure"
  | "cancel";
export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
const fail = (code: string, message: string): never => {
  throw new AdapterError(code, message);
};
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const scopeOf = (value: Scope): Scope => ({
  serviceId: value.serviceId,
  projectId: value.projectId,
  graphId: value.graphId,
});
const assetKey = (ref: AssetRef) =>
  JSON.stringify([ref.serviceId, ref.assetId, ref.versionId]);
const imageData =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#172336"/><circle cx="460" cy="130" r="80" fill="#70e8c4"/><path d="M0 340L180 150L370 400H0Z" fill="#5865ef"/><text x="32" y="55" fill="white" font-family="sans-serif" font-size="24">SIMULATED OUTPUT</text></svg>',
  );

/** In-memory development data only. Snapshots are detached and deeply frozen. */
export class DevelopmentAdapter implements WorkgraphAdapter {
  private state!: AdapterSnapshot;
  private snapshot!: AdapterSnapshot;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: RunEvent) => void>();
  private blobs = new Map<string, Blob>();
  private previewReleases = new Set<() => void>();
  private keys = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seenEvents = new Set<string>();
  private seenInteractions = new Set<string>();
  private lastEvents = new Map<string, RunEvent>();
  private histories = new Map<
    string,
    { undo: WorkGraph[]; redo: WorkGraph[] }
  >();
  private nextId = 0;
  private order = 0;
  private disposed = false;
  private readonly options: DevelopmentAdapterOptions;
  constructor(options: DevelopmentAdapterOptions = {}) {
    for (const capacity of Object.values(options.serviceCapacities ?? {}))
      if (!Number.isSafeInteger(capacity) || capacity! < 1)
        fail("invalid", translate("The Runtime fixture capacity must be a positive integer"));
    this.options = {
      ...options,
      serviceCapacities: { ...options.serviceCapacities },
    };
    this.resetDemo(options.seed !== false);
  }
  private id(prefix: string) {
    return prefix + "-" + ++this.nextId;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private assertAlive() {
    if (this.disposed) fail("disposed", translate("The development adapter has been disposed"));
  }
  private service(id: string) {
    return (
      this.state.services.find((s) => s.id === id) ??
      fail("not_found", translate("Runtime not found"))
    );
  }
  private graph(id: string) {
    return (
      this.state.graphs.find((g) => g.id === id) ??
      fail("not_found", translate("Work Graph not found"))
    );
  }
  private node(graph: WorkGraph, id: string) {
    return (
      graph.nodes.find((n) => n.id === id) ?? fail("not_found", translate("Node not found"))
    );
  }
  private run(id: string) {
    return (
      this.state.runs.find((r) => r.id === id) ??
      fail("not_found", translate("Run not found"))
    );
  }
  private writable(serviceId: string) {
    this.assertAlive();
    if (!this.service(serviceId).connected)
      fail("offline", translate("The simulated Runtime is offline. The cache is read-only and the run status is pending confirmation"));
  }
  private touch(graph: WorkGraph) {
    graph.revision++;
  }
  private history(graphId: string) {
    let history = this.histories.get(graphId);
    if (!history) {
      history = { undo: [], redo: [] };
      this.histories.set(graphId, history);
    }
    return history;
  }
  private recordEdit(graph: WorkGraph) {
    const history = this.history(graph.id);
    history.undo.push(clone(graph));
    if (history.undo.length > 50) history.undo.shift();
    history.redo = [];
  }
  private clearHistory(graphId: string) {
    this.histories.delete(graphId);
  }
  private validateHistory(graph: WorkGraph, target: WorkGraph) {
    for (const edge of graph.edges)
      if (
        edge.kind === "delivery" &&
        target.nodes.some((n) => n.id === edge.target) &&
        !target.edges.some(
          (e) =>
            e.id === edge.id &&
            e.source === edge.source &&
            e.target === edge.target &&
            e.kind === "delivery",
        )
      )
        fail("hard_connection", translate("Undo cannot remove a hard connection while its delivery document still exists"));
    // History must never resurrect a run output, even after an ordinary deletion.
    for (const node of target.nodes)
      if (node.originRunId && !graph.nodes.some((n) => n.id === node.id))
        fail("history_output", translate("Undo cannot recreate run outputs"));
    for (const run of this.state.runs.filter(
      (r) => r.graphId === graph.id && !isTerminal(r.status),
    )) {
      const before = this.node(graph, run.nodeId);
      const after = target.nodes.find((n) => n.id === run.nodeId);
      if (!after) fail("locked", translate("Undo cannot remove a node with an active run"));
      if (run.kind === "execution") {
        const inputs = (g: WorkGraph) =>
          g.edges
            .filter((e) => e.target === run.nodeId)
            .map((e) => [e.id, e.source, e.target]);
        if (
          after!.prompt !== before.prompt ||
          JSON.stringify(inputs(graph)) !== JSON.stringify(inputs(target))
        )
          fail("locked", translate("Undo cannot change a locked prompt or input connection"));
      }
    }
  }
  private canApplyHistory(
    graphId: string,
    direction: "undo" | "redo",
  ): boolean {
    if (this.disposed) return false;
    const graph = this.graph(graphId);
    const target = this.history(graphId)[direction].at(-1);
    if (!target || !this.service(graph.serviceId).connected) return false;
    try {
      this.validateHistory(graph, target);
      return true;
    } catch {
      return false;
    }
  }
  canUndoGraph(graphId: string): boolean {
    return this.canApplyHistory(graphId, "undo");
  }
  canRedoGraph(graphId: string): boolean {
    return this.canApplyHistory(graphId, "redo");
  }
  private applyHistory(graphId: string, direction: "undo" | "redo"): boolean {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const history = this.history(graphId);
    const target = history[direction].at(-1);
    if (!target) return false;
    this.validateHistory(graph, target);
    const restored = clone(target);
    for (const node of restored.nodes) {
      const existing = graph.nodes.find((n) => n.id === node.id);
      // Content revisions are clocks, never historical values. Undo is itself a new edit.
      if (existing) {
        const changed =
          node.content !== existing.content ||
          JSON.stringify(node.assetRef) !== JSON.stringify(existing.assetRef);
        node.contentRevision = changed
          ? Math.max(node.contentRevision, existing.contentRevision) + 1
          : existing.contentRevision;
      }
    }
    const opposite = direction === "undo" ? "redo" : "undo";
    history[direction].pop();
    history[opposite].push(clone(graph));
    if (history[opposite].length > 50) history[opposite].shift();
    graph.nodes = restored.nodes;
    graph.edges = restored.edges;
    graph.name = restored.name;
    this.touch(graph);
    this.publish();
    return true;
  }
  undoGraph(graphId: string): boolean {
    return this.applyHistory(graphId, "undo");
  }
  redoGraph(graphId: string): boolean {
    return this.applyHistory(graphId, "redo");
  }
  private publish(event?: RunEvent) {
    this.state.revision++;
    this.snapshot = freeze(clone(this.state));
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* Observers cannot roll back a committed command. */
      }
    }
    if (event)
      for (const listener of [...this.eventListeners]) {
        try {
          listener(freeze(clone(event)));
        } catch {
          /* Isolate observers. */
        }
      }
  }
  getSnapshot = (): AdapterSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.assertAlive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeEvents = (listener: (event: RunEvent) => void): (() => void) => {
    this.assertAlive();
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };
  selectGraph(graphId: string, serviceId?: string) {
    this.assertAlive();
    const graph = this.graph(graphId);
    if (serviceId && graph.serviceId !== serviceId)
      fail("scope", translate("The Work Graph does not belong to the specified Runtime"));
    if (
      this.state.activeGraphId === graphId &&
      this.state.activeServiceId === graph.serviceId
    )
      return;
    this.state.activeGraphId = graphId;
    this.state.activeServiceId = graph.serviceId;
    this.publish();
  }
  createGraph(serviceId: string, projectId: string, name: string): WorkGraph {
    this.writable(serviceId);
    if (
      !this.state.projects.some(
        (p) => p.serviceId === serviceId && p.id === projectId,
      )
    )
      fail("scope", translate("The project does not belong to the Runtime"));
    if (!name.trim()) fail("invalid", translate("Enter a Work Graph name"));
    const id = this.id("graph");
    const graph: WorkGraph = {
      id,
      graphId: id,
      serviceId,
      projectId,
      name,
      nodes: [],
      edges: [],
      revision: 0,
    };
    this.state.graphs.push(graph);
    this.publish();
    return freeze(clone(graph));
  }
  private newNode(
    graph: WorkGraph,
    input: CreateNodeInput,
    extra: Partial<WorkNode> = {},
  ): WorkNode {
    const id = this.id("node");
    const names: Record<string, string> = {
      text: translate("Text"),
      image: translate("Image"),
      document: translate("Document"),
      video: translate("Video"),
      execution: translate("Execution task"),
    };
    return {
      ...scopeOf(graph),
      id,
      nodeId: id,
      type: input.type,
      title: input.title ?? names[input.type] ?? translate("Extension node"),
      x: input.x ?? 100,
      y: input.y ?? 100,
      width: input.width ?? (input.type === "video" ? 420 : 340),
      height:
        input.height ??
        (input.type === "video"
          ? 236
          : input.type === "audio"
            ? 120
            : input.type === "execution"
              ? 360
              : 240),
      content: input.content ?? "",
      prompt: input.prompt ?? "",
      summary: input.summary ?? "",
      readonly: false,
      contentRevision: 1,
      ...(input.assetRef ? { assetRef: clone(input.assetRef) } : {}),
      ...extra,
    };
  }
  private validatePatch(graph: WorkGraph, patch: NodePatch) {
    for (const field of ["x", "y", "width", "height"] as const)
      if (
        patch[field] !== undefined &&
        (!Number.isFinite(patch[field]) ||
          ((field === "width" || field === "height") && patch[field]! <= 0))
      )
        fail("invalid", translate("Node layout values must be valid numbers"));
    if (patch.assetRef) {
      const asset = this.readAsset(patch.assetRef);
      if (
        asset.serviceId !== graph.serviceId ||
        asset.projectId !== graph.projectId
      )
        fail("scope", translate("The asset must belong to the current Runtime and project"));
    }
  }
  createNode(graphId: string, input: CreateNodeInput): WorkNode {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    this.validatePatch(graph, input);
    if (input.type === "group") fail("invalid_group", translate("Select members before creating a group"));
    const node = this.newNode(graph, input);
    this.recordEdit(graph);
    graph.nodes.push(node);
    this.touch(graph);
    this.publish();
    return freeze(clone(node));
  }
  /** Development-only stress fixture: one edit, one notification, no execution. */
  createDemoNodes(graphId: string, count = 200): WorkNode[] {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    if (!Number.isSafeInteger(count) || count < 1 || count > 2000)
      fail("invalid", translate("The number of demo nodes must be an integer from 1 to 2000"));
    const startY = Math.max(0, ...graph.nodes.map((n) => n.y + n.height)) + 100;
    const nodes = Array.from({ length: count }, (_, index) =>
      this.newNode(graph, {
        type: "text",
        title: translate("Performance sample ") + (index + 1),
        content: translate("Development test node for checking pan, zoom, and scrolling."),
        x: 80 + (index % 10) * 380,
        y: startY + Math.floor(index / 10) * 280,
      }),
    );
    this.recordEdit(graph);
    graph.nodes.push(...nodes);
    this.touch(graph);
    this.publish();
    return freeze(clone(nodes));
  }
  moveNodes(
    graphId: string,
    moves: Array<{ id: string; x: number; y: number }>,
  ) {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const ids = new Set<string>();
    for (const move of moves) {
      this.node(graph, move.id);
      if (ids.has(move.id)) fail("invalid", translate("The batch move contains duplicate nodes"));
      if (!Number.isFinite(move.x) || !Number.isFinite(move.y))
        fail("invalid", translate("Node layout values must be valid numbers"));
      ids.add(move.id);
    }
    const staged = clone(graph);
    const byId = new Map(staged.nodes.map((node) => [node.id, node]));
    const members = new Set<string>();
    for (const move of moves) {
      const node = byId.get(move.id)!;
      if (node.type !== "group") continue;
      const dx = move.x - node.x,
        dy = move.y - node.y;
      for (const id of node.memberIds ?? []) {
        const member = byId.get(id) ?? fail("not_found", translate("Group member not found"));
        member.x += dx;
        member.y += dy;
        members.add(id);
      }
      node.x = move.x;
      node.y = move.y;
    }
    for (const move of moves) {
      const node = byId.get(move.id)!;
      if (node.type !== "group" && !members.has(node.id)) {
        node.x = move.x;
        node.y = move.y;
      }
    }
    for (const group of staged.nodes.filter((node) => node.type === "group"))
      if (!ids.has(group.id) && group.memberIds?.some((id) => ids.has(id)))
        Object.assign(group, this.groupBounds(staged, group.memberIds));
    // Derived member coordinates and group bounds must also be valid before recording history.
    for (const node of staged.nodes) this.validatePatch(graph, node);
    if (
      staged.nodes.every((node, index) => {
        const old = graph.nodes[index]!;
        return (
          node.x === old.x &&
          node.y === old.y &&
          node.width === old.width &&
          node.height === old.height
        );
      })
    )
      return;
    this.recordEdit(graph);
    graph.nodes = staged.nodes;
    this.touch(graph);
    this.publish();
  }
  updateNode(graphId: string, nodeId: string, patch: NodePatch) {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const node = this.node(graph, nodeId);
    this.validatePatch(graph, patch);
    if (
      node.type === "group" &&
      (patch.content !== undefined ||
        patch.prompt !== undefined ||
        patch.assetRef !== undefined)
    )
      fail("invalid_group", translate("Groups only support layout and title edits"));
    if (
      patch.prompt !== undefined &&
      node.type === "execution" &&
      this.isNodeLocked(graphId, nodeId)
    )
      fail("locked", translate("The prompt cannot be changed while a run is active"));
    if (
      node.readonly &&
      (patch.content !== undefined || patch.assetRef !== undefined)
    )
      fail("readonly", translate("The original delivery is read-only. Make a copy to edit it"));
    const editedRef = patch.assetRef ?? node.assetRef;
    if (
      patch.content !== undefined &&
      editedRef &&
      (node.type === "text" || node.type === "document")
    ) {
      const asset = this.readAsset(editedRef);
      if (!hasTextContent(asset))
        fail("unsupported_input", translate("The attachment has no editable text representation"));
    }
    const contentChanged =
      patch.content !== undefined || patch.assetRef !== undefined;
    const safe: NodePatch = {};
    for (const key of [
      "title",
      "x",
      "y",
      "width",
      "height",
      "content",
      "prompt",
      "summary",
      "assetRef",
    ] as const)
      if (patch[key] !== undefined)
        Object.assign(safe, { [key]: clone(patch[key]) });
    // A reference-only replacement must display the same immutable body used by execution.
    if (
      patch.assetRef &&
      patch.content === undefined &&
      (node.type === "text" || node.type === "document")
    )
      safe.content = this.readAsset(patch.assetRef).text ?? "";
    const dx = (safe.x ?? node.x) - node.x;
    const dy = (safe.y ?? node.y) - node.y;
    this.recordEdit(graph);
    Object.assign(node, safe);
    if (node.type === "group") {
      // Corner resize can change x/y as well: only a pure translation moves children.
      if (patch.width === undefined && patch.height === undefined)
        for (const memberId of node.memberIds ?? []) {
          const member = this.node(graph, memberId);
          member.x += dx;
          member.y += dy;
        }
    } else if (
      patch.x !== undefined ||
      patch.y !== undefined ||
      patch.width !== undefined ||
      patch.height !== undefined
    ) {
      for (const group of graph.nodes.filter(
        (n) => n.type === "group" && n.memberIds?.includes(nodeId),
      ))
        Object.assign(group, this.groupBounds(graph, group.memberIds!));
    }
    if (contentChanged) {
      node.contentRevision++;
      if (
        patch.content !== undefined &&
        node.assetRef &&
        (node.type === "document" || node.type === "text")
      )
        node.assetRef = this.ref(
          this.saveAssetInternal(node.assetRef, patch.content),
        );
    }
    this.touch(graph);
    this.publish();
  }
  isNodeLocked(graphId: string, nodeId: string): boolean {
    return this.state.runs.some(
      (r) =>
        r.graphId === graphId &&
        r.nodeId === nodeId &&
        r.kind === "execution" &&
        !isTerminal(r.status),
    );
  }
  deleteNodes(graphId: string, nodeIds: string[]) {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const ids = new Set(nodeIds);
    if (
      graph.edges.some(
        (edge) =>
          edge.kind === "delivery" &&
          ids.has(edge.source) &&
          !ids.has(edge.target),
      )
    )
      fail(
        "hard_connection",
        translate("Delete the delivery document first, or delete it together with the execution node"),
      );
    for (const id of ids) {
      this.node(graph, id);
      if (
        this.state.runs.some(
          (r) =>
            r.graphId === graphId && r.nodeId === id && !isTerminal(r.status),
        )
      )
        fail("locked", translate("A run node can only be deleted after it reaches a terminal state"));
    }
    for (const edge of graph.edges)
      if (
        (ids.has(edge.source) || ids.has(edge.target)) &&
        this.isNodeLocked(graphId, edge.target)
      )
        fail("locked", translate("Deleting the predecessor would remove a locked input connection"));
    this.recordEdit(graph);
    graph.nodes = graph.nodes.filter((n) => !ids.has(n.id));
    graph.edges = graph.edges.filter(
      (e) => !ids.has(e.source) && !ids.has(e.target),
    );
    for (const group of graph.nodes.filter((n) => n.type === "group")) {
      group.memberIds = (group.memberIds ?? []).filter((id) => !ids.has(id));
      if (group.memberIds.length)
        Object.assign(group, this.groupBounds(graph, group.memberIds));
    }
    this.touch(graph);
    this.publish();
  }
  connect(graphId: string, source: string, target: string): WorkEdge {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const from = this.node(graph, source);
    const to = this.node(graph, target);
    const executionChain = from.type === "execution" && to.type === "execution";
    if (
      (!executionChain && ["execution", "group"].includes(from.type)) ||
      !["execution", "text", "image"].includes(to.type) ||
      source === target
    )
      fail(
        "invalid_edge",
        translate("Content nodes can connect to execution, text, or image nodes. Sequence edges can only connect execution nodes"),
      );
    if (this.isNodeLocked(graphId, target))
      fail("locked", translate("Input connections cannot be changed while a run is active"));
    if (executionChain) {
      if (!executionOrder([...graph.edges.map(e => ({sourceId:e.source, targetId:e.target, kind:e.kind})), {sourceId:source, targetId:target, kind:'execution'}])) fail('invalid_edge', translate("Cannot create the sequence edge because it would form a cycle"));
    }
    const existing = graph.edges.find(
      (e) => e.source === source && e.target === target,
    );
    if (existing) return freeze(clone(existing));
    const edge = { ...scopeOf(graph), id: this.id("edge"), source, target, ...(executionChain ? { kind: "execution" as const } : {}) };
    this.recordEdit(graph);
    graph.edges.push(edge);
    this.touch(graph);
    this.publish();
    return freeze(clone(edge));
  }
  disconnect(graphId: string, edgeId: string) {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const edge =
      graph.edges.find((e) => e.id === edgeId) ??
      fail("not_found", translate("Connection not found"));
    if (edge.kind === "delivery")
      fail(
        "hard_connection",
        translate("An execution node and its delivery document have a hard connection that is removed only when the delivery document is deleted"),
      );
    if (this.isNodeLocked(graphId, edge.target))
      fail("locked", translate("Input connections cannot be changed while a run is active"));
    this.recordEdit(graph);
    graph.edges = graph.edges.filter((e) => e.id !== edgeId);
    this.touch(graph);
    this.publish();
  }
  private copyContent(graph: WorkGraph, original: WorkNode): WorkNode {
    const copy = this.newNode(
      graph,
      {
        ...original,
        title: original.title + translate(" Copy"),
        x: original.x + 40,
        y: original.y + 40,
      },
      { copiedFromNodeId: original.id },
    );
    if (original.assetRef) {
      const asset = this.readAsset(original.assetRef);
      const saved = this.addAsset(
        graph.serviceId,
        graph.projectId,
        {
          name: asset.name,
          mimeType: asset.mimeType,
          data: this.blobs.get(assetKey(asset))!,
        },
        asset.text,
      );
      copy.assetRef = this.ref(saved);
    }
    return copy;
  }
  copyNode(graphId: string, nodeId: string): WorkNode {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const original = this.node(graph, nodeId);
    if (original.type === "group") {
      // Clipboard selection is explicit: copying a wrapper does not copy hidden/unselected children.
      const group = this.newNode(
        graph,
        {
          ...original,
          x: original.x + 40,
          y: original.y + 40,
          title: original.title + translate(" Copy"),
        },
        { copiedFromNodeId: original.id, memberIds: [] },
      );
      this.recordEdit(graph);
      graph.nodes.push(group);
      this.touch(graph);
      this.publish();
      return freeze(clone(group));
    }
    const copy = this.copyContent(graph, original);
    this.recordEdit(graph);
    graph.nodes.push(copy);
    this.touch(graph);
    this.publish();
    return freeze(clone(copy));
  }
  /** Paste detached clipboard data, never reread its source nodes. Position is the selection's center. */
  pasteNodes(
    graphId: string,
    nodes: WorkNode[],
    edges: WorkEdge[],
    position: { x: number; y: number },
  ): WorkNode[] {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    this.validatePatch(graph, position);
    if (!nodes.length) return [];
    const originals = clone(nodes);
    const sourceEdges = clone(edges);
    const byId = new Map<string, WorkNode>();
    // Validate the whole clipboard before allocating assets, changing history, or publishing.
    for (const node of originals) {
      if (
        node.serviceId !== graph.serviceId ||
        node.projectId !== graph.projectId
      )
        fail("scope", translate("Clipboard nodes must belong to the current Runtime and project"));
      if (!node.id || node.id !== node.nodeId || byId.has(node.id))
        fail("invalid_clipboard", translate("Clipboard node identities are duplicated or inconsistent"));
      this.validatePatch(graph, node);
      byId.set(node.id, node);
      if (node.assetRef && !this.blobs.has(assetKey(node.assetRef)))
        fail("missing_asset", translate("The clipboard asset version has no content"));
    }
    const memberships = new Map<string, string[]>();
    const ownedMembers = new Set<string>();
    for (const group of originals.filter((node) => node.type === "group")) {
      const memberIds = [...new Set(group.memberIds ?? [])].filter((id) =>
        byId.has(id),
      );
      for (const id of memberIds) {
        if (byId.get(id)!.type === "group" || ownedMembers.has(id))
          fail("invalid_group", translate("The clipboard does not support nested or overlapping groups"));
        ownedMembers.add(id);
      }
      memberships.set(group.id, memberIds);
    }
    const includedEdges: WorkEdge[] = [];
    const pairs = new Set<string>();
    for (const edge of sourceEdges) {
      if (
        edge.serviceId !== graph.serviceId ||
        edge.projectId !== graph.projectId
      )
        fail("scope", translate("Clipboard connections must belong to the current Runtime and project"));
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (
        !source ||
        !target ||
        edge.kind === "delivery" ||
        edge.source === edge.target ||
        (edge.kind === "execution" ? source.type !== "execution" || target.type !== "execution" : ["execution", "group"].includes(source.type)) ||
        !["execution", "text", "image"].includes(target.type)
      )
        continue;
      if (edge.graphId !== source.graphId || edge.graphId !== target.graphId)
        fail("scope", translate("A clipboard connection and its endpoints come from different Work Graphs"));
      const pair = JSON.stringify([edge.source, edge.target]);
      if (!pairs.has(pair)) {
        pairs.add(pair);
        includedEdges.push(edge);
      }
    }
    if (!executionOrder(includedEdges.map(e => ({sourceId:e.source, targetId:e.target, kind:e.kind})))) fail('invalid_edge', translate("Sequence edges cannot form a cycle"));
    const bounds = originals.reduce(
      (box, node) => ({
        left: Math.min(box.left, node.x),
        top: Math.min(box.top, node.y),
        right: Math.max(box.right, node.x + node.width),
        bottom: Math.max(box.bottom, node.y + node.height),
      }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const dx = position.x - (bounds.left + bounds.right) / 2;
    const dy = position.y - (bounds.top + bounds.bottom) / 2;
    const stagedAssets: Array<{ asset: AssetVersion; blob: Blob }> = [];
    const copies = originals.map((original) => {
      const translated = {
        ...original,
        x: original.x + dx,
        y: original.y + dy,
      };
      this.validatePatch(graph, translated);
      const copy = this.newNode(graph, translated, {
        copiedFromNodeId: original.id,
      });
      if (original.assetRef) {
        const source = this.readAsset(original.assetRef);
        const blob = this.blobs
          .get(assetKey(source))!
          .slice(0, source.size, source.mimeType);
        const asset: AssetVersion = {
          ...source,
          serviceId: graph.serviceId,
          projectId: graph.projectId,
          assetId: this.id("asset"),
          versionId: this.id("version"),
          createdAt: this.now(),
        };
        stagedAssets.push({ asset, blob });
        copy.assetRef = this.ref(asset);
      }
      return copy;
    });
    const mapping = new Map(
      originals.map((node, index) => [node.id, copies[index]!.id]),
    );
    copies.forEach((copy, index) => {
      if (copy.type === "group")
        copy.memberIds = memberships
          .get(originals[index]!.id)!
          .map((id) => mapping.get(id)!);
    });
    const copiedEdges = includedEdges.map((edge) => ({
      ...scopeOf(graph),
      id: this.id("edge"),
      source: mapping.get(edge.source)!,
      target: mapping.get(edge.target)!,
      ...(edge.kind === "execution" ? {kind: "execution" as const} : {}),
    }));
    this.recordEdit(graph);
    for (const { asset, blob } of stagedAssets) {
      this.state.assets.push(asset);
      this.blobs.set(assetKey(asset), blob);
    }
    graph.nodes.push(...copies);
    graph.edges.push(...copiedEdges);
    this.touch(graph);
    this.publish();
    return freeze(clone(copies));
  }

  private groupBounds(
    graph: WorkGraph,
    nodeIds: string[],
  ): Pick<WorkNode, "x" | "y" | "width" | "height"> {
    const nodes = nodeIds.map((id) => this.node(graph, id));
    const left = Math.min(...nodes.map((n) => n.x));
    const top = Math.min(...nodes.map((n) => n.y));
    return {
      x: left - 24,
      y: top - 48,
      width: Math.max(...nodes.map((n) => n.x + n.width)) - left + 48,
      height: Math.max(...nodes.map((n) => n.y + n.height)) - top + 72,
    };
  }
  groupNodes(graphId: string, nodeIds: string[]): WorkNode {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const ids = [...new Set(nodeIds)];
    if (ids.length < 2) fail("invalid_group", translate("Select at least two nodes"));
    for (const id of ids) {
      if (
        this.node(graph, id).type === "group" ||
        graph.nodes.some((n) => n.type === "group" && n.memberIds?.includes(id))
      )
        fail("invalid_group", translate("Nested or overlapping groups are not supported. Ungroup the existing group first"));
    }
    const group = this.newNode(
      graph,
      { type: "group", title: translate("Group"), ...this.groupBounds(graph, ids) },
      { memberIds: ids },
    );
    this.recordEdit(graph);
    graph.nodes.push(group);
    this.touch(graph);
    this.publish();
    return freeze(clone(group));
  }
  ungroupNodes(graphId: string, groupIds: string[]): void {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    for (const id of groupIds)
      if (this.node(graph, id).type !== "group")
        fail("invalid_group", translate("Select a group node"));
    // Removing the spatial wrapper preserves members, their references and runs.
    this.deleteNodes(graphId, groupIds);
  }
  /** Clipboard can attach only explicitly copied members after remapping their node IDs. */
  setGroupMembers(graphId: string, groupId: string, memberIds: string[]): void {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const group = this.node(graph, groupId);
    if (group.type !== "group") fail("invalid_group", translate("Select a group node"));
    const ids = [...new Set(memberIds)];
    for (const id of ids)
      if (
        this.node(graph, id).type === "group" ||
        graph.nodes.some(
          (n) =>
            n.id !== groupId && n.type === "group" && n.memberIds?.includes(id),
        )
      )
        fail("invalid_group", translate("Nested or overlapping groups are not supported"));
    this.recordEdit(graph);
    group.memberIds = ids;
    this.touch(graph);
    this.publish();
  }
  getReferences(graphId: string, nodeId: string): InputSnapshot["inputs"] {
    const graph = this.graph(graphId);
    const node = this.node(graph, nodeId);
    if (!["execution", "text", "image"].includes(node.type)) return [];
    return freeze(
      graph.edges
        .filter((e) => e.target === nodeId && e.kind !== "execution")
        .map((e) => {
          const input = this.node(graph, e.source);
          if (input.type === "execution")
            fail("invalid_edge", translate("Execution nodes cannot be used as inputs"));
          const asset = input.assetRef
            ? this.readAsset(input.assetRef)
            : undefined;
          return {
            nodeId: input.id,
            type: input.type,
            title: input.title,
            content:
              (input.type === "document" || input.type === "text") &&
              asset?.text !== undefined
                ? asset.text
                : input.content,
            contentRevision: input.contentRevision,
            ...(input.assetRef ? { assetRef: clone(input.assetRef) } : {}),
          };
        }),
    );
  }
  hasInputChanges(runId: string) {
    const run = this.run(runId);
    const graph = this.graph(run.graphId);
    const node = graph.nodes.find((n) => n.id === run.nodeId);
    if (!node) return true;
    return (
      JSON.stringify(run.inputSnapshot) !==
      JSON.stringify({
        prompt: node.prompt,
        inputs: this.getReferences(run.graphId, run.nodeId),
      })
    );
  }
  private validateInputs(inputs: InputSnapshot["inputs"]) {
    for (const input of inputs) {
      if (!["text", "image", "document", "video"].includes(input.type))
        fail("unsupported_input", translate("The extension node has no executable resource representation"));
      if (input.type === "video")
        fail("unsupported_input", translate("Video is preview-only and has no executable representation"));
      if (input.type === "image" && !input.assetRef)
        fail("missing_asset", translate("The image has no available asset"));
      if (
        input.type === "document" &&
        input.assetRef &&
        this.readAsset(input.assetRef).text === undefined
      )
        fail("unsupported_input", translate("The attachment has no usable text representation"));
    }
  }
  submitRun(graphId: string, nodeId: string, idempotencyKey?: string): Run {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const node = this.node(graph, nodeId);
    const key = idempotencyKey
      ? JSON.stringify([graph.serviceId, idempotencyKey])
      : undefined;
    if (key && this.keys.has(key)) {
      const old = this.run(this.keys.get(key)!);
      if (old.graphId !== graphId || old.nodeId !== nodeId)
        fail("idempotency_conflict", translate("The idempotency key is already used by another task"));
      return freeze(clone(old));
    }
    if (node.type !== "execution") fail("invalid", translate("Select an execution node"));
    if (!node.prompt.trim()) fail("empty_prompt", translate("Enter a prompt"));
    if (this.isNodeLocked(graphId, nodeId))
      fail("locked", translate("This node already has an active run"));
    const inputs = this.getReferences(graphId, nodeId);
    this.validateInputs(inputs);
    this.clearHistory(graphId);
    const run = this.makeRun(graph, node, "execution", {
      prompt: node.prompt,
      inputs,
    });
    if (key) this.keys.set(key, run.id);
    this.schedule();
    this.publish();
    return freeze(clone(run));
  }
  private makeRun(
    graph: WorkGraph,
    node: WorkNode,
    kind: Run["kind"],
    input: InputSnapshot,
  ): Run {
    const id = this.id("run");
    const run: Run = {
      ...scopeOf(graph),
      id,
      runId: id,
      nodeId: node.id,
      kind,
      status: "queued",
      sequence: ++this.order,
      lastEventSequence: 0,
      inputSnapshot: clone(input),
      createdAt: this.now(),
      summaries: [translate("The simulated task was accepted and is waiting for a project execution slot")],
      outputNodeIds: [],
      cancelRequested: false,
      occupiesSlot: false,
    };
    this.state.runs.push(run);
    return run;
  }
  private schedule() {
    for (const service of this.state.services) {
      if (!service.connected) continue;
      const live = this.state.runs.filter(
        (r) => r.serviceId === service.id && !isTerminal(r.status),
      );
      const occupied = live.filter((r) => r.occupiesSlot);
      const busy = new Set(occupied.map((r) => r.projectId));
      let available = service.capacity - occupied.length;
      const heads = new Set<string>();
      for (const run of live.sort((a, b) => a.sequence - b.sequence)) {
        if (run.occupiesSlot || heads.has(run.projectId)) continue;
        heads.add(run.projectId);
        if (
          available <= 0 ||
          busy.has(run.projectId) ||
          run.cancelRequested ||
          run.status !== "queued"
        )
          continue;
        run.occupiesSlot = true;
        run.status = "running";
        run.summaries.push(translate("Simulation: checking previous execution progress"), translate("Simulation: started processing the task"));
        busy.add(run.projectId);
        available--;
        this.arm(run);
      }
    }
  }
  private arm(run: Run) {
    if (
      !this.options.autoAdvance ||
      this.timers.has(run.id) ||
      run.status !== "running"
    )
      return;
    const timer = setTimeout(() => {
      this.timers.delete(run.id);
      if (
        !this.disposed &&
        this.service(run.serviceId).connected &&
        !isTerminal(run.status)
      )
        this.advanceRun(run.id);
    }, this.options.delayMs ?? 1600);
    this.timers.set(run.id, timer);
  }
  cancelRun(runId: string) {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (
      isTerminal(run.status) ||
      run.cancelRequested ||
      run.status === "finalizing"
    )
      return;
    run.cancelRequested = true;
    if (run.occupiesSlot) run.status = "cancelling";
    run.summaries.push(
      run.occupiesSlot
        ? translate("Stop requested. Waiting for confirmation from the simulated Runtime")
        : translate("Queue cancellation requested. Waiting for confirmation from the simulated Runtime"),
    );
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
    this.publish();
  }
  acknowledgeCancellation(runId: string) {
    const run = this.run(runId);
    if (!run.cancelRequested || isTerminal(run.status)) return false;
    return this.emit(run, { type: "cancelled" });
  }
  answerInput(runId: string, interactionId: string, answer: string) {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (
      run.status !== "waiting_input" ||
      run.question?.id !== interactionId ||
      !answer.trim()
    )
      fail("stale_interaction", translate("The question has expired or the answer is empty"));
    run.question!.response = answer;
    run.status = "running";
    run.summaries.push(translate("Answer received: ") + answer);
    this.arm(run);
    this.publish();
  }
  decideApproval(runId: string, interactionId: string, approved: boolean) {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (run.status !== "waiting_approval" || run.approval?.id !== interactionId)
      fail("stale_interaction", translate("The approval has expired"));
    run.approval!.response = approved ? "approved" : "rejected";
    if (!approved) {
      this.emit(run, { type: "failed", reason: translate("The user rejected the simulated approval") });
      return;
    }
    run.status = "running";
    run.summaries.push(translate("The simulated approval was granted"));
    this.arm(run);
    this.publish();
  }
  getQueue(serviceId: string): QueueSnapshot {
    const service = this.service(serviceId);
    const runs = this.state.runs
      .filter((r) => r.serviceId === serviceId && !isTerminal(r.status))
      .sort((a, b) => a.sequence - b.sequence);
    return freeze(
      clone({
        serviceId,
        capacity: service.capacity,
        occupied: runs.filter((r) => r.occupiesSlot).length,
        connected: service.connected,
        stale: !service.connected,
        runs,
      }),
    );
  }
  locateRun(runId: string): (Scope & { nodeId: string }) | undefined {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) return undefined;
    const graph = this.state.graphs.find(
      (g) =>
        g.id === run.graphId &&
        g.serviceId === run.serviceId &&
        g.projectId === run.projectId,
    );
    return graph?.nodes.some((n) => n.id === run.nodeId)
      ? { ...scopeOf(run), nodeId: run.nodeId }
      : undefined;
  }
  setConnected(serviceId: string, connected: boolean) {
    this.assertAlive();
    const service = this.service(serviceId);
    if (service.connected === connected) return;
    service.connected = connected;
    if (connected) {
      this.schedule();
      for (const run of this.state.runs.filter(
        (r) => r.serviceId === serviceId,
      ))
        this.arm(run);
    }
    this.publish();
  }
  private ref(asset: AssetVersion): AssetRef {
    return {
      serviceId: asset.serviceId,
      assetId: asset.assetId,
      versionId: asset.versionId,
    };
  }
  private addAsset(
    serviceId: string,
    projectId: string,
    input: AssetImport,
    text?: string,
    assetId?: string,
  ): AssetVersion {
    const blob =
      typeof input.data === "string"
        ? new Blob([input.data], { type: input.mimeType })
        : input.data.slice(0, input.data.size, input.mimeType);
    const asset: AssetVersion = {
      serviceId,
      projectId,
      assetId: assetId ?? this.id("asset"),
      versionId: this.id("version"),
      name: input.name,
      mimeType: input.mimeType,
      size: blob.size,
      createdAt: this.now(),
      ...(text !== undefined ? { text } : {}),
    };
    this.state.assets.push(asset);
    this.blobs.set(assetKey(asset), blob);
    return asset;
  }
  async importAsset(
    serviceId: string,
    projectId: string,
    input: AssetImport,
  ): Promise<AssetVersion> {
    this.writable(serviceId);
    if (
      !this.state.projects.some(
        (p) => p.id === projectId && p.serviceId === serviceId,
      )
    )
      fail("scope", translate("The asset project does not exist"));
    const epoch = this.state;
    const mimeType = fileMime({ name: input.name, type: input.mimeType });
    const textual = isTextMime(mimeType);
    const text = textual
      ? typeof input.data === "string"
        ? input.data
        : await input.data.text()
      : undefined;
    this.writable(serviceId);
    if (epoch !== this.state) fail("stale_import", translate("The fixture was reset. Ignoring the late import"));
    const asset = this.addAsset(
      serviceId,
      projectId,
      { ...input, mimeType },
      text,
    );
    this.publish();
    return freeze(clone(asset));
  }
  readAsset(ref: AssetRef): AssetVersion {
    return freeze(
      clone(
        this.state.assets.find((a) => assetKey(a) === assetKey(ref)) ??
          fail("missing_asset", translate("The specified asset version was not found")),
      ),
    );
  }
  private saveAssetInternal(ref: AssetRef, content: string): AssetVersion {
    const old = this.readAsset(ref);
    return this.addAsset(
      old.serviceId,
      old.projectId,
      { name: old.name, mimeType: old.mimeType, data: content },
      content,
      old.assetId,
    );
  }
  saveAsset(ref: AssetRef, content: string): AssetVersion {
    this.writable(ref.serviceId);
    const old = this.readAsset(ref);
    if (!hasTextContent(old)) fail("invalid", translate("A binary asset cannot be saved as text"));
    const asset = this.saveAssetInternal(ref, content);
    this.publish();
    return freeze(clone(asset));
  }
  acquireAssetPreview(ref: AssetRef): AssetPreview {
    this.assertAlive();
    this.readAsset(ref);
    const blob =
      this.blobs.get(assetKey(ref)) ??
      fail("missing_asset", translate("The asset version has no content"));
    const url = URL.createObjectURL(blob);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
      this.previewReleases.delete(release);
    };
    this.previewReleases.add(release);
    return { url, release };
  }
  placeAsset(
    graphId: string,
    ref: AssetRef,
    position?: { x: number; y: number },
  ): WorkNode {
    const graph = this.graph(graphId);
    const asset = this.readAsset(ref);
    if (
      graph.serviceId !== asset.serviceId ||
      graph.projectId !== asset.projectId
    )
      fail("scope", translate("Import the asset into the target project first"));
    const type = asset.mimeType.startsWith("image/")
      ? "image"
      : asset.mimeType.startsWith("video/")
        ? "video"
        : asset.mimeType.startsWith("audio/")
          ? "audio"
          : "document";
    return this.createNode(graphId, {
      type,
      title: asset.name,
      assetRef: ref,
      content: asset.text ?? "",
      ...position,
    });
  }
  generate(graphId: string, nodeId: string, prompt: string): Run {
    const graph = this.graph(graphId);
    this.writable(graph.serviceId);
    const node = this.node(graph, nodeId);
    if (
      !["text", "image"].includes(node.type) ||
      node.readonly ||
      !prompt.trim()
    )
      fail("invalid", translate("Text or image generation requires an editable node and a non-empty prompt"));
    if (
      this.state.runs.some(
        (r) =>
          r.nodeId === nodeId && r.graphId === graphId && !isTerminal(r.status),
      )
    )
      fail("locked", translate("The node already has a generation task"));
    const inputs = this.getReferences(graphId, nodeId);
    this.validateInputs(inputs);
    this.clearHistory(graphId);
    const run = this.makeRun(graph, node, "generation", { prompt, inputs });
    run.generationRevision = node.contentRevision;
    this.schedule();
    this.publish();
    return freeze(clone(run));
  }
  private applyGenerated(run: Run, result: GenerationResult) {
    const graph = this.graph(run.graphId);
    this.clearHistory(graph.id);
    const node = this.node(graph, run.nodeId);
    node.content = result.content;
    if (result.assetRef) node.assetRef = clone(result.assetRef);
    else if (node.type === "text" && node.assetRef)
      node.assetRef = this.ref(
        this.saveAssetInternal(node.assetRef, result.content),
      );
    node.contentRevision++;
    this.touch(graph);
  }
  applyGenerationCandidate(runId: string) {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (!run.candidate) fail("not_found", translate("There is no generation candidate to apply"));
    const node = this.node(this.graph(run.graphId), run.nodeId);
    if (node.readonly) fail("readonly", translate("The node is not editable"));
    if (
      this.state.runs.some(
        (r) =>
          r.nodeId === run.nodeId &&
          r.graphId === run.graphId &&
          !isTerminal(r.status),
      )
    )
      fail("locked", translate("Wait for the current generation to finish"));
    this.applyGenerated(run, run.candidate!);
    delete run.candidate;
    this.publish();
  }
  private validateOutput(output: OutputManifest) {
    if (
      !output ||
      !output.markdown ||
      typeof output.markdown.body !== "string" ||
      !output.markdown.body.trim() ||
      typeof output.markdown.title !== "string"
    )
      fail("invalid_output", translate("A successful output must include a non-empty Markdown document"));
    if (output.images !== undefined && !Array.isArray(output.images))
      fail("invalid_output", translate("Image outputs must be an array"));
    for (const image of output.images ?? [])
      if (
        typeof image.title !== "string" ||
        typeof image.dataUrl !== "string" ||
        !/^data:image\/(png|jpeg|webp|gif|svg\+xml)(;[^,]*)?,/i.test(
          image.dataUrl,
        )
      )
        fail("invalid_output", translate("Images must provide a development image data URL"));
  }
  private imageBlob(dataUrl: string): Blob {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(5, comma);
    const body = dataUrl.slice(comma + 1);
    const bytes = meta.includes(";base64")
      ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    return new Blob([bytes], { type: meta.split(";")[0] });
  }
  private publishOutputs(run: Run, output: OutputManifest, images: Blob[]) {
    const graph = this.graph(run.graphId);
    this.clearHistory(graph.id);
    const source = this.node(graph, run.nodeId);
    const prior = this.state.runs.filter(
      (r) =>
        r.nodeId === run.nodeId &&
        r.graphId === run.graphId &&
        r.outputNodeIds.length,
    ).length;
    const document = this.addAsset(
      run.serviceId,
      run.projectId,
      {
        name: output.markdown.title + ".md",
        mimeType: "text/markdown",
        data: output.markdown.body,
      },
      output.markdown.body,
    );
    const entries: CreateNodeInput[] = [
      {
        type: "document",
        title: output.markdown.title,
        content: output.markdown.body,
        summary: output.markdown.summary ?? output.markdown.body.slice(0, 120),
        assetRef: this.ref(document),
      },
    ];
    (output.images ?? []).forEach((image, index) => {
      const asset = this.addAsset(run.serviceId, run.projectId, {
        name: image.title,
        mimeType: images[index]!.type,
        data: images[index]!,
      });
      entries.push({
        type: "image",
        title: image.title,
        assetRef: this.ref(asset),
      });
    });
    entries.forEach((entry, index) => {
      const node = this.newNode(
        graph,
        {
          ...entry,
          x:
            source.x + source.width + 100 + prior * 820 + (index > 0 ? 400 : 0),
          y: source.y + Math.max(0, index - 1) * 290,
        },
        { readonly: entry.type === "document", originRunId: run.id },
      );
      graph.nodes.push(node);
      graph.edges.push({
        ...scopeOf(graph),
        id: this.id("edge"),
        source: index === 0 ? source.id : run.outputNodeIds[0]!,
        target: node.id,
        originRunId: run.id,
        ...(index === 0 ? { kind: "delivery" as const } : {}),
      });
      run.outputNodeIds.push(node.id);
    });
    if (run.outputNodeIds.length > 1) {
      graph.nodes.push(
        this.newNode(
          graph,
          {
            type: "group",
            title: output.markdown.title + translate(" · Outputs"),
            ...this.groupBounds(graph, run.outputNodeIds),
          },
          { memberIds: [...run.outputNodeIds] },
        ),
      );
    }
    this.touch(graph);
  }
  /** Replay hook: full identity, unique event ID, increasing per-run sequence and legal transitions. */
  applyEvent(event: RunEvent): boolean {
    this.assertAlive();
    const run = this.state.runs.find((r) => r.id === event.runId);
    const eventKey = JSON.stringify([event.serviceId, event.eventId]);
    if (
      !event.eventId ||
      ![
        "summary",
        "status",
        "question",
        "approval",
        "succeeded",
        "failed",
        "interrupted",
        "cancelled",
        "generated",
      ].includes(event.type)
    )
      return false;
    if (
      !run ||
      event.serviceId !== run.serviceId ||
      event.projectId !== run.projectId ||
      event.graphId !== run.graphId ||
      event.nodeId !== run.nodeId ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= run.lastEventSequence ||
      this.seenEvents.has(eventKey) ||
      isTerminal(run.status) ||
      !this.service(run.serviceId).connected
    )
      return false;
    let decoded: Blob[] = [];
    if (event.type === "succeeded") {
      if (
        run.kind !== "execution" ||
        !run.occupiesSlot ||
        !["running", "finalizing", "cancelling"].includes(run.status)
      )
        return false;
      this.validateOutput(event.output);
      decoded = (event.output.images ?? []).map((image) =>
        this.imageBlob(image.dataUrl),
      );
    } else if (event.type === "generated") {
      if (
        run.kind !== "generation" ||
        !run.occupiesSlot ||
        !["running", "cancelling"].includes(run.status)
      )
        return false;
      const graph = this.graph(run.graphId);
      const node = this.node(graph, run.nodeId);
      if (typeof event.result?.content !== "string")
        fail("invalid_output", translate("The generation result has no content"));
      this.validatePatch(graph, event.result);
      if (
        node.type === "image" &&
        (!event.result.assetRef ||
          !this.readAsset(event.result.assetRef).mimeType.startsWith("image/"))
      )
        fail("invalid_output", translate("Image generation must provide an image asset"));
    } else if (event.type === "cancelled") {
      if (!run.cancelRequested) return false;
    } else if (event.type === "question" || event.type === "approval") {
      if (
        run.status !== "running" ||
        run.cancelRequested ||
        !event.interactionId ||
        this.seenInteractions.has(JSON.stringify([run.id, event.interactionId]))
      )
        return false;
    } else if (event.type === "status") {
      const allowed =
        (event.status === "running" && run.status === "preparing") ||
        (event.status === "finalizing" &&
          run.status === "running" &&
          run.kind === "execution");
      if (!allowed) return false;
    } else if (
      (event.type === "failed" || event.type === "interrupted") &&
      !run.occupiesSlot
    )
      return false;
    run.lastEventSequence = event.sequence;
    this.seenEvents.add(eventKey);
    this.lastEvents.set(run.id, clone(event));
    if (event.type === "question" || event.type === "approval")
      this.seenInteractions.add(JSON.stringify([run.id, event.interactionId]));
    switch (event.type) {
      case "summary":
        run.summaries.push(event.message);
        break;
      case "status":
        run.status = event.status;
        break;
      case "question":
        run.status = "waiting_input";
        run.question = { id: event.interactionId, message: event.message };
        run.summaries.push(translate("Waiting for answer: ") + event.message);
        break;
      case "approval":
        run.status = "waiting_approval";
        run.approval = { id: event.interactionId, message: event.message };
        run.summaries.push(translate("Waiting for approval: ") + event.message);
        break;
      case "succeeded":
        this.publishOutputs(run, event.output, decoded);
        run.status = "succeeded";
        run.summaries.push(translate("The simulated delivery was published"));
        break;
      case "generated": {
        this.clearHistory(run.graphId);
        const node = this.node(this.graph(run.graphId), run.nodeId);
        if (node.contentRevision === run.generationRevision)
          this.applyGenerated(run, event.result);
        else {
          run.candidate = clone(event.result);
          run.summaries.push(translate("The content has newer edits. The generation result was kept as a candidate"));
        }
        run.status = "succeeded";
        break;
      }
      case "failed":
      case "interrupted":
        run.status = event.type;
        run.error = event.reason;
        run.summaries.push(event.reason);
        break;
      case "cancelled":
        run.status = "cancelled";
        run.summaries.push(translate("The simulated Runtime confirmed the cancellation"));
        break;
    }
    if (isTerminal(run.status)) {
      run.occupiesSlot = false;
      const timer = this.timers.get(run.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(run.id);
      this.schedule();
    }
    this.publish(event);
    return true;
  }
  /** Re-deliver the last accepted event unchanged; a correct replay is a no-op. */
  replayLastEvent(runId: string): boolean {
    const previous = this.lastEvents.get(runId);
    return previous ? this.applyEvent(clone(previous)) : false;
  }
  private emit(run: Run, payload: RunEventPayload): boolean {
    return this.applyEvent({
      ...scopeOf(run),
      runId: run.id,
      nodeId: run.nodeId,
      sequence: run.lastEventSequence + 1,
      eventId: this.id("event"),
      ...payload,
    });
  }
  /** Appends incremental progress events without completing or advancing the run status. */
  appendDemoSummary(runId: string, count = 1): number {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
      fail("invalid", translate("The number of simulated summaries must be an integer from 1 to 1000"));
    if (!run.occupiesSlot || isTerminal(run.status)) return 0;
    let accepted = 0;
    for (let index = 0; index < count; index++) {
      if (
        this.emit(run, {
          type: "summary",
          message:
            translate("Simulated progress summary ") +
            (run.summaries.length + 1) +
            translate(": reviewing references and the progress of this delivery."),
        })
      )
        accepted++;
      else break;
    }
    return accepted;
  }
  advanceRun(runId: string, scenario: DemoScenario = "success"): boolean {
    const run = this.run(runId);
    this.writable(run.serviceId);
    if (isTerminal(run.status)) return false;
    if (run.cancelRequested || scenario === "cancel") {
      if (!run.cancelRequested) this.cancelRun(runId);
      return this.acknowledgeCancellation(runId);
    }
    if (run.status !== "running" && run.status !== "finalizing") return false;
    if (scenario === "question")
      return this.emit(run, {
        type: "question",
        interactionId: this.id("question"),
        message: translate("Simulated question: confirm what this delivery should emphasize."),
      });
    if (scenario === "approval")
      return this.emit(run, {
        type: "approval",
        interactionId: this.id("approval"),
        message: translate("Simulated approval: allow delivery document generation to continue?"),
      });
    if (scenario === "failure")
      return this.emit(run, {
        type: "failed",
        reason:
          translate("Simulated execution failed with a recoverable demo error. The prompt and inputs are preserved; run the task normally to try again."),
      });
    if (run.kind === "generation") {
      const node = this.node(this.graph(run.graphId), run.nodeId);
      let assetRef: AssetRef | undefined;
      if (node.type === "image") {
        const blob = this.imageBlob(imageData);
        assetRef = this.ref(
          this.addAsset(run.serviceId, run.projectId, {
            name: translate("simulated-generated-image.svg"),
            mimeType: blob.type,
            data: blob,
          }),
        );
      }
      return this.emit(run, {
        type: "generated",
        result: {
          content: translate("[Simulated generation] ") + run.inputSnapshot.prompt,
          ...(assetRef ? { assetRef } : {}),
        },
      });
    }
    return this.emit(run, {
      type: "succeeded",
      output: {
        markdown: {
          title: translate("Simulated delivery document"),
          body:
            translate("# Simulated delivery\n\n") +
            run.inputSnapshot.prompt +
            translate("\n\nThis content was generated by the development adapter without calling a real Agent.\n\nDirect references:\n") +
            (run.inputSnapshot.inputs
              .map((i) => i.content || i.title)
              .join("\n\n") || translate("No reference content")),
          summary: translate("Development fixture delivery · Simulated history reviewed"),
        },
        images: [{ title: translate("simulated-illustration.svg"), dataUrl: imageData }],
      },
    });
  }
  resetDemo(seed = true) {
    this.histories.clear();
    this.assertAlive();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const release of [...this.previewReleases]) release();
    this.blobs.clear();
    this.keys.clear();
    this.seenEvents.clear();
    this.seenInteractions.clear();
    this.lastEvents.clear();
    this.state = {
      mode: "development",
      namespace: "openworkgraph:development:v1",
      revision: 0,
      services: [
        {
          id: "service-local",
          serviceId: "service-local",
          name: translate("Local development Runtime · Simulated"),
          capacity: 2,
          connected: true,
          development: true,
        },
        {
          id: "service-studio",
          serviceId: "service-studio",
          name: translate("Studio development Runtime · Simulated"),
          capacity: 1,
          connected: true,
          development: true,
        },
      ],
      projects: [
        {
          id: "project-web",
          projectId: "project-web",
          serviceId: "service-local",
          name: translate("Web Product"),
        },
        {
          id: "project-design",
          projectId: "project-design",
          serviceId: "service-local",
          name: translate("Design Research"),
        },
        {
          id: "project-web",
          projectId: "project-web",
          serviceId: "service-studio",
          name: translate("Studio Project"),
        },
      ],
      graphs: [],
      assets: [],
      runs: [],
      activeGraphId: "",
      activeServiceId: "service-local",
    };
    const specs = [
      ["graph-main", "service-local", "project-web", translate("Product Work Graph")],
      ["graph-next", "service-local", "project-web", translate("Same Project · Next Iteration")],
      ["graph-design", "service-local", "project-design", translate("Design Research")],
      ["graph-studio", "service-studio", "project-web", translate("Studio Work Graph")],
    ];
    for (const service of this.state.services) {
      const capacity =
        this.options.serviceCapacities?.[
          service.id as "service-local" | "service-studio"
        ];
      if (capacity !== undefined) service.capacity = capacity;
    }
    for (const [id, serviceId, projectId, name] of specs) {
      const graph: WorkGraph = {
        id: id!,
        graphId: id!,
        serviceId: serviceId!,
        projectId: projectId!,
        name: name!,
        revision: 0,
        nodes: [],
        edges: [],
      };
      this.state.graphs.push(graph);
      if (seed) {
        const text = this.newNode(graph, {
          type: "text",
          title: translate("Ideas and Goals"),
          x: 80,
          y: 140,
          content:
            translate("Connect ideas into an executable workflow.\nThis standalone development fixture simulates every run and delivery."),
        });
        const execution = this.newNode(graph, {
          type: "execution",
          title: translate("Prepare an Implementation Plan"),
          x: 500,
          y: 140,
          height: 300,
          prompt: translate("Prepare an actionable plan from the reference content."),
        });
        graph.nodes.push(text, execution);
        graph.edges.push({
          ...scopeOf(graph),
          id: this.id("edge"),
          source: text.id,
          target: execution.id,
        });
      }
    }
    this.state.activeGraphId = "graph-main";
    if (seed) {
      const graph = this.graph("graph-main");
      const asset = this.addAsset(
        graph.serviceId,
        graph.projectId,
        {
          name: translate("Welcome.md"),
          mimeType: "text/markdown",
          data: translate("# Get Started\n\nConnect reference content, start a run manually, and use the demo controls to advance its status."),
        },
        translate("# Get Started\n\nConnect reference content, start a run manually, and use the demo controls to advance its status."),
      );
      graph.nodes.push(
        this.newNode(graph, {
          type: "document",
          title: translate("Instructions"),
          x: 80,
          y: 490,
          content: asset.text,
          assetRef: this.ref(asset),
          summary: translate("Connect, run, wait for interaction, deliver, and run again"),
        }),
      );
      const blob = this.imageBlob(imageData);
      const image = this.addAsset(graph.serviceId, graph.projectId, {
        name: translate("development-illustration.svg"),
        mimeType: blob.type,
        data: blob,
      });
      graph.nodes.push(
        this.newNode(graph, {
          type: "image",
          title: translate("Development Illustration"),
          x: 880,
          y: 140,
          assetRef: this.ref(image),
        }),
      );
    }
    this.publish();
  }
  dispose() {
    if (this.disposed) return;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const release of [...this.previewReleases]) release();
    this.listeners.clear();
    this.eventListeners.clear();
    this.disposed = true;
  }
}
export function createDevelopmentAdapter(
  options?: DevelopmentAdapterOptions,
): DevelopmentAdapter {
  return new DevelopmentAdapter(options);
}
