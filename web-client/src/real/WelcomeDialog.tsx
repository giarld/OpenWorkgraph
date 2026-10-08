import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Bot, Check, FileText, Network, Server, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import './WelcomeDialog.css';
import webClientPackage from '../../package.json';
import { WelcomeRuntimePairing } from './WelcomeRuntimePairing';
import { WelcomeAgentSetup } from './WelcomeAgentSetup';
import { WelcomeImageSetup } from './WelcomeImageSetup';
import { WelcomeSkillsSetup } from './WelcomeSkillsSetup';
import { WelcomeWorkspaceSetup } from './WelcomeWorkspaceSetup';
import { WelcomeGraphSetup } from './WelcomeGraphSetup';
import { WelcomeCommand } from './WelcomeCommand';
import type { ConnectionRegistry } from '../adapter/connections';

export function WelcomeDialog({ registry, theme, onPairingStart, onModelsChanged, onClose, onComplete }: {
  registry: ConnectionRegistry;
  theme: 'dark' | 'light';
  onPairingStart: () => void;
  onModelsChanged: () => void;
  onClose: () => void;
  onComplete: (serviceId: string, projectId: string, graphId?: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(0);
  const steps = ['Welcome to Workgraph', 'Connect Workspace', 'Set up Agent', 'Set up project workspace', 'Set up image models', 'Install skills', 'Create your first Work Graph'] as const;
  const stepLabels = [t('Welcome'), t('Workspace'), t('Agent'), t('Project workspace'), t('Image models'), t('Skills'), t('Work Graph')];
  const [setupProjectId, setSetupProjectId] = useState('');
  const [setupServiceId, setSetupServiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) { setOpen(false); onClose(); } };
  const dialog = useRef<HTMLDialogElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.showModal();
    element.focus({ preventScroll: true });
    return () => element.close();
  }, [open]);

  useEffect(() => {
    if (!pages.current) return;
    pages.current.scrollTo({
      top: pages.current.clientHeight * page,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
    if (page !== 0) closeButton.current?.focus({ preventScroll: true });
    const viewport = pages.current;
    // Observe after the initial smooth scroll has started without resetting it.
    let initial = true;
    const resizeObserver = new ResizeObserver(() => {
      if (initial) { initial = false; return; }
      viewport.scrollTo({ top: viewport.clientHeight * page, behavior: 'instant' });
    });
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, [page]);

  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      className="welcome-dialog panel"
      tabIndex={-1}
      aria-label={t(steps[page])}
      onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, a[href], summary, [tabindex="0"]')).filter(button => !button.closest('[inert]') && !button.matches(':disabled') && button.checkVisibility());
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          last?.focus({ preventScroll: true });
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          first?.focus({ preventScroll: true });
        }
      }}
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <ol className="welcome-progress">
        {steps.map((label, index) => (
          <li key={label} aria-label={t(label)} title={t(label)} aria-current={page === index ? 'step' : undefined} className={page > index ? 'is-complete' : undefined}>
            <span className="welcome-progress-number" aria-hidden="true">{page > index ? <Check size={12} /> : index + 1}</span>
            <span className="welcome-progress-label">{stepLabels[index]}</span>
          </li>
        ))}
      </ol>
      <button ref={closeButton} className="icon-button welcome-close" aria-label={t('Close introduction')} disabled={busy} onClick={close}>
        <X size={20} />
      </button>
      <div ref={pages} className="welcome-pages">
        <section className="welcome-page welcome-intro" inert={page !== 0}>
          <div className="welcome-graph-preview" aria-hidden="true">
            <span className="welcome-preview-node"><FileText size={22} /><i /><i /></span>
            <span className="welcome-preview-edge" />
            <span className="welcome-preview-node welcome-preview-agent"><Bot size={28} /><i /></span>
            <span className="welcome-preview-edge" />
            <span className="welcome-preview-node"><Network size={22} /><i /><i /></span>
          </div>
          <div className="welcome-brand">
            <img
              className="welcome-brand-logo"
              src={theme === 'dark' ? '/brand/openworkgraph-wordmark-light.svg' : '/brand/openworkgraph-wordmark-dark.svg'}
              alt=""
              aria-hidden="true"
            />
            <span className="brand-version-badge" title={`OpenWorkgraph v${webClientPackage.version}`}>v{webClientPackage.version}</span>
          </div>
          <h1>{t('Welcome to Workgraph')}</h1>
          <p>{t('Bring ideas, tasks, and outputs together in one Work Graph. Whether you write with others, create art, or build software and hardware, collaborate with AI to turn ideas into reality.')}</p>
          <button className="primary-button" onClick={() => setPage(1)}>
            {t('Quick start')}<ArrowDown size={18} />
          </button>
        </section>
        <section className="welcome-page welcome-tutorial" aria-label={t('Connect Workspace')} inert={page !== 1}>
          <header className="welcome-section-heading">
            <span className="welcome-agent-icon"><Server size={22} aria-hidden="true" /></span>
            <h2>{t('Connect Workspace')}</h2>
          </header>
          <ol className="welcome-setup-steps">
            <li>
              <h3>{t('Install Codex CLI')}</h3>
              <p>{t('Follow the official guide to install and configure Codex CLI.')}</p>
              <WelcomeCommand command="npm install -g @openai/codex" copyLabel={t('Copy Codex installation command')} />
              <a href="https://developers.openai.com/codex/cli/" target="_blank" rel="noopener noreferrer">{t('Open Codex CLI installation guide')}</a>
            </li>
            <li>
              <h3>{t('Start Workspace')}</h3>
              <p>{t('Run this command in a terminal on the device that will run your Workspace:')}</p>
              <WelcomeCommand command="npx openworkgraph@latest start" copyLabel={t('Copy start command')} />
              <p className="welcome-start-note">{t('Requires Node.js 24+. No global installation needed; the first run downloads the required package.')}</p>
              <details className="welcome-start-options">
                <summary>{t('Other startup options')}</summary>
                <div className="welcome-start-options-content">
                  <p>{t('For frequent use, install the CLI globally, then start your Workspace:')}</p>
                  <WelcomeCommand command="npm install -g openworkgraph" copyLabel={t('Copy installation command')} />
                  <WelcomeCommand command="openworkgraph start" copyLabel={t('Copy global start command')} />
                </div>
              </details>
            </li>
            <li>
              <h3>{t('Pair Workspace')}</h3>
              <WelcomeRuntimePairing registry={registry} onStart={onPairingStart} onBusy={setBusy} onComplete={id => { setSetupServiceId(id); setPage(2); }} />
            </li>
          </ol>
        </section>
        <section className="welcome-page welcome-agent-page" aria-label={t('Set up Agent')} inert={page !== 2}>
          {page === 2 && setupServiceId && <WelcomeAgentSetup registry={registry} serviceId={setupServiceId} onBusy={setBusy} onModelsChanged={onModelsChanged} onComplete={() => setPage(3)} />}
        </section>
        <section className="welcome-page welcome-agent-page welcome-workspace-page" aria-label={t('Set up project workspace')} inert={page !== 3}>
          {page === 3 && <WelcomeWorkspaceSetup registry={registry} serviceId={setupServiceId} onBusy={setBusy} onComplete={id => { setSetupProjectId(id); setPage(4); }} onSkip={() => { setSetupProjectId(''); setPage(4); }} />}
        </section>
        <section className="welcome-page welcome-agent-page welcome-image-page" aria-label={t('Set up image models')} inert={page !== 4}>
          {page === 4 && <WelcomeImageSetup registry={registry} serviceId={setupServiceId} onBusy={setBusy} onComplete={() => setPage(5)} />}
        </section>
        <section className="welcome-page welcome-agent-page welcome-skills-page" aria-label={t('Install skills')} inert={page !== 5}>
          {page === 5 && <WelcomeSkillsSetup registry={registry} serviceId={setupServiceId} onBusy={setBusy} onComplete={() => setPage(6)} />}
        </section>
        <section className="welcome-page welcome-agent-page welcome-graph-page" aria-label={t('Create your first Work Graph')} inert={page !== 6}>
          {page === 6 && <WelcomeGraphSetup registry={registry} serviceId={setupServiceId} projectId={setupProjectId} onBusy={setBusy} onSetupWorkspace={() => setPage(3)} onComplete={(projectId, graphId) => { setOpen(false); onComplete(setupServiceId, projectId, graphId); }} />}
        </section>
      </div>
    </dialog>
  );
}
