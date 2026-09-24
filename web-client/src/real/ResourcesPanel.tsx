import { randomId } from "../adapter/random";
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronDown, ChevronLeft, ChevronRight, File, FileText, Image, MoreHorizontal, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import './ResourcesPanel.css';
import type { Point } from '../canvas/geometry';
import { beginAssetDrag } from './asset-drag';
import { isLifecycleCancellation } from '../adapter/transport';
import { fileMime, PROJECT_FILE_PREVIEW_MAX_BYTES } from '../domain/file-types';
import { cachedImageBlob } from './image-preview-cache';
import { useI18n } from '../i18n/I18nProvider';

export type ResourceRequest = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export interface CanvasCreated { resource: { id: string; name: string; current: { version: number; mime: string; bytes: number } }; referenceId: string }
export interface LibraryAsset { id: string; projectId: string; name: string; deleted: boolean; shared: boolean; current: { version: number; mime: string; bytes: number } }
export interface ResourcePlacement { complete: (created: CanvasCreated) => Promise<void>; fail: (error: unknown) => Promise<void> }
export interface ResourcesPanelProps { ready?: boolean; refreshToken?: number; request: ResourceRequest; projectId: string; ownerProjectId?: string; projects?: { projectId: string; name: string; state: string }[]; graphId: string; readOnly: boolean; onPlace: (asset: LibraryAsset, position?: Point) => ResourcePlacement; onError: (e: unknown) => void }
type UploadStatus = { uploadId: string; received: number; bytes: number; state: string };
type Target = { mode: 'new'; name: string } | { mode: 'update'; name: string; assetId: string; expectedVersion: number } | { mode: 'canvas'; name: string; graphId: string };
const projectPath = (id: string) => '/v1/projects/' + encodeURIComponent(id);
const key = () => randomId();
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const CHUNK = 1024 * 1024;
export function isConfirmedResourceConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 409 && 'code' in error && error.code === 'REVISION_CONFLICT';
}
type ResourceOperation = { label: string; run: () => Promise<void>; canEnd?: () => boolean; refreshOnSuccess?: boolean };

/** Retains original request bodies and keys after ALL failures, including an
 * unknown commit result. Retry this job; never substitute a new finish key. */
