import { useEffect, useState, useRef, useId } from 'react';
import type { RemoteTransferTarget } from '../../../packages/protocol/src/remote-assets';
import { useI18n } from '../i18n/I18nProvider';
import { ResourcesPanel, type ResourcesPanelProps } from './ResourcesPanel';
import { RemoteAssetsPanel } from './RemoteAssetsPanel';
import type { Request } from './contracts';
import './RemoteAssets.css';
import './SidebarLibraryTabs.css';
type AssetLibraryTab = 'local' | 'remote';
const ASSET_LIBRARY_TAB_STORAGE_KEY = 'openworkgraph:asset-library-tab:v1';
function readAssetLibraryTab(): AssetLibraryTab {
  try { return localStorage.getItem(ASSET_LIBRARY_TAB_STORAGE_KEY) === 'remote' ? 'remote' : 'local'; }
  catch { return 'local'; }
}
export function AssetLibraryPanel(props: ResourcesPanelProps & { serviceId: string; remoteRequest: Request; visible: boolean; onSettings(): void; getRemoteTarget(action: 'graph' | 'library'): Promise<RemoteTransferTarget>; remoteMutationBlocked?: boolean }) {
  const { t } = useI18n(); const id = useId(); const [tab, setTab] = useState<AssetLibraryTab>(readAssetLibraryTab), [assetsRevision, setAssetsRevision] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem(ASSET_LIBRARY_TAB_STORAGE_KEY, tab); }
    catch { /* Asset browsing remains available without storage. */ }
  }, [tab]);
  useEffect(() => {
    const element = toolbar.current; if (!element) return;
    const update = () => element.parentElement?.style.setProperty('--asset-library-toolbar-height', element.getBoundingClientRect().height + 'px');
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.serviceId && detail.serviceId !== props.serviceId) return;
      if (detail?.payload?.state && detail.payload.state !== 'succeeded') return;
      setAssetsRevision(value => value + 1);
    };
    window.addEventListener('openworkgraph:remote-transfers-changed', changed);
    return () => window.removeEventListener('openworkgraph:remote-transfers-changed', changed);
  }, [props.serviceId]);
  return <div className="asset-library-panel">
    <div className="remote-library-toolbar" ref={toolbar}><div className="ow-library-tabs" role="tablist" aria-label={t('Asset library')} onKeyDown={event => { const keys=['ArrowLeft','ArrowRight','Home','End']; if(!keys.includes(event.key)) return; event.preventDefault(); const next=event.key==='Home'?'local':event.key==='End'?'remote':tab==='local'?'remote':'local'; setTab(next); event.currentTarget.querySelector<HTMLButtonElement>('[data-tab="'+next+'"]')?.focus(); }}><button id={id+'-local'} data-tab="local" aria-controls={id+'-local-panel'} tabIndex={tab === 'local'?0:-1} role="tab" aria-selected={tab === 'local'} type="button" onClick={() => setTab('local')}>{t('Local assets')}</button><button id={id+'-remote'} data-tab="remote" aria-controls={id+'-remote-panel'} tabIndex={tab === 'remote'?0:-1} role="tab" aria-selected={tab === 'remote'} type="button" onClick={() => setTab('remote')}>{t('Remote assets')}</button></div></div>
    <div id={id+'-local-panel'} aria-labelledby={id+'-local'} hidden={tab !== 'local'} role="tabpanel"><ResourcesPanel {...props} refreshToken={(props.refreshToken ?? 0) + assetsRevision}/></div>
    <div id={id+'-remote-panel'} aria-labelledby={id+'-remote'} hidden={tab !== 'remote'} role="tabpanel"><RemoteAssetsPanel request={props.remoteRequest} serviceId={props.serviceId} ready={!!props.ready} visible={props.visible && tab === 'remote'} onSettings={props.onSettings} getTarget={props.getRemoteTarget} dragContext={{ request: props.request, projectId: props.projectId, graphId: props.graphId }} mutationsBlocked={props.remoteMutationBlocked} graphWritable={!props.readOnly}/></div>
  </div>;
}
