import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArrowLeft, ArrowLeftRight, Bot, Download, Folder, HardDrive, Image, Link, Palette, Pencil, Plus, RotateCcw, Unplug, X } from 'lucide-react';
import { ConnectionRegistry, RUNTIME_NAME_MAX_LENGTH, type Connection } from '../adapter/connections';
import { LifecycleCancelledError, Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import type { LanguagePreference } from '../i18n/core';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { runtimeNeedsUpgrade } from '../domain/runtime-version';
import { workspaceAgentStore } from './agent-state';
import { ManagementPanel, type ManagementPage } from './ManagementPanel';
import { WorkspaceCombobox } from './WorkspaceCombobox';
import { WorkspacePairing } from './WorkspacePairing';
import { WelcomeCommand } from './WelcomeCommand';
import { messageOf, type Request } from './contracts';
import webClientPackage from '../../package.json';
import '../i18n/catalogs/settings';
import './SettingsDialog.css';

type SettingsPage = 'general' | 'connect' | ManagementPage;
export interface SettingsEntry { workspaceId: string; page: ManagementPage; sequence: number }
interface SettingsDialogProps {
  open: boolean; registry: ConnectionRegistry; connections: Connection[];
  defaultWorkspaceId: string; entry?: SettingsEntry;
  context: { serviceId: string; projectId?: string; graphId?: string };
  onlineWorkspaceIds: string[]; theme: 'dark' | 'light';
  updatingWorkspaceId?: string;
  onThemeChange(theme: 'dark' | 'light'): void; onClose(): void;
  onChanged(): void; onModelsChanged(): void; onError(error: unknown): void;
  onDisconnect(connection: Connection): void; onUpdate(connection: Connection): Promise<void>;
}
const pages = [
  { id: 'projects', title: 'Projects', icon: Folder },
  { id: 'agents', title: 'Agent', icon: Bot },
  { id: 'data-sources', title: 'Data sources', icon: Folder },
  { id: 'images', title: 'Image generation', icon: Image },
  { id: 'transfer', title: 'Import and export', icon: ArrowLeftRight },
  { id: 'storage', title: 'Storage', icon: HardDrive },
  { id: 'backups', title: 'Backups and restore', icon: Archive },
  { id: 'sessions', title: 'Connections and sessions', icon: Link },
] as const;

/** Settings have their own Workspace scope; browsing them never navigates the Work Graph. */
export function SettingsDialog(props: SettingsDialogProps) {
  const { t, preference, setPreference } = useI18n();
  const [page, setPage] = useState<SettingsPage>('general');
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [rename, setRename] = useState<string>();
  const [leave, setLeave] = useState<(() => void)>();
  const [disconnect, setDisconnect] = useState<Connection>();
  const [contentRevision, setContentRevision] = useState(0);
  const [transferTarget, setTransferTarget] = useState<{ workspaceId: string; projectId: string }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const selection = useRef(0);
  const latest = useRef(props); latest.current = props;
  const selected = props.connections.find(item => item.serviceId === workspaceId);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const lastEntry = useRef<SettingsEntry | undefined>(undefined);
  const initialized = useRef(false);
  const online = !!selected && props.onlineWorkspaceIds.includes(selected.serviceId);
  const resetDraft = useCallback(() => { setDirty(false); setBusy(false); setRename(undefined); setError(''); setContentRevision(value => value + 1); selection.current++; }, []);
  useEffect(() => {
    if (!props.open) return;
    if (props.entry && props.entry !== lastEntry.current) {
      lastEntry.current = props.entry;
      setWorkspaceId(props.entry.workspaceId); setPage(props.entry.page); resetDraft(); initialized.current = true;
    } else if (!initialized.current) {
      setWorkspaceId(props.defaultWorkspaceId || props.connections[0]?.serviceId || '');
      setPage(props.connections.length ? 'projects' : 'general'); initialized.current = true;
    }
  }, [props.open, props.entry, props.defaultWorkspaceId, props.connections, resetDraft]);
  useEffect(() => {
    if (!props.open || !workspaceId || selected) return;
    setWorkspaceId(''); resetDraft();
  }, [props.open, workspaceId, selected, resetDraft]);
  useEffect(() => {
    const element = dialog.current!;
    if (!props.open) { if (element.open) element.close(); return; }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!element.open) element.showModal();
    closeButton.current?.focus();
    return () => {
      if (element.open) element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [props.open]);
  const change = (action: () => void) => {
    if (busy) return;
    if (dirty || (rename !== undefined && rename !== (selected?.runtimeName || ''))) setLeave(() => action);
    else { resetDraft(); action(); }
  };
  const selectPage = (next: SettingsPage) => { if (next !== page) change(() => setPage(next)); };
  const selectWorkspace = (id: string) => { if (id !== workspaceId) change(() => { setWorkspaceId(id); if (page === 'connect' || page === 'add') setPage('projects'); }); };
  const transport = useMemo(() => selected && selected.status !== 'invalid' ? new Transport(props.registry, selected.serviceId) : undefined,
    [props.registry, selected?.serviceId, selected?.generation, selected?.session.id]);
  const request = useMemo<Request>(() => async <T,>(path: string, body?: unknown, method?: string, options?: Parameters<Request>[3]) => {
    if (!transport || selectedRef.current?.serviceId !== transport.serviceId) throw new LifecycleCancelledError();
    const epoch = selection.current;
    const writing = method !== 'GET' && method !== 'BLOB' && method !== 'RANGE';
    if (writing && !latest.current.onlineWorkspaceIds.includes(transport.serviceId)) throw new Error(t('The Workspace is offline or reconciling its snapshot. Editing, uploading, and running are unavailable.'));
    const result = await transport.request<T>(path, body, method, options);
    if (epoch !== selection.current || selectedRef.current?.serviceId !== transport.serviceId) throw new LifecycleCancelledError();
    return result;
  }, [transport, t]);
  const agentStore = useMemo(() => selected?.status === 'paired' ? workspaceAgentStore(props.registry, selected.serviceId) : undefined,
    [props.registry, selected?.serviceId, selected?.generation, selected?.session.id, selected?.status]);
  const report = (reason: unknown) => { setError(messageOf(reason)); props.onError(reason); };
  const reconnect = async () => {
    if (!selected || busy) return;
    const id = selected.serviceId; setBusy(true); setError('');
    try { await props.registry.restore([id]); } catch (reason) { report(reason); } finally { setBusy(false); }
  };
  const isCurrentWorkspace = selected?.serviceId === props.context.serviceId;
  const selectedProjectId = page === 'transfer' && transferTarget?.workspaceId === selected?.serviceId
    ? transferTarget?.projectId : isCurrentWorkspace ? props.context.projectId : undefined;
  const managementPage = page !== 'general' && page !== 'connect' ? page : undefined;
  const scopeKey = `${selected?.serviceId}:${selected?.generation}:${selected?.session.id}:${contentRevision}`;
  const management = selected && selected.status !== 'invalid' && managementPage && <ManagementPanel
    key={scopeKey} embedded page={managementPage} onPageChange={next => selectPage(next)} request={request}
    agentStore={agentStore} readOnly={!online} onBusyChange={setBusy} onDirtyChange={setDirty}
    projectId={selectedProjectId} graphId={isCurrentWorkspace && selectedProjectId === props.context.projectId ? props.context.graphId : undefined}
    onProjectChange={id => change(() => setTransferTarget({ workspaceId: selected.serviceId, projectId: id }))}
    onChanged={props.onChanged} onModelsChanged={props.onModelsChanged}
    onRestoreStarted={status => props.registry.setMaintenance(selected.serviceId, status)} onError={report}/>;
  return createPortal(<dialog ref={dialog} id="global-settings-dialog" className="settings-dialog" aria-labelledby="global-settings-title"
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); change(props.onClose); }}
    onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) change(props.onClose); } }}>
    <header className="settings-dialog-header"><h2 id="global-settings-title">{t('Settings')}</h2><button ref={closeButton} type="button" className="settings-close" disabled={busy} aria-label={t('Close settings')} onClick={() => change(props.onClose)}><X size={20} aria-hidden="true"/></button></header>
    {props.open && <div className="settings-dialog-layout">
      <nav className="settings-navigation" aria-label={t('Settings categories')}>
        <div className="settings-general-navigation"><p className="settings-group-label">{t('General')}</p>
          <button type="button" disabled={busy} className="settings-nav-item" aria-current={page === 'general' ? 'page' : undefined} onClick={() => selectPage('general')}><Palette size={18} aria-hidden="true"/>{t('Appearance and language')}</button>
        </div>
        <div className="settings-workspace-selection"><p className="settings-group-label">{t('Workspace')}</p>
          <WorkspaceCombobox connections={props.connections} value={workspaceId} disabled={busy} onChange={selectWorkspace} onConnect={() => selectPage('connect')}/>
        </div>
        <div className="settings-workspace-navigation">{pages.map(item => <button key={item.id} type="button" disabled={busy} className="settings-nav-item"
          aria-current={page === item.id || (item.id === 'projects' && page === 'add') ? 'page' : undefined} onClick={() => selectPage(item.id)}>
          <item.icon size={18} aria-hidden="true"/><span>{t(item.title)}</span>
        </button>)}</div>
      </nav>
      <div className="settings-content" key={`${workspaceId}:${page}`} aria-busy={busy}>
        {error && <p className="settings-error" role="alert">{error}</p>}
        {page === 'general' ? <section className="settings-general"><h3>{t('Appearance and language')}</h3>
          <label className="settings-preference-row"><span>{t('Theme')}</span><select value={props.theme} onChange={event => props.onThemeChange(event.target.value as 'dark' | 'light')}><option value="dark">{t('Dark')}</option><option value="light">{t('Light')}</option></select></label>
          <label className="settings-preference-row"><span>{t('Language')}</span><select value={preference} onChange={event => setPreference(event.target.value as LanguagePreference)}><option value="system">{t('Follow system')}</option><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        </section> : page === 'connect' ? <section className="settings-connect">
          <header className="settings-page-header"><button type="button" className="settings-close" aria-label={t('Back')} onClick={() => selectPage(selected ? 'sessions' : 'general')}><ArrowLeft size={20}/></button><h3>{t('Connect new Workspace')}</h3></header>
          <WorkspacePairing registry={props.registry} onDirtyChange={setDirty} onError={report} onPaired={id => { resetDraft(); setWorkspaceId(id); setPage('projects'); props.onChanged(); }}/>
        </section> : !selected ? <section className="settings-empty"><h3>{t(pages.find(item => item.id === page)?.title ?? 'Projects')}</h3><p>{t(props.connections.length ? 'Select a Workspace to configure' : 'No Workspace connected')}</p>
          <button type="button" className="settings-primary" onClick={() => selectPage('connect')}><Plus size={16}/>{t('Connect new Workspace')}</button>
        </section> : <>
          {(page === 'sessions' || selected.status === 'invalid') && <section className="settings-connection">
            <h3>{t('Connections and sessions')}</h3>
            <div className="settings-connection-name">{rename === undefined ? <><strong>{selected.runtimeName || selected.address}</strong><button type="button" className="settings-close" disabled={busy} aria-label={t('Rename Workspace')} onClick={() => setRename(selected.runtimeName || '')}><Pencil size={16}/></button></> :
              <form onSubmit={event => { event.preventDefault(); try { props.registry.renameRuntime(selected.serviceId, rename, selected.session.id); setRename(undefined); } catch (reason) { report(reason); } }}>
                <label>{t('Workspace name')}<input autoFocus maxLength={RUNTIME_NAME_MAX_LENGTH} value={rename} placeholder={selected.address} onChange={event => setRename(event.target.value)}/></label>
                <button type="submit">{t('Save')}</button><button type="button" onClick={() => setRename(undefined)}>{t('Cancel')}</button>
              </form>}
            </div>
            {selected.runtimeName && <p className="settings-connection-address">{selected.address}</p>}
            {selected.status === 'invalid' && <p role="status">{t('Session expired. Pair again.')}</p>}
            {selected.status === 'offline' && <p role="status">{t('Offline')}</p>}
            {runtimeNeedsUpgrade(selected.info.version, webClientPackage.version) && <div className="settings-upgrade">
              <p>{t('Upgrade Workspace v{runtimeVersion} to v{clientVersion}', { runtimeVersion: selected.info.version, clientVersion: webClientPackage.version })}</p>
              {selected.info.installation === 'npx' && <><p>{t('Run this command on the Workspace device to restart with the latest version. Restarting cancels active and queued tasks; finish your tasks first.')}</p><WelcomeCommand command="npx openworkgraph@latest restart" label={t('Workspace upgrade command')} copyLabel={t('Copy Workspace upgrade command')}/></>}
              {selected.info.installation === 'npm-global' && <button type="button" disabled={!online || !!props.updatingWorkspaceId || busy} onClick={() => void props.onUpdate(selected)}><Download size={16}/>{t(props.updatingWorkspaceId === selected.serviceId ? 'Updating Workspace…' : 'Update Workspace')}</button>}
            </div>}
            <div className="settings-connection-actions">
              {selected.status === 'offline' && <button type="button" disabled={busy} onClick={() => void reconnect()}><RotateCcw size={16}/>{t('Reconnect')}</button>}
              {selected.status === 'invalid' && <button type="button" onClick={() => selectPage('connect')}><Link size={16}/>{t('Pair again')}</button>}
              <button type="button" disabled={busy} onClick={() => change(() => setDisconnect(selected))}><Unplug size={16}/>{t('Disconnect')}</button>
            </div>
          </section>}
          {!online && selected.status !== 'invalid' && <div className="settings-offline" role="status"><span>{t('The Workspace is offline or reconciling its snapshot. Editing, uploading, and running are unavailable.')}</span><button type="button" disabled={busy} onClick={() => void reconnect()}>{t('Reconnect')}</button></div>}
          {management}
        </>}
      </div>
    </div>}
    {leave && <ConfirmationDialog title={t('Discard unsaved changes')} text={t('Discard unsaved changes and continue?')} onCancel={() => setLeave(undefined)} onConfirm={() => { const next = leave; setLeave(undefined); resetDraft(); next(); }}/>}
    {disconnect && <ConfirmationDialog title={t('Disconnect Workspace')} text={t('Disconnect “{name}” from this browser?', { name: disconnect.runtimeName || disconnect.address })} onCancel={() => setDisconnect(undefined)} onConfirm={() => { props.onDisconnect(disconnect); setDisconnect(undefined); resetDraft(); }}/>}
  </dialog>, document.body);
}
