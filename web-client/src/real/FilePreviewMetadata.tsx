import { formatFileSize } from '../domain/file-types';
import { useI18n } from '../i18n/I18nProvider';
import { ImagePreviewMetadata } from './ImagePreviewMetadata';
import { fileExtension, previewFormat } from './preview-formats';

/** Uses original file bytes, including streams that have no complete Blob. */
export function FilePreviewMetadata({ blob, bytes, name, mime = '' }: {
  blob?: Blob; bytes?: number; name: string; mime?: string;
}) {
  const { t } = useI18n();
  const actualMime = (mime || blob?.type || '').split(';')[0].trim().toLowerCase();
  const kind = previewFormat(name, actualMime);
  if (blob && (kind === 'image' || kind === 'svg')) return <ImagePreviewMetadata blob={blob} name={name} mime={actualMime}/>;
  const size = bytes ?? blob?.size;
  const extension = fileExtension(name).toUpperCase();
  const format = extension || (actualMime && actualMime !== 'application/octet-stream' ? actualMime : '—');
  return <div className="ow-image-metadata ow-file-preview-metadata" aria-label={t('File information')}>
    <span>{t('Format')}: {format}</span>
    {size !== undefined && <span title={`${size} B`}>{t('File size')}: {formatFileSize(size)}</span>}
  </div>;
}
