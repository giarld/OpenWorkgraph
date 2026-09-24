import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getNodeDefinition } from '../components/node-registry';
import type { GraphSnapshot } from './contracts';
import '../i18n/catalogs/runs';
import { useI18n } from '../i18n/I18nProvider';

type OutputNode = GraphSnapshot['nodes'][number];

export function ExecutionOutputList({ outputs, disabled, renderContent, onRestore }: {
  outputs: OutputNode[];
  disabled: boolean;
  renderContent: (node: OutputNode) => ReactNode;
  onRestore: (node: OutputNode) => void;
}) {
  const { t } = useI18n();
  const previewId = useId();
  const [preview, setPreview] = useState<{ id: string; left: number; top: number; width: number; height: number }>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => { clearTimeout(timer.current); };
  const close = () => { cancel(); setPreview(undefined); };
  const leave = () => { cancel(); timer.current = setTimeout(() => setPreview(undefined), 120); };
  useEffect(() => {
    window.addEventListener('resize', close);
    return () => { cancel(); window.removeEventListener('resize', close); };
  }, []);
  const show = (node: OutputNode, target: HTMLElement, immediate = false) => {
    cancel();
    const row = target.getBoundingClientRect();
    const menu = target.closest('.execution-output-menu')!.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const height = Math.min(260, window.innerHeight - 24);
    const left = menu.right + 10 + width <= window.innerWidth - 12
      ? menu.right + 10 : Math.max(12, menu.left - width - 10);
    const next = { id: node.id, left, top: Math.max(12, Math.min(row.top, window.innerHeight - height - 12)), width, height };
    setPreview(undefined);
    if (immediate) setPreview(next);
    else timer.current = setTimeout(() => setPreview(next), 200);
  };
  const output = outputs.find(node => node.id === preview?.id);
  return <>
    <div className="execution-output-list" onScroll={close}>
      {outputs.map(node => {
        const definition = getNodeDefinition(node.type), Icon = definition.icon;
        const content = node.content && typeof node.content === 'object' && !Array.isArray(node.content) ? node.content : {};
        return <button className="create-option" key={node.id} disabled={disabled}
          aria-describedby={output?.id === node.id ? previewId : undefined}
          onMouseEnter={event => show(node, event.currentTarget)} onMouseLeave={leave}
          onFocus={event => show(node, event.currentTarget, true)} onBlur={close}
          onClick={() => { close(); onRestore(node); }}>
          <Icon size={18}/><span>{String(content.title ?? definition.title)}</span>
        </button>;
      })}
      {!outputs.length && <p className="muted" role="status">{t('There are no hidden outputs to display. New outputs appear automatically in the Work Graph.')}</p>}
    </div>
    {output && preview && createPortal(<div id={previewId} role="tooltip" aria-label={t('Output preview')}
      className="execution-output-preview panel" style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
      onMouseEnter={cancel} onMouseLeave={leave}>
      <div className="execution-output-preview-content" inert key={output.id}>{renderContent(output)}</div>
    </div>, document.body)}
  </>;
}
