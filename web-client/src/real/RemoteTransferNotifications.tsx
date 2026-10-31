import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteTransfer } from '../../../packages/protocol/src/remote-assets';
import { ConnectionRegistry, type Connection } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import '../i18n/catalogs/remote-assets';
import { messageOf, type Request } from './contracts';
import { NotificationQueue, type NotificationItem } from './NotificationCenter';
import './RemoteTransferNotifications.css';

const eventName = 'openworkgraph:remote-transfers-changed';
const transferring = (job: RemoteTransfer) => ['accepted', 'preparing', 'transferring', 'committing'].includes(job.state);
const loading = (job: RemoteTransfer) => transferring(job) || (job.state === 'succeeded' && job.target.kind === 'temporary' && !job.result?.deliveryAcknowledged);
const notificationId = (job: RemoteTransfer) => [job.serviceId, job.id, job.attempt, loading(job) ? 'progress' : job.state].join(':');

/** One monitor per connected Workspace, independent of the open sidebar or graph. */
export function WorkspaceTransferNotifications({ registry, connection, ...props }: {
  registry: ConnectionRegistry; connection: Connection; ready: boolean; browserId: string;
  onError(error: unknown): void;
}) {
  const transport = useMemo(() => new Transport(registry, connection.serviceId), [registry, connection.serviceId, connection.generation]);
  const request = useMemo<Request>(() => transport.request.bind(transport), [transport]);
  return <RemoteTransferNotifications {...props} request={request} serviceId={connection.serviceId}/>;
}

export function RemoteTransferNotifications({ request, serviceId, ready, browserId, onError }: {
  request: Request; serviceId: string; ready: boolean; browserId: string;
  onError(error: unknown): void;
}) {
  const { t } = useI18n();
  const [notices, setNotices] = useState<RemoteTransfer[]>([]);
  const [busy, setBusy] = useState(new Set<string>());
  const controlPending = useRef(new Set<string>());
  const history = useRef({ serviceId, initialized: false, jobs: new Map<string, RemoteTransfer>(), notified: new Set<string>() });
  const latest = useRef({ onError }); latest.current = { onError };
  useEffect(() => {
    if (history.current.serviceId !== serviceId) {
      history.current = { serviceId, initialized: false, jobs: new Map(), notified: new Set() };
      setNotices([]);
    }
    if (!ready) return;
    let live = true, running = false, dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = history.current;
    const accept = (job: RemoteTransfer, submitted = false) => {
      if (job.serviceId !== serviceId) return;
      const previous = state.jobs.get(job.id);
      if (previous && (job.attempt < previous.attempt || (job.attempt === previous.attempt && job.revision <= previous.revision))) {
        // The initial snapshot can beat a very fast POST response. Surface the
        // authoritative result of that submission without regressing its state.
        if ((!submitted && !loading(previous)) || state.notified.has(notificationId(previous))) return;
        job = previous;
      }
      state.jobs.set(job.id, job);
      if (job.target.kind === 'temporary' && job.target.browserId !== browserId) return;
      // Snapshot terminal rows establish a baseline, never a history of notifications.
      if (!loading(job) && !submitted && !previous && !state.initialized) return;
      if (!loading(job) && state.notified.has(notificationId(job))) return;
      state.notified.add(notificationId(job));
      setNotices(items => items.some(item => item.id === job.id) ? items.map(item => item.id === job.id ? job : item) : [...items, job]);
    };
    const reload = async () => {
      if (!live) return;
      if (running) { dirty = true; return; }
      running = true;
      try {
        do {
          dirty = false;
          const jobs = await request<RemoteTransfer[]>('/v1/remote-transfers');
          if (!live) return;
          jobs.forEach(job => accept(job));
          state.initialized = true;
        } while (dirty && live);
      } catch (error) {
        if (live) {
          latest.current.onError(error);
          clearTimeout(timer);
          timer = setTimeout(() => { timer = undefined; void reload(); }, 2000);
        }
      }
      finally { running = false; }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ serviceId?: string; job?: RemoteTransfer }>).detail;
      if (detail?.serviceId && detail.serviceId !== serviceId) return;
      if (detail?.job) accept(detail.job, true);
      // Progress events are coalesced; at most one snapshot is in flight.
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; void reload(); }, 100);
    };
    window.addEventListener(eventName, changed);
    void reload();
    return () => { live = false; clearTimeout(timer); window.removeEventListener(eventName, changed); };
  }, [request, serviceId, ready, browserId]);

  const control = async (job: RemoteTransfer, action: 'cancel' | 'retry') => {
    if (!ready || controlPending.current.has(job.id)) return;
    controlPending.current.add(job.id); setBusy(new Set(controlPending.current));
    try {
      const updated = await request<RemoteTransfer>('/v1/remote-transfers/' + job.id + '/' + action, action === 'retry' ? { expectedAttempt: job.attempt } : {});
      window.dispatchEvent(new CustomEvent(eventName, { detail: { serviceId, job: updated, payload: { state: updated.state } } }));
    } catch (error) { latest.current.onError(new Error(t(messageOf(error)))); }
    finally { controlPending.current.delete(job.id); setBusy(new Set(controlPending.current)); }
  };
  const items: NotificationItem[] = notices.filter(job => job.serviceId === serviceId).map(job => {
    const active = loading(job), failed = job.state === 'failed' || job.state === 'interrupted';
    const label = active ? 'Loading asset' : job.state === 'succeeded' ? 'Asset loaded' : job.state === 'cancelled' ? 'Asset loading cancelled' : 'Asset loading failed';
    return {
      id: job.id, kind: active ? 'progress' : failed ? 'error' : job.state === 'succeeded' ? 'success' : 'info',
      resetKey: `${job.attempt}:${active ? 'progress' : job.state}`,
      duration: active || failed || job.retryable ? null : 5000,
      dismissLabel: active ? undefined : t('Close'), className: 'remote-transfer-notification',
      content: <div className="remote-transfer-notice" data-state={active ? 'loading' : job.state}>
        <div className="remote-transfer-notice-title"><strong>{t(label)}</strong><span title={job.path}>{job.path.split('/').at(-1)}</span></div>
        {active && <progress aria-label={t('Loading asset') + ': ' + job.path} max={Math.max(1, job.bytes ?? 1)} value={transferring(job) && job.bytes !== null && job.bytes > 0 ? Math.min(job.received, job.bytes) : undefined}/>}
        {failed && job.error && <span>{t(job.error)}</span>}
        {failed && job.retryBlockedReason && <span>{t(job.retryBlockedReason)}</span>}
        {transferring(job) && <button type="button" disabled={!ready || busy.has(job.id)} onClick={() => void control(job, 'cancel')}>{t('Cancel transfer')}</button>}
        {job.retryable && <button type="button" disabled={!ready || busy.has(job.id)} onClick={() => void control(job, 'retry')}>{t('Retry transfer')}</button>}
      </div>,
    };
  });
  return <NotificationQueue items={items} onDismiss={id => setNotices(items => items.filter(job => job.id !== id))}/>;
}
