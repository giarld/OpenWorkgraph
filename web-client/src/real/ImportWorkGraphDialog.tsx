import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../../../packages/protocol/src/index';
import { useI18n } from '../i18n/I18nProvider';
import '../components/ConfirmationDialog.css';

export function ImportWorkGraphDialog({ fileName, workspace, projects, initialProjectId, disabled, onCancel, onConfirm }: {
  fileName: string; workspace: string; projects: Project[]; initialProjectId: string; disabled: boolean;
  onCancel(): void; onConfirm(projectId: string): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();
  const [projectId, setProjectId] = useState(initialProjectId);
  const available = projects.filter(project => project.state === 'active' && project.availability !== 'unavailable');
  const selected = available.find(project => project.projectId === projectId);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog workgraph-import-dialog" aria-label={t('Import Work Graph')} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && selected) onConfirm(selected.projectId); }}>
      <h2>{t('Import Work Graph')}</h2>
      <p>{fileName}</p>
      <p>{t('Target Workspace: {workspace}', { workspace })}</p>
      <p id={descriptionId}>{t('Select a project to create a new Work Graph. The current Work Graph will not be overwritten.')}</p>
      <label>{t('Target project (required)')}<select autoFocus required value={selected?.projectId ?? ''} disabled={disabled}
        onChange={event => setProjectId(event.target.value)}>
        <option value="">{t('Select a project')}</option>
        {available.map(project => <option key={project.projectId} value={project.projectId}>{project.name} · {project.canonicalPath}</option>)}
      </select></label>
      <div className="confirmation-dialog-actions">
        <button type="button" onClick={onCancel}>{t('Cancel')}</button>
        <button type="submit" className="confirmation-dialog-primary" disabled={disabled || !selected}>{t('Confirm import')}</button>
      </div>
    </form>
  </dialog>, document.body);
}
