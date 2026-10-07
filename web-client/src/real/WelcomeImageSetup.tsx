import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'lucide-react';
import type { ImageProvider } from '../../../packages/protocol/src/index';
import type { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';
import { WelcomeStepActions, WelcomeStepLayout } from './WelcomeStepLayout';

type CatalogModel = { id: string; name: string; selected: boolean };

export function WelcomeImageSetup({ registry, serviceId, onBusy, onComplete }: {
  registry: ConnectionRegistry;
  serviceId: string;
  onBusy: (busy: boolean) => void;
  onComplete: () => void;
}) {
  const { t } = useI18n();
  const transport = useMemo(() => new Transport(registry, serviceId), [registry, serviceId]);
  const [providers, setProviders] = useState<ImageProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('https://api.openai.com');
  const [secret, setSecret] = useState('');
  const [provider, setProvider] = useState<ImageProvider>();
  const [catalog, setCatalog] = useState<CatalogModel[]>();
  const [catalogRevision, setCatalogRevision] = useState<number>();
  const modelSection = useRef<HTMLElement>(null);
  const selected = providers.find(item => item.id === id);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void transport.request<ImageProvider[]>('/v1/image-providers').then(value => {
      if (live) {
        setProviders(value);
        setProvider(current => current ? value.find(item => item.id === current.id) : undefined);
        setCatalog(undefined);
      }
    }).catch(failure => { if (live) setError(messageOf(failure)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [transport, reload]);

  useEffect(() => {
    const target = modelSection.current;
    const viewport = target?.closest<HTMLElement>('.welcome-step-content');
    if (!target || !viewport) return;
    viewport.scrollTo({ top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [provider?.id]);

  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); onBusy(true); setError('');
    try { await operation(); }
    catch (failure) {
      setError(messageOf(failure));
      // Recover revisions after partial saves or concurrent edits; retain form values.
      try {
        const fresh = await transport.request<ImageProvider[]>('/v1/image-providers');
        setProviders(fresh);
        if (provider) { setProvider(fresh.find(item => item.id === provider.id)); setCatalog(undefined); }
      } catch { /* Preserve the original actionable error. */ }
    } finally { setBusy(false); onBusy(false); }
  }

  async function saveProvider() {
    let saved = await transport.request<ImageProvider>('/v1/image-providers', {
      id: id.trim(), name: name.trim(), driver: 'openai', endpoint: endpoint.trim(), enabled: true, expectedRevision: selected?.revision ?? 0,
    });
    setId(saved.id);
    if (secret.trim()) {
      try { saved = await transport.request<ImageProvider>('/v1/image-providers/' + encodeURIComponent(saved.id) + '/credential', { secret, expectedRevision: saved.revision }, 'POST', { journal: 'memory' }); }
      catch (failure) { throw new Error(t('Provider settings were saved, but the API key could not be saved: {error}', { error: messageOf(failure) })); }
      setSecret('');
    }
    setProviders(current => [...current.filter(item => item.id !== saved.id), saved]);
    setId(saved.id); setProvider(saved); setCatalog(undefined);
  }

  const canFinish = provider?.enabled && provider.credentialConfigured && (catalog ? catalog.some(item => item.selected) : provider.models.length > 0);
  return <WelcomeStepLayout className="welcome-image-setup" actions={<WelcomeStepActions busy={busy} disabled={!canFinish} onSkip={onComplete} onConfirm={() => void act(async () => {
    if (!provider || !canFinish) return;
    if (catalog) await transport.request('/v1/image-providers/' + encodeURIComponent(provider.id) + '/models/select', { models: catalog.filter(item => item.selected).map(({ id, name }) => ({ id, name })), expectedRevision: catalogRevision });
    onComplete();
  })} />}>
    <header>
      <span className="welcome-agent-icon"><Image size={22} aria-hidden="true" /></span>
      <div><h2>{t('Set up image models')}</h2><p>{t('Add an image API provider and choose models. You can skip this step and configure it later in Workspace management.')}</p></div>
    </header>
    {!provider ? <form className="welcome-agent-card" autoComplete="off" onSubmit={event => { event.preventDefault(); void act(saveProvider); }}>
      <h3>{t('Image generation provider')}</h3>
      {loading ? <p role="status">{t('Loading…')}</p> : <>
        <label>{t('Provider instance')}<select disabled={busy} value={selected?.id ?? ''} onChange={event => {
          const value = providers.find(item => item.id === event.target.value);
          setId(value?.id ?? ''); setName(value?.name ?? ''); setEndpoint(value?.endpoint ?? 'https://api.openai.com'); setSecret('');
        }}><option value="">{t('Add new provider')}</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!selected && <label>{t('New provider ID')}<input required disabled={busy} value={id} onChange={event => setId(event.target.value)} placeholder="openai-main" /></label>}
        <label>{t('Display name')}<input required disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{t('Registered API base URL')}<input required type="url" disabled={busy} value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
        <label>API Key<input type="password" autoComplete="new-password" required={!selected?.credentialConfigured} disabled={busy} value={secret} onChange={event => setSecret(event.target.value)} placeholder={selected?.credentialConfigured ? t('Leave blank to keep the current API key') : t('Enter provider API key')} /></label>
        <p>{t('The API key is stored only on the Workspace computer and is not included in Work Graphs or backups.')}</p>
        <button type="submit" disabled={busy || !id.trim() || !name.trim() || (!selected?.credentialConfigured && !secret.trim())}>{t('Save provider and continue')}</button>
      </>}
    </form> : <section ref={modelSection} className="welcome-agent-card">
      <h3>{t('Image generation models')}</h3>
      <p>{provider.name}</p>
      <p>{t('Fetch the provider model catalog, then select the models image nodes may use. Quality, size, and aspect ratio are set on image nodes.')}</p>
      <button type="button" disabled={busy || !provider.enabled || !provider.credentialConfigured} onClick={() => void act(async () => {
        const result = await transport.request<{ models: CatalogModel[]; revision: number }>('/v1/image-providers/' + encodeURIComponent(provider.id) + '/models/discover', { expectedRevision: provider.revision });
        setCatalog(result.models); setCatalogRevision(result.revision);
      })}>{t('Fetch image generation models')}</button>
      {catalog ? <div className="welcome-image-models" role="group" aria-label={t('Provider model catalog')}>
        {catalog.length === 0 && <p>{t('No models were returned. Check the provider settings and try again.')}</p>}
        {catalog.map(item => <label key={item.id}><input type="checkbox" disabled={busy} checked={item.selected} onChange={event => setCatalog(current => current?.map(model => model.id === item.id ? { ...model, selected: event.target.checked } : model))} /><span>{item.name}<code>{item.id}</code></span></label>)}
      </div> : provider.models.length ? <p>{provider.models.map(item => item.name || item.id).join(', ')}</p> : <p>{t('No image generation models selected.')}</p>}
      <button type="button" disabled={busy} onClick={() => { setProvider(undefined); setCatalog(undefined); }}>{t('Edit provider settings')}</button>
    </section>}
    {busy && <p role="status">{t('Saving or fetching image settings…')}</p>}
    {error && <div role="alert" className="welcome-agent-save-error">{error}<button type="button" className="secondary-button" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>{t('Refresh image generation catalog')}</button></div>}
  </WelcomeStepLayout>;
}