export function createResourceUpload(request: ResourceRequest, projectId: string, file: File, target: Target) {
  const base = projectPath(projectId) + '/uploads';
  const start = { name: file.name, mime: fileMime(file), bytes: file.size, idempotencyKey: key() };
  const finish = { ...target, idempotencyKey: key() };
  let status: UploadStatus | undefined;
  let chunk: { data: string; offset: number; idempotencyKey: string } | undefined;
  let finishing = false;
  let result: LibraryAsset | CanvasCreated | undefined;
  let running: Promise<LibraryAsset | CanvasCreated> | undefined;
  let confirmedConflict = false;
  async function run(onProgress?: (percent: number) => void) {
    confirmedConflict = false;
    if (result) return result;
    status ??= await request<UploadStatus>(base, start);
    // A finished upload must be replayed before checking its state.
    if (!finishing) {
      if (chunk) { status = await request<UploadStatus>(base + '/' + status.uploadId + '/chunks', chunk); chunk = undefined; }
      status = await request<UploadStatus>(base + '/' + status.uploadId);
      if (status.state !== 'uploading' || status.received < 0 || status.received > file.size || status.bytes !== file.size) throw new Error('Upload state mismatch; a replacement submission cannot be created automatically.');
      onProgress?.(file.size ? status.received / file.size * 100 : 0);
      while (status.received < file.size) {
        const bytes = new Uint8Array(await file.slice(status.received, status.received + CHUNK).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        chunk = { offset: status.received, data: btoa(binary), idempotencyKey: key() };
        status = await request<UploadStatus>(base + '/' + status.uploadId + '/chunks', chunk);
        chunk = undefined;
        onProgress?.(status.received / file.size * 100);
      }
      finishing = true;
    }
    try { result = await request<LibraryAsset | CanvasCreated>(base + '/' + status.uploadId + '/finish', finish); }
    catch (error) { confirmedConflict = isConfirmedResourceConflict(error); throw error; }
    onProgress?.(100);
    return result;
  }
  return { canEndAttempt: () => confirmedConflict, run(onProgress?: (percent: number) => void) {
    if (!running) running = run(onProgress).finally(() => { running = undefined; });
    return running;
  } };
}

// Same request + File + scope resumes a failed upload. The transport must own
// connection epochs and reject stale responses; no credentials are stored here.
const canvasJobs = new WeakMap<ResourceRequest, WeakMap<File, Map<string, ReturnType<typeof createResourceUpload>>>>();
export async function uploadCanvas(request: ResourceRequest, projectId: string, graphId: string, file: File, onProgress?: (percent: number) => void): Promise<CanvasCreated> {
  let files = canvasJobs.get(request);
  if (!files) { files = new WeakMap(); canvasJobs.set(request, files); }
  let scopes = files.get(file);
  if (!scopes) { scopes = new Map(); files.set(file, scopes); }
  const scope = JSON.stringify([projectId, graphId]);
  let job = scopes.get(scope);
  if (!job) { job = createResourceUpload(request, projectId, file, { mode: 'canvas', name: file.name, graphId }); scopes.set(scope, job); }
  const created = await job.run(onProgress) as CanvasCreated;
  scopes.delete(scope);
  return created;
}

const media = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm']);
const imageExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
function imageDownloadName(name: string, mime?: string): string {
  const safeName = name.replaceAll(/[\\/]/g, '_');
  const extension = mime && imageExtensions[mime];
  if (!extension) return safeName;
  const existing = /\.(png|jpe?g|gif|webp|svg)$/i.exec(safeName);
  if (existing?.[1].toLowerCase() === extension || (mime === 'image/jpeg' && existing && /^jpe?g$/i.test(existing[1]))) return safeName;
  return (existing ? safeName.slice(0, -existing[0].length) : safeName) + '.' + extension;
}
export interface CanvasResourcePreviewProps { request: ResourceRequest; projectId: string; graphId: string; resourceId: string; version: number; mime?: string; name?: string; imageNode?: boolean; onError: (e: unknown) => void }
export function CanvasResourcePreview({ request, projectId, graphId, resourceId, version, mime, name, imageNode = false, onError }: CanvasResourcePreviewProps) {
  const { t } = useI18n();
  return <ResourcePreview request={request} path={projectPath(projectId) + '/graphs/' + encodeURIComponent(graphId) + '/resources/' + encodeURIComponent(resourceId) + '/versions/' + version} mime={mime} name={name ?? t('Resource')} imageNode={imageNode} onError={onError} />;
}
export function CanvasProjectFilePreview({ request, projectId, relativePath, mime, name, imageNode = false, onError, missingMessage }: { request: ResourceRequest; projectId: string; relativePath: string; mime: string; name: string; imageNode?: boolean; onError: (e: unknown) => void; missingMessage?: string }) {
  const { t } = useI18n();
  const [thumbnailSize, setThumbnailSize] = useState(320);
  const projectRequest = useCallback(async <T,>(path: string, _body?: unknown, method?: string): Promise<T> => {
    const load = async (kind: 'thumbnail' | 'media' | 'content') => {
      const [observation] = await request<Array<{ state: 'available' | 'missing' | 'unavailable'; bytes: number | null; changeToken: string | null }>>(projectPath(projectId) + '/files/stat', { paths: [relativePath] }, 'POST');
      if (!observation || observation.state !== 'available') throw new Error(observation?.state === 'missing' ? missingMessage ?? t('The project file no longer exists; the reference is retained.') : t('The project file is currently unavailable.'));
      if (typeof observation.bytes === 'number' && observation.bytes > PROJECT_FILE_PREVIEW_MAX_BYTES) throw new Error(t('Files larger than 50 MiB cannot be previewed.'));
      const query = new URLSearchParams({ path: relativePath, ...(observation.changeToken ? { cacheKey: observation.changeToken } : {}), ...(kind === 'thumbnail' ? { size: String(thumbnailSize) } : {}) });
      if (kind === 'content') {
        const result = await request<{ base64: string }>(projectPath(projectId) + '/files/content?' + query);
        const bytes = Uint8Array.from(atob(result.base64), character => character.charCodeAt(0));
        return new Blob([bytes], { type: mime || 'application/octet-stream' });
      }
      return request<Blob>(projectPath(projectId) + '/files/' + kind + '?' + query, undefined, 'BLOB');
    };
    if (method === 'BLOB') {
      const action = path.split('?')[0]?.split('/').at(-1);
      return await load(action === 'thumbnail' ? 'thumbnail' : action === 'content' ? 'media' : 'content') as T;
    }
    if (path.endsWith('/representation')) return { state: 'ready', text: await (await load('content')).text(), reason: null } as T;
    return { mime } as T;
  }, [request, projectId, relativePath, mime, thumbnailSize, t, missingMessage]);
  return <ResourcePreview request={projectRequest} path={'project-file:' + relativePath} mime={mime} name={name} imageNode={imageNode} cacheImages={false} thumbnailSize={thumbnailSize} onThumbnailSize={setThumbnailSize} onError={onError}/>;
}
const THUMBNAIL_LEVELS = [320, 640, 1280, 2560, 4096] as const;
function ResourcePreview({ request, path, mime, name, imageNode, cacheImages = true, thumbnailSize: suppliedThumbnailSize, onThumbnailSize, onError }: { request: ResourceRequest; path: string; mime?: string; name: string; imageNode?: boolean; cacheImages?: boolean; thumbnailSize?: number; onThumbnailSize?: (size: number) => void; onError: (e: unknown) => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ path: string; mime?: string; url?: string; text?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState(suppliedThumbnailSize ?? 320);
  const [originalUrl, setOriginalUrl] = useState<string>();
  const originalTransientUrl = useRef<string | undefined>(undefined);
  const downloadEpoch = useRef(0);
  const downloadUrls = useRef(new Set<string>());
  const dialog = useRef<HTMLElement>(null);
  const imageButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const errors = useRef(onError); errors.current = onError;
  const current = state?.path === path ? state : undefined;
  const setSelectedThumbnailSize = useCallback((size: number) => {
    setThumbnailSize(size);
    onThumbnailSize?.(size);
  }, [onThumbnailSize]);
  useEffect(() => {
    if (!imageNode) return;
    const update = () => {
      const rect = imageButton.current?.getBoundingClientRect();
      if (!rect) return;
      const target = Math.ceil(Math.max(rect.width, rect.height) * Math.max(window.devicePixelRatio || 1, 1));
      const next = THUMBNAIL_LEVELS.find(level => level >= target) ?? THUMBNAIL_LEVELS.at(-1)!;
      if (next !== thumbnailSize) setSelectedThumbnailSize(next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (observer && imageButton.current) observer.observe(imageButton.current);
    const world = imageButton.current?.closest<HTMLElement>('.owg-world');
    const viewportObserver = typeof MutationObserver === 'undefined' || !world ? undefined : new MutationObserver(update);
    viewportObserver?.observe(world!, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); viewportObserver?.disconnect(); window.removeEventListener('resize', update); };
  }, [imageNode, current?.url, thumbnailSize, setSelectedThumbnailSize]);
  useEffect(() => {
    downloadEpoch.current++;
    setDownloading(false);
    setExpanded(false);
    setOriginalUrl(undefined);
    return () => {
      downloadEpoch.current++;
      if (originalTransientUrl.current) { URL.revokeObjectURL(originalTransientUrl.current); originalTransientUrl.current = undefined; }
      for (const url of downloadUrls.current) URL.revokeObjectURL(url);
      downloadUrls.current.clear();
    };
  }, [request, path]);
  useEffect(() => {
    if (!expanded) return;
    if (!imageNode || !current?.url) return;
    let active = true;
    if (originalTransientUrl.current) { URL.revokeObjectURL(originalTransientUrl.current); originalTransientUrl.current = undefined; }
    setOriginalUrl(undefined);
    const load = request<Blob>(path + '/content', undefined, 'BLOB');
    void load.then(blob => {
      const url = URL.createObjectURL(blob);
      if (active) {
        originalTransientUrl.current = url;
        setOriginalUrl(url);
      } else URL.revokeObjectURL(url);
    }).catch(e => { if (active) errors.current(e); });
    dialog.current?.focus();
    return () => {
      active = false;
      if (originalTransientUrl.current) { URL.revokeObjectURL(originalTransientUrl.current); originalTransientUrl.current = undefined; }
      if (imageButton.current?.isConnected) imageButton.current.focus();
    };
  }, [expanded, imageNode, current?.url, request, path, cacheImages]);
  async function download() {
    if (downloading) return;
    const epoch = downloadEpoch.current;
    setDownloading(true);
    try {
      const blob = await request<Blob>(path + '/content', undefined, 'BLOB');
      if (epoch !== downloadEpoch.current) return;
      // Never navigate to executable HTML/SVG. Force an attachment even if the
      // original content type is active, and do not expose the URL as a link.
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      downloadUrls.current.add(url);
      const downloadMime = imageExtensions[blob.type] ? blob.type : current?.mime ?? mime;
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = imageNode ? imageDownloadName(name, downloadMime) : name.replaceAll('/', '_');
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { if (downloadUrls.current.delete(url)) URL.revokeObjectURL(url); }, 1000);
    } catch (e) { if (epoch === downloadEpoch.current) { if (!imageNode) setState({ path, error: message(e) }); errors.current(e); } }
    finally { if (epoch === downloadEpoch.current) setDownloading(false); }
  }
  useEffect(() => {
    let active = true;
    let transientUrl: string | undefined;
    // Keep the currently displayed thumbnail while a higher or lower mip level
    // is loading. Clear it only when the image source itself changes.
    setState(previous => previous?.path === path ? previous : undefined);
    setOriginalUrl(undefined);
    void (async () => {
      const resolvedMime = mime ?? (await request<{ mime: string }>(path)).mime;
      if (!active) return;
      if (media.has(resolvedMime)) {
        const thumbnailPath = path + '/thumbnail?size=' + thumbnailSize;
        const previewPath = path + '/preview';
        const mediaPath = imageNode ? thumbnailPath : previewPath;
        const blob = imageNode && cacheImages ? await cachedImageBlob(request, mediaPath) : await request<Blob>(mediaPath, undefined, 'BLOB');
        const url = URL.createObjectURL(blob);
        transientUrl = url;
        if (!active) { URL.revokeObjectURL(url); transientUrl = undefined; return; }
        setState({ path, mime: imageNode ? 'image/webp' : resolvedMime, url });
      } else {
        const representation = await request<{ state: string; text: string | null; reason: string | null }>(path + '/representation');
        if (active) setState({ path, text: representation.state === 'ready' ? representation.text ?? '' : representation.reason ?? t('Preview is not supported for this format yet.') });
      }
    })().catch(e => { if (active) { setState({ path, error: message(e) }); errors.current(e); } });
    return () => { active = false; if (transientUrl) URL.revokeObjectURL(transientUrl); };
  }, [request, path, mime, imageNode, cacheImages, retry, thumbnailSize, t]);
  const expandable = imageNode && current?.url && current.mime?.startsWith('image/');
  return <div className={'ow-resource-preview' + (imageNode ? ' ow-image-node-preview' : '')} aria-label={t('{name} preview', { name })}>
    {!current && <p role="status">{t('Loading preview…')}</p>}
    {current?.error && <div role="status">{t('Could not load preview: {error}', { error: current.error })}<button onClick={() => setRetry(v => v + 1)}>{t('Retry preview')}</button></div>}
    {current?.url && (current.mime?.startsWith('video/') ? <video src={current.url} controls preload="metadata" aria-label={name} /> : expandable ? <button ref={imageButton} className="ow-image-expand" data-canvas-interactive data-canvas-draggable type="button" aria-label={t('Enlarge {name}', { name })} title={t('Double-click to enlarge image')} onContextMenu={e => e.preventDefault()} onClick={e => { if (e.detail === 0) setExpanded(true); }} onDoubleClick={() => setExpanded(true)}><img src={current.url} alt={name} draggable={false} onContextMenu={e => e.preventDefault()} /></button> : <img src={current.url} alt={name} draggable={false} onContextMenu={e => e.preventDefault()} />)}
    {current?.text !== undefined && <pre>{current.text}</pre>}
    {!imageNode && <button disabled={downloading} onClick={() => void download()}>{downloading ? t('Downloading…') : t('Download original file')}</button>}
    {expanded && current?.url && createPortal(<div className="modal-backdrop ow-image-backdrop" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpanded(false); }}><section className="ow-image-dialog panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} onClick={e => e.stopPropagation()} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.code === 'Space' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)) { e.preventDefault(); setExpanded(false); }
      if (e.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus(); }
      }
    }}><header><h2 id={titleId}>{name}</h2><button type="button" aria-label={t('Close image preview')} onClick={() => setExpanded(false)}>{t('Close')}</button></header>{originalUrl ? <img src={originalUrl} alt={name} draggable={false} onContextMenu={e => e.stopPropagation()} /> : <p role="status">{t('Reading original image…')}</p>}<footer><button type="button" disabled={downloading} onClick={() => { void download(); }}>{downloading ? t('Downloading…') : t('Download original file')}</button></footer></section></div>, document.body)}
  </div>;
}

