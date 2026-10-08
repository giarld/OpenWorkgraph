import { MarkdownPreview } from "../real/MarkdownPreview";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowDown, ChevronRight, File } from "lucide-react";
import { forwardRef, type ReactNode, type UIEventHandler } from "react";
import type {
  AssetRef,
  Run,
  WorkgraphAdapter,
} from "../domain/types";
import {
  getNodeDefinition,
  getNodeRegistryVersion,
  subscribeNodeRegistry,
  type NodeContentProps,
} from "./node-registry";
import "./content.css";
import { useI18n } from "../i18n/I18nProvider";
import type { Request } from "../real/contracts";
export type { NodeContentProps } from "./node-registry";

export function AssetPreviewContent({
  assetRef,
  adapter,
  kind,
  title,
  onError,
}: {
  assetRef: AssetRef;
  adapter: WorkgraphAdapter;
  kind: string;
  title: string;
  onError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ key: string; url: string }>();
  const [failed, setFailed] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const key = JSON.stringify([
    assetRef.serviceId,
    assetRef.assetId,
    assetRef.versionId,
  ]);
  useEffect(() => {
    setFailed(false);
    let release: (() => void) | undefined;
    try {
      const acquired = adapter.acquireAssetPreview({
        serviceId: assetRef.serviceId,
        assetId: assetRef.assetId,
        versionId: assetRef.versionId,
      });
      release = () => acquired.release();
      setPreview({ key, url: acquired.url });
    } catch (error) {
      setFailed(true);
      errorRef.current(error);
    }
    return () => release?.();
  }, [adapter, assetRef.serviceId, assetRef.assetId, assetRef.versionId, key]);
  const url = preview?.key === key ? preview.url : undefined;
  if (failed)
    return (
      <p className="muted" role="status">
        {t("Unable to preview this media. Check the asset or file format.")}
      </p>
    );
  if (!url) return <p className="muted">{t("Loading preview…")}</p>;
  const mediaError = () => {
    setFailed(true);
    errorRef.current(new Error(t("Unable to load media: {title}", { title })));
  };
  return (
    <div className="media-content">
      {kind === "image" ? (
        <img src={url} alt={title} draggable={false} onContextMenu={e => e.preventDefault()} onError={mediaError} />
      ) : kind === "video" ? (
        <video
          data-canvas-interactive
          src={url}
          controls
          preload="metadata"
          aria-label={title}
          onError={mediaError}
        />
      ) : (
        <audio
          data-canvas-interactive
          src={url}
          controls
          preload="metadata"
          aria-label={title}
          onError={mediaError}
        />
      )}
    </div>
  );
}

const failedRunStatuses = new Set(["failed", "cancelled", "interrupted"]);
const completedRunStatuses = new Set(["succeeded", ...failedRunStatuses]);

export const RunProcessList = forwardRef<HTMLDivElement, {
  items: string[];
  status: string;
  className?: string;
  ariaLabel: string;
  live?: boolean;
  collapseLongItems?: boolean;
  canvasDraggable?: boolean;
  children?: ReactNode;
  onScroll?: UIEventHandler<HTMLDivElement>;
}>(function RunProcessList({ items, status, className = "", ariaLabel, live = false, collapseLongItems = false, canvasDraggable = false, onScroll, children }, ref) {
  return <div className={(className + " run-process-list").trim()} data-canvas-interactive data-canvas-draggable={canvasDraggable ? "" : undefined} ref={ref} tabIndex={0} role="log" aria-label={ariaLabel} aria-live={live ? "polite" : "off"} onScroll={onScroll}>
    {items.map((text, index) => {
      const last = index === items.length - 1;
      const state = last && !completedRunStatuses.has(status) ? "running" : last && failedRunStatuses.has(status) ? "failed" : "succeeded";
      return <div className="run-process-row" data-process-state={state} data-process-last={last ? 'true' : undefined} key={index}><span className="run-process-marker" aria-hidden="true"/><RunProcessText text={text} collapsible={collapseLongItems}/></div>;
    })}
    {children}
  </div>;
});

