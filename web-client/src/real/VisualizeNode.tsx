import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import sdkSource from "virtual:visualize-sdk";
import { bindVisualizeIframe } from "../../../packages/protocol/src/index";
import type { GraphScope, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeHostContext, VisualizeInputSnapshot, VisualizeStoredNode } from "../../../packages/protocol/src/index";
import { bindVisualizeAssetTransport, loadVisualizePageAssets, updateVisualizePageAssets } from "./visualize-assets";
import { openVisualizeBridge } from "./visualize-bridge";
import { prepareVisualizeHtmlDocument, VISUALIZE_HTML_SANDBOX, VISUALIZE_HTML_PERMISSIONS } from "./visualize-html";
import { graphPath, messageOf, errorCode, type Request } from "./contracts";
import { randomId } from "../adapter/random";
import { useI18n } from "../i18n/I18nProvider";
import "./VisualizeNode.css";

type Bridge = Awaited<ReturnType<typeof openVisualizeBridge>>;
type Entry = { revision: number; bridge: Promise<Bridge>; context?: VisualizeHostContext; tail: Promise<unknown> };
/** The graph owns capabilities; changing views never recaptures accepted inputs. */
export class VisualizeSessions {
  private entries = new Map<string, Entry>();
  constructor(readonly request: Request, readonly scope: GraphScope) {}
  async acquire(nodeId: string, revision: number, presentation: Pick<VisualizeHostContext, "theme" | "locale" | "viewport">): Promise<Entry> {
    let entry = this.entries.get(nodeId);
    if (entry && entry.revision !== revision) { this.close(nodeId); entry = undefined; }
    if (!entry) {
      entry = { revision, bridge: openVisualizeBridge({ request: this.request }, this.scope, nodeId, presentation), tail: Promise.resolve() };
      this.entries.set(nodeId, entry);
      const captured = entry;
      void entry.bridge.catch(() => { if (this.entries.get(nodeId) === captured) this.entries.delete(nodeId); });
    }
    await entry.bridge;
    return entry;
  }
  dispatch(entry: Entry, request: VisualizeBridgeRequest, bytes?: ArrayBuffer): Promise<VisualizeBridgeResponse> {
    const work = entry.tail.catch(() => undefined).then(async () => {
      const response = await (await entry.bridge).dispatch(request, bytes);
      if (response.ok) {
        const result = response.result as unknown as Record<string, any>;
        if (request.method === "initialize") entry.context = result as VisualizeHostContext;
        else if (entry.context) {
          if (result.revisions) entry.context.revisions = result.revisions;
          if (result.form) entry.context.form = result.form;
          if (result.state) entry.context.state = result.state;
          if (result.inputs) { entry.context.inputs = result.inputs; entry.context.revisions.inputVersion = result.inputs.version; entry.context.inputsChanged = result.inputsChanged; }
          if (result.layoutRevision) entry.context.revisions.layoutRevision = result.layoutRevision;
        }
      }
      return response;
    });
    entry.tail = work;
    return work;
  }
  close(nodeId: string): void { const entry = this.entries.get(nodeId); if (!entry) return; this.entries.delete(nodeId); void entry.tail.catch(() => undefined).then(() => entry.bridge).then(bridge => bridge.close()).catch(() => undefined); }
  retain(ids: string[]): void { for (const id of this.entries.keys()) if (!ids.includes(id)) this.close(id); }
  dispose(): void { for (const id of this.entries.keys()) this.close(id); }
}