function AssetThumbnail({ request, path, name, onPreview }: { request: ResourceRequest; path: string; name: string; onPreview: () => void }) {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const objectUrl = useRef<string | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<number>(THUMBNAIL_LEVELS[0]);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const update = () => {
      const bounds = button.current?.getBoundingClientRect();
      if (!bounds) return;
      const pixels = Math.ceil(Math.max(bounds.width, bounds.height) * Math.max(window.devicePixelRatio || 1, 1));
      setSize(THUMBNAIL_LEVELS.find(level => level >= pixels) ?? THUMBNAIL_LEVELS.at(-1)!);
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    update();
    if (button.current) observer.observe(button.current);
    if (button.current) resize?.observe(button.current);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); resize?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setFailed(false);
    void cachedImageBlob(request, path + '/thumbnail?size=' + size).then(blob => {
      const next = URL.createObjectURL(blob);
      if (!active) { URL.revokeObjectURL(next); return; }
      const previous = objectUrl.current;
      objectUrl.current = next;
      setUrl(next);
      if (previous) URL.revokeObjectURL(previous);
    }).catch(() => { if (active && !objectUrl.current) setFailed(true); });
    return () => { active = false; };
  }, [request, path, visible, size]);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  return <button ref={button} type="button" className="ow-assets-thumbnail" aria-label={t('Preview image: {name}', { name })} onClick={onPreview}>
    {url && !failed ? <img src={url} alt={name} draggable={false} decoding="async" onContextMenu={e => e.preventDefault()} onError={() => setFailed(true)} /> : <span><Image size={28} aria-hidden="true" /><small>{failed ? t('Thumbnail unavailable; click to preview') : t('Loading thumbnail…')}</small></span>}
  </button>;
}

