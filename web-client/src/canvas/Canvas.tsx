import { limitNodeTitle } from '../../../packages/protocol/src/node-title';
import {
  forwardRef,
  memo,
  useMemo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as PE,
} from "react";
import { groupAtCenter, insetNodePosition } from './group-drop';
import { GRID_SIZE, snapNodeMove } from './move-snap';
import { previewEdgeError } from '../../../packages/protocol/src/preview';
import {
  Minus,
  Plus,
  Maximize,
  LocateFixed,
  Map as MapIcon,
  MousePointer2,
  Hand,
  CircleHelp,
  Layers,
  Crown,
} from "lucide-react";
import type {
  WorkGraph,
  WorkNode,
  WorkEdge,
  WorkgraphAdapter,
} from "../domain/types";
import {
  boundsOf,
  centerOn,
  clampZoom,
  connectionPath,
  fitBounds,
  inputPort,
  chainInputPort,
  chainOutputPort,
  intersects,
  outputPort,
  rectFromPoints,
  resizeRect,
  screenToWorld,
  viewportRect,
  wheelPan,
  wheelZoom,
  zoomAt,
  type Point,
  type Rect,
  type ResizeCorner,
  type Size,
  type Viewport,
} from "./geometry";
import "./canvas.css";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { primaryKey, primaryModifier } from "./primary-modifier";
import { useI18n } from "../i18n/I18nProvider";
export type { Viewport, Point } from "./geometry";
export interface CanvasHandle {
  fit(): void;
  locate(id: string): void;
  getViewport(): Viewport;
  getVisibleWorldBounds(): Rect;
  getPlacementPosition(size: Size): Point;
}
export interface CanvasProps {
  graph: WorkGraph;
  readOnly?: boolean;
  adapter?: WorkgraphAdapter;
  isNodeLocked?(id: string): boolean;
  isNodeRunning?(id: string): boolean;
  isNodeWaiting?(id: string): boolean;
  isNodeAwaitingApproval?(id: string): boolean;
  isNodeFailed?(id: string): boolean;
  onNodePointerDown?(id: string, target: EventTarget | null): void;
  canMoveNodes?(ids: string[]): boolean;
  selectedIds: string[];
  onSelect(ids: string[]): void;
  renderNode(node: WorkNode): ReactNode;
  /**
   * Identifies the external data used by renderNode for one node. When set,
   * unrelated parent renders do not invalidate every mounted node body.
   */
  nodeRenderKey?(node: WorkNode): unknown;
  renderTitlePrefix?(node: WorkNode): ReactNode;
  renderToolbar?(node: WorkNode): ReactNode;
  renderPanel?(node: WorkNode): ReactNode;
  onCreateMenu?(position: Point, screenPosition: Point): void;
  onOpenNode?(node: WorkNode): void;
  onActivateNode?(node: WorkNode): void;
  canEditTextOnSpace?(node: WorkNode): boolean;
  shouldOpenNodeOnDoubleClick?(node: WorkNode): boolean;
  onImportFiles?(files: File[], position: Point): void | Promise<void>;
  canDropData?(data: DataTransfer, targetNodeId?: string): boolean;
  onDropData?(data: DataTransfer, position: Point, targetNodeId?: string): void;
  onPasteText?(text: string, position: Point): void;
  onMove?(moves: Array<Point & { id: string }>): void | Promise<void>;
  onResize?(id: string, bounds: Rect): void | Promise<void>;
  onConnect?(source: string, target: string): void;
  onExecutionOutputs?(nodeId: string, position: Point, screen: Point): void;
  hiddenExecutionOutputCounts?: Record<string, number>;
  onConnectCreate?(
    sourceId: string,
    position: Point,
    screen: Point,
    port: "input" | "output",
  ): void;
  onDeleteNodes?(ids: string[]): void;
  onDeleteEdge?(id: string): void;
  onUndo?(): void;
  onRedo?(): void;
  onError(error: unknown): void;
  viewport?: Viewport;
  initialViewport?: Viewport;
  onViewportChange?(viewport: Viewport): void;
  locateNodeId?: string | null;
  focusPanelNodeId?: string | null;
  tool?: "select" | "pan";
  theme?: "light" | "dark";
  backgroundMode?: "lines" | "dots" | "blank";
  showMinimap?: boolean;
  showZoomButtons?: boolean;
  className?: string;
}
// Viewport frames change geometry, not document content. Keep expensive node
// previews mounted without re-running their renderers on every pan/zoom frame.
const NodeBody = memo(function NodeBody({ node, renderer }: {
  node: WorkNode;
  renderer: { current: CanvasProps['renderNode'] };
  renderKey: unknown;
}) {
  return <>{renderer.current(node)}</>;
});
type Gesture = {
  pointer: number;
  start: Point;
  current: Point;
  viewport: Viewport;
  moved: boolean;
} & (
  | { kind: "pan" }
  | { kind: "box"; initial: string[] }
  | { kind: "move"; nodes: WorkNode[]; origins: WorkNode[]; anchorId: string; snapToGrid: boolean; clickSelection?: string[] }
  | { kind: "resize"; node: WorkNode; corner: ResizeCorner; snapToGrid: boolean; shiftKey: boolean }
  | { kind: "link"; node: WorkNode; port: "input" | "output" | "chain-input" | "chain-output" }
);
const INTERACTIVE =
  'input,textarea,select,button,a,video,audio,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-canvas-interactive],[data-canvas-no-zoom]';
const element = (target: EventTarget | null) =>
  target instanceof Element ? target : null;
const interactive = (target: EventTarget | null) =>
  !!element(target)?.closest(INTERACTIVE);
const CLIPBOARD = "application/x-openworkgraph-nodes";
const acceptsInput = (node: WorkNode) =>
  ["text", "image", "execution", "file", "preview"].includes(node.type);
const suppliesOutput = (node: WorkNode) =>
  node.type !== "execution" && node.type !== "group";
const resizeMinimum = (_node: WorkNode): Size => ({ width: 220, height: 160 });
type MoveGesture = Extract<Gesture, { kind: 'move' }>;
function moveGeometry(g: MoveGesture) {
  const delta = { x: (g.current.x - g.start.x) / g.viewport.k, y: (g.current.y - g.start.y) / g.viewport.k };
  if (!g.snapToGrid) return delta;
  const anchor = g.nodes.find(n => n.id === g.anchorId) ?? g.nodes[0];
  return snapNodeMove(anchor, delta);
}

