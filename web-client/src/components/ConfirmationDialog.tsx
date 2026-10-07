import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nProvider';
import './ConfirmationDialog.css';

/** Shared management confirmation; native modal focus trapping and restoration. */
export function ConfirmationDialog({ title, text, disabled = false, onCancel, onConfirm }: {
  title: string; text: string; disabled?: boolean; onCancel(): void; onConfirm(): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" role="alertdialog" aria-label={title} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }} onClose={onCancel}>
    <p id={descriptionId}>{text}</p>
    <div className="confirmation-dialog-actions">
      <button type="button" autoFocus onClick={onCancel}>{t('Cancel')}</button>
      <button type="button" className="confirmation-dialog-primary" disabled={disabled} onClick={() => { if (!disabled) onConfirm(); }}>{t('Confirm action')}</button>
    </div>
  </dialog>, document.body);
}
