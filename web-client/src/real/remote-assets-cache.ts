import type { RemoteListing } from '../../../packages/protocol/src/remote-assets';
import { randomId } from '../adapter/random';
export const REMOTE_ASSETS_DATABASE = 'openworkgraph-remote-assets';
/** Only the public fields needed to reopen historical lists. No addresses or credentials. */
export interface RemoteAssetSourceSummary { id: string; serviceId: string; locationRevision: number; name: string }
type Scope = { serviceId: string; sourceId: string; locationRevision: number };
const scopeKey = (scope: Scope) => JSON.stringify([scope.serviceId, scope.sourceId, scope.locationRevision]);
const key = (scope: Scope, path: string) => JSON.stringify([scope.serviceId, scope.sourceId, scope.locationRevision, path]);
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(REMOTE_ASSETS_DATABASE, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('listings'); open.result.createObjectStore('positions'); open.result.createObjectStore('meta'); };
    open.onsuccess = () => { open.result.onversionchange = () => { open.result.close(); database = undefined; }; resolve(open.result); };
    open.onerror = () => { database = undefined; reject(open.error); };
  });
}
async function access<T>(store: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db(); return new Promise((resolve, reject) => { const tx = database.transaction(store, mode), request = operation(tx.objectStore(store)); tx.oncomplete = () => resolve(request.result); tx.onabort = tx.onerror = () => reject(tx.error ?? request.error); });
}
export const remoteAssetsCache = {
  async sources(serviceId: string): Promise<RemoteAssetSourceSummary[]> {
    const value = await access<unknown>('meta','readonly',store=>store.get('sources:'+serviceId));
    if(!Array.isArray(value)) return [];
    return value.filter((item): item is RemoteAssetSourceSummary => !!item && typeof item==='object' && typeof item.id==='string' && item.serviceId===serviceId && Number.isSafeInteger(item.locationRevision) && item.locationRevision>0 && typeof item.name==='string').map(({id,serviceId,locationRevision,name})=>({id,serviceId,locationRevision,name}));
  },
  saveSources: (serviceId: string, sources: RemoteAssetSourceSummary[]) => access('meta','readwrite',store=>store.put(sources.map(({id,serviceId,locationRevision,name})=>({id,serviceId,locationRevision,name})),'sources:'+serviceId)),
  selectedSource: (serviceId: string) => access<string|undefined>('meta','readonly',store=>store.get('selected-source:'+serviceId)),
  selectSource: (serviceId: string, sourceId: string) => access('meta','readwrite',store=>store.put(sourceId,'selected-source:'+serviceId)),
  read: (scope: Scope, path: string) => access<RemoteListing | undefined>('listings', 'readonly', store => store.get(key(scope, path))),
  save: (listing: RemoteListing) => access('listings', 'readwrite', store => store.put({ serviceId: listing.serviceId, sourceId: listing.sourceId, locationRevision: listing.locationRevision, path: listing.path, entries: listing.entries.map(({ name, path, kind, bytes, error }) => ({ name, path, kind, bytes, ...(error ? { error } : {}) })), observedAt: listing.observedAt }, key(listing, listing.path))),
  lastPath: (scope: Scope) => access<string | undefined>('positions', 'readonly', store => store.get(scopeKey(scope))),
  remember: (scope: Scope, path: string) => access('positions', 'readwrite', store => store.put(path, scopeKey(scope))),
  async invalidate(serviceId: string, sources: { id: string; locationRevision: number }[]) {
    const database = await db(); await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['positions', 'listings', 'meta'], 'readwrite');
      for (const name of ['positions', 'listings']) { const cursor = tx.objectStore(name).openCursor(); cursor.onsuccess = () => { const item = cursor.result; if (!item) return; const parts = JSON.parse(String(item.key)) as [string, string, number]; if (parts[0] === serviceId && !sources.some(s => s.id === parts[1] && s.locationRevision === parts[2])) item.delete(); item.continue(); }; }
      const selected=tx.objectStore('meta').get('selected-source:'+serviceId); selected.onsuccess=()=>{if(selected.result&&!sources.some(s=>s.id===selected.result))tx.objectStore('meta').delete('selected-source:'+serviceId);};
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
  async browserId(): Promise<string> {
    const database = await db(); return new Promise((resolve, reject) => { const tx = database.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), request = store.get('browserId'); let id = ''; request.onsuccess = () => { id = typeof request.result === 'string' ? request.result : randomId(); if (!request.result) store.put(id, 'browserId'); }; tx.oncomplete = () => resolve(id); tx.onerror = tx.onabort = () => reject(tx.error); });
  },
};
