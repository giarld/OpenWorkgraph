import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import './ImagePreviewViewport.css';

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;
const ZOOM_STEP = 1.25;
const ZOOM_DURATION = 180;
interface ImageView { width: number; height: number; scale: number; minScale: number; x: number; y: number }

function constrainImage(view: ImageView, viewportWidth: number, viewportHeight: number): ImageView {
  const maxX = Math.max(0, (view.width * view.scale - viewportWidth) / 2);
  const maxY = Math.max(0, (view.height * view.scale - viewportHeight) / 2);
  return { ...view, x: Math.max(-maxX, Math.min(maxX, view.x)), y: Math.max(-maxY, Math.min(maxY, view.y)) };
}

function canPanImage(view: ImageView, viewportWidth: number, viewportHeight: number): boolean {
  return view.scale > Math.min(viewportWidth / view.width, viewportHeight / view.height);
}

/** Original-image zoom shared by standalone and Markdown image dialogs. */
export function ImagePreviewViewport({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const measured = useRef('');
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [view, setView] = useState<ImageView>({ width: 0, height: 0, scale: 1, minScale: MIN_SCALE, x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const panEnabled = canPanImage(view, viewportSize.width, viewportSize.height);
  const currentView = useRef(view);
  const animationFrame = useRef<number | null>(null);
  const animationTarget = useRef<ImageView | null>(null);
  const applyView = useCallback((next: ImageView) => { currentView.current = next; setView(next); }, []);
  const stopAnimation = useCallback(() => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
    animationTarget.current = null;
    setAnimating(false);
  }, []);
  useEffect(() => () => { if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current); }, []);
  const endDrag = useCallback(() => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    setDragging(false);
    if (pointerId !== undefined && viewport.current?.hasPointerCapture(pointerId)) viewport.current.releasePointerCapture(pointerId);
  }, []);
  useEffect(() => { if (!panEnabled) endDrag(); }, [panEnabled, endDrag]);
  const fit = useCallback(() => {
    const element = viewport.current;
    const picture = image.current;
    if (!element || !picture?.naturalWidth || !picture.naturalHeight) return;
    const width = element.clientWidth, height = element.clientHeight;
    if (!width || !height) return;
    const key = [src, width, height, picture.naturalWidth, picture.naturalHeight].join(':');
    if (measured.current === key) return;
    measured.current = key;
    endDrag();
    stopAnimation();
    const scale = Math.min(1, width / picture.naturalWidth, height / picture.naturalHeight);
    setViewportSize({ width, height });
    applyView({ width: picture.naturalWidth, height: picture.naturalHeight, scale, minScale: Math.min(MIN_SCALE, scale), x: 0, y: 0 });
  }, [src, endDrag, stopAnimation, applyView]);
  useLayoutEffect(() => {
    fit();
    const observer = new ResizeObserver(fit);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [fit]);
  const zoom = useCallback((factor: number, clientPoint?: { x: number; y: number }, animate = false) => {
    const bounds = viewport.current?.getBoundingClientRect();
    if (!bounds) return;
    // Keep the anchor fixed until an image edge reaches the viewport boundary.
    const anchorX = clientPoint ? clientPoint.x - bounds.left - bounds.width / 2 : 0;
    const anchorY = clientPoint ? clientPoint.y - bounds.top - bounds.height / 2 : 0;
    // Repeated button presses accumulate from the pending target, while gestures
    // interrupt from the currently displayed image instead of jumping to its target.
    const base = animate ? animationTarget.current ?? currentView.current : currentView.current;
    if (!base.width) return;
    const scale = Math.max(base.minScale, Math.min(MAX_SCALE, base.scale * factor));
    const ratio = scale / base.scale;
    const target = constrainImage({ ...base, scale, x: anchorX - (anchorX - base.x) * ratio, y: anchorY - (anchorY - base.y) * ratio }, bounds.width, bounds.height);
    if (animate && target.scale === base.scale && target.x === base.x && target.y === base.y) return;
    stopAnimation();
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { applyView(target); return; }
    const from = currentView.current;
    const start = performance.now();
    animationTarget.current = target;
    setAnimating(true);
    const frame = (now: number) => {
      const progress = Math.max(0, Math.min(1, (now - start) / ZOOM_DURATION));
      if (progress >= 1) {
        applyView(target);
        animationFrame.current = null;
        animationTarget.current = null;
        setAnimating(false);
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      const next = { ...target, scale: from.scale + (target.scale - from.scale) * eased,
        x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased };
      applyView(constrainImage(next, bounds.width, bounds.height));
      animationFrame.current = requestAnimationFrame(frame);
    };
    animationFrame.current = requestAnimationFrame(frame);
  }, [stopAnimation, applyView]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.deltaY || (event.target as Element).closest('.image-preview-zoom-controls')) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      zoom(Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), { x: event.clientX, y: event.clientY });
    };
    // React wheel handlers are passive; a native listener must cancel browser page zoom.
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom]);
  return <div ref={viewport} className="image-preview-viewport" data-pan-enabled={panEnabled} data-dragging={dragging} data-zoom-animating={animating}
    onPointerDown={event => {
      if (!canPanImage(currentView.current, event.currentTarget.clientWidth, event.currentTarget.clientHeight) || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary || (event.target as Element).closest('.image-preview-zoom-controls')) return;
      event.preventDefault();
      event.stopPropagation();
      stopAnimation();
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      current.x = event.clientX;
      current.y = event.clientY;
      const width = event.currentTarget.clientWidth, height = event.currentTarget.clientHeight;
      const value = currentView.current;
      applyView(constrainImage({ ...value, x: value.x + dx, y: value.y + dy }, width, height));
    }}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
    onLostPointerCapture={endDrag}>
    <img ref={image} className="image-preview-zoom-image" src={src} alt={alt} draggable={false} onLoad={fit} onError={onError} onContextMenu={event => event.stopPropagation()}
      style={{ width: view.width || undefined, height: view.height || undefined, transform: 'translate(-50%, -50%) translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')' }}/>
    <div className="image-preview-zoom-controls" role="group" aria-label={t('Image zoom')}>
      <button type="button" aria-label={t('Zoom out')} title={t('Zoom out')} disabled={!view.width || view.scale <= view.minScale} onClick={() => zoom(1 / ZOOM_STEP, undefined, true)}><ZoomOut size={18}/></button>
      <span aria-label={t('Zoom percentage')} aria-live="polite">{Math.round(view.scale * 100)}%</span>
      <button type="button" aria-label={t('Zoom in')} title={t('Zoom in')} disabled={!view.width || view.scale >= MAX_SCALE} onClick={() => zoom(ZOOM_STEP, undefined, true)}><ZoomIn size={18}/></button>
    </div>
  </div>;
}
