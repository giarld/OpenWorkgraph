import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { randomId } from "../adapter/random";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Folder, FolderPlus, Plus, RefreshCw, CircleAlert, ArrowLeft, Monitor, Archive, ShieldCheck, SlidersHorizontal, Image, ArrowLeftRight, ChevronDown, Settings2, Pencil, HardDrive } from 'lucide-react';
import type { Backup, GraphBundle, ModelDefaults, Project, ProjectCandidates, Session, ExecutionSettings, SandboxMode, ImageProvider } from '../../../packages/protocol/src/index';
import { createWorkGraphArchive, readWorkGraphFile } from './workgraph-archive';
import { useI18n } from '../i18n/I18nProvider';
import './ManagementPanel.css';

export interface ManagementPanelProps {
  onBack?: () => void;
  initialPage?: 'projects' | 'add';
  runtimeAddress?: string;
  onRenameRuntime?: () => void;
  /** Authenticated transport. BLOB means HTTP GET decoded as Blob. */
  request: <T>(path: string, body?: unknown, method?: string, options?: { journal?: "session" | "memory" }) => Promise<T>;
  projectId?: string;
  graphId?: string;
  readOnly?: boolean;
  onChanged: () => void;
  onModelsChanged?: () => void;
  onError: (error: unknown) => void;
}
type Guidance = { localOnly: true; command: string };
type LocatedBackup = Backup & { location?: string };
type StorageCategory = 'database' | 'resources' | 'runs' | 'backups' | 'config' | 'staging' | 'other';
type StorageUsage = { totalBytes: number; categories: Record<StorageCategory, number>; measuredAt: string };
type StorageCleanup = { collectedResources: number; collectedBlobs: number; removedFiles: number; failedFiles: number; usage: StorageUsage };
const storageCategories: { key: StorageCategory; label: string }[] = [
  { key: 'database', label: 'Database' }, { key: 'resources', label: 'Resource files' },
  { key: 'runs', label: 'Task files' }, { key: 'backups', label: 'Backups' },
  { key: 'config', label: 'Configuration' }, { key: 'staging', label: 'Staging files' },
  { key: 'other', label: 'Other data' },
];
const formatSize = (bytes: number) => {
  if (bytes < 1024) return String(bytes) + ' B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
};
type Resource<T> = { data?: T; loading: boolean; error?: string };
type DiscoveredImageModel = { id: string; name: string; selected: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Request failed. Check the Workspace connection and try again.';
const encode = encodeURIComponent;
const localTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const twoDigits = (part: number) => String(part).padStart(2, '0');
  return date.getFullYear() + '-' + twoDigits(date.getMonth() + 1) + '-' + twoDigits(date.getDate()) + ' ' + twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes()) + ':' + twoDigits(date.getSeconds());
};

