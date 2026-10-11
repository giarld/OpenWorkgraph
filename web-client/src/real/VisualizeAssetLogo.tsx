import { useEffect, useRef, useState } from 'react';
import { PanelsTopLeft } from 'lucide-react';
import { ImagePreviewCache } from './image-preview-cache';
import type { ResourceRequest } from './ResourcesPanel';
import { useI18n } from '../i18n/I18nProvider';

const logos = new ImagePreviewCache(1024 * 1024, 128);
export function VisualizeAssetLogo({ request, path, name, logoSha256, onPreview }: { request: ResourceRequest; path: string; name: string; logoSha256?: string; onPreview(): void }) {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '160px' });
    if (button.current) observer.observe(button.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(undefined); setFailed(false);
    if (!visible || !logoSha256) return;
    let active = true, objectUrl: string | undefined;
    void logos.load(request, path + '/visualize-logo?sha256=' + encodeURIComponent(logoSha256)).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request, path, logoSha256, visible]);
  return <button ref={button} type="button" className="ow-assets-thumbnail ow-assets-visualize-logo" aria-label={t('View interactive content: {name}', { name })} onClick={onPreview}>
    {url && !failed ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} /> : <PanelsTopLeft size={48} aria-hidden="true" />}
  </button>;
}
