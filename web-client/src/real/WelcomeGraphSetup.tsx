import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import type { GraphSnapshot, Project } from '../../../packages/protocol/src/index';
import type { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { randomId } from '../adapter/random';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';
import { WelcomeStepActions, WelcomeStepLayout } from './WelcomeStepLayout';

export function WelcomeGraphSetup({ registry, serviceId, projectId, onBusy, onComplete, onSetupWorkspace }: {
  registry: ConnectionRegistry;
  serviceId: string;
  projectId: string;
  onBusy: (busy: boolean) => void;
  onComplete: (projectId: string, graphId?: string) => void;
  onSetupWorkspace: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const transport = useMemo(() => new Transport(registry, serviceId), [registry, serviceId]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState(projectId);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const selected = projects.find(project => project.projectId === selectedId);
  const canCreate = !loading && !loadError && Boolean(selected);
  const attempt = useRef<{ projectId: string; title: string; idempotencyKey: string } | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setLoading(true); setLoadError('');
    void transport.request<Project[]>('/v1/projects/all').then(items => {
      if (!live) return;
      const available = items.filter(project => project.state === 'active' && project.availability !== 'unavailable');
      setProjects(available);
      setSelectedId(current => available.some(project => project.projectId === current) ? current : '');
    }).catch(failure => { if (live) { setProjects([]); setLoadError(messageOf(failure)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [transport, reload]);

  async function create() {
    if (busy || !canCreate || !name.trim()) return;
    attempt.current ??= { projectId: selectedId, title: name.trim(), idempotencyKey: randomId() };
    setBusy(true); onBusy(true); setError('');
    try {
      const { projectId: targetId, ...body } = attempt.current;
      const graph = await transport.request<GraphSnapshot>(`/v1/projects/${encodeURIComponent(targetId)}/graphs`, body);
      onComplete(targetId, graph.graphId);
    } catch (failure) {
      const pending = transport.pending().some(item => item.idempotencyKey === attempt.current?.idempotencyKey);
      setUncertain(pending);
      if (!pending) attempt.current = undefined;
      setError(messageOf(failure));
    } finally { setBusy(false); onBusy(false); }
  }

  return <WelcomeStepLayout className="welcome-graph-setup" actions={<WelcomeStepActions busy={busy} disabled={!canCreate || !name.trim()} onSkip={() => onComplete(selected?.projectId ?? '')} form={formId} label={t('Create and open Work Graph')} busyLabel={t('Creating Work Graph…')} />}>
    <header>
      <span className="welcome-agent-icon"><Network size={22} aria-hidden="true" /></span>
      <div><h2>{t('Create your first Work Graph')}</h2><p>{t('Choose a project and name your Work Graph to organize ideas, tasks, and outputs.')}</p></div>
    </header>
    <form id={formId} className="welcome-agent-card" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>{t('Work Graph project')}<select aria-label={t('Work Graph project')} required value={selectedId} disabled={loading || busy || uncertain || projects.length === 0} onChange={event => { setSelectedId(event.target.value); setError(''); }}>
        <option value="">{t('Select a project')}</option>
        {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name} · {project.canonicalPath}</option>)}
      </select></label>
      {loading && <p role="status">{t('Loading…')}</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {!loading && !loadError && projects.length === 0 && <p role="status">{t('No available projects. Add a project in project workspace setup before creating a Work Graph.')}</p>}
      <button type="button" className="secondary-button" disabled={loading || busy || uncertain} onClick={() => setReload(value => value + 1)}>{t('Refresh projects')}</button>
      <label>{t('New Work Graph name')}<input required maxLength={1024} disabled={busy || uncertain || !canCreate} value={name} onChange={event => { setName(event.target.value); setError(''); }} placeholder={t('For example, My first project')} /></label>
      {!selected && <button type="button" className="secondary-button" disabled={busy || uncertain} onClick={onSetupWorkspace}>{t('Set up project workspace')}</button>}
      <p>{t('Create an empty Work Graph and open the editor, or skip and create one later from the Work Graph library.')}</p>
      {error && <p className="welcome-agent-save-error" role="alert">{error}</p>}
      {uncertain && <p role="status">{t('The creation result is not yet confirmed. Retry with the same name to avoid duplicates, or skip to check the Work Graph library.')}</p>}
    </form>
  </WelcomeStepLayout>;
}
