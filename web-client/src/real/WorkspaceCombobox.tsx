import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import type { Connection } from '../adapter/connections';
import { useI18n } from '../i18n/I18nProvider';

export function WorkspaceCombobox({ connections, value, disabled, onChange, onConnect }: {
  connections: Connection[]; value: string; disabled?: boolean;
  onChange(id: string): void; onConnect(): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const selected = connections.find(item => item.serviceId === value);
  const matches = connections.filter(item => `${item.runtimeName ?? ''} ${item.address}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const choose = (index: number) => { const item = matches[index]; if (!item) return; close(); onChange(item.serviceId); };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id]);
  const expand = () => { setQuery(''); setActive(Math.max(0, connections.findIndex(item => item.serviceId === value))); setOpen(true); };
  return <div className="workspace-combobox" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" role="combobox" aria-label={t('Workspace')} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
      disabled={disabled} className="workspace-combobox-trigger" onClick={() => open ? close() : expand()}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); expand(); } }}>
      <span>{selected?.runtimeName || selected?.address || t('Select Workspace')}</span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    {open && <div className="workspace-combobox-popover">
      <div className="workspace-combobox-search"><Search size={16} aria-hidden="true"/><input ref={search} role="combobox" aria-label={t('Search Workspaces')} placeholder={t('Search Workspaces')}
        aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); choose(active); }
          if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); setActive(0); }
          if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); setActive(matches.length - 1); }
        }}/>
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={t('Workspaces')} className="workspace-combobox-options">
        {matches.map((item, index) => <div key={item.serviceId} id={`${id}-option-${index}`} role="option" aria-selected={item.serviceId === value}
          className={index === active ? 'is-active' : ''} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <span><strong>{item.runtimeName || item.address}</strong>{item.runtimeName && <small>{item.address}</small>}</span>
          {item.serviceId === value && <Check size={16} aria-hidden="true"/>}
        </div>)}
      </div>
      {!matches.length && <p className="workspace-combobox-empty" role="status">{t('No matching Workspaces')}</p>}
      <button type="button" className="workspace-combobox-connect" onClick={() => { close(); onConnect(); }}><Plus size={16} aria-hidden="true"/>{t('Connect new Workspace')}</button>
    </div>}
  </div>;
}
