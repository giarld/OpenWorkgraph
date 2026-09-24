import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import type { WorkNode } from '../domain/types';
import { getNodeDefinition } from './node-registry';
import './NodeOutline.css';
import { useI18n } from '../i18n/I18nProvider';

function scrollContainer(element: HTMLElement) {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && current.scrollHeight > current.clientHeight) return current;
  }
  return null;
}

export function NodeOutline({ nodes, selected, search, selectionRevision, onSelect }: {
  nodes: WorkNode[]; selected: string[]; search: string; selectionRevision: number; onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const items = useRef(new Map<string, HTMLButtonElement>());
  const byId = new Map(nodes.map(node => [node.id, node]));
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const owner = new Map<string, string>();
  for (const group of nodes.filter(node => node.type === 'group')) {
    for (const id of group.memberIds ?? []) {
      if (byId.has(id) && byId.get(id)?.type !== 'group' && !owner.has(id)) owner.set(id, group.id);
    }
  }
  const selectedId = selected.length === 1 ? selected[0] : undefined;
  const selectedOwner = selectedId ? owner.get(selectedId) : undefined;
  const selectedExpanded = !selectedOwner || !collapsed.has(selectedOwner);
  useLayoutEffect(() => {
    if (!selectedOwner) return;
    setCollapsed(current => {
      if (!current.has(selectedOwner)) return current;
      const next = new Set(current);
      next.delete(selectedOwner);
      return next;
    });
  }, [selectedId, selectedOwner, selectionRevision]);
  useLayoutEffect(() => {
    if (!selectedId) return;
    const item = items.current.get(selectedId);
    if (!item) return;
    const container = scrollContainer(item);
    if (!container) return;
    const containerBounds = container.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    if (itemBounds.top < containerBounds.top || itemBounds.bottom > containerBounds.bottom) {
      container.scrollTop += (itemBounds.top + itemBounds.bottom - containerBounds.top - containerBounds.bottom) / 2;
    }
  }, [selectedId, selectionRevision, selectedExpanded]);
  const query = search.trim().toLocaleLowerCase();
  const matches = (node: WorkNode) => (node.title + node.content).toLocaleLowerCase().includes(query);
  const item = (node: WorkNode) => {
    const definition = getNodeDefinition(node.type);
    const Icon = node.type === 'group' ? Square : definition.icon;
    return <button ref={element => { if (element) items.current.set(node.id, element); else items.current.delete(node.id); }} aria-label={node.title} aria-pressed={selected.includes(node.id)} className={'node-list-item ' + (selected.includes(node.id) ? 'active' : '')} onClick={() => onSelect(node.id)}>
      <span className="node-list-icon"><Icon size={18} aria-hidden="true" /></span>
      <span><strong>{node.title}</strong><small>{node.type === 'group' ? t('Group') : node.content || t(definition.title)}</small></span>
    </button>;
  };
  const roots = nodes.filter(node => !owner.has(node.id)).flatMap(node => {
    if (node.type !== 'group') return matches(node) ? [<li key={node.id} className="node-outline-leaf">{item(node)}</li>] : [];
    const members = [...new Set(node.memberIds ?? [])]
      .flatMap(id => owner.get(id) === node.id ? [byId.get(id)!] : [])
      .sort((a, b) => nodeOrder.get(a.id)! - nodeOrder.get(b.id)!);
    const visible = matches(node) ? members : members.filter(matches);
    if (!matches(node) && !visible.length) return [];
    const expanded = Boolean(query) || !collapsed.has(node.id);
    return [<li key={node.id} className="node-outline-branch">
      <div className="node-outline-group">
        <button className="node-outline-toggle" aria-label={t(expanded ? 'Collapse group: {title}' : 'Expand group: {title}', { title: node.title })} aria-expanded={expanded} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} disabled={Boolean(query)}>
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        {item(node)}
      </div>
      {expanded && visible.length > 0 && <ul className="node-outline-children" aria-label={t('Nodes in {title}', { title: node.title })}>{visible.map(member => <li key={member.id}>{item(member)}</li>)}</ul>}
    </li>];
  });
  return <div className="node-list node-outline"><ul aria-label={t('Work Graph nodes')}>{roots}</ul>{roots.length === 0 && query && <p className="muted">{t('No matching nodes')}</p>}</div>;
}
