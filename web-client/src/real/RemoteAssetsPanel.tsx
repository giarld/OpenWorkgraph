import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Copy, Download, Folder, LoaderCircle, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import type { DataSource, RemoteEntry, RemoteListing, RemoteTransfer, RemoteTransferTarget } from '../../../packages/protocol/src/remote-assets';
import { randomId } from '../adapter/random';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf, type Request } from './contracts';
import { remoteAssetsCache, type RemoteAssetSourceSummary } from './remote-assets-cache';
import { formatFileSize } from '../domain/file-types';
import '../i18n/catalogs/remote-assets';
import { FileEntryIcon } from './FileEntryIcon';
import { setFileDragPreview } from './file-drag-preview';
import { beginAssetDrag, type AssetDragContext } from './asset-drag';
import type { Point } from '../canvas/geometry';
import { defaultWorkgraphNodeSize } from '../../../packages/protocol/src/node-layout';
import { NotificationQueue } from './NotificationCenter';
import { requestRemoteThumbnail } from './remote-thumbnail-queue';
import { RemoteAssetPreviewDialog, REMOTE_PREVIEW_AUTO_BYTES } from './RemoteAssetPreviewDialog';
import './ProjectFilesPanel.css';
import './RemoteAssets.css';
import './RemoteTransferNotifications.css';

