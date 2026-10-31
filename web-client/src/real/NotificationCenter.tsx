import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bell, CheckCheck, CheckCircle2, CircleAlert, Info, LoaderCircle, MessageCircleQuestion, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import '../i18n/catalogs/notifications';

export type NotificationKind = 'info' | 'success' | 'warning' | 'error' | 'progress' | 'action';
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  content: ReactNode;
  duration?: number | null;
  dismissLabel?: string;
  className?: string;
  resetKey?: string;
}
interface Entry extends NotificationItem { key: string; order: number; onDismiss?: () => void; }
interface Store {
  publish: (source: string, items: NotificationItem[], dismiss?: (id: string) => void) => void;
  remove: (source: string) => void;
}
const PublisherContext = createContext<Store | null>(null);
const EntriesContext = createContext<Entry[]>([]);
export const MIN_NOTIFICATION_VISIBLE_MS = 2000;
export const notificationVisibleDuration = (duration: number) => Math.max(MIN_NOTIFICATION_VISIBLE_MS, duration);

export function appendNotification(items: NotificationItem[], item: NotificationItem, limit = 50): NotificationItem[] {
  if (typeof item.content === 'string' && items.some(existing => existing.content === item.content && existing.kind === item.kind)) return items;
  return [...items, item].slice(-Math.max(1, limit));
}

/** Sources retain ownership of operations; the center owns their common presentation. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState(new Map<string, Entry[]>());
  const sequence = useRef(0);
  const publish = useCallback<Store['publish']>((source, items, dismiss) => {
    setGroups(previous => {
      const saved = previous.get(source) ?? [];
      const next = new Map(previous);
      next.set(source, items.map(item => ({ ...item, key: `${source}:${item.id}`,
        order: saved.find(entry => entry.id === item.id)?.order ?? ++sequence.current,
        onDismiss: dismiss && item.dismissLabel ? () => dismiss(item.id) : undefined,
      })));
      return next;
    });
  }, []);
  const remove = useCallback((source: string) => setGroups(previous => {
    if (!previous.has(source)) return previous;
    const next = new Map(previous); next.delete(source); return next;
  }), []);
  const store = useMemo(() => ({ publish, remove }), [publish, remove]);
  const entries = useMemo(() => [...groups.values()].flat().sort((a, b) => b.order - a.order), [groups]);
  return <PublisherContext.Provider value={store}><EntriesContext.Provider value={entries}>{children}</EntriesContext.Provider></PublisherContext.Provider>;
}

export function NotificationQueue(props: { items: NotificationItem[]; onDismiss?: (id: string) => void }) {
  const store = useContext(PublisherContext);
  // Isolated component previews still use the same notification presentation.
  if (!store) return <NotificationProvider><NotificationQueue {...props}/><div className="workgraph-status-dock"><NotificationCenter/></div></NotificationProvider>;
  return <NotificationSource {...props} store={store}/>;
}
function NotificationSource({ items, onDismiss, store }: { items: NotificationItem[]; onDismiss?: (id: string) => void; store: Store }) {
  const source = useId();
  useLayoutEffect(() => { store.publish(source, items, onDismiss); }, [store, source, items, onDismiss]);
  useLayoutEffect(() => () => store.remove(source), [store, source]);
  return null;
}

export function NotificationCenter() {
  const { t } = useI18n();
  const entries = useContext(EntriesContext);
  const [retained, setRetained] = useState(entries);
  // Keep removed entries just long enough for their exit animation.
  if (entries !== retained && (entries.length !== retained.length || entries.some((entry, index) => entry !== retained[index]))) {
    const next = [...entries, ...retained.filter(saved => !entries.some(entry => entry.key === saved.key))];
    if (next.length !== retained.length || next.some((entry, index) => entry !== retained[index])) setRetained(next);
  }
  const remove = useCallback((key: string) => setRetained(items => items.filter(item => item.key !== key)), []);
  if (!retained.length) return null;
  const dismissible = entries.filter(entry => entry.onDismiss);
  return <section className="workgraph-notifications" aria-label={t('Notifications')}>
    <header><Bell size={14} aria-hidden="true"/><h2>{t('Notifications')}</h2><span>{entries.length}</span></header>
    <ul>{retained.map(saved => <NotificationCard key={saved.key} entry={saved} exiting={!entries.some(entry => entry.key === saved.key)} onExited={remove}/>)}</ul>
    <footer><button className="workgraph-notifications-clear" type="button" disabled={!dismissible.length} onClick={() => dismissible.forEach(entry => entry.onDismiss?.())} title={t('Clear dismissible notifications')}><CheckCheck size={16} aria-hidden="true"/>{t('Clear all')}</button></footer>
  </section>;
}
const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: CircleAlert, progress: LoaderCircle, action: MessageCircleQuestion };
const kindLabels: Record<NotificationKind, string> = { info: 'Information', success: 'Success', warning: 'Warning', error: 'Error', progress: 'In progress', action: 'Action needed' };
function NotificationCard({ entry, exiting, onExited }: { entry: Entry; exiting: boolean; onExited: (key: string) => void }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const latest = useRef(entry); latest.current = entry;
  const duration = entry.duration === undefined ? (entry.kind === 'info' || entry.kind === 'success' ? 5000 : null) : entry.duration;
  useEffect(() => {
    if (exiting || hovered || focused || duration === null || !entry.onDismiss) return;
    const timer = setTimeout(() => latest.current.onDismiss?.(), notificationVisibleDuration(duration));
    return () => clearTimeout(timer);
  }, [exiting, hovered, focused, duration, entry.key, entry.kind, entry.resetKey, !!entry.onDismiss]);
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onExited(entry.key), 240);
    return () => clearTimeout(timer);
  }, [exiting, entry.key, onExited]);
  const Icon = icons[entry.kind];
  return <li className={`workgraph-notification ${entry.className ?? ''}`} data-kind={entry.kind} data-phase={exiting ? 'exit' : 'enter'} inert={exiting}
    onAnimationEnd={event => { if (exiting && event.target === event.currentTarget) onExited(entry.key); }}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="workgraph-notification-icon" role="img" aria-label={t(kindLabels[entry.kind])}><Icon size={17} aria-hidden="true"/></span>
    <div className="workgraph-notification-body" role={entry.kind === 'error' ? 'alert' : 'status'} aria-live={entry.kind === 'progress' ? 'off' : undefined}>{entry.content}</div>
    {entry.onDismiss && <button className="workgraph-notification-dismiss" type="button" aria-label={entry.dismissLabel ?? t('Close')} title={entry.dismissLabel ?? t('Close')} onClick={() => entry.onDismiss?.()}><X size={15} aria-hidden="true"/></button>}
  </li>;
}