/** Node UI has no viewport dependency; pan/zoom only transforms the world layer. */
const CanvasNode = memo(function CanvasNode({ node, canvasProps: props, nodeRenderer, nodeRenderKey, groupDropTarget, linkTargetId, linkPort }: {
  node: WorkNode;
  canvasProps: CanvasProps;
  nodeRenderer: { current: CanvasProps['renderNode'] };
  nodeRenderKey: unknown;
  groupDropTarget: boolean;
  linkTargetId?: string;
  linkPort?: 'input' | 'output' | 'chain-input' | 'chain-output';
}) {
  const { t } = useI18n();
  return (
    <div
      key={node.id}
      data-node-id={node.id}
      data-node-running={props.isNodeRunning?.(node.id) ? "true" : undefined}
      data-node-waiting={props.isNodeWaiting?.(node.id) ? "true" : undefined}
      data-node-awaiting-approval={props.isNodeAwaitingApproval?.(node.id) ? "true" : undefined}
      data-node-failed={props.isNodeFailed?.(node.id) ? "true" : undefined}
      onPointerDownCapture={event => { if (event.button === 0) props.onNodePointerDown?.(node.id, event.target); }}
      data-group-drop-target={groupDropTarget ? 'true' : undefined}
      className={
        "owg-node " +
        (node.type === "group" ? "owg-group " : "") +
        (props.isNodeRunning?.(node.id) ? "owg-node-running " : "") +
        (props.isNodeWaiting?.(node.id) ? "owg-node-waiting " : "") +
        (props.isNodeAwaitingApproval?.(node.id) ? "owg-node-awaiting-approval " : "") +
        (props.isNodeFailed?.(node.id) ? "owg-node-failed " : "") +
        (props.selectedIds.includes(node.id) ? "selected" : "")
      }
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
      }}
      aria-label={node.title}
    >
      <div className="owg-node-title" title={node.title}>
        {node.type === 'execution' && props.graph.edges.some(edge => edge.kind === 'execution' && edge.target === node.id) && !props.graph.edges.some(edge => edge.kind === 'execution' && edge.source === node.id) && <span className="owg-chain-master-mark" title={t("Chain primary node")}><Crown size={16} aria-label={t("Chain primary node")} role="img" /></span>}
        {props.renderTitlePrefix?.(node)}
        <span className="owg-node-title-text">{node.title}</span>
      </div>
      <div className={"owg-node-body" + (node.type === "execution" ? " execution-chain-body" : node.type === 'preview' ? ' owg-preview-body' : "")}>
        {node.type === 'preview' ? <>
          <div className="owg-preview-content" inert={!props.selectedIds.includes(node.id)}>
            <NodeBody node={node} renderer={nodeRenderer} renderKey={nodeRenderKey} />
          </div>
          {!props.selectedIds.includes(node.id) && <div className="owg-preview-selection-shield" data-canvas-draggable aria-hidden="true"/>}
        </> : node.type === "group" ? null : <NodeBody node={node} renderer={nodeRenderer} renderKey={nodeRenderKey} />}
      </div>
      {acceptsInput(node) && (
        <button
          className="owg-port input"
          data-port="input"
          data-link-target={
            linkTargetId === node.id &&
            linkPort === "output"
              ? "true"
              : undefined
          }
          aria-disabled={
            props.isNodeLocked?.(node.id) ?? props.adapter?.isNodeLocked(props.graph.id, node.id)
          }
          aria-label={t("{title} input port", { title: node.title })}
          title={t("Input: connect a content node")}
        />
      )}
      {node.type === "execution" && (
        <>
          <button
            className="owg-port chain-input"
            data-port="chain-input"
            data-connected={props.graph.edges.some(edge => edge.kind === "execution" && edge.target === node.id) ? "true" : undefined}
            data-link-target={linkTargetId === node.id && linkPort === "chain-output" ? "true" : undefined}
            aria-label={t("{title} chain input slot", { title: node.title })}
            title={t("Chain input: connect a preceding execution node")}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M 3 3 L 17 3 L 17 10 L 10 17 L 3 10 Z" /></svg></button>
          <button
            className="owg-port chain-output"
            data-port="chain-output"
            data-connected={props.graph.edges.some(edge => edge.kind === "execution" && edge.source === node.id) ? "true" : undefined}
            data-link-target={linkTargetId === node.id && linkPort === "chain-input" ? "true" : undefined}
            aria-label={t("{title} chain output slot", { title: node.title })}
            title={t("Chain output: connect a following execution node")}
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M 3 3 L 17 3 L 17 10 L 10 17 L 3 10 Z" /></svg></button>
        </>
      )}
      {suppliesOutput(node) && (
        <button
          className="owg-port output"
          data-port="output"
          data-link-target={
            linkTargetId === node.id &&
            linkPort === "input"
              ? "true"
              : undefined
          }
          aria-label={t("{title} output port", { title: node.title })}
          title={t("Output: connect a text, image, or execution node")}
        />
      )}
      {node.type === "execution" && props.onExecutionOutputs && (
        <button
          className="owg-port output execution-output"
          data-port="output"
          aria-label={props.hiddenExecutionOutputCounts?.[node.id]
            ? t("{title} output folder, {count} hidden artifacts", { title: node.title, count: props.hiddenExecutionOutputCounts[node.id] })
            : t("{title} output folder", { title: node.title })}
          title={props.hiddenExecutionOutputCounts?.[node.id]
            ? t("{count} hidden artifacts; drag out or click to choose artifacts to show", { count: props.hiddenExecutionOutputCounts[node.id] })
            : t("Drag out or click to choose output artifacts to show")}
          aria-haspopup="dialog"
          onKeyDown={event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            props.onExecutionOutputs?.(node.id, { x: node.x + node.width + 100, y: node.y }, { x: rect.right, y: rect.bottom });
          }}
        >
          <Layers size={25}/>
          {(props.hiddenExecutionOutputCounts?.[node.id] ?? 0) > 0 && <span className="execution-output-count" aria-hidden="true">{props.hiddenExecutionOutputCounts![node.id] > 99 ? "99+" : props.hiddenExecutionOutputCounts![node.id]}</span>}
        </button>
      )}
      {props.selectedIds.includes(node.id) &&
        (["nw", "ne", "sw", "se"] as const).map((corner) => (
          <button
            key={corner}
            className={"owg-resize " + corner}
            data-resize={corner}
            aria-label={t("Resize {title} from {corner}", { title: node.title, corner })}
            title={
              node.type === "image"
                ? t("Drag to resize width and height freely; hold Shift to preserve the aspect ratio")
                : node.type === "video"
                  ? t("Drag to resize proportionally")
                  : t("Drag to resize")
            }
          />
        ))}
      {props.renderPanel && (
        <div
          className="owg-node-panel"
          data-canvas-interactive
          style={{
            top: node.height + 16,
            width: Math.max(node.width, 600),
          }}
        >
          {props.renderPanel(node)}
        </div>
      )}
    </div>
  );
});

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(
  function Canvas(props, ref) {
    const { t } = useI18n();
    const root = useRef<HTMLDivElement>(null);
    const [localViewport, setLocalViewport] = useState<Viewport>(props.initialViewport ?? {
      x: 80,
      y: 80,
      k: 1,
    });
    const viewport = props.viewport ?? localViewport;
    const [size, setSize] = useState<Size>({ width: 1000, height: 700 });
    const [gesture, setGesture] = useState<Gesture | null>(null);
    const gestureRef = useRef<Gesture | null>(null);
    const [draft, setDraft] = useState<Record<string, Partial<Rect>>>({});
    const [pendingLayout, setPendingLayout] = useState<Record<string, { token: object; bounds: Partial<Rect> }>>({});
    const layoutEpoch = useRef(0);
    const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
    const [space, setSpace] = useState(false),
      [modifierDown, setModifierDown] = useState(false);
    const [localTool, setLocalTool] = useState<"select" | "pan">("pan");
    const [minimap, setMinimap] = useState(props.showMinimap ?? false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const lastPointer = useRef<Point | null>(null);
    const suppressContext = useRef(false);
    const current = useRef({ props, viewport, size });
    current.current = { props, viewport, size };
    const nodeRenderer = useRef(props.renderNode);
    nodeRenderer.current = props.renderNode;
    const viewportAnimation = useRef<{ frame: number; target: Viewport; kind: 'zoom' | 'navigate' } | null>(null);
    const zoomRangePointer = useRef<{ id: number; x: number; y: number; value: number; dragging: boolean } | null>(null);
    const publishedViewport = useRef(viewport);
    const [viewportAnimating, setViewportAnimating] = useState(false);
    function cancelViewportAnimation() {
      if (viewportAnimation.current) cancelAnimationFrame(viewportAnimation.current.frame);
      viewportAnimation.current = null;
      setViewportAnimating(false);
    }
    // One affine interpolation keeps the pointer anchor, grid, nodes and minimap
    // synchronized. A new request starts at the currently displayed position.
    function animateViewport(v: Viewport, duration = 260, kind: 'zoom' | 'navigate' = 'navigate') {
      const from = { ...current.current.viewport }, target = { ...v, k: clampZoom(v.k) };
      cancelViewportAnimation();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        (from.x === target.x && from.y === target.y && from.k === target.k)) {
        writeViewport(target);
        return;
      }
      const start = performance.now();
      const animation = { frame: 0, target, kind };
      viewportAnimation.current = animation;
      setViewportAnimating(true);
      const tick = (now: number) => {
        if (viewportAnimation.current !== animation) return;
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        writeViewport(progress === 1 ? target : {
          x: from.x + (target.x - from.x) * eased,
          y: from.y + (target.y - from.y) * eased,
          k: from.k + (target.k - from.k) * eased,
        });
        if (progress < 1) animation.frame = requestAnimationFrame(tick);
        else { viewportAnimation.current = null; setViewportAnimating(false); }
      };
      animation.frame = requestAnimationFrame(tick);
    }
    function zoomControlAnchor(): Point {
      const { props, viewport, size } = current.current;
      const selected = props.graph.nodes.filter(node => props.selectedIds.includes(node.id));
      if (!selected.length) return { x: size.width / 2, y: size.height / 2 };
      const bounds = boundsOf(selected);
      return {
        x: (bounds.x + bounds.width / 2) * viewport.k + viewport.x,
        y: (bounds.y + bounds.height / 2) * viewport.k + viewport.y,
      };
    }
    function zoomViewport(scale: number, pointer: Point = zoomControlAnchor()) {
      animateViewport(zoomAt(current.current.viewport, pointer, scale), 140, 'zoom');
    }
    function directZoomViewport(scale: number) {
      if (scale === current.current.viewport.k) return;
      changeViewport(zoomAt(current.current.viewport, zoomControlAnchor(), scale));
    }
    function targetZoom() {
      return viewportAnimation.current?.kind === 'zoom' ? viewportAnimation.current.target.k : current.current.viewport.k;
    }
    useEffect(() => {
      setViewportAnimating(false);
      return () => {
        if (viewportAnimation.current) cancelAnimationFrame(viewportAnimation.current.frame);
        viewportAnimation.current = null;
      };
    }, [props.graph.id]);
    useEffect(() => {
      // A controlled viewport supplied externally takes precedence over motion.
      const supplied = props.viewport, published = publishedViewport.current;
      if (supplied && viewportAnimation.current &&
        (supplied.x !== published.x || supplied.y !== published.y || supplied.k !== published.k)) cancelViewportAnimation();
    }, [props.viewport]);
    useEffect(() => {
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      const changed = () => {
        if (preference.matches && viewportAnimation.current) changeViewport(viewportAnimation.current.target);
      };
      preference.addEventListener('change', changed);
      return () => preference.removeEventListener('change', changed);
    }, []);
    const effectiveTool =
      space || modifierDown
        ? (props.tool ?? localTool) === "select"
          ? "pan"
          : "select"
        : (props.tool ?? localTool);
    const nodes = useMemo(() => props.graph.nodes
      .map((n) => pendingLayout[n.id] || draft[n.id]
        ? { ...n, ...pendingLayout[n.id]?.bounds, ...draft[n.id] } : n)
      .sort((a, b) => Number(b.type === "group") - Number(a.type === "group")),
    [props.graph.nodes, pendingLayout, draft]);
    const nodeById = new globalThis.Map(nodes.map((n) => [n.id, n]));
    const selectedNodeIds = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
    const toolbarNode = props.selectedIds.length === 1 && !gesture
      ? nodeById.get(props.selectedIds[0])
      : undefined;
    const dropGroups = new Set<string>();
    if (gesture?.kind === 'move' && gesture.moved) {
      const moving = new Set(gesture.nodes.map(n => n.id));
      const carried = new Set(gesture.nodes.flatMap(n => n.memberIds ?? []));
      const candidates = nodes.filter(n => n.type === 'group' && n.memberIds && !moving.has(n.id));
      for (const node of nodes) {
        if (!moving.has(node.id) || node.type === 'group' || carried.has(node.id)) continue;
        const target = groupAtCenter(node, candidates);
        if (target && insetNodePosition(node, target) && (!props.canMoveNodes || props.canMoveNodes([target.id]))) dropGroups.add(target.id);
      }
    }
    function report(e: unknown) {
      current.current.props.onError(e);
    }
    function attempt(fn: () => void) {
      try {
        fn();
      } catch (e) {
        report(e);
      }
    }
    // Keep the released geometry visible while an asynchronous adapter saves it.
    // Each operation owns only its overlays, so an older reply cannot erase a newer drag.
    function commitLayout(bounds: Record<string, Partial<Rect>>, save: () => void | Promise<void>) {
      const token = {}, epoch = layoutEpoch.current;
      setPendingLayout(previous => ({ ...previous, ...Object.fromEntries(
        Object.entries(bounds).map(([id, value]) => [id, { token, bounds: value }]),
      ) }));
      const clear = () => {
        if (layoutEpoch.current !== epoch) return;
        setPendingLayout(previous => Object.fromEntries(Object.entries(previous).filter(([, entry]) => entry.token !== token)));
      };
      try {
        const result = save();
        if (result) void result.then(clear, error => { clear(); if (layoutEpoch.current === epoch) report(error); });
        else clear();
      } catch (error) { clear(); throw error; }
    }
    function writeViewport(v: Viewport) {
      const next = { ...v, k: clampZoom(v.k) };
      current.current.viewport = next;
      publishedViewport.current = next;
      setLocalViewport(next);
      current.current.props.onViewportChange?.(next);
    }
    function changeViewport(v: Viewport) {
      cancelViewportAnimation();
      writeViewport(v);
    }
    useEffect(() => {
      const canvas = root.current;
      if (!canvas) return;
      const focusInputPanel = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) ||
          !target.matches('textarea:not(:disabled):not([readonly]),input:not(:disabled):not([readonly]),[contenteditable="true"]')) return;
        const panel = target.closest<HTMLElement>('.owg-node-panel');
        const { viewport, size } = current.current;
        if (!panel || viewport.k >= 0.9) return;
        const bounds = panel.getBoundingClientRect(), canvasBounds = canvas.getBoundingClientRect();
        const centerX = (bounds.left + bounds.width / 2 - canvasBounds.left - viewport.x) / viewport.k;
        const top = (bounds.top - canvasBounds.top - viewport.y) / viewport.k;
        const next = { x: size.width / 2 - centerX, y: size.height / 2 - top, k: 1 };
        const pending = viewportAnimation.current?.target;
        if (pending && pending.k === next.k && Math.abs(pending.x - next.x) < 0.01 && Math.abs(pending.y - next.y) < 0.01) return;
        animateViewport(next, 140);
      };
      // Native textareas emit input; rich prompts also report custom edits
      // such as Enter, paste and undo that do not emit a native input event.
      canvas.addEventListener('input', focusInputPanel, true);
      canvas.addEventListener('owg-prompt-edit', focusInputPanel, true);
      return () => {
        canvas.removeEventListener('input', focusInputPanel, true);
        canvas.removeEventListener('owg-prompt-edit', focusInputPanel, true);
      };
    }, []);
    function relative(client: Point): Point {
      const r = root.current?.getBoundingClientRect();
      return { x: client.x - (r?.left ?? 0), y: client.y - (r?.top ?? 0) };
    }
    function world(client: Point): Point {
      return screenToWorld(relative(client), current.current.viewport);
    }
    function locate(id: string) {
      const n = current.current.props.graph.nodes.find((n) => n.id === id);
      if (n)
        animateViewport(
          centerOn(
            { x: n.x + n.width / 2, y: n.y + n.height / 2 },
            current.current.size,
            Math.min(1, fitBounds(n, current.current.size).k),
          ),
        );
    }
    function fit() {
      animateViewport(
        fitBounds(
          boundsOf(current.current.props.graph.nodes),
          current.current.size,
        ),
      );
    }
    function activateSelection(allowActivate = true) {
      const selectedNode = props.selectedIds.length === 1
        ? props.graph.nodes.find(node => node.id === props.selectedIds[0])
        : undefined;
      if (selectedNode) {
        if (!allowActivate) return;
        if (selectedNode.type === 'text' && !selectedNode.readonly && !props.readOnly && (props.canEditTextOnSpace?.(selectedNode) ?? true)) {
          root.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedNode.id)}"] [data-canvas-text-editor]`)?.focus({ preventScroll: true });
        } else if (selectedNode.type !== 'execution') props.onActivateNode?.(selectedNode);
      } else setSpace(true);
    }
    function focusSelection() {
      const { props, size } = current.current;
      const selected = props.graph.nodes.filter(node => props.selectedIds.includes(node.id));
      if (!selected.length) return;
      const bounds = boundsOf(selected);
      animateViewport(centerOn({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, size, 1));
    }
    useImperativeHandle(ref, () => ({
      fit,
      locate,
      getViewport: () => current.current.viewport,
      getVisibleWorldBounds: () => viewportRect(current.current.viewport, current.current.size),
      getPlacementPosition: (nodeSize) => {
        const { size, viewport } = current.current;
        const center = screenToWorld({ x: size.width / 2, y: size.height / 2 }, viewport);
        return { x: center.x - nodeSize.width / 2, y: center.y - nodeSize.height / 2 };
      },
    }));
    useEffect(() => {
      if (props.locateNodeId) locate(props.locateNodeId);
    }, [props.locateNodeId, props.graph.id]);
    useEffect(() => {
      if (!props.focusPanelNodeId) return;
      const n = current.current.props.graph.nodes.find(
        (n) => n.id === props.focusPanelNodeId,
      );
      if (!n) return;
      // Measure the mounted composer in world units: its height depends on
      // font metrics and content, not a fixed 338px estimate. Only refocus on
      // opening or canvas resize; editing must preserve manual pan/zoom.
      const panel = Array.from(root.current?.querySelectorAll<HTMLElement>(
        "[data-node-id]",
      ) ?? []).find((el) => el.dataset.nodeId === n.id)
        ?.querySelector<HTMLElement>(".owg-node-panel");
      const panelHeight = panel
        ? panel.getBoundingClientRect().height / current.current.viewport.k
        : 338;
      const panelWidth = Math.max(n.width, 600),
        bounds = {
          x: n.x + (n.width - panelWidth) / 2,
          y: n.y - 24,
          width: panelWidth,
          height: n.height + 24 + 16 + panelHeight,
        };
      const available = {
        width: Math.max(1, size.width - 60),
        height: Math.max(1, size.height - 240),
      };
      const k = Math.min(1, fitBounds(bounds, available, 0).k);
      const next = centerOn(
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        available,
        k,
      );
      animateViewport({ ...next, x: next.x + 30, y: next.y + 130 });
    }, [props.focusPanelNodeId, props.graph.id, size.width, size.height]);

    useEffect(() => {
      setDraft({});
      setPendingLayout({});
      ++layoutEpoch.current;
      setSelectedEdge(null);
      gestureRef.current = null;
      setGesture(null);
      lastPointer.current = null;
      return () => { ++layoutEpoch.current; };
    }, [props.graph.id]);
    useEffect(() => {
      if (props.showMinimap !== undefined) setMinimap(props.showMinimap);
    }, [props.showMinimap]);
    useEffect(() => {
      const el = root.current;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        const r = entries[0].contentRect;
        setSize({ width: r.width, height: r.height });
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      const el = root.current;
      if (!el) return;
      const wheel = (e: WheelEvent) => {
        // Cancel browser zoom before any interactive/gesture early return.
        // Chromium reports trackpad pinch as Ctrl+wheel, including on macOS.
        if (e.ctrlKey || primaryModifier(e)) e.preventDefault();
        if (gestureRef.current) return;
        if (e.ctrlKey || primaryModifier(e)) {
          if (element(e.target)?.closest('[data-canvas-no-zoom]')) return;
        } else if (interactive(e.target)) return;
        e.preventDefault();
        const pointer = relative({ x: e.clientX, y: e.clientY });
        // Keep high-frequency wheel input direct so it does not lag behind
        // the pointer. Ctrl+wheel includes trackpad pinch; Command+wheel
        // remains a zoom shortcut on macOS.
        if (e.ctrlKey || primaryModifier(e))
          changeViewport(
            wheelZoom(
              current.current.viewport,
              pointer,
              e.deltaY,
              e.deltaMode,
              current.current.size.height,
              // macOS trackpad pinch arrives as Ctrl+wheel. Leave the
              // separate Command+wheel shortcut at its original speed.
              e.ctrlKey && !e.metaKey && primaryKey === "Meta" ? 2 : 1,
            ),
          );
        else
          changeViewport(
            wheelPan(
              current.current.viewport,
              e.deltaX,
              e.deltaY,
              e.deltaMode,
              current.current.size,
            ),
          );
      };
      el.addEventListener("wheel", wheel, { passive: false, capture: true });
      return () => el.removeEventListener("wheel", wheel, { capture: true });
    }, []);
    useEffect(() => {
      const down = (e: KeyboardEvent) => {
        if (e.key === primaryKey) updateSnapModifier(e);
        if (interactive(e.target) || e.defaultPrevented) return;
        if (e.code === "Space") {
          e.preventDefault();
          setSpace(true);
        }
        if (e.key === primaryKey) setModifierDown(true);
      };
      const up = (e: KeyboardEvent) => {
        if (e.key === primaryKey) updateSnapModifier(e);
        if (e.code === "Space") setSpace(false);
        if (e.key === primaryKey) setModifierDown(false);
      };
      const blur = () => {
        setSpace(false);
        setModifierDown(false);
        gestureRef.current = null;
        setGesture(null);
        setDraft({});
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", blur);
      return () => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", blur);
      };
    }, []);
    function begin(event: PE, data: Gesture) {
      event.preventDefault();
      root.current?.focus({ preventScroll: true });
      root.current?.setPointerCapture(event.pointerId);
      gestureRef.current = data;
      setGesture(data);
    }
    function down(event: PE<HTMLDivElement>) {
      if (
        interactive(event.target) &&
        !element(event.target)?.closest("[data-port],[data-resize],[data-canvas-draggable]")
      )
        return;
      cancelViewportAnimation();
      const target = element(event.target),
        nodeId = target?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const node = nodes.find((n) => n.id === nodeId);
      const edgeId = target?.closest<SVGElement>("[data-connection-id]")
        ?.dataset.connectionId;
      const activeTool =
        primaryModifier(event) || space
          ? (props.tool ?? localTool) === "select"
            ? "pan"
            : "select"
          : (props.tool ?? localTool);
      const start = { x: event.clientX, y: event.clientY };
      const base = {
        pointer: event.pointerId,
        start,
        current: start,
        viewport: current.current.viewport,
        moved: false,
      };
      if (
        event.button === 1 ||
        (event.button === 2 && !node && !edgeId) ||
        (event.button === 0 && activeTool === "pan" && !node && !edgeId)
      ) {
        begin(event, { ...base, kind: "pan" });
        return;
      }
      if (event.button !== 0) return;
      root.current?.focus({ preventScroll: true });
      if (edgeId) {
        event.preventDefault();
        setSelectedEdge(edgeId);
        props.onSelect([]);
        return;
      }
      setSelectedEdge(null);
      if (node) {
        // Keep the selecting gesture on the graph even after the shield is
        // removed, so pointerup/click cannot land in an iframe or a control.
        if (target?.closest('.owg-preview-selection-shield')) root.current?.setPointerCapture(event.pointerId);
        if (props.readOnly) { props.onSelect([node.id]); return; }
        const port = target?.closest<HTMLElement>("[data-port]")?.dataset
          .port as Extract<Gesture, { kind: "link" }>["port"] | undefined;
        if (port) {
          if (
            (port === "input" || port === "chain-input") &&
            (props.isNodeLocked?.(node.id) ?? props.adapter?.isNodeLocked(props.graph.id, node.id))
          ) {
            event.preventDefault();
            report(
              new Error(
                "\u8fd0\u884c\u671f\u95f4\u4e0d\u80fd\u4fee\u6539\u8f93\u5165\u8fde\u7ebf",
              ),
            );
            return;
          }
          begin(event, { ...base, kind: "link", node, port });
          return;
        }
        if (target?.closest("[data-resize]")) {
          if (props.canMoveNodes && !props.canMoveNodes([node.id])) return;
          begin(event, {
            ...base,
            kind: "resize",
            node,
            corner: target.closest<HTMLElement>("[data-resize]")!.dataset
              .resize as ResizeCorner,
            snapToGrid: primaryModifier(event),
            shiftKey: event.shiftKey,
          });
          return;
        }
        const additive = event.shiftKey || primaryModifier(event);
        const ids = additive
          ? props.selectedIds.includes(node.id)
            ? props.selectedIds.filter((id) => id !== node.id)
            : [...props.selectedIds, node.id]
          : props.selectedIds.includes(node.id)
            ? props.selectedIds
            : [node.id];
        const deferDeselect = primaryModifier(event) && !event.shiftKey && props.selectedIds.includes(node.id);
        const moveIds = deferDeselect ? props.selectedIds : ids;
        const canMove = moveIds.includes(node.id) && (!props.canMoveNodes || props.canMoveNodes(moveIds));
        props.onSelect(canMove ? moveIds : ids);
        if (canMove)
          begin(event, {
            ...base,
            kind: "move",
            nodes: nodes.filter((n) => moveIds.includes(n.id)),
            origins: nodes,
            anchorId: nodes.find(n => moveIds.includes(n.id) && n.memberIds?.includes(node.id))?.id ?? node.id,
            snapToGrid: primaryModifier(event),
            clickSelection: deferDeselect ? ids : undefined,
          });
      } else
        begin(event, {
          ...base,
          kind: "box",
          initial: event.shiftKey || primaryModifier(event) ? props.selectedIds : [],
        });
    }
    function updateMoveDraft(g: MoveGesture) {
      const delta = moveGeometry(g);
      const affected = new Set(g.nodes.flatMap(n => [n.id, ...(n.memberIds ?? [])]));
      setDraft(Object.fromEntries(g.origins.filter(n => affected.has(n.id))
        .map(n => [n.id, { x: n.x + delta.x, y: n.y + delta.y }])));
    }
    function updateResizeDraft(g: Extract<Gesture, { kind: 'resize' }>) {
      setDraft({
        [g.node.id]: resizeRect(
          g.node,
          { x: g.current.x - g.start.x, y: g.current.y - g.start.y },
          g.viewport.k,
          g.corner,
          g.node.type === "image" ? g.shiftKey : g.node.type === "video",
          resizeMinimum(g.node),
          g.snapToGrid ? GRID_SIZE / 2 : undefined,
        ),
      });
    }
    function updateSnapModifier(event: KeyboardEvent) {
      const active = gestureRef.current;
      if (!active || (active.kind !== 'move' && active.kind !== 'resize')) return;
      const next = active.kind === 'move'
        ? { ...active, snapToGrid: primaryModifier(event) }
        : { ...active, snapToGrid: primaryModifier(event), shiftKey: event.shiftKey };
      gestureRef.current = next;
      setGesture(next);
      if (next.moved) {
        if (next.kind === 'move') updateMoveDraft(next);
        else updateResizeDraft(next);
      }
    }
    function move(event: PE) {
      lastPointer.current = world({ x: event.clientX, y: event.clientY });
      const old = gestureRef.current;
      if (!old || old.pointer !== event.pointerId) return;
      const g = {
        ...old,
        ...(old.kind === 'move' ? { snapToGrid: primaryModifier(event) } : {}),
        ...(old.kind === 'resize' ? { snapToGrid: primaryModifier(event) } : {}),
        ...(old.kind === 'resize' ? { shiftKey: event.shiftKey } : {}),
        current: { x: event.clientX, y: event.clientY },
        moved:
          old.moved ||
          Math.hypot(event.clientX - old.start.x, event.clientY - old.start.y) >
            3,
      };
      gestureRef.current = g;
      setGesture(g);
      const dx = g.current.x - g.start.x,
        dy = g.current.y - g.start.y;
      if (g.kind === "pan")
        changeViewport({
          ...g.viewport,
          x: g.viewport.x + dx,
          y: g.viewport.y + dy,
        });
      if (g.kind === "move" && g.moved) {
        updateMoveDraft(g);
      }
      if (g.kind === "resize") updateResizeDraft(g);
      if (g.kind === "box") {
        const box = rectFromPoints(world(g.start), world(g.current));
        props.onSelect([
          ...new Set([
            ...g.initial,
            ...props.graph.nodes
              .filter((n) => intersects(box, n))
              .map((n) => n.id),
          ]),
        ]);
      }
    }
    function linkDropTarget(
      g: Extract<Gesture, { kind: "link" }>,
      screen: Point,
    ) {
      const p = current.current.props;
      const point = world(screen);
      const hit = document.elementFromPoint(screen.x, screen.y);
      const chain = g.port === "chain-input" || g.port === "chain-output";
      const hitPort = hit?.closest<HTMLElement>('[data-port]')?.dataset.port;
      const hitNodeId = hit?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      const opposite = chain ? (g.port === 'chain-output' ? 'chain-input' : 'chain-output') : (g.port === 'output' ? 'input' : 'output');
      const blocked =
        !!hit?.closest(".owg-node-panel,.owg-node-toolbar") ||
        (chain ? hitPort !== opposite : !!hitPort && hitPort !== opposite);
      const padding = 32 / current.current.viewport.k;
      const candidates = [...p.graph.nodes]
        .reverse()
        .filter(
          (node) => {
            if (chain && node.id !== hitNodeId) return false;
            const source = g.port === "output" || g.port === "chain-output" ? g.node : node;
            const target = g.port === "output" || g.port === "chain-output" ? node : g.node;
            if (chain && (source.type !== "execution" || target.type !== "execution")) return false;
            const incoming = target.type === "preview" ? p.graph.edges.filter(edge => edge.target === target.id).length : 0;
            return node.id !== g.node.id && (chain || !previewEdgeError(source.type, target.type, incoming)) &&
              (chain ? true : (g.port === "output" ? acceptsInput(node) : suppliesOutput(node)));
          },
        );
      const hitPoint = { ...point, width: 0, height: 0 };
      const other = blocked
        ? undefined
        : (candidates.find((node) => intersects(hitPoint, node)) ??
          candidates.find((node) =>
            intersects(hitPoint, {
              x: node.x - padding,
              y: node.y - padding,
              width: node.width + padding * 2,
              height: node.height + padding * 2,
            }),
          ));
      return { point, other, blocked, padding };
    }
    function finish(event: PE, cancelled = false) {
      const active = gestureRef.current;
      if (!active || active.pointer !== event.pointerId) return;
      const release = { x: event.clientX, y: event.clientY };
      const g: Gesture = !cancelled && event.type === "pointerup" && (active.kind === "move" || active.kind === "resize")
        ? {
            ...active,
            ...(active.kind === 'move' ? { snapToGrid: primaryModifier(event) } : {}),
            ...(active.kind === 'resize' ? { snapToGrid: primaryModifier(event) } : {}),
            ...(active.kind === 'resize' ? { shiftKey: event.shiftKey } : {}),
            current: release,
            moved: active.moved || Math.hypot(release.x - active.start.x, release.y - active.start.y) > 3,
          }
        : active;
      gestureRef.current = null;
      setGesture(null);
      if (root.current?.hasPointerCapture(event.pointerId))
        root.current.releasePointerCapture(event.pointerId);
      if (!cancelled)
        attempt(() => {
          const p = current.current.props,
            a = p.adapter;
          if (g.kind === "move" && !g.moved && g.clickSelection) p.onSelect(g.clickSelection);
          if (g.kind === "move" && g.moved) {
            const delta = moveGeometry(g);
            const members = new Set(g.nodes.flatMap((n) => n.memberIds ?? []));
            const moves = g.nodes
              .filter(
                (n) =>
                  !members.has(n.id) &&
                  p.graph.nodes.some((live) => live.id === n.id),
              )
              .map((n) => ({
                id: n.id,
                x: n.x + delta.x,
                y: n.y + delta.y,
              }));
            const affected = new Set(g.nodes.flatMap(n => [n.id, ...(n.memberIds ?? [])]));
            const bounds = Object.fromEntries(g.origins.filter(n => affected.has(n.id)).map(n => [n.id, {
              x: n.x + delta.x,
              y: n.y + delta.y,
            }]));
            commitLayout(bounds, () => {
              if (p.onMove) return p.onMove(moves);
              a?.moveNodes(p.graph.id, moves);
            });
          }
          if (g.kind === "resize" && g.moved) {
            const next = resizeRect(
              g.node,
              { x: g.current.x - g.start.x, y: g.current.y - g.start.y },
              g.viewport.k,
              g.corner,
              g.node.type === "image"
                ? g.shiftKey
                : g.node.type === "video",
              resizeMinimum(g.node),
              g.snapToGrid ? GRID_SIZE / 2 : undefined,
            );
            commitLayout({ [g.node.id]: next }, () => {
              if (p.onResize) return p.onResize(g.node.id, next);
              a?.updateNode(p.graph.id, g.node.id, next);
            });
          }
          if (g.kind === "box" && !g.moved) p.onSelect(g.initial);
          if (g.kind === "pan") {
            suppressContext.current = g.moved;
            if (!g.moved && event.button !== 2) {
              p.onSelect([]);
              setSelectedEdge(null);
            }
          }
          if (g.kind === "link") {
            if (g.node.type === "execution" && g.port === "output") {
              p.onExecutionOutputs?.(g.node.id, g.moved ? world({ x: event.clientX, y: event.clientY }) : { x: g.node.x + g.node.width + 100, y: g.node.y }, { x: event.clientX, y: event.clientY });
              return;
            }
            const { point, other, blocked, padding } = linkDropTarget(g, {
              x: event.clientX,
              y: event.clientY,
            });
            if (blocked) return;
            if (other) {
              const source = g.port === "output" || g.port === "chain-output" ? g.node : other,
                dest = g.port === "input" || g.port === "chain-input" ? g.node : other;
              if (p.onConnect) p.onConnect(source.id, dest.id);
              else a?.connect(p.graph.id, source.id, dest.id);
            } else if (
              (g.port === "input" || g.port === "output") &&
              !p.graph.nodes.some((n) =>
                intersects(
                  { x: point.x, y: point.y, width: 0, height: 0 },
                  {
                    x: n.x - padding,
                    y: n.y - padding,
                    width: n.width + padding * 2,
                    height: n.height + padding * 2,
                  },
                ),
              )
            )
              p.onConnectCreate?.(
                g.node.id,
                point,
                { x: event.clientX, y: event.clientY },
                g.port,
              );
          }
        });
      setDraft({});
    }
    const pastePosition = () =>
      lastPointer.current ??
      screenToWorld({ x: size.width / 2, y: size.height / 2 }, viewport);
    const mapBounds = boundsOf(nodes, 500),
      mapScale = Math.min(240 / mapBounds.width, 160 / mapBounds.height);
    const mapViewport = {
      x: (240 - mapBounds.width * mapScale) / 2 - mapBounds.x * mapScale,
      y: (160 - mapBounds.height * mapScale) / 2 - mapBounds.y * mapScale,
      k: mapScale,
    };
    const visible = viewportRect(viewport, size);
    const navigateMap = (event: PE<SVGSVGElement>) => {
      const r = event.currentTarget.getBoundingClientRect();
      const p = screenToWorld(
        {
          x: ((event.clientX - r.left) * 240) / r.width,
          y: ((event.clientY - r.top) * 160) / r.height,
        },
        mapViewport,
      );
      const next = centerOn(p, size, current.current.viewport.k);
      if (event.type === 'pointermove') changeViewport(next);
      else animateViewport(next);
    };
    const hoveredLinkNode =
      gesture?.kind === "link" && !(gesture.node.type === "execution" && gesture.port === "output")
        ? linkDropTarget(gesture, gesture.current).other
        : undefined;
    const linkTarget =
      hoveredLinkNode &&
      gesture?.kind === "link" &&
      !(props.isNodeLocked?.(gesture.port === "output" || gesture.port === "chain-output" ? hoveredLinkNode.id : gesture.node.id) ?? props.adapter?.isNodeLocked(props.graph.id, gesture.port === "output" || gesture.port === "chain-output" ? hoveredLinkNode.id : gesture.node.id))
        ? hoveredLinkNode
        : undefined;
    return (
      <div
        ref={root}
        className={"owg-canvas " + (props.className ?? "")}
        data-theme={props.theme ?? "dark"}
        data-viewport-animating={viewportAnimating}
        tabIndex={0}
        role="region"
        aria-label={t("Work Graph")}
        data-tool={gesture?.kind === "pan" ? "grabbing" : effectiveTool}
        data-resizing={gesture?.kind === "resize" ? gesture.corner : undefined}
        onKeyDownCapture={(e) => {
          // Node content (including execution progress) may stop key bubbling.
          // Keep the shortcut available there without stealing text or control input.
          const target = element(e.target);
          if (e.repeat || e.defaultPrevented || e.nativeEvent.isComposing ||
            e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ||
            target?.closest('input,textarea,select,button:not([data-canvas-shortcut-surface]),a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],dialog,[role="dialog"],[role="alertdialog"]')) return;
          const targetId = target?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
          const previewTarget = props.graph.nodes.some(node => node.id === targetId && node.type === 'preview');
          // Read-only preview surfaces reserve Space for node activation,
          // even when their pointer interactions require an interactive wrapper.
          if (e.code === 'Space' && previewTarget) {
            e.preventDefault();
            e.stopPropagation();
            activateSelection();
            return;
          }
          if (e.key.toLowerCase() !== 'f') return;
          if (!current.current.props.graph.nodes.some(node => current.current.props.selectedIds.includes(node.id))) return;
          e.preventDefault();
          focusSelection();
        }}
        onPointerDownCapture={(e) => {
          // Draggable previews use down() for selection. Selecting here too
          // can make its additive toggle remove the node we just added.
          if (
            e.button !== 0 ||
            !interactive(e.target) ||
            element(e.target)?.closest('[data-canvas-link]') ||
            element(e.target)?.closest(
              ".owg-node-toolbar,.owg-node-panel,[data-port],[data-resize],[data-canvas-draggable]",
            )
          )
            return;
          const id = element(e.target)?.closest<HTMLElement>("[data-node-id]")
            ?.dataset.nodeId;
          if (id && !props.selectedIds.includes(id)) {
            props.onSelect(
              e.shiftKey || primaryModifier(e)
                ? [...props.selectedIds, id]
                : [id],
            );
            setSelectedEdge(null);
          }
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => finish(e)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={(e) => {
          if (gestureRef.current) finish(e, e.buttons !== 0);
        }}
        onDoubleClick={(e) => {
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const imagePreview = hit?.closest<HTMLButtonElement>(".ow-image-expand[data-canvas-draggable]");
          if (imagePreview) { imagePreview.click(); return; }
          if (interactive(hit)) return;
          const id =
            hit?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
          const n = props.graph.nodes.find((n) => n.id === id);
          if (n && props.shouldOpenNodeOnDoubleClick?.(n)) { props.onOpenNode?.(n); return; }
          // Pointer capture retargets double-clicks to the canvas, so focus the inline editor here.
          if (n?.type === "text" && !n.readonly) {
            hit
              ?.closest("[data-node-id]")
              ?.querySelector<HTMLTextAreaElement>("[data-canvas-text-editor]")
              ?.focus({ preventScroll: true });
            return;
          }
          if (n) props.onOpenNode?.(n);
          else if (!hit?.closest("[data-connection-id]"))
            props.onCreateMenu?.(world({ x: e.clientX, y: e.clientY }), {
              x: e.clientX,
              y: e.clientY,
            });
        }}
        onContextMenu={(e) => {
          if (interactive(e.target)) return;
          e.preventDefault();
          if (suppressContext.current) {
            suppressContext.current = false;
            return;
          }
          if (
            !element(e.target)?.closest("[data-node-id],[data-connection-id]")
          )
            props.onCreateMenu?.(world({ x: e.clientX, y: e.clientY }), {
              x: e.clientX,
              y: e.clientY,
            });
        }}
        onKeyDown={(e) => {
          if (interactive(e.target) || e.nativeEvent.isComposing) return;
          const mod = primaryModifier(e),
            key = e.key.toLowerCase();
          if (e.code === "Space") {
            e.preventDefault();
            activateSelection(!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey);
          }
          if (e.key === primaryKey) setModifierDown(true);
          if (e.key === "Escape") {
            gestureRef.current = null;
            setGesture(null);
            setDraft({});
            setSelectedEdge(null);
            props.onSelect([]);
          }
          if (
            (key === "delete" || key === "backspace") &&
            (selectedEdge || props.selectedIds.length)
          ) {
            e.preventDefault();
            attempt(() => {
              if (selectedEdge) {
                if (props.onDeleteEdge) props.onDeleteEdge(selectedEdge);
                else props.adapter?.disconnect(props.graph.id, selectedEdge);
                setSelectedEdge(null);
              } else {
                if (props.onDeleteNodes) props.onDeleteNodes(props.selectedIds);
                else
                  props.adapter?.deleteNodes(props.graph.id, props.selectedIds);
                props.onSelect([]);
              }
            });
          }
          if (mod && key === "g" && props.adapter) {
            e.preventDefault();
            attempt(() => {
              if (e.shiftKey) {
                for (const id of props.selectedIds) {
                  if (
                    props.graph.nodes.find((n) => n.id === id)?.type === "group"
                  )
                    props.adapter!.ungroupNodes(props.graph.id, [id]);
                }
                props.onSelect([]);
              } else {
                const group = props.adapter!.groupNodes(
                  props.graph.id,
                  props.selectedIds,
                );
                props.onSelect([group.id]);
              }
            });
          }
          if (mod && key === "a") {
            e.preventDefault();
            props.onSelect(props.graph.nodes.map((n) => n.id));
          }
          if (mod && (key === "z" || key === "y")) {
            const action =
              key === "y" || e.shiftKey ? props.onRedo : props.onUndo;
            if (action) {
              e.preventDefault();
              attempt(action);
            }
          }
        }}
        onCopy={(e) => {
          if (
            interactive(document.activeElement) ||
            (document.activeElement !== root.current &&
              interactive(e.target)) ||
            !props.selectedIds.length
          )
            return;
          e.preventDefault();
          const selected = props.graph.nodes.filter((n) =>
              props.selectedIds.includes(n.id),
            ),
            ids = new Set(selected.map((n) => n.id));
          const edges = props.graph.edges.filter(
            (edge) =>
              ids.has(edge.source) &&
              ids.has(edge.target) &&
              edge.kind !== "delivery" &&
              (edge.kind === "execution" || suppliesOutput(nodeById.get(edge.source)!)) &&
              acceptsInput(nodeById.get(edge.target)!),
          );
          e.clipboardData.setData(
            CLIPBOARD,
            JSON.stringify({ nodes: selected, edges }),
          );
          e.clipboardData.setData(
            "text/plain",
            selected.map((n) => n.content || n.title).join("\n\n"),
          );
        }}
        onPaste={(e) => {
          if (
            interactive(document.activeElement) ||
            (document.activeElement !== root.current && interactive(e.target))
          )
            return;
          const files = Array.from(e.clipboardData.files);
          const raw = e.clipboardData.getData(CLIPBOARD);
          const text = e.clipboardData.getData("text/plain");
          if (files.length && props.onImportFiles) {
            e.preventDefault();
            Promise.resolve(props.onImportFiles(files, pastePosition())).catch(
              report,
            );
            return;
          }
          if (raw && props.adapter) {
            e.preventDefault();
            attempt(() => {
              const data = JSON.parse(raw) as {
                nodes: WorkNode[];
                edges: WorkEdge[];
              };
              if (!Array.isArray(data.nodes) || !Array.isArray(data.edges))
                throw new Error("Invalid node clipboard");
              const copies = props.adapter!.pasteNodes(
                props.graph.id,
                data.nodes,
                data.edges,
                screenToWorld(
                  { x: size.width / 2, y: size.height / 2 },
                  viewport,
                ),
              );
              props.onSelect(copies.map((n) => n.id));
            });
            return;
          }
          if (text && (props.onPasteText || props.adapter)) {
            e.preventDefault();
            attempt(() => {
              if (props.onPasteText) props.onPasteText(text, pastePosition());
              else {
                const n = props.adapter!.createNode(props.graph.id, {
                  type: "text",
                  title: limitNodeTitle(text.trim()) || t("Pasted text"),
                  content: text,
                  ...pastePosition(),
                });
                props.onSelect([n.id]);
              }
            });
          }
        }}
        onDragOver={(e) => {
          const targetNodeId = element(e.target)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
          const custom = props.onDropData && props.canDropData?.(e.dataTransfer, targetNodeId);
          if (!props.readOnly && ((custom && (!interactive(e.target) || !!targetNodeId)) || (!interactive(e.target) && props.onImportFiles && Array.from(e.dataTransfer.types).includes('Files')))) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          if (props.readOnly) return;
          const targetNodeId = element(e.target)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
          if (props.onDropData && props.canDropData?.(e.dataTransfer, targetNodeId)) {
            e.preventDefault();
            props.onDropData(e.dataTransfer, world({ x: e.clientX, y: e.clientY }), targetNodeId);
            return;
          }
          if (interactive(e.target)) return;
          if (!props.onImportFiles) return;
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files);
          if (files.length)
            Promise.resolve(
              props.onImportFiles(files, world({ x: e.clientX, y: e.clientY })),
            ).catch(report);
        }}
      >
        <div
          className={"owg-grid " + (props.backgroundMode ?? "lines")}
          style={{
            backgroundSize: GRID_SIZE * viewport.k + "px " + GRID_SIZE * viewport.k + "px",
            backgroundPosition: viewport.x + "px " + viewport.y + "px",
          }}
        />
        <div
          className="owg-world"
          style={{
            transform:
              "translate(" +
              viewport.x +
              "px," +
              viewport.y +
              "px) scale(" +
              viewport.k +
              ")",
          }}
        >
          <svg className="owg-connections" aria-label={t("Node connections")}>
            {props.graph.edges.map((edge) => {
              const a = nodeById.get(edge.source),
                b = nodeById.get(edge.target);
              if (!a || !b) return null;
              const d = connectionPath(edge.kind === "execution" ? chainOutputPort(a) : outputPort(a), edge.kind === "execution" ? chainInputPort(b) : inputPort(b), edge.kind === "execution" ? 'vertical' : 'horizontal');
              return (
                <g
                  key={edge.id}
                  className={[
                    selectedEdge === edge.id ? "selected" : "",
                    selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target) ? "node-connected" : "",
                  ].filter(Boolean).join(" ")}
                >
                  {edge.kind === "delivery" && (
                    <title>{t("Task output: hiding an artifact disconnects it; show it again from the output folder")}</title>
                  )}
                  <path
                    data-connection-id={edge.id}
                    data-connection-kind={edge.kind ?? "reference"}
                    className="owg-edge-hit"
                    d={d}
                  />
                  <path className={"owg-edge" + (edge.kind === "execution" ? " execution-chain" : "")} d={d} />
                </g>
              );
            })}
            {gesture?.kind === "link" && (
              <path
              className={"owg-link-preview" + (gesture.port === "chain-input" || gesture.port === "chain-output" ? " execution-chain" : "")}
                d={
                  gesture.port === "output" || gesture.port === "chain-output"
                    ? connectionPath(
                        gesture.port === "chain-output" ? chainOutputPort(gesture.node) : outputPort(gesture.node),
                        linkTarget
                          ? gesture.port === "chain-output" ? chainInputPort(linkTarget) : inputPort(linkTarget)
                          : world(gesture.current),
                        gesture.port === "chain-output" ? 'vertical' : 'horizontal',
                      )
                    : connectionPath(
                        linkTarget
                          ? gesture.port === "chain-input" ? chainOutputPort(linkTarget) : outputPort(linkTarget)
                          : world(gesture.current),
                        gesture.port === "chain-input" ? chainInputPort(gesture.node) : inputPort(gesture.node),
                        gesture.port === "chain-input" ? 'vertical' : 'horizontal',
                      )
                }
              />
            )}
          </svg>
          {nodes.map(node => <CanvasNode key={node.id} node={node} canvasProps={props}
            nodeRenderer={nodeRenderer} nodeRenderKey={props.nodeRenderKey ? props.nodeRenderKey(node) : props.renderNode}
            groupDropTarget={dropGroups.has(node.id)} linkTargetId={linkTarget?.id}
            linkPort={gesture?.kind === 'link' ? gesture.port : undefined} />)}
          {/* Keep controls outside node stacking contexts, including groups at z-index -1. */}
          {toolbarNode && props.renderToolbar && (
            <div
              className="owg-node-toolbar"
              data-canvas-interactive
              style={{
                left: toolbarNode.x + toolbarNode.width / 2,
                top: toolbarNode.y - 40 / viewport.k,
                transform: "translate(-50%, -100%) scale(" + 1 / viewport.k + ")",
                transformOrigin: "bottom center",
              }}
            >
              {props.renderToolbar(toolbarNode)}
            </div>
          )}
          {gesture?.kind === "box" && gesture.moved && (
            <div
              className="owg-selection-box"
              style={{
                ...(() => {
                  const r = rectFromPoints(
                    world(gesture.start),
                    world(gesture.current),
                  );
                  return {
                    left: r.x,
                    top: r.y,
                    width: r.width,
                    height: r.height,
                  };
                })(),
              }}
            />
          )}
        </div>
        <div
          className={
            "owg-zoom-controls" +
            (!props.tool || props.showZoomButtons ? " owg-zoom-expanded" : "")
          }
          data-canvas-no-zoom
        >
          {!props.tool && (
            <>
              <button
                aria-label={t("Select tool")}
                title={t("Select tool")}
                aria-pressed={localTool === "select"}
                onClick={() => setLocalTool("select")}
              >
                <MousePointer2 size={16} />
              </button>
              <button
                aria-label={t("Pan tool")}
                title={t("Pan tool")}
                aria-pressed={localTool === "pan"}
                onClick={() => setLocalTool("pan")}
              >
                <Hand size={16} />
              </button>
              <span className="owg-divider" />
            </>
          )}
          {props.showZoomButtons && (
            <button
              aria-label={t("Zoom out")}
              disabled={viewport.k <= 0.05}
              onClick={() =>
                zoomViewport(targetZoom() / 1.2)
              }
            >
              <Minus size={16} />
            </button>
          )}
          <input
            className="owg-zoom-range"
            type="range"
            aria-label={t("Zoom percentage")}
            min={5}
            max={500}
            step={1}
            value={Math.round(targetZoom() * 100)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              cancelViewportAnimation();
              zoomRangePointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, value: Number(e.currentTarget.value), dragging: false };
            }}
            onPointerMove={(e) => {
              const pointer = zoomRangePointer.current;
              if (!pointer || pointer.id !== e.pointerId || pointer.dragging) return;
              if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 3) return;
              pointer.dragging = true;
              directZoomViewport(pointer.value / 100);
            }}
            onPointerUp={(e) => {
              const pointer = zoomRangePointer.current;
              if (!pointer || pointer.id !== e.pointerId) return;
              zoomRangePointer.current = null;
              const scale = pointer.value / 100;
              if (pointer.dragging) directZoomViewport(scale);
              else if (scale !== current.current.viewport.k) zoomViewport(scale);
            }}
            onPointerCancel={(e) => {
              if (zoomRangePointer.current?.id !== e.pointerId) return;
              zoomRangePointer.current = null;
              e.currentTarget.value = String(Math.round(current.current.viewport.k * 100));
            }}
            onChange={(e) => {
              const scale = Number(e.currentTarget.value) / 100;
              const pointer = zoomRangePointer.current;
              if (pointer) {
                pointer.value = Number(e.currentTarget.value);
                if (!pointer.dragging) return;
                directZoomViewport(scale);
              } else zoomViewport(scale);
            }}
          />
          <button
            className="owg-zoom-value"
            title={t("Reset to 100%")}
            onClick={() =>
              zoomViewport(1)
            }
          >
            {Math.round(viewport.k * 100)}%
          </button>
          {props.showZoomButtons && (
            <button
              aria-label={t("Zoom in")}
              disabled={viewport.k >= 5}
              onClick={() =>
                zoomViewport(targetZoom() * 1.2)
              }
            >
              <Plus size={16} />
            </button>
          )}
          <span className="owg-divider" />
          <button aria-label={t("Fit all nodes")} title={t("Fit all nodes")} onClick={fit}>
            <Maximize size={16} />
          </button>
          <button
            aria-label={t("Toggle minimap")}
            title={t("Minimap")}
            aria-pressed={minimap}
            onClick={() => setMinimap(!minimap)}
          >
            <MapIcon size={16} />
          </button>
          <button
            aria-label={t("Return to Work Graph origin")}
            title={t("Return to Work Graph origin")}
            onClick={() => animateViewport(centerOn({ x: 0, y: 0 }, size, 1))}
          >
            <LocateFixed size={16} />
          </button>
          <button
            aria-label={t("Keyboard shortcut help")}
            title={t("Keyboard shortcuts")}
            aria-haspopup="dialog"
            aria-expanded={shortcutsOpen}
            onClick={() => setShortcutsOpen(true)}
          >
            <CircleHelp size={16} />
          </button>
        </div>
        {shortcutsOpen && (
          <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />
        )}
        {minimap && (
          <svg
            className="owg-minimap"
            data-canvas-no-zoom
            viewBox="0 0 240 160"
            aria-label={t("Work Graph minimap")}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              navigateMap(e);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                navigateMap(e);
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          >
            <g
              transform={
                "translate(" +
                mapViewport.x +
                "," +
                mapViewport.y +
                ") scale(" +
                mapScale +
                ")"
              }
            >
              {nodes.map((n) => (
                <rect
                  key={n.id}
                  x={n.x}
                  y={n.y}
                  width={n.width}
                  height={n.height}
                  className={
                    "owg-map-node " +
                    (n.type === "execution" ? "execution" : "")
                  }
                />
              ))}
              <rect
                {...visible}
                className="owg-map-viewport"
                strokeWidth={1 / mapScale}
              />
            </g>
          </svg>
        )}
      </div>
    );
  },
);
export default Canvas;
