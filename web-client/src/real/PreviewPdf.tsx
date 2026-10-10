import { useEffect, useRef, useState } from 'react';
import { useNodeViewport } from '../canvas/NodeViewport';
import { PreviewLayout } from './PreviewLayout';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useI18n } from '../i18n/I18nProvider';
import { translate } from '../i18n/translate';
GlobalWorkerOptions.workerSrc = workerUrl;
// Vite emits local, version-matched CMaps/fonts/decoders; no CDN dependency.
const binaryAssets = import.meta.glob<string>([
  '/node_modules/pdfjs-dist/cmaps/*.bcmap',
  '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '/node_modules/pdfjs-dist/wasm/*.wasm',
], { query: '?url', import: 'default', eager: true });
const assetUrls = new Map(Object.entries(binaryAssets).map(([path, url]) => [path.split('/').pop()!, url]));
class LocalPdfBinaryData {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    const url = assetUrls.get(filename);
    if (!url) throw Error(translate('Missing PDF reader resource: {filename}', {filename}));
    const response = await fetch(url);
    if (!response.ok) throw Error(translate('Failed to load PDF reader resources.'));
    return new Uint8Array(await response.arrayBuffer());
  }
}

export default function PreviewPdf({ blob }: { blob: Blob }) {
  const visible = useNodeViewport();
  const rendered = useRef<{ pdf: PDFDocumentProxy; page: number; canvas: HTMLCanvasElement } | undefined>(undefined);
  const {t} = useI18n();
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    let loading: ReturnType<typeof getDocument> | undefined;
    setPdf(undefined); setPage(1); setError('');
    void blob.arrayBuffer().then(async data => {
      if (!active) return;
      // Render pages only; never instantiate the PDF scripting or annotation APIs.
      loading = getDocument({ data, useSystemFonts: true, useWorkerFetch: false, BinaryDataFactory: LocalPdfBinaryData });
      const document = await loading.promise;
      if (active) setPdf(document);
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : translate('Unable to read the PDF.')); });
    return () => { active = false; void loading?.destroy(); };
  }, [blob]);
  useEffect(() => {
    // Page changes replace the keyed canvas, including a quick return to a
    // completed page while another page's render is still pending.
    if (!pdf || !visible || (rendered.current?.pdf === pdf && rendered.current.page === page && rendered.current.canvas === canvas.current)) return;
    let active = true;
    let task: RenderTask | undefined;
    setError('');
    void pdf.getPage(page).then(async documentPage => {
      if (!active || !canvas.current) return;
      const view = documentPage.getViewport({ scale: 1 });
      const viewport = documentPage.getViewport({ scale: Math.min(2, 1200 / view.width, 1600 / view.height) });
      const target = canvas.current;
      target.width = viewport.width; target.height = viewport.height;
      task = documentPage.render({ canvas: target, viewport });
      await task.promise;
      if (active) rendered.current = { pdf, page, canvas: target };
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : translate('Failed to render the PDF page.')); });
    return () => { active = false; task?.cancel(); };
  }, [pdf, page, visible]);
  return <PreviewLayout className="ow-preview-pdf" footer={pdf && <nav aria-label={t('PDF pagination')}><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('Previous page')}</button><span aria-live="polite">{page} / {pdf.numPages}</span><button disabled={page >= pdf.numPages} onClick={() => setPage(p => p + 1)}>{t('Next page')}</button></nav>}>
    {error && <p role="status">{t('PDF preview failed: {error}', {error})}</p>}
    {!pdf && !error && <p role="status">{t('Loading PDF…')}</p>}
    {pdf && <canvas key={page} ref={canvas} role="img" aria-label={t('PDF page {page}', {page})} />}
  </PreviewLayout>;
}
