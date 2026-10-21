import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Globe, SlidersHorizontal, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { VisualizePagePermission, VisualizePagePermissions } from './visualize-permissions';
import './VisualizePageInfo.css';

const browserPermissionLabels = {
  downloads: 'File downloads', clipboardRead: 'Read clipboard', clipboardWrite: 'Write clipboard', fullscreen: 'Fullscreen', screenCapture: 'Screen sharing',
  camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', payment: 'Payment', usb: 'USB devices', serial: 'Serial devices',
} as const;

export function VisualizePageInfo({ title, permissions, usedPermissions, onChange }: {
  title: string; permissions: VisualizePagePermissions; usedPermissions: VisualizePagePermission[]; onChange(value: VisualizePagePermissions): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { popup.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = trigger.current, panel = popup.current;
      if (!button || !panel) return;
      const anchor = button.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8));
      const top = anchor.bottom + 8 + bounds.height <= window.innerHeight - 8 ? anchor.bottom + 8 : Math.max(8, anchor.top - bounds.height - 8);
      panel.style.left = left + 'px'; panel.style.top = top + 'px';
    };
    position();
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, usedPermissions]);
  useLayoutEffect(() => { if (open) popup.current?.focus({ preventScroll: true }); }, [open]);
  const browserPermissions = Object.entries(browserPermissionLabels).filter(([key]) => usedPermissions.includes(key as VisualizePagePermission));
  return <>
    <button ref={trigger} className="ow-visualize-header-action ow-visualize-page-info-button" type="button" aria-label={t('Page information')} title={t('Page information')} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id} onPointerDown={event => event.stopPropagation()}>
      <SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true"/>
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-labelledby={id + '-title'} tabIndex={-1} className="ow-visualize-page-info" onToggle={event => setOpen(event.newState === 'open')}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const controls = Array.from(popup.current?.querySelectorAll<HTMLElement>('button, input') ?? []);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === popup.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === popup.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header><h3 id={id + '-title'}>{t('Page information')}</h3><button type="button" aria-label={t('Close page information')} onClick={close}><X size={16} aria-hidden="true"/></button></header>
      <div className="ow-visualize-page-info-summary"><Globe size={20} strokeWidth={1.75} aria-hidden="true"/><div><strong>{title || t('Interactive page')}</strong><span>{t('Visualization node page')}</span></div></div>
      {usedPermissions.includes('network') && <fieldset><legend>{t('Page permissions')}</legend>
        <label><span>{t('Network requests')}<small>{t('Read and send data over the network')}</small></span><input type="checkbox" checked={permissions.network} onChange={event => onChange({ ...permissions, network: event.target.checked })}/></label>
      </fieldset>}
      {browserPermissions.length > 0 && <fieldset className="ow-visualize-browser-permissions"><legend>{t('Browser capabilities')}</legend>
        {browserPermissions.map(([key, label]) => <label key={key}><span>{t(label)}</span><input type="checkbox" checked={permissions[key as keyof typeof browserPermissionLabels]} onChange={event => onChange({ ...permissions, [key]: event.target.checked })}/></label>)}
      </fieldset>}
      {usedPermissions.some(key => !['network', 'downloads', 'fullscreen'].includes(key)) && <p>{t('Browser approval may still be required.')}</p>}
      {usedPermissions.length > 0 && <p>{t('Changes reload this page. Permissions are saved in this browser.')}</p>}
    </div>
  </>;
}
