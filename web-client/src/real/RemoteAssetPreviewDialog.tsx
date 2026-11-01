import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, X } from 'lucide-react';
import type { RemoteEntry } from '../../../packages/protocol/src/remote-assets';
import type { RangeBlob } from '../adapter/transport';
import { randomId } from '../adapter/random';
import { useI18n } from '../i18n/I18nProvider';
import { fileMime, formatFileSize } from '../domain/file-types';
import { messageOf, type Request } from './contracts';
import { FileContent } from './PreviewNode';
import { StreamingVideoPreview } from './VideoPreview';
import { previewFormat } from './preview-formats';
import './ResourcesPanel.css';

export const REMOTE_PREVIEW_AUTO_BYTES = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;
interface Preview { id: string; bytes: number; mime: string }

export function RemoteAssetPreviewDialog({ request, sourceId, locationRevision, entry, onClose }: {
  request: Request; sourceId: string; locationRevision: number; entry: RemoteEntry; onClose(): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const previousFocus = useRef(document.activeElement);
  const manual = useRef(false);
  const [allowed, setAllowed] = useState(entry.bytes !== null && entry.bytes <= REMOTE_PREVIEW_AUTO_BYTES);
  const [session, setSession] = useState<{ preview: Preview; lifetime: AbortController }>(), [blob, setBlob] = useState<Blob>(), [error, setError] = useState('');
  const [retry, setRetry] = useState(0), [received, setReceived] = useState(0), [reading, setReading] = useState(false);
  const lifetime = useMemo(() => new AbortController(), [request, sourceId, locationRevision, entry.path, retry]);
  // A retry must never pair the previous session with the new request signal.
  const preview = session?.lifetime === lifetime ? session.preview : undefined;
  const previewId = useMemo(() => randomId(), [lifetime]);
  const scopedRequest = useMemo<Request>(() => (path, body, method, options) => request(path, body, method, {
    ...options, signal: options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
  }), [request, lifetime]);
  useEffect(() => {
    const element = dialog.current, previous = previousFocus.current; element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    setSession(undefined); setBlob(undefined); setError(''); setReceived(0);
    const opening = manual.current || entry.bytes !== null && entry.bytes <= REMOTE_PREVIEW_AUTO_BYTES;
    if (opening) {
      setReading(true);
      void scopedRequest<Preview>('/v1/data-sources/' + sourceId + '/preview', { locationRevision, path: entry.path, previewId }, 'POST', { journal: 'memory' }).then(result => {
        if (lifetime.signal.aborted) { void request('/v1/remote-previews/' + previewId + '/remove', {}, 'POST', { journal: 'memory' }).catch(() => {}); return; }
        setSession({ preview: result, lifetime });
        // Recheck authoritative size if a cached listing was smaller or stale.
        if (result.bytes > REMOTE_PREVIEW_AUTO_BYTES && !manual.current) setAllowed(false);
      }).catch(cause => { if (!lifetime.signal.aborted) setError(messageOf(cause)); }).finally(() => { if (!lifetime.signal.aborted) setReading(false); });
    }
    return () => { lifetime.abort(); if (opening) void request('/v1/remote-previews/' + previewId + '/remove', {}, 'POST', { journal: 'memory' }).catch(() => {}); };
    // Changing the manual consent starts content reading, not another session.
  }, [scopedRequest, request, lifetime, sourceId, locationRevision, entry.path, entry.bytes, previewId]);
  const mime = preview?.mime && preview.mime !== 'application/octet-stream' ? preview.mime : fileMime({ name: entry.name, type: '' });
  const video = previewFormat(entry.name, mime) === 'video';
  useEffect(() => {
    if (!allowed || !preview || video) return;
    let current = true; setReading(true); setBlob(undefined); setReceived(0);
    void (async () => {
      const parts: Blob[] = [];
      for (let start = 0; start < preview.bytes; start += CHUNK) {
        const result = await scopedRequest<RangeBlob>('/v1/remote-previews/' + preview.id, undefined, 'RANGE', { range: { start, end: Math.min(preview.bytes, start + CHUNK) - 1 } });
        if (!current) return;
        if (result.total !== preview.bytes || result.start !== start) throw Error('Remote file changed during preview. Open it again.');
        parts.push(result.blob); setReceived(start + result.blob.size);
      }
      if (current) setBlob(new Blob(parts, { type: mime }));
    })().catch(cause => { if (current && !lifetime.signal.aborted) setError(messageOf(cause)); }).finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [allowed, preview, video, scopedRequest, lifetime, mime]);
  const load = () => {
    manual.current = true;
    setAllowed(true);
    if (!preview) setRetry(value => value + 1);
  };
  return createPortal(<dialog ref={dialog} className="ow-asset-preview-dialog ow-asset-file-dialog remote-asset-preview-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } }}>
    <header><h2 id={title}>{entry.name}</h2><button type="button" aria-label={t('Close preview')} autoFocus onClick={onClose}><X size={20} aria-hidden="true"/></button></header>
    <div className="ow-preview-node" data-canvas-interactive>
      {!allowed ? <div className="ow-preview-file-summary"><File size={32} aria-hidden="true"/>{(preview?.bytes ?? entry.bytes) !== null && <span>{formatFileSize(preview?.bytes ?? entry.bytes!)}</span>}<button type="button" onClick={load}>{t('Load preview')}</button></div>
        : error ? <div role="alert">{t(error)}<button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry preview')}</button></div>
        : video && preview ? <StreamingVideoPreview request={scopedRequest} path={'/v1/remote-previews/' + preview.id} bytes={preview.bytes} name={entry.name} mime={mime} allowFullFallback={false}/>
        : blob ? <FileContent blob={blob} name={entry.name} mime={mime} showName={false}/>
        : <div role="status">{t('Loading preview…')}{reading && <progress aria-label={t('Loading preview…')} max={preview?.bytes || 1} value={preview ? received : undefined}/>}</div>}
    </div>
  </dialog>, document.body);
}