function RunProcessText({ text, collapsible }: { text: string; collapsible: boolean }) {
  const { t } = useI18n();
  const contentId = useId();
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(() => collapsible && (text.length > 180 || text.split('\n').length > 6));

  useEffect(() => setExpanded(false), [text]);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!collapsible || !element) {
      setOverflowing(false);
      return;
    }
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      const collapsedHeight = (Number.isFinite(lineHeight) ? lineHeight : 21) * 6;
      setOverflowing(current => {
        const next = element.scrollHeight > collapsedHeight + 1;
        return current === next ? current : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [collapsible, text]);

  const canToggle = collapsible && overflowing;
  return <div className="run-process-content">
    <p id={contentId} ref={contentRef} className="run-process-text" data-collapsed={canToggle && !expanded ? 'true' : undefined}>{text}</p>
    {canToggle && <button type="button" className="run-process-toggle" aria-controls={contentId} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('Collapse full text') : t('Expand full text')}</button>}
  </div>;
}

function SubmittedPrompt({ text }: { text: string }) {
  const { t } = useI18n();
  const contentId = useId();
  const copyRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(() => text.split('\n').length > 2);

  useEffect(() => setExpanded(false), [text]);
  useLayoutEffect(() => {
    const copy = copyRef.current;
    const measure = measureRef.current;
    if (!copy || !measure) return;
    const update = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(measure).lineHeight);
      const next = measure.scrollHeight > (Number.isFinite(lineHeight) ? lineHeight : 21) * 2 + 1;
      setOverflowing(current => current === next ? current : next);
      if (!next) setExpanded(false);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(copy);
    return () => observer?.disconnect();
  }, [text]);

  return <div className="execution-submitted-prompt" data-expandable={overflowing ? 'true' : 'false'}>
    {overflowing && <button type="button" data-canvas-interactive className="execution-submitted-prompt-toggle" aria-label={expanded ? t('Collapse submitted prompt') : t('Expand submitted prompt')} aria-controls={contentId} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronRight size={14} aria-hidden="true" /></button>}
    <div className="execution-submitted-prompt-copy" ref={copyRef}>
      <p id={contentId} className="execution-submitted-prompt-text" data-expanded={expanded ? 'true' : undefined}>{text}</p>
      <p ref={measureRef} className="execution-submitted-prompt-measure" aria-hidden="true">{text}</p>
    </div>
  </div>;
}

export function RunSummary({
  run,
  node,
  interaction,
}: Pick<NodeContentProps, "node"> & { run?: { status: string; summaries: string[]; error?: string; prompt?: string }; statusLabel?: string; interaction?: ReactNode }) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const submittedPrompt = run ? (run.prompt ?? node.prompt).trim() : "";
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new MutationObserver(() => {
      if (following) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [following, run?.status]);
  useLayoutEffect(() => {
    if (following && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [following, run?.summaries.length, run?.status]);
  return (
    <div className="execution-content">
      {run && submittedPrompt && <SubmittedPrompt text={submittedPrompt} />}
      {run ? (
        <div className={`execution-process-wrap${submittedPrompt ? " has-submitted-prompt" : ""}`}>
          <RunProcessList
            className="run-summaries"
            ref={list}
            ariaLabel={t("Execution progress")}
            live={following}
            canvasDraggable
            status={run.status}
            items={run.summaries.length ? run.summaries : [t("Live progress will appear here after the run starts.")]}
            onScroll={(event) => {
              const element = event.currentTarget;
              setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
            }}
          >{interaction}</RunProcessList>
          {!following && <button className="execution-process-jump" type="button" data-canvas-interactive aria-label={t("Jump to latest execution progress")} title={t("Jump to latest execution progress")} onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}><ArrowDown size={18} aria-hidden="true" /></button>}
        </div>
      ) : (
        <p className="muted">
          {node.prompt.trim()
            ? t("The prompt is ready. Open the execution panel to run it.")
            : t("Enter a prompt to start, or connect content nodes as references.")}
        </p>
      )}
      {run?.error && (
        <p className="muted" role="status">
          {run.error}
        </p>
      )}
    </div>
  );
}

export function TextContent({ node, onChange, onError, allowNodeOpenOnDoubleClick = false }: Pick<NodeContentProps, "node" | "onError"> & { onChange: (value: string) => void; allowNodeOpenOnDoubleClick?: boolean }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!editor.current) return;
    const input = editor.current;
    if (editing) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    // Caret placement must not change the preview's initial reading position.
    input.scrollTop = 0;
    input.scrollLeft = 0;
  }, [editing]);
  return (
    <div
      className={"node-text-container" + (editing ? " editing" : "")}
      title={editing ? undefined : allowNodeOpenOnDoubleClick ? t("Click to select and drag; double-click to view content") : t("Click to select and drag; double-click to edit text")}
      onDoubleClick={(event) => {
        if (allowNodeOpenOnDoubleClick) return;
        event.stopPropagation();
        if (!node.readonly) setEditing(true);
      }}
    >
      <textarea
        ref={editor}
        data-canvas-text-editor
        className="node-text"
        data-canvas-interactive={editing || undefined}
        aria-label={t("{title} body", { title: node.title })}
        value={node.content}
        readOnly={node.readonly || !editing}
        tabIndex={editing ? 0 : -1}
        onBlur={() => setEditing(false)}
        onFocus={() => {
          if (!node.readonly) setEditing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            editor.current?.blur();
          }
        }}
        placeholder={t("Enter text…")}
        onChange={(event) => {
          if (node.readonly) return;
          try {
            onChange(event.target.value);
          } catch (error) {
            onError(error);
          }
        }}
      />
    </div>
  );
}