export function VisualizeNode(props: { owner: VisualizeSessions; nodeId: string; pageRevision?: number; theme?: "light" | "dark"; locale?: string; online: boolean; readOnly: boolean; temporary?: boolean; expanded?: boolean; onDismiss?(): void; onChanged(): void; onAssetsChanged?(): void; onError(error: unknown): void; onOpenPrompt(): void }) {
  const { t } = useI18n();
  const latest = useRef(props); latest.current = props;
  const iframe = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const binding = useRef<{ dispose(): void } | null>(null);
  const activeEntry = useRef<Entry | undefined>(undefined);
  const attach = useRef<() => void>(() => undefined);
  const pushCapabilities = useRef<() => void>(() => undefined);
  const pushVisibility = useRef<() => void>(() => undefined);
  const [visible, setVisible] = useState(!!props.expanded);
  const [entered, setEntered] = useState(!!props.expanded);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [awaitingViewport, setAwaitingViewport] = useState(false);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  useEffect(() => {
    if (props.expanded) { setVisible(true); setEntered(true); return; }
    const observer = new IntersectionObserver(entries => {
      const active = entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      setVisible(active); if (active) setEntered(true);
    }, { root: box.current?.closest('.owg-canvas') ?? null });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [props.expanded]);
  const [document, setDocument] = useState<string>();
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshLocked, setRefreshLocked] = useState(false);
  const refreshPending = useRef(false);
  const refreshUnlockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshIcon = useRef<SVGSVGElement>(null);
  const [spinning, setSpinning] = useState(false);
  const [spinCycles, setSpinCycles] = useState<number>();
  const unlockRefresh = () => {
    clearTimeout(refreshUnlockTimer.current); refreshUnlockTimer.current = undefined;
    refreshPending.current = false; setRefreshLocked(false);
  };
  const stopRefreshAnimation = () => { setSpinning(false); };
  const finishRefresh = () => {
    setRefreshing(false);
    if (!refreshPending.current) return;
    if (!refreshIcon.current || !visibleRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { stopRefreshAnimation(); unlockRefresh(); return; }
    const animation = refreshIcon.current?.getAnimations().find(item => item instanceof CSSAnimation && item.animationName === 'ow-visualize-refresh-spin');
    if (!animation?.effect) { stopRefreshAnimation(); unlockRefresh(); return; }
    const timing = animation.effect.getComputedTiming();
    const cycles = (timing.currentIteration ?? 0) + 1;
    // Keep the animation's timeline and finish the current revolution naturally.
    setSpinCycles(cycles);
    // Button recovery has its own timer; a cancelled animation may never emit animationend.
    clearTimeout(refreshUnlockTimer.current);
    const remaining = Math.max(0, (cycles * Number(timing.duration) - Number(animation.currentTime ?? 0)) / animation.playbackRate);
    refreshUnlockTimer.current = setTimeout(unlockRefresh, remaining);
  };
  useEffect(() => () => { clearTimeout(refreshUnlockTimer.current); }, []);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => { if (motion.matches) { stopRefreshAnimation(); if (!refreshing) unlockRefresh(); } };
    motion.addEventListener('change', changed);
    return () => motion.removeEventListener('change', changed);
  }, [refreshing]);
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  const connectionRetries = useRef(0);
  const presentation = () => {
    const style = getComputedStyle(window.document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of ["canvas", "panel", "fill", "text", "muted", "stroke", "active", "link", "danger"]) { const value = style.getPropertyValue("--" + name).trim(); if (value) tokens[name] = value; }
    return { theme: { mode: latest.current.theme ?? "light", tokens }, locale: latest.current.locale ?? "en", viewport: { width: Math.max(1, iframe.current?.clientWidth || box.current?.clientWidth || 480), height: Math.max(1, iframe.current?.clientHeight || box.current?.clientHeight || 360) } };
  };
  useEffect(() => {
    if (!entered) return;
    if (!visibleRef.current) { setAwaitingViewport(true); finishRefresh(); return; }
    setAwaitingViewport(false);
    if (!props.online && !props.temporary) { setWaitingForConnection(true); finishRefresh(); return; }
    setWaitingForConnection(false);
    let live = true;
    const releaseAssets: (() => void)[] = [];
    binding.current?.dispose(); binding.current = null; setDocument(undefined); setFrameLoaded(false); setEmpty(false); setError(""); setNotice(""); setChanged(false);
    activeEntry.current = undefined;
    const { owner, nodeId } = props;
    const responseIdentity = (request: VisualizeBridgeRequest) => ({ channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId, requestId: request.requestId, type: "response" as const, method: "initialize" as const });
    const failure = (request: VisualizeBridgeRequest, code: "OFFLINE" | "READ_ONLY" | "INPUT_BLOCKED", message: string): VisualizeBridgeResponse => ({ channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId, requestId: request.requestId, type: "response", method: request.method, ok: false, error: { code, message, retryable: code === "OFFLINE" } });
    void (async () => {
      const stored = await owner.request<VisualizeStoredNode>(graphPath(owner.scope.projectId, owner.scope.graphId) + "/visualize/" + encodeURIComponent(nodeId));
      if (!live) return;
      if (!visibleRef.current) { setAwaitingViewport(true); finishRefresh(); return; }
      if (!stored.page || !stored.content.page || !stored.content.form || !stored.content.state) { setEmpty(true); finishRefresh(); return; }
      const page = stored.page;
      const view = presentation();
      let entry: Entry | undefined; let identity: { sessionId: string; nodeId: string };
      if (!props.temporary) { entry = await owner.acquire(nodeId, stored.content.page.revision, view); identity = await entry.bridge; activeEntry.current = entry; }
      else identity = { sessionId: randomId(), nodeId };
      if (!live) return;
      if (!visibleRef.current) { setAwaitingViewport(true); finishRefresh(); return; }
      const context: VisualizeHostContext = { ...view, pageRevision: stored.content.page.revision, form: stored.content.form, state: stored.content.state, inputs: { version: 1, digest: "0".repeat(64), inputs: [] }, inputsChanged: false, revisions: { pageRevision: stored.content.page.revision, formVersion: stored.content.form.version, stateVersion: stored.content.state.version, inputVersion: 1, executionRevision: stored.executionRevision, layoutRevision: stored.layoutRevision }, capabilities: { readOnly: true, online: false, canCreateSuccessors: false, canExportAssets: false } };
      let assetInputDigest: string | undefined;
      const assetRefreshes = new Map<string, Promise<void>>();
      let assetRefreshTail: Promise<void> = Promise.resolve();
      const refreshInputAssets = (inputs: VisualizeInputSnapshot): Promise<void> => {
        const existing = assetRefreshes.get(inputs.digest);
        if (existing) return existing;
        // Share retries and preserve snapshot order through the media update,
        // which is outside the workspace bridge's serialized dispatch.
        const work = assetRefreshTail.catch(() => undefined).then(async () => {
          if (!live || inputs.digest === assetInputDigest) return;
          const assets = await loadVisualizePageAssets({ request: owner.request, scope: owner.scope, page: { ...page, dependencies: [] }, form: {}, inputs, alive: () => live });
          if (!live) return;
          updateVisualizePageAssets(iframe.current, identity, assets.binaryAssets);
          if (assets.errors.length) setNotice(assets.errors.join('；'));
          else assetInputDigest = inputs.digest;
        }).finally(() => { assetRefreshes.delete(inputs.digest); });
        assetRefreshes.set(inputs.digest, work);
        assetRefreshTail = work;
        return work;
      };
      const dispatch = async (request: VisualizeBridgeRequest, bytes?: ArrayBuffer): Promise<VisualizeBridgeResponse> => {
        const current = latest.current;
        let response: VisualizeBridgeResponse;
        if (!visibleRef.current) response = failure(request, "READ_ONLY", t("Interactive page paused outside the viewport."));
        else if (current.temporary) response = request.method === "initialize" ? { ...responseIdentity(request), ok: true, result: { ...context, ...presentation() } } : failure(request, request.method === "readInputs" ? "INPUT_BLOCKED" : "READ_ONLY", t("Connect a Workspace to use page inputs and save changes."));
        else if (!current.online && request.method === "initialize" && entry?.context) response = { ...responseIdentity(request), ok: true, result: structuredClone(entry.context) };
        else if (!current.online) response = failure(request, "OFFLINE", t("The Workspace is disconnected or synchronizing. Connect and try again."));
        else if (current.readOnly && !["initialize", "readInputs"].includes(request.method)) response = failure(request, "READ_ONLY", t("The current Work Graph is read-only."));
        else response = await owner.dispatch(entry!, request, bytes);
        if (live && response.ok && request.method === "readInputs" && request.params.refresh) {
          const inputs = (response.result as { inputs: VisualizeInputSnapshot }).inputs;
          await refreshInputAssets(inputs);
        }
        if (response.ok && request.method === "initialize") {
          const result = response.result as VisualizeHostContext;
          response = { ...response, method: "initialize", result: { ...result, ...presentation(), capabilities: { ...result.capabilities, readOnly: !!current.temporary || current.readOnly || result.capabilities.readOnly, online: !current.temporary && current.online, canCreateSuccessors: !current.temporary && current.online && !current.readOnly && result.capabilities.canCreateSuccessors, canExportAssets: !current.temporary && current.online && !current.readOnly && !!result.capabilities.canExportAssets } } };
        }
        if (live) {
          if (!response.ok) {
            setNotice(response.error.message + (response.error.fields?.length ? " " + response.error.fields.map(field => field.path + ": " + field.message).join("; ") : ""));
            if (response.error.code === "SESSION_EXPIRED") { owner.close(nodeId); setError(response.error.message); }
          }
          else if (request.method === "readInputs") setChanged((response.result as { inputsChanged: boolean }).inputsChanged);
          else if (["saveState", "updateForm", "createSuccessors", "requestLayout", "exportAsset"].includes(request.method)) {
            setNotice(t(request.method === "createSuccessors" ? "Successors created. Run them manually when ready." : request.method === "exportAsset" ? "Asset saved to the library and added to the Work Graph." : "Saved"));
            if (request.method === "exportAsset") current.onAssetsChanged?.();
            current.onChanged();
          }
        }
        return response;
      };
      if (entry) {
        const bridge = await entry.bridge;
        const initialized = await owner.dispatch(entry, { channel: "openworkgraph.visualize", version: 1, sessionId: bridge.sessionId, nodeId, requestId: randomId(), type: "request", method: "initialize", expected: context.revisions, params: {} });
        if (!initialized.ok) throw Object.assign(new Error(initialized.error.message), initialized.error);
      }
      const { resources, binaryAssets, errors } = await loadVisualizePageAssets({ request: owner.request, scope: owner.scope, page: stored.page, form: stored.content.form.data, inputs: entry?.context?.inputs, alive: () => live });
      if (!live) return;
      if (errors.length) setNotice(errors.join('；'));
      else assetInputDigest = entry?.context?.inputs.digest;
      const html = await prepareVisualizeHtmlDocument({ page: stored.page, hostOrigin: window.location.origin, ...identity, sdkSource, resources, theme: view.theme, locale: view.locale, expanded: props.expanded });
      if (!live) return;
      setChanged(entry?.context?.inputsChanged ?? false);
      pushCapabilities.current = () => {
        if (!live || !binding.current || !iframe.current?.contentWindow) return;
        const current = latest.current;
        const capabilities = entry?.context?.capabilities ?? context.capabilities;
        iframe.current.contentWindow.postMessage({ channel: "openworkgraph.visualize", version: 1, sessionId: identity.sessionId, nodeId, type: "capabilities", capabilities: { readOnly: !!current.temporary || current.readOnly || capabilities.readOnly, online: !current.temporary && current.online, canCreateSuccessors: !current.temporary && current.online && !current.readOnly && capabilities.canCreateSuccessors, canExportAssets: !current.temporary && current.online && !current.readOnly && !!capabilities.canExportAssets } }, "*");
      };
      attach.current = () => {
        if (!live || !iframe.current) return;
        if (binding.current) { binding.current.dispose(); binding.current = null; owner.close(nodeId); setError(t("The page navigated away. Reload it to reconnect.")); return; }
        binding.current = bindVisualizeIframe({ window, iframe: iframe.current, ...identity, dispatch, close: () => undefined, onDismiss: () => { if (latest.current.expanded) latest.current.onDismiss?.(); }, onZoom: gesture => {
          const frame = iframe.current;
          if (!frame || latest.current.expanded || !visibleRef.current) return;
          const rect = frame.getBoundingClientRect();
          if (!frame.offsetWidth || !frame.offsetHeight) return;
          // CSS zoom expresses native pixel wheel deltas in logical page units.
          const renderScale = box.current ? Number(getComputedStyle(box.current).zoom) || 1 : 1;
          // Dispatch on the host iframe so Canvas uses its existing pointer
          // anchor, platform sensitivity, gesture guards and zoom limits.
          frame.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
            clientX: rect.left + (frame.clientLeft + gesture.x * frame.clientWidth) * rect.width / frame.offsetWidth,
            clientY: rect.top + (frame.clientTop + gesture.y * frame.clientHeight) * rect.height / frame.offsetHeight,
            deltaY: gesture.deltaY * (gesture.deltaMode === 0 ? renderScale : 1), deltaMode: gesture.deltaMode, ctrlKey: gesture.ctrlKey, metaKey: gesture.metaKey,
          }));
        } });
        pushCapabilities.current(); pushVisibility.current(); setFrameLoaded(true); finishRefresh();
      };
      pushVisibility.current = () => iframe.current?.contentWindow?.postMessage({ channel: 'openworkgraph.visualize.visibility', sessionId: identity.sessionId, nodeId, active: visibleRef.current }, '*');
      if (!live) return;
      releaseAssets.push(bindVisualizeAssetTransport(window, () => iframe.current, identity, binaryAssets));
      setDocument(html);
      connectionRetries.current = 0;
    })().catch(reason => {
      if (!live) return;
      finishRefresh();
      const message = messageOf(reason);
      const connectionPending = !latest.current.online || ['OFFLINE', 'NETWORK_ERROR', 'SERVICE_UNAVAILABLE'].includes(errorCode(reason)) || message === t('The Workspace is offline or reconciling its snapshot. Editing, uploading, and running are unavailable.');
      if (connectionPending) { setError(''); setWaitingForConnection(true); }
      else setError(message);
    });
    return () => { live = false; for (const release of releaseAssets) release(); binding.current?.dispose(); binding.current = null; attach.current = () => undefined; pushCapabilities.current = () => undefined; pushVisibility.current = () => undefined; };
  }, [entered, props.owner, props.nodeId, props.pageRevision, props.theme, props.locale, props.temporary, retry, t]);
  useEffect(() => {
    if (visible && awaitingViewport) setRetry(value => value + 1);
  }, [visible, awaitingViewport]);
  useEffect(() => {
    pushVisibility.current();
    if (!visible || !document || !props.online || props.temporary) return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const entry = activeEntry.current;
      try { if (live && visibleRef.current && entry?.context) {
        const bridge = await entry.bridge;
        if (!live) return;
        const response = await props.owner.dispatch(entry, { channel: 'openworkgraph.visualize', version: 1, sessionId: bridge.sessionId, nodeId: props.nodeId, requestId: randomId(), type: 'request', method: 'readInputs', expected: { ...entry.context.revisions }, params: { refresh: false } });
        if (live && response.ok) setChanged((response.result as { inputsChanged: boolean }).inputsChanged);
      } } catch { /* Retry only while visible. */ }
      if (live) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => { live = false; clearTimeout(timer); };
  }, [visible, document, props.online, props.temporary, props.owner, props.nodeId]);
  useEffect(() => {
    if (!visible || !waitingForConnection || !props.online || props.temporary) return;
    const timer = setTimeout(() => setRetry(value => value + 1), Math.min(5000, 300 * 2 ** Math.min(connectionRetries.current++, 4)));
    return () => clearTimeout(timer);
  }, [visible, waitingForConnection, props.online, props.temporary, retry]);
  useEffect(() => {
    let live = true;
    pushCapabilities.current();
    const entry = activeEntry.current;
    if (visible && props.online && !props.readOnly && !props.temporary && entry?.context) {
      void entry.bridge.then(bridge => props.owner.dispatch(entry, { channel: "openworkgraph.visualize", version: 1, sessionId: bridge.sessionId, nodeId: props.nodeId, requestId: randomId(), type: "request", method: "initialize", expected: { ...entry.context!.revisions }, params: {} })).then(response => {
        if (!live) return;
        if (response.ok) pushCapabilities.current();
        else if (response.error.code === "SESSION_EXPIRED") setError(response.error.message);
      }).catch(reason => { if (live) setNotice(messageOf(reason)); });
    }
    return () => { live = false; };
  }, [visible, props.online, props.readOnly, document, props.owner, props.nodeId, props.temporary]);
  const reload = () => {
    if (refreshPending.current || (!props.online && !props.temporary)) return;
    clearTimeout(refreshUnlockTimer.current); refreshUnlockTimer.current = undefined;
    refreshPending.current = true; setRefreshing(true); setRefreshLocked(true); setSpinCycles(undefined);
    setSpinning(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // A new session captures the latest inputs and reloads the saved page/form/state.
    props.owner.close(props.nodeId); activeEntry.current = undefined;
    setRetry(value => value + 1);
  };
  return <div ref={box} className={"ow-visualize-node" + (props.expanded ? " ow-visualize-expanded" : "")} data-visualize-active={visible} data-canvas-interactive={empty ? undefined : true}>
    {empty ? <button type="button" onClick={props.onOpenPrompt}>{t("Open prompt to generate an interactive page")}</button> : <>
      <div className="ow-visualize-status" role="status">
        <span className="ow-visualize-status-message" data-canvas-draggable={props.expanded ? undefined : true}>
          {!props.online ? t("Workspace disconnected · Saved page remains visible") : props.readOnly ? t("Read-only") : refreshing ? t("Refreshing page…") : notice || t("Interactive page")}
          {props.temporary && <span>{t("Connect a Workspace to use page inputs and save changes.")}</span>}
          {changed && <span>{t("Predecessor inputs changed")}</span>}
        </span>
        <button className="ow-visualize-refresh-page" type="button" aria-label={t("Refresh page")} title={t("Refresh the page and accept the latest inputs")} aria-busy={refreshLocked} disabled={refreshLocked || (!props.online && !props.temporary)} onClick={reload}>
          <RefreshCw ref={refreshIcon} size={18} strokeWidth={1.75} aria-hidden="true" className={spinning ? "is-spinning" : undefined} style={spinCycles === undefined ? undefined : { animationIterationCount: spinCycles }} onAnimationEnd={stopRefreshAnimation}/>
        </button>
      </div>
      {error ? <div role="alert">{error}<button type="button" disabled={refreshLocked || (!props.online && !props.temporary)} onClick={reload}>{t("Reload page")}</button></div> : document && (visible || frameLoaded) ? <iframe ref={iframe} title={t("Interactive page")} tabIndex={0} sandbox={VISUALIZE_HTML_SANDBOX} allow={VISUALIZE_HTML_PERMISSIONS} referrerPolicy="no-referrer" srcDoc={document} onLoad={() => attach.current()}/> : <p role="status">{t("Loading interactive page…")}</p>}
    </>}
  </div>;
}
