import { useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { Rect } from './geometry';
import { EDITOR_PANEL_STORAGE_KEY, fitEditorPanel, readEditorPanel } from './editor-panel-layout';

const layoutEvent = 'owg-editor-panel-layout';
function storedLayout() {
  try { return readEditorPanel(window.localStorage); } catch { return null; }
}
function sameBounds(a: Rect, b: Rect) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function EditorPanel({ nodeId, title, titlePrefix, area, defaultBounds, visible, children }: {
  nodeId: string; title: string; area: Rect; defaultBounds: Rect; visible: boolean;
  titlePrefix?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [preferred, setPreferred] = useState(storedLayout);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; bounds: Rect; next: Rect; preferred: Rect | null; kind: 'move' | 'resize' } | null>(null);
  const bounds = fitEditorPanel(preferred ?? defaultBounds, area);
  useEffect(() => { const saved = storedLayout(); if (saved) setPreferred(saved); }, [nodeId]);
  useEffect(() => {
    const update = (event?: Event) => { if (!gesture.current) setPreferred(event instanceof CustomEvent ? event.detail : storedLayout()); };
    const storage = (event: StorageEvent) => { if (!event.key || event.key === EDITOR_PANEL_STORAGE_KEY) update(); };
    window.addEventListener('storage', storage);
    window.addEventListener(layoutEvent, update);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(layoutEvent, update); };
  }, []);
  function save(next: Rect) {
    setPreferred(next);
    try { localStorage.setItem(EDITOR_PANEL_STORAGE_KEY, JSON.stringify(next)); } catch { /* Still draggable without storage. */ }
    window.dispatchEvent(new CustomEvent(layoutEvent, { detail: next }));
  }
  function start(event: PointerEvent<HTMLElement>, kind: 'move' | 'resize') {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds, next: bounds, preferred, kind };
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    active.next = fitEditorPanel(active.kind === 'move'
      ? { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy }
      : { ...active.bounds, width: active.bounds.width + dx, height: active.bounds.height + dy }, area);
    setPreferred(sameBounds(active.next, active.bounds) ? active.preferred : active.next);
  }
  function finish(event: PointerEvent<HTMLElement>, cancel = false) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    event.stopPropagation(); gesture.current = null; setDragging(false);
    if (cancel || sameBounds(active.next, active.bounds)) setPreferred(active.preferred);
    else save(active.next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, kind: 'move' | 'resize') {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 32 : 8;
    const next = fitEditorPanel(kind === 'move' ? { ...bounds, x: bounds.x + delta[0] * step, y: bounds.y + delta[1] * step }
      : { ...bounds, width: bounds.width + delta[0] * step, height: bounds.height + delta[1] * step }, area);
    if (!sameBounds(next, bounds)) save(next);
  }
  return <div className="owg-node-panel owg-fixed-node-panel" data-panel-node-id={nodeId} data-canvas-interactive
    data-panel-dragging={dragging || undefined} inert={!visible} aria-hidden={!visible}
    style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, visibility: visible ? 'visible' : 'hidden' }}>
    <div className="owg-editor-panel-content">
      <div className="owg-panel-target" title={title} role="button" tabIndex={0} aria-label={t('Move prompt editor')}
        onPointerDown={event => start(event, 'move')} onPointerMove={move} onPointerUp={event => finish(event)}
        onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} onKeyDown={event => keyboard(event, 'move')}>
        <span className="owg-panel-target-label">{t('Edit node')}:</span>
        {titlePrefix}
        <span className="owg-panel-target-title">{title}</span>
      </div>
      {children}
    </div>
    <button type="button" className="owg-panel-resize" aria-label={t('Resize prompt editor')}
      onPointerDown={event => start(event, 'resize')} onPointerMove={move} onPointerUp={event => finish(event)}
      onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} onKeyDown={event => keyboard(event, 'resize')}>
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M24.85 13.72 A23 23 0 0 1 13.72 24.85" />
      </svg>
    </button>
  </div>;
}