function TextThumbnail({ request, path, name, onPreview }: { request: ResourceRequest; path: string; name: string; onPreview: () => void }) {
  const { t } = useI18n();
  const [excerpt, setExcerpt] = useState('');
  useEffect(() => {
    let active = true;
    void request<{ state: string; text: string | null }>(path + '/representation').then(result => {
      if (active && result.state === 'ready') setExcerpt(result.text ?? '');
    }).catch(() => { /* Preview remains available from the asset dialog. */ });
    return () => { active = false; };
  }, [request, path]);
  return <button className="ow-assets-file-preview" onClick={onPreview} aria-label={t('Preview: {name}', { name })}><span>{excerpt || name}</span></button>;
}

function AssetPreviewDialog({ request, path, asset, onClose, onError }: { request: ResourceRequest; path: string; asset: LibraryAsset; onClose: () => void; onError: (e: unknown) => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const titleId = useId();
  useEffect(() => {
    const priorInert = new Map<HTMLElement, boolean>();
    const isolateBackground = () => {
      for (const child of document.body.children) {
        if (!(child instanceof HTMLElement) || child === backdrop.current || child.classList.contains('workgraph-toast-viewport')) continue;
        if (!priorInert.has(child)) priorInert.set(child, child.inert);
        child.inert = true;
      }
    };
    isolateBackground();
    const observer = new MutationObserver(isolateBackground);
    observer.observe(document.body, { childList: true });
    dialog.current?.querySelector<HTMLElement>('button[autofocus]')?.focus();
    return () => {
      observer.disconnect();
      for (const [element, inert] of priorInert) element.inert = inert;
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div ref={backdrop} className="ow-asset-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="ow-asset-preview-dialog" role="dialog" aria-labelledby={titleId} aria-modal="true" onKeyDown={e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.code === 'Space' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); onClose(); return; }
    if (e.key === 'Tab') {
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),video[controls],[tabindex="0"]'));
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  }} onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <header><div><small>{t('Asset preview · v{version}', { version: asset.current.version })}</small><h2 id={titleId}>{asset.name}</h2></div><button type="button" aria-label={t('Close preview')} onClick={onClose} autoFocus><X size={20} aria-hidden="true" /></button></header>
    <ResourcePreview request={request} path={path} mime={asset.current.mime} name={asset.name} onError={onError} />
  </section></div>, document.body);
}

function AssetMenu({ name, open, onToggle, onClose, children }: { name: string; open: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [open, onClose]);
  return <div ref={root} className={'ow-assets-card-menu' + (open ? ' is-open' : '')}>
    <button ref={trigger} type="button" className="ow-assets-menu-trigger" aria-label={t('Asset actions: {name}', { name })} aria-expanded={open} aria-controls={id} onClick={onToggle}><MoreHorizontal size={15} aria-hidden="true" /></button>
    <div id={id} className="ow-assets-card-actions" aria-label={t('Asset actions: {name}', { name })} role="group" inert={!open} aria-hidden={!open} onClick={event => { if ((event.target as Element).closest('button:not(:disabled)')) onClose(); }}>{children}</div>
  </div>;
}

export function ResourcesPanel(props: ResourcesPanelProps) { return <ResourcesPanelScope key={JSON.stringify([props.projectId, props.ownerProjectId ?? props.projectId, props.graphId])} {...props} />; }
function ResourcesPanelScope({ ready = true, refreshToken = 0, request, projectId, ownerProjectId = projectId, projects = [], graphId, readOnly, onPlace, onError }: ResourcesPanelProps) {
  const { t } = useI18n();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [deleted, setDeleted] = useState(false);
  const [scope, setScope] = useState<'project' | 'shared' | 'available'>('project');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openAssetMenu, setOpenAssetMenu] = useState<string>();
  const [trashResult, setTrashResult] = useState('');
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = controls.current; if (!element) return;
    const observer = new ResizeObserver(() => { element.parentElement?.style.setProperty('--asset-controls-height', element.getBoundingClientRect().height + 'px'); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const [uploadProjectId, setUploadProjectId] = useState(ownerProjectId);
  const [uploadShared, setUploadShared] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<LibraryAsset>();
  const [selection, setSelection] = useState<{ file: File; matches: LibraryAsset[]; projectId: string; shared: boolean }>();
  const [choice, setChoice] = useState('');
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState<ResourceOperation>();
  const [canEnd, setCanEnd] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const uploadMenuId = useId();
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  const dragAllowed = useRef(false);
  useEffect(() => () => cancelDrag.current?.(), [request]);
  const uploadMenu = useRef<HTMLDivElement>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const errors = useRef(onError); errors.current = onError;
  const base = projectPath(projectId);
  const viewKey = JSON.stringify([base, ownerProjectId, deleted, scope, search.trim(), page]);
  const currentViewKey = useRef(viewKey); currentViewKey.current = viewKey;
  useEffect(() => {
    if (!uploadOpen) return;
    const close = (event: PointerEvent) => { if (!uploadMenu.current?.contains(event.target as Node)) setUploadOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setUploadOpen(false); uploadTrigger.current?.focus(); } };
    const blur = (event: FocusEvent) => { if (!uploadMenu.current?.contains(event.target as Node)) setUploadOpen(false); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('focusin', blur, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('focusin', blur, true); document.removeEventListener('keydown', escape, true); };
  }, [uploadOpen]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setLoading(true); setAssets([]); setPreview(undefined); setOpenAssetMenu(undefined);
    if (!ready) { setError(''); return () => { active = false; }; }
    void request<LibraryAsset[]>(base + '/assets/query', { deleted, scope, limit: 100, offset: page * 100, ...(search.trim() ? { search: search.trim() } : {}) }).then(items => {
      if (active) { setAssets(items); setError(''); }
    }).catch(e => { if (active && !isLifecycleCancellation(e)) { setError(message(e)); errors.current(e); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, base, deleted, scope, search, page, refresh, refreshToken, ready]);
  function assetMatchesView(asset: LibraryAsset) {
    const query = search.trim().toLocaleLowerCase();
    if (asset.deleted !== deleted || (query && !asset.name.toLocaleLowerCase().includes(query))) return false;
    if (scope === 'project') return asset.projectId === ownerProjectId;
    if (scope === 'shared') return asset.shared && (asset.projectId === ownerProjectId || !asset.deleted);
    return asset.projectId === ownerProjectId || (asset.shared && !asset.deleted);
  }
  function mergeAsset(asset: LibraryAsset, operationViewKey: string) {
    if (currentViewKey.current !== operationViewKey) { setRefresh(value => value + 1); return; }
    setAssets(current => {
      const existing = current.some(item => item.id === asset.id);
      if (!assetMatchesView(asset)) return existing ? current.filter(item => item.id !== asset.id) : current;
      if (!existing && page > 0) return current;
      const next = existing ? current.map(item => item.id === asset.id ? asset : item) : [...current, asset];
      next.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return next.slice(0, 100);
    });
    setPreview(current => current?.id === asset.id ? (assetMatchesView(asset) ? asset : undefined) : current);
  }
  async function execute(operation: ResourceOperation) {
    if (!ready || readOnly || locked.current) return;
    locked.current = true; setBusy(true); setError(''); setPending(operation); setCanEnd(false);
    try { await operation.run(); if (mounted.current) { setPending(undefined); if (operation.refreshOnSuccess) setRefresh(v => v + 1); } }
    catch (e) { if (mounted.current) { setError(message(e)); setCanEnd(operation.canEnd?.() === true); onError(e); } }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function chooseFile(file: File) {
    void execute({ label: t('Check for assets with the same name'), run: async () => {
      const matches = await request<LibraryAsset[]>(projectPath(uploadProjectId) + '/assets/same-name', { name: file.name });
      // The same-name endpoint is already restricted to the target library project.
      // Its real project ID may differ from a browser bridge's routing alias.
      if (mounted.current) { setSelection({ file, matches, projectId: uploadProjectId, shared: uploadShared }); setChoice(''); setUploadOpen(false); }
    } });
  }
  function upload() {
    if (!selection || (selection.matches.length > 0 && !choice)) return;
    const operationViewKey = viewKey;
    const asset = selection.matches.find(a => a.id === choice);
    const target: Target = asset ? { mode: 'update', name: selection.file.name, assetId: asset.id, expectedVersion: asset.current.version } : { mode: 'new', name: selection.file.name };
    const job = createResourceUpload(request, selection.projectId, selection.file, target);
    const shareKey = key();
    void execute({ label: t('Upload file (resume original submission)'), canEnd: job.canEndAttempt, run: async () => {
      let uploaded = await job.run(value => { if (mounted.current) setProgress(value); }) as LibraryAsset;
      if (uploaded.shared !== selection.shared) uploaded = await request<LibraryAsset>(projectPath(selection.projectId) + '/assets/' + encodeURIComponent(uploaded.id) + '/share', { shared: selection.shared, idempotencyKey: shareKey });
      if (mounted.current) { mergeAsset(uploaded, operationViewKey); setSelection(undefined); setUploadOpen(false); }
    } });
  }
  function mutate(asset: LibraryAsset, action: 'delete' | 'restore' | 'copy' | 'share', position?: Point) {
    if (action !== 'copy' && asset.projectId !== ownerProjectId) return;
    const operationViewKey = viewKey;
    const body = action === 'copy' ? { assetId: asset.id, expectedVersion: asset.current.version, idempotencyKey: key() } : action === 'share' ? { shared: !asset.shared, idempotencyKey: key() } : { idempotencyKey: key() };
    let created: CanvasCreated | undefined;
    let placement: ResourcePlacement | undefined;
    let confirmedConflict = false;
    void execute({ label: action === 'copy' ? t('Copy independently to Work Graph') : action === 'delete' ? t('Delete asset') : action === 'share' ? (asset.shared ? t('Stop sharing') : t('Share')) : t('Restore asset'), canEnd: () => confirmedConflict, run: async () => {
      confirmedConflict = false;
      if (action === 'copy') {
        placement ??= onPlace(asset, position);
        try {
          created ??= await request<CanvasCreated>(base + '/graphs/' + encodeURIComponent(graphId) + '/resources/copy-asset', body);
          await placement.complete(created);
        } catch (error) {
          confirmedConflict = isConfirmedResourceConflict(error);
          await placement.fail(error).catch(() => undefined);
          throw error;
        }
      } else {
        const changed = await request<LibraryAsset>(base + '/assets/' + encodeURIComponent(asset.id) + '/' + action, body);
        if (mounted.current) mergeAsset(changed, operationViewKey);
      }
    } });
  }
  function emptyTrash() {
    if (!window.confirm(t('Permanently remove all deleted assets from the current workspace? This applies regardless of search, scope filters, or pagination and cannot be undone. Independent Work Graph copies are unaffected.'))) return;
    const body = { idempotencyKey: key() };
    setTrashResult('');
    void execute({ label: t('Empty trash'), refreshOnSuccess: true, run: async () => {
      const result = await request<{ removed: number; retained: number }>(base + '/assets/empty-trash', body);
      if (mounted.current) { setPage(0); setTrashResult(t('Permanently removed {count} assets.', { count: result.removed }) + (result.retained ? t(' {count} more assets are still referenced by history and were retained.', { count: result.retained }) : '')); }
    } });
  }
  const disabled = !ready || readOnly || busy || !!pending;
  dragAllowed.current = !disabled && !loading;
  const groups = [
    { id: 'images', label: t('Images'), Icon: Image, items: assets.filter(a => a.current.mime.startsWith('image/')) },
    { id: 'texts', label: t('Text'), Icon: FileText, items: assets.filter(a => a.current.mime.startsWith('text/') || a.current.mime === 'application/pdf') },
    { id: 'files', label: t('Other files'), Icon: File, items: assets.filter(a => !a.current.mime.startsWith('image/') && !a.current.mime.startsWith('text/') && a.current.mime !== 'application/pdf') },
  ];
  const availableProjects = projects.filter(p => p.state === 'active');
  return <section className="ow-resources-panel" aria-label={t('Asset library')} aria-busy={busy}>
    <header className="ow-assets-heading"><h2>{t('Asset library')}</h2></header>
    <div className="ow-assets-controls" ref={controls}>
    <div className="ow-assets-toolbar">
      <label className="ow-assets-search"><Search size={15} aria-hidden="true" /><input aria-label={t('Search assets')} placeholder={t('Search assets')} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />{search && <button aria-label={t('Clear name filter')} onClick={() => { setSearch(''); setPage(0); }}><X size={14} /></button>}</label>
      <div className="ow-assets-upload-anchor" ref={uploadMenu}><button ref={uploadTrigger} className="ow-assets-upload-trigger" aria-label={t('Add asset')} aria-controls={uploadMenuId} aria-expanded={uploadOpen} disabled={disabled || !!selection} onClick={() => setUploadOpen(v => !v)}><Plus size={16} />{t('Add')}</button>
        {<div id={uploadMenuId} className={"ow-assets-upload-menu" + (uploadOpen ? " is-open" : "")} inert={!uploadOpen} aria-hidden={!uploadOpen} role="group" aria-label={t('Asset upload settings')}><label>{t('Target workspace')}<select aria-label={t('Target workspace')} value={uploadProjectId} onChange={e => setUploadProjectId(e.target.value)}>{availableProjects.length ? availableProjects.map(p => <option key={p.projectId} value={p.projectId}>{p.name}</option>) : <option value={ownerProjectId}>{t('Current workspace')}</option>}</select></label><label>{t('Sharing scope')}<select aria-label={t('Sharing scope')} value={uploadShared ? 'shared' : 'private'} onChange={e => setUploadShared(e.target.value === 'shared')}><option value="private">{t('Target workspace only')}</option><option value="shared">{t('Shared within Runtime')}</option></select></label><button className="ow-assets-upload" disabled={disabled} onClick={() => uploadInput.current?.click()}><Upload size={15} />{t('Choose file to upload')}</button></div>}
      </div>
    </div>
    <div className="ow-assets-library-settings" role="group" aria-label={t('Asset library management')}><div className="ow-assets-filters"><label>{t('Asset scope')}<select value={scope} onChange={e => { setScope(e.target.value as typeof scope); setPage(0); }}><option value="project">{t('Current workspace')}</option><option value="shared">{t('Shared within Runtime')}</option><option value="available">{t('Current workspace and shared')}</option></select></label><label className="ow-resources-check"><input type="checkbox" checked={deleted} onChange={e => { setDeleted(e.target.checked); setPage(0); }} />{t('Show deleted assets')}</label><button className="ow-assets-icon-button" aria-label={t('Refresh')} disabled={loading || busy} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={16} /></button></div>{deleted && <button className="ow-assets-empty-trash" disabled={disabled || loading} onClick={emptyTrash}><Trash2 size={14} aria-hidden="true" />{t('Empty trash')}</button>}</div>
    </div>
    <input ref={uploadInput} className="ow-assets-file-input" aria-label={t('Upload to asset library')} type="file" disabled={disabled || !!selection} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) chooseFile(file); }} />

    {trashResult && <p role="status">{trashResult}</p>}
    {readOnly && <p role="status">{t('Read-only: assets and previews remain available.')}</p>}
    {selection && <fieldset disabled={disabled}><legend>{t('Upload: {name}', { name: selection.file.name })}</legend><p>{selection.matches.length ? t('An asset with this name exists. Choose explicitly; it will not be overwritten by default.') : t('Create a new asset.')}</p>{selection.matches.length > 0 && <label>{t('Action')}<select value={choice} onChange={e => setChoice(e.target.value)}><option value="">{t('Choose…')}</option><option value="new">{t('Keep both (create new asset)')}</option>{selection.matches.map(a => <option key={a.id} value={a.id}>{t('Update')} {a.name} · v{a.current.version} · {a.id}</option>)}</select></label>}<button disabled={disabled || (selection.matches.length > 0 && !choice)} onClick={upload}>{t('Confirm upload')}</button><button onClick={() => { setSelection(undefined); setProgress(0); }}>{t('Cancel selection')}</button></fieldset>}
    {busy && <div role="status">{pending?.label}…<progress max={100} value={progress} aria-label={t('Upload progress')} /></div>}
    {pending && !busy && <div className="ow-resource-recovery">{canEnd ? <><p>{t('The resource version changed. End this attempt and choose again.')}</p><button disabled={readOnly} onClick={() => { if (locked.current || !pending.canEnd?.()) return; setPending(undefined); setCanEnd(false); setSelection(undefined); setChoice(''); setProgress(0); setError(''); setRefresh(v => v + 1); }}>{t('End this attempt and choose again')}</button></> : <><p>{t('The operation is not confirmed. Retrying will reuse the original submission.')}</p><button disabled={readOnly} onClick={() => void execute(pending)}>{t('Retry: {action}', { action: pending.label })}</button></>}</div>}
    <div className="ow-assets-groups">
      {loading ? <div className="ow-assets-empty" role="status">{ready ? t('Loading assets…') : t('Connecting to Runtime; assets will load automatically when ready…')}</div> : assets.length === 0 ? <div className="ow-assets-empty"><Archive size={24} /><strong>{error ? t('Assets are temporarily unavailable') : t('No matching assets')}</strong><p>{error ? t('Refresh and try again.') : t('No assets match the current filters.')}</p>{!error && <button onClick={() => { setSearch(''); setDeleted(false); setScope('project'); setPage(0); }}>{t('Reset filters')}</button>}</div> : groups.filter(g => g.items.length).map((group, index) => <React.Fragment key={group.id}>
        <button className="ow-assets-group-heading" style={{ top: 'calc(var(--asset-controls-height, 140px) + ' + index * 32 + 'px)' }} aria-expanded={!collapsed[group.id]} onClick={() => setCollapsed(v => ({ ...v, [group.id]: !v[group.id] }))}><ChevronDown size={14} className={collapsed[group.id] ? 'is-collapsed' : ''} /><group.Icon size={15} /><strong>{group.label}</strong><span>{group.items.length}</span></button>
        {!collapsed[group.id] && <ul className="ow-assets-list">{group.items.map(asset => <li key={asset.id} className="ow-assets-card" title={asset.name} draggable={!disabled && !asset.deleted} onDragStart={event => {
            if (!dragAllowed.current || asset.deleted || (event.target as Element).closest('.ow-assets-card-menu, .ow-assets-quick-actions')) { event.preventDefault(); return; }
            cancelDrag.current?.();
            cancelDrag.current = beginAssetDrag(event.dataTransfer, { request, projectId, graphId }, position => { if (dragAllowed.current && mounted.current) mutate(asset, 'copy', position); });
            setOpenAssetMenu(undefined); setUploadOpen(false);
          }} onDragEnd={() => { cancelDrag.current?.(); cancelDrag.current = undefined; }}>
          {asset.current.mime.startsWith('image/') ? <AssetThumbnail key={asset.current.version} request={request} path={base + '/assets/' + encodeURIComponent(asset.id) + '/versions/' + asset.current.version} name={asset.name} onPreview={() => setPreview(asset)} /> : group.id === 'texts' ? <TextThumbnail request={request} path={base + '/assets/' + encodeURIComponent(asset.id) + '/versions/' + asset.current.version} name={asset.name} onPreview={() => setPreview(asset)} /> : <button className="ow-assets-file-preview" onClick={() => setPreview(asset)} aria-label={t('Preview: {name}', { name: asset.name })}><File size={22} /><span>{asset.name}</span></button>}
          <div className="ow-assets-quick-actions" role="group" aria-label={t('Quick actions: {name}', { name: asset.name })}>
            {!asset.deleted && <button type="button" disabled={disabled} aria-label={t('Copy independently to Work Graph: {name}', { name: asset.name })} title={t('Copy independently to Work Graph')} onClick={() => mutate(asset, 'copy')}><Plus size={18} aria-hidden="true" /></button>}
            {!asset.deleted && asset.projectId === ownerProjectId && <button type="button" disabled={disabled} aria-label={t('Delete asset: {name}', { name: asset.name })} title={t('Delete asset')} onClick={() => { if (window.confirm(t('Move “{name}” to deleted assets? Work Graph copies are unaffected.', { name: asset.name }))) mutate(asset, 'delete'); }}><Trash2 size={16} aria-hidden="true" /></button>}
          </div>
          <div className="ow-assets-card-details"><strong title={asset.name}>{asset.name}</strong><AssetMenu name={asset.name} open={openAssetMenu === asset.id} onToggle={() => setOpenAssetMenu(v => v === asset.id ? undefined : asset.id)} onClose={() => setOpenAssetMenu(undefined)}><button onClick={() => setPreview(asset)}>{t('Preview')}</button>{asset.deleted ? asset.projectId === ownerProjectId && <button disabled={disabled} onClick={() => mutate(asset, 'restore')}>{t('Restore')}</button> : <button disabled={disabled} onClick={() => mutate(asset, 'copy')}>{t('Copy independently to Work Graph')}</button>}{!asset.deleted && asset.projectId === ownerProjectId && <><button disabled={disabled} onClick={() => mutate(asset, 'share')}>{asset.shared ? t('Stop sharing') : t('Share')}</button><button disabled={disabled} onClick={() => { if (window.confirm(t('Move “{name}” to deleted assets? Work Graph copies are unaffected.', { name: asset.name }))) mutate(asset, 'delete'); }}>{t('Delete')}</button></>}</AssetMenu></div>
        </li>)}</ul>}
      </React.Fragment>)}
      {(page > 0 || assets.length === 100) && <nav className="ow-assets-pagination" aria-label={t('Asset pagination')}><button aria-label={t('Previous page')} disabled={page === 0 || loading} onClick={() => setPage(v => v - 1)}><ChevronLeft size={16} /></button><span>{t('Page {page}', { page: page + 1 })}</span><button aria-label={t('Next page')} disabled={assets.length < 100 || loading} onClick={() => setPage(v => v + 1)}><ChevronRight size={16} /></button></nav>}
    </div>

    {preview && <AssetPreviewDialog request={request} path={base + '/assets/' + encodeURIComponent(preview.id) + '/versions/' + preview.current.version} asset={preview} onClose={() => setPreview(undefined)} onError={onError} />}
  </section>;
}
export default ResourcesPanel;
