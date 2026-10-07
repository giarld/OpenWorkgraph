import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { Moon, Sun, PanelLeftClose, PanelLeftOpen, Settings2, Bell, Check, Layers, Download, Pencil, Trash2, Upload, Plus, RotateCcw, Server, ChevronRight, CheckCircle2, Unplug, WifiOff, CircleAlert, Copy, Archive } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { randomId } from "../adapter/random";
import { FILE_NODE_MAX_BYTES, fileMime, importedNodeType } from '../domain/file-types';
import { runtimeStatus } from './runtime-status';
import { runtimeNeedsUpgrade } from '../domain/runtime-version';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionRegistry, RUNTIME_NAME_MAX_LENGTH, type Connection } from "../adapter/connections";
import { createPairingIdentity, type PairingIdentity } from '../adapter/client-pairing';
import {
  Transport,
  LifecycleCancelledError,
  isLifecycleCancellation,
} from "../adapter/transport";
import { EventSubscription } from "../adapter/events";
import type {
  GraphSnapshot,
  Json,
  Project,
  Request,
  Run,
  RunNotification,
} from "./contracts";
import { graphPath, messageOf } from "./contracts";
import { useTemporaryCanvases } from "./use-temporary-canvases";
import type { GraphBundle } from '../../../packages/protocol/src/index';
import { GraphWorkspace } from "./GraphWorkspace";
import { appendToastQueueItem, ToastQueue, type ToastQueueItem } from './Toast';
import { readRecentGraphs, rememberGraph, type RecentGraph } from './recent-graphs';
import type { CanvasHandle, Point } from '../canvas/Canvas';
import { executionUnavailableReason } from './execution-availability';
import { GraphEditor } from "./editor";
import { createAuthoritativeLoader } from "./authoritative-loader";
export { createAuthoritativeLoader } from "./authoritative-loader";
import { readProjectGraphPages } from "./graph-pages";
import { groupLibraryGraphs } from './library-graphs';
import { createWorkGraphArchive, readWorkGraphFile, workGraphArchiveFilename } from './workgraph-archive';
import { ManagementPanel } from "./ManagementPanel";
import { ResourcesPanel, type CanvasCreated, type LibraryAsset, type ResourcePlacement } from "./ResourcesPanel";
import { ProjectFilesPanel } from './ProjectFilesPanel';
import { runsForDetail, RunsPanel } from "./RunsPanel";
import { createRunNotifications } from "./notifications";
import { RunNotifications } from "./RunNotifications";
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { useI18n } from '../i18n/I18nProvider';
import '../i18n/catalogs/app';
import "./real.css";
import { WelcomeDialog } from './WelcomeDialog';
import webClientPackage from '../../package.json';
interface ServiceData {
  generation: number;
  projects: Project[];
  graphs: GraphSnapshot[];
  runs: Run[];
  notifications: RunNotification[];
  revision: number;
  error?: string;
  eventStatus: "starting" | "connected" | "offline";
}
function clearServiceCache(serviceId: string) {
  const prefix = "openworkgraph:real:cache:" + serviceId + ":";
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith(prefix)) sessionStorage.removeItem(key);
}
/** Capture before any await; selection epochs also reject A→B→A navigation. */
export function captureSelection(
  registry: ConnectionRegistry,
  serviceId: string,
  selection: { current: number },
) {
  const lease = registry.lease(serviceId),
    epoch = selection.current;
  return () => {
    registry.assertCurrent(lease);
    if (selection.current !== epoch) throw new LifecycleCancelledError();
  };
}

export function isSnapshotSafeReadRequest(path: string, method?: string): boolean {
  const verb = (method ?? 'POST').toUpperCase();
  if (verb !== 'POST') return false;
  return /^\/v1\/projects\/[A-Za-z0-9_-]+\/assets\/(query|same-name)$/.test(path)
    || /^\/v1\/projects\/[A-Za-z0-9_-]+\/files\/stat$/.test(path);
}
type LeftSidebarTab = 'canvas' | 'files' | 'assets';
const LEFT_SIDEBAR_TAB_STORAGE_KEY = 'openworkgraph:left-sidebar-tab:v1';

function readLeftSidebarTab(): LeftSidebarTab {
  try {
    const value = localStorage.getItem(LEFT_SIDEBAR_TAB_STORAGE_KEY);
    if (value === 'canvas' || value === 'files' || value === 'assets') return value;
  } catch { /* Unavailable preferences must not prevent startup. */ }
  return 'canvas';
}

