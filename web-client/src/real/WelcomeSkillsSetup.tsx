import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Download, LoaderCircle, RotateCcw, Puzzle, Settings2 } from 'lucide-react';
import type { SkillCatalog } from '../../../packages/protocol/src/skills';
import type { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';
import { WelcomeStepActions, WelcomeStepLayout } from './WelcomeStepLayout';

const PAGE_SIZE = 12;

export function WelcomeSkillsSetup({ registry, serviceId, onBusy, onComplete }: {
  registry: ConnectionRegistry;
  serviceId: string;
  onBusy: (busy: boolean) => void;
  onComplete: () => void;
}) {
  const { t } = useI18n();
  const transport = useMemo(() => new Transport(registry, serviceId), [registry, serviceId]);
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState('');
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<Record<string, string>>({});
  const lifetime = useRef(0);
  const lock = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const items = catalog?.items ?? [];
  const hasMore = limit < items.length;

  useEffect(() => {
    const epoch = ++lifetime.current;
    setLoading(true); setError('');
    void transport.listSkills(reload > 0).then(result => {
      if (epoch === lifetime.current) setCatalog(result);
    }).catch(failure => { if (epoch === lifetime.current) setError(messageOf(failure)); })
      .finally(() => { if (epoch === lifetime.current) setLoading(false); });
    return () => { lifetime.current++; };
  }, [transport, reload]);

  useEffect(() => {
    const target = sentinel.current;
    const root = target?.closest('.welcome-step-content');
    if (!target || !root || !hasMore) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setLimit(value => value + PAGE_SIZE);
    }, { root, rootMargin: '80px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, limit]);

  async function installSkill(item: SkillCatalog['items'][number]) {
    if (lock.current || loading || item.installed || item.error) return;
    const epoch = lifetime.current;
    lock.current = true; setBusy(true); onBusy(true); setInstalling(item.skillId);
    setFailures(current => { const next = { ...current }; delete next[item.skillId]; return next; });
    try {
      const installed = await transport.installSkill(item.skillId, item.revision);
      window.dispatchEvent(new Event('openworkgraph:skills-changed'));
      if (epoch !== lifetime.current) return;
      setCatalog(current => current ? { ...current, items: current.items.map(row => row.skillId === installed.skillId ? installed : row) } : current);
    } catch (failure) {
      if (epoch !== lifetime.current) return;
      setFailures(current => ({ ...current, [item.skillId]: messageOf(failure) }));
      // Recover the revision and installation state after a lost response.
      try {
        const fresh = await transport.listSkills();
        if (epoch === lifetime.current) {
          setCatalog(fresh);
          if (fresh.items.some(row => row.skillId === item.skillId && row.installed)) {
            window.dispatchEvent(new Event('openworkgraph:skills-changed'));
          }
        }
      } catch { /* Keep the per-skill error available for retry. */ }
    } finally {
      lock.current = false;
      if (epoch === lifetime.current) { setBusy(false); setInstalling(''); onBusy(false); }
    }
  }

  return <WelcomeStepLayout className="welcome-skills-setup" actions={<WelcomeStepActions
    busy={busy} disabled={false} onSkip={onComplete} onConfirm={onComplete}
    label={t('Continue')}
    busyLabel={t('Continue')}
  />}>
    <header>
      <span className="welcome-agent-icon"><BookOpen size={22} aria-hidden="true" /></span>
      <div><h2>{t('Install skills')}</h2><p>{t('Choose skills from workgraph-skills to install in this Workspace. You can skip this step and install or configure them later in the Skill library.')}</p></div>
    </header>
    {loading && <p role="status">{t('Loading skills…')}</p>}
    {(error || catalog?.error || catalog?.stale) && <div className="welcome-agent-save-error" role="alert">
      <p>{error || catalog?.error || t('Showing cached skills. Refresh to check the source.')}</p>
      <button type="button" disabled={loading || busy} onClick={() => setReload(value => value + 1)}>{t('Reload and retry')}</button>
    </div>}
    {catalog && <p className="welcome-skills-summary" role="status">{t('{total} skills · {installed} installed', { total: items.length, installed: items.filter(item => item.installed).length })}</p>}
    {!loading && catalog && !items.length && <p>{t('No skills in this source.')}</p>}
    <ul className="welcome-skills-list" aria-label={t('Available skills')} aria-busy={busy || loading}>
      {items.slice(0, limit).map(item => <li key={item.skillId} className="welcome-skill-card" data-installing={installing === item.skillId} data-failed={!item.installed && !!failures[item.skillId]}>
        <div className="welcome-skill-choice">
          <span className="welcome-skill-icon" aria-hidden="true"><Puzzle size={20} strokeWidth={1.6} /></span>
          <span className="welcome-skill-copy">
            <span className="welcome-skill-heading"><strong>{item.name}</strong>
            </span>
            <span className="welcome-skill-description">{item.description}</span>
            {item.configuration === 'required' && <span className="welcome-skill-config"><Settings2 size={13} aria-hidden="true" />{t('Configure this skill in the Skill library before use.')}</span>}
          </span>
          <div className="welcome-skill-action" aria-live="polite">
            <button type="button" className="welcome-skill-install" disabled={busy || loading || item.installed || !!item.error}
              aria-label={t('{action}: {name}', { action: item.installed ? t('Installed') : installing === item.skillId ? t('Installing…') : failures[item.skillId] ? t('Installation failed · Retry') : t('Install'), name: item.name })}
              onClick={() => void installSkill(item)}>
              {item.installed ? <CheckCircle2 size={14} aria-hidden="true" /> : installing === item.skillId ? <LoaderCircle className="welcome-skill-spinner" size={14} aria-hidden="true" /> : failures[item.skillId] ? <RotateCcw size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
              {item.installed ? t('Installed') : installing === item.skillId ? t('Installing…') : failures[item.skillId] ? t('Installation failed · Retry') : t('Install')}
            </button>
          </div>
        </div>
        {(item.error || (!item.installed && failures[item.skillId])) && <p className="welcome-agent-save-error" role="alert">{item.error || failures[item.skillId]}</p>}
      </li>)}
    </ul>
    {hasMore && <div ref={sentinel} className="welcome-skills-more"><button type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>{t('Load more skills')}</button></div>}
  </WelcomeStepLayout>;
}
