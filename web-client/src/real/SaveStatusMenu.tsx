import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, FileText, RefreshCw, RotateCcw } from 'lucide-react';
import type { Draft } from './editor';
import type { GraphSnapshot, Json } from './contracts';
import { messageOf } from './contracts';
import { useI18n } from '../i18n/I18nProvider';

/** Saving failures can belong to a different node than the open prompt. */
export function SaveStatusMenu({ label, drafts, graph, disabled, locked, resolve, onError }: {
  label: string; drafts: Draft[]; graph: GraphSnapshot; disabled: boolean;
  locked(nodeId: string): boolean;
  resolve(draft: Draft, content?: Json): Promise<void>;
  onError(error: unknown): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!root.current || !menu.current) return;
      const bounds = root.current.getBoundingClientRect();
      const width = menu.current.getBoundingClientRect().width;
      menu.current.style.left = Math.max(16, Math.min(bounds.left, window.innerWidth - 16 - width)) + 'px';
      menu.current.style.top = bounds.bottom + 8 + 'px';
      menu.current.style.maxHeight = Math.max(120, Math.min(600, window.innerHeight - bounds.bottom - 24)) + 'px';
    };
    position(); window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open, drafts.length > 0]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    menu.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const handle = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setCopied('');
    try { await work(); }
    catch (error) { setError(messageOf(error)); onError(error); }
    finally { setBusy(false); }
  };
  return <div className="workgraph-save-status" ref={root}>
    <span role="status"><button ref={trigger} type="button" className="workgraph-save-trigger" aria-label={t('Save status: {status}', { status: label })}
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setError(''); setCopied(''); setOpen(value => !value); }}>
      {label}<ChevronDown size={12} aria-hidden="true"/>
    </button></span>
    {open && createPortal(<div ref={menu} className="workgraph-save-menu panel" data-empty={!drafts.length} role="menu" aria-label={t('Handle unsaved changes')} tabIndex={-1} aria-busy={busy}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') { setOpen(false); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button[role=menuitem]:not(:disabled)') ?? []);
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index < 0 ? buttons.length - 1 : index - 1 + buttons.length) % buttons.length;
          buttons[next].focus();
        }
      }}>
      <div className="workgraph-save-menu-heading"><span>{drafts.length ? t('Handle unsaved changes') : t('Save status')}</span>{drafts.length > 0 && <span className="workgraph-save-count">{drafts.length}</span>}</div>
      {!drafts.length ? <div className="workgraph-save-empty"><Check size={16} aria-hidden="true"/><span>{t('All changes are saved.')}</span></div> : <>
        {disabled && <p className="workgraph-save-note">{t('Saving is currently unavailable. You can still copy unsaved content.')}</p>}
        {drafts.map((draft, index) => {
          const node = graph.nodes.find(node => node.id === draft.nodeId);
          const content = draft.content && typeof draft.content === 'object' && !Array.isArray(draft.content) ? draft.content : {};
          const title = typeof content.title === 'string' && content.title ? content.title : node && node.content && typeof node.content === 'object' && !Array.isArray(node.content) && typeof node.content.title === 'string' ? node.content.title : draft.nodeId;
          const preview = ['prompt', 'text', 'summary'].map(key => typeof content[key] === 'string' ? content[key] : '').filter(Boolean).join('\n\n');
          const key = draft.draftId ?? draft.nodeId + ':' + index;
          const saving = draft.state === 'saving';
          const status = saving ? t('Saving') : draft.state === 'conflict' ? t('Conflict') : draft.state === 'failed' ? t('Save failed') : t('Unsaved');
          return <section key={key} role="group" aria-label={title} className="workgraph-save-entry">
            <div className="workgraph-save-entry-heading"><FileText size={14} aria-hidden="true"/><strong title={title}>{title}</strong><span>{status}</span></div>
            {preview ? <div className="workgraph-save-preview">{preview}</div> : <p className="workgraph-save-note">{t('This change contains node settings. Copy the content to inspect the complete version.')}</p>}
            {!node && <p className="workgraph-save-note">{t('The node was removed. Copy your changes or discard them to continue.')}</p>}
            {draft.error && <p className="workgraph-save-error">{draft.error}</p>}
            <div className="workgraph-save-actions">
              <button type="button" role="menuitem" disabled={disabled || busy || saving || !node || node.readOnly || locked(draft.nodeId)} onClick={() => void handle(() => resolve(draft, draft.content))}><RefreshCw size={14}/>{t('Retry saving')}</button>
              <button type="button" role="menuitem" disabled={disabled || busy || saving} onClick={() => void handle(() => resolve(draft))}><RotateCcw size={14}/>{t('Use saved version')}</button>
              <button type="button" role="menuitem" disabled={busy} onClick={() => void handle(async () => { await navigator.clipboard.writeText(JSON.stringify(draft.content, null, 2)); setCopied(key); })}><Copy size={14}/>{t('Copy unsaved content')}</button>
            </div>
            {copied === key && <p className="workgraph-save-note" role="status">{t('Unsaved content copied.')}</p>}
          </section>;
        })}
      </>}
      {error && <p className="workgraph-save-error" role="alert">{error}</p>}
    </div>, root.current?.closest('.real-workspace') ?? document.body)}
  </div>;
}
