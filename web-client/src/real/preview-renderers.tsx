import { MarkdownPreview } from './MarkdownPreview';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNodeSelected, useNodeViewport } from '../canvas/NodeViewport';
import { staticImagePreview } from './image-node-animation';
import { VideoPreview } from './VideoPreview';
import { AudioPreview } from './AudioPreview';
import { codeMarkdown, parseCsv, previewFormat, previewImageMime } from './preview-formats';
import { buildHtmlPreviewDocument, HTML_PREVIEW_SANDBOX, HTML_PREVIEW_PERMISSIONS } from './preview-html';
import type { PreviewRendererDefinition, PreviewRendererProps } from './preview-registry';
import { PreviewLayout } from './PreviewLayout';
import { useI18n } from '../i18n/I18nProvider';

const Pdf = lazy(() => import('./PreviewPdf'));
function HtmlPreview({text}: PreviewRendererProps) {
  const {t} = useI18n();
  const active = useNodeViewport();
  const id = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => buildHtmlPreviewDocument(text, { hostOrigin: window.location.origin, sessionId: id, nodeId: id }),[text, id]);
  useEffect(() => {
    const contextMenu = (event: MessageEvent) => {
      const element = frame.current, data = event.data;
      if (!element?.closest('[data-canvas-file-preview]')?.closest('.owg-canvas[data-node-context-menu]')) return;
      if (!element || event.source !== element.contentWindow || data?.channel !== 'openworkgraph.file.contextmenu' || data.sessionId !== id || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
      if (data.x < 0 || data.y < 0 || data.x > element.clientWidth || data.y > element.clientHeight) return;
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + data.x * bounds.width / element.offsetWidth, clientY: bounds.top + data.y * bounds.height / element.offsetHeight }));
    };
    window.addEventListener('message', contextMenu);
    return () => window.removeEventListener('message', contextMenu);
  }, [id]);
  const pushVisibility = () => {
    const element = frame.current;
    element?.contentWindow?.postMessage({ channel: 'openworkgraph.visualize.visibility', sessionId: id, nodeId: id, active }, '*');
    element?.contentWindow?.postMessage({ channel: 'openworkgraph.file.contextmenu.enable', sessionId: id, enabled: Boolean(element.closest('[data-canvas-file-preview]')?.closest('.owg-canvas[data-node-context-menu]')) }, '*');
  };
  useEffect(pushVisibility, [active, html]);
  return <iframe ref={frame} onLoad={pushVisibility} title={t('Isolated web preview')} sandbox={HTML_PREVIEW_SANDBOX} allow={HTML_PREVIEW_PERMISSIONS} referrerPolicy="no-referrer" srcDoc={html}/>;
}
function SvgPreview({blob,name}: PreviewRendererProps) {
  const {t} = useI18n();
  const [image,setImage] = useState<{blob:Blob;url:string}>();
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    // SVG in an img is an image document, never an active browsing context.
    const url = URL.createObjectURL(new Blob([blob],{type:'image/svg+xml'}));
    setImage({blob,url}); setFailed(false);
    return () => URL.revokeObjectURL(url);
  },[blob]);
  if (failed) return <p role="status">{t('SVG preview failed. Switch to plain text to inspect the file contents.')}</p>;
  return image?.blob === blob ? <img className="ow-preview-svg" src={image.url} alt={t('SVG preview: {name}', {name})} draggable={false} onContextMenu={e => e.stopPropagation()} onError={() => setFailed(true)}/> : <p role="status">{t('Loading SVG…')}</p>;
}
function ImagePreview({blob,name,mime}: PreviewRendererProps) {
  const {t} = useI18n();
  const selected = useNodeSelected();
  const visible = useNodeViewport();
  const playing = visible && selected !== false;
  const source = useMemo(() => new Blob([blob],{type:previewImageMime(name,mime) ?? blob.type ?? 'application/octet-stream'}), [blob,name,mime]);
  const [image,setImage] = useState<{blob:Blob;url:string;original?:Blob}>();
  const [animation,setAnimation] = useState<{blob:Blob;url:string}>();
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setFailed(false);
    void staticImagePreview(source).then(preview => {
      if (!active) return;
      url = URL.createObjectURL(preview);
      setImage({blob,url,original:preview === source ? undefined : source});
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  },[blob,source]);
  useEffect(() => {
    if (!playing || image?.blob !== blob || !image.original) return;
    const url = URL.createObjectURL(image.original);
    setAnimation({blob,url});
    return () => { URL.revokeObjectURL(url); setAnimation(undefined); };
  },[playing,blob,image?.original]);
  const url = playing && animation?.blob === blob ? animation.url : image?.url;
  if (failed) return <p role="status">{t('Image preview failed. Switch to hexadecimal to inspect the file contents.')}</p>;
  return image?.blob === blob ? <img className="ow-preview-image" src={url} alt={name} draggable={false} onContextMenu={e => e.stopPropagation()} onError={() => setFailed(true)}/> : <p role="status">{t('Loading image…')}</p>;
}
function CodePreview(props: PreviewRendererProps) { return <MarkdownPreview {...props} text={codeMarkdown(props.text,props.name)}/>; }
function PdfPreview({blob}: PreviewRendererProps) { const {t} = useI18n(); return <Suspense fallback={<p role="status">{t('Loading PDF reader…')}</p>}><Pdf blob={blob}/></Suspense>; }
function CsvPreview({text}: PreviewRendererProps) {
  const {t} = useI18n();
  const {rows,truncated} = useMemo(() => parseCsv(text),[text]);
  const [page,setPage] = useState(0);
  const pages = Math.max(1,Math.ceil(rows.length/100));
  return <PreviewLayout footer={<nav aria-label={t('Table pagination')}><button disabled={page === 0} onClick={() => setPage(p => p-1)}>{t('Previous page')}</button><span>{page+1} / {pages}</span><button disabled={page+1 >= pages} onClick={() => setPage(p => p+1)}>{t('Next page')}</button></nav>}>
    {truncated && <p role="status">{t('Table preview shows at most 100,000 cells. Switch to plain text to view the remaining content.')}</p>}
    <table aria-label={t('CSV preview')}><tbody>{rows.slice(page*100,(page+1)*100).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table>
    {!rows.length && <p>{t('Empty file')}</p>}
  </PreviewLayout>;
}
const renderedModes = ['rendered','text','hex'] as const;
/** Fallback first; resolution searches newest registrations first. */
export const builtInPreviewRenderers: readonly PreviewRendererDefinition[] = [
  {id:'core.binary',label:'Hexadecimal',matches:()=>true,input:'blob',initialView:'metadata',modes:['hex','text'],defaultMode:'hex'},
  {id:'core.text',label:'Plain text',matches:file=>file.mime.split(';')[0].trim().toLowerCase().startsWith('text/') && previewFormat(file.name,file.mime)==='hex' && !file.name.toLowerCase().endsWith('.bin'),input:'text',modes:['text','hex'],defaultMode:'text'},
  {id:'core.image',label:'Image',matches:file=>previewFormat(file.name,file.mime)==='image',input:'blob',Component:ImagePreview,modes:['rendered','hex'],defaultMode:'rendered'},
  {id:'core.video',label:'Video',matches:file=>previewFormat(file.name,file.mime)==='video',input:'blob',Component:VideoPreview,layout:'fill',modes:['rendered','hex'],defaultMode:'rendered'},
  {id:'core.audio',label:'Audio',matches:file=>previewFormat(file.name,file.mime)==='audio',input:'blob',Component:AudioPreview,layout:'fill',modes:['rendered','hex'],defaultMode:'rendered'},
  ...([
    ['html','Web page','text',HtmlPreview],['svg','SVG','blob',SvgPreview],['markdown','Markdown','text',MarkdownPreview],
    ['code','Markdown','text',CodePreview],['csv','Table','text',CsvPreview],['pdf','PDF','blob',PdfPreview],
  ] as const).map(([format,label,input,Component]): PreviewRendererDefinition => ({
    id:'core.'+format,label,input,Component,layout:format === 'csv' || format === 'pdf' ? 'fill' : 'scroll',modes:renderedModes,defaultMode:'rendered',matches:file=>previewFormat(file.name,file.mime)===format,
  })),
];
