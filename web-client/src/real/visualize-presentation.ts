import type { GraphScope } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';

export type VisualizePresentationStatus = 'waiting' | 'running' | 'paused' | 'error';
type Mode = 'shared' | 'exclusive';
type Lease = { alive(): boolean; release(): Promise<void>; abandon(): void };
const channelName = 'openworkgraph.visualize.presentation.v1';
const leaseDuration = 90_000;
let identity: { tab: string; generation: number } | undefined;
function windowIdentity() {
  if (!identity) {
    const storageKey = channelName + ':window';
    let tab = randomId(), generation = 1;
    try {
      tab = sessionStorage.getItem(storageKey) ?? tab; sessionStorage.setItem(storageKey, tab);
      generation = Number(sessionStorage.getItem(storageKey + ':generation') ?? 0) + 1;
      sessionStorage.setItem(storageKey + ':generation', String(generation));
    } catch { /* Expiry still recovers unavailable session storage. */ }
    identity = { tab, generation };
  }
  return identity;
}

// Web Locks release automatically when a window closes, including crashes.
// IndexedDB leases provide the same exclusion on HTTP origins without Web Locks.
let database: Promise<IDBDatabase> | undefined;
let openedDatabase: IDBDatabase | undefined;
function leaseDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(channelName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('leases');
    request.onsuccess = () => { openedDatabase = request.result; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
type Holder = { id: string; mode: Mode; expires: number; tab: string; generation: number };
async function updateLease<T>(name: string, update: (holders: Holder[]) => { holders: Holder[]; result: T }): Promise<T> {
  const db = await leaseDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('leases', 'readwrite');
    const store = transaction.objectStore('leases'), request = store.getAll(IDBKeyRange.bound([name, ''], [name, '\uffff']));
    let result: T;
    request.onsuccess = () => {
      const current = windowIdentity();
      const previous = request.result as Holder[];
      const changed = update(previous.filter(holder => holder.expires > Date.now() && !(holder.tab === current.tab && holder.generation < current.generation)));
      result = changed.result;
      for (const holder of previous) if (!changed.holders.some(next => next.id === holder.id)) store.delete([name, holder.id]);
      for (const holder of changed.holders) store.put(holder, [name, holder.id]);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? Error('Unable to coordinate visualization pages.'));
  });
}
async function held(name: string): Promise<boolean> {
  if (navigator.locks) return (await navigator.locks.query()).held?.some(lock => lock.name === name) ?? false;
  return updateLease(name, holders => ({ holders, result: holders.length > 0 }));
}
async function claim(name: string, mode: Mode): Promise<Lease | undefined> {
  if (navigator.locks) {
    return new Promise((resolve, reject) => {
      let release: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      let alive = true;
      const completed = navigator.locks.request(name, { mode, ifAvailable: true }, async lock => {
        if (!lock) { resolve(undefined); return; }
        resolve({ alive: () => alive, abandon: () => { alive = false; release(); }, release: async () => { alive = false; release(); await completed; } });
        await done;
      });
      void completed.catch(reject);
    });
  }
  const id = randomId();
  let expires = Date.now() + leaseDuration;
  const acquired = await updateLease(name, holders => {
    const available = mode === 'shared' ? holders.every(holder => holder.mode === 'shared') : !holders.length;
    return { holders: available ? [...holders, { id, mode, expires, ...windowIdentity() }] : holders, result: available };
  });
  if (!acquired) return;
  let alive = true, renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!alive || Date.now() >= expires) { alive = false; return; }
      const deadline = Date.now() + leaseDuration;
      const renewed = await updateLease(name, holders => ({ holders: holders.map(holder => holder.id === id ? { ...holder, expires: deadline } : holder), result: holders.some(holder => holder.id === id) }));
      if (renewed) expires = deadline; else alive = false;
    }).catch(() => { alive = false; });
  }, 10_000);
  let removal: Promise<void> | undefined;
  const remove = () => {
    alive = false; clearInterval(timer);
    // Enqueue a direct deletion during pagehide, before this JS context dies.
    return removal ??= new Promise<void>((resolve, reject) => {
      const transaction = openedDatabase!.transaction('leases', 'readwrite');
      transaction.objectStore('leases').delete([name, id]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    alive: () => alive && Date.now() < expires,
    abandon: () => { void remove().catch(() => undefined); },
    release: remove,
  };
}

/** Coordinate same-origin work graph views and standalone windows without opener. */
export function coordinateVisualizePresentation(options: {
  scope: GraphScope; nodeId: string; temporary: boolean; standalone: boolean;
  onStatus(status: VisualizePresentationStatus): void;
  onSuspend(closeSession: boolean): Promise<void>;
}): { active(): boolean; dispose(): void } {
  const key = JSON.stringify([options.temporary, options.scope.serviceId, options.scope.projectId, options.scope.graphId, options.nodeId]);
  const presenceName = channelName + ':standalone:' + key, renderName = channelName + ':render:' + key;
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(channelName);
  let disposed = false, hidden = false, syncing = false, running = false;
  let presence: Lease | undefined, render: Lease | undefined;
  let draining = Promise.resolve();
  const announce = () => { if (!disposed) channel?.postMessage(key); };
  const status = (value: VisualizePresentationStatus) => { if (!disposed) options.onStatus(value); };
  const suspend = async (value: VisualizePresentationStatus, closeSession: boolean) => {
    running = false; status(value);
    const previous = render; render = undefined;
    if (!previous) { if (closeSession) await options.onSuspend(true); return; }
    // Keep the shared rendering lock until pending writes have finished.
    draining = draining.then(() => options.onSuspend(closeSession)).catch(() => undefined).then(() => previous.release());
    await draining;
  };
  const release = async () => {
    await suspend('waiting', options.standalone);
    const previous = presence; presence = undefined;
    await previous?.release(); announce();
  };
  const sync = async () => {
    if (syncing || disposed || hidden) return;
    syncing = true;
    try {
      await draining;
      if (render && !render.alive() || presence && !presence.alive()) {
        await suspend('waiting', true);
        await presence?.release(); presence = undefined; announce();
      }
      if (disposed || hidden) return;
      if (options.standalone) {
        if (!presence) {
          presence = await claim(presenceName, 'exclusive');
          if (!presence) { status('paused'); return; }
          announce();
        }
      } else if (await held(presenceName)) {
        await suspend('paused', true); return;
      }
      if (!render) {
        render = await claim(renderName, options.standalone ? 'exclusive' : 'shared');
        if (!render) { status(options.standalone ? 'waiting' : 'paused'); return; }
        // A standalone may have announced its presence while the node acquired.
        if (!options.standalone && await held(presenceName)) { await suspend('paused', true); return; }
      }
      if (disposed || hidden) { await release(); return; }
      running = true; status('running');
    } catch {
      await suspend('error', true).catch(() => undefined);
      await presence?.release().catch(() => undefined); presence = undefined;
      status('error');
    } finally {
      // An unmount/pagehide may race either asynchronous lock acquisition.
      if (disposed || hidden) await release().catch(() => undefined);
      syncing = false;
    }
  };
  const message = (event: MessageEvent) => { if (event.data === key) void sync(); };
  const pagehide = () => { hidden = true; running = false; render?.abandon(); presence?.abandon(); void release(); };
  const pageshow = () => { hidden = false; void sync(); };
  channel?.addEventListener('message', message);
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  window.addEventListener('focus', pageshow);
  // The authoritative lock check also recovers from crashes and missed messages.
  const timer = setInterval(() => void sync(), 1000);
  void sync();
  return {
    active: () => running && !!render?.alive() && (!options.standalone || !!presence?.alive()) && !disposed && !hidden,
    dispose: () => {
      disposed = true; running = false; clearInterval(timer);
      channel?.removeEventListener('message', message);
      window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); window.removeEventListener('focus', pageshow);
      // Acquisition can finish after unmount; sync then releases those locks.
      void release().finally(() => channel?.close());
    },
  };
}
