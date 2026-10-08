import { useI18n } from '../i18n/I18nProvider';
import { WelcomeCommand } from './WelcomeCommand';
import './WorkspaceRestartHint.css';

export function WorkspaceRestartHint() {
  const { t } = useI18n();
  return <div className="workspace-restart-hint">
    <p>{t('Run this command on the Workspace device to restart and reconnect. Restarting cancels active and queued tasks; finish your tasks first.')}</p>
    <WelcomeCommand command="npx openworkgraph@latest restart" label={t('Workspace restart command')} copyLabel={t('Copy Workspace restart command')} />
  </div>;
}
