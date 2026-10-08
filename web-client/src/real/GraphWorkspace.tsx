import { PreviewDialogHeading, PreviewDialogLayers, visibleDialogControls, type PreviewDialogNavigation } from '../components/PreviewDialogStack';
import { MarkdownPreview, MarkdownPreviewProvider } from './MarkdownPreview';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import { useRunProgress, useRunPrompts, useInputChanges } from "./use-run-progress";
import { NodeRunInteractions } from './NodeRunInteractions';
import { PromptEditor } from "../components/RunPanels";
import { syncSkillReferences } from "./project-file-mentions";
import type { SkillReference } from "../../../packages/protocol/src/skills";
import { DocumentDialog } from "../components/DocumentDialog";
import { LinkedVideoPreview, LinkedFilePreview, PreviewNode, ProjectFilePreview, ResourceFilePreview } from "./PreviewNode";
import { previewFormat, previewMode, type PreviewMode } from './preview-formats';
import { VideoNodeSummary } from './VideoNodeSummary';
import { ExecutionOutputList } from "./ExecutionOutputList";
import { Toast } from './Toast';
import { WorkspaceRestartHint } from './WorkspaceRestartHint';
import { WifiOff } from 'lucide-react';
import { createPortal } from "react-dom";
import { getNodeDefinition } from "../components/node-registry";
import { NodeOutline } from '../components/NodeOutline';
import { runStatusLabels } from "./notifications";
import type { RecentGraph } from './recent-graphs';
import { randomId } from "../adapter/random";
import { canDropAsset, dropAsset } from './asset-drag';
import { canDropProjectFile, dropProjectFile } from './project-file-drag';
import { isBoundProjectFileReference, isEmptyProjectFileReference, isProjectFileReference, projectFileSource } from './project-file-reference';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Eye, Hand, MousePointer2, Maximize, Undo2, Redo2, Type, Settings2, Image, Upload, Replace, FolderPlus, Group, Ungroup, Grid2X2, Search, X, Plus, Trash2, Copy, FileText, File as FileIcon, Menu, Home, Download, Clock3, ChevronRight, Link2, Square, LoaderCircle, CircleAlert, Lock } from "lucide-react";
import { FILE_NODE_MAX_BYTES, PROJECT_FILE_PREVIEW_MAX_BYTES, fileMime, formatFileSize, importedNodeType } from '../domain/file-types';
import { TextContent, RunSummary, DocumentCard, ContentPlaceholder } from "../components/NodeContent";
import { Canvas, type CanvasHandle } from "../canvas/Canvas";
import { readViewport, saveViewport, viewportStorageKey } from "./viewport-storage";
import { primaryModifier } from "../canvas/primary-modifier";
import { markdownLinkTarget } from './markdown-link-target';
import { markdownImageCache } from './markdown-image-cache';
import { useI18n } from '../i18n/I18nProvider';
import type { WorkGraph, WorkNode } from "../domain/types";
import type {
  GraphOperation,
  GraphSnapshot,
  Json,
  Request,
  Run,
  ModelDefaults,
} from "./contracts";
import type { ImageGenerationOptions, ImageProvider, ImageRoute } from '../../../packages/protocol/src/index';
import { graphPath, messageOf } from "./contracts";
import { GraphEditor, type Draft } from "./editor";
import {
  uploadCanvas,
  createResourceUpload,
  CanvasResourcePreview,
  CanvasProjectFilePreview,
  type CanvasCreated,
} from "./ResourcesPanel";
import { RealPluginView } from "./plugin-views";
import {
  assertLayoutEditable,
  assertGeometryEditable,
  createGroupOperation,
  defaultNodeSize,
  groupMembersOperation,
  moveWithMembershipOperations,
  groupRenameOperation,
  nodeBounds,
  resizeWithMembershipOperations,
  textCopyContent,
  ungroupOperations,
} from "./graph-layout";
import { GraphHistory } from "./graph-history";
import { outputPlacement } from "./output-placement";
import { PasteQueue } from "./paste-queue";
import {
  IMAGE_RATIOS,
  IMAGE_SCALES,
  chooseDeclaredImageSize,
  declaredImageSizes,
  imageRatiosForModel,
  imageScalesForModel,
  inferImageScale,
  modelAllowsCustomImageSize,
  nearestImageRatio,
  normalizeImageOptionsForModel,
  parseImageDimensions,
  presetImageSize,
  validateCustomImageSize,
} from './image-generation-options';
import {
  assertResourcePasteTarget,
  encodeNodeClipboard,
  planNodePaste,
  parseNodeClipboard,
  createResourcePasteJob,
  REAL_NODE_CLIPBOARD,
  LEGACY_NODE_CLIPBOARD,
} from "./graph-clipboard";
type MarkdownLinkedFile = { id: number; sourcePath: string; name: string; mime: string; bytes: number; base64?: string; contentPath?: string; scope: 'project' | 'run'; relativePath?: string };
const object = (value: Json): Record<string, Json> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hasProjectFileSource = isBoundProjectFileReference;
const independentContent = (value: Json): Record<string, Json> => { const content = { ...object(value) }; delete content.source; delete content.observation; return content; };
function DocumentNodeContent({ node, wire, request, imageRequest, imageRevision, onOpenLink }: { node: WorkNode; wire: GraphSnapshot["nodes"][number]; request: Request; imageRequest: Request; imageRevision: number; onOpenLink: (href: string, sourcePath?: string) => void }) {
  const content = object(wire.content);
  const resourceId = typeof content.resourceId === 'string' ? content.resourceId : '';
  if (!resourceId) return <div className="node-content"><DocumentCard node={node} onOpenLink={onOpenLink} imageRequest={imageRequest} imageRevision={imageRevision}/></div>;
  return <ResourceDocumentNodeContent node={node} wire={wire} request={request} imageRequest={imageRequest} imageRevision={imageRevision} resourceId={resourceId} onOpenLink={onOpenLink}/>;
}
function ResourceDocumentNodeContent({ node, wire, request, imageRequest, imageRevision, resourceId, onOpenLink }: { node: WorkNode; wire: GraphSnapshot["nodes"][number]; request: Request; imageRequest: Request; imageRevision: number; resourceId: string; onOpenLink: (href: string, sourcePath?: string) => void }) {
  const {t} = useI18n();
  const content = object(wire.content);
  const resourceVersion = Number(content.resourceVersion);
  const [retry,setRetry] = useState(0);
  const [representation,setRepresentation] = useState<{state:'loading'|'ready'|'failed';text?:string;reason?:string}>({state:'loading'});
  useEffect(() => {
    let active = true;
    setRepresentation({state:'loading'});
    const path = graphPath(node.projectId,node.graphId) + '/resources/' + encodeURIComponent(resourceId) + '/versions/' + resourceVersion + '/representation';
    void request<{state:string;text:string|null;reason:string|null}>(path).then(value => {
      if (!active) return;
      if (value.state === 'ready') setRepresentation({state:'ready',text:value.text ?? ''});
      else setRepresentation({state:'failed',reason:value.reason || undefined});
    }).catch(error => { if (active) setRepresentation({state:'failed',reason:messageOf(error)}); });
    return () => { active = false; };
  }, [request,node.projectId,node.graphId,resourceId,resourceVersion,wire.contentVersion,retry]);
  if (representation.state === 'loading') return <div className="node-content ow-document-state" role="status">{t('Reading document…')}</div>;
  if (representation.state === 'failed') return <div className="node-content ow-document-state" role="status"><span>{representation.reason || t('The document is still being processed. Try again later.')}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry preview')}</button></div>;
  return <div className="node-content"><DocumentCard node={{...node,content:representation.text ?? ''}} onOpenLink={onOpenLink} imageRequest={imageRequest} imageRevision={imageRevision}/></div>;
}
function ProjectFileContent({ request, projectId, source, mime, name, compact = false, node, onError, onDetach, refreshKey = 0, onOpenLink }: { request: Request; projectId: string; source: Record<string, Json>; mime: string; name: string; compact?: boolean; node?: WorkNode; onError?: (error: unknown) => void; onDetach?: (text: string) => Promise<void>; refreshKey?: number; onOpenLink?: (href: string, sourcePath?: string) => void }) {
  const {t} = useI18n();
  const [value, setValue] = useState<{ state: 'loading' | 'ready' | 'missing' | 'unavailable' | 'too-large'; data?: string; error?: string }>({ state:'loading' });
  const [draft, setDraft] = useState<string>();
  const [detachError, setDetachError] = useState('');
  const [retry, setRetry] = useState(0);
  const detachTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const path = String(source.relativePath ?? '');
  useEffect(() => {
    let live = true; setValue({ state:'loading' }); setDraft(undefined); setDetachError('');
    const base = '/v1/projects/' + encodeURIComponent(projectId) + '/files';
    const query = new URLSearchParams({ path });
    void request<Array<{ state:'available'|'missing'|'unavailable'; bytes:number|null }>>(base + '/stat', { paths:[path] }, 'POST').then(async ([status]) => {
      if (!live) return;
      if (!status || status.state !== 'available') { setValue({ state:status?.state === 'missing' ? 'missing' : 'unavailable' }); return; }
      if (typeof status.bytes === 'number' && status.bytes > PROJECT_FILE_PREVIEW_MAX_BYTES) { setValue({ state:'too-large' }); return; }
      const result = await request<{ base64:string }>(base + '/content?' + query);
      if (live) setValue({ state:'ready', data:result.base64 });
    }).catch(error => { if (live) setValue({ state:'unavailable', error:messageOf(error) }); });
    return () => { live = false; clearTimeout(detachTimer.current); };
  }, [request, projectId, path, refreshKey, retry]);
  if (value.state === 'loading') return <p className="muted">{t('Reading {path}…', {path})}</p>;
  if (value.state === 'missing') return <div className="ow-project-reference-empty"><strong>{name}</strong><span>{path}</span><span>{t('The project file no longer exists. Its reference and connections are preserved.')}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{t('Check again')}</button></div>;
  if (value.state === 'too-large') return <div className="ow-project-reference-empty"><strong>{name}</strong><span>{path}</span><span>{t('The file exceeds 50 MiB and cannot be previewed. Reduce its size and try again.')}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry reading')}</button></div>;
  if (value.state === 'unavailable') return <div className="ow-project-reference-empty"><strong>{name}</strong><span>{path}</span><span>{value.error || t('The project file is currently unavailable. Check the workspace or project directory.')}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry reading')}</button></div>;
  if (mime.startsWith('image/')) return <div className="ow-project-reference-preview"><img src={'data:' + mime + ';base64,' + value.data} alt={name} onContextMenu={e => e.preventDefault()}/><small>{path}</small></div>;
  if (mime.startsWith('text/') || ['application/json','application/xml','application/yaml'].includes(mime)) {
    const bytes = Uint8Array.from(atob(value.data ?? ''), character => character.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (compact && node) {
      const visible = draft ?? text;
      return <div className="node-content real-text-content"><TextContent node={{...node,content:visible,readonly:node.readonly || !onDetach}} onChange={next => {
        setDraft(next); setDetachError(''); clearTimeout(detachTimer.current);
        detachTimer.current = setTimeout(() => { void onDetach?.(next).catch(error => { const message=messageOf(error); setDetachError(message); onError?.(error); }); }, 250);
      }} allowNodeOpenOnDoubleClick onError={onError ?? (() => undefined)}/>{detachError && <span className="ow-project-reference-edit-error" role="alert">{detachError}</span>}</div>;
    }
    return <div><MarkdownPreview sourcePath={path} text={draft ?? text} onOpenLink={onOpenLink}/><hr/><small>{path}</small></div>;
  }
  return <div className="ow-project-reference-empty"><FileIcon size={32}/><strong>{name}</strong><span>{path}</span></div>;
}
interface CanvasUploadJob {
  replacement?: { nodeId: string; version: number; content: Json; type: string };
  id: string;
  file: File;
  position: { x: number; y: number };
  progress: number;
  state: "uploading" | "failed" | "saved";
  error?: string;
  created?: CanvasCreated;
  text?: string;
  transferredFile?: File;
  place?: () => Promise<GraphSnapshot>;
}
export interface GraphWorkspaceProps {
  projectName?: string;
  graphActions?: (closeMenu: () => void) => ReactNode;
  recentGraphs?: RecentGraph[];
  onOpenRecent?: (graph: RecentGraph) => void;
  onLibrary?: () => void;
  onHome?: () => void;
  onNew?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  serviceRequest?: Request;
  modelsAvailable?: boolean;
  modelRefreshToken?: number;
  assetsAvailable?: boolean;
  executionReason?: string;
  imageReason?: string;
  onOpenRun?: (run?: Run) => void;
  onRunSubmitted?: (run: Run) => void;
  theme?: "light" | "dark";
  sidebarTarget?: HTMLElement | null;
  toastTarget?: HTMLElement | null;
  temporary?: boolean;
  uploadFile?: (file: File) => Promise<CanvasCreated>;
  onPlaceProjectFile?: (relativePath: string) => void | Promise<void>;
  request: Request;
  graph: GraphSnapshot;
  online: boolean;
  runtimeUnavailable?: boolean;
  projectActive: boolean;
  runs: Run[];
  refreshToken: number;
  onChanged: () => void;
  onAssetsChanged?: () => void;
  onOpenProjectDirectory?: (path: string) => void;
  onCanvas?: (handle: CanvasHandle | null) => void;
  onError: (e: unknown) => void;
  onEditor?: (editor: GraphEditor | undefined) => void;
  executionAvailable: boolean;
  imageAvailable: boolean;
  locateNodeId?: string;
  editExecutionNode?: {nodeId:string;graphId:string;projectId:string;nonce:number};
}
export function GraphWorkspace(props: GraphWorkspaceProps) {
  const {t} = useI18n();
  useEffect(() => {
    const preventBrowserZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    // Cover toolbars and portal dialogs while preserving their own zoom handlers.
    window.addEventListener('wheel', preventBrowserZoom, {passive:false,capture:true});
    return () => window.removeEventListener('wheel', preventBrowserZoom, true);
  }, []);
  const viewportKey = viewportStorageKey(!!props.temporary, props.graph.serviceId, props.graph.projectId, props.graph.graphId);
  const [mainMenu, setMainMenu] = useState(false);
  const [recentMenu, setRecentMenu] = useState<{ left: number; top: number }>();
  const mainMenuTrigger = useRef<HTMLButtonElement>(null);
  const mainMenuPanel = useRef<HTMLElement>(null);
  const recentMenuPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (!mainMenu) setRecentMenu(undefined); }, [mainMenu]);
  useEffect(() => { if (recentMenu) recentMenuPanel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [recentMenu]);
  useEffect(() => {
    if (!mainMenu) return;
    mainMenuPanel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [mainMenu]);
  useEffect(() => {
    if (!mainMenu) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') {
      if (recentMenu) { setRecentMenu(undefined); mainMenuPanel.current?.querySelector<HTMLButtonElement>('.graph-recent-trigger')?.focus(); }
      else { setMainMenu(false); mainMenuTrigger.current?.focus(); }
    } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [mainMenu, recentMenu]);
  const [editor] = useState(
    () => new GraphEditor(props.request, props.graph, localStorage),
  );
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const state = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
    editor.getSnapshot,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [models, setModels] = useState<ModelDefaults>();
  const [imageProviders,setImageProviders] = useState<ImageProvider[]>([]);
  const showModelControls = !props.temporary;
  const [imageSettingsOpen,setImageSettingsOpen] = useState(false);
  const [snapImageDimensions,setSnapImageDimensions] = useState(true);
  const [imagePreview,setImagePreview] = useState<{nodeId:string;hasImage:boolean;issues:string[]} | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [referenceId, setReferenceId] = useState<string>();
  const [markdownLinkedFiles, setMarkdownLinkedFiles] = useState<MarkdownLinkedFile[]>([]);
  const markdownLinkedFile = markdownLinkedFiles.at(-1);
  const [markdownLinkPending, setMarkdownLinkPending] = useState(false);
  const [copyingMarkdownLinkedFile,setCopyingMarkdownLinkedFile] = useState(false);
  const markdownLinkRequest = useRef(0);
  const [externalLink, setExternalLink] = useState<string>();
  const [confirmRunNodeId, setConfirmRunNodeId] = useState<string>();
  const [confirmUndoRunIds, setConfirmUndoRunIds] = useState<string[]>();
  const [stoppingUndoRuns, setStoppingUndoRuns] = useState(false);
  const undoRunDialog = useRef<HTMLElement>(null);
  useEffect(()=>{
    if (!confirmUndoRunIds) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    undoRunDialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  },[confirmUndoRunIds]);
  const submittedNodeKeys = useRef(new Set<string>());
  const [generatedOutputNodeId, setGeneratedOutputNodeId] = useState<string>();
  const resourceSaveKeys = useRef(new Map<string, string>());
  const projectFileSaveKeys = useRef(new Map<string, string>());
  const projectFileCopyJobs = useRef(new Map<string, { signature:string; idempotencyKey:string; created?:CanvasCreated; place?:()=>Promise<GraphSnapshot> }>());
  const projectFileDetachKeys = useRef(new Map<string, string>());
  const textAssetJobs = useRef(new Map<string, ReturnType<typeof createResourceUpload>>());
  const textAssetBusy = useRef(new Set<string>());
  const [savingTextAssets, setSavingTextAssets] = useState(new Set<string>());
  const [running, setRunning] = useState(false);
  const [resourceDocument, setResourceDocument] = useState<{ id: string; version: number; text: string }>();
  const [promptProjectFile, setPromptProjectFile] = useState<{ path: string; name: string }>();
  const [documentId, setDocumentId] = useState<string>();
  const [documentPreviewId, setDocumentPreviewId] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [createMenu, setCreateMenu] = useState<{ world: { x: number; y: number }; screen: { x: number; y: number }; connection?: { nodeId: string; port: "input" | "output" }; preferAbove?: boolean }>();
  const createMenuElement = useRef<HTMLDivElement>(null);
  const [createMenuPosition, setCreateMenuPosition] = useState<{ left: number; top: number }>();
  const [outputMenu, setOutputMenu] = useState<{ nodeId: string; world: { x: number; y: number }; screen: { x: number; y: number } }>();
  useEffect(() => {
    if (!outputMenu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOutputMenu(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [outputMenu]);
  useEffect(() => {
    if (!createMenu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setCreateMenu(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [createMenu]);
  useLayoutEffect(() => {
    if (!createMenu) { setCreateMenuPosition(undefined); return; }
    const place = () => {
      const menu = createMenuElement.current;
      if (!menu) return;
      const margin = 12, gap = 8;
      const bounds = menu.getBoundingClientRect();
      const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin);
      const left = Math.max(margin, Math.min(createMenu.screen.x, maxLeft));
      const below = createMenu.screen.y;
      const above = createMenu.screen.y - bounds.height - gap;
      let top: number;
      if (createMenu.preferAbove) top = above;
      else if (below + bounds.height <= window.innerHeight - margin) top = below;
      else if (above >= margin) top = above;
      else top = below;
      setCreateMenuPosition({ left, top: Math.max(margin, Math.min(top, maxTop)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [createMenu]);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState<"select" | "pan">("pan");
  const [background, setBackground] = useState<"lines" | "dots" | "blank">("lines");
  const [uploads, setUploads] = useState<CanvasUploadJob[]>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [pasteQueue] = useState(() => new PasteQueue());
  const pasteState = useSyncExternalStore(pasteQueue.subscribe, pasteQueue.getSnapshot, pasteQueue.getSnapshot);
  const reportedEditorError = useRef('');
  const reportedPasteError = useRef('');
  useEffect(() => {
    if (!state.error) { reportedEditorError.current = ''; return; }
    if (pasteState.count > 0) { reportedEditorError.current = state.error; return; }
    if (reportedEditorError.current !== state.error) {
      reportedEditorError.current = state.error;
      props.onError(new Error(state.error));
    }
  }, [state.error, pasteState.count, props.onError]);
  useEffect(() => {
    if (!pasteState.error) { reportedPasteError.current = ''; return; }
    if (reportedPasteError.current !== pasteState.error) {
      reportedPasteError.current = pasteState.error;
      props.onError(new Error(t('Paste failed: {error}', {error:pasteState.error})));
    }
  }, [pasteState.error, props.onError]);
  const pasteEpoch = useRef(0);
  const pasteScope = JSON.stringify([
    props.graph.serviceId,
    props.graph.projectId,
    props.graph.graphId,
    props.online,
    props.projectActive,
    state.online,
    state.graph.archived,
    state.graph.trashed,
  ]);
  const priorPasteScope = useRef(pasteScope);
  // Fence as soon as new props are rendered, before passive effects can run.
  if (priorPasteScope.current !== pasteScope) {
    priorPasteScope.current = pasteScope;
    ++pasteEpoch.current;
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++pasteEpoch.current;
    };
  }, []);
  useEffect(
    () =>
      editor.subscribe(() => {
        // Also capture synchronous offline→online transitions between renders.
        if (!editor.getSnapshot().online) ++pasteEpoch.current;
      }),
    [editor],
  );
  const canvas = useRef<CanvasHandle>(null);
  const attachCanvas = useCallback((handle: CanvasHandle | null) => {
    canvas.current = handle;
    props.onCanvas?.(handle);
  }, [props.onCanvas]);
  const workspaceElement = useRef<HTMLElement>(null);
  const dockElement = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const workspace = workspaceElement.current, dock = dockElement.current;
    const surface = workspace?.querySelector<HTMLElement>('.owg-canvas');
    const zoom = workspace?.querySelector<HTMLElement>('.owg-zoom-controls');
    if (!workspace || !dock || !surface || !zoom) return;
    const position = () => {
      const area = surface.getBoundingClientRect(), parent = workspace.getBoundingClientRect();
      const controls = zoom.getBoundingClientRect(), width = dock.getBoundingClientRect().width;
      const center = area.left + area.width / 2, left = center - width / 2;
      const overlaps = left < controls.right + 12 && left + width > controls.left - 12;
      dock.style.setProperty('--dock-center', (center - parent.left) + 'px');
      dock.style.setProperty('--dock-bottom', (overlaps ? parent.bottom - controls.top + 12 : parent.bottom - area.bottom + 20) + 'px');
    };
    position();
    const observer = new ResizeObserver(position);
    for (const element of [workspace, surface, dock, zoom]) observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const file = useRef<HTMLInputElement>(null);
  const replacement = useRef<CanvasUploadJob["replacement"]>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [history] = useState(
    () =>
      new GraphHistory(
        props.request,
        () => {
          const current = editor.getSnapshot(),
            graph = current.graph;
          return {
            graph,
            online:
              current.online &&
              latest.current.online &&
              latest.current.projectActive,
            busy: current.busy,
            queued: current.busy,
            drafts: current.drafts.length,
            active: latest.current.runs.some(
              (r) =>
                r.serviceId === graph.serviceId &&
                r.projectId === graph.projectId &&
                r.graphId === graph.graphId &&
                !["succeeded", "failed", "cancelled", "interrupted"].includes(
                  r.status,
                ),
            ),
          };
        },
        async (committed) => {
          if (committed) editor.acceptCommitted(committed);
          else await editor.refresh();
        },
        undefined,
        (() => { try { return window.localStorage; } catch { return undefined; } })(),
      ),
  );
  const historyState = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const runStamp = JSON.stringify(
    props.runs
      .filter(
        (r) =>
          r.serviceId === props.graph.serviceId &&
          r.projectId === props.graph.projectId &&
          r.graphId === props.graph.graphId,
      )
      .map((r) => [r.id, r.status]),
  );
  useEffect(() => {
    history.queuedCommit = operations => editor.command(operations);
    history.queuedTravel = direction => editor.travelHistory(direction);
    const unsubscribeCommands = editor.subscribeCommands(({ before, after, operations }) => history.recordCommitted(before, after, operations));
    history.observe();
    const unsubscribe = editor.subscribe(history.observe);
    return () => { unsubscribe(); unsubscribeCommands(); history.queuedCommit = undefined; history.queuedTravel = undefined; };
  }, [editor, history]);
  useEffect(() => {
    // Loading already-completed runs after a refresh does not change the
    // document. Active runs and graph revision changes are checked by observe.
    history.observe();
  }, [history, props.online, props.projectActive, runStamp]);
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    props.onEditor?.(editor);
    return () => {
      props.onEditor?.(undefined);
      disposeTimer.current = setTimeout(() => {
        pasteQueue.dispose();
        // Connection restoration can switch storage before the UI navigation callback.
        // Finish local drafts without keeping a second canvas mounted.
        if (props.temporary && editor.getSnapshot().drafts.length) {
          void editor.flush().catch(props.onError).finally(() => editor.dispose());
        } else editor.dispose();
      }, 0);
    };
  }, [editor]);
  useEffect(() => {
    // Reconcile the authoritative snapshot before enabling history; the
    // editor may still contain the older session cache used during startup.
    if (props.online && !editor.getSnapshot().online) editor.acceptCommitted(props.graph);
    // A transient transport failure must not cancel the queue's bounded retries.
    // Project deactivation and editor disposal still cancel pending work.
    editor.setOnline(props.online && props.projectActive, !props.projectActive);
  }, [editor, props.online, props.projectActive]);
  useEffect(() => {
    if (props.online) void editor.refresh().catch(props.onError);
  }, [editor, props.refreshToken, props.online]);
  useEffect(() => {
    let live = true; setModels(undefined);
    if (!showModelControls || props.modelsAvailable === false) return;
    void (props.serviceRequest ?? props.request)<ModelDefaults>("/v1/models").then(value => { if (live) setModels(value); }).catch(error => { if (live) props.onError(error); });
    return () => { live = false; };
  }, [props.serviceRequest, props.request, props.modelsAvailable, props.modelRefreshToken, showModelControls]);
  useEffect(() => {
    let live=true;
    if (!showModelControls) { setImageProviders([]); return; }
    void (props.serviceRequest ?? props.request)<ImageProvider[]>('/v1/image-providers').then(value=>{if(live)setImageProviders(value);}).catch(()=>{if(live)setImageProviders([]);});
    return ()=>{live=false;};
  },[props.serviceRequest,props.request,props.refreshToken,showModelControls]);
  const g = state.graph;
  const [projectFilesRevision, setProjectFilesRevision] = useState(0);
  const wasOnline = useRef(props.online);
  useEffect(() => {
    const reconnected = props.online && !wasOnline.current;
    wasOnline.current = props.online;
    if (!reconnected) return;
    // File changes while disconnected may have been missed, and failed image reads need a retry.
    markdownImageCache.invalidateProject(g.projectId);
    setProjectFilesRevision(value => value + 1);
  }, [props.online, g.projectId]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId === g.projectId) setProjectFilesRevision(value => value + 1);
    };
    window.addEventListener('openworkgraph:project-files-changed', changed);
    return () => window.removeEventListener('openworkgraph:project-files-changed', changed);
  }, [g.projectId]);
  const projectFileReferenceIds = new Set(g.nodes.flatMap(node => isProjectFileReference(node.content) ? [node.id] : []));
  const [legacyFileSizes, setLegacyFileSizes] = useState<Record<string, { key: string; bytes: number }>>({});
  const legacyFileTargets = g.nodes.flatMap(node => {
    const content = object(node.content);
    if (node.type !== 'file' || typeof content.resourceId !== 'string' || !Number.isSafeInteger(content.resourceVersion) || (typeof content.bytes === 'number' && Number.isSafeInteger(content.bytes) && content.bytes >= 0)) return [];
    return [{ nodeId: node.id, key: [node.contentVersion, content.resourceId, content.resourceVersion].join(':'), resourceId: content.resourceId, version: Number(content.resourceVersion) }];
  });
  const legacyFileTargetStamp = JSON.stringify(legacyFileTargets);
  useEffect(() => {
    let live = true;
    void Promise.all(legacyFileTargets.map(async target => {
      try {
        const metadata = await props.request<{ bytes: number }>(graphPath(g.projectId, g.graphId) + '/resources/' + encodeURIComponent(target.resourceId) + '/versions/' + target.version);
        return Number.isSafeInteger(metadata.bytes) && metadata.bytes >= 0 ? { ...target, bytes: metadata.bytes } : undefined;
      } catch { return undefined; }
    })).then(results => {
      if (!live) return;
      setLegacyFileSizes(Object.fromEntries(results.filter(result => result !== undefined).map(result => [result.nodeId, { key: result.key, bytes: result.bytes }])));
    });
    return () => { live = false; };
  }, [props.request, g.projectId, g.graphId, legacyFileTargetStamp]);
  const [titleDraft, setTitleDraft] = useState<string>();
  const [titleSaving, setTitleSaving] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const titleEditActive = useRef(false);
  const titleSavePending = useRef(false);
  const editingTitle = titleDraft !== undefined;
  useLayoutEffect(() => {
    if (editingTitle) { titleInput.current?.focus(); titleInput.current?.select(); }
  }, [editingTitle]);
  const locked = (id: string) =>
    props.runs.some(
      (r) =>
        r.serviceId === g.serviceId &&
        r.projectId === g.projectId &&
        r.graphId === g.graphId &&
        r.nodeId === id &&
        !["succeeded", "failed", "cancelled", "interrupted"].includes(r.status),
    );
  const documentReadOnly =
    !props.online ||
    !props.projectActive ||
    !state.online ||
    g.archived ||
    Boolean((g as GraphSnapshot & { trashed?: boolean }).trashed);
  const uploading = uploads.some(job => job.state === 'uploading');
  const readOnly = documentReadOnly || historyState.busy || stoppingUndoRuns || uploading;
  const closePreviewDialogs = () => {
    markdownLinkRequest.current++;
    setMarkdownLinkedFiles([]);
    setMarkdownLinkPending(false);
    setCopyingMarkdownLinkedFile(false);
    setReferenceId(undefined);
    setDocumentId(undefined);
    setDocumentPreviewId(undefined);
    setPromptProjectFile(undefined);
    setGeneratedOutputNodeId(undefined);
  };
  const backMarkdownPreview = () => {
    markdownLinkRequest.current++;
    setMarkdownLinkPending(false);
    setCopyingMarkdownLinkedFile(false);
    setMarkdownLinkedFiles(files => files.slice(0, -1));
  };
  const openMarkdownLink = useCallback((href: string, sourcePath?: string) => {
    const target = markdownLinkTarget(href, sourcePath);
    if (target.kind === 'external') setExternalLink(target.url);
    else if (target.kind === 'file') {
      const requestId = ++markdownLinkRequest.current;
      setMarkdownLinkPending(true);
      setCopyingMarkdownLinkedFile(false);
      void (props.serviceRequest ?? props.request)<{name:string;mime:string;bytes:number;base64?:string;contentPath?:string;scope:'project'|'run';relativePath?:string}>(
        '/v1/projects/' + encodeURIComponent(g.projectId) + '/files/link-preview',
        {path:target.path,streamVideo:true},
        'POST',
      ).then(file => { if (requestId === markdownLinkRequest.current) setMarkdownLinkedFiles(files => [...files, { ...file, id: requestId, sourcePath: file.scope === 'project' && file.relativePath ? file.relativePath : target.path }]); })
        .catch(() => { if (requestId === markdownLinkRequest.current) props.onError(new Error(t('Unable to view this file.'))); })
        .finally(() => { if (requestId === markdownLinkRequest.current) setMarkdownLinkPending(false); });
    }
  }, [props.serviceRequest, props.request, props.onError, g.projectId, t]);
  useEffect(() => {
    markdownLinkRequest.current++;
    setMarkdownLinkedFiles([]);
    setMarkdownLinkPending(false);
    setCopyingMarkdownLinkedFile(false);
  }, [g.serviceId, g.projectId, g.graphId]);
  useEffect(() => {
    titleEditActive.current = false;
    setTitleDraft(undefined);
  }, [readOnly, g.serviceId, g.projectId, g.graphId]);
  useEffect(() => () => { markdownLinkRequest.current++; }, []);
  const beginTitleEdit = () => {
    if (readOnly || titleSavePending.current) return;
    titleEditActive.current = true;
    setTitleDraft(g.title);
  };
  const saveTitle = async () => {
    if (!titleEditActive.current || titleSavePending.current || readOnly) return;
    const title = titleDraft?.trim();
    if (!title) { titleInput.current?.setCustomValidity(t('Enter a Work Graph name.')); titleInput.current?.reportValidity(); titleInput.current?.focus(); return; }
    if (title === editor.getSnapshot().graph.title) { titleEditActive.current = false; setTitleDraft(undefined); return; }
    titleSavePending.current = true; setTitleSaving(true);
    try {
      await editor.command([{ type: 'graph.rename', title }]);
      if (!mounted.current) return;
      titleEditActive.current = false; setTitleDraft(undefined);
      latest.current.onChanged();
    } catch (error) {
      if (mounted.current) latest.current.onError(error);
    } finally {
      titleSavePending.current = false;
      if (mounted.current) setTitleSaving(false);
    }
  };
  const toWorkNode = (n: GraphSnapshot["nodes"][number]): WorkNode => {
    const d = state.drafts.find((d) => d.nodeId === n.id);
    const c = object(d?.content ?? n.content);
    return {
      id: n.id,
      nodeId: n.id,
      serviceId: g.serviceId,
      projectId: g.projectId,
      graphId: g.graphId,
      type: n.type,
      title: String(c.title ?? (n.type === "execution" ? t('Execution task') : n.type)),
      x: n.x,
      y: n.y,
      width: nodeBounds(n).width,
      height: nodeBounds(n).height,
      ...(n.type === "group" && n.schemaVersion === 1
        ? { memberIds: [...(n.memberIds ?? [])] }
        : {}),
      content: String(c.text ?? ""),
      prompt: String(c.prompt ?? ""),
      summary: String(c.summary ?? ""),
      readonly: n.readOnly || documentReadOnly,
      contentRevision: n.contentVersion,
    };
  };
  const work: WorkGraph = useMemo(() => ({
    id: g.graphId,
    serviceId: g.serviceId,
    projectId: g.projectId,
    graphId: g.graphId,
    name: g.title,
    revision: g.executionRevision,
    edges: g.edges.map((e) => ({
      ...g,
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      ...(e.kind === "delivery" ? { kind: "delivery" as const } : e.kind === "execution" ? { kind: "execution" as const } : {}),
    })),
    nodes: g.nodes.map(toWorkNode),
  }), [g, readOnly, state.drafts, t]);
  const node = g.nodes.find((n) => n.id === selected[0]);
  useEffect(() => {
    if(node?.type!=='image'||isProjectFileReference(node.content)||!props.online){setImagePreview(null);return;}
    let live=true;
    setImagePreview(null);
    void props.request<{resources:{kind:string;resource?:unknown}[];issues:{reason:string}[]}>(graphPath(g.projectId,g.graphId)+'/input-preview',{nodeId:node.id,excludeFiles:object(object(node.content).imageRoute).type==='api'},'POST').then(value=>{
      if(live)setImagePreview({nodeId:node.id,hasImage:value.resources.some(item=>item.kind==='image'&&!!item.resource),issues:value.issues.map(item=>item.reason)});
    }).catch(()=>{if(live)setImagePreview({nodeId:node.id,hasImage:false,issues:[t('Failed to read frozen reference images. Refresh the Work Graph.')]});});
    return ()=>{live=false;};
  },[node?.id,node?.type,node?.contentVersion,g.executionRevision,g.projectId,g.graphId,props.online,props.request]);
  const graphRuns = useMemo(
    () => props.runs.filter(r => r.serviceId === g.serviceId && r.projectId === g.projectId && r.graphId === g.graphId),
    [props.runs, g.serviceId, g.projectId, g.graphId],
  );
  const activeChainBatches = new Set(graphRuns.filter(run => run.chainBatch && !["succeeded", "failed", "cancelled", "interrupted"].includes(run.status)).map(run => run.chainBatch!));
  const activeChainNodeIds = new Set(graphRuns.filter(run => run.chainBatch && activeChainBatches.has(run.chainBatch)).map(run => run.nodeId));
  const chainTopologyError = t('Running chain members and their execution connections cannot be deleted or changed. Stop the full schedule and let it finish first.');
  const activeChainExecutionEdge = (edge: { sourceId: string; targetId: string; kind?: string }) => edge.kind === "execution" && (activeChainNodeIds.has(edge.sourceId) || activeChainNodeIds.has(edge.targetId));
  const [acknowledgedFailures, setAcknowledgedFailures] = useState<ReadonlySet<string>>(() => new Set());
  const latestNodeRuns = useMemo(() => {
    const latest = new Map<string, Run>();
    for (const run of graphRuns) {
      const previous = latest.get(run.nodeId);
      if (!previous || BigInt(run.submissionSequence ?? '0') >= BigInt(previous.submissionSequence ?? '0')) latest.set(run.nodeId, run);
    }
    return latest;
  }, [graphRuns]);
  const failureKey = (run: Run) => JSON.stringify([run.serviceId, run.projectId, run.graphId, run.id]);
  const acknowledgeNodeFailure = (id: string) => {
    const run = latestNodeRuns.get(id);
    if (run?.status !== 'failed') return;
    const key = failureKey(run);
    setAcknowledgedFailures(previous => previous.has(key) ? previous : new Set([...previous, key]));
  };
  const selectNodes = (ids: string[]) => {
    setConfirmRunNodeId(undefined);
    setSelectionRevision(revision => revision + 1);
    setSelected(ids);
    props.onOpenRun?.(ids.length === 1 ? graphRuns.filter(r => r.nodeId === ids[0]).at(-1) : undefined);
    if (ids.length === 1) {
      const selectedNode = g.nodes.find(item => item.id === ids[0]);
      if (selectedNode?.type === "execution") {
        setDetailsOpen(true);
      }
    }
  };
  useEffect(()=>{
    const target=props.editExecutionNode;
    if(!target||target.graphId!==g.graphId||target.projectId!==g.projectId)return;
    setSelected([target.nodeId]);setDetailsOpen(true);canvas.current?.locate(target.nodeId);
  },[props.editExecutionNode,g.graphId,g.projectId]);
  const progress = useRunProgress(props.request, graphRuns, props.online, props.refreshToken);
  const submittedPrompts = useRunPrompts(props.request, graphRuns, props.online, props.refreshToken);
  const nodeRenderKeys = useMemo(() => new Map(g.nodes.map(wire => {
    const run = latestNodeRuns.get(wire.id);
    const runProgress = run ? progress[run.id] : undefined;
    const legacySize = legacyFileSizes[wire.id];
    return [wire.id, JSON.stringify([
      wire.contentVersion,
      readOnly,
      wire.readOnly,
      projectFilesRevision,
      legacySize?.key,
      legacySize?.bytes,
      run?.id,
      run?.status,
      runProgress?.summaries,
      runProgress?.error,
      run ? submittedPrompts[run.id] : undefined,
    ])] as const;
  })), [g.nodes, latestNodeRuns, progress, submittedPrompts, legacyFileSizes, projectFilesRevision, readOnly]);
  const selectedRun = graphRuns.filter(r => r.nodeId === node?.id).at(-1);
  const inputChanged = useInputChanges(props.request, selectedRun, props.online, g.executionRevision);
  const draft = state.drafts.find((d) => d.nodeId === node?.id);
  const content = object(draft?.content ?? node?.content ?? {});
  const savedRoute=object(content.imageRoute ?? null);
  const savedImageOptions=object(savedRoute.options ?? null);
  const imageOptions:ImageGenerationOptions={
    quality:['auto','high','medium','low'].includes(String(savedImageOptions.quality))?savedImageOptions.quality as ImageGenerationOptions['quality']:'auto',
    size:typeof savedImageOptions.size==='string'?savedImageOptions.size:'auto',
    aspectRatio:typeof savedImageOptions.aspectRatio==='string'?savedImageOptions.aspectRatio:'auto',
  };
  const selectedRoute:ImageRoute=savedRoute.type==='api' && typeof savedRoute.providerId==='string' && typeof savedRoute.modelId==='string'
    ? {type:'api',providerId:savedRoute.providerId,modelId:savedRoute.modelId,options:imageOptions}:{type:'codex',options:imageOptions};
  useEffect(() => {
    setGroupTitle(String(content.title ?? t('Group')));
  }, [node?.id, node?.content]);
  const overrideJson = JSON.stringify(content.modelOverride ?? null);
  useEffect(() => {
    const override = object(content.modelOverride ?? null);
    setModel(typeof override.model === "string" ? override.model : "");
    setEffort(
      typeof override.reasoningEffort === "string"
        ? override.reasoningEffort
        : "",
    );
    setReferenceId(current => current === node?.id ? current : undefined);
  }, [node?.id, overrideJson]);
  const act = (fn: () => unknown | Promise<unknown>) => {
    try {
      void Promise.resolve(fn()).catch(props.onError);
    } catch (e) {
      props.onError(e);
    }
  };
  const saveImageRoute=(route:ImageRoute)=>node&&act(()=>editor.edit(node.id,{...content,imageRoute:route as unknown as Json}));
  const previewModeProps = (wire: GraphSnapshot['nodes'][number]) => {
    const effective = object(state.drafts.find(draft => draft.nodeId === wire.id)?.content ?? wire.content);
    return {
      preferredMode: previewMode(effective.previewMode),
      ...(!readOnly && !wire.readOnly && !locked(wire.id) ? { onModeChange: (mode: PreviewMode) => act(() => {
        const current = editor.getSnapshot();
        const target = current.graph.nodes.find(item => item.id === wire.id);
        if (!target) throw Error(t('The preview node was removed.'));
        const draft = current.drafts.find(item => item.nodeId === wire.id);
        editor.edit(wire.id, { ...object(draft?.content ?? target.content), previewMode: mode });
      }) } : {}),
    };
  };
  const saveTextAsset = async (nodeId: string) => {
    if (readOnly || props.assetsAvailable === false || textAssetBusy.current.has(nodeId)) return;
    let job = textAssetJobs.current.get(nodeId);
    if (!job) {
      const snapshot = editor.getSnapshot();
      const source = snapshot.graph.nodes.find(item => item.id === nodeId);
      if (source?.type !== 'text') return;
      const value = object(snapshot.drafts.find(item => item.nodeId === nodeId)?.content ?? source.content);
      const title = String(value.title ?? '').trim() || t('Work Graph text');
      const safeTitle = title.replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 240);
      const name = /\.txt$/i.test(safeTitle) ? safeTitle : safeTitle + '.txt';
      const file = new File([String(value.text ?? '')], name, { type: 'text/plain' });
      job = createResourceUpload(props.serviceRequest ?? props.request, g.projectId, file, { mode: 'new', name });
      textAssetJobs.current.set(nodeId, job);
    }
    textAssetBusy.current.add(nodeId);
    setSavingTextAssets(new Set(textAssetBusy.current));
    try {
      await job.run();
      textAssetJobs.current.delete(nodeId);
      if (mounted.current) { props.onAssetsChanged?.(); props.onChanged(); }
    } catch (error) {
      throw Error(t('Failed to save the text asset: {error}. Click save again to retry the original text copy.', {error:messageOf(error)}));
    } finally {
      textAssetBusy.current.delete(nodeId);
      if (mounted.current) setSavingTextAssets(new Set(textAssetBusy.current));
    }
  };
  const saveProjectFileAsset = async (nodeId: string) => {
    if (readOnly || props.assetsAvailable === false) return;
    const current = editor.getSnapshot().graph.nodes.find(item => item.id === nodeId);
    if (!current) return;
    const value = object(current.content);
    const source = object(value.source);
    if (source.kind !== 'project-file') return;
    const relativePath = String(source.relativePath ?? '');
    if (!relativePath) throw Error(t('The project file reference is missing a relative path.'));
    const request = props.serviceRequest ?? props.request;
    const [status] = await request<Array<{path:string;state:'available'|'missing'|'unavailable';bytes:number|null;changeToken:string|null}>>(
      '/v1/projects/' + encodeURIComponent(g.projectId) + '/files/stat',
      { paths: [relativePath] },
    );
    if (!status || status.state !== 'available') throw Error(status?.state === 'missing' ? t('The project file no longer exists and cannot be added to the asset library.') : t('The project file is currently unavailable and cannot be added to the asset library.'));
    if (status.bytes === null || !Number.isSafeInteger(status.bytes) || status.bytes < 0) throw Error(t('Unable to determine the project file size, so it cannot be added to the asset library.'));
    if (status.bytes > FILE_NODE_MAX_BYTES) throw Error(t('The file exceeds 300 MB and cannot be added to the asset library.'));
    const title = String(value.title ?? relativePath.split('/').at(-1) ?? t('Project file'));
    const key = JSON.stringify([g.projectId, relativePath, status.changeToken, title]);
    const idempotencyKey = projectFileSaveKeys.current.get(key) ?? randomId();
    projectFileSaveKeys.current.set(key, idempotencyKey);
    await request('/v1/projects/' + encodeURIComponent(g.projectId) + '/assets/import-file', {
      path: relativePath,
      mime: String(value.mime ?? 'application/octet-stream'),
      name: title,
      idempotencyKey,
    });
    projectFileSaveKeys.current.delete(key);
    props.onAssetsChanged?.();
    props.onChanged();
  };
  const copyProjectFileToResourceNode = async (nodeId: string) => {
    if (readOnly) return;
    const current = editor.getSnapshot().graph;
    const reference = current.nodes.find(item => item.id === nodeId);
    if (!reference) return;
    const value = object(reference.content);
    const source = object(value.source);
    if (source.kind !== 'project-file') return;
    const relativePath = String(source.relativePath ?? '');
    if (!relativePath) throw Error(t('The project file reference is missing a relative path.'));
    const title = String(value.title ?? relativePath.split('/').at(-1) ?? t('Project file'));
    const mime = String(value.mime ?? 'application/octet-stream');
    const [status] = await (props.serviceRequest ?? props.request)<Array<{state:'available'|'missing'|'unavailable';bytes:number|null;changeToken:string|null}>>(
      '/v1/projects/' + encodeURIComponent(current.projectId) + '/files/stat',
      { paths:[relativePath] },
    );
    if (!status || status.state !== 'available') throw Error(status?.state === 'missing' ? t('The project file no longer exists and cannot be copied as a resource node.') : t('The project file is currently unavailable and cannot be copied as a resource node.'));
    if (status.bytes === null || !Number.isSafeInteger(status.bytes) || status.bytes < 0) throw Error(t('Unable to determine the project file size, so it cannot be copied as a resource node.'));
    if (status.bytes > FILE_NODE_MAX_BYTES) throw Error(t('The file exceeds 300 MB and cannot be copied as a resource node.'));
    if (reference.type === 'text' && status.bytes > 8 * 1024 * 1024) throw Error(t('The text file exceeds the node content limit of 8 MiB.'));
    const signature = JSON.stringify([current.serviceId,current.projectId,current.graphId,nodeId,reference.contentVersion,relativePath,status.changeToken,title,mime]);
    let job = projectFileCopyJobs.current.get(nodeId);
    if (job && job.signature !== signature) { projectFileCopyJobs.current.delete(nodeId); job = undefined; }
    if (!job) {
      job = { signature, idempotencyKey:randomId() };
      projectFileCopyJobs.current.set(nodeId,job);
    }
    job.created ??= await props.request<CanvasCreated>(graphPath(current.projectId,current.graphId) + '/resources/import-file', {
      path:relativePath, mime, name:title, idempotencyKey:job.idempotencyKey,
    });
    const created = job.created;
    const nodeType = importedNodeType(created.resource.name,created.resource.current.mime);
    const representation = nodeType === 'text'
      ? await props.request<{state:string;text:string|null}>(graphPath(current.projectId,current.graphId) + '/resources/' + encodeURIComponent(created.resource.id) + '/versions/' + created.resource.current.version + '/representation')
      : undefined;
    if (nodeType === 'text' && (representation?.state !== 'ready' || representation.text === null || new TextEncoder().encode(representation.text).length > 8 * 1024 * 1024)) throw Error(t('The text resource cannot be copied as a text node. The maximum size is 8 MiB.'));
    job.place ??= editor.prepareCommand([{
      type:'node.create',
      node:{
        id:randomId(), type:nodeType, schemaVersion:1, contentVersion:1,
        content:{ title:created.resource.name, text:representation?.text ?? '', prompt:'', resourceId:created.resource.id, resourceVersion:created.resource.current.version, mime:created.resource.current.mime, ...(nodeType === 'file' ? { bytes:created.resource.current.bytes } : {}) },
        x:reference.x + 40, y:reference.y + 40, width:reference.width, height:reference.height, readOnly:false,
      },
    }]);
    const placed = await job.place();
    projectFileCopyJobs.current.delete(nodeId);
    const copied = placed.nodes.find(item => item.content && object(item.content).resourceId === created.resource.id);
    if (copied) selectNodes([copied.id]);
    props.onChanged();
  };
  const associateProjectFile = async (nodeId: string, relativePath: string) => {
    const current = editor.getSnapshot().graph;
    const target = current.nodes.find(item => item.id === nodeId);
    if (!target || !isEmptyProjectFileReference(target.content)) throw Error(t('The target node is not an empty reference node.'));
    const idempotencyKey = randomId();
    const marker: GraphOperation = { type:'node.project-file.associate', nodeId, expectedContentVersion:target.contentVersion, nodeType:target.type as 'text'|'image'|'file', content:structuredClone(target.content) };
    const commit = history.prepareCommand([marker], async () => {
      const committed = await (props.serviceRequest ?? props.request)<GraphSnapshot>(graphPath(current.projectId, current.graphId) + '/project-files/associate', {
        path:relativePath, nodeId, expectedContentVersion:target.contentVersion, expectedExecutionRevision:current.executionRevision, expectedLayoutRevision:current.layoutRevision, idempotencyKey,
      });
      editor.acceptCommitted(committed);
      return committed;
    });
    await commit(); props.onChanged();
  };
  const detachProjectFileText = async (nodeId: string, text: string) => {
    const current = editor.getSnapshot().graph;
    const target = current.nodes.find(item => item.id === nodeId);
    const content = object(target?.content ?? null), source = object(content.source), observation = object(content.observation);
    if (!target || target.type !== 'text' || source.kind !== 'project-file' || typeof observation.changeToken !== 'string') throw Error(t('The reference source changed. Reopen it before editing.'));
    const key = JSON.stringify([nodeId,target.contentVersion,observation.changeToken,text]);
    const idempotencyKey = projectFileDetachKeys.current.get(key) ?? randomId();
    projectFileDetachKeys.current.set(key,idempotencyKey);
    const committed = await (props.serviceRequest ?? props.request)<GraphSnapshot>(graphPath(current.projectId,current.graphId) + '/nodes/' + encodeURIComponent(nodeId) + '/detach', {
      expectedContentVersion:target.contentVersion, expectedExecutionRevision:current.executionRevision, expectedLayoutRevision:current.layoutRevision,
      expectedObservationToken:observation.changeToken, content:{ ...independentContent(content), text }, idempotencyKey,
    });
    projectFileDetachKeys.current.delete(key);
    editor.acceptCommitted(committed); props.onChanged();
  };
  const saveImageOptions=(patch:Partial<ImageGenerationOptions>)=>saveImageRoute({...selectedRoute,options:{...imageOptions,...patch}});
  const command = async (ops: Parameters<GraphEditor["command"]>[0]) => {
    if (!latest.current.online || !latest.current.projectActive)
      throw Error(t('The current Work Graph is read-only.'));
    await editor.command(history.prepareOperations(ops));
    latest.current.onChanged();
  };
  const guardLayout = (ids: string[]) => {
    if (!mounted.current) throw Error(t('The Work Graph changed. Remaining operations were stopped.'));
    if (history.getSnapshot().busy) throw Error(t('Wait for the current Work Graph operation to finish.'));
    const current = editor.getSnapshot();
    assertLayoutEditable(
      current.graph,
      ids,
      !current.online ||
        !latest.current.online ||
        !latest.current.projectActive,
      (id) =>
        latest.current.runs.some(
          (r) =>
            r.serviceId === current.graph.serviceId &&
            r.projectId === current.graph.projectId &&
            r.graphId === current.graph.graphId &&
            r.nodeId === id &&
            !["succeeded", "failed", "cancelled", "interrupted"].includes(
              r.status,
            ),
        ),
    );
  };
  const guardGeometry = (ids: string[]) => {
    if (!mounted.current) throw Error(t('The Work Graph changed. Remaining operations were stopped.'));
    if (history.getSnapshot().busy)
      throw Error(t('Wait for the current Work Graph operation to finish.'));
    const current = editor.getSnapshot();
    assertGeometryEditable(current.graph, ids, !current.online || !latest.current.online || !latest.current.projectActive);
  };
  const canGeometry = (ids: string[]) => { try { guardGeometry(ids); return true; } catch { return false; } };
  const expandedOutputIds = new Set(g.edges.filter(edge => edge.kind === "delivery").map(edge => edge.targetId));
  const guardDelete = (ids: string[]) => {
    if (ids.some(id => !expandedOutputIds.has(id) && (activeChainNodeIds.has(id) || g.edges.some(edge => (edge.sourceId === id || edge.targetId === id) && activeChainExecutionEdge(edge))))) throw Error(chainTopologyError);
    const graph = editor.getSnapshot().graph;
    guardGeometry(ids.filter(id => graph.nodes.find(node => node.id === id)?.type === 'group'));
    guardLayout(ids.filter(id => graph.nodes.find(node => node.id === id)?.type !== 'group'));
    for (const edge of editor.getSnapshot().graph.edges) {
      if (!ids.includes(edge.sourceId)) continue;
      if (locked(edge.targetId)) throw Error(t('The downstream task has not finished, so its reference content cannot be deleted.'));
      if (edge.kind === "delivery" && !ids.includes(edge.targetId)) throw Error(t('Hide or select all outputs of this task first.'));
    }
  };
  const canDelete = (ids: string[]) => { try { guardDelete(ids); return true; } catch { return false; } };
  const groupSelection = async () => {
    guardGeometry(selected);
    const id = randomId();
    await command([
      createGroupOperation(editor.getSnapshot().graph, selected, id),
    ]);
    selectNodes([id]);
  };
  const ungroupSelection = async () => {
    guardGeometry(selected);
    const current = editor.getSnapshot().graph;
    const members = current.nodes
      .filter((n) => selected.includes(n.id))
      .flatMap((n) => n.memberIds ?? []);
    await command(ungroupOperations(current, selected));
    setSelected([...new Set(members)]);
  };
  const selectedGroups = g.nodes.filter(
    (n) =>
      selected.includes(n.id) && n.type === "group" && n.schemaVersion === 1,
  );
  const selectedMembers = selected.filter(
    (id) => !selectedGroups.some((n) => n.id === id),
  );
  const updateMembers = async (remove: boolean) => {
    if (selectedGroups.length !== 1 || !selectedMembers.length)
      throw Error(t('Select one group and its member nodes.'));
    const groupId = selectedGroups[0].id;
    guardGeometry([groupId, ...selectedMembers]);
    const current = editor.getSnapshot().graph;
    const oldMembers =
      current.nodes.find((n) => n.id === groupId)?.memberIds ?? [];
    const members = remove
      ? oldMembers.filter((id) => !selectedMembers.includes(id))
      : [...new Set([...oldMembers, ...selectedMembers])];
    await command([groupMembersOperation(current, groupId, members)]);
  };
  const renameGroup = async () => {
    if (!node || node.type !== "group" || node.schemaVersion !== 1) return;
    if (groupTitle === String(object(node.content).title ?? t('Group'))) return;
    guardGeometry([node.id]);
    await command([groupRenameOperation(node.id, groupTitle)]);
  };
  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey ||
          !primaryModifier(event) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (event.repeat) return;
      if (!props.online || !props.projectActive || !editor.getSnapshot().online ||
          editor.getSnapshot().graph.archived || editor.getSnapshot().graph.trashed) return;
      void (async () => {
        if (titleEditActive.current) await saveTitle();
        if (event.target instanceof HTMLElement && event.target.getAttribute('aria-label') === t('Group name')) await renameGroup();
        await editor.flush();
      })().catch(props.onError);
    };
    window.addEventListener('keydown', saveShortcut, true);
    return () => window.removeEventListener('keydown', saveShortcut, true);
  });
  let canGroup = !!selected.length && canGeometry(selected);
  if (canGroup) {
    try {
      createGroupOperation(g, selected, "validation-only");
    } catch {
      canGroup = false;
    }
  }
  const canUngroup =
    !!selected.length &&
    selectedGroups.length === selected.length &&
    canGeometry(selected);
  let canCopyText = false;
  if (node && !locked(node.id)) {
    try {
      textCopyContent(node, content);
      canCopyText = true;
    } catch {
      /* Resource/plugin identities must not be cloned here. */
    }
  }
  const create = async (
    type: string,
    text = "",
    position: { x: number; y: number } | undefined = undefined,
    extra: Record<string, Json> = {},
    connection?: { nodeId: string; port: "input" | "output" },
  ) => {
    if (connection && activeChainNodeIds.has(connection.nodeId))
      throw Error(chainTopologyError);
    const size = defaultNodeSize(type);
    const placement = position ?? canvas.current?.getPlacementPosition(size) ?? { x: 80, y: 80 };
    const id = randomId();
    await command([
      {
        type: "node.create",
        node: {
          id,
          type,
          schemaVersion: 1,
          contentVersion: 1,
          content: {
            title: type === "execution" ? t('Execution task') : t('New {type}', {type:getNodeDefinition(type).title}),
            text,
            prompt: "",
            ...extra,
          },
          ...(["preview", "execution"].includes(type) ? size : {}),
          ...placement,
          readOnly: false,
        },
      },
      ...(connection ? [{ type: "edge.create" as const, edge: { id: randomId(), sourceId: connection.port === "output" ? connection.nodeId : id, targetId: connection.port === "output" ? id : connection.nodeId, kind: "reference" as const } }] : []),
    ]);
    selectNodes([id]);
    setDetailsOpen(true);
    return id;
  };
  const resumeUpload = async (job: CanvasUploadJob, prepareOnly = false): Promise<Parameters<GraphEditor["command"]>[0] | undefined> => {
    guardLayout([]);
    const update = () =>
      setUploads((jobs) => jobs.map((j) => (j.id === job.id ? { ...job } : j)));
    job.state = "uploading";
    job.error = undefined;
    update();
    try {
      const detectedType = importedNodeType(job.file.name, fileMime(job.file));
      const intended = job.replacement?.type === 'file' ? 'file' : detectedType;
      if (job.file.size > FILE_NODE_MAX_BYTES) throw Error(t('File nodes support up to 300 MB.'));
      if (intended === 'text' && job.file.size > 8 * 1024 * 1024) throw Error(t('The text file exceeds the node content limit of 8 MiB.'));
      if (intended === 'text') job.text ??= await job.file.text();
      // Unknown browser MIME types are stored as octet-stream, never trusted as active content.
      const normalizedMime = detectedType === 'file' && !['application/pdf','video/mp4','video/webm'].includes(fileMime(job.file)) ? 'application/octet-stream' : fileMime(job.file);
      const uploadFile = job.transferredFile ??= job.file.type !== normalizedMime
        ? new File([job.file], job.file.name, {type:normalizedMime}) : job.file;
      job.created ??= props.uploadFile ? await props.uploadFile(uploadFile) : await uploadCanvas(
        props.request,
        g.projectId,
        g.graphId,
        uploadFile,
        (progress) => {
          job.progress = progress;
          update();
        },
      );
      const resource = job.created.resource;
      guardLayout([]);
      const mime = resource.current.mime;
      if (job.replacement && !job.place) {
        guardLayout([]);
        const target = editor.getSnapshot().graph.nodes.find(n => n.id === job.replacement!.nodeId);
        if (!target || target.readOnly || target.contentVersion !== job.replacement.version || state.drafts.some(d => d.nodeId === target.id)) throw Error(t('The original node changed. Select the replacement file again.'));
        if (job.replacement.type !== 'file' && !mime.startsWith(job.replacement.type + '/')) throw Error(t('Select a file that matches the node type.'));
      }
      const operations: Parameters<GraphEditor["command"]>[0] = job.replacement ? [{ type: "node.content", nodeId: job.replacement.nodeId, expectedContentVersion: job.replacement.version, content: { ...independentContent(job.replacement.content), title: resource.name, resourceId: resource.id, resourceVersion: resource.current.version, mime, bytes: resource.current.bytes } }] : [
        {
          type: "node.create",
          node: {
            id: job.id,
            type: importedNodeType(resource.name, mime),
            schemaVersion: 1,
            contentVersion: 1,
            content: {
              title: resource.name,
              text: importedNodeType(resource.name, mime) === 'text' ? job.text ?? '' : '',
              prompt: "",
              resourceId: resource.id,
              resourceVersion: resource.current.version,
              mime,
              bytes: resource.current.bytes,
            },
            ...job.position,
            readOnly: false,
          },
        },
      ];
      if (prepareOnly) return operations;
      job.place ??= editor.prepareCommand(operations);
      await job.place();
      job.state = "saved";
      update();
      setSelected([job.replacement?.nodeId ?? job.id]);
      latest.current.onChanged();
    } catch (error) {
      job.state = "failed";
      job.error = messageOf(error);
      update();
      throw error;
    }
  };
  const upload = async (files: File[], position = { x: 100, y: 100 }) => {
    if (!files.length) return;
    if (readOnly) throw Error(t('The current Work Graph is read-only.'));
    if (files.length > 1000) throw Error(t('A batch can contain at most 1000 operations.'));
    const jobs: CanvasUploadJob[] = files.map((file,i)=>({id:randomId(),file,position:{x:position.x+40*i,y:position.y+40*i},progress:0,state:'uploading'}));
    setUploads(current=>[...current,...jobs]);
    if (jobs.length===1) { await resumeUpload(jobs[0]); return; }
    try {
      const operations: Parameters<GraphEditor["command"]>[0] = [];
      for (const job of jobs) operations.push(...(await resumeUpload(job,true))!);
      // All resources are prepared first; one acknowledged command places the batch.
      await command(operations);
      for (const job of jobs) job.state='saved';
      setUploads(current=>current.map(job=>jobs.find(item=>item.id===job.id) ?? job));
      setSelected(jobs.map(job=>job.id));
    } catch (error) {
      for (const job of jobs) {job.state='failed';job.error=messageOf(error);}
      setUploads(current=>current.map(job=>jobs.find(item=>item.id===job.id) ?? job));
      throw error;
    }
  };
  const copyMarkdownLinkedFileToGraph = async () => {
    const linked = markdownLinkedFile;
    if (!linked || copyingMarkdownLinkedFile) return;
    if (readOnly) throw Error(t('The current Work Graph is read-only.'));
    if (!Number.isSafeInteger(linked.bytes) || linked.bytes < 0) throw Error(t('Unable to determine the file size, so it cannot be copied to the Work Graph.'));
    if (linked.bytes > FILE_NODE_MAX_BYTES) throw Error(t('Files larger than 300 MB cannot be copied as resource nodes.'));
    const requestId = markdownLinkRequest.current;
    setCopyingMarkdownLinkedFile(true);
    try {
      const parts: BlobPart[] = [];
      if (linked.contentPath) {
        for (let start = 0; start < linked.bytes; start += 1024 * 1024) {
          const end = Math.min(start + 1024 * 1024 - 1, linked.bytes - 1);
          const result = await (props.serviceRequest ?? props.request)<{blob:Blob;start:number;end:number;total:number}>(linked.contentPath,undefined,'RANGE',{range:{start,end}});
          if (result.start !== start || result.end !== end || result.total !== linked.bytes || result.blob.size !== end-start+1) throw Error(t('The video changed while downloading.'));
          parts.push(result.blob);
        }
      } else {
        const bytes = Uint8Array.from(atob(linked.base64 ?? ''), character => character.charCodeAt(0));
        if (bytes.byteLength !== linked.bytes) throw Error(t('Unable to view this file.'));
        parts.push(bytes);
      }
      const file = new File(parts, linked.name, {type:linked.mime || 'application/octet-stream'});
      const nodeType = importedNodeType(file.name,fileMime(file));
      const position = canvas.current?.getPlacementPosition(defaultNodeSize(nodeType)) ?? {x:100,y:100};
      await upload([file],position);
      if (requestId === markdownLinkRequest.current) backMarkdownPreview();
    } finally { if (requestId === markdownLinkRequest.current) setCopyingMarkdownLinkedFile(false); }
  };
  const edit = (key: string, value: string) => {
    if (node)
      act(() => {
        if (key === "title") guardGeometry([node.id]);
        else guardLayout(key === "text" ? [] : [node.id]);
        if (node.type === "group") throw Error(t('Groups only support renaming and layout operations.'));
        editor.edit(node.id, { ...content, [key]: value });
      });
  };
  const travelHistory = async (redo: boolean) => {
    const currentHistory = history.getSnapshot();
    if (pasteQueue.getSnapshot().count || uploads.some(job=>job.state==='uploading') || currentHistory.busy || !(redo ? currentHistory.canRedo : currentHistory.canUndo)) return;
    const pending=editor.getSnapshot();
    if (!redo && currentHistory.undoRunIds.length && !pending.busy && !pending.drafts.length) {
      const runs=await Promise.all(currentHistory.undoRunIds.map(id=>latest.current.request<Run>('/v1/runs/'+encodeURIComponent(id))));
      const active=runs.filter(run=>!['succeeded','failed','cancelled','interrupted'].includes(run.status));
      if (active.length) { setConfirmUndoRunIds(active.map(run=>run.id)); return; }
      await editor.refresh();
    }
    guardLayout([]);
    await (redo ? history.redo() : history.undo());
    setSelected((ids) =>
      ids.filter((id) =>
        editor.getSnapshot().graph.nodes.some((n) => n.id === id),
      ),
    );
    latest.current.onChanged();
  };
  const confirmUndoRunGate = async () => {
    const ids=confirmUndoRunIds;
    if (!ids?.length || stoppingUndoRuns) return;
    const before=editor.getSnapshot().graph;
    setStoppingUndoRuns(true);
    try {
      const pending=new Set(ids);
      for (const id of ids) {
        const path='/v1/runs/'+encodeURIComponent(id);
        const run=await latest.current.request<Run>(path);
        if (['succeeded','failed','cancelled','interrupted'].includes(run.status)) { pending.delete(id); continue; }
        await latest.current.request(path+(run.chainBatch===id?'/cancel-chain':'/cancel'),{idempotencyKey:randomId()},'POST');
      }
      for (let attempt=0; pending.size && attempt<120; attempt++) {
        if (!mounted.current) return;
        for (const id of [...pending]) {
          const run=await latest.current.request<Run>('/v1/runs/'+encodeURIComponent(id));
          if (['succeeded','failed','cancelled','interrupted'].includes(run.status)) pending.delete(id);
        }
        if (pending.size) await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if (pending.size) throw Error(t('The Workspace has not finished stopping the task. Try undo again after it settles.'));
      await editor.refresh();
      const current=editor.getSnapshot().graph;
      if (current.graphId!==before.graphId || current.history?.cursor!==before.history?.cursor)
        throw Error(t('The Work Graph changed. Run the operation again.'));
      await history.undo();
      setConfirmUndoRunIds(undefined);
      setSelected(ids=>ids.filter(id=>editor.getSnapshot().graph.nodes.some(node=>node.id===id)));
      latest.current.onChanged();
    } finally { setStoppingUndoRuns(false); }
  };
  const clipboardTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const root = target.closest(".owg-canvas");
    if (!root) return false;
    // Chromium can send copy to a previously selected textarea after focus
    // has returned to the work graph. The current focus owns the clipboard.
    if (document.activeElement === root) return true;
    return Boolean(target.closest(".ow-image-expand[data-canvas-draggable]")) ||
      !target.closest(
        "input,textarea,select,button,[contenteditable=true],[data-canvas-interactive],[data-canvas-no-zoom]",
      );
  };
  const pasteNodes = (raw: string, element: Element) => {
    if (editor.getSnapshot().drafts.length) throw Error(t('Save the body content before pasting nodes.'));
    // Validate before queuing; freeze both payload and placement for this intent.
    const payload = parseNodeClipboard(raw);
    assertResourcePasteTarget(raw, editor.getSnapshot().graph);
    const viewport = canvas.current?.getViewport();
    const rect = element.closest(".owg-canvas")?.getBoundingClientRect();
    if (!viewport || !rect) throw Error(t('Unable to determine the paste position.'));
    const offset = pasteQueue.getSnapshot().count * 32;
    const at = { x: (rect.width / 2 - viewport.x) / viewport.k + offset, y: (rect.height / 2 - viewport.y) / viewport.k + offset };
    const needsResources = payload.nodes.some(n => typeof n.content.resourceId === "string" || (n.content.source && typeof n.content.source === 'object' && !Array.isArray(n.content.source) && n.content.source.kind === 'project-file'));
    if (!needsResources) {
      guardLayout([]);
      const plan = planNodePaste(raw, at, undefined, undefined, { serviceId:g.serviceId, projectId:g.projectId, graphId:g.graphId });
      const pending = command(plan.operations);
      setSelected(plan.nodeIds);
      void pending.catch(props.onError);
      return;
    }
    let job: ReturnType<typeof createResourcePasteJob> | undefined;
    pasteQueue.enqueue(async progress => {
      const epoch = pasteEpoch.current;
      const assertCurrent = () => {
        guardLayout([]);
        if (epoch !== pasteEpoch.current) throw Error(t('The connection or Work Graph changed. Remaining paste operations were paused; reconnect to continue.'));
        const current = editor.getSnapshot();
        if (current.drafts.length) throw Error(t('Save the body content before continuing to paste.'));
      };
      assertCurrent();
      // Resource preparation has its own progress workflow; graph placement joins the shared queue.
      job ??= createResourcePasteJob(raw, editor.getSnapshot().graph, at, async (path, body, method) => {
        guardLayout([]);
        return latest.current.request(path, body, method);
      }, ops => editor.prepareCommand(history.prepareOperations(ops)), undefined, progress);
      const ids = await job.run(assertCurrent);
      if (mounted.current) { setSelected(ids); latest.current.onChanged(); }
    });
  };
  const baseDocumentNode = work.nodes.find(n => n.id === documentId);
  const documentWire = g.nodes.find(n => n.id === documentId);
  const documentNode = baseDocumentNode && (documentWire?.type !== "text" && object(documentWire?.content ?? {}).resourceId ? { ...baseDocumentNode, content: resourceDocument && resourceDocument.id === documentId ? resourceDocument.text : "" } : baseDocumentNode);
  const documentEpoch = useRef(0);
  const openDocument = (id: string, preview = false) => {
    const target = editor.getSnapshot().graph.nodes.find(n => n.id === id);
    if (!target) return;
    const c = object(target.content), epoch = ++documentEpoch.current;
    if (target.type === "text" || typeof c.resourceId !== "string") { setDocumentPreviewId(preview ? id : undefined); setDocumentId(id); return; }
    act(async () => {
      const representation = await props.request<{ state: string; text: string | null; reason: string | null }>(graphPath(g.projectId, g.graphId) + "/resources/" + encodeURIComponent(c.resourceId as string) + "/versions/" + c.resourceVersion + "/representation");
      if (!mounted.current || epoch !== documentEpoch.current) return;
      if (representation.state !== "ready") throw Error(representation.reason || t('The document is still being processed. Try again later.'));
      setResourceDocument({ id, version: target.contentVersion, text: representation.text ?? "" }); setDocumentPreviewId(preview ? id : undefined); setDocumentId(id);
    });
  };
  const promptDisabled = !!(readOnly || node?.readOnly || (node && locked(node.id)) || (draft && ["conflict", "recovery"].includes(draft.state)));
  const imageMode = imagePreview?.nodeId===node?.id && imagePreview?.hasImage ? (String(content.prompt??'').trim()?'text_image':'image') : 'text';
  const selectedProvider = selectedRoute.type==='api' ? imageProviders.find(provider=>provider.id===selectedRoute.providerId) : undefined;
  const selectedImageModel = selectedRoute.type==='api' ? selectedProvider?.models.find(item=>item.id===selectedRoute.modelId) : undefined;
  const customImageSizeAllowed = selectedRoute.type==='codex' || modelAllowsCustomImageSize(selectedImageModel);
  const availableImageSizes = declaredImageSizes(selectedImageModel);
  const availableImageRatios = selectedRoute.type==='api' ? imageRatiosForModel(selectedImageModel) : [...IMAGE_RATIOS];
  const availableImageScales = selectedRoute.type==='api' ? imageScalesForModel(selectedImageModel) : [...IMAGE_SCALES];
  const selectedImageScale = inferImageScale(imageOptions.size);
  const selectedImageDimensions = parseImageDimensions(imageOptions.size) ?? {width:1024,height:1024};
  const customSizeIssue = customImageSizeAllowed && imageOptions.size && imageOptions.size !== 'auto' ? validateCustomImageSize(imageOptions.size) : undefined;
  const reportedCustomSizeIssue = useRef('');
  useEffect(() => {
    if (!customSizeIssue) { reportedCustomSizeIssue.current = ''; return; }
    if (reportedCustomSizeIssue.current !== customSizeIssue) {
      reportedCustomSizeIssue.current = customSizeIssue;
      props.onError(new Error(customSizeIssue));
    }
  }, [customSizeIssue, props.onError]);
  const apiBlock = selectedRoute.type==='api' ? !selectedProvider ? t('The selected image generation provider does not exist. Select it again in Workspace management.')
    : !selectedProvider.enabled ? t('The selected image generation provider is disabled.')
    : !selectedProvider.credentialConfigured ? t('The selected provider credentials are not configured or have been revoked.')
    : !selectedImageModel ? t('The selected image model does not exist.')
    : !selectedImageModel.modes.includes(imageMode) ? t('The selected model does not support {mode}.', {mode:{text:t('text-to-image'),image:t('promptless image-to-image'),text_image:t('text-and-image generation')}[imageMode]})
    : imageOptions.size && imageOptions.size!=='auto' && !selectedImageModel.sizes.includes('auto') && !selectedImageModel.sizes.includes(imageOptions.size) ? t('The selected model does not support the current image size.')
    : imageOptions.quality && imageOptions.quality!=='auto' && !selectedImageModel.qualities.includes('auto') && !selectedImageModel.qualities.includes(imageOptions.quality) ? t('The selected model does not support the current image quality.')
    : undefined : undefined;
  const missingInput = node?.type==='image' && !String(content.prompt??'').trim() && !(imagePreview?.nodeId===node.id && imagePreview.hasImage);
  const missingImageInputHint = t('Enter a prompt or connect an existing image resource.');
  const imageIssue = imagePreview?.issues[0] === 'Own prompt must be nonempty unless an image node has a reference image'
    || imagePreview?.issues[0] === 'Own prompt must be nonempty unless an image node has a frozen reference image'
    ? missingImageInputHint : imagePreview?.issues[0];
  const imageBlock = node?.type==='image' ? (imagePreview?.nodeId!==node.id ? t('Checking frozen image inputs…') : imageIssue ?? (missingInput?missingImageInputHint:selectedRoute.type==='api'?apiBlock??customSizeIssue:customSizeIssue??(!props.imageAvailable?props.imageReason??t('Codex image generation is unavailable.'):undefined))) : undefined;
  const runDisabled = promptDisabled || running || (node?.type==='image' ? Boolean(imageBlock) || (selectedRoute.type==='codex' && !props.executionAvailable) : !String(content.prompt ?? "").trim() || !props.executionAvailable);
  const unavailableReason = !props.online ? t('The Workspace is disconnected or synchronizing. Connect and try again.')
    : node?.type==='image' ? imageBlock ?? (selectedRoute.type==='codex' && !props.executionAvailable ? props.executionReason ?? t('Codex execution is unavailable.') : undefined)
    : !props.executionAvailable ? props.executionReason ?? t('Workspace execution is unavailable.') : undefined;
  const submitNodeRun = async () => {
    if (!node || runDisabled) return;
    setRunning(true);
    try {
      const submitted = await editor.run(node.id, node.type === "execution" ? "execution" : node.type === "image" ? "image_generation" : "text_generation", node.type==='image' && selectedRoute.type==='api'?undefined:model ? { model, reasoningEffort: effort || null } : undefined, node.type==='image'?selectedRoute:undefined);
      submittedNodeKeys.current.add(JSON.stringify([g.serviceId, g.projectId, g.graphId, node.id]));
      props.onRunSubmitted?.(submitted);
      if (node.type === "execution") setDetailsOpen(false);
      props.onChanged();
      if (node.type === "execution") await editor.refresh();
    }
    finally { setRunning(false); }
  };
  const runNode = () => {
    if (!node || runDisabled) return;
    if (latestNodeRuns.has(node.id) || submittedNodeKeys.current.has(JSON.stringify([g.serviceId, g.projectId, g.graphId, node.id]))) { setConfirmRunNodeId(node.id); return; }
    return submitNodeRun();
  };
  const reasoningModel = models?.available.find(item => item.id === (model || models.selection?.model));
  const inheritedReasoningEffort = model
    ? reasoningModel?.defaultReasoningEffort
    : models?.selection?.reasoningEffort ?? reasoningModel?.defaultReasoningEffort;
  const inheritedReasoningLabel = inheritedReasoningEffort === undefined
    ? t('Reasoning · Unknown')
    : inheritedReasoningEffort === null
      ? t('Reasoning · None')
      : t('Reasoning · {effort}', { effort: inheritedReasoningEffort });
  const reasoningControl = node && (<select aria-label={t('Reasoning effort')} value={effort} disabled={promptDisabled} onChange={e => {
                  const chosenModel = model || models?.selection?.model;
                  if (!chosenModel) return;
                  setModel(chosenModel); setEffort(e.target.value); act(() => editor.edit(node.id, { ...content, modelOverride: { model: chosenModel, reasoningEffort: e.target.value || null } }));
                }}><option value="">{inheritedReasoningLabel}</option>{reasoningModel?.reasoningEfforts.map(e => <option key={e}>{e}</option>)}{effort && !reasoningModel?.reasoningEfforts.includes(effort) && <option value={effort}>{t('{effort} (currently unavailable)', {effort})}</option>}</select>);
  const chooseImageScale = (scale:(typeof IMAGE_SCALES)[number]) => {
    if(selectedRoute.type==='api' && selectedImageModel && !customImageSizeAllowed){
      const size=chooseDeclaredImageSize(selectedImageModel,scale,imageOptions.aspectRatio??'auto');
      if(size)saveImageOptions({size,aspectRatio:nearestImageRatio(size)});
      return;
    }
    const ratio=scale!=='auto' && (imageOptions.aspectRatio??'auto')==='auto'?'1:1':imageOptions.aspectRatio??'auto';
    saveImageOptions({size:presetImageSize(scale,ratio),aspectRatio:ratio});
  };
  const chooseImageRatio = (ratio:string) => {
    if(selectedRoute.type==='api' && selectedImageModel && !customImageSizeAllowed){
      const size=chooseDeclaredImageSize(selectedImageModel,selectedImageScale,ratio);
      if(size)saveImageOptions({size,aspectRatio:ratio});
      return;
    }
    saveImageOptions({aspectRatio:ratio,size:presetImageSize(selectedImageScale,ratio)});
  };
  const commitImageDimension = (axis:'width'|'height',raw:string) => {
    const numeric=Math.max(1,Math.min(3840,Math.floor(Number(raw)||selectedImageDimensions[axis])));
    const value=snapImageDimensions?Math.ceil(numeric/16)*16:numeric;
    const dimensions={...selectedImageDimensions,[axis]:value};
    const size=`${dimensions.width}x${dimensions.height}`;
    saveImageOptions({size,aspectRatio:nearestImageRatio(size)});
  };
  const reference = work.nodes.find(n => n.id === referenceId);
  const referenceWire = g.nodes.find(n => n.id === referenceId);
  const referenceContent = object(referenceWire?.content ?? {});
  const generatedOutputNode = g.nodes.find(n => n.id === generatedOutputNodeId);
  const generatedOutput = object(object(generatedOutputNode?.content ?? {}).generatedOutput);
  const saveLabel = state.drafts.length
    ? state.drafts.some((d) => d.state === "conflict")
      ? t('Conflict')
      : state.drafts.some((d) => d.state === "recovery")
        ? t('Recovery pending')
        : state.drafts.some((d) => d.state === "failed")
          ? t('Save failed')
          : state.drafts.some((d) => d.state === "saving")
            ? t('Saving')
            : t('Unsaved')
    : t('Saved');
  // Canvas cards and output previews deliberately share this rendering path.
  const linkedPreviewLayers = markdownLinkedFiles.map(file => ({
    id: String(file.id), title: file.name,
    content: <MarkdownPreviewProvider sourcePath={file.sourcePath}>{file.contentPath
      ? <LinkedVideoPreview request={props.serviceRequest ?? props.request} path={file.contentPath} bytes={file.bytes} name={file.name} copying={copyingMarkdownLinkedFile} onCopyToGraph={readOnly ? undefined : () => act(copyMarkdownLinkedFileToGraph)}/>
      : <LinkedFilePreview base64={file.base64 ?? ''} name={file.name} mime={file.mime} copying={copyingMarkdownLinkedFile} onCopyToGraph={readOnly ? undefined : () => act(copyMarkdownLinkedFileToGraph)}/>}</MarkdownPreviewProvider>,
  }));
  const previewNavigation: PreviewDialogNavigation = { layers: linkedPreviewLayers, pending: markdownLinkPending, onBack: backMarkdownPreview };
  const hasPreviewRoot = !!(reference || documentNode || promptProjectFile || generatedOutputNode);
  const renderNodeContent = (n: WorkNode, wire: GraphSnapshot["nodes"][number]) => {
    if (wire.type === "group" && wire.schemaVersion === 1) return null;
    const c = object(wire.content);
    const resourceImport = object(c.resourceImport);
    if (resourceImport.state === 'loading' || resourceImport.state === 'failed') return <div className="node-content ow-resource-import-state">{resourceImport.state === 'loading' ? <LoaderCircle size={28} className="ow-resource-import-spinner" aria-hidden="true"/> : <CircleAlert size={28} aria-hidden="true"/>}<strong>{n.title}</strong><span>{resourceImport.state === 'loading' ? t('Copying resource…') : t('Resource copy failed. Retry from the asset library.')}</span></div>;
    const projectFileImport = object(c.projectFileImport);
    if (projectFileImport.state === 'loading' || projectFileImport.state === 'failed') return <div className="node-content ow-resource-import-state">{projectFileImport.state === 'loading' ? <LoaderCircle size={28} className="ow-resource-import-spinner" aria-hidden="true"/> : <CircleAlert size={28} aria-hidden="true"/>}<strong>{n.title}</strong><span>{projectFileImport.state === 'loading' ? t('Linking project file…') : t('Project file linking failed. Add the same file again to retry.')}</span></div>;
    const projectSource = object(c.source);
    if (projectSource.kind === 'project-file-empty') return <div className="node-content ow-empty-reference-node" aria-label={t('Empty reference node. Drop any project file here to associate it.')}><Link2 size={32} aria-hidden="true"/></div>;
    if (wire.schemaVersion === 1 && (wire.type === 'video' || wire.type === 'file' && previewFormat(String(projectSource.relativePath ?? n.title), String(c.mime ?? '')) === 'video')) {
      const relativePath = projectSource.kind === 'project-file' ? String(projectSource.relativePath) : undefined;
      const resourcePath = typeof c.resourceId === 'string' ? graphPath(g.projectId, g.graphId) + '/resources/' + encodeURIComponent(c.resourceId) + '/versions/' + Number(c.resourceVersion) : undefined;
      if (relativePath !== undefined || resourcePath) return <VideoNodeSummary key={[wire.id, wire.contentVersion, projectFilesRevision].join(':')} request={relativePath !== undefined ? props.serviceRequest ?? props.request : props.request} projectId={g.projectId} relativePath={relativePath} resourcePath={resourcePath} name={n.title} mime={String(c.mime ?? '')} bytes={typeof c.bytes === 'number' ? c.bytes : undefined}/>;
    }
    if (projectSource.kind === 'project-file') {
      if (wire.type === 'file') return <div className="node-content ow-file-node"><FileIcon size={32}/><div className="ow-file-metadata"><strong title={n.title}>{n.title}</strong><span className="ow-file-size" title={String(projectSource.relativePath)}>{String(projectSource.relativePath)}</span></div></div>;
      if (wire.type === 'image' || wire.type === 'video') return <CanvasProjectFilePreview key={String(projectSource.relativePath) + ':' + projectFilesRevision} request={props.serviceRequest ?? props.request} projectId={g.projectId} relativePath={String(projectSource.relativePath)} mime={String(c.mime ?? 'application/octet-stream')} name={n.title} imageNode={wire.type === 'image'} onError={props.onError}/>;
      return <ProjectFileContent request={props.serviceRequest ?? props.request} projectId={g.projectId} source={projectSource} mime={String(c.mime ?? 'application/octet-stream')} name={n.title} compact node={n} onError={props.onError} refreshKey={projectFilesRevision} onDetach={wire.type === 'text' && !readOnly && !n.readonly && !locked(n.id) ? text => detachProjectFileText(n.id,text) : undefined}/>;
    }
    if (wire.schemaVersion === 1 && wire.type === "preview") return <PreviewNode key={wire.id + ':' + projectFilesRevision} graph={g} nodeId={wire.id} request={props.request} onError={props.onError} {...previewModeProps(wire)}/>;
    if (wire.schemaVersion === 1 && n.type === 'file') {
      const sizeKey = [wire.contentVersion, c.resourceId, c.resourceVersion].join(':');
      const bytes = typeof c.bytes === 'number' && Number.isSafeInteger(c.bytes) && c.bytes >= 0 ? c.bytes : legacyFileSizes[n.id]?.key === sizeKey ? legacyFileSizes[n.id]?.bytes : undefined;
      return <div className="node-content ow-file-node"><FileIcon size={32} aria-hidden="true"/>{typeof c.resourceId === 'string' ? <div className="ow-file-metadata"><strong title={n.title}>{n.title}</strong>{bytes !== undefined && <span className="ow-file-size">{formatFileSize(bytes)}</span>}</div> : <><span>{t('No file uploaded yet (maximum 300 MB)')}</span><button type="button" className="ow-file-upload-button" disabled={readOnly || n.readonly || locked(n.id)} onClick={() => { replacement.current = { nodeId: n.id, type: 'file', version: wire.contentVersion, content: wire.content }; file.current?.click(); }}><Upload size={16} aria-hidden="true"/>{t('Upload file')}</button></>}</div>;
    }
    if (wire.schemaVersion === 1 && !c.resourceId && n.type === "execution") {
      const run = graphRuns.filter(r => r.nodeId === n.id).at(-1);
      return <div className="node-content"><RunSummary interaction={run ? <NodeRunInteractions key={run.id} run={run} request={props.request} disabled={readOnly || !!n.readonly} onChanged={props.onChanged} onError={props.onError}/> : undefined} node={n} statusLabel={run ? runStatusLabels[run.status] : undefined} run={run ? { status: run.status, summaries: progress[run.id]?.summaries ?? [], error: progress[run.id]?.error, prompt: submittedPrompts[run.id] ?? n.prompt } : undefined}/></div>;
    }
    if (wire.schemaVersion === 1 && n.type === "document") return <DocumentNodeContent node={n} wire={wire} request={props.request} imageRequest={props.serviceRequest ?? props.request} imageRevision={projectFilesRevision} onOpenLink={openMarkdownLink}/>;
    if (wire.schemaVersion === 1 && !c.resourceId && ["image", "video", "audio"].includes(n.type)) return <div className="node-content"><ContentPlaceholder node={n}/></div>;
    if (n.type === "text" && wire.schemaVersion === 1) {
      const nodeDraft = state.drafts.find(d => d.nodeId === n.id);
      return <div className="node-content real-text-content"><TextContent
        node={{ ...n, readonly: !!(readOnly || n.readonly || (nodeDraft && ["conflict", "recovery"].includes(nodeDraft.state))) }}
        onError={props.onError}
        onChange={text => {
          guardLayout([]);
          const current = editor.getSnapshot();
          const currentNode = current.graph.nodes.find(value => value.id === n.id);
          if (!currentNode) throw Error(t('The node was removed.'));
          const currentDraft = current.drafts.find(value => value.nodeId === n.id);
          editor.edit(n.id, { ...object(currentDraft?.content ?? currentNode.content), text });
        }}
      /></div>;
    }
    return (
      <div className="real-node-content">
        {!["text", "image", "document", "video", "execution"].includes(
          n.type,
        ) || wire.schemaVersion !== 1 ? (
          <RealPluginView node={wire} readonly={n.readonly} />
        ) : ["text", "document", "execution"].includes(n.type) &&
          !c.resourceId ? (
          <MarkdownPreview text={n.type === "execution" ? n.prompt : n.content}/>
        ) : c.resourceId ? (
          <CanvasResourcePreview
            request={props.request}
            projectId={g.projectId}
            graphId={g.graphId}
            resourceId={String(c.resourceId)}
            version={Number(c.resourceVersion)}
            mime={typeof c.mime === 'string' ? c.mime : undefined}
            name={n.title}
            imageNode={n.type === 'image'}
            onError={props.onError}
          />
        ) : (
          <p>
            {n.type === "image"
              ? t('Upload an image or enter a prompt to generate one')
              : t('The node view is missing. Original data was preserved and was not migrated automatically.')}
          </p>
        )}
        {locked(n.id) && (
          <span role="status">{t('Task in progress · Input locked')}</span>
        )}
      </div>
    );
  };
  const openImageNodePreview = (nodeId: string): boolean => {
    const nodeElement = Array.from(document.querySelectorAll<HTMLElement>('[data-node-id]')).find(element => element.dataset.nodeId === nodeId);
    const preview = nodeElement?.querySelector<HTMLButtonElement>('.ow-image-expand[data-canvas-draggable]');
    if (!preview) return false;
    preview.click();
    return true;
  };
  const localNoticeStamp = [pasteState.count, pasteState.error ?? '', ...uploads.map(job => `${job.id}:${job.state}`)].join('\u0000');
  useEffect(() => {
    if (props.toastTarget) props.toastTarget.scrollTop = props.toastTarget.scrollHeight;
  }, [localNoticeStamp, props.toastTarget]);
  const notices = <>
    <Toast open={pasteState.count > 0} duration={null} role="status" className="workgraph-paste-status">
      <span>{t('Pasting nodes…')}</span>
      {pasteState.progress && <span>{t('Resources {completed}/{total}', {completed:pasteState.progress.completed,total:pasteState.progress.total})}</span>}
      {pasteState.count > 1 && <span>{t('{count} batches waiting', {count:pasteState.count - 1})}</span>}
      {pasteState.warning && <span>{pasteState.warning}</span>}
    </Toast>
    {uploads.map((job) => (
      <Toast className="real-upload-status" key={job.id} duration={job.state === 'saved' ? 5000 : null} dismissLabel={job.state === 'uploading' ? undefined : t('Close')} onDismiss={() => setUploads(jobs => jobs.filter(j => j.id !== job.id))}>
        <span>
          {job.file.name} ·{" "}
          {job.state === "saved"
            ? t('Saved to the Work Graph')
            : job.state === "failed"
              ? t('Upload or placement failed')
              : t('Uploading')}
        </span>
        {job.state === "uploading" && <span className="real-upload-percent" aria-label={t('Upload progress')}>{Math.max(0, Math.min(100, Math.round(job.progress)))}%</span>}
      </Toast>
    ))}
  </>;
  return (
    <MarkdownPreviewProvider onOpenLink={openMarkdownLink} imageRequest={props.serviceRequest ?? props.request} projectId={g.projectId} imageRevision={projectFilesRevision}>
    <section ref={workspaceElement} className="real-workspace" aria-label={t('Work Graph editor')}>
      {props.runtimeUnavailable === true && !props.online && <section className="workspace-disconnected panel" role="status">
        <WifiOff size={40} aria-hidden="true" />
        <h2>{t('Workspace connection disconnected')}</h2>
        <WorkspaceRestartHint />
      </section>}
      <div className="real-toolbar topbar-left panel">
        <button className="icon-button" ref={mainMenuTrigger} aria-label={t('Work Graph main menu')} aria-expanded={mainMenu} onClick={() => setMainMenu(v => !v)}><Menu size={18}/></button>
        {props.projectName && <span className="workgraph-project-prefix" title={props.projectName}>
          <span className="workgraph-project-name">{props.projectName}</span><span aria-hidden="true">/</span>
        </span>}
        {editingTitle ? <input ref={titleInput} className="workgraph-title-input" aria-label={t('Work Graph title')} maxLength={1024} value={titleDraft} readOnly={titleSaving}
          onChange={e => { e.currentTarget.setCustomValidity(''); setTitleDraft(e.target.value); }} onBlur={() => { void saveTitle(); }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); void saveTitle(); }
            if (e.key === 'Escape' && !titleSavePending.current) { e.preventDefault(); titleEditActive.current = false; setTitleDraft(undefined); }
          }}/>
          : <strong className="workgraph-title" role="button" tabIndex={readOnly ? -1 : 0} aria-disabled={readOnly}
            title={readOnly ? g.title : t('Double-click to rename the Work Graph')} onDoubleClick={beginTitleEdit}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); beginTitleEdit(); } }}>{g.title}</strong>}
        <span role="status">{titleSaving ? t('Saving') : saveLabel}{readOnly ? t(' · Read-only') : ""}</span>
      </div>
      {mainMenu && <>
        <button className="graph-menu-dismiss" aria-label={t('Close Work Graph main menu')} onClick={() => { setRecentMenu(undefined); setMainMenu(false); }}/>
        <nav ref={mainMenuPanel} className="graph-main-menu panel" aria-label={t('Work Graph main menu')}>
          <button onClick={() => { setMainMenu(false); props.onHome?.(); }}><Home size={16}/>{t('Home')}</button>
          <button onClick={() => { setMainMenu(false); props.onLibrary?.(); }}><Grid2X2 size={16}/>{t('My Work Graphs')}</button>
          <button className="graph-recent-trigger" aria-expanded={!!recentMenu} aria-haspopup="true" onClick={event => {
            if (recentMenu) { setRecentMenu(undefined); return; }
            const bounds = event.currentTarget.getBoundingClientRect();
            const width = Math.min(392, window.innerWidth - 16);
            setRecentMenu({ left: bounds.right + width <= window.innerWidth ? bounds.right : Math.max(8, bounds.left - width), top: Math.min(bounds.top, Math.max(8, window.innerHeight - 320)) });
          }}><Clock3 size={16}/>{t('Open recent Work Graph')}<ChevronRight className="graph-recent-chevron" size={15}/></button>
          <hr/>
          <button disabled={!props.online || !props.projectActive} onClick={() => { setMainMenu(false); props.onNew?.(); }}><Plus size={16}/>{t('New Work Graph')}</button>
          <button className="danger" disabled={readOnly} onClick={() => { setMainMenu(false); props.onDelete?.(); }}><Trash2 size={16}/>{t('Delete current Work Graph')}</button>
          <hr/>
          <button onClick={() => { setMainMenu(false); props.onExport?.(); }}><Download size={16}/>{t('Export current Work Graph')}</button>
          {props.graphActions && <>
            <hr/>
            <div className="graph-management-actions">{props.graphActions(() => setMainMenu(false))}</div>
          </>}
          <button disabled={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canUndo} onClick={() => { setMainMenu(false); act(() => travelHistory(false)); }}><Undo2 size={16}/>{t('Undo')}</button>
          <button disabled={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canRedo} onClick={() => { setMainMenu(false); act(() => travelHistory(true)); }}><Redo2 size={16}/>{t('Redo')}</button>
        </nav>
        {recentMenu && <nav ref={recentMenuPanel} className="graph-recent-menu panel" aria-label={t('Recently opened Work Graphs')} style={{ left: recentMenu.left, top: recentMenu.top }}>
          {props.recentGraphs?.length ? props.recentGraphs.map(item => {
            const label = item.runtimeName + '/' + item.projectName + '/' + item.title;
            const current = item.temporary === Boolean(props.temporary) && item.serviceId === (props.temporary ? 'browser' : props.graph.serviceId) &&
              item.projectId === props.graph.projectId && item.graphId === props.graph.graphId;
            return <button key={JSON.stringify([item.temporary, item.serviceId, item.projectId, item.graphId])} title={label} aria-current={current ? 'page' : undefined} onClick={() => { setRecentMenu(undefined); setMainMenu(false); props.onOpenRecent?.(item); }}><span className="graph-recent-marker" aria-hidden="true">{current ? '• ' : ''}</span><span className="graph-recent-label">{label}</span></button>;
          }) : <p className="muted">{t('No recently opened Work Graphs')}</p>}
        </nav>}
      </>}
      {confirmRunNodeId && node?.id === confirmRunNodeId && <RunResubmitDialog
        title={String(content.title ?? '')}
        action={node.type === 'execution' ? t('Run') : t('Generate')}
        disabled={runDisabled}
        onClose={() => setConfirmRunNodeId(undefined)}
        onConfirm={() => { setConfirmRunNodeId(undefined); act(submitNodeRun); }}
      />}
      {confirmUndoRunIds && <div className="modal-backdrop markdown-link-confirm-backdrop" onClick={()=>{if(!stoppingUndoRuns)setConfirmUndoRunIds(undefined);}}><section className="reference-preview panel markdown-link-confirm" role="alertdialog" aria-modal="true" aria-label={t('Undo running task')} tabIndex={-1} ref={undoRunDialog} onClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'&&!stoppingUndoRuns){event.preventDefault();setConfirmUndoRunIds(undefined);}if(event.key==='Tab'){const buttons=Array.from(undoRunDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
        <div className="panel-heading"><strong>{t('Undo running task')}</strong></div>
        <p>{stoppingUndoRuns?t('Waiting for the Workspace to stop the task…'):t('Undo has reached a running task. Stop it and continue undoing the Work Graph?')}</p>
        <div className="button-row"><button type="button" disabled={stoppingUndoRuns} onClick={()=>setConfirmUndoRunIds(undefined)}>{t('Keep task')}</button><button type="button" className="primary-button" disabled={stoppingUndoRuns} onClick={()=>act(confirmUndoRunGate)}>{t('Stop task and undo')}</button></div>
      </section></div>}
      {imageSettingsOpen && node?.type==='image' && <div className="modal-backdrop" onClick={()=>setImageSettingsOpen(false)}><section className="image-settings-dialog panel" role="dialog" aria-modal="true" aria-label={t('Image settings')} onClick={event=>event.stopPropagation()}>
        <div className="panel-heading"><strong>{t('Image settings')}</strong><button className="icon-button" aria-label={t('Close image settings')} onClick={()=>setImageSettingsOpen(false)}><X size={16}/></button></div>

        {selectedRoute.type === 'codex' && <label>{t('Reasoning effort')}{reasoningControl}</label>}
        <fieldset><legend>{t('Quality')}</legend><div className="image-setting-options">{([['auto',t('Auto')],['high',t('High')],['medium',t('Medium')],['low',t('Low')]] as const).map(([value,label])=>{const supported=selectedRoute.type==='codex'||value==='auto'||Boolean(selectedImageModel?.qualities.includes('auto')||selectedImageModel?.qualities.includes(value));return <button type="button" disabled={!supported} aria-pressed={imageOptions.quality===value} className={imageOptions.quality===value?'active':''} onClick={()=>saveImageOptions({quality:value})} key={value}>{label}</button>;})}</div></fieldset>
        {customImageSizeAllowed ? <div className="image-dimension-section">
          <div className="image-setting-heading"><span>{t('Size')}</span><label className="image-alignment-toggle"><span>{t('Align to multiples of 16')}</span><input type="checkbox" checked={snapImageDimensions} onChange={event=>setSnapImageDimensions(event.target.checked)}/></label></div>
          <div className="image-dimension-inputs"><label><span>W</span><input aria-label={t('Image width')} type="number" min="1" max="3840" key={`width-${selectedImageDimensions.width}`} defaultValue={selectedImageDimensions.width} onBlur={event=>commitImageDimension('width',event.currentTarget.value)} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}/></label><span>×</span><label><span>H</span><input aria-label={t('Image height')} type="number" min="1" max="3840" key={`height-${selectedImageDimensions.height}`} defaultValue={selectedImageDimensions.height} onBlur={event=>commitImageDimension('height',event.currentTarget.value)} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}/></label></div>
          {customSizeIssue && <p className="image-setting-error" role="status">{t('The size was not saved. Check the notification.')}</p>}
        </div> : <label>{t('Model size')}<select aria-label={t('Image size')} value={imageOptions.size} onChange={event=>saveImageOptions({size:event.target.value,aspectRatio:nearestImageRatio(event.target.value)})}>{availableImageSizes.map(size=><option value={size} key={size}>{size.replace('x',' × ')}</option>)}</select></label>}
        <fieldset><legend>{t('Resolution')}</legend><div className="image-setting-options">{IMAGE_SCALES.map(scale=>{const supported=availableImageScales.includes(scale);return <button type="button" disabled={!supported} aria-pressed={selectedImageScale===scale} className={selectedImageScale===scale?'active':''} onClick={()=>chooseImageScale(scale)} key={scale}>{scale==='auto'?t('Auto'):scale.toUpperCase()}</button>;})}</div></fieldset>
        <fieldset><legend>{t('Aspect ratio')}</legend><div className="image-aspect-options">{availableImageRatios.map(value=><button type="button" aria-pressed={imageOptions.aspectRatio===value} className={imageOptions.aspectRatio===value?'active':''} onClick={()=>chooseImageRatio(value)} key={value}>{value==='auto'?t('Auto'):value}</button>)}</div></fieldset>
      </section></div>}
      <div ref={dockElement} className="bottom-dock panel" role="toolbar" aria-label={t("Work Graph tools")}>
        <button className={"icon-button " + (tool === "pan" ? "active" : "")} aria-pressed={tool === "pan"} aria-label={t(tool === "pan" ? "Switch to selection" : "Switch to pan")} title={t(tool === "pan" ? "Switch to selection" : "Switch to pan")} onClick={() => setTool(tool === "pan" ? "select" : "pan")}>{tool === "pan" ? <Hand size={18}/> : <MousePointer2 size={18}/>}</button>
        <button className="icon-button" aria-label={t("Fit Work Graph")} title={t("Fit Work Graph")} onClick={() => canvas.current?.fit()}><Maximize size={18}/></button>
        <button className="icon-button" aria-label={t("Undo")} title={historyState.reason || t("Undo")} disabled={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canUndo} onClick={() => act(() => travelHistory(false))}><Undo2 size={18}/></button>
        <button className="icon-button" aria-label={t("Redo")} title={t("Redo")} disabled={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canRedo} onClick={() => act(() => travelHistory(true))}><Redo2 size={18}/></button>
        <span className="topbar-divider"/>
        <button className="icon-button" aria-label={t("Add text")} title={t("Add text")} disabled={readOnly} onClick={() => act(() => create("text"))}><Type size={18}/></button>
        <button className="icon-button" aria-label={t("Add execution")} title={t("Add execution")} disabled={readOnly} onClick={() => act(() => create("execution"))}><Settings2 size={18}/></button>
        <button className="icon-button" aria-label={t("Add image")} title={t("Add image")} disabled={readOnly} onClick={() => act(() => create("image"))}><Image size={18}/></button>
        <button className="icon-button" aria-label={t("Upload to Work Graph")} title={t("Upload to Work Graph")} disabled={readOnly} onClick={() => { replacement.current = undefined; file.current?.click(); }}><Upload size={18}/></button>
        <button className="icon-button" aria-label={t("Add document")} title={t("Add document")} disabled={readOnly} onClick={() => act(() => create("document"))}><FileText size={18}/></button>
        <button className="icon-button" aria-label={t("Add preview")} title={t("Add preview")} disabled={readOnly} onClick={() => act(() => create("preview"))}><Eye size={18}/></button>
        <button className="icon-button" aria-label={t("Add file")} title={t("Add file")} disabled={readOnly} onClick={() => act(() => create("file"))}><FileIcon size={18}/></button>
        <button className="icon-button" aria-label={t("Add node")} title={t("Add node")} disabled={readOnly} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); const dock = dockElement.current?.getBoundingClientRect(); const v = canvas.current?.getViewport(); if (v) setCreateMenu({ world: { x: (300 - v.x) / v.k, y: (250 - v.y) / v.k }, screen: { x: r.left, y: dock?.top ?? r.top }, preferAbove: true }); }}><Plus size={18}/></button>
        <span className="topbar-divider"/>
        <button className="icon-button" aria-label={t("Group")} title={t("Group")} disabled={!canGroup} onClick={() => act(groupSelection)}><Group size={18}/></button>
        <button className="icon-button" aria-label={t("Ungroup")} title={t("Ungroup")} disabled={!canUngroup} onClick={() => act(ungroupSelection)}><Ungroup size={18}/></button>
        {selectedGroups.length === 1 && selectedMembers.length > 0 && <>
          <button disabled={!canGeometry(selected)} onClick={() => act(() => updateMembers(false))}>{t("Add to selected group")}</button>
          <button disabled={!canGeometry(selected)} onClick={() => act(() => updateMembers(true))}>{t("Remove from selected group")}</button>
        </>}
        <button className="icon-button" aria-label={t("Change Work Graph background")} title={t("Change Work Graph background")} onClick={() => setBackground(background === "lines" ? "dots" : background === "dots" ? "blank" : "lines")}><Grid2X2 size={18}/></button>
      </div>
      {props.sidebarTarget && createPortal(<>
        <div className="sidebar-search"><Search size={15} aria-hidden="true"/><input aria-label={t('Find nodes')} placeholder={t('Search nodes')} value={search} onChange={e => setSearch(e.target.value)}/></div>
        <div className="node-count muted"><span>{t('All nodes')}</span><span>{work.nodes.length}</span></div>
        <NodeOutline key={JSON.stringify([work.serviceId, work.projectId, work.id])} nodes={work.nodes} selected={selected} search={search} selectionRevision={selectionRevision} onSelect={id => { selectNodes([id]); canvas.current?.locate(id); }} />
      </>, props.sidebarTarget)}
      {outputMenu && <>
        <button className="dismiss-layer" aria-label="Close output list" onClick={() => setOutputMenu(undefined)}/>
        <div className="create-menu panel execution-output-menu" role="dialog" aria-label="Show outputs" style={{ position: "fixed", left: Math.max(12, Math.min(outputMenu.screen.x, window.innerWidth - 310)), top: Math.max(12, Math.min(outputMenu.screen.y, window.innerHeight - 310)) }}>
          <div className="panel-heading"><strong>Show outputs</strong><button className="icon-button" aria-label="Close output list" onClick={() => setOutputMenu(undefined)}><X size={16}/></button></div>
          <ExecutionOutputList
            outputs={(g.hiddenExecutionOutputs ?? []).filter(output => output.executionNodeId === outputMenu.nodeId).map(output => output.node)}
            disabled={readOnly}
            renderContent={output => renderNodeContent({ ...toWorkNode(output), readonly: true }, output)}
            onRestore={output => act(async () => {
              const current = editor.getSnapshot().graph;
              const position = outputPlacement(
                current.nodes.map(node => ({ ...nodeBounds(node), id: node.id, type: node.type, schemaVersion: node.schemaVersion, memberIds: node.memberIds })),
                nodeBounds(output),
                outputMenu.world,
                canvas.current?.getVisibleWorldBounds(),
              );
              const operations: GraphOperation[] = [{ type: "execution.output.restore", executionNodeId: outputMenu.nodeId, nodeId: output.id, x: position.x, y: position.y }];
              if (position.groupId) {
                const group = current.nodes.find(node => node.id === position.groupId);
                if (group) operations.push({ type: 'group.members', groupId: group.id, memberIds: [...(group.memberIds ?? []), output.id] });
              }
              await command(operations);
              setOutputMenu(undefined); selectNodes([output.id]);
            })}
          />
        </div>
      </>}
      {createMenu && <>
        <button className="dismiss-layer" aria-label={t("Close add node menu")} onClick={() => setCreateMenu(undefined)} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCreateMenu(undefined); }}/>
        <div ref={createMenuElement} className="create-menu node-create-menu panel" role="dialog" aria-label={t("Add node")} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} style={{ position: "fixed", left: createMenuPosition?.left ?? Math.max(12, createMenu.screen.x), top: createMenuPosition?.top ?? Math.max(12, createMenu.screen.y), visibility: createMenuPosition ? "visible" : "hidden" }}>
          <div className="panel-heading"><strong>{t("Add node")}</strong><button className="icon-button" aria-label={t("Close add node menu")} onClick={() => setCreateMenu(undefined)}><X size={16}/></button></div>
          {["text", "execution", "image", "document", "file", "preview"].map(type => {
            const definition = getNodeDefinition(type), Icon = definition.icon;
            return <button className="create-option" key={type} disabled={readOnly || (Boolean(createMenu.connection) && activeChainNodeIds.has(createMenu.connection!.nodeId)) || (!!createMenu.connection && ((type === "execution" && createMenu.connection.port === "input") || (type === "preview" && g.nodes.find(n => n.id === createMenu.connection!.nodeId)?.type === "preview")))} onClick={() => { const { world, connection } = createMenu; setCreateMenu(undefined); act(() => create(type, "", world, {}, connection)); }}><Icon size={18}/><span>{t(definition.title)}</span></button>;
          })}
          <button className="create-option" disabled={readOnly} onClick={() => { setCreateMenu(undefined); file.current?.click(); }}><Upload size={18}/>{t("Import file")}</button>
        </div>
      </>}
      {props.toastTarget
        ? createPortal(notices, props.toastTarget)
        : <div className="workgraph-toast-viewport workgraph-notices" aria-label="Work Graph operation notifications">{notices}</div>}
      <div
        className="real-canvas-row"
        onCopyCapture={(e) => {
          if (!clipboardTarget(e.target) || !selected.length) return;
          e.preventDefault();
          e.stopPropagation();
          act(() => {
            if (editor.getSnapshot().drafts.length)
              throw Error("Wait for the body content to finish saving before copying nodes.");
            const current = editor.getSnapshot().graph;
            const raw = encodeNodeClipboard(current, selected);
            e.clipboardData.setData(REAL_NODE_CLIPBOARD, raw);
            e.clipboardData.setData(
              "text/plain",
              current.nodes
                .filter((n) => selected.includes(n.id))
                .map((n) => {
                  const c = object(n.content);
                  return n.type === "execution" ? String(c.prompt ?? "") : String(c.text || c.prompt || c.title || n.type);
                })
                .join("\n\n"),
            );
          });
        }}
        onCutCapture={(e) => {
          if (!clipboardTarget(e.target) || !selected.length) return;
          e.preventDefault();
          e.stopPropagation();
          act(() => {
            throw Error(
              "Structured cut is not supported yet. Copy first, verify the pasted result, then delete explicitly.",
            );
          });
        }}
        onPasteCapture={(e) => {
          if (!clipboardTarget(e.target)) return;
          const raw = e.clipboardData.getData(REAL_NODE_CLIPBOARD);
          if (raw) {
            e.preventDefault();
            e.stopPropagation();
            const target = e.target as Element;
            act(() => pasteNodes(raw, target));
          } else if (e.clipboardData.getData(LEGACY_NODE_CLIPBOARD)) {
            e.preventDefault();
            e.stopPropagation();
            act(() => {
              throw Error(
                "Development Work Graph node data cannot be imported directly into a real graph. Paste it explicitly as plain text.",
              );
            });
          }
        }}
        onKeyDownCapture={(e) => {
          if (primaryModifier(e) && e.key.toLowerCase() === 'v' && e.repeat && clipboardTarget(e.target)) { e.preventDefault(); e.stopPropagation(); return; }
          if (!primaryModifier(e) || e.key.toLowerCase() !== "g") return;
          const target = e.target as HTMLElement;
          if (
            !target.closest(".owg-canvas") ||
            target.closest(
              "input,textarea,select,button,[contenteditable=true],[data-canvas-interactive],[data-canvas-no-zoom]",
            )
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          act(e.shiftKey ? ungroupSelection : groupSelection);
        }}
      >
        <Canvas
          key={viewportKey}
          ref={attachCanvas}
          initialViewport={readViewport(localStorage, viewportKey)}
          onViewportChange={viewport => saveViewport(localStorage, viewportKey, viewport)}
          theme={props.theme}
          graph={work}
          readOnly={readOnly}
          isNodeLocked={locked}
          isNodeRunning={id => latestNodeRuns.get(id)?.status === 'running'}
          isNodeWaiting={id => ['accepted', 'queued', 'preparing'].includes(latestNodeRuns.get(id)?.status ?? '')}
          isNodeAwaitingApproval={id => latestNodeRuns.get(id)?.status === 'waiting_approval'}
          isNodeFailed={id => { const run = latestNodeRuns.get(id); return run?.status === 'failed' && !acknowledgedFailures.has(failureKey(run)); }}
          onNodePointerDown={(id) => {
            acknowledgeNodeFailure(id);
          }}
          canMoveNodes={canGeometry}
          selectedIds={selected}
          onSelect={selectNodes}
          tool={tool}
          backgroundMode={background}
          locateNodeId={props.locateNodeId}
          onError={props.onError}
          shouldOpenNodeOnDoubleClick={n => hasProjectFileSource(g.nodes.find(item => item.id === n.id)?.content ?? null)}
          canEditTextOnSpace={n => !hasProjectFileSource(g.nodes.find(item => item.id === n.id)?.content ?? null) && !locked(n.id) && !state.drafts.some(d => d.nodeId === n.id && ['conflict', 'recovery'].includes(d.state))}
          onOpenNode={(n) => { selectNodes([n.id]); const openedContent = g.nodes.find(item => item.id === n.id)?.content ?? {}; if (hasProjectFileSource(openedContent)) setReferenceId(n.id); else if (n.type === "document") openDocument(n.id); else if (n.type === 'file') { if (typeof object(openedContent).resourceId === 'string') setReferenceId(n.id); } else setDetailsOpen(true); }}
          onActivateNode={n => {
            if (n.type === 'execution') return;
            if (n.type === 'preview' && openImageNodePreview(n.id)) return;
            if (n.type === 'image') { if (!openImageNodePreview(n.id)) setReferenceId(n.id); return; }
            if (n.type === 'document') { openDocument(n.id, true); return; }
            if (n.type === 'text' || n.type === 'file' || n.type === 'video' || n.type === 'preview') setReferenceId(n.id);
          }}
          onCreateMenu={readOnly ? undefined : (world, screen) => setCreateMenu({ world, screen })}
          onConnectCreate={readOnly ? undefined : (nodeId, world, screen, port) => { if (activeChainNodeIds.has(nodeId)) { props.onError(new Error(chainTopologyError)); return; } setCreateMenu({ world, screen, connection: { nodeId, port } }); }}
          onExecutionOutputs={(nodeId, world, screen) => { setCreateMenu(undefined); setOutputMenu({ nodeId, world, screen }); }}
          hiddenExecutionOutputCounts={(g.hiddenExecutionOutputs ?? []).reduce<Record<string, number>>((counts, output) => {
            counts[output.executionNodeId] = (counts[output.executionNodeId] ?? 0) + 1;
            return counts;
          }, {})}
          renderToolbar={n => <div className="node-toolbar" data-canvas-interactive>
            <input className="node-title-input" aria-label={n.type === "group" ? t("Group name") : "Node name"} value={n.type === "group" ? groupTitle : n.title} disabled={n.type === 'file' || !canGeometry([n.id]) || n.readonly} onChange={e => n.type === "group" ? setGroupTitle(e.target.value) : edit("title", e.target.value)} onBlur={() => { if (n.type === "group") act(renameGroup); }}
              onKeyDown={e => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }}/>
            {["image", "video"].includes(n.type) && !isProjectFileReference(content) && <button className="icon-button" aria-label="Replace media" title="Replace media" disabled={readOnly || n.readonly || !!draft} onClick={() => { replacement.current = { nodeId: n.id, type: n.type, version: node!.contentVersion, content: node!.content }; file.current?.click(); }}><Replace size={16}/></button>}
            {n.type === 'file' && !isProjectFileReference(content) && <button className="icon-button" aria-label={typeof content.resourceId === 'string' ? 'Upload again' : 'Upload file'} title={typeof content.resourceId === 'string' ? 'Upload again' : 'Upload file (maximum 300 MB)'} disabled={readOnly || n.readonly || !!draft} onClick={() => { replacement.current = { nodeId: n.id, type: n.type, version: node!.contentVersion, content: node!.content }; file.current?.click(); }}><Replace size={16}/></button>}
            {!['group', 'file', 'preview'].includes(n.type) && !isProjectFileReference(content) && <button className="icon-button" aria-label="Edit node" title="Edit node" onClick={() => n.type === "document" ? openDocument(n.id) : setDetailsOpen(true)}><Settings2 size={16}/></button>}
            {canCopyText && <button className="icon-button" aria-label="Create editable text copy" title="Create editable text copy" disabled={readOnly} onClick={() => act(() => create(node!.type, String(content.text ?? ""), { x: n.x + 40, y: n.y + 40 }, textCopyContent(node!, content)))}><Copy size={16}/></button>}
            {n.type === "execution" && <button className="icon-button" aria-label="Copy execution task" title="Copy execution task (prompt only)" disabled={readOnly} onClick={() => act(() => create("execution", "", { x: n.x + 40, y: n.y + 40 }, { prompt: String(content.prompt ?? ""), ...(Array.isArray(content.skillReferences) ? { skillReferences: content.skillReferences } : {}) }))}><Copy size={16}/></button>}
            {n.type === "text" && typeof object(content.generatedOutput).resourceId === "string" && <button className="icon-button" aria-label="View generated file" title="View generated file" onClick={() => setGeneratedOutputNodeId(n.id)}><FileText size={16}/></button>}
            {hasProjectFileSource(content) && <button className="icon-button" aria-label="Copy as resource node" title={props.temporary ? 'Temporary Work Graphs do not support copying project file resources yet' : 'Copy as resource node'} disabled={readOnly || props.temporary} onClick={() => act(() => copyProjectFileToResourceNode(n.id))}><Copy size={16}/></button>}
            {hasProjectFileSource(content) && <button className="icon-button" aria-label="Add to asset library (independent copy)" title="Add to asset library" disabled={readOnly || props.assetsAvailable === false} onClick={() => act(() => saveProjectFileAsset(n.id))}><FolderPlus size={16}/></button>}
            {n.type === "text" && !isProjectFileReference(content) && <button className="icon-button" aria-label="Save to asset library (independent copy)" title={savingTextAssets.has(n.id) ? "Saving text asset…" : textAssetJobs.current.has(n.id) ? "Retry saving original text copy" : "Save to asset library"} disabled={readOnly || props.assetsAvailable === false || savingTextAssets.has(n.id)} onClick={() => act(() => saveTextAsset(n.id))}><FolderPlus size={16}/></button>}
            {n.type !== "text" && !isProjectFileReference(content) && typeof content.resourceId === "string" && <button className="icon-button" aria-label="Save to asset library (independent copy)" title="Save to asset library" disabled={readOnly || props.assetsAvailable === false} onClick={() => act(async () => {
              const key = JSON.stringify([g.graphId, content.resourceId, content.resourceVersion, content.title]); const idempotencyKey = resourceSaveKeys.current.get(key) ?? randomId(); resourceSaveKeys.current.set(key, idempotencyKey); await (props.serviceRequest ?? props.request)(graphPath(g.projectId, g.graphId) + "/resources/save-to-library", { resourceId: content.resourceId, expectedVersion: content.resourceVersion, name: String(content.title ?? "Work Graph resource"), idempotencyKey }); resourceSaveKeys.current.delete(key); props.onAssetsChanged?.(); props.onChanged();
            })}><FolderPlus size={16}/></button>}
            {n.type !== 'group' && !isEmptyProjectFileReference(content) && (n.type !== 'file' || typeof content.resourceId === 'string' || hasProjectFileSource(content)) && <button className="icon-button" aria-label="View node content" title="View node content" onClick={() => { if (n.type === 'preview' && openImageNodePreview(n.id)) return; if (n.type === 'image') { openImageNodePreview(n.id); return; } if (hasProjectFileSource(content)) setReferenceId(n.id); else if (["text", "document"].includes(n.type)) openDocument(n.id); else if (n.type === "execution" && selectedRun) props.onOpenRun?.(selectedRun); else setReferenceId(n.id); }}><Maximize size={16}/></button>}
            {n.type === 'group' && <button className="icon-button" aria-label={t("Ungroup")} title={t("Ungroup")} disabled={!canUngroup} onClick={() => act(ungroupSelection)}><Ungroup size={16}/></button>}
            <button className="icon-button" aria-label="Delete selected node" title="Delete selected node" disabled={!canDelete([n.id])} onClick={() => act(() => { guardDelete([n.id]); return command([{ type: "node.delete", nodeId: n.id }]); })}><Trash2 size={16}/></button>
          </div>}
          onUndo={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canUndo ? undefined : () => act(() => travelHistory(false))}
          onRedo={readOnly || pasteState.count > 0 || historyState.busy || !historyState.canRedo ? undefined : () => act(() => travelHistory(true))}
          onMove={
            readOnly
              ? undefined
              : async (moves) => {
                    const ids = moves.map((move) => move.id);
                    guardGeometry(ids);
                    const operations = moveWithMembershipOperations(editor.getSnapshot().graph, moves);
                    guardGeometry(operations.flatMap(op => op.type === 'group.members' ? [op.groupId, ...op.memberIds] : op.type === 'layout.resize' ? op.sizes.map(s => s.nodeId) : []));
                    await command(operations);
                  }
          }
          onResize={
            readOnly
              ? undefined
              : async (id, bounds) => {
                    guardGeometry([id]);
                    await command(resizeWithMembershipOperations(editor.getSnapshot().graph, id, bounds));
                  }
          }
          onConnect={
            readOnly
              ? undefined
              : (sourceId, targetId) =>
                  act(() => {
                    guardLayout([targetId]);
                    const currentGraph = editor.getSnapshot().graph;
                    const source = currentGraph.nodes.find(n => n.id === sourceId);
                    const target = currentGraph.nodes.find(n => n.id === targetId);
                    if (!source || !target) throw Error("A connected node does not exist. Refresh the Work Graph and try again.");
                    const executionChain = source.type === "execution" && target.type === "execution";
                    if (executionChain && (activeChainNodeIds.has(sourceId) || activeChainNodeIds.has(targetId))) throw Error(chainTopologyError);
                    if (source.type === "execution" && !executionChain) throw Error("Drag an output from the output folder, then connect the output node.");
                    if (executionChain) {
                      if (!executionOrder([...currentGraph.edges, { sourceId, targetId, kind: 'execution' }])) throw Error('Cannot create the chain connection because it would form a cycle.');
                    }
                    if (
                      editor
                        .getSnapshot()
                        .graph.nodes.some(
                          (n) =>
                            [sourceId, targetId].includes(n.id) &&
                            n.type === "group",
                        )
                    )
                      throw Error("Layout-only groups cannot be connection endpoints.");
                    if (locked(targetId)) throw Error("Active node input connections are locked");
                    return command([
                      {
                        type: "edge.create",
                        edge: {
                          id: randomId(),
                          sourceId,
                          targetId,
                          kind: executionChain ? "execution" : "reference",
                        },
                      },
                    ]);
                  })
          }
          onDeleteNodes={
            readOnly
              ? undefined
              : (ids) =>
                  act(() => {
                    guardDelete(ids);
                    return command(
                      ids.map((nodeId) => ({ type: "node.delete", nodeId })),
                    );
                  })
          }
          onDeleteEdge={
            readOnly
              ? undefined
              : (edgeId) =>
                  act(() => {
                    const edge = g.edges.find((e) => e.id === edgeId);
                    if (edge && activeChainExecutionEdge(edge)) throw Error(chainTopologyError);
                    if (edge?.kind === "delivery")
                      throw Error("Delivery relationships cannot be removed");
                    if (edge) guardLayout([edge.targetId]);
                    if (edge && locked(edge.targetId))
                      throw Error("Active node input connections are locked");
                    return command([{ type: "edge.delete", edgeId }]);
                  })
          }
          onPasteText={
            readOnly
              ? undefined
              : (text, position) => act(() => create("text", text, position))
          }
          onImportFiles={
            readOnly
              ? undefined
              : (files, position) =>
                  upload(files, position).catch(props.onError)
          }
          canDropData={(data, targetNodeId) => !readOnly && (canDropProjectFile(data, g.projectId) ? !targetNodeId || isEmptyProjectFileReference(g.nodes.find(item => item.id === targetNodeId)?.content ?? null) : !targetNodeId && props.assetsAvailable !== false && canDropAsset(data, { request: props.serviceRequest ?? props.request, projectId: g.projectId, graphId: g.graphId }))}
          onDropData={(data, position, targetNodeId) => canDropProjectFile(data, g.projectId) ? dropProjectFile(data, g.projectId, position, targetNodeId && isEmptyProjectFileReference(g.nodes.find(item => item.id === targetNodeId)?.content ?? null) ? targetNodeId : undefined, (id, path) => act(() => associateProjectFile(id, path))) : dropAsset(data, { request: props.serviceRequest ?? props.request, projectId: g.projectId, graphId: g.graphId }, position)}
          renderPanel={panelNode => node && panelNode.id === node.id && selected.length === 1 && detailsOpen && !isProjectFileReference(node.content) && ["text", "image", "execution"].includes(node.type) && node.schemaVersion === 1 ? (
            <PromptEditor key={node.id} inputChanged={inputChanged} value={String(content.prompt ?? "")} disabled={promptDisabled} runDisabled={runDisabled}
              references={g.edges.filter(edge => edge.kind === "reference" && edge.targetId === node.id).map(edge => ({ id: edge.sourceId, title: work.nodes.find(n => n.id === edge.sourceId)?.title || "Reference node" }))}
              onOpenReference={setReferenceId} onClose={() => setDetailsOpen(false)} onRun={() => act(runNode)} onChange={(value, references) => { if (node) act(() => { guardLayout([node.id]); editor.edit(node.id, { ...content, prompt: value, skillReferences: (references ?? syncSkillReferences(String(content.prompt ?? ""), value, (Array.isArray(content.skillReferences) ? content.skillReferences : []) as unknown as SkillReference[])) as unknown as Json }); }); }}
              mentionEnabled={props.online && props.projectActive}
              skillEnabled={node.type !== "image" || selectedRoute.type === "codex"}
              skillReferences={(Array.isArray(content.skillReferences) ? content.skillReferences : []) as unknown as SkillReference[]}
              mentionRequest={props.serviceRequest ?? props.request}
              mentionProjectId={g.projectId}
              onOpenProjectFile={item => item.kind === 'directory' ? props.onOpenProjectDirectory?.(item.relativePath) : setPromptProjectFile({ path:item.relativePath, name:item.name })}
              placeholder={node.type === "execution" ? t("Describe the work you want to complete…") : node.type === "image" ? t("Describe the image you want to generate…") : t("Describe how you want to revise this text")}
              status={running ? t("Saving and submitting…") : locked(node.id) ? t("Locked while running") : unavailableReason}
              submitting={running}
              runHint={unavailableReason}
              additionalWarnings={draft && ["conflict", "failed", "recovery"].includes(draft.state) ? [t(draftNoticeTitle(draft)), t(DRAFT_RECOVERY_NOTICE)] : []}
              runLabel={node.type === "execution" ? t("Run") : t("Generate")}
              controls={<div className={node.type === 'image' ? 'image-prompt-settings' : 'prompt-model-settings'}>
                {node.type==='image' && showModelControls && <>
                <label className="image-toolbar-route" title={t('Generation method')}><select aria-label={t('Image generation method')} value={selectedRoute.type==='api'?selectedRoute.providerId:'codex'} disabled={promptDisabled} onChange={e => {
                  const provider=imageProviders.find(item=>item.id===e.target.value);
                  const providerModel=provider?(provider.models.find(item=>item.isDefault)??provider.models[0]):undefined;
                  saveImageRoute(provider?{type:'api',providerId:provider.id,modelId:providerModel?.id??'',options:providerModel?normalizeImageOptionsForModel(imageOptions,providerModel):imageOptions}:{type:'codex',options:imageOptions});
                }}><option value="codex">{t('Codex image generation')}</option>{imageProviders.map(provider=><option key={provider.id} value={provider.id}>{provider.models.length ? provider.name : t('{name} (no model selected)', {name:provider.name})}</option>)}</select></label>
                {selectedRoute.type==='api' && <label className="image-toolbar-model" title={t('Image model')}><select aria-label={t('Image model')} value={selectedRoute.modelId} disabled={promptDisabled||!selectedProvider?.models.length} onChange={event=>{const nextModel=selectedProvider?.models.find(item=>item.id===event.target.value);saveImageRoute({...selectedRoute,modelId:event.target.value,options:nextModel?normalizeImageOptionsForModel(imageOptions,nextModel):imageOptions});}}>{selectedProvider?.models.length?<>{selectedProvider.models.map(item=><option key={item.id} value={item.id}>{item.name || item.id}</option>)}</>:<option value="">{t('No image model has been added. Configure one in Workspace management first.')}</option>}</select></label>}

                </>}
                {showModelControls && (node.type!=='image'||selectedRoute.type==='codex') && <><select aria-label={t('Run model')} title={t('Run model')} value={model} disabled={promptDisabled} onChange={e => {
                  setModel(e.target.value); setEffort(""); act(() => editor.edit(node.id, { ...content, modelOverride: e.target.value ? { model: e.target.value, reasoningEffort: null } : null }));
                }}><option value="">{models?.selection?.model ?? t('Workspace default')}</option>{models?.available.map(m => <option key={m.id}>{m.id}</option>)}{model && !models?.available.some(m => m.id === model) && <option value={model}>{t('{model} (currently unavailable)', {model})}</option>}</select>
                {node.type !== 'image' && reasoningControl}</>}
                {node.type === 'image' && <button type="button" className="image-settings-trigger" aria-label={t('Image settings')} aria-haspopup="dialog" aria-expanded={imageSettingsOpen} title={t('Image settings: quality, size, aspect ratio, and reasoning effort')} disabled={promptDisabled} onClick={()=>setImageSettingsOpen(true)}><Settings2 size={14}/><span>{imageOptions.quality==='auto'?t('Auto'):t({high:'High',medium:'Medium',low:'Low'}[imageOptions.quality!])} · {imageOptions.aspectRatio === 'auto' ? t('Auto ratio') : imageOptions.aspectRatio}</span></button>}
              </div>}
            >
            {draft &&
              ["conflict", "failed", "recovery"].includes(draft.state) && (
                <Conflict
                  hideNotice
                  key={node.id + draft.state}
                  draft={draft}
                  remote={node.content}
                  disabled={readOnly}
                  onError={props.onError}
                  resolve={(content) =>
                    act(() => editor.resolve(node.id, content))
                  }
                />
              )}
            </PromptEditor>) : null}
          renderNode={n => renderNodeContent(n, g.nodes.find(v => v.id === n.id)!)}
          nodeRenderKey={n => nodeRenderKeys.get(n.id)}
          renderTitlePrefix={n => {
            const source = projectFileSource(g.nodes.find(node => node.id === n.id)?.content ?? null);
            const definition = getNodeDefinition(n.type);
            const TitleIcon = n.type === "group" ? Square : definition.icon;
            return <>
              {n.type === "document" && n.readonly && <span className="owg-node-readonly-mark" title={t('Read-only document')} data-node-readonly-icon="true"><Lock className="owg-node-title-icon owg-node-readonly-icon" size={16} aria-label={t('Read-only document')} role="img"/></span>}
              {projectFileReferenceIds.has(n.id) && <span className="owg-project-reference-mark" title={String(source.relativePath ?? '')} data-project-file-reference="true"><Link2 className="owg-node-title-icon owg-project-reference-icon" size={16} aria-label="Project file reference"/></span>}
              {!projectFileReferenceIds.has(n.id) && <span className={"owg-node-type-mark" + (n.type === "preview" ? " owg-preview-node-title-mark" : "")} aria-label={n.type === "group" ? "Group node" : definition.title + " node"} data-node-type-icon={n.type} {...(n.type === "preview" ? { "data-preview-node": "true" } : {})}><TitleIcon className="owg-node-title-icon owg-node-type-icon" size={16}/></span>}
            </>;
          }}
        />
      </div>
      {reference && <ReferenceDialog key={reference.id} title={reference.title} fitted={reference.type === 'file' || reference.type === 'preview'} navigation={previewNavigation} onClose={closePreviewDialogs}>
        {object(referenceContent.source).kind === 'project-file' && ['image','video'].includes(reference.type) ? <CanvasProjectFilePreview key={reference.id + ':' + projectFilesRevision} request={props.serviceRequest ?? props.request} projectId={g.projectId} relativePath={String(object(referenceContent.source).relativePath)} mime={String(referenceContent.mime ?? 'application/octet-stream')} name={reference.title} onError={props.onError}/> : object(referenceContent.source).kind === 'project-file' && reference.type === 'file' ? <ProjectFilePreview key={reference.id + ':' + projectFilesRevision} request={props.serviceRequest ?? props.request} projectId={g.projectId} relativePath={String(object(referenceContent.source).relativePath)} mime={String(referenceContent.mime ?? 'application/octet-stream')} name={reference.title} download showName={false}/> : object(referenceContent.source).kind === 'project-file' ? <ProjectFileContent key={reference.id + ':' + projectFilesRevision} request={props.serviceRequest ?? props.request} projectId={g.projectId} source={object(referenceContent.source)} mime={String(referenceContent.mime ?? 'application/octet-stream')} name={reference.title} onOpenLink={openMarkdownLink}/> : reference.type === 'file' && typeof referenceContent.resourceId === 'string' ? <ResourceFilePreview request={props.request} projectId={g.projectId} graphId={g.graphId} resourceId={referenceContent.resourceId} version={Number(referenceContent.resourceVersion)} name={reference.title} mime={typeof referenceContent.mime === 'string' ? referenceContent.mime : ''} showName={false}/> : reference.type === "preview" ? <PreviewNode key={reference.id + ':' + projectFilesRevision} graph={g} nodeId={reference.id} request={props.request} onError={props.onError} {...previewModeProps(referenceWire!)}/> : reference.type !== "text" && typeof referenceContent.resourceId === "string" ? <CanvasResourcePreview request={props.request} projectId={g.projectId} graphId={g.graphId} resourceId={referenceContent.resourceId} version={Number(referenceContent.resourceVersion)} mime={typeof referenceContent.mime === "string" ? referenceContent.mime : undefined} name={reference.title} onError={props.onError}/> : <MarkdownPreview text={reference.type === "execution" ? reference.prompt : reference.content} onOpenLink={openMarkdownLink}/>}
      </ReferenceDialog>}
      {generatedOutputNode && typeof generatedOutput.resourceId === "string" && <ReferenceDialog key={generatedOutputNode.id} title={String(generatedOutput.name ?? "Generated file")} navigation={previewNavigation} onClose={closePreviewDialogs}>
        <CanvasResourcePreview request={props.request} projectId={g.projectId} graphId={g.graphId} resourceId={generatedOutput.resourceId} version={Number(generatedOutput.resourceVersion)} mime={typeof generatedOutput.mime === "string" ? generatedOutput.mime : undefined} name={String(generatedOutput.name ?? "Generated file")} onError={props.onError}/>
      </ReferenceDialog>}
      {promptProjectFile && <ReferenceDialog key={promptProjectFile.path + ':' + projectFilesRevision} title={promptProjectFile.name} fitted navigation={previewNavigation} onClose={closePreviewDialogs}>
        <ProjectFilePreview request={props.serviceRequest ?? props.request} projectId={g.projectId} relativePath={promptProjectFile.path} name={promptProjectFile.name} mime={fileMime({ name:promptProjectFile.name, type:'' })} download showName={false}/>
      </ReferenceDialog>}
      {!hasPreviewRoot && (linkedPreviewLayers.length > 0 || markdownLinkPending) && <ReferenceDialog title={linkedPreviewLayers[0]?.title ?? t('Loading preview…')} fitted navigation={{ ...previewNavigation, layers: linkedPreviewLayers.slice(1) }} onClose={closePreviewDialogs}>
        {linkedPreviewLayers[0]?.content ?? <p role="status">{t('Loading preview…')}</p>}
      </ReferenceDialog>}
      {externalLink && <ExternalLinkConfirmDialog url={externalLink} onClose={() => setExternalLink(undefined)} onOpen={() => { const url=externalLink; setExternalLink(undefined); window.open(url, '_blank', 'noopener,noreferrer'); }}/>}

      {documentNode && <DocumentDialog
        initialPreview={documentPreviewId === documentId || (documentWire?.type !== "text" && typeof object(documentWire?.content ?? {}).resourceId === "string")}
        node={{ ...documentNode, readonly: documentNode.readonly || (documentNode.type !== "text" && locked(documentNode.id)) }}
        navigation={previewNavigation}
        onClose={closePreviewDialogs}
        onError={props.onError}
        onOpenLink={openMarkdownLink}
        imageRequest={props.serviceRequest ?? props.request}
        imageRevision={projectFilesRevision}
        onSelect={copy => { setSelected([copy.id]); openDocument(copy.id); }}
        saveStatus={saveLabel}
        onDraft={patch => {
          guardLayout(documentNode.type === "text" ? [] : [documentNode.id]);
          const current = editor.getSnapshot();
          const target = current.graph.nodes.find(n => n.id === documentNode.id);
          if (!target) throw Error("The document was removed.");
          const local = current.drafts.find(d => d.nodeId === target.id);
          const content = { ...object(local?.content ?? target.content), title: patch.title, text: patch.content } as Record<string, Json>;
          // Editing a textual file creates inline canvas content; its original immutable
          // resource remains protected by history and never mutates a library asset.
          delete content.resourceId; delete content.resourceVersion; delete content.mime;
          editor.edit(target.id, content);
        }}
        onCopy={readOnly ? undefined : async () => {
          const id = await create("document", documentNode.content, { x: documentNode.x + 50, y: documentNode.y + 50 }, { title: documentNode.title + " copy" });
          return { ...documentNode, id, nodeId: id, readonly: false };
        }}
      >{state.drafts.filter(d => d.nodeId === documentNode.id && ["conflict", "failed", "recovery"].includes(d.state)).map(d => <Conflict key={d.nodeId + d.state} draft={d} remote={documentWire?.content ?? {}} disabled={readOnly} resolve={content => act(() => editor.resolve(d.nodeId, content))} onError={props.onError}/>)}</DocumentDialog>}
      <input
        hidden
        type="file"
        multiple
        ref={file}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const target = replacement.current; replacement.current = undefined;
          if (target && files[0]) {
            const job: CanvasUploadJob = { id: randomId(), file: files[0], replacement: target, position: { x: 0, y: 0 }, progress: 0, state: "uploading" };
            setUploads(jobs => [...jobs, job]); act(() => resumeUpload(job));
          } else act(() => upload(files));
        }}
      />
    </section>
    </MarkdownPreviewProvider>
  );
}
function RunResubmitDialog({ title, action, disabled, onClose, onConfirm }: { title: string; action: string; disabled: boolean; onClose(): void; onConfirm(): void }) {
  const {t} = useI18n();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop markdown-link-confirm-backdrop" onClick={onClose}><section className="reference-preview panel markdown-link-confirm" role="alertdialog" aria-modal="true" aria-label={t('Confirm resubmission')} tabIndex={-1} ref={dialog} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="panel-heading"><strong>{t('Submit this node again?')}</strong></div>
    <p>{t('“{title}” has already been submitted. Confirm to start another run.', { title })}</p>
    <div className="button-row"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary-button" disabled={disabled} onClick={onConfirm}>{t('Confirm {action}', { action })}</button></div>
  </section></div>;
}
function ReferenceDialog({ title, onClose, children, fitted=false, navigation }: { title: string; onClose(): void; children: ReactNode; fitted?:boolean; navigation?: PreviewDialogNavigation }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop reference-preview-backdrop" onClick={onClose}><section className={'reference-preview panel' + (fitted ? ' reference-preview-fitted' : '')} role="dialog" aria-modal="true" aria-label="Reference content preview" tabIndex={-1} ref={dialog} onClick={e => e.stopPropagation()} onKeyDown={e => {
    e.stopPropagation();
    if (e.key === "Escape" || (e.code === "Space" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !(e.target as Element).closest('button,a[href],video,audio,input,textarea,select,[contenteditable="true"]'))) { e.preventDefault(); onClose(); }
    if (e.key === "Tab") {
      const controls = visibleDialogControls(dialog.current);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus(); }
    }
  }}><PreviewDialogHeading title={title} navigation={navigation} onClose={onClose} closeLabel="Close reference preview"/><MarkdownPreviewProvider expandableImages><PreviewDialogLayers navigation={navigation}>{fitted ? children : <div className="reference-preview-body">{children}</div>}</PreviewDialogLayers></MarkdownPreviewProvider></section></div>;
}
function ExternalLinkConfirmDialog({url,onClose,onOpen}: {url:string;onClose():void;onOpen():void}) {
  const {t}=useI18n();
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{dialog.current?.focus();},[]);
  return <div className="modal-backdrop markdown-link-confirm-backdrop" onClick={onClose}><section className="reference-preview panel markdown-link-confirm" role="alertdialog" aria-modal="true" aria-label={t('Confirm opening external link')} tabIndex={-1} ref={dialog} onClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();onClose();}}}>
    <div className="panel-heading"><strong>{t('Open external link?')}</strong></div>
    <p>{t('This link will open in a new browser tab:')}</p><code>{url}</code>
    <div className="button-row"><button type="button" className="primary-button" onClick={onOpen}>{t('Open link')}</button><button type="button" onClick={onClose}>{t('Cancel')}</button></div>
  </section></div>;
}
function draftNoticeTitle(draft: Draft): string {
  return draft.state === "recovery" ? "Recover unsaved draft" : draft.state === "failed" ? "Save failed" : "Body version conflict";
}
const DRAFT_RECOVERY_NOTICE = "Review the latest Workspace content first. Keeping local content or merging still requires version validation; nothing is force-overwritten and no run is restarted automatically.";
function Conflict({
  draft,
  remote,
  disabled,
  resolve,
  onError,
  hideNotice = false,
}: {
  draft: Draft;
  remote: Json;
  disabled: boolean;
  resolve: (content?: Json) => void;
  onError: (error: unknown) => void;
  hideNotice?: boolean;
}) {
  const [merged, setMerged] = useState(JSON.stringify(draft.content, null, 2));
  return (
    <section aria-label="Body conflict and draft recovery">
      {!hideNotice && <><h3>{draftNoticeTitle(draft)}</h3><p>{DRAFT_RECOVERY_NOTICE}</p></>}
      <div className="real-conflict">
        <label>
          Local draft
          <textarea
            value={merged}
            onChange={(e) => setMerged(e.target.value)}
          />
        </label>
        <label>
          Latest Workspace content
          <textarea readOnly value={JSON.stringify(remote, null, 2)} />
        </label>
      </div>
      <button disabled={disabled} onClick={() => resolve()}>
        Use Workspace content
      </button>
      <button disabled={disabled} onClick={() => resolve(draft.content)}>
        Recover local content and validate
      </button>
      <button
        disabled={disabled}
        onClick={() => {
          try {
            resolve(JSON.parse(merged));
          } catch (e) {
            onError(e);
          }
        }}
      >
        Save manual merge
      </button>
    </section>
  );
}
