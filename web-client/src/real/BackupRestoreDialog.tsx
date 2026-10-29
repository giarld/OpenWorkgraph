import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BackupRestoreChallenge } from '../../../packages/protocol/src/index';
import { useI18n } from '../i18n/I18nProvider';
import '../components/ConfirmationDialog.css';
import './BackupRestoreDialog.css';

export function BackupRestoreDialog({ preview, disabled, pending, onCancel, onConfirm }: {
  preview: BackupRestoreChallenge; disabled: boolean; pending: boolean; onCancel(): void; onConfirm(): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { element.close(); }; }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog backup-restore-dialog" role="alertdialog" aria-label={t('Restore backup')}
    onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <h3>{t('Restore backup')}</h3>
    <p>{t('This replaces all Workspace data, disconnects every browser, and pauses queued tasks. All Workspace operations are blocked during restoration.')}</p>
    <p>{t('Backup version: {source}. Workspace version: {target}.', { source: preview.serviceVersion, target: preview.targetServiceVersion })}</p>
    {preview.requiresUpgrade && <p>{t('The backup database will be upgraded from schema {source} to {target} before restoration.', { source: preview.schemaVersion, target: preview.targetSchemaVersion })}</p>}
    <label>{t('Type RESTORE to confirm')}<input autoFocus autoComplete="off" spellCheck={false} disabled={disabled} value={text} onChange={event => setText(event.target.value)} /></label>
    <div className="confirmation-dialog-actions">
      <button type="button" disabled={pending} onClick={onCancel}>{t('Cancel')}</button>
      <button type="button" className="confirmation-dialog-primary" disabled={disabled || text !== 'RESTORE'} onClick={() => { if (!disabled && text === 'RESTORE') onConfirm(); }}>{t('Restore backup')}</button>
    </div>
  </dialog>, document.body);
}
