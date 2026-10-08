import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ConfirmationDialog.css';

/** Non-dismissible modal: the page stays inert until the operation settles. */
export function ProgressDialog({ title }: { title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" aria-label={title}
    aria-modal="true" aria-busy="true" onCancel={event => event.preventDefault()}>
    <p role="status">{title}</p>
    <progress aria-label={title} style={{ width: '100%', marginTop: 16 }} />
  </dialog>, document.body);
}
