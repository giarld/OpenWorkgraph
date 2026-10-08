import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import './PreviewDialogStack.css';

export interface PreviewDialogLayer { id: string; title: string; content: ReactNode }
export interface PreviewDialogNavigation { layers: PreviewDialogLayer[]; pending?: boolean; onBack(): void }

export function PreviewDialogHeading({ title, titleId, navigation, onClose, closeLabel }: { title: string; titleId?: string; navigation?: PreviewDialogNavigation; onClose(): void; closeLabel: string }) {
  const { t } = useI18n();
  return <header className="panel-heading preview-dialog-heading">
    {!!navigation?.layers.length && <button className="icon-button preview-dialog-back" aria-label={t('Back')} title={t('Back')} onClick={navigation.onBack}><ArrowLeft size={18}/></button>}
    <h2 id={titleId}>{navigation?.layers.at(-1)?.title ?? title}</h2>
    {navigation?.pending && <span className="muted" role="status">{t('Loading preview…')}</span>}
    <button className="icon-button" aria-label={closeLabel} onClick={onClose}><X size={18}/></button>
  </header>;
}

function Layer({ active, className = '', children, autoFocus = true }: { active: boolean; className?: string; children: ReactNode; autoFocus?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (!active) return;
    const target = focus.current?.isConnected ? focus.current : element.current;
    if (initialized.current || autoFocus) target?.focus({ preventScroll: true });
    initialized.current = true;
    return () => {
      if (document.activeElement instanceof HTMLElement && element.current?.contains(document.activeElement)) focus.current = document.activeElement;
      element.current?.querySelectorAll('video, audio').forEach(media => (media as HTMLMediaElement).pause());
    };
  }, [active, autoFocus]);
  return <div ref={element} className={'preview-dialog-layer ' + className} data-preview-layer-active={active} aria-hidden={!active} inert={!active} tabIndex={-1} onFocusCapture={event => { if (event.target !== element.current) focus.current = event.target as HTMLElement; }}>{children}</div>;
}

/** Keep covered layers mounted so scroll positions, view modes and drafts survive Back. */
export function PreviewDialogLayers({ navigation, children, rootClassName }: { navigation?: PreviewDialogNavigation; children: ReactNode; rootClassName?: string }) {
  const layers = navigation?.layers ?? [];
  return <div className="preview-dialog-layers">
    <Layer active={!layers.length} className={rootClassName} autoFocus={false}>{children}</Layer>
    {layers.map((layer, index) => <Layer key={layer.id} active={index === layers.length - 1} className="preview-dialog-file-layer">{layer.content}</Layer>)}
  </div>;
}

export function visibleDialogControls(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], video[controls], audio[controls], [tabindex="0"]') ?? [])
    .filter(element => !element.closest('[inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
}
