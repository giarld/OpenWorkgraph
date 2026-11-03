import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { BuiltinAgentDiscoveredModel } from '../../../packages/protocol/src/builtin-agent';
import { useI18n } from '../i18n/I18nProvider';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
function score(value: string, query: string): number {
  const direct = value.indexOf(query);
  if (direct >= 0) return direct;
  let last = -1;
  for (const character of query) {
    last = value.indexOf(character, last + 1);
    if (last < 0) return Infinity;
  }
  return 1000 + last - query.length;
}

/** Settings-only directory picker. Selecting an option adds it to the model draft. */
export function BuiltinAgentModelCombobox({ models, disabled, onAdd }: {
  models: BuiltinAgentDiscoveredModel[]; disabled: boolean; onAdd(id: string): void;
}) {
  const { language } = useI18n(), text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const catalog = useMemo(() => models.map(model => ({ model, name: normalize(model.name), id: normalize(model.id) })), [models]);
  const matches = useMemo(() => {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return models;
    return catalog.map(item => ({ model: item.model, score: terms.reduce((total, term) => total + Math.min(score(item.name, term), score(item.id, term)), 0) }))
      .filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score).map(item => item.model);
  }, [catalog, models, query]);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const close = () => { popup.current?.hidePopover(); trigger.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => { const model = matches[index]; if (!model || disabled) return; close(); onAdd(model.id); };
  useEffect(() => { if (disabled) popup.current?.hidePopover(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = trigger.current, panel = popup.current;
      if (!button || !panel) return;
      const bounds = button.getBoundingClientRect(), below = innerHeight - bounds.bottom - 14, above = bounds.top - 14;
      const down = below >= Math.min(320, above), width = Math.min(Math.max(bounds.width, 280), innerWidth - 16);
      Object.assign(panel.style, { width: width + 'px', left: Math.max(8, Math.min(bounds.left, innerWidth - width - 8)) + 'px',
        top: down ? bounds.bottom + 6 + 'px' : 'auto', bottom: down ? 'auto' : innerHeight - bounds.top + 6 + 'px',
        maxHeight: Math.max(0, Math.min(360, down ? below : above)) + 'px' });
    };
    position(); search.current?.focus({ preventScroll: true });
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(id + '-option-' + current)?.scrollIntoView({ block: 'nearest' });
  }, [open, current, matches, id]);
  return <div className="builtin-agent-model-combobox">
    <label htmlFor={id + '-trigger'}>{text('目录模型', 'Catalog model')}</label>
    <button ref={trigger} id={id + '-trigger'} type="button" role="combobox" aria-label={text('目录模型', 'Catalog model')}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={id + '-list'} disabled={disabled}
      className="builtin-agent-model-trigger" popoverTarget={id + '-popup'} onClick={() => { setQuery(''); setActive(0); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setActive(0); popup.current?.showPopover(); } }}>
      <span>{text('选择要添加的模型', 'Choose a model to add')}</span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    <div ref={popup} id={id + '-popup'} popover="auto" className="builtin-agent-model-popup" onToggle={event => setOpen(event.newState === 'open')}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) popup.current?.hidePopover(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') popup.current?.hidePopover();
      }}>
      <div className="builtin-agent-model-search"><Search size={16} aria-hidden="true"/><input ref={search} type="text" role="combobox" autoComplete="off" spellCheck={false}
        aria-label={text('搜索目录模型', 'Search catalog models')} placeholder={text('搜索模型名称或 ID', 'Search model name or ID')}
        aria-autocomplete="list" aria-expanded={open} aria-controls={id + '-list'} aria-activedescendant={matches[current] ? id + '-option-' + current : undefined}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); choose(current); }
          if (event.ctrlKey && event.key === 'Home') { event.preventDefault(); setActive(0); }
          if (event.ctrlKey && event.key === 'End') { event.preventDefault(); setActive(Math.max(0, matches.length - 1)); }
        }}/></div>
      <div id={id + '-list'} role="listbox" aria-label={text('目录模型', 'Catalog model')} className="builtin-agent-model-options">
        {matches.map((model, index) => <button key={model.id} id={id + '-option-' + index} type="button" role="option" tabIndex={-1}
          aria-selected={index === current} className={index === current ? 'is-active' : ''} onPointerMove={() => setActive(index)}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <strong>{model.name}</strong>{model.name !== model.id && <small>{model.id}</small>}
        </button>)}
      </div>
      {!matches.length && <p className="builtin-agent-model-empty" role="status">{text('没有匹配的模型', 'No matching models')}</p>}
    </div>
  </div>;
}
