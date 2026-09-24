import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export const MIN_TOAST_VISIBLE_MS = 2000;

export function toastVisibleDuration(duration: number): number {
  return Math.max(MIN_TOAST_VISIBLE_MS, duration);
}

export interface ToastQueueItem {
  id: string;
  content: ReactNode;
  role?: 'status' | 'alert';
  duration?: number | null;
  dismissLabel?: string;
  className?: string;
  resetKey?: string;
}

export function appendToastQueueItem(items: ToastQueueItem[], item: ToastQueueItem, limit = 50): ToastQueueItem[] {
  if (typeof item.content === 'string' && items.some(existing =>
    existing.content === item.content && (existing.role ?? 'status') === (item.role ?? 'status'))) return items;
  return [...items, item].slice(-Math.max(1, limit));
}

export function ToastQueue({ items, onDismiss, className = '', label = translate("Notification queue"), target }: {
  items: ToastQueueItem[];
  onDismiss?: (id: string) => void;
  className?: string;
  label?: string;
  target?: HTMLElement | null;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const itemStamp = items.map(item => item.id).join('\u0000');
  useEffect(() => {
    const element = target ?? viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [itemStamp, target]);
  const toasts = items.map(item => <Toast
      key={item.id}
      role={item.role}
      duration={item.duration}
      dismissLabel={item.dismissLabel}
      className={item.className}
      resetKey={item.resetKey}
      onDismiss={onDismiss ? () => onDismiss(item.id) : undefined}
    >{item.content}</Toast>);
  if (target !== undefined) return target ? createPortal(toasts, target) : null;
  if (!items.length) return null;
  return <div ref={viewport} className={`workgraph-toast-viewport ${className}`} aria-label={label}>{toasts}</div>;
}

/** Retain the last content during exit, even when its operation has finished. */
export function Toast({ open = true, children, resetKey, duration = 5000, onDismiss, dismissLabel, className = '', role = 'status' }: {
  open?: boolean; children: ReactNode; resetKey?: string; duration?: number | null;
  onDismiss?: () => void; dismissLabel?: string; className?: string; role?: 'status' | 'alert';
}) {
  const [visible, setVisible] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const content = useRef(children);
  const dismiss = useRef(onDismiss);
  const shownAt = useRef(Date.now());
  dismiss.current = onDismiss;
  if (open) content.current = children;
  useEffect(() => {
    if (open) { shownAt.current = Date.now(); setVisible(true); setExiting(false); return; }
    if (!visible) return;
    const remaining = Math.max(0, MIN_TOAST_VISIBLE_MS - (Date.now() - shownAt.current));
    const timer = setTimeout(() => setExiting(true), remaining);
    return () => clearTimeout(timer);
  }, [open, resetKey, visible]);
  useEffect(() => {
    if (!open || duration === null || hovered || focused) return;
    const timer = setTimeout(() => setExiting(true), toastVisibleDuration(duration));
    return () => clearTimeout(timer);
  }, [open, resetKey, duration, hovered, focused]);
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => { setVisible(false); dismiss.current?.(); }, 180);
    return () => clearTimeout(timer);
  }, [exiting]);
  if (!visible) return null;
  return <div className={`workgraph-toast ${className}`} data-phase={exiting ? 'exit' : 'enter'} role={role}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {content.current}
    {dismissLabel && <button type="button" className="workgraph-toast-dismiss" aria-label={dismissLabel} onClick={() => setExiting(true)}>X</button>}
  </div>;
}
