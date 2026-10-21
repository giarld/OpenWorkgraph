import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { NODE_BORDER_COLORS } from '../../../packages/protocol/src/node-appearance';
import type { WorkNode } from '../domain/types';
import { useI18n } from '../i18n/I18nProvider';
import { getNodeDefinition } from './node-registry';
import './NodeInfoDialog.css';

export function NodeInfoDialog({ node, disabled, onClose, onChange, onError }: {
  node: WorkNode;
  disabled: boolean;
  onClose(): void;
  onChange(color: string | null): Promise<void>;
  onError(error: unknown): void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const number = (value: number) => String(Math.round(value * 100) / 100);
  const colors = [{ name: 'Default', value: null }, ...NODE_BORDER_COLORS];
  return createPortal(<dialog ref={dialog} className="node-info-dialog panel" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="panel-heading">
      <strong id={titleId}>{t('Node information')}</strong>
      <button type="button" className="icon-button" aria-label={t('Close node information')} title={t('Close node information')} onClick={onClose}><X size={18}/></button>
    </div>
    <dl className="node-info-details">
      <dt>ID</dt><dd className="node-info-id">{node.id}</dd>
      <dt>{t('Name')}</dt><dd>{node.title}</dd>
      <dt>{t('Type')}</dt><dd>{t(node.type === 'group' ? 'Group' : getNodeDefinition(node.type).title)}</dd>
      <dt>{t('Dimensions')}</dt><dd>{number(node.width)} × {number(node.height)}</dd>
      <dt>{t('Coordinates')}</dt><dd>X: {number(node.x)} · Y: {number(node.y)}</dd>
    </dl>
    <fieldset className="node-info-colors" disabled={disabled || saving}>
      <legend>{t('Node border color')}</legend>
      <div className="node-info-swatches">{colors.map(color => <button key={color.name} type="button"
        className={'node-info-swatch' + (color.value === null ? ' node-info-swatch-default' : '')}
        style={{ '--swatch-color': color.value ?? 'var(--stroke)' } as CSSProperties}
        title={t(color.name)} aria-label={t(color.name)} aria-pressed={(node.borderColor ?? null) === color.value}
        onClick={() => {
          if ((node.borderColor ?? null) === color.value) return;
          setSaving(true);
          void onChange(color.value).catch(onError).finally(() => setSaving(false));
        }}><span aria-hidden="true"/></button>)}</div>
    </fieldset>
  </dialog>, document.body);
}