// Resource-local generations prevent retries/late responses from replacing newer data.
function useResource<T>(path: string, props: ManagementPanelProps, enabled = true) {
  const [state, setState] = useState<Resource<T>>({ loading: true });
  const generation = useRef(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  async function reload() {
    const ticket = ++generation.current;
    setState({ loading: true });
    try {
      const data = await callbacks.current.request<T>(path, undefined, 'GET');
      if (ticket === generation.current) setState({ data, loading: false });
    } catch (error) {
      if (ticket === generation.current) {
        setState({ loading: false, error: message(error) });
        callbacks.current.onError(error);
      }
    }
  }
  useEffect(() => { if (enabled) void reload(); return () => { generation.current++; }; }, [path, enabled]);
  return { ...state, reload };
}
function Status({ value, retry }: { value: Resource<unknown>; retry: () => void }) {
  const { t } = useI18n();
  return value.loading ? <p role="status">{t('Loading…')}</p> : value.error ? <div role="status">{t('Loading failed: {error}', { error: value.error })}<button type="button" onClick={retry}>{t('Retry loading')}</button></div> : null;
}
function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/** Parent must key this component by service identity. It never owns service authentication. */
export function ManagementPanel(props: ManagementPanelProps) {
  const { t } = useI18n();
  const { projectId, graphId } = props;
  const [page, setPage] = useState<'projects' | 'add' | 'settings'>(props.initialPage ?? 'projects');
  const [manualOpen, setManualOpen] = useState(false);
  const manualDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (manualOpen) manualDialog.current?.showModal(); else manualDialog.current?.close(); }, [manualOpen]);
  const projects = useResource<Project[]>('/v1/projects/all', props);
  const candidates = useResource<ProjectCandidates>('/v1/project-candidates', props, page === 'add');
  const sessions = useResource<Session[]>('/v1/sessions', props, page === 'settings');
  const backups = useResource<LocatedBackup[]>('/v1/backups', props, page === 'settings');
  const storage = useResource<StorageUsage>('/v1/storage', props, page === 'settings');
  const guidance = useResource<Guidance>('/v1/restore-guidance', props, page === 'settings');
  const models = useResource<ModelDefaults>('/v1/models', props, page === 'settings');
  const execution = useResource<ExecutionSettings>('/v1/execution-settings', props, page === 'settings');
  const imageProviders = useResource<ImageProvider[]>('/v1/image-providers', props, page === 'settings');
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [providerEndpoint, setProviderEndpoint] = useState('https://api.openai.com');
  const [providerEnabled, setProviderEnabled] = useState(true);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredImageModel[]>([]);
  const [imageSecret, setImageSecret] = useState('');
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write');
  useEffect(() => { if (execution.data) setSandbox(execution.data.sandboxMode); }, [execution.data]);
  const [path, setPath] = useState('');
  const [repair, setRepair] = useState<{ id: string; path: string }>();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [file, setFile] = useState<File>();
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => void }>();
  const mounted = useRef(false);
  const lock = useRef(false);
  const backupKey = useRef<string | undefined>(undefined);
  const importAttempt = useRef<{ file: File; target: string; key: string } | undefined>(undefined);
  const latest = useRef(props); latest.current = props;
  const scope = JSON.stringify([projectId, graphId]);
  const scopeGeneration = useRef(0);
  const priorScope = useRef(scope);
  const scopeEffectReady = useRef(false);
  const pageEffectReady = useRef(false);
  const writeGeneration = useRef(0);
  const priorReadOnly = useRef(Boolean(props.readOnly));
  if (priorReadOnly.current !== Boolean(props.readOnly)) {
    priorReadOnly.current = Boolean(props.readOnly);
    if (props.readOnly) writeGeneration.current++;
  }
  if (priorScope.current !== scope) { priorScope.current = scope; scopeGeneration.current++; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!scopeEffectReady.current) { scopeEffectReady.current = true; return; }
    setFile(undefined); setConfirmation(undefined); setNotice(''); setFailure('');
  }, [scope]);
  useEffect(() => {
    if (!pageEffectReady.current) { pageEffectReady.current = true; return; }
    setFile(undefined); setConfirmation(undefined);
  }, [page]);
  useEffect(() => { if (revoked) props.onError(new Error(t('The current browser session was revoked. Pair again to use management features.'))); }, [revoked, props.onError, t]);
  useEffect(() => {
    setModel(models.data?.selection?.model ?? '');
    setEffort(models.data?.selection?.reasoningEffort ?? '');
  }, [models.data]);
  const selectedProject = projects.data?.find(p => p.projectId === projectId);
  const selectedModel = models.data?.available.find(m => m.id === model);
  const selectedProvider = imageProviders.data?.find(p => p.id === providerId);
  useEffect(() => {
    if(!selectedProvider)return;
    setProviderName(selectedProvider.name);setProviderEndpoint(selectedProvider.endpoint);setProviderEnabled(selectedProvider.enabled);
  },[selectedProvider?.id,selectedProvider?.revision]);
  useEffect(() => {
    setDiscoveredModels([]);
  },[selectedProvider?.id]);

  async function act(label: string, work: (valid: () => boolean) => Promise<void>, scoped = false, writing = true) {
    if (lock.current || revoked || (writing && latest.current.readOnly)) return;
    lock.current = true; setBusy(label); setNotice(''); setFailure('');
    const startedScope = scopeGeneration.current;
    const startedWrite = writeGeneration.current;
    const valid = () => mounted.current && (!scoped || startedScope === scopeGeneration.current) && (!writing || (!latest.current.readOnly && startedWrite === writeGeneration.current));
    try { await work(valid); } catch (error) {
      if (valid()) { setFailure(t('{action} failed: {error}', { action: label, error: message(error) })); latest.current.onError(error); }
    } finally { lock.current = false; if (mounted.current) setBusy(''); }
  }
  async function mutate(label: string, endpoint: string, body: unknown, reload: () => Promise<void>, method = 'POST') {
    await act(label, async valid => {
      await props.request(endpoint, body, method);
      if (!valid()) return;
      setNotice(t('{action} was confirmed by the Workspace.', { action: label })); latest.current.onChanged();
      if (endpoint === '/v1/models') latest.current.onModelsChanged?.();
      await reload();
    });
  }
  async function addProject(directory: string) {
    if (!directory) return;
    await act(t('Register project'), async valid => {
      await props.request('/v1/projects', { path: directory }, 'POST');
      if (!valid()) return;
      latest.current.onChanged();
      await projects.reload();
      if (!valid()) return;
      setManualOpen(false); setPath(''); setPage('projects');
      setNotice(t('Project added. The project list has been refreshed.'));
    });
  }
  function confirm(text: string, run: () => void) { if (!latest.current.readOnly) setConfirmation({ text, run }); }
  const disabled = Boolean(busy) || revoked;
  const writeDisabled = disabled || Boolean(props.readOnly);
  const resourceSummary = (value: Resource<unknown>, summary: string) => value.loading ? t('Loading…') : value.error ? t('Loading failed · Expand to retry') : summary;
  const settingsSections = {
    'Agent permissions': { icon: ShieldCheck, group: t('Agents and models'), summary: resourceSummary(execution, t('{mode} · Applies to new tasks', { mode: { 'read-only': t('Read-only'), 'workspace-write': t('Workspace write'), 'danger-full-access': t('Full access') }[execution.data?.sandboxMode ?? 'workspace-write'] })) },
    'Workspace default model': { icon: SlidersHorizontal, summary: resourceSummary(models, models.data?.selection?.model ?? t('No default model set')) },
    'Image generation agent · API providers': { icon: Image, summary: resourceSummary(imageProviders, imageProviders.data?.length ? t('{count} providers · Independent image generation settings', { count: imageProviders.data.length }) : t('Add providers, credentials, and image models')) },
    'Work Graph import and export': { icon: ArrowLeftRight, group: t('Data and backups'), summary: t('Import or export ZIP Work Graph packages') },
    'Storage data management': { icon: HardDrive, summary: resourceSummary(storage, storage.data ? t('Workspace data: {size}', { size: formatSize(storage.data.totalBytes) }) : t('View Workspace storage and clean unused resource copies')) },
    'Workspace backups and local restore': { icon: Archive, summary: resourceSummary(backups, backups.data?.length ? t('{count} backups · Local restore', { count: backups.data.length }) : t('Back up the entire Workspace and view local restore guidance')) },
    'Browser sessions': { icon: Monitor, group: t('Connections and access'), summary: resourceSummary(sessions, t('{count} browser sessions · View and revoke', { count: sessions.data?.length ?? 0 })) },
  } satisfies Record<string, { icon: typeof Monitor; summary: string; group?: string }>;
  function section(title: keyof typeof settingsSections, children: ReactNode) {
    if (page !== 'settings') return null;
    const item = settingsSections[title];
    const Icon = item.icon;
    return <section className="management-setting-section">
      {'group' in item && <h3 className="management-setting-group">{item.group}</h3>}
      <details className="management-setting">
        <summary><span className="management-setting-icon"><Icon size={18} aria-hidden="true" /></span><span className="management-setting-copy"><strong>{t(title)}</strong><span>{item.summary}</span></span><ChevronDown className="management-setting-chevron" size={16} aria-hidden="true" /></summary>
        <div className="management-setting-body">{children}</div>
      </details>
    </section>;
  }

  return <div className="management-panel" aria-label={t('Workspace management')}>
    <header>
      <nav className="management-navigation" aria-label={t('Workspace management navigation')}>
        <button className="management-back" type="button" aria-label={page === 'projects' ? t('Back to Workspace list') : t('Back to project management')} title={page === 'projects' ? t('Back to Workspace list') : t('Back to project management')} disabled={Boolean(busy)} hidden={page === 'projects' && !props.onBack} onClick={() => { if (page === 'projects') props.onBack?.(); else { setPage('projects'); setConfirmation(undefined); setFailure(''); } }}><ArrowLeft size={20} aria-hidden="true" /></button>
        <h2>{page === 'projects' ? t('Project management') : page === 'add' ? t('Add project') : t('More management')}</h2>
      </nav>
      {props.runtimeAddress && <code>{props.runtimeAddress}</code>}
      <p>{page === 'add' ? t('Choose an existing project or add a directory manually.') : page === 'settings' ? t('Expand settings as needed to manage Workspace capabilities and data.') : t('Manage projects and work content for this Workspace.')}</p>
    </header>
    <div aria-live="polite">{busy && <p role="status">{t('{action}…', { action: busy })}</p>}{notice && <p role="status">{notice}</p>}{failure && !manualOpen && <p role="alert">{failure}</p>}</div>
    {props.readOnly && <p role="status">{t('Read-only: registration, changes, revocation, creation, and import are disabled. Refresh, viewing, and downloads remain available.')}</p>}
    {revoked && <p role="status">{t('The current browser session was revoked. Pair again to use management features.')}</p>}
    {confirmation && <ConfirmationDialog title={t('Confirm management action')} text={confirmation.text} disabled={writeDisabled}
      onCancel={() => setConfirmation(undefined)} onConfirm={() => { const run = confirmation.run; setConfirmation(undefined); run(); }}/>}
    <fieldset disabled={disabled} className="management-controls">
    {page === 'add' && <section className="management-section" aria-label={t('Add project')}>
      <button className="candidate-manual" type="button" disabled={writeDisabled} onClick={() => { setPath(''); setFailure(''); setManualOpen(true); }}><FolderPlus size={16} aria-hidden="true" />{t('Add a new project directory')}</button>
      <div className="candidate-heading">
        <div><h3>{t('Existing Codex projects')}</h3>{candidates.data && <span>{t('{count} projects', { count: candidates.data.candidates.length })}</span>}</div>
        <button className="candidate-refresh" type="button" aria-label={t('Refresh Codex projects')} title={t('Refresh Codex projects')} disabled={candidates.loading} onClick={candidates.reload}><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
      <Status value={candidates} retry={candidates.reload} />
      {candidates.data && <><details className="candidate-source"><summary>{t('Project source')}</summary><p>{candidates.data.reason}</p></details>{candidates.data.candidates.length === 0 && <div className="management-empty"><Folder size={28} aria-hidden="true" /><strong>{t('No projects available to add')}</strong><p>{t('Use the option above to add a project directory manually.')}</p></div>}
        <ul className="candidate-list">{candidates.data.candidates.map(candidate => {
          const registered = projects.data?.some(project => project.canonicalPath === candidate.path);
          const available = candidate.availability === 'available';
          const name = candidate.path.split(/[\\/]/).filter(Boolean).at(-1) ?? candidate.path;
          return <li className="candidate-row" key={candidate.path}>
            <Folder className="candidate-folder" size={20} aria-hidden="true" />
            <div className="candidate-info">
              <strong>{name}</strong>
              <code className="candidate-path">{candidate.path}</code>
              <span className="candidate-state">{registered || available ? <Check size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}{registered ? t('Added to Workspace') : available ? t('Directory available') : t('Directory unavailable')}</span>
            </div>
            <button className="candidate-add" type="button" aria-label={registered ? t('Added') : t('Add this project')} title={registered ? t('This project is already added') : available ? t('Add {name}', { name }) : t('Directory unavailable')} disabled={writeDisabled || registered || !available} onClick={() => { void addProject(candidate.path); }}>{registered ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}</button>
          </li>;
        })}</ul></>}

    </section>}
    <dialog ref={manualDialog} className="management-directory-dialog" aria-labelledby="directory-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) setManualOpen(false); }} onClose={() => setManualOpen(false)}>
      <h3 id="directory-dialog-title">{t('Add project directory manually')}</h3>
      <form onSubmit={event => { event.preventDefault(); void addProject(path.trim()); }}>
        {failure && <p role="alert">{failure}</p>}
        <label>{t('Absolute directory path on Workspace')}<input placeholder={t('For example, D:\Projects\MyProject or /home/me/project')} disabled={writeDisabled} value={path} onChange={event => setPath(event.target.value)} required /></label>
        <p>{t('Enter an existing directory on the Workspace computer. No directory will be created.')}</p>
        <div className="management-form-actions"><button className="management-primary" disabled={writeDisabled || !path.trim()} type="submit">{t('Register project')}</button>
        <button disabled={disabled} type="button" onClick={() => setManualOpen(false)}>{t('Cancel')}</button></div>
      </form>
    </dialog>
    {page === 'projects' && <section className="management-section" aria-label={t('Registered projects')}>
      <div className="management-page-actions">
        <button className="management-primary" type="button" disabled={writeDisabled} onClick={() => { setNotice(''); setFailure(''); setPage('add'); }}><Plus size={16} aria-hidden="true" />{t('Add new project')}</button>
        <button type="button" onClick={() => setPage('settings')}><Settings2 size={16} aria-hidden="true" />{t('More management')}</button>
      </div>
      <Status value={projects} retry={projects.reload} />
      <div className="candidate-heading"><h3>{t('Registered projects')} <span>{projects.data?.length ?? 0}</span></h3><button className="candidate-refresh" type="button" aria-label={t('Refresh projects')} title={t('Refresh projects')} disabled={projects.loading} onClick={projects.reload}><RefreshCw size={16} aria-hidden="true" /></button></div>
      {projects.data?.length === 0 && <div className="management-empty"><FolderPlus size={28} aria-hidden="true" /><strong>{t('No projects yet')}</strong><p>{t('Select “Add project” to choose an existing project or enter a directory.')}</p></div>}
      <ul>{projects.data?.map(project => <li data-current={project.projectId === projectId} key={project.projectId}>
        <div className="management-item-heading"><Folder size={18} aria-hidden="true" /><strong>{project.name}</strong>{project.projectId === projectId && <span className="management-badge">{t('Current project')}</span>}</div><code>{project.canonicalPath}</code>
        <div className="management-item-meta"><span className="management-badge">{project.state === 'active' ? t('Enabled') : t('Disabled')}</span><span>{project.availability === 'available' ? t('Path available') : project.availability === 'unavailable' ? t('Path unavailable') : t('Path status unknown')}</span><span>{project.isGit ? 'Git' : t('Not Git')}</span></div>
        <div className="management-actions"><button type="button" disabled={writeDisabled} onClick={() => confirm(t('{action} project “{name}”? Disabled projects are read-only, and the Workspace will reject disabling a project with unfinished tasks.', { action: project.state === 'active' ? t('Disable') : t('Enable'), name: project.name }), () => { void mutate(t('Update project state'), `/v1/projects/${encode(project.projectId)}/state`, { state: project.state === 'active' ? 'inactive' : 'active' }, projects.reload); })}>{project.state === 'active' ? t('Disable project') : t('Enable project')}</button>
        <button type="button" disabled={writeDisabled || project.state !== 'active'} onClick={() => setRepair({ id: project.projectId, path: project.canonicalPath })}>{t('Change path')}</button></div>
        {repair?.id === project.projectId && <form onSubmit={event => { event.preventDefault(); const nextPath = repair.path.trim(); confirm(t('Change the path for “{name}” to {path}? This will not move the directory or files.', { name: project.name, path: nextPath }), () => { void mutate(t('Change project path'), `/v1/projects/${encode(project.projectId)}/path`, { path: nextPath }, projects.reload); }); }}>
          <label>{t('New absolute directory path')}<input disabled={writeDisabled} required value={repair.path} onChange={event => setRepair({ id: project.projectId, path: event.target.value })} /></label>
          <button type="submit" disabled={writeDisabled || !repair.path.trim()}>{t('Save path')}</button><button type="button" onClick={() => setRepair(undefined)}>{t('Cancel changes')}</button>
        </form>}
      </li>)}</ul>

    </section>}
    {page === 'settings' && props.onRenameRuntime && <div className="management-actions">
      <button type="button" onClick={props.onRenameRuntime}><Pencil size={16} aria-hidden="true" />{t('Rename Workspace')}</button>
    </div>}
    {section('Agent permissions', <>
      <Status value={execution} retry={execution.reload} />
      <p>{t('Sandbox permissions are enforced by Codex app-server. Changes apply to newly submitted tasks; queued and running tasks keep their original setting.')}</p>
      {execution.data && <form onSubmit={event => { event.preventDefault(); void mutate(t('Save permission scope'), '/v1/execution-settings', { sandboxMode: sandbox, expectedRevision: execution.data!.revision }, execution.reload); }}>
        <label>{t('Sandbox permissions')}<select aria-label={t('Sandbox permissions')} value={sandbox} disabled={writeDisabled} onChange={event => setSandbox(event.target.value as SandboxMode)}>
          <option value="read-only">{t('Read-only')}</option>
          <option value="workspace-write">{t('Workspace write')}</option>
          <option value="danger-full-access">{t('Full access')}</option>
        </select></label>
        <p>{sandbox === 'read-only' ? t('Files can be read. Write operations require Codex approval.') : sandbox === 'workspace-write' ? t('The task workspace and output directories can be modified, and network access is enabled. File operations outside that scope require Codex approval.') : t('Codex sandbox restrictions are disabled. Agents can use the file and network permissions of the Workspace process.')}</p>
        <button type="submit" disabled={writeDisabled}>{t('Save permission scope')}</button>
      </form>}
    </>)}
    {section('Workspace default model', <>
      <Status value={models} retry={models.reload} /><button type="button" onClick={models.reload}>{t('Refresh model capabilities')}</button>
      <p>{t('Models and reasoning effort come from this Workspace’s actual catalog. No hard-coded model or automatic substitute is used.')}</p>
      {models.data && <><p>{t('Saved:')} {models.data.selection ? `${models.data.selection.model} / ${models.data.selection.reasoningEffort ?? t('Workspace default')}` : t('Not set')} · {t('Revision')} {models.data.revision}</p>
      {models.data.available.length === 0 && <p>{t('No models are currently available. Check Workspace sign-in and capabilities on the Workspace computer.')}</p>}
      <form onSubmit={event => { event.preventDefault(); void mutate(t('Save default model'), '/v1/models', { selection: { model, reasoningEffort: effort || null }, expectedRevision: models.data!.revision }, models.reload); }}>
        <label>{t('Model')}<select disabled={writeDisabled} aria-label={t('Model')} value={selectedModel ? model : ''} onChange={event => { setModel(event.target.value); setEffort(''); }}><option value="">{t('Choose an available model')}</option>{models.data.available.map(option => <option key={option.id} value={option.id}>{option.id}</option>)}</select></label>
        <label>{t('Reasoning effort')}<select aria-label={t('Reasoning effort')} value={effort} onChange={event => setEffort(event.target.value)} disabled={writeDisabled || !selectedModel}><option value="">{t('Use Workspace default effort')}</option>{selectedModel?.reasoningEfforts.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <button type="submit" disabled={writeDisabled || !selectedModel || Boolean(effort && !selectedModel.reasoningEfforts.includes(effort))}>{t('Save default model')}</button>
      </form></>}
    </>)}
    {section('Image generation agent · API providers', <>
      <Status value={imageProviders} retry={imageProviders.reload} />
      <button type="button" onClick={imageProviders.reload}>{t('Refresh image generation catalog')}</button>
      <p>{t('The image generation API is independent of Codex image generation. After saving a provider and API key, choose which provider models image nodes may use.')}</p>
      <label>{t('Provider instance')}<select aria-label={t('Image generation provider')} value={providerId} onChange={event => { setProviderId(event.target.value);setDiscoveredModels([]);setImageSecret(''); }}>
        <option value="">{t('Add new provider')}</option>{providerId && !selectedProvider && <option value={providerId}>{t('New provider')} · {providerId}</option>}{imageProviders.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
      </select></label>
      {!selectedProvider && <label>{t('New provider ID')}<input value={providerId} onChange={event => setProviderId(event.target.value)} disabled={writeDisabled} placeholder={t('For example, openai-main')} /></label>}
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); const secret=imageSecret; void act(t('Save image generation provider'),async valid => {
        const saved=await props.request<ImageProvider>('/v1/image-providers',{id:providerId,name:providerName,driver:'openai',endpoint:providerEndpoint,enabled:providerEnabled,expectedRevision:selectedProvider?.revision??0},'POST');
        if(!valid())return;
        if(secret){
          try { await props.request('/v1/image-providers/'+encode(saved.id)+'/credential',{secret,expectedRevision:saved.revision},'POST'); }
          catch(error){ await imageProviders.reload(); throw new Error(t('Provider settings were saved, but the API key could not be saved: {error}', { error: message(error) })); }
          if(!valid())return;
          setImageSecret('');
        }
        setNotice(secret ? t('Provider settings and API key were confirmed by the Workspace.') : t('Provider settings were confirmed by the Workspace.'));latest.current.onChanged();await imageProviders.reload();
      }); }}>
        <label>{t('Display name')}<input value={providerName} onChange={event => setProviderName(event.target.value)} disabled={writeDisabled} required /></label>
        <label>{t('Registered API base URL')}<input type="url" value={providerEndpoint} onChange={event => setProviderEndpoint(event.target.value)} disabled={writeDisabled} required /></label>
        <label>API Key<input type="password" autoComplete="new-password" value={imageSecret} onChange={event => setImageSecret(event.target.value)} disabled={writeDisabled} placeholder={selectedProvider?.credentialConfigured ? t('Leave blank to keep the current API key') : t('Enter provider API key')} /></label>
        <p>{selectedProvider ? t('Current credential: {state}. Leaving this blank keeps the credential unchanged.', { state: selectedProvider.credentialConfigured ? t('configured (cannot be read back)') : t('not configured or must be re-entered after restore') }) : t('Save it while creating the provider, or leave it blank and add it later.')} {t('The API key is stored only on the Workspace computer and is not included in Work Graphs or backups.')}</p>
        <label className="management-checkbox"><input type="checkbox" checked={providerEnabled} onChange={event => setProviderEnabled(event.target.checked)} disabled={writeDisabled} />{t('Enable new task submissions')}</label>
        <button type="submit" disabled={writeDisabled || !providerId.trim() || !providerName.trim()}>{t('Save provider settings')}</button>
      </form>
      {selectedProvider && <>
        <p>{t('Revision')} {selectedProvider.revision} · {selectedProvider.enabled ? t('Enabled') : t('Disabled')}</p>
        <div className="management-danger-actions"><button type="button" disabled={writeDisabled || !selectedProvider.credentialRevision} onClick={() => confirm(t('Revoke all previous credential versions for this provider? Accepted but unsent requests will no longer continue.'),()=>{void mutate(t('Revoke image generation credentials'),'/v1/image-providers/'+encode(selectedProvider.id)+'/credential-revoke',{expectedRevision:selectedProvider.revision},imageProviders.reload);})}>{t('Revoke credentials')}</button>
        <button type="button" disabled={writeDisabled} onClick={() => confirm(t('Delete provider “{name}”? New tasks can no longer use it; accepted tasks retain frozen settings.', { name: selectedProvider.name }),()=>{void mutate(t('Delete image generation provider'),'/v1/image-providers/'+encode(selectedProvider.id)+'/delete',{expectedRevision:selectedProvider.revision},imageProviders.reload);setProviderId('');})}>{t('Delete provider')}</button></div>
        <h4 className="management-form-heading">{t('Image generation models')}</h4>
        <p>{t('Fetch the provider model catalog, then select the models image nodes may use. Quality, size, and aspect ratio are set on image nodes.')}</p>
        <button type="button" disabled={writeDisabled || !selectedProvider.enabled || !selectedProvider.credentialConfigured} onClick={() => { void act(t('Fetch image generation models'),async valid => {
          const result=await props.request<{models:DiscoveredImageModel[];revision:number}>('/v1/image-providers/'+encode(selectedProvider.id)+'/models/discover',{expectedRevision:selectedProvider.revision},'POST');
          if(valid()){setDiscoveredModels(result.models);setNotice(t('Fetched {count} models from the provider. Select models and save.', { count: result.models.length }));}
        }); }}>{t('Fetch image generation models')}</button>
        {!selectedProvider.enabled && <p>{t('This provider is disabled. Enable new task submissions and save provider settings before fetching models.')}</p>}
        {!selectedProvider.credentialConfigured && <p>{selectedProvider.credentialRevision === null
          ? t('This provider has no API key configured. Enter the API key again above and save provider settings before fetching models.')
          : t('This provider had an API key, but the Workspace cannot read it from local credential storage. Enter the API key again above and save provider settings before fetching models.')}</p>}
        {discoveredModels.length>0 && <div className="image-model-catalog" role="group" aria-label={t('Provider model catalog')}>
          {discoveredModels.map(item => <label className="management-checkbox" key={item.id}><input type="checkbox" checked={item.selected} disabled={writeDisabled} onChange={event => setDiscoveredModels(current=>current.map(model=>model.id===item.id?{...model,selected:event.target.checked}:model))} /><span>{item.name}<code>{item.id}</code></span></label>)}
          <button type="button" disabled={writeDisabled} onClick={() => { void act(t('Save image generation model selection'),async valid => {
            await props.request('/v1/image-providers/'+encode(selectedProvider.id)+'/models/select',{models:discoveredModels.filter(item=>item.selected).map(({id,name})=>({id,name})),expectedRevision:selectedProvider.revision},'POST');
            if(valid()){setNotice(t('Image generation model selection saved.'));await imageProviders.reload();}
          }); }}>{t('Save model selection')}</button>
        </div>}
        {selectedProvider.models.length===0 && <p>{t('No image generation models selected.')}</p>}
        {selectedProvider.models.map(item => <div className="image-model-row" key={item.id}><span>{item.name} · {item.id}</span></div>)}
      </>}
    </>)}
    {section('Work Graph import and export', <>
      <p>{t('Import target:')} {selectedProject ? `${selectedProject.name} (${selectedProject.projectId})` : projectId ? t('{projectId} (project not loaded or unavailable)', { projectId }) : t('No project selected')}. {t('Import creates a new Work Graph and does not overwrite the current graph.')}</p>
      <p>{t('Export target:')} {graphId ?? t('No Work Graph selected')}. {t('Import and export run only after an explicit click and do not migrate Workspace sessions.')}</p>
      <button type="button" disabled={!projectId || !graphId || !selectedProject} onClick={() => { void act(t('Export Work Graph'), async valid => {
        const bundle = await props.request<GraphBundle>(`/v1/projects/${encode(projectId!)}/graphs/${encode(graphId!)}/export`, undefined, 'GET');
        if (!valid()) return;
        saveFile(await createWorkGraphArchive(bundle), `openworkgraph-${graphId}.workgraph.zip`);
        setNotice(t('The Work Graph package was sent to the browser for download.'));
      }, true, false); }}>{t('Export current Work Graph')}</button>
      <label>{t('Choose Work Graph ZIP package')}<input disabled={writeDisabled} key={scope} type="file" accept=".zip,application/zip,application/vnd.openworkgraph.graph+zip" onChange={event => setFile(event.target.files?.[0])} /></label>
      <button type="button" disabled={writeDisabled || !file || !selectedProject || selectedProject.state !== 'active'} onClick={() => confirm(t('Import “{file}” into the current project “{project}” ({projectId}) and create a new Work Graph?', { file: file?.name ?? '', project: selectedProject?.name ?? '', projectId: projectId ?? '' }), () => {
        const target = projectId!; const chosen = file!;
        void act(t('Import Work Graph'), async valid => {
          const bundle = await readWorkGraphFile(chosen);
          if (!valid()) return;
          if (importAttempt.current?.file !== chosen || importAttempt.current?.target !== target) importAttempt.current = { file: chosen, target, key: randomId() };
          await props.request(`/v1/projects/${encode(target)}/graphs/import`, { bundle, idempotencyKey: importAttempt.current.key }, 'POST', { journal:'memory' });
          if (!valid()) return;
          importAttempt.current = undefined;
          setNotice(t('Work Graph import was confirmed by the Workspace. View it in the current project’s Work Graph list.')); setFile(undefined); latest.current.onChanged();
        }, true);
      })}>{t('Import into current project')}</button>
    </>)}
    {section('Storage data management', <>
      <p>{t('Storage counts files in this Workspace’s data directory, including all projects. Project source files outside that directory are not counted.')}</p>
      <Status value={storage} retry={storage.reload} />
      {storage.data && <>
        <div className="management-storage-total"><span>{t('Total Workspace data')}</span><strong>{formatSize(storage.data.totalBytes)}</strong></div>
        <dl className="management-storage-breakdown">{storageCategories.map(item => <div key={item.key}><dt>{t(item.label)}</dt><dd>{formatSize(storage.data!.categories[item.key])}</dd></div>)}</dl>
        <p>{t('Measured at {time}. Sizes may change while the Workspace is active.', { time: localTime(storage.data.measuredAt) })}</p>
      </>}
      <h4 className="management-form-heading">{t('Cache cleanup')}</h4>
      <div className="management-actions"><button type="button" disabled={disabled} onClick={() => { void storage.reload(); }}>{t('Refresh storage usage')}</button>
        <button type="button" disabled={writeDisabled} onClick={() => confirm(t('Clean unused Work Graph resource copies? Only copies without node, history, snapshot, output, or read references will be collected. Asset library items, backups, and project source files remain untouched.'), () => { void act(t('Clean unused resource copies'), async valid => {
          const result = await props.request<StorageCleanup>('/v1/storage/cleanup', {}, 'POST');
          if (!valid()) return;
          await storage.reload();
          if (!valid()) return;
          setNotice(t('Collected {resources} resource copies and removed {files} files. {failed} files remain queued for retry.', { resources: result.collectedResources, files: result.removedFiles, failed: result.failedFiles }));
        }); })}>{t('Clear cache')}</button></div>
      <p>{t('Cleanup checks current references before removal. Shared files and protected history are retained; failed file removals stay queued for retry.')}</p>
    </>)}
    {section('Workspace backups and local restore', <>
      <p>{t('A backup covers the entire Workspace, not only the current project. Restore can only be performed by an administrator on the Workspace computer.')}</p>
      <Status value={backups} retry={backups.reload} />
      <button type="button" disabled={writeDisabled} onClick={() => { void act(t('Create backup'), async valid => {
        backupKey.current ??= randomId();
        const backup = await props.request<LocatedBackup>('/v1/backups', { idempotencyKey: backupKey.current }, 'POST');
        if (!valid()) return;
        backupKey.current = undefined;
        if (backup.state === 'failed') throw new Error(t('The Workspace reported that backup creation failed. Check Workspace logs and try again.'));
        setNotice(backup.state === 'ready' ? t('Backup is ready.') : t('Backup is being created. Refresh the list to see the result.'));
        latest.current.onChanged(); await backups.reload();
      }); }}>{t('Create backup')}</button><button type="button" onClick={backups.reload}>{t('Refresh backups')}</button>
      {backups.data?.length === 0 && <p>{t('No backups.')}</p>}
      <ul>{backups.data?.map(backup => <li key={backup.id}><div className="management-item-heading"><Archive size={18} aria-hidden="true" /><strong>{backup.createdAt}</strong><span className="management-badge">{backup.state === 'ready' ? t('Ready') : backup.state === 'creating' ? t('Creating') : t('Failed')}</span></div><code>{backup.id}</code><span>{backup.bytes === null ? t('Size unknown') : t('{bytes} bytes', { bytes: backup.bytes })}</span>{backup.sha256 && <code>Manifest SHA-256: {backup.sha256}</code>}
        <span>{t('Workspace location:')}{backup.location ? <code>{backup.location}</code> : t('Workspace did not provide a location')}</span>
        <button type="button" disabled={backup.state !== 'ready'} onClick={() => { void act(t('Download backup'), async valid => {
          const blob = await props.request<Blob>(`/v1/backups/${encode(backup.id)}/download`, undefined, 'BLOB');
          if (!valid()) return;
          if (!(blob instanceof Blob)) throw new Error(t('The authenticated request must return the backup binary response as a Blob.'));
          saveFile(blob, `${backup.id}.owg-backup`); setNotice(t('The backup was sent to the browser for download. Confirm that the download completed.'));
        }, false, false); }}>{t('Authenticated backup download')}</button>
      </li>)}</ul>
      <Status value={guidance} retry={guidance.reload} />
      {guidance.data && <details><summary>{t('Local restore guidance (not executed in the browser)')}</summary><p>{t('After safely preserving current data and stopping the Workspace, a local administrator should run restore preview to inspect the backup, verify the returned manifest SHA-256, and replace the placeholders below. The digest shown in the list is not the SHA-256 of the complete downloaded file. Restore invalidates all browser sessions and pauses queued tasks; pair again afterward.')}</p><pre>{guidance.data.command}</pre></details>}
    </>)}
    {section('Browser sessions', <>
      <Status value={sessions} retry={sessions.reload} /><button type="button" onClick={sessions.reload}>{t('Refresh sessions')}</button>
      {sessions.data?.length === 0 && <p>{t('No browser sessions.')}</p>}
      <ul>{sessions.data?.map(session => <li data-current={session.current} key={session.id}><div className="management-item-heading"><Monitor size={18} aria-hidden="true" /><strong>{session.browserName}</strong>{session.current && <span className="management-badge">{t('Current browser')}</span>}</div><span>{session.origin}</span><span className="management-badge">{session.state === 'active' ? t('Valid') : t('Session expired')}</span><dl className="management-details"><dt>{t('Paired at')}</dt><dd>{localTime(session.pairedAt)}</dd><dt>{t('Last used')}</dt><dd>{localTime(session.lastUsedAt)}</dd><dt>{t('Expires at')}</dt><dd>{localTime(session.expiresAt)}</dd></dl>
        <button type="button" disabled={writeDisabled} onClick={() => confirm(t('Revoke the session for “{name}”? {effect}', { name: session.browserName, effect: session.current ? t('This disconnects the current browser and requires pairing again.') : t('That browser must pair again to access this Workspace.') }), () => { void act(t('Revoke session'), async valid => {
          await props.request(`/v1/sessions/${encode(session.id)}`, undefined, 'DELETE');
          if (!valid()) return;
          setNotice(t('Session revocation was confirmed by the Workspace.'));
          if (session.current) setRevoked(true);
          latest.current.onChanged();
          if (!session.current) await sessions.reload();
        }); })}>{t('Revoke session')}</button>
      </li>)}</ul>
    </>)}
    </fieldset>
  </div>;
}
export default ManagementPanel;
