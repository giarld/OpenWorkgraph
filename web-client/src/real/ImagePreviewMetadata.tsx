import { useEffect, useState } from 'react';
import { formatFileSize } from '../domain/file-types';
import { useI18n } from '../i18n/I18nProvider';
import { previewFormat, previewImageMime } from './preview-formats';

/** Metadata comes from the original file, never a resized preview. */
export function ImagePreviewMetadata({ blob, name, mime }: { blob: Blob; name: string; mime?: string }) {
  const { t } = useI18n();
  const actualMime = (blob.type.startsWith('image/') ? blob.type : mime ?? blob.type).split(';')[0].trim().toLowerCase();
  const format = previewFormat(name, actualMime);
  const imageMime = actualMime === 'image/svg+xml' ? actualMime : previewImageMime(name, actualMime) ?? (format === 'svg' ? 'image/svg+xml' : undefined);
  const [dimensions, setDimensions] = useState<{ blob: Blob; mime: string; width: number; height: number }>();
  useEffect(() => {
    if (!imageMime) return;
    let active = true;
    const url = URL.createObjectURL(new Blob([blob], { type: imageMime }));
    const image = new Image();
    image.onload = () => {
      if (active && image.naturalWidth && image.naturalHeight) setDimensions({ blob, mime: imageMime, width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = url;
    return () => { active = false; image.onload = null; image.src = ''; URL.revokeObjectURL(url); };
  }, [blob, imageMime]);
  if (!imageMime) return null;
  const size = dimensions?.blob === blob && dimensions.mime === imageMime ? `${dimensions.width} × ${dimensions.height} px` : '—';
  const formatName = imageMime === 'image/svg+xml' ? 'SVG' : imageMime === 'image/x-icon' || imageMime === 'image/vnd.microsoft.icon' ? 'ICO' : imageMime.slice(6).toUpperCase();
  return <div className="ow-image-metadata" aria-label={t('Image information')}>
    <span>{t('Dimensions')}: {size}</span>
    <span>{t('Format')}: {formatName}</span>
    <span title={`${blob.size} B`}>{t('File size')}: {formatFileSize(blob.size)}</span>
  </div>;
}
