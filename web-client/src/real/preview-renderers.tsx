import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents, markdownRemarkPlugins } from '../components/MarkdownCodeBlock';
import { codeMarkdown, parseCsv, previewFormat, previewImageMime } from './preview-formats';
import { buildHtmlPreviewDocument, HTML_PREVIEW_SANDBOX, HTML_PREVIEW_PERMISSIONS } from './preview-html';
import type { PreviewRendererDefinition, PreviewRendererProps } from './preview-registry';
import { PreviewLayout } from './PreviewLayout';
import { useI18n } from '../i18n/I18nProvider';

const Pdf = lazy(() => import('./PreviewPdf'));
function HtmlPreview({text}: PreviewRendererProps) {
  const {t} = useI18n();
  const html = useMemo(() => buildHtmlPreviewDocument(text),[text]);
  return <iframe title={t('Isolated web preview')} sandbox={HTML_PREVIEW_SANDBOX} allow={HTML_PREVIEW_PERMISSIONS} referrerPolicy="no-referrer" srcDoc={html}/>;
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
  return image?.blob === blob ? <img className="ow-preview-svg" src={image.url} alt={t('SVG preview: {name}', {name})} draggable={false} onContextMenu={e => e.preventDefault()} onError={() => setFailed(true)}/> : <p role="status">{t('Loading SVG…')}</p>;
}
function ImagePreview({blob,name,mime}: PreviewRendererProps) {
  const {t} = useI18n();
  const [image,setImage] = useState<{blob:Blob;url:string}>();
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([blob],{type:previewImageMime(name,mime) ?? blob.type ?? 'application/octet-stream'}));
    setImage({blob,url}); setFailed(false);
    return () => URL.revokeObjectURL(url);
  },[blob,name,mime]);
  if (failed) return <p role="status">{t('Image preview failed. Switch to hexadecimal to inspect the file contents.')}</p>;
  return image?.blob === blob ? <img className="ow-preview-image" src={image.url} alt={name} draggable={false} onContextMenu={e => e.preventDefault()} onError={() => setFailed(true)}/> : <p role="status">{t('Loading image…')}</p>;
}
function MarkdownPreview({text}: PreviewRendererProps) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm,...markdownRemarkPlugins]} skipHtml components={{...markdownCodeComponents,a:({children})=><span>{children}</span>,img:({alt})=><span>{alt}</span>}}>{text}</ReactMarkdown></div>;
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
  {id:'core.image',label:'Image',matches:file=>previewFormat(file.name,file.mime)==='image',input:'blob',Component:ImagePreview,modes:['rendered','hex'],defaultMode:'rendered'},
  ...([
    ['html','Web page','text',HtmlPreview],['svg','SVG','blob',SvgPreview],['markdown','Markdown','text',MarkdownPreview],
    ['code','Markdown','text',CodePreview],['csv','Table','text',CsvPreview],['pdf','PDF','blob',PdfPreview],
  ] as const).map(([format,label,input,Component]): PreviewRendererDefinition => ({
    id:'core.'+format,label,input,Component,layout:format === 'csv' || format === 'pdf' ? 'fill' : 'scroll',modes:renderedModes,defaultMode:'rendered',matches:file=>previewFormat(file.name,file.mime)===format,
  })),
];
