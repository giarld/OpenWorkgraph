import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNodeViewport } from '../canvas/NodeViewport';
import { createPortal } from 'react-dom';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents, markdownRemarkPlugins } from '../components/MarkdownCodeBlock';
import { useI18n } from '../i18n/I18nProvider';
import type { Request } from './contracts';
import { markdownLinkTarget } from './markdown-link-target';
import { markdownImageCache } from './markdown-image-cache';
import { ImagePreviewViewport } from './ImagePreviewViewport';

export interface MarkdownPreviewContext {
  sourcePath?: string;
  onOpenLink?: (href: string, sourcePath?: string) => void;
  imageRequest?: Request;
  projectId?: string;
  imageRevision?: number;
  expandableImages?: boolean;
}
const MarkdownContext = createContext<MarkdownPreviewContext>({});

/** The host supplies authorized interactions; standalone previews stay passive. */
export function MarkdownPreviewProvider({ children, ...options }: MarkdownPreviewContext & { children: ReactNode }) {
  const parent = useContext(MarkdownContext);
  const { onOpenLink = parent.onOpenLink, imageRequest = parent.imageRequest, projectId = parent.projectId,
    imageRevision = parent.imageRevision, expandableImages = parent.expandableImages, sourcePath = parent.sourcePath } = options;
  const value = useMemo(() => ({ onOpenLink, imageRequest, projectId, imageRevision, expandableImages, sourcePath }),
    [onOpenLink, imageRequest, projectId, imageRevision, expandableImages, sourcePath]);
  return <MarkdownContext.Provider value={value}>{children}</MarkdownContext.Provider>;
}

/** Shared by the preview registry, reference dialogs and document nodes. */
export function MarkdownPreview({ text, className = '', ...options }: MarkdownPreviewContext & { text: string; className?: string }) {
  const visible = useNodeViewport();
  const retained = useRef<ReactNode>(null);
  const context = useContext(MarkdownContext);
  const { onOpenLink = context.onOpenLink, imageRequest = context.imageRequest, projectId = context.projectId,
    imageRevision = context.imageRevision ?? 0, expandableImages = context.expandableImages ?? false, sourcePath = context.sourcePath } = options;
  const components = useMemo<Components>(() => ({
        ...markdownCodeComponents,
        a: ({ children, href, node: _node, ...rest }) => onOpenLink && href ? <a {...rest} href={href} data-canvas-interactive data-canvas-link onPointerDown={event => event.stopPropagation()} onClick={event => {
          if (href.startsWith('#')) return;
          event.preventDefault(); event.stopPropagation(); onOpenLink(href, sourcePath);
        }}>{children}</a> : <span>{children}</span>,
        img: ({ src, alt }) => imageRequest && projectId ? <MarkdownFileImage sourcePath={sourcePath} src={src ?? ''} alt={alt} request={imageRequest} projectId={projectId} revision={imageRevision} onOpenLink={onOpenLink} expandable={expandableImages}/> : <span>{alt}</span>,
  }), [onOpenLink, imageRequest, projectId, imageRevision, expandableImages, sourcePath]);
  // Shared provider updates (e.g. project file revisions) must not restart
  // Markdown parsing or image reads in retained, offscreen nodes.
  const content = useMemo(() => visible ? <article className={('markdown-body ' + className).trim()}>
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, ...markdownRemarkPlugins]}
      urlTransform={url => /^file:/i.test(url) || (/^[a-z]:/i.test(url) && (url[2] === '/' || url.charCodeAt(2) === 92)) ? url : defaultUrlTransform(url)}
      components={components}>{text}</ReactMarkdown>
  </article> : retained.current, [visible, className, components, text]);
  useLayoutEffect(() => { if (visible) retained.current = content; }, [visible, content]);
  return content;
}

