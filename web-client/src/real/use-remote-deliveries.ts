import { translate } from '../i18n/translate';
import { messageOf } from './contracts';
import { useEffect, useState } from 'react';
import type { RemoteTransfer } from '../../../packages/protocol/src/remote-assets';
import type { Node } from '../../../packages/protocol/src/index';
import { remoteAssetsCache } from './remote-assets-cache';
import { withRemoteTemporaryTargets } from './remote-temporary-targets';
import type { TemporaryCanvasStore } from './temporary-store';
import type { Request } from './contracts';

/** Synchronizes already committed Workspace deliveries; never starts a transfer. */
export function useRemoteDeliveries(options: { store: TemporaryCanvasStore; request: Request; serviceId: string; ready: boolean; refreshToken?: number; onChanged(): void; onError(error: unknown): void }) {
  const [browserId, setBrowserId] = useState('');
  useEffect(() => { let current = true; void remoteAssetsCache.browserId().then(id => { if (current) setBrowserId(id); }).catch(options.onError); return () => { current = false; }; }, []);
  useEffect(() => {
    if (!options.ready || !browserId) return; let current = true, running = false, again = false;
    let retry: ReturnType<typeof setTimeout> | undefined, retryDelay = 2000, reportedError = false;
    const sync = async () => {
      if (!current) return;
      if (running) { again = true; return; } running = true;
      clearTimeout(retry); retry = undefined;
      try {
        do {
          again = false;
          const graphs = await withRemoteTemporaryTargets(options.serviceId, browserId, async () => {
            if (!current) return;
            const snapshot = await options.store.list();
            if (!current) return;
            await options.request('/v1/remote-transfers/temporary-targets/sync', { browserId, graphs: snapshot.map(g => ({ graphId: g.graphId, writable: !g.archived && !g.trashed, revision: g.executionRevision + g.layoutRevision })) }, 'POST', { journal: 'memory' });
            return snapshot;
          });
          if (!current || !graphs) return;
          const jobs = await options.request<RemoteTransfer[]>('/v1/remote-transfers');
          for (const job of jobs) {
            if (!current) return;
            if (job.result?.deliveryAcknowledged || job.state !== 'succeeded' || job.target.kind !== 'temporary' || job.target.browserId !== browserId || !job.result?.deliveryId || !graphs.some(g => g.graphId === (job.target as {graphId:string}).graphId && !g.archived && !g.trashed)) continue;
            const key = options.serviceId + ':' + job.id;
            const mirrored = await options.store.hasRemoteDelivery(job.target.graphId, key);
            if (!current) return;
            if (mirrored) { await options.request('/v1/remote-transfers/' + job.id + '/ack', { browserId }, 'POST', { journal: 'memory' }); continue; }
            const delivery = await options.request<{ node: Node; mime: string; name: string; bytes: number; sha256: string }>('/v1/remote-transfers/' + job.id + '/delivery');
            if (!current) return;
            const blob = await options.request<Blob>('/v1/remote-transfers/' + job.id + '/content', undefined, 'BLOB');
            if (!current) return;
            await options.store.receiveRemoteDelivery(job.target.graphId, key, delivery, blob);
            if (!current) return;
            options.onChanged();
            await options.request('/v1/remote-transfers/' + job.id + '/ack', { browserId }, 'POST', { journal: 'memory' });
          }
        } while (again && current);
        retryDelay = 2000; reportedError = false;
      } catch (error) {
        if (current) {
          if (!reportedError) { reportedError = true; options.onError(new Error(translate(messageOf(error)))); }
          // Retry only the local synchronization of committed deliveries.
          // This never creates or retries a remote transfer.
          retry = setTimeout(() => { retry = undefined; void sync(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      } finally { running = false; }
    };
    void sync(); const changed = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.serviceId && detail.serviceId !== options.serviceId) return; if (detail?.payload?.state && detail.payload.state !== 'succeeded') return; void sync(); }; window.addEventListener('openworkgraph:remote-transfers-changed', changed);
    return () => { current = false; clearTimeout(retry); window.removeEventListener('openworkgraph:remote-transfers-changed', changed); };
  }, [options.store, options.request, options.serviceId, options.ready, options.refreshToken, browserId]);
  return browserId;
}
