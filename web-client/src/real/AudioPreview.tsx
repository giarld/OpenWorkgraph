import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { previewAudioMime } from '../domain/audio-formats';
import type { PreviewRendererProps } from './preview-registry';
import './audio-preview.css';

export function AudioPreview({ blob, name, mime }: PreviewRendererProps) {
  const { t } = useI18n();
  const [source, setSource] = useState<{ blob: Blob; name: string; mime: string; url: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([blob], { type: previewAudioMime(name, mime) ?? previewAudioMime('', blob.type) ?? 'application/octet-stream' }));
    setSource({ blob, name, mime, url });
    setFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [blob, name, mime]);
  const current = source?.blob === blob && source.name === name && source.mime === mime ? source : undefined;
  return <div className="ow-preview-audio" data-canvas-interactive>
    {current && <audio key={current.url} src={current.url} controls controlsList="nodownload" preload="metadata" aria-label={t('Audio preview: {name}', { name })}
      onError={() => setFailed(true)} onKeyDown={event => event.stopPropagation()} />}
    {failed ? <p role="status">{t('Audio preview failed. The browser may not support this format or codec. Switch to hexadecimal to inspect the file contents.')}</p>
      : !current ? <p role="status">{t('Loading audio…')}</p> : null}
  </div>;
}
