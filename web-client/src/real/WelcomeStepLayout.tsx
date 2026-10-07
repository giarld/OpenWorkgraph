import type { ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

export function WelcomeStepLayout({ children, actions, className = '', contentClassName = '' }: {
  children: ReactNode;
  actions: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return <div className={`welcome-step-layout ${className}`}>
    <div className={`welcome-agent-setup welcome-step-content ${contentClassName}`}>{children}</div>
    <footer className="welcome-step-actions">{actions}</footer>
  </div>;
}

export function WelcomeStepActions({ busy, disabled, onSkip, onConfirm, form, label, busyLabel }: {
  busy: boolean;
  disabled: boolean;
  onSkip: () => void;
  onConfirm?: () => void;
  form?: string;
  label?: string;
  busyLabel?: string;
}) {
  const { t } = useI18n();
  return <>
    <button className="secondary-button" type="button" disabled={busy} onClick={onSkip}>{t('Skip')}</button>
    <button className="primary-button" type={form ? 'submit' : 'button'} form={form} disabled={busy || disabled} onClick={onConfirm}>
      {busy ? busyLabel ?? t('Saving settings…') : label ?? t('Confirm and continue')}
    </button>
  </>;
}