export function RealApp() {
  const { t } = useI18n();
  const [savedSelection] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem('openworkgraph:selection:v1') ?? 'null');
      if (value && typeof value.temporary === 'boolean' &&
          ['activeService', 'projectId', 'graphId'].every(key => typeof value[key] === 'string') &&
          ['active', 'archived', 'trashed'].includes(value.filter))
        return value as { temporary: boolean; activeService: string; projectId: string; graphId: string; filter: 'active' | 'archived' | 'trashed' };
    } catch { /* Unavailable or invalid preferences must not prevent startup. */ }
    return { temporary: false, activeService: '', projectId: '', graphId: '', filter: 'active' as const };
  });
  const [page, setPage] = useState<'editor' | 'library'>(() => location.hash === '#workgraphs' ? 'library' : 'editor');
  const importInput = useRef<HTMLInputElement>(null);
  const [selectedCards, setSelectedCards] = useState<string[]>([]);
  const [libraryProjectId, setLibraryProjectId] = useState('');
  const enterLibrary = useRef(() => {});
  const [creating, setCreating] = useState(false);
  const [cardRename, setCardRename] = useState<GraphSnapshot>();
  const [runtimeRename, setRuntimeRename] = useState<{ serviceId: string; sessionId: string; name: string }>();
  const [cardTitle, setCardTitle] = useState('');
  const [cardPurge, setCardPurge] = useState<GraphSnapshot>();
  const [cardPurgeTitle, setCardPurgeTitle] = useState('');
  useEffect(() => { const sync = () => { if (location.hash === '#workgraphs') enterLibrary.current(); setPage(location.hash === '#workgraphs' ? 'library' : 'editor'); setServicePanelOpen(false); }; window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync); }, []);
  const showPage = (value: 'editor' | 'library') => { if (value === 'library') setLibraryProjectId(''); setPage(value); setServicePanelOpen(false); if (value === 'editor' && window.innerWidth <= 700) setLeftOpen(false); location.hash = value === 'library' ? 'workgraphs' : 'editor'; };
  const [rightPanel, setRightPanel] = useState<'queue' | 'management' | 'details' | null>(null);
  const [closingRightPanel, setClosingRightPanel] = useState<'queue' | 'management' | 'details' | null>(null);
  useEffect(() => {
    if (rightPanel) {
      setClosingRightPanel(rightPanel);
      return;
    }
    const timer = window.setTimeout(() => setClosingRightPanel(null), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240);
    return () => window.clearTimeout(timer);
  }, [rightPanel]);
  const panelContent = rightPanel ?? closingRightPanel;
  const servicePanelOpen = rightPanel === 'management';
  const setServicePanelOpen = (value: boolean | ((open: boolean) => boolean)) =>
    setRightPanel(current => (typeof value === 'function' ? value(current === 'management') : value) ? 'management' : current === 'management' ? null : current);
  const [servicePage, setServicePage] = useState<"list" | "connect" | "projects">("list");
  const [managementInitialPage, setManagementInitialPage] = useState<'projects' | 'add'>('projects');
  const [managementEntry, setManagementEntry] = useState(0);
  const [nodeSidebar, setNodeSidebar] = useState<HTMLDivElement | null>(null);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 700);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number | null>(() => {
    try {
      const width = Number(localStorage.getItem('openworkgraph:left-sidebar-width'));
      return Number.isFinite(width) && width >= 220 && width <= 480 ? width : null;
    } catch { return null; }
  });
  const sidebarResize = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const sidebarWidthLimit = () => Math.max(220, Math.min(480, window.innerWidth - 320));
  const resizeSidebar = (width: number) => {
    const next = Math.max(220, Math.min(sidebarWidthLimit(), width));
    if (sidebarResize.current) sidebarResize.current.width = next;
    setLeftSidebarWidth(next);
  };
  useEffect(() => () => { document.body.classList.remove('resizing-left-sidebar'); }, []);
  useEffect(() => {
    if (leftOpen && page === 'editor') return;
    sidebarResize.current = null;
    document.body.classList.remove('resizing-left-sidebar');
  }, [leftOpen, page]);
  const [theme, setTheme] = useState<"dark" | "light">(() => localStorage.getItem("openworkgraph:theme") === "light" ? "light" : "dark");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("openworkgraph:theme", theme); }, [theme]);
  const [temporary, setTemporary] = useState(savedSelection.temporary);
  const [registry] = useState(() => new ConnectionRegistry());
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [connections, setConnections] = useState<Connection[]>([]);
  const [updatingRuntime, setUpdatingRuntime] = useState<{ serviceId: string; version: string }>();
  const [connectionsRestored, setConnectionsRestored] = useState(false);
  const [welcomePairing, setWelcomePairing] = useState(false);
  const [data, setData] = useState<Record<string, ServiceData>>({});
  const dataRef = useRef(data);
  dataRef.current = data;
  const [activeService, setActiveService] = useState(savedSelection.activeService);
  const [projectId, setProjectId] = useState(savedSelection.projectId);
  const [graphId, setGraphId] = useState(savedSelection.graphId);
  const [recentGraphs, setRecentGraphs] = useState(() => readRecentGraphs(localStorage));
  const [detailRun, setDetailRun] = useState<Run>();
  const [locateNodeId, setLocateNodeId] = useState("");
  const [editExecutionNode, setEditExecutionNode] = useState<{nodeId:string;graphId:string;projectId:string;nonce:number}>();
  const [tab, setTab] = useState<LeftSidebarTab>(readLeftSidebarTab);
  useEffect(() => {
    try { localStorage.setItem(LEFT_SIDEBAR_TAB_STORAGE_KEY, tab); }
    catch { /* Sidebar navigation remains available without storage. */ }
  }, [tab]);
  const [filter, setFilter] = useState<"active" | "archived" | "trashed">(
    savedSelection.filter,
  );
  useEffect(() => {
    try {
      // Persist navigation intent, never a fallback shown while snapshots load.
      localStorage.setItem('openworkgraph:selection:v1', JSON.stringify({ temporary, activeService, projectId, graphId, filter }));
    } catch { /* Navigation remains available when browser storage is disabled. */ }
  }, [temporary, activeService, projectId, graphId, filter]);
  const [toastItems, setToastItems] = useState<ToastQueueItem[]>([]);
  const [toastViewport, setToastViewport] = useState<HTMLDivElement | null>(null);
  const toastSequence = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const [modelRevision, setModelRevision] = useState(0);
  const [noticeRevision, setNoticeRevision] = useState(0);
  const [graphName, setGraphName] = useState("");
  const [deleteName, setDeleteName] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmTrashGraphs, setConfirmTrashGraphs] = useState<GraphSnapshot[]>();
  useEffect(() => setConfirmTrashGraphs(undefined), [temporary, activeService, projectId, libraryProjectId, page]);
  const [actionDialog, setActionDialog] = useState<'copy' | 'archive' | 'trash'>();
  const [copyServiceId, setCopyServiceId] = useState('');
  const [copyProjectId, setCopyProjectId] = useState('');
  const [copyPending, setCopyPending] = useState(false);
  const copyAttempt = useRef<{ scope: string; sessionId: string; bundle: GraphBundle; idempotencyKey: string } | undefined>(undefined);
  const navigation = useRef(0);
  const selectionKey = useRef("");
  const restored = useRef<Promise<Connection[]> | undefined>(undefined);
  const editor = useRef<GraphEditor | undefined>(undefined);
  const canvas = useRef<CanvasHandle | null>(null);
  const attachCanvas = useCallback((handle: CanvasHandle | null) => { canvas.current = handle; }, []);
  const projectFilePlacements = useRef(new Map<string, {
    editor: GraphEditor;
    nodeId: string;
    created: Promise<GraphSnapshot>;
    association?: () => Promise<GraphSnapshot>;
    uncertain: boolean;
  }>());
  const enqueueToast = useCallback((content: string, role: 'status' | 'alert' = 'alert') => {
    const id = `toast-${++toastSequence.current}`;
    setToastItems(items => appendToastQueueItem(items, { id, content, role, duration: role === 'alert' ? 10000 : 5000, dismissLabel: t('Close') }));
  }, [t]);
  const dismissToast = useCallback((id: string) => {
    setToastItems(items => items.filter(item => item.id !== id));
  }, []);
  const onError = useCallback((e: unknown) => {
    if (!isLifecycleCancellation(e)) enqueueToast(messageOf(e));
  }, [enqueueToast]);
  const local = useTemporaryCanvases(onError);
  const changed = useCallback(() => setRefresh((n) => n + 1), []);
  const [notifications] = useState(() =>
    createRunNotifications({
      storage: localStorage,
      revalidateSession: async (serviceId) => {
        const current = captureSelection(registry, serviceId, navigation);
        await new Transport(registry, serviceId).request("/v1/session");
        current();
        return registry.get(serviceId)?.status === "paired";
      },
      markRead: async (todo) => {
        await new Transport(registry, todo.serviceId).request(
          `/v1/notifications/${encodeURIComponent(todo.runId)}/read`,
          { expectedRevision: todo.notificationRevision },
        );
      },
      markAllRead: async (serviceId) => {
        await new Transport(registry, serviceId).request('/v1/notifications/read-all', {});
      },
      onOpen: async (todo) => {
        if (editor.current?.getSnapshot().graph.serviceId === 'browser-local' && editor.current.getSnapshot().drafts.length) await editor.current.flush();
        const current = captureSelection(registry, todo.serviceId, navigation);
        const target = new Transport(registry, todo.serviceId);
        const run = await target.request<Run>("/v1/runs/" + todo.runId);
        current();
        const graph = await target.request<GraphSnapshot>(
          graphPath(run.projectId, run.graphId),
        );
        current();
        navigation.current++;
        setTemporary(false);
        setActiveService(todo.serviceId);
        setProjectId(run.projectId);
        setGraphId(run.graphId);
        setLocateNodeId(run.nodeId);
        setDetailRun(run); setRightPanel('details');
        setFilter(
          graph.trashed ? "trashed" : graph.archived ? "archived" : "active",
        );
        setTab("canvas"); setPage("editor"); location.hash = "editor";
      },
      onError,
    }),
  );
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    let alive = true;
    let knownServices = new Set(registry.list().map(row => row.serviceId));
    const update = () => {
      if (!alive) return;
      const rows = registry.list();
      setConnections(rows);
      setData((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id, d]) =>
            rows.some(
              (c) =>
                c.serviceId === id &&
                c.status !== "invalid" &&
                c.generation === d.generation,
            ),
          ),
        ),
      );
      const current = new Map(rows.map(row => [row.serviceId, row]));
      for (const id of new Set([...knownServices, ...current.keys()])) {
        const row = current.get(id);
        if (!row) notifications.removeService(id);
        else if (row.status === "invalid") notifications.suspendService(id);
        else continue;
        clearServiceCache(id);
      }
      knownServices = new Set(rows.map(row => row.serviceId));
    };
    const unsub = registry.subscribe(update);
    // StrictMode replays effects; do not restore twice and invalidate in-flight readers.
    restored.current ??= registry.restore();
    void restored.current.then(update).catch((e) => {
      if (alive) onError(e);
    }).finally(() => {
      if (alive) setConnectionsRestored(true);
    });
    return () => {
      alive = false;
      navigation.current++;
      unsub();
      disposeTimer.current = setTimeout(() => registry.dispose(), 0);
    };
  }, [registry, notifications, onError]);
  useEffect(
    () => notifications.subscribe(() => setNoticeRevision((n) => n + 1)),
    [notifications],
  );
  const services = connections.filter((c) => c.status !== "invalid");
  const connection =
    services.find((c) => c.serviceId === activeService) ?? services[0];
  const serviceId = connection?.serviceId ?? "";
  useEffect(() => {
    if (servicePage === 'projects' && !serviceId) setServicePage('list');
  }, [servicePage, serviceId]);
  const transport = useMemo(
    () => (serviceId ? new Transport(registry, serviceId) : undefined),
    [registry, serviceId, connection?.generation],
  );
  const request = useMemo<Request>(
    () =>
      async <T,>(path: string, body?: unknown, method?: string, options?: { journal?: "session" | "memory"; range?: { start: number; end: number } }): Promise<T> => {
        if (!transport) throw Error(t('Connect a Workspace first'));
        // These POST endpoints are read-only. Let previews and asset queries
        // recover while the authoritative snapshot is still reconciling.
        const snapshotSafeRead = isSnapshotSafeReadRequest(path, method);
        if (
          (body !== undefined || method === "DELETE") &&
          !snapshotSafeRead &&
          (registry.get(transport.serviceId)?.status !== "paired" ||
            dataRef.current[transport.serviceId]?.eventStatus !== "connected")
        )
          throw Error(t('The Workspace is offline or reconciling its snapshot. Editing, uploading, and running are unavailable.'));
        return transport.request<T>(path, body, method, options);
      },
    [transport, registry, t],
  );
  const current = data[serviceId];
  useEffect(() => {
    if (current?.error) enqueueToast(current.error);
  }, [serviceId, current?.error, enqueueToast]);
  const project =
    current?.projects.find((p) => p.projectId === projectId) ??
    current?.projects[0];
  const localMode = temporary || !connection;
  const libraryTargetProject = libraryProjectId ? project :
    current?.projects.find(p => p.projectId === projectId && p.state === 'active') ?? current?.projects.find(p => p.state === 'active');
  const graphs = localMode ? local.graphs :
    current?.graphs.filter((g) => page === 'library' ? !libraryProjectId || g.projectId === libraryProjectId : g.projectId === project?.projectId) ?? [];
  const visibleGraphs = graphs.filter((g) =>
    filter === "trashed"
      ? Boolean((g as GraphSnapshot & { trashed?: boolean }).trashed)
      : filter === "archived"
        ? g.archived &&
          !Boolean((g as GraphSnapshot & { trashed?: boolean }).trashed)
        : !g.archived &&
          !Boolean((g as GraphSnapshot & { trashed?: boolean }).trashed),
  );
  const selectedGraphId = localMode ? local.selected : graphId;
  const graph = visibleGraphs.find((g) => g.graphId === selectedGraphId) ?? visibleGraphs[0];
  const libraryGroups = groupLibraryGraphs(visibleGraphs, current?.projects ?? []);
  const cardProjectActive = (target: GraphSnapshot) => localMode || current?.projects.some(p => p.projectId === target.projectId && p.state === 'active');
  const deletableGraphs = visibleGraphs.filter(cardProjectActive);
  const selectedLibraryGraphs = deletableGraphs.filter(g => selectedCards.includes(g.graphId));
  const allLibraryGraphsSelected = deletableGraphs.length > 0 && selectedLibraryGraphs.length === deletableGraphs.length;
  enterLibrary.current = () => {
    if (page !== 'editor') return;
    const source = editor.current?.getSnapshot().graph ?? graph;
    if (source) {
      setTemporary(source.serviceId === 'browser-local');
      if (source.serviceId !== 'browser-local') { setActiveService(source.serviceId); setProjectId(source.projectId); }
    }
    setLibraryProjectId('');
  };
  useEffect(() => {
    if (page !== 'editor' || !graph || graph.trashed) return;
    // A loading snapshot can display the first graph before the saved selection resolves.
    if (localMode ? ((!temporary && !!activeService) ||
      (local.selected ? local.selected !== graph.graphId : local.graphs.length !== 1))
      : (activeService !== serviceId || projectId !== graph.projectId || graphId !== graph.graphId)) return;
    const entry: RecentGraph = {
      temporary: localMode,
      serviceId: localMode ? 'browser' : serviceId,
      projectId: graph.projectId,
      graphId: graph.graphId,
      title: graph.title,
      runtimeName: localMode ? t('Temporary browser storage') : connection?.runtimeName || connection?.address || serviceId,
      projectName: localMode ? t('Temporary Work Graph') : project?.name ?? graph.projectId,
    };
    setRecentGraphs(rememberGraph(localStorage, entry));
  }, [page, graph?.graphId, graph?.title, graph?.trashed, localMode, temporary, local.selected, local.graphs.length, activeService, serviceId, projectId, project?.name, graphId, connection?.runtimeName, connection?.address, t]);
  const availableRecentGraphs = recentGraphs.flatMap(item => {
    const source = item.temporary ? local.graphs : data[item.serviceId]?.graphs;
    const found = source?.find(candidate => candidate.projectId === item.projectId && candidate.graphId === item.graphId && !candidate.trashed);
    if (!found || (!item.temporary && !services.some(connection => connection.serviceId === item.serviceId))) return [];
    return [{
      ...item,
      title: found.title,
      runtimeName: item.temporary ? t('Temporary browser storage') : (() => {
        const connection = services.find(connection => connection.serviceId === item.serviceId);
        return connection?.runtimeName || connection?.address || item.runtimeName;
      })(),
      projectName: item.temporary ? t('Temporary Work Graph') : data[item.serviceId]?.projects.find(project => project.projectId === item.projectId)?.name ?? item.projectName,
    }];
  });
  const openRecentGraph = (item: RecentGraph) => {
    const found = (item.temporary ? local.graphs : data[item.serviceId]?.graphs)?.find(candidate => candidate.projectId === item.projectId && candidate.graphId === item.graphId && !candidate.trashed);
    if (!found) { onError(Error(t('This recently opened Work Graph is no longer available. Select it again in My Work Graphs.'))); return; }
    navigate(() => {
      setTemporary(item.temporary);
      if (item.temporary) local.select(item.graphId);
      else { setActiveService(item.serviceId); setProjectId(item.projectId); setGraphId(item.graphId); }
      setFilter(found.archived ? 'archived' : 'active');
      setTab('canvas');
      showPage('editor');
    });
  };
  const selectGraph = (id: string) => {
    if (localMode) local.select(id);
    else {
      setActiveService(serviceId);
      setProjectId(current?.graphs.find(g => g.graphId === id)?.projectId ?? project?.projectId ?? '');
      setGraphId(id);
    }
  };
  const canvasRequest = localMode ? local.store.request : request;
  const canvasChanged = () => { if (localMode) void local.refresh().catch(onError); else changed(); };
  const captureCanvasSelection = () => {
    const epoch = navigation.current;
    return localMode ? () => { if (navigation.current !== epoch) throw new LifecycleCancelledError(); }
      : captureSelection(registry, serviceId, navigation);
  };
  const navigate = (change: () => void) => {
    const epoch = ++navigation.current;
    const state = editor.current?.getSnapshot();
    if (state && state.online && !state.graph.archived && !state.graph.trashed) {
      void editor.current!.flush().then(() => { if (epoch === navigation.current) change(); }).catch(onError);
    } else change();
  };
  const nextSelectionKey = JSON.stringify([
    serviceId,
    connection?.session.id,
    connection?.generation,
    project?.projectId,
    page === "editor" ? graph?.graphId : null,
    tab,
    filter,
    temporary,
    page,
    libraryProjectId,
  ]);
  if (selectionKey.current !== nextSelectionKey) {
    selectionKey.current = nextSelectionKey;
    navigation.current++;
  }
  useEffect(() => { setSelectedCards([]); setCardRename(undefined); setCardPurge(undefined); setCardPurgeTitle(''); setCreating(false); }, [serviceId, connection?.generation, libraryProjectId, temporary, filter]);
  useEffect(() => { setLibraryProjectId(''); }, [serviceId, temporary]);
  const online =
    connection?.status === "paired" && current?.eventStatus === "connected";
  const statusConnection = connection ?? connections.find(c => c.serviceId === activeService);
  const activeRuntimeStatus = runtimeStatus(statusConnection, current?.eventStatus, current?.error, webClientPackage.version);
  const runtimeDisconnected =
    !localMode &&
    (connection?.status === "offline" || current?.eventStatus === "offline");
  const copyConnection = services.find(c => c.serviceId === copyServiceId) ?? connection;
  const copyProjects = data[copyConnection?.serviceId ?? '']?.projects.filter(p => p.state === 'active') ?? [];
  const copyProject = copyProjects.find(p => p.projectId === copyProjectId) ?? copyProjects[0];
  const canCopy = copyConnection?.status === 'paired' && data[copyConnection.serviceId]?.eventStatus === 'connected' && !!copyProject;
  const [capacity, setCapacity] = useState<{ request: Request; occupied: number; capacity: number }>();
  useEffect(() => {
    let live = true;
    if (!online || !connection) return;
    request<{ occupied: number; capacity: number }>("/v1/capacity").then(value => { if (live) setCapacity({ request, ...value }); }).catch(onError);
    return () => { live = false; };
  }, [request, online, current?.revision]);
  const bridgeScope = JSON.stringify([serviceId, connection?.generation, project?.projectId, graph?.graphId, online, navigation.current]);
  const bridgeContext = useRef(bridgeScope); bridgeContext.current = bridgeScope;
  const localBridge = useMemo(() => {
    if (!localMode || !graph) return undefined;
    const binding = online && connection && project?.state === "active" ? {
      serviceId, projectId: project.projectId, sessionId: connection.session.id, request,
      isCurrent: () => bridgeContext.current === bridgeScope && registry.get(serviceId)?.generation === connection.generation && registry.get(serviceId)?.status === "paired",
    } : undefined;
    return local.bridgeFor(graph.graphId, binding);
  }, [localMode, graph?.graphId, bridgeScope, request, local.bridgeFor]);
  const assetsAvailable = localMode ? !!localBridge?.capabilities.assets : !!connection;
  const projectFilesAvailable = !localMode && connection?.info.capabilities.projectFiles?.status === 'available' && connection.info.capabilities.projectFileReferences?.status === 'available';
  const canvasOnline = localMode || !!online;
  const canvasProjectActive = localMode || (page === 'library' ? libraryTargetProject : project)?.state === "active";
  useEffect(() => {
    setDeleteName("");
    setPendingDelete(false);
    setActionDialog(undefined);
  }, [serviceId, connection?.generation, project?.projectId, graph?.graphId]);
  const acceptData = useCallback(
    (id: string, value: ServiceData) => {
      const row = registry.get(id);
      if (
        !row ||
        row.status === "invalid" ||
        row.generation !== value.generation
      )
        return;
      setData((current) => ({ ...current, [id]: value }));
      if (value.revision > 0 && !value.error)
        notifications.ingest({ serviceId: id, name: row.address }, value.notifications);
    },
    [registry, notifications],
  );
  const act = (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void fn()
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const updateRuntime = async (target: Connection) => {
    if (updatingRuntime || target.status !== 'paired') return;
    setUpdatingRuntime({ serviceId: target.serviceId, version: target.info.version });
    try {
      await new Transport(registry, target.serviceId).request('/v1/runtime/update', undefined, 'POST');
    } catch (error) {
      setUpdatingRuntime(current => current?.serviceId === target.serviceId ? undefined : current);
      onError(error);
    }
  };
  useEffect(() => {
    if (!updatingRuntime) return;
    let cancelled = false;
    let polling = false;
    const started = Date.now();
    const poll = async () => {
      if (polling) return;
      polling = true;
      const row = registry.get(updatingRuntime.serviceId);
      if (!row || cancelled) {
        if (!cancelled) setUpdatingRuntime(current => current?.serviceId === updatingRuntime.serviceId ? undefined : current);
        polling = false;
        return;
      }
      try {
        const info = await registry.discover(row.address, row.serviceId);
        if (!cancelled && runtimeNeedsUpgrade(updatingRuntime.version, info.version)) {
          const restored = await registry.restore([row.serviceId]);
          if (restored.some(connection => connection.serviceId === row.serviceId && connection.status === 'paired' && runtimeNeedsUpgrade(updatingRuntime.version, connection.info.version))) {
            if (!cancelled) setUpdatingRuntime(undefined);
            return;
          }
        }
      } catch { /* The Runtime disconnects while npm replaces it. */ }
      if (!cancelled && Date.now() - started > 120_000) {
        setUpdatingRuntime(undefined);
        onError(new Error(t('Workspace update did not complete. Check the Workspace device and reconnect.')));
      }
      polling = false;
    };
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [updatingRuntime, registry, onError, t]);
  const place = (asset: LibraryAsset, dropPosition?: Point): ResourcePlacement => {
    if (!editor.current || !graph) throw Error(t('Select and open the target Work Graph first'));
    if (!canvas.current) throw Error(t('Cannot determine where to place the node. Open the target Work Graph first.'));
    const placementEditor = editor.current;
    const target = placementEditor.getSnapshot().graph;
    if (target.serviceId !== graph.serviceId || target.projectId !== graph.projectId || target.graphId !== graph.graphId) throw new LifecycleCancelledError();
    const size = { width: 300, height: 220 };
    const position = dropPosition ? { x: dropPosition.x - size.width / 2, y: dropPosition.y - size.height / 2 } : canvas.current.getPlacementPosition(size);
    const nodeId = randomId();
    const nodeType = importedNodeType(asset.name, asset.current.mime);
    const initialContent = {
      title: asset.name,
      text: '',
      prompt: '',
      mime: asset.current.mime,
      resourceImport: { state: 'loading' },
      ...(nodeType === 'file' ? { bytes: asset.current.bytes } : {}),
    };
    const create = placementEditor.prepareCommand([{ type: 'node.create', node: {
      id: nodeId,
      type: nodeType,
      schemaVersion: 1,
      contentVersion: 1,
      content: initialContent,
      ...size,
      ...position,
      readOnly: false,
    } }]);
    const createdNode = create();
    let completed = false;
    const update = async (content: Json) => {
      await createdNode;
      if (editor.current !== placementEditor) throw new LifecycleCancelledError();
      const current = placementEditor.getSnapshot().graph.nodes.find(node => node.id === nodeId);
      if (!current) throw new LifecycleCancelledError();
      await placementEditor.prepareCommand([{ type: 'node.content', nodeId, expectedContentVersion: current.contentVersion, content }])();
      canvasChanged();
    };
    return {
      complete: async created => {
        if (completed) return;
        const resource = created.resource;
        const importedText = nodeType === 'text' ? await canvasRequest<{state:string;text:string|null}>(graphPath(graph.projectId,graph.graphId) + '/resources/' + encodeURIComponent(resource.id) + '/versions/' + resource.current.version + '/representation') : null;
        if (nodeType === 'text' && (importedText?.state !== 'ready' || importedText.text === null || new TextEncoder().encode(importedText.text).length > 8 * 1024 * 1024)) throw Error(t('The text resource cannot be imported as a text node (maximum 8 MiB).'));
        if (nodeType === 'file' && resource.current.bytes > FILE_NODE_MAX_BYTES) throw Error(t('File nodes support up to 300 MB.'));
        await update({ title: resource.name, text: importedText?.text ?? '', prompt: '', resourceId: resource.id, resourceVersion: resource.current.version, mime: resource.current.mime, ...(nodeType === 'file' ? { bytes: resource.current.bytes } : {}) });
        completed = true;
      },
      fail: async error => {
        if (completed) return;
        void error;
        await update({ ...initialContent, resourceImport: { state: 'failed' } });
      },
    };
  };
  const placeProjectFile = async (path: string, dropPosition?: Point) => {
    if (!editor.current || !graph || !canvas.current || localMode) throw Error(t('Connect a Workspace and open the target Work Graph first.'));
    const placementEditor = editor.current;
    const target = placementEditor.getSnapshot().graph;
    if (target.serviceId !== graph.serviceId || target.projectId !== graph.projectId || target.graphId !== graph.graphId) throw new LifecycleCancelledError();
    const scope = JSON.stringify([target.serviceId, target.projectId, target.graphId, path]);
    let job = projectFilePlacements.current.get(scope);
    if (job && job.editor !== placementEditor) { projectFilePlacements.current.delete(scope); job = undefined; }
    if (!job) {
      const size = { width: 300, height: 220 };
      const position = dropPosition ? { x: dropPosition.x - size.width / 2, y: dropPosition.y - size.height / 2 } : canvas.current.getPlacementPosition(size);
      const name = path.split('/').at(-1) || t('Project file');
      const mime = fileMime({ name, type: '' });
      const nodeId = randomId();
      const created = placementEditor.prepareCommand([{ type: 'node.create', node: {
        id: nodeId,
        type: importedNodeType(name, mime),
        schemaVersion: 1,
        contentVersion: 1,
        content: { title: name, text: '', prompt: '', mime, source: { kind: 'project-file-empty', relativePath: path }, projectFileImport: { state: 'loading' } },
        ...size,
        ...position,
        readOnly: false,
      } }])();
      job = { editor: placementEditor, nodeId, created, uncertain: false };
      projectFilePlacements.current.set(scope, job);
    }
    await job.created;
    if (editor.current !== placementEditor) throw new LifecycleCancelledError();
    const contentObject = (value: Json): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {};
    const linked = () => {
      const node = placementEditor.getSnapshot().graph.nodes.find(item => item.id === job!.nodeId);
      const source = contentObject(contentObject(node?.content ?? null).source);
      return source.kind === 'project-file';
    };
    if (job.uncertain) {
      await placementEditor.refresh();
      if (linked()) { projectFilePlacements.current.delete(scope); canvasChanged(); return; }
      job.association = undefined;
      job.uncertain = false;
    }
    let current = placementEditor.getSnapshot().graph;
    let node = current.nodes.find(item => item.id === job!.nodeId);
    if (!node) throw new LifecycleCancelledError();
    const currentContent = contentObject(node.content);
    const importState = contentObject(currentContent.projectFileImport);
    if (importState.state === 'failed') {
      await placementEditor.prepareCommand([{ type: 'node.content', nodeId: node.id, expectedContentVersion: node.contentVersion, content: { ...currentContent, projectFileImport: { state: 'loading' } } }])();
      current = placementEditor.getSnapshot().graph;
      node = current.nodes.find(item => item.id === job!.nodeId);
      if (!node) throw new LifecycleCancelledError();
    }
    job.association ??= (() => {
      const expected = placementEditor.getSnapshot().graph;
      const expectedNode = expected.nodes.find(item => item.id === job!.nodeId);
      if (!expectedNode) throw new LifecycleCancelledError();
      const body = { path, nodeId: expectedNode.id, expectedContentVersion: expectedNode.contentVersion, expectedExecutionRevision: expected.executionRevision, expectedLayoutRevision: expected.layoutRevision, idempotencyKey: randomId() };
      let result: GraphSnapshot | undefined;
      return async () => {
        result ??= await request<GraphSnapshot>(graphPath(expected.projectId, expected.graphId) + '/project-files/associate', body);
        placementEditor.acceptCommitted(result);
        return result;
      };
    })();
    try {
      await job.association();
      projectFilePlacements.current.delete(scope);
      canvasChanged();
    } catch (error) {
      job.uncertain = true;
      try {
        await placementEditor.refresh();
        if (linked()) { projectFilePlacements.current.delete(scope); canvasChanged(); return; }
        const failedGraph = placementEditor.getSnapshot().graph;
        const failedNode = failedGraph.nodes.find(item => item.id === job!.nodeId);
        if (failedNode) {
          const failedContent = contentObject(failedNode.content);
          await placementEditor.prepareCommand([{ type: 'node.content', nodeId: failedNode.id, expectedContentVersion: failedNode.contentVersion, content: { ...failedContent, projectFileImport: { state: 'failed' } } }])();
          job.association = undefined;
          job.uncertain = false;
          canvasChanged();
        }
      } catch { /* Keep the loading placeholder and exact association request for retry. */ }
      throw error;
    }
  };
  const lifecycle = async (action: string) => {
    if (!graph) throw Error(t('Select a Work Graph first'));
    const currentSelection = captureCanvasSelection();
    if (action === 'trash' && editor.current?.getSnapshot().drafts.length) await editor.current.flush();
    currentSelection();
    const target = editor.current?.getSnapshot().graph ?? graph;
    await canvasRequest(
      graphPath(graph.projectId, graph.graphId) +
        (action === "purge" ? "/permanent-delete" : "/commands"),
      {
        idempotencyKey: randomId(),
        expectedExecutionRevision: target.executionRevision,
        expectedLayoutRevision: target.layoutRevision,
        ...(action === "purge"
          ? { confirmTitle: deleteName }
          : {
              operations: [
                { type: "graph.trash", trashed: action === "trash" },
              ],
            }),
      },
    );
    currentSelection();
    setPendingDelete(false);
    selectGraph("");
    showPage("library");
    canvasChanged();
  };
  const copyToWorkspace = async () => {
    if (!graph || !copyConnection || !copyProject || !canCopy) throw Error(t('Select an active project workspace on a connected Workspace'));
    const currentSelection = captureCanvasSelection();
    const targetSelection = captureSelection(registry, copyConnection.serviceId, navigation);
    const scope = JSON.stringify([graph.serviceId, graph.projectId, graph.graphId, copyConnection.serviceId, copyProject.projectId]);
    if (copyAttempt.current?.scope === scope && copyAttempt.current.sessionId !== copyConnection.session.id)
      throw Error(t('The target Workspace session changed. Check the copy result in the target project workspace before trying again. The import cannot be repeated automatically.'));
    if (copyAttempt.current?.scope !== scope) {
      if (editor.current?.getSnapshot().drafts.length) await editor.current.flush();
      currentSelection(); targetSelection();
      const bundle = await canvasRequest<GraphBundle>(graphPath(graph.projectId, graph.graphId) + '/export');
      currentSelection(); targetSelection();
      copyAttempt.current = { scope, sessionId: copyConnection.session.id, bundle, idempotencyKey: randomId() };
      setCopyPending(true);
    }
    const attempt = copyAttempt.current;
    const created = await new Transport(registry, copyConnection.serviceId).request<GraphSnapshot>(
      `/v1/projects/${copyProject.projectId}/graphs/import`, { bundle: attempt.bundle, idempotencyKey: attempt.idempotencyKey },
      undefined, { journal: 'memory' },
    );
    currentSelection(); targetSelection();
    copyAttempt.current = undefined; setCopyPending(false); setActionDialog(undefined);
    setActiveService(copyConnection.serviceId); setProjectId(copyProject.projectId); setGraphId(created.graphId);
    setTemporary(false); setFilter('active'); setTab('canvas'); changed();
  };
  const closeActionDialog = () => {
    setActionDialog(undefined);
    document.querySelector<HTMLButtonElement>('.topbar-left [aria-label="' + t('Work Graph main menu') + '"]')?.focus();
  };
  const exportGraph = async (target: GraphSnapshot) => {
    const guard = captureCanvasSelection();
    if (editor.current?.getSnapshot().graph.graphId === target.graphId && editor.current.getSnapshot().drafts.length) await editor.current.flush();
    guard();
    const bundle = localMode ? await local.store.exportGraph(target.graphId, async source => {
      guard();
      if (!online || !connection || !project || source.serviceId !== serviceId || source.projectId !== project.projectId) throw Error(t('Exporting referenced nodes requires a connection to their source Workspace and project.'));
      const [status] = await request<Array<{ state:'available'|'missing'|'unavailable'; name:string; mime:string|null; bytes:number|null; changeToken:string|null }>>(
        '/v1/projects/' + encodeURIComponent(source.projectId) + '/files/stat', { paths:[source.relativePath] },
      );
      guard();
      if (!status || status.state !== 'available') throw Error(status?.state === 'missing' ? t('The referenced file no longer exists. Work Graph export failed.') : t('The referenced file is currently unavailable. Work Graph export failed.'));
      if (status.bytes === null || !Number.isSafeInteger(status.bytes) || status.bytes < 0) throw Error(t('The referenced file size could not be verified. Work Graph export failed.'));
      if (status.bytes > FILE_NODE_MAX_BYTES) throw Error(t('The referenced file exceeds 300 MB. Work Graph export failed.'));
      const name = status.name || source.relativePath.split('/').at(-1) || t('Project file');
      return {
        name,
        mime:status.mime ?? fileMime({ name, type:'' }),
        size:status.bytes,
        read:async () => {
          guard();
          const query = new URLSearchParams({ path:source.relativePath, ...(status.changeToken ? { cacheKey:status.changeToken } : {}) });
          if (status.bytes! > 50 * 1024 * 1024) {
            const bytes = new Uint8Array(status.bytes!);
            for (let start = 0; start < bytes.length; start += 4 * 1024 * 1024) {
              guard();
              const end = Math.min(start + 4 * 1024 * 1024, bytes.length) - 1;
              const part = await request<import('../adapter/transport').RangeBlob>('/v1/projects/' + encodeURIComponent(source.projectId) + '/files/content?' + query, undefined, 'RANGE', {range:{start,end}});
              guard();
              if (part.start !== start || part.end !== end || part.total !== bytes.length || part.blob.size !== end - start + 1) throw Error(t('The referenced file changed during export. Try again.'));
              bytes.set(new Uint8Array(await part.blob.arrayBuffer()), start);
            }
            const [after] = await request<Array<{state:string;bytes:number|null;changeToken:string|null}>>('/v1/projects/' + encodeURIComponent(source.projectId) + '/files/stat', {paths:[source.relativePath]});
            guard();
            if (after?.state !== 'available' || after.bytes !== status.bytes || after.changeToken !== status.changeToken) throw Error(t('The referenced file changed during export. Try again.'));
            return bytes;
          }
          const content = await request<{ path:string; bytes:number; base64:string }>('/v1/projects/' + encodeURIComponent(source.projectId) + '/files/content?' + query);
          guard();
          const bytes = Uint8Array.from(atob(content.base64), character => character.charCodeAt(0));
          if (content.bytes !== bytes.length || bytes.length !== status.bytes) throw Error(t('The referenced file changed during export. Try again.'));
          return bytes;
        },
      };
    }) : await canvasRequest<GraphBundle>(graphPath(target.projectId, target.graphId) + '/export');
    guard();
    const url = URL.createObjectURL(await createWorkGraphArchive(bundle));
    const link = document.createElement('a'); link.href = url; link.download = workGraphArchiveFilename(target.title); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const updateCard = async (target: GraphSnapshot, operations: import('./contracts').GraphOperation[]) => {
    const guard = captureCanvasSelection();
    await canvasRequest(graphPath(target.projectId, target.graphId) + '/commands', { idempotencyKey: randomId(), expectedExecutionRevision: target.executionRevision, expectedLayoutRevision: target.layoutRevision, operations });
    // Refresh committed data even if navigation changed while the write completed.
    canvasChanged(); guard();
  };
  const purgeCard = async (target: GraphSnapshot, confirmTitle: string) => {
    const guard = captureCanvasSelection();
    await canvasRequest(graphPath(target.projectId, target.graphId) + '/permanent-delete', {
      idempotencyKey: randomId(),
      expectedExecutionRevision: target.executionRevision,
      expectedLayoutRevision: target.layoutRevision,
      confirmTitle,
    });
    canvasChanged(); guard();
    setSelectedCards(ids => ids.filter(id => id !== target.graphId));
    if ((localMode && local.selected === target.graphId) || (!localMode && graphId === target.graphId)) selectGraph('');
    setCardPurge(undefined);
    setCardPurgeTitle('');
  };
  void noticeRevision;
  const desktopNotificationsEnabled = notifications.isDesktopEnabled();
  const todos = notifications
    .list()
    .filter((t) => services.some((c) => c.serviceId === t.serviceId));
  return (
    <main className={"app real-app " + (leftOpen ? "" : "sidebar-closed")}>
      {confirmTrashGraphs && <ConfirmationDialog title={t('Confirm move to trash')}
        text={t('Move {count} Work Graphs to the trash?', { count: confirmTrashGraphs.length })} disabled={busy || !canvasOnline}
        onCancel={() => setConfirmTrashGraphs(undefined)} onConfirm={() => {
          const targets = confirmTrashGraphs; setConfirmTrashGraphs(undefined);
          act(async () => {
            const guard = captureCanvasSelection();
            for (const target of targets) { guard(); await updateCard(target, [{ type: 'graph.trash', trashed: true }]); }
            setSelectedCards([]);
          });
        }}/>}
      {connectionsRestored && (services.length === 0 || welcomePairing) && local.graphs.length > 0 && <WelcomeDialog
        registry={registry} theme={theme} onPairingStart={() => setWelcomePairing(true)} onClose={() => setWelcomePairing(false)}
        onModelsChanged={() => setModelRevision(value => value + 1)}
        onComplete={(id, workspaceId, createdGraphId) => {
          setWelcomePairing(false);
          navigate(() => {
            setActiveService(id); setProjectId(workspaceId); setGraphId(createdGraphId ?? '');
            setTemporary(false); setFilter('active'); setTab('canvas');
            showPage(createdGraphId ? 'editor' : 'library'); changed();
          });
        }}
      />}
      {services.map((c) => (
        <ServiceMonitor
          key={c.serviceId + ":" + c.generation}
          registry={registry}
          connection={c}
          refresh={refresh}
          onData={acceptData}
        />
      ))}
      {runtimeRename && <div className="library-dialog-backdrop"><form className="library-dialog panel" role="dialog" aria-modal="true" aria-label={t('Rename Workspace')}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRuntimeRename(undefined); } }}
        onSubmit={event => {
          event.preventDefault();
          try {
            registry.renameRuntime(runtimeRename.serviceId, runtimeRename.name, runtimeRename.sessionId);
            setRuntimeRename(undefined);
          } catch (error) { onError(error); }
        }}>
        <h2>{t('Rename Workspace')}</h2>
        <label>{t('Workspace name')}<input autoFocus required maxLength={RUNTIME_NAME_MAX_LENGTH} value={runtimeRename.name} onFocus={event => event.target.select()} onChange={event => setRuntimeRename({ ...runtimeRename, name: event.target.value })}/></label>
        <button disabled={!runtimeRename.name.trim()}>{t('Confirm rename')}</button>
        <button type="button" onClick={() => setRuntimeRename(undefined)}>{t('Cancel')}</button>
      </form></div>}
      {cardRename && <div className="library-dialog-backdrop"><form className="library-dialog panel" role="dialog" aria-modal="true" aria-label={t('Rename Work Graph')} onSubmit={e => { e.preventDefault(); act(async () => { await updateCard(cardRename, [{ type: 'graph.rename', title: cardTitle.trim() }]); setCardRename(undefined); }); }}><label>{t('New Work Graph name')}<input autoFocus required value={cardTitle} onChange={e => setCardTitle(e.target.value)}/></label><button disabled={busy || !cardTitle.trim()}>{t('Confirm rename')}</button><button type="button" onClick={() => setCardRename(undefined)}>{t('Cancel')}</button></form></div>}
      {cardPurge && <div className="library-dialog-backdrop"><form className="library-dialog panel" role="dialog" aria-modal="true" aria-label={t('Permanently delete Work Graph')} onSubmit={e => { e.preventDefault(); act(() => purgeCard(cardPurge, cardPurgeTitle)); }}>
        <h2>{t('Permanently delete Work Graph')}</h2>
        <p>{t('Permanently delete “{title}”, its run history, and snapshots. This cannot be undone.', { title: cardPurge.title })}</p>
        <label>{t('Enter the Work Graph name to confirm')}<input autoFocus value={cardPurgeTitle} onChange={e => setCardPurgeTitle(e.target.value)}/></label>
        <div className="graph-confirm-actions"><button disabled={busy || cardPurgeTitle !== cardPurge.title}>{t('Confirm permanent deletion')}</button><button type="button" onClick={() => { setCardPurge(undefined); setCardPurgeTitle(''); }}>{t('Cancel')}</button></div>
      </form></div>}
      <input ref={importInput} aria-label={t('Import Work Graph file')} type="file" accept=".zip,application/zip,application/vnd.openworkgraph.graph+zip" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) act(async () => {
          const guard = captureCanvasSelection();
          const bundle = await readWorkGraphFile(file); guard();
          const created = localMode ? await local.store.importGraph(bundle) : await request<GraphSnapshot>('/v1/projects/' + libraryTargetProject!.projectId + '/graphs/import', { bundle, idempotencyKey: randomId() }, undefined, { journal:'memory' });
          guard(); selectGraph(created.graphId); if (!localMode) setProjectId(created.projectId); setFilter('active'); canvasChanged();
        });
      }}/>
      <header className="real-header topbar-right">
        <div className="runtime-header-actions">
          <button className="icon-button panel desktop-notification-button" aria-label={desktopNotificationsEnabled ? t('Disable desktop notifications') : t('Enable desktop notifications')} title={desktopNotificationsEnabled ? t('Disable desktop notifications') : t('Enable desktop notifications')} aria-pressed={desktopNotificationsEnabled}
            onClick={() => {
              if (desktopNotificationsEnabled) {
                notifications.disableDesktop();
                enqueueToast(t('Desktop notifications disabled'), 'status');
                return;
              }
              void notifications
                .enableDesktop()
                .then((p) => {
                  enqueueToast(
                    p === "granted"
                      ? t('Desktop notifications enabled')
                      : p === "unsupported"
                        ? t('This browser does not support desktop notifications. In-page notifications remain available.')
                        : t('Desktop notifications were not authorized. In-page notifications remain available.'),
                    'status',
                  );
                })
                .catch(onError);
            }}
          >
            <Bell size={18}/>
            {desktopNotificationsEnabled && <span className="desktop-notification-check" aria-hidden="true"><Check size={10} strokeWidth={3}/></span>}
          </button>
          {page === 'editor' && <a
            className="icon-button panel github-repository-link"
            href="https://github.com/giarld/OpenWorkgraph"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('Open GitHub repository (opens in a new tab)')}
            title={t('Open GitHub repository (opens in a new tab)')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.467-1.332-5.467-5.93 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.523.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.653.243 2.873.12 3.176.77.84 1.235 1.911 1.235 3.221 0 4.61-2.807 5.625-5.479 5.922.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          </a>}
          <LanguageSwitcher />
          <button className="icon-button panel" aria-label={t('Toggle theme')} title={t('Toggle theme')} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={18}/> : <Moon size={18}/>}</button>
        </div>
        <div className="runtime-queue-dock">
          <button type="button" className="runtime-current-status panel" aria-label={t('Workspace management')} aria-expanded={servicePanelOpen} aria-controls="service-panel" aria-describedby="runtime-status-tooltip" data-state={activeRuntimeStatus.state} onClick={() => setServicePanelOpen(v => !v)}>
            <span className="runtime-status-light" aria-hidden="true" />
            <span className="runtime-status-name">{activeRuntimeStatus.name}</span>
            <span id="runtime-status-tooltip" className="runtime-status-tooltip panel" role="tooltip">{activeRuntimeStatus.details}</span>
          </button>
          <button
            className="queue-trigger panel"
            aria-label={t('Workspace queue')}
            disabled={!connection}
            aria-pressed={rightPanel === 'queue'}
            onClick={() => setRightPanel(current => current === 'queue' ? null : 'queue')}
          >
            {t('Workspace queue')}{capacity?.request === request ? " · " + capacity.occupied + "/" + capacity.capacity : ""}
          </button>
        </div>
      </header>
      <div ref={setToastViewport} className="workgraph-toast-viewport real-toast-queue" aria-label={t('Action notifications')}/>
      <ToastQueue
        target={toastViewport}
        items={[
          ...toastItems,
          ...(transport?.pending() ?? []).map(p => ({
            id: `pending-${p.id}`,
            role: 'alert' as const,
            duration: null,
            className: 'real-pending-request-toast',
            content: <><strong>{t('Request with unknown result')}</strong><span>{p.persistence === 'memory' ? t('The original request is stored only in this tab. Do not close the page or repeat the import; reconnect to reconcile it here.') : t('Do not create another operation. Reconnect and use the original request to reconcile it; runs are not resubmitted automatically.')}</span><code>{p.path}</code><button disabled={!online || busy} onClick={() => act(async () => { await transport!.retry(p.id); changed(); })}>{t('Reconcile with the original key and body')}</button></>,
          })),
        ]}
        onDismiss={dismissToast}
      />
      <div className="real-layout">
        <aside className={'real-sidebar left-sidebar' + (leftOpen && page === 'editor' ? '' : ' left-sidebar-collapsed')} aria-label={t('Work Graph sidebar')} aria-hidden={!leftOpen || page !== 'editor'} inert={!leftOpen || page !== 'editor'} style={{ width: leftOpen && page === 'editor' ? leftSidebarWidth ?? undefined : 0 }}>
          <div className="sidebar-tabs">
            <button className={tab === "canvas" ? "active" : ""} onClick={() => setTab("canvas")}>{t('Work Graph')}</button>
            <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>{t('Project files')}</button>
            <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>{t('Asset library')}</button>
            <button className="icon-button sidebar-collapse" aria-label={t('Collapse sidebar')} onClick={() => setLeftOpen(false)}><PanelLeftClose size={18}/></button>
          </div>
          <div className="sidebar-brand">
            <img
              src={theme === 'dark' ? '/brand/openworkgraph-wordmark-light.svg' : '/brand/openworkgraph-wordmark-dark.svg'}
              alt=""
              aria-hidden="true"
            />
            <span className="brand-version-badge sidebar-version-badge" title={`OpenWorkgraph v${webClientPackage.version}`}>v{webClientPackage.version}</span>
            <h1 className="visually-hidden">OpenWorkgraph</h1>
          </div>
          <div ref={setNodeSidebar} className={tab !== "canvas" ? "real-hidden" : "real-node-sidebar"}/>
          {tab === 'files' && <ProjectFilesPanel key={serviceId + ':' + (project?.projectId ?? '')} request={request} projectId={project?.projectId} ready={!!online && projectFilesAvailable} onPlace={(path, position) => { void placeProjectFile(path, position).catch(onError); }}/>}
                    {tab === "assets" && assetsAvailable &&
            (graph ? (
              <ResourcesPanel
                ready={!!online}
                refreshToken={assetsRevision}
                key={
                  serviceId + ":" + connection?.generation + ":" + graph.graphId
                }
                request={localMode ? localBridge!.request : request}
                projectId={graph.projectId}
                ownerProjectId={localMode ? project?.projectId : graph.projectId}
                projects={localMode ? (project ? [project] : []) : current?.projects}
                graphId={graph.graphId}
                readOnly={
                  !online ||
                  project?.state !== "active" ||
                  graph.archived ||
                  Boolean(
                    (graph as GraphSnapshot & { trashed?: boolean }).trashed,
                  )
                }
                onPlace={place}
                onError={onError}
              />
            ) : (
              <p>{t('Select a target Work Graph to view the asset library.')}</p>
            ))}
{tab === 'assets' && !assetsAvailable && <p className="muted">{t('Connect a Workspace and select an active project to browse the asset library. Drag local files into the Work Graph or import them from the Add node menu.')}</p>}
        </aside>
        {leftOpen && page === 'editor' && <div
          className="left-sidebar-resizer"
          role="separator"
          aria-label={t('Resize left sidebar')}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={sidebarWidthLimit()}
          aria-valuenow={Math.min(sidebarWidthLimit(), leftSidebarWidth ?? (window.innerWidth <= 1000 ? 220 : 280))}
          tabIndex={0}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            const startWidth = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? 280;
            sidebarResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add('resizing-left-sidebar');
          }}
          onPointerMove={event => {
            const resize = sidebarResize.current;
            if (resize?.pointerId === event.pointerId) resizeSidebar(resize.startWidth + event.clientX - resize.startX);
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            const width = sidebarResize.current?.width;
            sidebarResize.current = null;
            document.body.classList.remove('resizing-left-sidebar');
            if (width !== undefined) try { localStorage.setItem('openworkgraph:left-sidebar-width', String(width)); } catch { /* Resizing still works without storage. */ }
          }}
          onKeyDown={event => {
            const width = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? 280;
            const next = event.key === 'ArrowLeft' ? width - 20 : event.key === 'ArrowRight' ? width + 20 : event.key === 'Home' ? 220 : event.key === 'End' ? sidebarWidthLimit() : null;
            if (next === null) return;
            event.preventDefault();
            resizeSidebar(next);
            try { localStorage.setItem('openworkgraph:left-sidebar-width', String(Math.max(220, Math.min(sidebarWidthLimit(), next)))); } catch { /* Resizing still works without storage. */ }
          }}
        />}
        <section className={"real-main workspace " + (page === "library" ? "library-active" : "")}>
          {page === 'library' && <section className="workgraph-library" aria-label={t('Work Graph list')}>
            <header><div><div className="library-brand"><img className="library-brand-logo" src={theme === 'dark' ? '/brand/openworkgraph-wordmark-light.svg' : '/brand/openworkgraph-wordmark-dark.svg'} alt="" aria-hidden="true"/><span className="brand-version-badge" title={`OpenWorkgraph v${webClientPackage.version}`}>v{webClientPackage.version}</span></div><h1>{t('Work Graph')}</h1></div><div className="library-actions">
              <button disabled={busy || runtimeDisconnected || !deletableGraphs.length} onClick={() => setSelectedCards(allLibraryGraphsSelected ? [] : deletableGraphs.map(g => g.graphId))}>
                {allLibraryGraphsSelected ? t('Deselect all') : t('Select all')}
              </button>
              {filter !== 'trashed' && selectedLibraryGraphs.length > 0 && <button disabled={busy || !canvasOnline} onClick={() => {
                setConfirmTrashGraphs(selectedLibraryGraphs);
              }}>{t('Delete selected ({count})', { count: selectedLibraryGraphs.length })}</button>}
              <button disabled={busy || !canvasOnline || !canvasProjectActive} title={localMode ? undefined : libraryTargetProject?.name} onClick={() => importInput.current?.click()}><Upload size={16}/>{t('Import Work Graph')}</button>
              <button disabled={busy || !canvasOnline || !canvasProjectActive} className="library-primary" onClick={() => setCreating(true)}><Plus size={16}/>{t('New Work Graph')}</button>
            </div></header>
          <div className="library-filters">
          <label>{t('Workspace')}<select aria-label={t('Select Workspace')} value={localMode ? 'browser' : serviceId} onChange={event => {
            const value = event.target.value;
            navigate(() => { setTemporary(value === 'browser'); if (value !== 'browser') setActiveService(value); setLibraryProjectId(''); setProjectId(''); setGraphId(''); setFilter('active'); });
          }}><option value="browser">{t('Temporary browser storage')}</option>{services.map(c => <option key={c.serviceId} value={c.serviceId}>{c.runtimeName ? `${c.runtimeName} (${c.address})` : c.address}</option>)}</select></label>
          {!localMode && connection && <>
              <label>
                {t('Projects on Workspace')}
                <select
                  value={libraryProjectId}
                  onChange={(e) => {
                    navigation.current++;
                    setLibraryProjectId(e.target.value);
                    setProjectId(e.target.value);
                    setGraphId("");
                  }}
                >
                  <option value="">
                    {t('All projects')}
                  </option>
                  {current?.projects.map((p) => (
                    <option key={p.projectId} value={p.projectId}>
                      {p.name} ·{" "}
                      {p.state === "active" ? t('Enabled') : t('Inactive (read-only)')}
                    </option>
                  ))}
                </select>
              </label>
              {!current ? (
                <p>{t('Loading Workspace data…')}</p>
              ) : current.error ? (
                <p role="status">{t('The Workspace is temporarily unavailable. Showing the most recent cached data.')}</p>
              ) : null}
          </>}
              <label>
                {t('List scope')}
                <select
                  value={filter}
                  onChange={(e) => {
                    const value = e.target.value as typeof filter;
                    navigate(() => { setFilter(value); selectGraph(""); });
                  }}
                >
                  <option value="active">{t('Active')}</option>
                  <option value="archived">{t('Archived')}</option>
                  <option value="trashed">{t('Trash')}</option>
                </select>
              </label>
</div>
              {!runtimeDisconnected && <div className="library-groups">{libraryGroups.map(group => <section className="library-project-group" key={group.projectId} aria-label={localMode ? t('Temporary browser storage') : group.name}>
                <h2>{localMode ? t('Temporary browser storage') : group.name}<span>{group.graphs.length}</span></h2>
                <div className="library-grid">{group.graphs.map(g => <article className="library-card" key={g.graphId}>
                <input className="library-card-check" type="checkbox" disabled={!cardProjectActive(g)} aria-label={t('Select {title}', { title: g.title })} checked={selectedCards.includes(g.graphId)} onChange={e => setSelectedCards(ids => e.target.checked ? [...ids, g.graphId] : ids.filter(id => id !== g.graphId))}/>
                <button className="library-card-open" aria-label={g.title} onClick={() => navigate(() => { selectGraph(g.graphId); setTab('canvas'); showPage('editor'); })}><strong>{g.title}</strong><span>{t('{nodes} nodes · {edges} edges', { nodes: g.nodes.length, edges: g.edges.length })}</span></button>
                <footer><span>{localMode ? t('Temporary browser storage') : group.name}</span><div>
                  <button aria-label={t('Export {title}', { title: g.title })} disabled={busy} className="icon-button" title={t('Export')} onClick={() => act(() => exportGraph(g))}><Download size={16}/></button>
                  <button aria-label={t('Rename {title}', { title: g.title })} disabled={!canvasOnline || !cardProjectActive(g) || g.archived || g.trashed || busy} className="icon-button" title={t('Rename')} onClick={() => { setCardRename(g); setCardTitle(g.title); }}><Pencil size={16}/></button>
                  <button aria-label={g.trashed ? t('Restore {title}', { title: g.title }) : t('Delete {title}', { title: g.title })} disabled={!canvasOnline || !cardProjectActive(g) || busy} className="icon-button" title={g.trashed ? t('Restore') : t('Delete')} onClick={() => act(() => updateCard(g, [{ type: 'graph.trash', trashed: !g.trashed }]))}>{g.trashed ? <RotateCcw size={16}/> : <Trash2 size={16}/>}</button>
                  {g.trashed && <button aria-label={t('Permanently delete {title}', { title: g.title })} disabled={!canvasOnline || !cardProjectActive(g) || busy} className="icon-button" title={t('Permanently delete')} onClick={() => { setCardPurge(g); setCardPurgeTitle(''); }}><Trash2 size={16}/></button>}
                </div></footer>
              </article>)}</div></section>)}</div>}
              {runtimeDisconnected && <div className="library-empty library-disconnected" role="status">
                <WifiOff size={48} aria-hidden="true"/>
                <h2>{t('Workspace connection disconnected')}</h2>
              </div>}
              {!runtimeDisconnected && (localMode || (current && !current.error)) && visibleGraphs.length === 0 && (!localMode && !project ? <div className="library-empty"><Layers size={32}/>
                <>
                  <h2>{t('No bound projects')}</h2>
                  <p>{t('Register a directory on the Workspace device in Workspace management.')}</p>
                  <button type="button" onClick={() => {
                    setManagementInitialPage('add');
                    setManagementEntry(entry => entry + 1);
                    setServicePage('projects');
                    setServicePanelOpen(true);
                  }}>{t('Bind project')}</button>
                </>
              </div> : filter === 'active' ? <div className="library-empty"><Layers size={48}/>
                  <h2>{t('There are currently no Work Graphs')}</h2>
                  <button type="button" disabled={busy || !canvasOnline || !canvasProjectActive} onClick={() => setCreating(true)}>{t('New Work Graph')}</button>
              </div> : null)}
              {creating && <div className="library-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label={t('New Work Graph')} className="library-dialog panel">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (localMode || libraryTargetProject)
                    act(async () => {
                      const currentSelection = captureCanvasSelection();
                      if (localMode && editor.current?.getSnapshot().drafts.length) await editor.current.flush();
                      currentSelection();
                      const created = localMode ? await local.store.create(graphName)
                        : await request<GraphSnapshot>(`/v1/projects/${libraryTargetProject!.projectId}/graphs`, { title: graphName, idempotencyKey: randomId() });
                      currentSelection();
                      selectGraph(created.graphId);
                      if (!localMode) setProjectId(created.projectId);
                      setTab('canvas'); setGraphName(''); setFilter('active'); setCreating(false); showPage('editor'); canvasChanged();
                    });
                }}
              >
                {!localMode && <label>{t('Projects on Workspace')}<select value={libraryTargetProject?.projectId ?? ''} onChange={event => { navigation.current++; setProjectId(event.target.value); }}>
                  {current?.projects.map(p => <option key={p.projectId} value={p.projectId} disabled={p.state !== 'active'}>{p.name}</option>)}
                </select></label>}
                <label>
                  {t('New Work Graph name')}
                  <input
                    value={graphName}
                    onChange={(e) => setGraphName(e.target.value)}
                    required
                  />
                </label>
                <div className="library-dialog-actions">
                  <button type="submit" disabled={!canvasOnline || !canvasProjectActive || busy}>{t('Create Work Graph')}</button>
                  <button type="button" onClick={() => setCreating(false)}>{t('Cancel')}</button>
                </div>
              </form>
              </section></div>}
          </section>}
          {!leftOpen && <button className="icon-button panel real-sidebar-open" aria-label={t('Expand sidebar')} onClick={() => setLeftOpen(true)}><PanelLeftOpen size={18}/></button>}
          <div className="workgraph-status-dock">
            {page === 'editor' && <RunNotifications todos={todos}
              onOpen={id => { void notifications.open(id).catch(onError); }}
              onDismiss={id => { void notifications.dismiss(id).catch(onError); }}
              onDismissAll={() => { void notifications.dismissAll().catch(onError); }} />}
          </div>
          {graph && page === 'editor' && (
            <div
              className="real-canvas-mount"
            >
              <GraphWorkspace
                projectName={localMode ? undefined : project?.name}
                recentGraphs={availableRecentGraphs}
                onOpenRecent={openRecentGraph}
                graphActions={(closeMenu) => <>
                  <button disabled={busy} onClick={() => { closeMenu(); setActionDialog('copy'); }}><Copy size={16} aria-hidden="true"/>{t('Copy to project workspace')}</button>
                  {!Boolean(
                    (graph as GraphSnapshot & { trashed?: boolean }).trashed,
                  ) && (
                    <>
                      <button
                        disabled={!canvasOnline || !canvasProjectActive || busy}
                        onClick={() => { closeMenu(); if (graph.archived) {
                          act(async () => {
                            const currentSelection = captureCanvasSelection();
                            await canvasRequest(graphPath(graph.projectId, graph.graphId) + "/commands", {
                              idempotencyKey: randomId(), expectedExecutionRevision: graph.executionRevision,
                              expectedLayoutRevision: graph.layoutRevision,
                              operations: [{ type: "graph.archive", archived: false }],
                            });
                            currentSelection(); selectGraph(""); canvasChanged();
                          });
                        } else setActionDialog('archive'); }}
                      >
                        {graph.archived ? <RotateCcw size={16} aria-hidden="true"/> : <Archive size={16} aria-hidden="true"/>}{graph.archived ? t('Restore from archive') : t('Archive')}
                      </button>
                      <button
                        disabled={!canvasOnline || !canvasProjectActive || busy}
                        onClick={() => { closeMenu(); setActionDialog('trash'); }}
                      >
                        <Trash2 size={16} aria-hidden="true"/>{t('Move to trash')}
                      </button>
                    </>
                  )}
                  {Boolean(
                    (graph as GraphSnapshot & { trashed?: boolean }).trashed,
                  ) && (
                    <>
                      <button
                        disabled={!canvasOnline || !canvasProjectActive || busy}
                        onClick={() => { closeMenu(); act(() => lifecycle("restore")); }}
                      >
                        <RotateCcw size={16} aria-hidden="true"/>{t('Restore from trash')}
                      </button>
                      <button
                        disabled={!canvasOnline || !canvasProjectActive || busy}
                        onClick={() => setPendingDelete(true)}
                      >
                        <Trash2 size={16} aria-hidden="true"/>{t('Permanently delete…')}
                      </button>
                    </>
                  )}
                  {pendingDelete && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        act(() => lifecycle("purge"));
                      }}
                    >
                      <p>
                        {t('Permanently delete “{title}”, its run history, and snapshots. This cannot be undone.', { title: graph.title })}
                      </p>
                      <label>
                        {t('Enter the Work Graph name to confirm')}
                        <input
                          value={deleteName}
                          onChange={(e) => setDeleteName(e.target.value)}
                        />
                      </label>
                      <div className="graph-confirm-actions">
                        <button disabled={busy || deleteName !== graph.title}>
                          {t('Confirm permanent deletion')}
                        </button>
                        <button type="button" onClick={() => setPendingDelete(false)}>
                          {t('Cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                </>}
                key={
                  graph.serviceId + ":" + (localMode ? 0 : connection?.generation) + ":" + graph.graphId
                }
                onLibrary={() => navigate(() => { enterLibrary.current(); showPage('library'); })}
                onNew={() => navigate(() => { enterLibrary.current(); showPage('library'); setCreating(true); })}
                onDelete={() => setActionDialog('trash')}
                onExport={() => act(() => exportGraph(graph))}
                sidebarTarget={nodeSidebar}
                toastTarget={toastViewport}
                theme={theme}
                request={canvasRequest}
                serviceRequest={localMode ? localBridge?.request : request}
                modelsAvailable={localMode ? !!localBridge?.capabilities.models : !!online}
                modelRefreshToken={modelRevision}
                assetsAvailable={assetsAvailable}
                executionReason={executionUnavailableReason(!!online, localMode, connection?.info.capabilities?.execution)}
                imageReason={executionUnavailableReason(!!online, localMode, connection?.info.capabilities?.imageGeneration)}
                graph={graph}
                online={canvasOnline}
                runtimeUnavailable={!localMode && current?.eventStatus === 'offline'}
                projectActive={canvasProjectActive}
                onOpenRun={run => { setDetailRun(run); setRightPanel(run ? 'details' : null); }}
                onRunSubmitted={run => { setDetailRun(run); setRightPanel('details'); }}
                runs={localMode ? [] : current?.runs ?? []}
                refreshToken={localMode ? local.revision : current?.revision ?? 0}
                onChanged={canvasChanged}
                onCanvas={attachCanvas}
                onAssetsChanged={() => setAssetsRevision(value => value + 1)}
                onOpenProjectDirectory={path => {
                  setLeftOpen(true);
                  setTab('files');
                  queueMicrotask(() => window.dispatchEvent(new CustomEvent('openworkgraph:locate-project-directory', { detail:{ projectId:graph.projectId, path } })));
                }}
                onError={onError}
                onEditor={(e) => {
                  editor.current = e;
                }}
                executionAvailable={
                  !localMode && connection?.info.capabilities?.execution?.status ===
                  "available"
                }
                imageAvailable={
                  !localMode && connection?.info.capabilities?.imageGeneration?.status ===
                  "available"
                }
                temporary={localMode}
                uploadFile={localMode ? file => local.store.upload(graph.graphId, file) : undefined}
                onPlaceProjectFile={localMode ? undefined : placeProjectFile}
                locateNodeId={localMode ? undefined : locateNodeId}
                editExecutionNode={localMode ? undefined : editExecutionNode}
              />
              {actionDialog && <div className="library-dialog-backdrop">
                {actionDialog === 'copy' ? <form className="library-dialog panel" role="dialog" aria-modal="true" aria-label={t('Copy to project workspace')} onKeyDown={event => {
                  if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); closeActionDialog(); }
                }} onSubmit={event => { event.preventDefault(); act(copyToWorkspace); }}>
                  <h2>{t('Copy to project workspace')}</h2>
                  <p>{t('Nodes, edges, groups, and file resources become an independent Work Graph in the target project workspace. The original Work Graph is kept.')}</p>
                  <label>{t('Target Workspace')}<select autoFocus aria-label={t('Target Workspace')} disabled={busy} value={copyConnection?.serviceId ?? ''} onChange={event => { setCopyServiceId(event.target.value); setCopyProjectId(''); }}>
                    <option value="" disabled>{t('Connect a Workspace from the right panel first')}</option>
                    {services.map(c => <option key={c.serviceId} value={c.serviceId}>{c.address}</option>)}
                  </select></label>
                  <label>{t('Target project workspace')}<select aria-label={t('Target project workspace')} disabled={busy} value={copyProject?.projectId ?? ''} onChange={event => setCopyProjectId(event.target.value)}>
                    <option value="" disabled>{t('Select an active project workspace')}</option>
                    {copyProjects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
                  </select></label>
                  {copyPending && <p>{t('Retrying uses the previous Work Graph snapshot and the same operation ID, so it will not create a duplicate.')}</p>}
                  <div className="library-dialog-actions"><button disabled={busy || !canCopy}>{copyPending ? t('Retry copy') : t('Confirm copy')}</button><button type="button" disabled={busy} onClick={closeActionDialog}>{t('Cancel')}</button></div>
                </form> : <section className="library-dialog panel" role="dialog" aria-modal="true" aria-label={actionDialog === 'archive' ? t('Confirm Work Graph archive') : t('Confirm move to trash')} onKeyDown={event => {
                  if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); closeActionDialog(); }
                }}>
                  <h2>{actionDialog === 'archive' ? t('Archive Work Graph') : t('Move to trash')}</h2>
                  <p>{actionDialog === 'archive' ?
                    t('Archive “{title}”? You can restore it from the archived list.', { title: graph.title }) :
                    t('Move “{title}” to the trash? You can restore it from the trash later.', { title: graph.title })}</p>
                  <div className="library-dialog-actions">
                    <button type="button" disabled={busy} onClick={() => {
                      if (actionDialog === 'trash') { act(() => lifecycle('trash')); return; }
                      act(async () => {
                        const currentSelection = captureCanvasSelection();
                        await canvasRequest(graphPath(graph.projectId, graph.graphId) + '/commands', {
                          idempotencyKey: randomId(), expectedExecutionRevision: graph.executionRevision,
                          expectedLayoutRevision: graph.layoutRevision,
                          operations: [{ type: 'graph.archive', archived: true }],
                        });
                        currentSelection(); setActionDialog(undefined); selectGraph(''); canvasChanged();
                      });
                    }}>{actionDialog === 'archive' ? t('Confirm archive') : t('Confirm move to trash')}</button>
                    <button type="button" disabled={busy} onClick={closeActionDialog} autoFocus>{t('Cancel')}</button>
                  </div>
                </section>}
              </div>}
            </div>
          )}
          {page === 'editor' && !graph && (
            <section className="real-empty"><h2>{t('Select or create a Work Graph')}</h2><button onClick={() => showPage("library")}>{t('My Work Graphs')}</button><p>{t('Select a Workspace in My Work Graphs, then create or open a Work Graph.')}</p></section>
          )}
        </section>
        <aside id="service-panel" className={'real-service-panel' + (rightPanel ? '' : ' real-service-panel-collapsed')} aria-label={panelContent === 'queue' ? t('Workspace queue') : panelContent === 'details' ? t('Run details') : t('Workspace management and connection')} aria-hidden={!rightPanel} inert={!rightPanel}>
          {panelContent === 'details' && detailRun && connection && detailRun.serviceId === serviceId && <div className="real-right-panel-content">
            <div className="service-panel-heading"><h2>{t('Run details')}</h2><button className="icon-button" aria-label={t('Close run details')} onClick={() => setRightPanel(null)}>×</button></div>
            <RunsPanel key={serviceId + ":" + connection.generation} mode="details" selectedRunId={detailRun.id} onSelectRun={setDetailRun}
              request={request} runs={runsForDetail(current?.runs ?? [], detailRun)} graphId={detailRun.graphId}
              onEditExecutionNode={(run,nodeId)=>{setTemporary(false);setProjectId(run.projectId);setGraphId(run.graphId);setEditExecutionNode({nodeId,graphId:run.graphId,projectId:run.projectId,nonce:Date.now()});}}
              readOnly={!online} onChanged={changed} onError={onError} onLocate={run => { setTemporary(false); setProjectId(run.projectId); setGraphId(run.graphId); setLocateNodeId(run.nodeId); }}/>
          </div>}
          {panelContent === 'queue' && connection && (
            <div className="real-right-panel-content"><div className="service-panel-heading"><h2>{t('Workspace queue')}</h2><button className="icon-button" aria-label={t('Close Workspace queue')} onClick={() => setRightPanel(null)}>×</button></div><RunsPanel
              key={serviceId + ":" + connection.generation}
              mode="queue"
              onSelectRun={run => { setDetailRun(run); setRightPanel('details'); }}
              describeRun={run => ({ node: String((current?.graphs.find(g => g.graphId === run.graphId)?.nodes.find(n => n.id === run.nodeId)?.content as { title?: string })?.title ?? t('Node removed')), graph: current?.graphs.find(g => g.graphId === run.graphId)?.title ?? t('Work Graph'), project: current?.projects.find(p => p.projectId === run.projectId)?.name ?? run.projectId })}
              request={request}
              runs={current?.runs ?? []}
              graphId={graph?.graphId}
              readOnly={!online}
              onChanged={changed}
              onError={onError}
              onLocate={(run) => {
                setTemporary(false);
                setProjectId(run.projectId);
                setGraphId(run.graphId);
                setLocateNodeId(run.nodeId);
              }}
            /></div>
          )}
          {panelContent === 'management' && <>
          <div className="service-panel-heading"><h2>{t('Workspace management and connection')}</h2><button className="icon-button" aria-label={t('Collapse')} onClick={() => setServicePanelOpen(false)}>×</button></div>
          <div className="service-panel-content">
          {servicePage === "connect" && <>
          <div className="runtime-subpage-heading"><button className="runtime-back" type="button" aria-label={t('Back to Workspace list')} title={t('Back to Workspace list')} onClick={() => setServicePage("list")}><ArrowLeft size={20} aria-hidden="true" /></button><h3>{t('Connect new Workspace')}</h3></div>
          <Pairing
            registry={registry}
            onPaired={(id) => {
              navigate(() => { setActiveService(id); setTemporary(false); setTab('canvas'); setFilter('active'); changed(); setServicePage('list'); });
            }}
            onError={onError}
          />
          </>}
          {servicePage === "list" && <><p className="runtime-intro">{t('Select a Workspace to manage projects, or connect another device.')}</p>
          <button className="runtime-connect runtime-primary" type="button" onClick={() => setServicePage("connect")}><Plus size={16} aria-hidden="true" />{t('Connect new Workspace')}</button>
          <div className="runtime-list-heading"><h3>{t('Connected Workspaces')}</h3><span>{connections.length}</span></div>
          {connections.length === 0 && (
            <div className="runtime-empty"><Server size={28} aria-hidden="true" /><strong>{t('No Workspace connected')}</strong><p>{t('Connect a Workspace to manage projects and run tasks.')}<br />{t('Temporary Work Graphs are available immediately and are not uploaded automatically after connecting.')}</p></div>
          )}
          {connections.map((c) => (
            <div className="real-service" data-selected={serviceId === c.serviceId} key={c.serviceId}>
              <button
                className="runtime-card-open"
                aria-pressed={serviceId === c.serviceId}
                onClick={() => {
                  if (serviceId === c.serviceId) {
                    setManagementInitialPage('projects');
                    setServicePage(c.status === 'invalid' ? 'connect' : 'projects');
                    return;
                  }
                  navigate(() => {
                    setActiveService(c.serviceId); setTemporary(false);
                    setProjectId(''); setGraphId(''); setTab('canvas'); setFilter('active');
                    setManagementInitialPage('projects');
                    setServicePage(c.status === 'invalid' ? 'connect' : 'projects');
                  });
                }}
              >
                <span className="runtime-card-heading"><Server size={18} aria-hidden="true" /><span className="runtime-address">{c.runtimeName || c.address}</span><ChevronRight size={16} aria-hidden="true" /></span>
                {c.runtimeName && <small>{c.address}</small>}
                <span className="runtime-card-status">
                  <span className="runtime-status">
                    {c.status === 'paired' ? <CheckCircle2 size={14} aria-hidden="true" /> : c.status === 'offline' ? <WifiOff size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
                    {c.status === 'paired' ? t('Authenticated') : c.status === 'offline' ? t('Offline') : t('Session expired. Pair again.')}
                  </span>
                  {serviceId === c.serviceId && <span className="runtime-current">{t('Current Workspace')}</span>}
                </span>
                {runtimeNeedsUpgrade(c.info.version, webClientPackage.version) && <span className="runtime-upgrade-warning"><CircleAlert size={14} aria-hidden="true" />{t('Upgrade Workspace v{runtimeVersion} to v{clientVersion}', { runtimeVersion: c.info.version, clientVersion: webClientPackage.version })}</span>}
                <small className="runtime-identity">ID · {c.serviceId}</small>
              </button>
              <div className="runtime-card-actions">
              {c.status === 'paired' && c.info.installation === 'npm-global' && runtimeNeedsUpgrade(c.info.version, webClientPackage.version) && (
                <button type="button" disabled={!!updatingRuntime} onClick={() => void updateRuntime(c)}>
                  <Download size={14} aria-hidden="true" />{updatingRuntime?.serviceId === c.serviceId ? t('Updating Workspace…') : t('Update Workspace')}
                </button>
              )}

              <button
                className="runtime-disconnect"
                onClick={() => {
                  notifications.removeService(c.serviceId);
                  clearServiceCache(c.serviceId);
                  registry.forget(c.serviceId);
                  setUpdatingRuntime(current => current?.serviceId === c.serviceId ? undefined : current);
                  setData((d) =>
                    Object.fromEntries(
                      Object.entries(d).filter(([id]) => id !== c.serviceId),
                    ),
                  );
                }}
              >
                <Unplug size={14} aria-hidden="true" />{t('Disconnect')}
              </button>
              {c.status === "offline" && (
                <button
                  onClick={() => act(() => registry.restore([c.serviceId]))}
                >
                  <RotateCcw size={14} aria-hidden="true" />{t('Reconnect')}
                </button>
              )}
              </div>
            </div>
          ))}
          </>}
          {servicePage === "projects" && connection && (
            <ManagementPanel
              initialPage={managementInitialPage}
              onBack={() => setServicePage("list")}
              runtimeAddress={connection.address}
              onRenameRuntime={() => setRuntimeRename({ serviceId: connection.serviceId, sessionId: connection.session.id, name: connection.runtimeName || '' })}
              readOnly={!online}
              key={serviceId + ":" + connection.generation + ":" + managementInitialPage + ":" + managementEntry}
              request={request}
              projectId={project?.projectId}
              graphId={localMode ? undefined : graph?.graphId}
              onChanged={changed}
              onModelsChanged={() => setModelRevision(value => value + 1)}
              onError={onError}
            />
          )}
          </div>
          </>}
        </aside>
      </div>
    </main>
  );
}
function Pairing({
  registry,
  onPaired,
  onError,
}: {
  registry: ConnectionRegistry;
  onPaired: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState("http://127.0.0.1:14317");
  const [name, setName] = useState<string>();
  const [runtimeName, setRuntimeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<PairingIdentity>();
  const [clientCode, setClientCode] = useState('');
  const identityRef = useRef<PairingIdentity | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [pairError, setPairError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const clientTicket = useRef(0);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      clientTicket.current++;
      controllerRef.current?.abort();
      identityRef.current?.dispose();
    },
    [],
  );
  return (
    <div className="runtime-pairing">
      <p className="runtime-intro">{t('Connect a Workspace to manage projects and Work Graphs in this browser.')}</p>
      <section className="runtime-step" aria-labelledby="pairing-authorize-title">
      <h4 id="pairing-authorize-title"><span className="runtime-step-number">1</span>{t('Enter the address and authorize')}</h4>
      <p>{t('Enter the address of the Workspace device, then generate a client code.')}</p>
        <label>
          {t('Workspace address')}
          <input
            form="runtime-pairing-form"
            type="url"
            required
            disabled={generating || busy}
            value={address}
            onChange={(e) => {
              attempt.current++;
              if (e.target.value !== address) {
                clientTicket.current++; controllerRef.current?.abort(); controllerRef.current = undefined; identityRef.current?.dispose(); identityRef.current = undefined;
                setIdentity(undefined); setClientCode(''); setCopyStatus('');
              }
              setAddress(e.target.value);
              setBusy(false);
            }}
          />
        </label>
        <label>
          {t('Workspace name')}
          <input disabled={generating || busy} maxLength={RUNTIME_NAME_MAX_LENGTH} value={runtimeName} placeholder={address} onChange={(e) => setRuntimeName(e.target.value)} />
        </label>
        <label>
          {t('Browser name')}
          <input required disabled={generating || busy} value={name ?? t('Desktop browser')} onChange={(e) => setName(e.target.value)} />
        </label>

      <button className="runtime-primary" type="button" disabled={generating || busy} onClick={() => {
        const ticket = ++clientTicket.current;
        attempt.current++;
        controllerRef.current?.abort();
        identityRef.current?.dispose();
        identityRef.current = undefined;
        setIdentity(undefined); setClientCode(''); setPairError(''); setCopyStatus(''); setGenerating(true);
        void createPairingIdentity(location.origin).then(async value => {
          try {
            const request = await registry.requestClientPairing(address, value);
            if (ticket !== clientTicket.current) { value.dispose(); return; }
            const controller = new AbortController();
            controllerRef.current = controller;
            identityRef.current = value; setIdentity(value); setClientCode(request.code); setGenerating(false); setBusy(true);
            const connection = await registry.waitForClientPairing(request, name ?? t('Desktop browser'), value, runtimeName.trim() || undefined, controller.signal);
            if (ticket !== clientTicket.current) return;
            value.dispose(); identityRef.current = undefined; setIdentity(undefined); setBusy(false);
            onPaired(connection.serviceId);
          } catch (error) { value.dispose(); throw error; }
        }).catch(error => { if (ticket === clientTicket.current) { setPairError(messageOf(error)); onError(error); } })
          .finally(() => { if (ticket === clientTicket.current) { setGenerating(false); setBusy(false); } });
      }}>{generating ? t('Generating…') : busy ? t('Waiting for Workspace approval…') : identity ? t('Regenerate client code') : t('Generate client code')}</button>
      {identity && <>
        <label>{t('Client code')}<input readOnly value={clientCode} onFocus={e => e.currentTarget.select()} spellCheck={false} className="pairing-short-code" /></label>
        <button type="button" onClick={() => {
          const ticket = clientTicket.current;
          if (!navigator.clipboard?.writeText) { setCopyStatus('Select the client code above and copy it manually.'); return; }
          void navigator.clipboard.writeText(clientCode).then(() => { if (ticket === clientTicket.current) setCopyStatus('Client code copied.'); })
            .catch(() => { if (ticket === clientTicket.current) setCopyStatus('Copy is unavailable. Select the client code and copy it manually.'); });
        }}>{t('Copy client code')}</button>
        <p role="status">{copyStatus ? t(copyStatus) : ''}</p>
        <small>{t('Current origin: {origin}', { origin: location.origin })}</small>
        <details><summary>{t('View public key fingerprint')}</summary><small>{t('Public key fingerprint SHA-256: {fingerprint}', { fingerprint: identity.fingerprint })}</small></details>
        <p>{t('Run this on the Workspace device (no need to enter the origin manually):')}</p>
        <code>npx openworkgraph pair --client-code {clientCode}</code>
        <p>{t('The client code is valid for 5 minutes. Keep this page open; refreshing or regenerating requires authorization again.')}</p>
        {busy && <p role="status">{t('Waiting for Workspace approval…')}</p>}
      </>}
      </section>
      {pairError && <p role="status">{t('Pairing was not completed. Check the notification and try again.')}</p>}
      <details className="runtime-help"><summary>{t('Connection and access information')}</summary>
        <p>{t('After pairing, this browser has full management access: it can manage projects and Work Graphs, run tasks, manage assets, revoke browser sessions, and manage operation backups.')}</p>
        <p>{t('HTTP is supported and HTTPS is not required. HTTP does not encrypt sessions or business data, so use it only on trusted networks. Legacy pairing codes can still be redeemed.')}</p>
        <p>
          {t('The address belongs to the Workspace device; do not use the other device’s localhost across devices. If Chrome or Edge requests local network access, authorize it according to your deployment policy.')}
        </p>
      </details>
    </div>
  );
}
function ServiceMonitor({
  registry,
  connection,
  refresh,
  onData,
}: {
  registry: ConnectionRegistry;
  connection: Connection;
  refresh: number;
  onData: (id: string, data: ServiceData) => void;
}) {
  const latest = useRef({ connection, onData });
  latest.current = { connection, onData };
  const trigger = useRef<() => void>(() => undefined);
  useEffect(() => {
    const lifecycle = new AbortController();
    const lease = registry.lease(connection.serviceId);
    if (lease.generation !== connection.generation) return;
    const transport = new Transport(registry, connection.serviceId, {
      signal: lifecycle.signal,
    });
    const cacheKey =
      "openworkgraph:real:cache:" +
      connection.serviceId +
      ":" +
      connection.session.id;
    let alive = true;
    let counter = 0;
    let eventStatus: ServiceData["eventStatus"] = "starting";
    let snapshot: ServiceData = {
      generation: connection.generation,
      projects: [],
      graphs: [],
      runs: [],
      notifications: [],
      revision: 0,
      eventStatus: "starting",
    };
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? "null");
      if (
        cached &&
        Array.isArray(cached.projects) &&
        Array.isArray(cached.graphs) &&
        Array.isArray(cached.runs) &&
          cached.graphs.every(
            (g: GraphSnapshot) => g.serviceId === connection.serviceId,
          ) && Array.isArray(cached.notifications)
      ) {
        snapshot = {
          ...cached,
          generation: connection.generation,
          eventStatus: "starting",
          revision: 0,
        };
        latest.current.onData(connection.serviceId, snapshot);
      }
    } catch {
      /* Cache is not authoritative. */
    }
    const readAuthority = createAuthoritativeLoader(
      async () => {
        const { cursor } = await transport.request<{ cursor: string }>(
          "/v1/events/cursor",
        );
        const [projects, runs, notifications] = await Promise.all([
          transport.request<Project[]>("/v1/projects/all"),
          transport.request<Run[]>("/v1/runs"),
          transport.request<RunNotification[]>("/v1/notifications"),
        ]);
        const graphs = (
          await Promise.all(
            projects.map((p) =>
              readProjectGraphPages(
                transport.request.bind(transport),
                connection.serviceId,
                p.projectId,
                () => {
                  if (!alive) throw new LifecycleCancelledError();
                  registry.assertCurrent(lease);
                },
              ),
            ),
          )
        ).flat();
        return { cursor, projects, graphs, runs, notifications };
      },
      ({ projects, graphs, runs, notifications }) => {
        snapshot = {
          generation: connection.generation,
          projects,
          graphs,
          runs,
          notifications,
          revision: ++counter,
          eventStatus,
        };
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(snapshot));
        } catch {
          /* The in-memory cache remains available. */
        }
        latest.current.onData(connection.serviceId, snapshot);
      },
      () => {
        if (!alive) throw new LifecycleCancelledError();
        registry.assertCurrent(lease);
      },
    );
    const load = async (): Promise<string> => {
      try {
        return (await readAuthority()).cursor;
      } catch (error) {
        if (alive && !isLifecycleCancellation(error)) {
          eventStatus = "offline";
          snapshot = {
            ...snapshot,
            error: messageOf(error),
            eventStatus,
          };
          latest.current.onData(connection.serviceId, snapshot);
        }
        throw error;
      }
    };
    let bootstrapRetry: ReturnType<typeof setTimeout> | undefined;
    trigger.current = () => {
      clearTimeout(bootstrapRetry);
      void load()
        .then((cursor) => {
          if (!stream) startStream(cursor);
        })
        .catch(() => {
          if (
            alive &&
            !stream &&
            registry.get(connection.serviceId)?.status !== "invalid"
          )
            bootstrapRetry = setTimeout(() => trigger.current(), 2000);
        });
    };
    let stream: EventSubscription | undefined;
    const startStream = (cursor: string) => {
      if (!alive) return;
      registry.assertCurrent(lease);
      stream = new EventSubscription(
        transport,
        connection.serviceId,
        {
          onEvent: async (event) => {
            // Preparing/copying resource bytes does not change graph topology.
            // The subsequent graph.changed event publishes the atomic placement.
            if (event.type.startsWith('canvas_resource.')) return;
            if (event.type === 'project.files.changed') window.dispatchEvent(new CustomEvent('openworkgraph:project-files-changed', { detail:{ serviceId:event.serviceId, projectId:event.projectId, payload:event.payload } }));
            await load();
          },
          reloadSnapshot: load,
          onError: (error) => {
            if (alive && !isLifecycleCancellation(error)) {
              eventStatus = "offline";
              snapshot = {
                ...snapshot,
                error: messageOf(error),
                eventStatus,
              };
              latest.current.onData(connection.serviceId, snapshot);
            }
          },
          onStatus: (status) => {
            if (status === "connected") eventStatus = "connected";
            else if (status === "reconnecting" || status === "stopped") eventStatus = "offline";
            if (alive) {
              if (eventStatus === "connected") trigger.current();
              else if (eventStatus === "offline") {
                snapshot = { ...snapshot, eventStatus };
                latest.current.onData(connection.serviceId, snapshot);
              }
            }
          },
        },
        { cursor },
      );
      stream.start();
    };
    const reconnectBootstrap = () => {
      if (!stream) trigger.current();
    };
    window.addEventListener("online", reconnectBootstrap);
    trigger.current();
    return () => {
      alive = false;
      clearTimeout(bootstrapRetry);
      window.removeEventListener("online", reconnectBootstrap);
      lifecycle.abort();
      trigger.current = () => undefined;
      void stream?.stop();
    };
  }, [registry, connection.serviceId, connection.generation]);
  useEffect(() => trigger.current(), [refresh]);
  return null;
}
