import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import type { ExecutionPlan } from '../../../packages/protocol/src/index';
import { useI18n } from '../i18n/I18nProvider';

export interface ExecutionDepthLayout {
  points: ReadonlyMap<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export function ExecutionDepthPreview({ plan, layout, selected, seeds, busy, disabled, onToggle, onExpand }: {
  plan: ExecutionPlan; layout: ExecutionDepthLayout; selected: ReadonlySet<string>; seeds: readonly string[];
  busy: boolean; disabled: boolean; onToggle(id: string): void; onExpand?: () => void;
}) {
  const { t } = useI18n();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="execution-depth-map">
    {onExpand && <button type="button" className="icon-button execution-depth-expand" aria-label={t('Expand execution depth selection')} title={t('Expand execution depth selection')} onClick={onExpand}><Maximize2 size={18} aria-hidden="true"/></button>}
    <div className="execution-depth-preview" data-panning={panning ? 'true' : undefined} role="region" aria-label={t('Execution dependency preview')} tabIndex={0}
      onPointerDown={event => {
        if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
        const element = event.currentTarget, bounds = element.getBoundingClientRect();
        // Leave native scrollbars available for pointing and dragging.
        if (event.clientX >= bounds.left + element.clientLeft + element.clientWidth || event.clientY >= bounds.top + element.clientTop + element.clientHeight) return;
        suppressClick.current = false;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, moved: false };
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!(event.buttons & 1)) { endDrag(event); return; }
        const x = event.clientX - current.x, y = event.clientY - current.y;
        if (!current.moved && Math.hypot(x, y) < 5) return;
        if (!current.moved) {
          current.moved = true;
          suppressClick.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          setPanning(true);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = current.left - x;
        event.currentTarget.scrollTop = current.top - y;
      }}
      onPointerUp={endDrag}
      onPointerCancel={event => { endDrag(event); suppressClick.current = false; }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) { drag.current = null; setPanning(false); } }}
      onPointerLeave={event => { if (!drag.current?.moved) endDrag(event); }}
      onClickCapture={event => {
        if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
      }}>
      <svg width={layout.width} height={layout.height} role="group" aria-label={t('Execution dependency preview')}>
        {plan.edges.map(e=>{
          const a=layout.points.get(e.sourceId)!,b=layout.points.get(e.targetId)!;
          const start=a.y+57,end=b.y-25,mid=(start+end)/2;
          return <g key={e.id} className={'execution-depth-edge'+(selected.has(e.sourceId)&&selected.has(e.targetId)?' is-selected':'')}>
            <path d={`M ${a.x} ${start} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${end}`} />
            <path d={`M ${b.x-3} ${end-4} L ${b.x} ${end} L ${b.x+3} ${end-4}`} />
          </g>;
        })}
        {plan.nodes.map(n=>{
          const p=layout.points.get(n.id)!,isSelected=selected.has(n.id),isMissing=isSelected&&n.missingPrompt,isTarget=n.id===plan.targetId;
          const status=isMissing?t('Missing prompt'):isTarget?t('Current node'):n.required?t('Required'):seeds.includes(n.id)?t('Selected'):isSelected?t('Included automatically'):t('Reuse result');
          const title=Array.from(n.title);
          return <g key={n.id} className={'execution-depth-node'+(isSelected?' is-selected':'')+(isTarget?' is-target':'')+(isMissing?' is-missing':'')} transform={`translate(${p.x} ${p.y})`} role="checkbox" aria-label={n.title} aria-description={status} aria-checked={isSelected} aria-disabled={n.required||busy||disabled} tabIndex={n.required||busy||disabled?-1:0} onClick={()=>onToggle(n.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onToggle(n.id);}}}>
            <title>{t('{title} ({status})', { title: n.title, status })}</title>
            <rect className="execution-depth-hit" x="-54" y="-24" width="108" height="80" rx="12"/>
            <circle className="execution-depth-halo" r="23"/>
            <circle className="execution-depth-disc" r="18"/>
            {isMissing?<path className="execution-depth-symbol" d="M 0 -7 V 2 M 0 7 v .5"/>:isTarget?<path className="execution-depth-play" d="M -4 -7 L 7 0 L -4 7 Z"/>:isSelected?<path className="execution-depth-symbol" d="m -7 0 5 5 9 -10"/>:<path className="execution-depth-symbol" d="M -6 -3 A 7 7 0 1 1 -6 4 M -6 -8 v 5 h 5"/>}
            <text className="execution-depth-title" y="36" textAnchor="middle">{title.length>9?title.slice(0,8).join('')+'…':n.title}</text>
            <foreignObject x="-54" y="40" width="108" height="16"><div className="execution-depth-status" title={status}>{status}</div></foreignObject>
          </g>;
        })}
      </svg>
    </div>
  </div>;
}

export function ExecutionDepthDialog({ count, children, onClose }: { count: ReactNode; children: ReactNode; onClose(): void }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="execution-depth-dialog execution-depth-panel panel" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={onClose}
    onPointerDown={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement | SVGElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="execution-depth-heading"><strong id={titleId}>{t('Select execution depth')}</strong>{count}<button autoFocus type="button" className="icon-button" aria-label={t('Close execution depth selection')} title={t('Close execution depth selection')} onClick={onClose}><X size={18} aria-hidden="true"/></button></div>
    {children}
  </dialog>, document.body);
}
