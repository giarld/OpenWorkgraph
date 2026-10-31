import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DataSource, DataSourceConfig, DataSourceCredentials, HostTrustChallenge } from '../../../packages/protocol/src/remote-assets';
import { useI18n } from '../i18n/I18nProvider';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { messageOf, type Request } from './contracts';
import '../i18n/catalogs/remote-assets';
import './RemoteAssets.css';
const initial = (): DataSourceConfig => ({ kind: 'git', name: '', url: '', root: '', branch: '', auth: 'public' });
export function DataSourcesSettings({ request, disabled, onBusyChange, onDirtyChange }: { request: Request; disabled: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n(); const [sources, setSources] = useState<DataSource[]>([]); const [selected, setSelected] = useState('');
  const [config, setConfig] = useState<DataSourceConfig>(initial); const [credentials, setCredentials] = useState<DataSourceCredentials>({});
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [challenges, setChallenges] = useState<HostTrustChallenge[]>([]); const [confirm, setConfirm] = useState<(() => void) | undefined>(); const [confirmText, setConfirmText] = useState('');
  const mounted = useRef(true); const source = sources.find(s => s.id === selected); const locked = disabled || busy || !!source?.busy;
  const reloadSources = useRef<(() => Promise<void>) | undefined>(undefined), previouslyDisabled = useRef(disabled);
  useEffect(() => {
    mounted.current = true;
    let current = true, generation = 0, initialized = false;
    let serviceId: string | undefined;
    const reload = async () => {
      const attempt = ++generation;
      try {
        const list = await request<DataSource[]>('/v1/data-sources');
        if (!current || attempt !== generation) return;
        const firstLoad = !initialized; initialized = true; serviceId = list[0]?.serviceId ?? serviceId;
        const occupancy = new Map(list.map(source => [source.id, source.busy]));
        // Keep the original configuration revision and both form drafts intact.
        setSources(previous => firstLoad ? list : previous.map(source => ({ ...source, busy: occupancy.get(source.id) ?? false })));
        setLoadError('');
      } catch (error) { if (current && attempt === generation) setLoadError(t(messageOf(error))); }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (serviceId && detail?.serviceId && detail.serviceId !== serviceId) return;
      const state = detail?.payload?.state;
      if (state && !['accepted', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(state)) return;
      void reload();
    };
    reloadSources.current = reload;
    void reload();
    window.addEventListener('openworkgraph:remote-transfers-changed', changed);
    return () => { current = false; mounted.current = false; ++generation; reloadSources.current = undefined; window.removeEventListener('openworkgraph:remote-transfers-changed', changed); };
  }, [request, t]);
  useEffect(() => {
    // Reuse the loader so reconnecting does not reset its original form revisions.
    if (previouslyDisabled.current && !disabled) void reloadSources.current?.();
    previouslyDisabled.current = disabled;
  }, [disabled]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const edit = (next: DataSourceConfig) => { setConfig(next); setDirty(true); setNotice(''); setChallenges([]); };
  const choose = (id: string) => { const next = sources.find(s => s.id === id); setSelected(id); setConfig(next?.config ?? initial()); setCredentials({}); setChallenges([]); setError(''); setLoadError(''); setNotice(''); setDirty(false); };
  const ask = (text: string, run: () => void) => { setConfirmText(text); setConfirm(() => run); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { if (mounted.current) setError(t(messageOf(e))); } finally { if (mounted.current) setBusy(false); } };
  const save = async (): Promise<DataSource> => {
    const saved = await request<DataSource>('/v1/data-sources' + (selected ? '/' + selected : ''), { config, ...(selected ? { expectedRevision: source!.revision } : {}), ...(Object.keys(credentials).length ? { credentials } : {}) }, 'POST', { journal: 'memory' });
    if (mounted.current) { setSources(list => [...list.filter(s => s.id !== saved.id), saved]); setSelected(saved.id); setConfig(saved.config); setCredentials({}); setDirty(false); window.dispatchEvent(new CustomEvent('openworkgraph:data-sources-changed')); } return saved;
  };
  return <section className="remote-source-settings" aria-label={t('Data sources')}>
    <div className="remote-source-toolbar"><label>{t('Select data source')}<select value={selected} disabled={busy} onChange={e => { const id = e.target.value; dirty ? ask(t('Discard data source edits?'), () => choose(id)) : choose(id); }}><option value="">{t('Add data source')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.config.name}</option>)}</select></label><button type="button" disabled={busy} aria-label={t('Add data source')} title={t('Add data source')} onClick={() => dirty ? ask(t('Discard data source edits?'), () => choose('')) : choose('')}><Plus size={18} aria-hidden="true"/></button></div>
    {source?.busy && <p role="status">{t('Wait for transfers to finish or cancel them before editing this source.')}</p>}
    {(error || loadError) && <p role="alert">{error || loadError}</p>}{notice && <p role="status">{notice}</p>}
    <form onSubmit={e => { e.preventDefault(); void run(async () => { await save(); }); }}>
      <fieldset className="remote-source-fields" disabled={locked}>
        <label>{t('Source name')}<input required maxLength={512} value={config.name} onChange={e => edit({ ...config, name: e.target.value })}/></label>
        <label>{t('Source type')}<select value={config.kind} onChange={e => edit(e.target.value === 'git' ? { ...initial(), name: config.name } : { kind: 'sftp', name: config.name, host: '', port: 22, username: '', root: '/', auth: 'password' })}><option value="git">Git</option><option value="sftp">SFTP</option></select></label>
        {config.kind === 'git' ? <>
          <label className="remote-source-wide">{t('Repository URL')}<input required value={config.url} placeholder="https://… / ssh://…" onChange={e => edit({ ...config, url: e.target.value })}/></label>
          <label>{t('Branch')}<input required value={config.branch} onChange={e => edit({ ...config, branch: e.target.value })}/></label>
          <label>{t('Root directory')}<input value={config.root} onChange={e => edit({ ...config, root: e.target.value })}/></label>
          <label>{t('Authentication')}<select value={config.auth} onChange={e => { edit({ ...config, auth: e.target.value as 'public' | 'token' | 'key' }); setCredentials({}); }}><option value="public">{t('Public repository')}</option><option value="token">{t('Access token')}</option><option value="key">{t('SSH key')}</option></select></label>
        </> : <>
          <div className="remote-source-address remote-source-wide">
            <label>{t('Host')}<input required value={config.host} onChange={e => edit({ ...config, host: e.target.value })}/></label>
            <label>{t('Port')}<input required type="number" min={1} max={65535} value={config.port} onChange={e => edit({ ...config, port: Number(e.target.value) })}/></label>
          </div>
          <label>{t('Username')}<input required autoComplete="off" value={config.username} onChange={e => edit({ ...config, username: e.target.value })}/></label>
          <label>{t('Root directory')}<input required value={config.root} onChange={e => edit({ ...config, root: e.target.value })}/></label>
          <label>{t('Authentication')}<select value={config.auth} onChange={e => { edit({ ...config, auth: e.target.value as 'password' | 'key' }); setCredentials({}); }}><option value="password">{t('Password')}</option><option value="key">{t('SSH key')}</option></select></label>
        </>}
        {(config.auth === 'token' ? ['token'] : config.auth === 'password' ? ['password'] : config.auth === 'key' ? ['passphrase'] : []).map(key => {
          const field = key as keyof DataSourceCredentials, label = key === 'token' ? 'Access token' : key === 'password' ? 'Password' : 'Private key passphrase';
          return <div key={key} className="remote-source-credential"><label>{t(label)}<input type="password" autoComplete="new-password" value={credentials[field] ?? ''} placeholder={source?.credentials[field] ? t('Saved credential') : undefined} onChange={e => { setCredentials(v => ({ ...v, [field]: e.target.value || undefined })); setDirty(true); }}/></label>{source?.credentials[field] && <button type="button" className="remote-credential-remove" onClick={() => { setCredentials(v => ({ ...v, [field]: null })); setDirty(true); }}>{t('Remove saved credential')}</button>}</div>;
        })}
        <div className="remote-source-actions"><button type="submit" className="remote-source-save">{t('Save')}</button><button type="button" onClick={e => { if (!e.currentTarget.form?.reportValidity()) return; void run(async () => { const current = dirty || !source ? await save() : source; const result = await request<{ ok: boolean; error?: string; challenges: HostTrustChallenge[] }>('/v1/data-sources/' + current.id + '/test', { expectedRevision: current.revision }, 'POST', { journal: 'memory' }); if (mounted.current) { setChallenges(result.challenges); if (result.ok) setNotice(t('Connection succeeded')); else setError(result.error ? t(result.error) : ''); } }); }}>{t('Test connection')}</button>
          {source && <button type="button" className="remote-source-remove" onClick={() => ask(t('Remove this connection and its saved credentials? Remote files, imported content, local copies and SSH keys are kept.'), () => { void run(async () => { await request('/v1/data-sources/' + source.id + '/remove', { expectedRevision: source.revision, confirmed: true }, 'POST', { journal: 'memory' }); if (mounted.current) { setSources(list => list.filter(s => s.id !== source.id)); choose(''); window.dispatchEvent(new CustomEvent('openworkgraph:data-sources-changed')); } }); })}><Trash2 size={16} aria-hidden="true"/>{t('Remove data source')}</button>}
        </div>
      </fieldset>
    </form>
    {challenges.map(challenge => <section key={challenge.id} className="remote-host-challenge"><strong>{challenge.endpoint}</strong>{challenge.previousFingerprint && <label>{t('Previous fingerprint')}<code>{challenge.previousFingerprint}</code></label>}<label>{t('New fingerprint')}<code>{challenge.fingerprint}</code></label><button disabled={locked || dirty} type="button" onClick={() => ask(t(challenge.previousFingerprint ? 'Replace trusted host fingerprint' : 'Confirm host fingerprint'), () => { void run(async () => { await request('/v1/data-sources/' + source!.id + '/trust', { expectedRevision: source!.revision, challengeId: challenge.id }, 'POST', { journal: 'memory' }); if (mounted.current) { setChallenges([]); setError(''); setNotice(t('Host confirmed. Test the connection again manually.')); } }); })}>{t(challenge.previousFingerprint ? 'Replace trusted host fingerprint' : 'Confirm host fingerprint')}</button></section>)}
    {confirm && <ConfirmationDialog title={t('Data sources')} text={confirmText} disabled={busy} onCancel={() => setConfirm(undefined)} onConfirm={() => { const action = confirm; setConfirm(undefined); action(); }}/>}
  </section>;
}