export function ContentPlaceholder({ node }: Pick<NodeContentProps, "node">) {
  const { t } = useI18n();
  return (
    <div className={node.type === "image" ? "unknown-node image-placeholder" : "unknown-node"}>
      <File size={28} />
      {node.type !== "image" && <strong>{node.title}</strong>}
      <p className="muted">
        {["image", "video", "audio"].includes(node.type)
          ? t("No media asset is linked")
          : t("Preview is not supported for this type: {type}", { type: node.type })}
      </p>
      {node.assetRef && (
        <span className="muted">{t("Asset version: {version}", { version: node.assetRef.versionId })}</span>
      )}
    </div>
  );
}

export function DocumentCard({ node, onOpenLink, imageRequest, imageRevision }: Pick<NodeContentProps, "node"> & { onOpenLink?: (href: string, sourcePath?: string) => void; imageRequest?: Request; imageRevision?: number }) {
  return <MarkdownPreview className="document-card" text={node.content || node.summary || node.title} onOpenLink={onOpenLink} imageRequest={imageRequest} projectId={node.projectId} imageRevision={imageRevision} />;
}

export function NodeContent(props: NodeContentProps) {
  useSyncExternalStore(
    subscribeNodeRegistry,
    getNodeRegistryVersion,
    getNodeRegistryVersion,
  );
  const { node, adapter, run, onOpen, onError } = props;
  const definition = getNodeDefinition(node.type);
  const CustomContent = definition.Content;
  return (
    <div className="node-content">
      {CustomContent ? (
        <CustomContent {...props} />
      ) : node.type === "text" ? (
        <TextContent key={node.id} {...props} onChange={(content) => adapter.updateNode(node.graphId, node.id, { content })} />
      ) : node.type === "execution" ? (
        <RunSummary
          key={run?.id ?? node.id}
          node={node}
          run={
            run?.nodeId === node.id &&
            run.graphId === node.graphId &&
            run.serviceId === node.serviceId
              ? { ...run, prompt: run.inputSnapshot.prompt }
              : undefined
          }
        />
      ) : node.type === "document" ? (
        <DocumentCard node={node}/>
      ) : ["image", "video", "audio"].includes(node.type) && node.assetRef ? (
        <AssetPreviewContent
          assetRef={node.assetRef}
          adapter={adapter}
          kind={node.type}
          title={node.title}
          onError={onError}
        />
      ) : (
        <ContentPlaceholder node={node} />
      )}
    </div>
  );
}

export default NodeContent;
