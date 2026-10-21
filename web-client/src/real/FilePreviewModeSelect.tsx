import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { FilePreviewMode } from './FileNodePreview';

export function FilePreviewModeSelect({ mode, options, onChange }: {
  mode: FilePreviewMode; options: { value: FilePreviewMode; label: string }[]; onChange(mode: FilePreviewMode): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const openingFocus = useRef<'first' | 'last' | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const close = () => { popup.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = trigger.current, panel = popup.current;
      if (!button || !panel) return;
      const anchor = button.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      panel.style.left = Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)) + 'px';
      panel.style.top = (anchor.bottom + 6 + bounds.height <= window.innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - bounds.height - 6)) + 'px';
    };
    position();
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const selected = openingFocus.current === 'first' ? buttons[0] : openingFocus.current === 'last' ? buttons.at(-1) : popup.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    openingFocus.current = undefined;
    selected?.focus({ preventScroll: true });
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" role="combobox" className="ow-file-preview-mode"
      aria-label={t('Preview display mode')} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} data-mode={mode} popoverTarget={id}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          openingFocus.current = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined;
          popup.current?.showPopover();
        }
      }}>
      <span>{options.find(option => option.value === mode)?.label}</span>
      <ChevronDown size={13} aria-hidden="true"/>
    </button>
    <div ref={popup} id={id} popover="auto" role="listbox" aria-label={t('Preview display mode')} className="ow-file-preview-mode-menu" data-canvas-interactive
      onToggle={event => setOpen(event.newState === 'open')}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') { popup.current?.hidePopover(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
          buttons[next]?.focus({ preventScroll: true });
        }
      }}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === mode} data-mode={option.value} tabIndex={-1}
        onClick={() => { onChange(option.value); close(); }}>
        <span>{option.label}</span><Check size={14} aria-hidden="true" style={{ visibility: option.value === mode ? 'visible' : 'hidden' }}/>
      </button>)}
    </div>
  </>;
}
