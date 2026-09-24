import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { ExecutionSettings, ModelDefaults, SandboxMode } from '../../../packages/protocol/src/index';
import type { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';

export function WelcomeAgentSetup({ registry, serviceId, onBusy, onModelsChanged, onComplete }: {
  registry: ConnectionRegistry;
  serviceId: string;
  onBusy: (busy: boolean) => void;
  onModelsChanged: () => void;
  onComplete: () => void;
}) {
  const { t } = useI18n();
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<ModelDefaults>();
  const [execution, setExecution] = useState<ExecutionSettings>();
  const [modelError, setModelError] = useState('');
  const [executionError, setExecutionError] = useState('');
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingExecution, setLoadingExecution] = useState(true);
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let live = true;
    setLoadingModels(true); setLoadingExecution(true); setModelError(''); setExecutionError('');
    let transport: Transport;
    try { transport = new Transport(registry, serviceId); }
    catch (error) {
      const value = messageOf(error);
      setModelError(value); setExecutionError(value); setLoadingModels(false); setLoadingExecution(false);
      return;
    }
    void Promise.allSettled([
      transport.request<ModelDefaults>('/v1/models'),
      transport.request<ExecutionSettings>('/v1/execution-settings'),
    ]).then(([modelResult, executionResult]) => {
      if (!live) return;
      if (modelResult.status === 'fulfilled') {
        const value = modelResult.value;
        setModels(value);
        const selected = value.available.find(item => item.id === value.selection?.model) ?? value.available[0];
        setModel(selected?.id ?? '');
        setEffort(value.selection?.model === selected?.id ? value.selection.reasoningEffort ?? '' : selected?.defaultReasoningEffort ?? '');
      } else setModelError(messageOf(modelResult.reason));
      if (executionResult.status === 'fulfilled') {
        setExecution(executionResult.value); setSandbox(executionResult.value.sandboxMode);
      } else setExecutionError(messageOf(executionResult.reason));
      setLoadingModels(false); setLoadingExecution(false);
    });
    return () => { live = false; };
  }, [registry, serviceId, reload]);

  const selectedModel = useMemo(() => models?.available.find(item => item.id === model), [models, model]);
  const validEffort = !effort || Boolean(selectedModel?.reasoningEfforts.includes(effort));
  const ready = Boolean(models && execution && selectedModel && validEffort);

  async function save() {
    if (!ready || saving) return;
    setSaving(true); onBusy(true); setSaveError('');
    try {
      const transport = new Transport(registry, serviceId);
      const savedExecution = await transport.request<ExecutionSettings>('/v1/execution-settings', { sandboxMode: sandbox, expectedRevision: execution!.revision });
      setExecution(savedExecution);
      const savedModels = await transport.request<ModelDefaults>('/v1/models', { selection: { model, reasoningEffort: effort || null }, expectedRevision: models!.revision });
      setModels(savedModels);
      onModelsChanged();
      setSaving(false);
      onBusy(false);
      onComplete();
    } catch (error) {
      setSaveError(messageOf(error));
      setSaving(false);
      onBusy(false);
    }
  }

  return <div className="welcome-agent-setup">
    <header>
      <span className="welcome-agent-icon"><Bot size={22} aria-hidden="true" /></span>
      <div><h2>{t('Set up Agent')}</h2><p>{t('Confirm Codex availability and choose the defaults used by new tasks.')}</p></div>
    </header>
    <section className="welcome-agent-card" aria-labelledby="welcome-codex-status">
      <div className="welcome-agent-card-title"><Bot size={18} aria-hidden="true" /><h3 id="welcome-codex-status">{t('Codex installation status')}</h3></div>
      {loadingModels ? <p role="status">{t('Checking Codex installation and sign-in…')}</p>
        : modelError ? <div className="welcome-agent-status error"><CircleAlert size={18} aria-hidden="true" /><div><strong>{t('Codex could not be verified')}</strong><p>{t('Check the Codex installation, compatible version, sign-in, and network connection on the Runtime device. Error: {error}', { error: modelError })}</p></div></div>
          : <div className="welcome-agent-status success"><CheckCircle2 size={18} aria-hidden="true" /><div><strong>{t('Codex is ready')}</strong><p>{t('{count} models are available from this Runtime.', { count: models?.available.length ?? 0 })}</p></div></div>}
      {!loadingModels && modelError && <button type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />{t('Check again')}</button>}
    </section>
    <section className="welcome-agent-card" aria-labelledby="welcome-permission-setting">
      <div className="welcome-agent-card-title"><ShieldCheck size={18} aria-hidden="true" /><h3 id="welcome-permission-setting">{t('Default permissions')}</h3></div>
      {loadingExecution ? <p role="status">{t('Loading permission settings…')}</p> : executionError ? <p role="alert">{executionError}</p> : <label>{t('Sandbox permissions')}<select value={sandbox} onChange={event => setSandbox(event.target.value as SandboxMode)}>
        <option value="read-only">{t('Read-only')}</option><option value="workspace-write">{t('Workspace write')}</option><option value="danger-full-access">{t('Full access')}</option>
      </select></label>}
    </section>
    <section className="welcome-agent-card" aria-labelledby="welcome-model-setting">
      <div className="welcome-agent-card-title"><SlidersHorizontal size={18} aria-hidden="true" /><h3 id="welcome-model-setting">{t('Default model and reasoning effort')}</h3></div>
      {models && <div className="welcome-agent-fields"><label>{t('Model')}<select value={model} onChange={event => { const next = models.available.find(item => item.id === event.target.value); setModel(event.target.value); setEffort(next?.defaultReasoningEffort ?? ''); }}>
        <option value="">{t('Choose an available model')}</option>{models.available.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
      </select></label><label>{t('Reasoning effort')}<select value={effort} disabled={!selectedModel} onChange={event => setEffort(event.target.value)}>
        <option value="">{t('Use Runtime default effort')}</option>{selectedModel?.reasoningEfforts.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label></div>}
    </section>
    {saveError && <p className="welcome-agent-save-error" role="alert">{saveError}</p>}
    <div className="welcome-graph-actions">
      <button className="secondary-button" type="button" disabled={saving} onClick={onComplete}>{t('Skip')}</button>
      <button className="primary-button welcome-agent-finish" type="button" disabled={!ready || saving} onClick={() => void save()}>{saving ? t('Saving Agent settings…') : t('Save Agent settings and continue')}</button>
    </div>
  </div>;
}
