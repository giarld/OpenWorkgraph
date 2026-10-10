import { useId, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { runtimeNeedsUpgrade } from '../domain/runtime-version';
import { WelcomeCommand } from './WelcomeCommand';
import './WorkspaceUpgradeHint.css';

export interface WorkspaceUpgradeHintProps {
  serviceId: string;
  runtimeVersion: string;
  clientVersion: string;
  installation?: 'npm-global' | 'npx' | 'other';
  updating?: boolean;
  updateDisabled?: boolean;
  onUpdate?: () => void;
  onManage: () => void;
}

export function WorkspaceUpgradeHint(props: WorkspaceUpgradeHintProps) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const contentId = useId();
  if (!runtimeNeedsUpgrade(props.runtimeVersion, props.clientVersion)) return null;
  return <details ref={details} className="workspace-upgrade-hint panel" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && details.current?.open) {
      event.preventDefault();
      details.current.open = false;
      details.current.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-controls={contentId}>{t('Workspace upgrade required')}</summary>
    <div id={contentId} className="workspace-upgrade-content">
      <p>{t('Upgrade Workspace v{runtimeVersion} to v{clientVersion}', { runtimeVersion: props.runtimeVersion, clientVersion: props.clientVersion })}</p>
      {props.installation === 'npm-global' ? <>
        <p>{t('This Workspace was installed globally with npm. Updating restarts it and cancels active and queued tasks; finish your tasks first.')}</p>
        {props.onUpdate && <button type="button" disabled={props.updateDisabled || props.updating} onClick={props.onUpdate}>{props.updating ? t('Updating Workspace…') : t('Update Workspace')}</button>}
      </> : props.installation === 'other' ?
        <p>{t('This Workspace uses a custom installation. Update it using its original installation method, then restart and reconnect. Restarting cancels active and queued tasks; finish your tasks first.')}</p> : <>
        {!props.installation && <p>{t('The Workspace did not report its installation method. If you started it with npx, use the command below; otherwise update it using its original installation method.')}</p>}
        <p>{t('Run this command on the Workspace device to restart with the latest version. Restarting cancels active and queued tasks; finish your tasks first.')}</p>
        <WelcomeCommand command="npx openworkgraph@latest restart" label={t('Workspace upgrade command')} copyLabel={t('Copy Workspace upgrade command')} />
      </>}
      <button type="button" className="workspace-upgrade-manage" onClick={props.onManage}>{t('Open Workspace management')}</button>
    </div>
  </details>;
}
