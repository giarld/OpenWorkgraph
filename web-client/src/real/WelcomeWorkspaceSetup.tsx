import { useEffect, useId, useMemo, useState } from 'react';
import { Folder } from 'lucide-react';
import type { Project, ProjectCandidates } from '../../../packages/protocol/src/index';
import type { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';
import { WelcomeStepActions, WelcomeStepLayout } from './WelcomeStepLayout';

export function WelcomeWorkspaceSetup({ registry, serviceId, onBusy, onComplete, onSkip }: {
  registry: ConnectionRegistry;
  serviceId: string;
  onBusy: (busy: boolean) => void;
  onComplete: (projectId: string) => void;
  onSkip: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const transport = useMemo(() => new Transport(registry, serviceId), [registry, serviceId]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [candidates, setCandidates] = useState<ProjectCandidates>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [candidateError, setCandidateError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [path, setPath] = useState('');
  const selected = projects.find(item => item.projectId === projectId);
  const usable = (project: Project) => project.state === 'active' && project.availability !== 'unavailable';

  useEffect(() => {
    let live = true;
    setLoading(true); setLoadError(''); setCandidateError('');
    void Promise.allSettled([
      transport.request<Project[]>('/v1/projects/all'),
      transport.request<ProjectCandidates>('/v1/project-candidates'),
    ]).then(([registered, discovered]) => {
      if (!live) return;
      if (registered.status === 'fulfilled') setProjects(registered.value);
      else setLoadError(messageOf(registered.reason));
      if (discovered.status === 'fulfilled') setCandidates(discovered.value);
      else setCandidateError(messageOf(discovered.reason));
      setLoading(false);
    });
    return () => { live = false; };
  }, [transport, reload]);

  async function continueSetup() {
    if (busy || (!selected && !path.trim())) return;
    setBusy(true); onBusy(true); setError('');
    try {
      // Re-read existing projects to check availability without registering duplicates.
      const project = selected
        ? (await transport.request<Project[]>('/v1/projects/all')).find(item => item.projectId === selected.projectId)
        : await transport.request<Project>('/v1/projects', { path: path.trim() });
      if (!project || !usable(project)) throw new Error(t('This project workspace is disabled or its directory is unavailable. Choose another project workspace.'));
      onComplete(project.projectId);
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); onBusy(false); }
  }

  return <WelcomeStepLayout className="welcome-workspace-setup" actions={<WelcomeStepActions busy={busy} disabled={selected ? !usable(selected) : !path.trim()} onSkip={onSkip} form={formId} />}>
    <header>
      <span className="welcome-agent-icon"><Folder size={22} aria-hidden="true" /></span>
      <div><h2>{t('Set up project workspace')}</h2><p>{t('Choose a project directory on the Workspace computer as your project workspace for Work Graphs and Agent tasks.')}</p></div>
    </header>
    <form id={formId} className="welcome-agent-card" onSubmit={event => { event.preventDefault(); void continueSetup(); }}>
      <h3>{t('Project workspace directory')}</h3>
      {loading && <p role="status">{t('Loading…')}</p>}
      {loadError && <p role="alert">{loadError}</p>}
      <label>{t('Registered project workspaces')}<select aria-label={t('Registered project workspaces')} value={projectId} disabled={loading || busy} onChange={event => { setProjectId(event.target.value); setError(''); }}>
        <option value="">{t('Add a project workspace directory')}</option>
        {projects.map(project => <option key={project.projectId} value={project.projectId} disabled={!usable(project)}>{project.name} · {project.canonicalPath}{!usable(project) ? ' · ' + t('Disabled') : ''}</option>)}
      </select></label>
      {selected ? <p className="welcome-workspace-path">{selected.canonicalPath}</p> : <>
        {candidates && candidates.candidates.length > 0 && <label>{t('Codex project directories')}<select aria-label={t('Codex project directories')} value={candidates.candidates.some(item => item.path === path) ? path : ''} disabled={busy || loading} onChange={event => { setPath(event.target.value); setError(''); }}>
          <option value="">{t('Enter a directory manually')}</option>
          {candidates.candidates.filter(candidate => !projects.some(project => project.canonicalPath === candidate.path)).map(candidate => <option key={candidate.path} value={candidate.path} disabled={candidate.availability !== 'available'}>{candidate.path}{candidate.availability !== 'available' ? ' · ' + t('Directory unavailable') : ''}</option>)}
        </select></label>}
        {(candidateError || candidates?.status === 'unavailable') && <p>{t('Codex project directories could not be loaded. You can enter a directory manually.')}</p>}
        <label>{t('Absolute directory path on Workspace')}<input required disabled={busy} value={path} onChange={event => { setPath(event.target.value); setError(''); }} placeholder={t('Enter an absolute directory path')} /></label>
        <p>{t('Enter an existing directory on the Workspace computer. No directory will be created.')}</p>
      </>}
      <button type="button" disabled={loading || busy} onClick={() => setReload(value => value + 1)}>{t('Refresh project workspaces')}</button>
      {error && <p role="alert" className="welcome-agent-save-error">{error}</p>}
      {busy && <p role="status">{t('Saving project workspace…')}</p>}
    </form>
  </WelcomeStepLayout>;
}