function Thumbnail({ entry, source, request, enabled }: { entry: RemoteEntry; source: RemoteAssetSourceSummary; request: Request; enabled: boolean }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLSpanElement>(null), objectUrl = useRef('');
  const [nearby, setNearby] = useState(false);
  const eligible = entry.kind === 'file' && entry.bytes !== null && entry.bytes <= REMOTE_PREVIEW_AUTO_BYTES && /\.(png|jpe?g|webp|gif|avif|mp4|mov|webm)$/i.test(entry.name);
  useEffect(() => {
    setUrl(''); setFailed(false);
    return () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; };
  }, [entry, source.id, source.locationRevision, request]);
  useEffect(() => {
    setNearby(false);
    if (!enabled || !eligible || !element.current) return;
    const observer = new IntersectionObserver(entries => setNearby(entries.some(entry => entry.isIntersecting)), { rootMargin: '120px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [enabled, eligible, entry.path]);
  useEffect(() => {
    if (!enabled || !eligible || !nearby || objectUrl.current) return;
    const abort = new AbortController();
    void requestRemoteThumbnail(request, '/v1/data-sources/' + source.id + '/thumbnail?' + new URLSearchParams({ path: entry.path, locationRevision: String(source.locationRevision) }), abort.signal).then(blob => {
      if (!abort.signal.aborted) { objectUrl.current = URL.createObjectURL(blob); setUrl(objectUrl.current); }
    }).catch(() => {});
    return () => abort.abort();
  }, [enabled, eligible, nearby, entry, source.id, source.locationRevision, request]);
  return <span ref={element} className="ow-project-file-tile-icon remote-asset-thumbnail">{url && !failed
    ? <img className="ow-project-file-thumbnail" src={url} alt="" draggable={false} decoding="async" onError={() => setFailed(true)}/>
    : <FileEntryIcon item={{ name: entry.name, kind: entry.kind === 'directory' ? 'directory' : 'file' }} size={30}/>}</span>;
}
export function RemoteAssetsPanel({ request, serviceId, ready, visible, onSettings, getTarget, dragContext, mutationsBlocked = false, graphWritable = true, refreshToken }: { request: Request; serviceId: string; ready: boolean; visible: boolean; onSettings(): void; getTarget(action: 'graph' | 'library'): Promise<RemoteTransferTarget>; dragContext: AssetDragContext; mutationsBlocked?: boolean; graphWritable?: boolean; refreshToken?: number }) {
  const { t } = useI18n(); const [sources, setSources] = useState<RemoteAssetSourceSummary[]>([]), [sourceId, setSourceId] = useState('');
  const [location, setLocation] = useState<{ sourceId: string; locationRevision: number; path: string }>();
  const [view, setView] = useState<RemoteListing>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [actionError, setActionError] = useState('');
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [refresh, setRefresh] = useState(0), [pending, setPending] = useState(new Map<string, { entry: RemoteEntry; action: string }>());
  const [preview, setPreview] = useState<{ sourceId: string; locationRevision: number; entry: RemoteEntry }>();
  const [search, setSearch] = useState(''); const searchInput = useRef<HTMLInputElement>(null);
  const activeActions = useRef(new Set<string>()); const sourcesGeneration = useRef(0); const sourcesInitialized = useRef(false);
  const generation = useRef(0), navigation = useRef(0), mounted = useRef(true);
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  const dragAllowed = useRef(false);
  dragAllowed.current = ready && visible && graphWritable && !mutationsBlocked;
  useEffect(() => () => { cancelDrag.current?.(); cancelDrag.current = undefined; }, [dragContext.request, dragContext.projectId, dragContext.graphId, serviceId, request, sourceId, location, visible, ready, graphWritable, mutationsBlocked]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setPreview(undefined); }, [serviceId, request, sourceId, visible, ready]);
  const reloadSources = useCallback(async () => {
    const generation=++sourcesGeneration.current;
    setSourcesLoading(true);
    try {
      const stored=await remoteAssetsCache.selectedSource(serviceId).catch(()=>undefined);
      const publish=(list:RemoteAssetSourceSummary[])=>{if(!mounted.current||generation!==sourcesGeneration.current)return;setSources(list);setSourceId(id=>list.some(s=>s.id===id)?id:list.some(s=>s.id===stored)?stored!:list[0]?.id??'');};
      if(!sourcesInitialized.current){const historical=await remoteAssetsCache.sources(serviceId).catch(()=>[]);if(!mounted.current||generation!==sourcesGeneration.current)return;sourcesInitialized.current=true;publish(historical);}
      if(!ready)return;
      const response=await request<DataSource[]>('/v1/data-sources');if(!mounted.current||generation!==sourcesGeneration.current)return;
      const list=response.map(source=>({id:source.id,serviceId:source.serviceId,locationRevision:source.locationRevision,name:source.config.name}));publish(list);
      await remoteAssetsCache.saveSources(serviceId,list).catch(()=>{if(mounted.current&&generation===sourcesGeneration.current)setError(t('History could not be saved.'));});
      if(mounted.current&&generation===sourcesGeneration.current)await remoteAssetsCache.invalidate(serviceId,list).catch(()=>{});
    } finally {
      if (mounted.current && generation === sourcesGeneration.current) setSourcesLoading(false);
    }
  }, [request, ready, serviceId, t]);
  useEffect(() => { void reloadSources().catch(e => setError(t(messageOf(e)))); const changed = () => { void reloadSources().catch(e => { if (mounted.current) setError(t(messageOf(e))); }); }; window.addEventListener('openworkgraph:data-sources-changed', changed); return () => { ++sourcesGeneration.current; window.removeEventListener('openworkgraph:data-sources-changed', changed); }; }, [reloadSources]);
  useEffect(()=>{if(sourceId)void remoteAssetsCache.selectSource(serviceId,sourceId).catch(()=>{});},[serviceId,sourceId]);
  const source = sources.find(s => s.id === sourceId);
  useEffect(() => { setSearch(''); }, [serviceId, sourceId, source?.locationRevision, location?.path]);
  useEffect(() => {
    const current = ++navigation.current; if (!source) { setLocation(undefined); return; }
    const scope = { serviceId, sourceId: source.id, locationRevision: source.locationRevision }; setLocation(undefined);
    void remoteAssetsCache.lastPath(scope).catch(() => '').then(path => { if (current === navigation.current && mounted.current) setLocation({ sourceId: source.id, locationRevision: source.locationRevision, path: path ?? '' }); });
  }, [serviceId, source?.id, source?.locationRevision]);
  useEffect(() => {
    if (!location || !source || location.sourceId !== source.id || location.locationRevision !== source.locationRevision || !visible) return;
    const current = ++generation.current; let live = true; setError(''); setLoading(true);
    const scope = { serviceId, ...location };
    void (async () => {
      const history = await remoteAssetsCache.read(scope, location.path).catch(() => undefined);
      if (!live || current !== generation.current) return;
      setView(history); void remoteAssetsCache.remember(scope, location.path).catch(() => {});
      if (!ready) { setLoading(false); return; }
      try {
        const listing = await request<RemoteListing>('/v1/data-sources/' + source.id + '/list', { path: location.path, locationRevision: location.locationRevision });
        if (!live || current !== generation.current) return;
        setView(listing); try { await remoteAssetsCache.save(listing); } catch { if (live) setError(t('History could not be saved.')); }
      } catch (e) { if (live && current === generation.current) setError(t(messageOf(e))); }
      finally { if (live && current === generation.current) setLoading(false); }
    })(); return () => { live = false; };
  }, [location, source?.id, source?.locationRevision, serviceId, visible, ready, refresh, request, t]);
  // Source changes are event driven; directories never poll or refresh on transfer events.
  void refreshToken;
  const listing = view && location && view.serviceId === serviceId && view.sourceId === sourceId && view.locationRevision === location.locationRevision && view.path === location.path ? view : undefined;
  const initialLoading = visible && !listing && (sourcesLoading || !!source && !location || loading);
  const navigate = (path: string) => { if (source) { ++generation.current; setLocation({ sourceId: source.id, locationRevision: source.locationRevision, path }); } };
  const act = async (entry: RemoteEntry, action: 'graph' | 'library' | 'download', position?: Point) => {
    if (!source || !listing || !ready || (action !== 'download' && mutationsBlocked) || (action === 'graph' && !graphWritable)) return;
    const pendingKey = JSON.stringify([source.id, listing.locationRevision, entry.path]); if (activeActions.current.has(pendingKey)) return; activeActions.current.add(pendingKey);
    const origin = { id: source.id, revision: listing.locationRevision, path: entry.path };
    setPending(old => new Map(old).set(pendingKey, { entry, action })); setActionError('');
    try {
      if (action === 'download') {
        const blob = await request<Blob>('/v1/data-sources/' + origin.id + '/download?' + new URLSearchParams({ path: origin.path, locationRevision: String(origin.revision) }), undefined, 'BLOB');
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = entry.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else {
        const captured = await getTarget(action);
        const size = defaultWorkgraphNodeSize('file');
        const to = action === 'library' ? { kind: 'library' as const, projectId: captured.projectId } : position && captured.kind !== 'library' ? { ...captured, x: position.x - size.width / 2, y: position.y - size.height / 2 } : captured;
        const job = await request<RemoteTransfer>('/v1/remote-transfers', { idempotencyKey: randomId(), sourceId: origin.id, locationRevision: origin.revision, path: origin.path, target: to });
        window.dispatchEvent(new CustomEvent('openworkgraph:remote-transfers-changed', { detail: { serviceId, job, payload: { state: job.state } } }));
      }
    } catch (e) { if (mounted.current) setActionError(t(messageOf(e))); } finally { activeActions.current.delete(pendingKey); if (mounted.current) setPending(old => { const next = new Map(old); next.delete(pendingKey); return next; }); }
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = listing?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(query)) ?? [];
  const entries = [...matches.filter(entry => entry.kind === 'directory'), ...matches.filter(entry => entry.kind !== 'directory')];
  const clearSearch = () => { setSearch(''); searchInput.current?.focus(); };
  return <section className="ow-project-files-panel remote-assets-browser" aria-label={t('Remote assets')}>
    <NotificationQueue items={[...pending].filter(([, value]) => value.action !== 'download').map(([id, { entry }]) => ({
      id, kind: 'progress', duration: null, className: 'remote-transfer-notification',
      content: <div className="remote-transfer-notice" data-state="submitting"><div className="remote-transfer-notice-title"><strong>{t('Loading asset')}</strong><span title={entry.path}>{entry.name}</span></div><progress aria-label={t('Loading asset') + ': ' + entry.path}/></div>,
    }))}/>
    <div className="remote-source-toolbar"><select aria-label={t('Select data source')} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="" disabled>{t('No data sources')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><button type="button" aria-label={t('Data source settings')} title={t('Data source settings')} onClick={onSettings}><Settings2 size={18}/></button><button type="button" disabled={!source || !ready} aria-label={t('Refresh')} title={t('Refresh')} onClick={() => setRefresh(x => x + 1)}><RefreshCw size={18}/></button></div>
    <label className="remote-assets-search"><Search size={15} aria-hidden="true"/><input ref={searchInput} type="search" aria-label={t('Search current page')} placeholder={t('Search current page')} value={search} disabled={!source || !location} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); clearSearch(); } }}/>{search && <button type="button" aria-label={t('Clear current page search')} onClick={clearSearch}><X size={14} aria-hidden="true"/></button>}</label>
    {source && location && <nav className="remote-breadcrumbs" aria-label={t('Root directory')}>
      <ol>
        <li><button type="button" aria-current={!location.path ? 'location' : undefined} onClick={() => navigate('')}>{t('Root')}</button></li>
        {location.path.split('/').filter(Boolean).map((segment, i, parts) => <li key={i}><ChevronRight size={12} aria-hidden="true"/><button type="button" title={segment} aria-current={i === parts.length - 1 ? 'location' : undefined} onClick={() => navigate(parts.slice(0, i + 1).join('/'))}>{segment}</button></li>)}
      </ol>
    </nav>}
    {error && <p role="alert">{error}</p>}{actionError && <p role="alert">{actionError}</p>}
    {source && location && <div className="ow-project-file-grid remote-assets-grid" aria-busy={loading}>
      {location.path && <button className="ow-project-file-tile ow-project-file-parent remote-parent-directory" type="button" aria-label={t('Back to parent directory')} onClick={() => navigate(location.path.split('/').slice(0, -1).join('/'))}><span className="ow-project-file-tile-icon"><ArrowUp size={24} aria-hidden="true"/></span><span className="ow-project-file-label">{t('Go up one level')}</span></button>}
      {entries.map(entry => <article key={JSON.stringify([location.sourceId, location.locationRevision, entry.path])} className="ow-project-file-tile-wrap remote-asset-card" data-kind={entry.kind}
        draggable={entry.kind === 'file' && dragAllowed.current && !pending.has(JSON.stringify([source.id, location.locationRevision, entry.path]))}
        onDragStart={event => {
          if (entry.kind !== 'file' || !dragAllowed.current || activeActions.current.has(JSON.stringify([source.id, location.locationRevision, entry.path])) || (event.target as Element).closest('.remote-entry-actions')) { event.preventDefault(); return; }
          cancelDrag.current?.();
          const endDrag = beginAssetDrag(event.dataTransfer, dragContext, position => {
            if (mounted.current && dragAllowed.current) void act(entry, 'graph', position);
          });
          const clearPreview = setFileDragPreview(event.dataTransfer, event.currentTarget);
          cancelDrag.current = () => { endDrag(); clearPreview(); };
        }}
        onDragEnd={() => { cancelDrag.current?.(); cancelDrag.current = undefined; }}>
      {entry.kind === 'directory' ? <button className="ow-project-file-tile remote-entry-main" type="button" title={entry.name} onClick={() => navigate(entry.path)} aria-label={entry.name}><Thumbnail entry={entry} source={source} request={request} enabled={visible && ready}/><span className="ow-project-file-label">{entry.name}</span><span className="ow-project-file-tile-meta">{t('Folder')}</span></button> : <button className="ow-project-file-tile remote-entry-main" type="button" aria-label={t('Preview: {name}', { name: entry.name })} title={entry.name} disabled={entry.kind !== 'file' || !ready} onClick={() => setPreview({ sourceId: source.id, locationRevision: source.locationRevision, entry })}><Thumbnail entry={entry} source={source} request={request} enabled={visible && ready}/><span className="ow-project-file-label">{entry.name}</span>{entry.bytes !== null && <span className="ow-project-file-tile-meta">{formatFileSize(entry.bytes)}</span>}{entry.kind === 'unavailable' && <span className="remote-entry-error" role="status">{entry.error ? t(entry.error) : t('Unavailable remote entry')}</span>}</button>}
      {entry.kind === 'file' && <div className="remote-entry-actions"><button className="ow-project-file-add" type="button" disabled={!ready || !graphWritable || mutationsBlocked || pending.has(JSON.stringify([source.id, location.locationRevision, entry.path]))} aria-label={t('Add to Work Graph') + ': ' + entry.name} title={t('Add to Work Graph')} onClick={() => void act(entry, 'graph')}><Plus size={16}/></button><button className="ow-project-file-add" type="button" disabled={!ready || mutationsBlocked || pending.has(JSON.stringify([source.id, location.locationRevision, entry.path]))} aria-label={t('Copy to local assets') + ': ' + entry.name} title={t('Copy to local assets')} onClick={() => void act(entry, 'library')}><Copy size={16}/></button><button className="ow-project-file-add" type="button" disabled={!ready || pending.has(JSON.stringify([source.id, location.locationRevision, entry.path]))} aria-label={t('Download') + ': ' + entry.name} title={t('Download')} onClick={() => void act(entry, 'download')}><Download size={16}/></button></div>}
    </article>)}</div>}
    {initialLoading && <div className="remote-assets-loading" role="status" aria-label={t('Loading…')}><LoaderCircle size={28} aria-hidden="true"/></div>}
    {preview && <RemoteAssetPreviewDialog key={JSON.stringify([preview.sourceId, preview.locationRevision, preview.entry.path])} request={request} {...preview} onClose={() => setPreview(undefined)}/>}
    {listing && !entries.length && <div className="remote-assets-empty" role="status">{query ? <Search size={28} aria-hidden="true"/> : <Folder size={28} aria-hidden="true"/>}<p>{t(query ? 'No matches on the current page' : 'Empty directory')}</p></div>}
  </section>;
}