function MarkdownFileImage({ sourcePath, src, alt, request, projectId, revision, onOpenLink, expandable }: { sourcePath?: string; src: string; alt?: string; request: Request; projectId: string; revision: number; onOpenLink?: (href: string, sourcePath?: string) => void; expandable: boolean }) {
  const { t } = useI18n();
  const target = markdownLinkTarget(src, sourcePath);
  const thumbnailSize = expandable ? 1280 : 640;
  const key = JSON.stringify([projectId, revision, src, sourcePath, thumbnailSize]);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [image, setImage] = useState<{ key: string; url?: string; failed?: boolean }>(() => target.kind === 'file' ? { key, url: markdownImageCache.peek(request, projectId, target.path, thumbnailSize) } : { key });
  const [original, setOriginal] = useState<{ key: string; url?: string; failed?: boolean }>();
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.focus();
    return () => { if (trigger.current?.isConnected) trigger.current.focus(); };
  }, [expanded]);
  useEffect(() => {
    if (!expanded || target.kind !== 'file') return;
    let active = true;
    setOriginal({ key, url: markdownImageCache.peek(request, projectId, target.path, 'original') });
    void markdownImageCache.load(request, projectId, target.path, 'original').then(url => {
      if (active) setOriginal({ key, url });
    }).catch(() => { if (active) setOriginal({ key, failed: true }); });
    return () => { active = false; };
  }, [expanded, key, request, projectId, src]);
  useEffect(() => {
    if (target.kind !== 'file') return;
    let active = true;
    setImage({ key, url: markdownImageCache.peek(request, projectId, target.path, thumbnailSize) });
    void markdownImageCache.load(request, projectId, target.path, thumbnailSize).then(url => {
      if (active) setImage({ key, url });
    }).catch(() => { if (active) setImage({ key, failed: true }); });
    return () => { active = false; };
  }, [key, src, projectId, request, thumbnailSize]);
  if (target.kind === 'file' && image?.key === key && image.url && !image.failed) {
    const imageElement = <img src={image.url} alt={alt ?? ''} draggable={false} onError={() => { markdownImageCache.remove(request, projectId, target.path, thumbnailSize); setImage({ key, failed: true }); }}/>;
    if (!expandable) return imageElement;
    return <>
      <button ref={trigger} type="button" className="markdown-image-expand" aria-label={t('Enlarge {name}', { name: alt || src })} aria-haspopup="dialog" aria-expanded={expanded} title={t('Double-click to enlarge image')} onClick={event => { if (event.detail === 0) setExpanded(true); }} onDoubleClick={() => setExpanded(true)}>{imageElement}</button>
      {expanded && createPortal(<div className="modal-backdrop markdown-image-backdrop" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onClick={() => setExpanded(false)}><section ref={dialog} className="markdown-image-dialog panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
        if (event.key === 'Tab') {
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}><header><h2 id={titleId}>{alt || src}</h2><button type="button" aria-label={t('Close image preview')} onClick={() => setExpanded(false)}>{t('Close')}</button></header>{original?.key === key && original.url && !original.failed ? <ImagePreviewViewport key={original.url} src={original.url} alt={alt ?? ''} onError={() => { markdownImageCache.remove(request, projectId, target.path, 'original'); setOriginal({ key, failed:true }); }}/> : <p role="status">{original?.key === key && original.failed ? t('Unable to view this file.') : t('Reading original image…')}</p>}</section></div>, document.body)}
    </>;
  }
  const label = alt || src;
  if (target.kind === 'file' && (image?.key !== key || !image.failed))
    return <span className="markdown-file-image-fallback" role="status">{t('Loading preview…')}</span>;
  return <span className="markdown-file-image-fallback" role={target.kind === 'file' ? 'status' : undefined}>{target.kind === 'file' ? t('Unable to view this file.') + ' ' : ''}{onOpenLink && target.kind !== 'invalid' ? <a href={src} data-canvas-interactive data-canvas-link onPointerDown={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); onOpenLink(src, sourcePath); }}>{label}</a> : label}</span>;
}
