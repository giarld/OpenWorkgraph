import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Transport } from '../adapter/transport';
import { markdownCodeComponents, markdownRemarkPlugins } from '../components/MarkdownCodeBlock';
import { skillReadmePackagePath, skillReadmeWebUrl } from './skill-library-state';

type ResourceClient = Pick<Transport, 'readSkillFile'>;
type Copy = (english: string, chinese: string) => string;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
function PackageImage({ client, id, version, path, alt, copy }: { client: ResourceClient; id: string; version: string; path: string; alt?: string; copy: Copy }) {
  const [image, setImage] = useState<{ key: string; url: string }>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = id + ':' + version + ':' + path;
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setFailed(false); setImage(undefined);
    void client.readSkillFile(id, version, path).then(blob => {
      if (!active) return;
      if (blob.size > MAX_PREVIEW_BYTES || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(blob.type)) throw new Error('Unsupported image');
      objectUrl = URL.createObjectURL(blob); setImage({ key, url: objectUrl });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, id, version, path, retry, key]);
  if (image?.key === key && !failed) return <img src={image.url} alt={alt || path} onError={() => setFailed(true)}/>;
  return <span className="ow-skills-resource">{alt || copy('Image', '图片')} ({path}) · {failed ? copy('Preview unavailable', '预览不可用') : copy('Loading…', '正在加载…')}{failed && <button type="button" onClick={() => setRetry(value => value + 1)}>{copy('Retry image', '重试图片')}</button>}</span>;
}
function PackageLink({ client, id, version, path, children, copy }: { client: ResourceClient; id: string; version: string; path: string; children: ReactNode; copy: Copy }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(false);
  const urls = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }; }, []);
  const download = async () => {
    if (loading) return;
    setLoading(true); setFailed(false);
    try {
      const blob = await client.readSkillFile(id, version, path);
      if (!alive.current) return;
      const url = URL.createObjectURL(blob); urls.current.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').at(-1)!;
      anchor.click();
      // Keep the URL through download initialization; all URLs are revoked on close too.
      window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
    } catch { if (alive.current) setFailed(true); }
    finally { if (alive.current) setLoading(false); }
  };
  return <span><button className="ow-skills-package-link" type="button" disabled={loading} onClick={() => void download()} title={copy('Download package file', '下载包内文件') + ': ' + path}>{children} · {loading ? copy('Loading…', '正在加载…') : copy('Download', '下载')}</button>{failed && <span role="status"> {copy('File unavailable. Retry the download.', '文件不可用，请重试下载。')} ({path})</span>}</span>;
}
export function SkillReadme({ content, client, id, version, copy }: { content: string; client?: ResourceClient; id: string; version?: string; copy: Copy }) {
  const pinned = version && /^[a-f0-9]{64}$/.test(version) ? version : undefined;
  return <article className="markdown-body ow-skills-readme"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, ...markdownRemarkPlugins]} urlTransform={url => url} components={{ ...markdownCodeComponents,
    a: ({ href, children }) => {
      const url = skillReadmeWebUrl(href);
      if (url) return <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
      const path = skillReadmePackagePath(href);
      return path && pinned && client ? <PackageLink client={client} id={id} version={pinned} path={path} copy={copy}>{children}</PackageLink> : <span>{children}{href ? ' (' + href + ')' : ''}</span>;
    },
    img: ({ src, alt }) => {
      const path = typeof src === 'string' ? skillReadmePackagePath(src) : undefined;
      return path && pinned && client ? <PackageImage client={client} id={id} version={pinned} path={path} alt={alt} copy={copy}/> : <span className="ow-skills-resource">{alt || copy('Image', '图片')}{typeof src === 'string' ? ' (' + src + ')' : ''}</span>;
    },
  }}>{content}</ReactMarkdown></article>;
}
