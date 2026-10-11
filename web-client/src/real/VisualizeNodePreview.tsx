import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatFileSize } from '../domain/file-types';
import { useI18n } from '../i18n/I18nProvider';
import { PreviewActionButton } from './PreviewActionButton';
import type { VisualizeSessions } from './VisualizeNode';
import { downloadVisualizeBlob, prepareVisualizeDownload } from './visualize-download';
import { messageOf } from './contracts';
import './VisualizeNodePreview.css';

export function VisualizeNodePreview({ owner, nodeId, contentVersion, children }: {
  owner: VisualizeSessions; nodeId: string; contentVersion: number; children: ReactNode;
}) {
  const { t } = useI18n();
  const [prepared, setPrepared] = useState<{ blob: Blob; name: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    setPrepared(undefined); setError('');
    void owner.settle(nodeId).then(() => prepareVisualizeDownload(owner.request, owner.scope, nodeId)).then(value => {
      if (live) setPrepared(value);
    }).catch(reason => { if (live) setError(messageOf(reason)); });
    return () => { live = false; };
  }, [owner, nodeId, contentVersion]);
  const download = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await owner.settle(nodeId);
      const value = await prepareVisualizeDownload(owner.request, owner.scope, nodeId);
      if (!active.current) return;
      setPrepared(value); downloadVisualizeBlob(value.blob, value.name);
    } catch (reason) { if (active.current) setError(messageOf(reason)); }
    finally { if (active.current) setBusy(false); }
  };
  return <div className="ow-visualize-node-preview">
    <div className="ow-visualize-preview-content">{children}</div>
    {error && <p className="ow-visualize-download-error" role="status">{error}</p>}
    <footer className="ow-preview-download">
      <div className="ow-image-metadata" aria-label={t('File information')}>
        <span title={prepared ? `${prepared.blob.size} B` : undefined}>{t('File size')}: {prepared ? formatFileSize(prepared.blob.size) : '—'}</span>
      </div>
      <PreviewActionButton action="download" busy={busy} onClick={() => { void download(); }}/>
    </footer>
  </div>;
}
