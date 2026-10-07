import { useEffect, useRef, useState } from 'react';
import { FileVideo, Play } from 'lucide-react';
import { formatFileSize } from '../domain/file-types';
import { useI18n } from '../i18n/I18nProvider';
import type { Request } from './contracts';
import './video-node-summary.css';

/** A lightweight cover, leaving playback to the existing node preview dialog. */
export function VideoNodeSummary({ request, name, mime, bytes, resourcePath, projectId, relativePath }: {
  request: Request; name: string; mime: string; bytes?: number;
  resourcePath?: string; projectId: string; relativePath?: string;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [cover, setCover] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [fileBytes, setFileBytes] = useState(bytes);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let url: string | undefined;
    setCover(undefined); setFailed(false); setFileBytes(bytes);
    const base = '/v1/projects/' + encodeURIComponent(projectId) + '/files/';
    const thumbnail = relativePath !== undefined
      ? base + 'thumbnail?' + new URLSearchParams({ path: relativePath, size: '320' })
      : resourcePath + '/thumbnail?size=320&video=1';
    void request<Blob>(thumbnail, undefined, 'BLOB').then(blob => {
      if (!live) return;
      url = URL.createObjectURL(blob); setCover(url);
    }).catch(() => { if (live) setFailed(true); });
    if (relativePath !== undefined) {
      void request<{ state: string; bytes: number | null }[]>(base + 'stat', { paths: [relativePath] }).then(records => {
        if (live && records[0]?.state === 'available' && typeof records[0].bytes === 'number') setFileBytes(records[0].bytes);
      }).catch(() => { /* File information remains readable if metadata is unavailable. */ });
    } else if (bytes === undefined && resourcePath) {
      void request<{ bytes: number }>(resourcePath).then(metadata => {
        if (live) setFileBytes(metadata.bytes);
      }).catch(() => { /* The cover does not depend on metadata availability. */ });
    }
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [visible, request, resourcePath, projectId, relativePath, bytes]);
  const extension = (relativePath ?? name).split('.').at(-1)?.toUpperCase();
  const format = mime.startsWith('video/') ? mime.slice(6).toUpperCase() : extension;
  return <div ref={container} className="node-content ow-video-node">
    <div className="ow-video-node-cover">
      {cover && !failed ? <img src={cover} alt={name} draggable={false} decoding="async" onError={() => setFailed(true)}/>
        : <div className="ow-video-node-placeholder"><FileVideo size={28} aria-hidden="true"/><span>{t(failed ? 'Thumbnail unavailable; click to preview' : 'Loading thumbnail…')}</span></div>}
      <span className="ow-video-node-badge" aria-hidden="true"><Play size={16} fill="currentColor"/></span>
    </div>
    <div className="ow-video-node-info">
      <strong title={name}>{name}</strong>
      <span>{[format, typeof fileBytes === 'number' && formatFileSize(fileBytes)].filter(Boolean).join(' · ')}</span>
      {relativePath && <span className="ow-video-node-path" title={relativePath}>{relativePath}</span>}
    </div>
  </div>;
}
