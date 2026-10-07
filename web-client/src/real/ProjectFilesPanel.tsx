import { useEffect, useRef, useState } from 'react';
import { FileVideo, Play } from 'lucide-react';
import { AlertCircle, ArrowUp, ChevronDown, ChevronRight, ChevronsDownUp, File, FileArchive, FileCode2, FileImage, FileJson, FileText, Folder, FolderOpen, FolderTree, LayoutGrid, Link2, ListTree, LoaderCircle, Plus, RefreshCw, Unplug } from 'lucide-react';
import { formatFileSize, PROJECT_FILE_PREVIEW_MAX_BYTES } from '../domain/file-types';
import type { ResourceRequest } from './ResourcesPanel';
import { beginProjectFileDrag } from './project-file-drag';
import { useI18n } from '../i18n/I18nProvider';
import './ProjectFilesPanel.css';

type Entry = { name: string; relativePath: string; kind: 'file' | 'directory'; hidden: boolean; bytes?: number };
type Listing = { path: string; items: Entry[]; nextCursor: string | null };
type Page = Listing & { loading: boolean; error?: string };
type View = 'tree' | 'grid';
const isVideoFile = (name: string): boolean => /[.](mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv)$/i.test(name);
const PROJECT_FILES_VIEW_STORAGE_KEY = 'openworkgraph:project-files-view:v1';
const PROJECT_FILES_SHOW_HIDDEN_STORAGE_KEY = 'openworkgraph:project-files-show-hidden:v1';

function readView(): View {
  try { return localStorage.getItem(PROJECT_FILES_VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'tree'; }
  catch { return 'tree'; }
}

function readShowHidden(): boolean {
  try { return localStorage.getItem(PROJECT_FILES_SHOW_HIDDEN_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

function EntryIcon({ item, open = false, size = 17 }: { item: Entry; open?: boolean; size?: number }) {
  const extension = item.name.split('.').at(-1)?.toLowerCase() ?? '';
  const Icon = item.kind === 'directory' ? (open ? FolderOpen : Folder)
    : isVideoFile(item.name) ? FileVideo
    : /^(png|jpe?g|gif|webp|svg|ico|avif)$/.test(extension) ? FileImage
    : /^(json|ya?ml|toml|xml)$/.test(extension) ? FileJson
    : /^(tsx?|jsx?|css|scss|html|py|rs|go|java|c|cpp|h|sh)$/.test(extension) ? FileCode2
    : /^(md|txt|pdf|csv)$/.test(extension) ? FileText
    : /^(zip|gz|tar|7z|rar)$/.test(extension) ? FileArchive : File;
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" className={'ow-project-file-icon ' + (item.kind === 'directory' ? 'is-folder' : Icon === FileCode2 || Icon === FileJson ? 'is-code' : Icon === FileImage ? 'is-image' : Icon === FileVideo ? 'is-video' : '')}/>;
}

function GridThumbnail({ item, projectId, request }: { item: Entry; projectId: string; request: ResourceRequest }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(80);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const isVideo = item.kind === 'file' && isVideoFile(item.name);
  const isImage = item.kind === 'file' && /[.](png|jpe?g|gif|webp|svg)$/i.test(item.name) && (item.bytes ?? 0) <= PROJECT_FILE_PREVIEW_MAX_BYTES;
  const hasThumbnail = isImage || isVideo;
  useEffect(() => {
    const element = container.current;
    if (!hasThumbnail || !element) return;
    const resize = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      const pixels = Math.max(bounds.width, bounds.height) * (window.devicePixelRatio || 1);
      setSize([80, 160, 320].find(level => level >= pixels) ?? 320);
    });
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    resize.observe(element);
    observer.observe(element);
    return () => { resize.disconnect(); observer.disconnect(); };
  }, [hasThumbnail]);
  useEffect(() => {
    if (!hasThumbnail || !visible) return;
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    const base = '/v1/projects/' + encodeURIComponent(projectId) + '/files/';
    void (async () => {
      const [observation] = await request<Array<{ state: string; bytes: number | null; changeToken: string | null }>>(base + 'stat', { paths: [item.relativePath] }, 'POST');
      if (!active) return;
      if (observation?.state !== 'available' || (!isVideo && (observation.bytes ?? 0) > PROJECT_FILE_PREVIEW_MAX_BYTES)) throw new Error('Thumbnail unavailable');
      const query = new URLSearchParams({ path: item.relativePath, size: String(size), ...(observation.changeToken ? { cacheKey: observation.changeToken } : {}) });
      const blob = await request<Blob>(base + 'thumbnail?' + query, undefined, 'BLOB');
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [hasThumbnail, isVideo, visible, size, projectId, item.relativePath, request]);
  return <span ref={container} className={'ow-project-file-tile-icon' + (isVideo ? ' is-video' : '')}>{url && !failed
    ? <><img className="ow-project-file-thumbnail" src={url} alt="" draggable={false} decoding="async" onError={() => setFailed(true)}/>{isVideo && <span className="ow-project-file-video-badge" aria-hidden="true"><Play size={10} fill="currentColor"/></span>}</>
    : <EntryIcon item={item} size={30}/>}</span>;
}

export function ProjectFilesPanel({ request, projectId, ready, onPlace }: { request: ResourceRequest; projectId?: string; ready: boolean; onPlace: (path: string, position?: { x: number; y: number }) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>(readView);
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const [location, setLocation] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState('');
  const [pages, setPages] = useState<Record<string, Page>>({});
  const generation = useRef(0);
  const tree = useRef<HTMLDivElement>(null);
  const key = (path: string) => path || '/';
  useEffect(() => {
    try { localStorage.setItem(PROJECT_FILES_VIEW_STORAGE_KEY, view); }
    catch { /* File browsing remains available without storage. */ }
  }, [view]);
  useEffect(() => {
    try { localStorage.setItem(PROJECT_FILES_SHOW_HIDDEN_STORAGE_KEY, String(showHidden)); }
    catch { /* File browsing remains available without storage. */ }
  }, [showHidden]);
  const load = async (path: string, cursor?: string) => {
    if (!projectId || !ready) return;
    const epoch = generation.current;
    const id = key(path);
    setPages(old => ({ ...old, [id]: { path, items: cursor ? old[id]?.items ?? [] : [], nextCursor: cursor ?? null, loading: true } }));
    try {
      const query = new URLSearchParams({ path, showHidden: String(showHidden), limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const result = await request<Listing>('/v1/projects/' + encodeURIComponent(projectId) + '/files?' + query);
      if (epoch !== generation.current) return;
      setPages(old => ({ ...old, [id]: { ...result, items: cursor ? [...(old[id]?.items ?? []), ...result.items] : result.items, loading: false } }));
    } catch (error) {
      if (epoch !== generation.current) return;
      setPages(old => ({ ...old, [id]: { ...(old[id] ?? { path, items: [], nextCursor: null }), loading: false, error: error instanceof Error ? error.message : String(error) } }));
    }
  };
  useEffect(() => {
    generation.current++;
    setPages({});
    setExpanded(new Set());
    setLocation('');
    setSelected('');
    if (projectId && ready) void load('');
    return () => { generation.current++; };
  // Query identity includes project and hidden preference; old responses are discarded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready, showHidden, request]);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else { next.add(path); if (!pages[key(path)]) void load(path); }
    setExpanded(next);
  };
  const refresh = () => {
    generation.current++;
    setPages({});
    // Refresh the grid's ancestors too, so navigating back never lands on an absent cache.
    const ancestors = location.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    for (const path of new Set(['', ...ancestors, ...expanded])) void load(path);
  };
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId === projectId && ready) refresh();
    };
    window.addEventListener('openworkgraph:project-files-changed', changed);
    return () => window.removeEventListener('openworkgraph:project-files-changed', changed);
  });
  const navigate = (path: string) => {
    setLocation(path);
    setSelected('');
    if (!pages[key(path)]) void load(path);
  };
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; path?: string }>).detail;
      if (detail?.projectId !== projectId || typeof detail.path !== 'string') return;
      setView('grid');
      navigate(detail.path);
    };
    window.addEventListener('openworkgraph:locate-project-directory', locate);
    return () => window.removeEventListener('openworkgraph:locate-project-directory', locate);
  });
  const drag = (event: React.DragEvent<HTMLButtonElement>, item: Entry) => {
    if (!projectId || item.kind !== 'file') return;
    const end = beginProjectFileDrag(event.dataTransfer, projectId, item.relativePath, position => onPlace(item.relativePath, position));
    event.currentTarget.addEventListener('dragend', end, { once: true });
  };
  const focusRelative = (current: HTMLElement, offset: number) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[data-file-row]') ?? [])];
    const index = rows.indexOf(current);
    rows[Math.max(0, Math.min(rows.length - 1, index + offset))]?.focus();
  };
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, item: Entry) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRelative(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const rows = tree.current?.querySelectorAll<HTMLElement>('[data-file-row]');
      rows?.[event.key === 'Home' ? 0 : rows.length - 1]?.focus();
    }
    if (event.key === 'ArrowRight' && item.kind === 'directory') {
      event.preventDefault();
      if (!expanded.has(item.relativePath)) toggle(item.relativePath);
      else focusRelative(event.currentTarget, 1);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (item.kind === 'directory' && expanded.has(item.relativePath)) toggle(item.relativePath);
      else {
        const parent = item.relativePath.split('/').slice(0, -1).join('/');
        [...(tree.current?.querySelectorAll<HTMLElement>('[data-file-row]') ?? [])].find(row => row.dataset.fileRow === parent)?.focus();
      }
    }
    if (event.key === 'Enter' && item.kind === 'file') { event.preventDefault(); onPlace(item.relativePath); }
  };
  const pageStatus = (path: string) => {
    const page = pages[key(path)];
    return <>
      {page?.loading && <div className="ow-project-file-status" role="status"><LoaderCircle size={16} className="is-spinning" aria-hidden="true"/>{t('Reading directory…')}</div>}
      {page?.error && <div className="ow-project-file-error" role="alert"><AlertCircle size={18} aria-hidden="true"/><div><strong>{t('Could not read directory')}</strong><p>{page.error}</p><button type="button" onClick={() => void load(path, page.nextCursor ?? undefined)}>{t('Read again')}</button></div></div>}
      {page && !page.loading && !page.error && page.items.length === 0 && <div className="ow-project-file-empty"><FolderOpen size={26} strokeWidth={1.5} aria-hidden="true"/><span>{t('This directory has no files to display')}</span></div>}
      {page?.nextCursor && !page.error && <button type="button" className="ow-project-file-more" disabled={page.loading} onClick={() => void load(path, page.nextCursor!)}>{t('Load more')}<ChevronDown size={14} aria-hidden="true"/></button>}
    </>;
  };
  const renderTree = (path: string): React.ReactNode => {
    const page = pages[key(path)];
    return <>
      <ul className="ow-project-file-tree-list">{page?.items.map(item => <li key={item.relativePath}>
        <div className={'ow-project-file-row' + (selected === item.relativePath ? ' is-selected' : '')}>
          <button type="button" draggable={item.kind === 'file'} onDragStart={event => drag(event, item)}
            data-file-row={item.relativePath} title={item.relativePath} className="ow-project-file-name"
            aria-expanded={item.kind === 'directory' ? expanded.has(item.relativePath) : undefined}
            onKeyDown={event => rowKey(event, item)} onFocus={() => setSelected(item.relativePath)}
            onClick={() => { setSelected(item.relativePath); if (item.kind === 'directory') toggle(item.relativePath); }}>
            <span className="ow-project-file-chevron" aria-hidden="true">{item.kind === 'directory' && (expanded.has(item.relativePath) ? <ChevronDown size={13}/> : <ChevronRight size={13}/>)}</span>
            <EntryIcon item={item} open={expanded.has(item.relativePath)}/><span className="ow-project-file-label">{item.name}</span>
          </button>
          {item.kind === 'file' && <div className="ow-project-file-row-end">
            {item.bytes !== undefined && <span className="ow-project-file-size">{formatFileSize(item.bytes)}</span>}
            <button type="button" className="ow-project-file-add" title={t('Add to Work Graph')} aria-label={t('Add {name} to Work Graph', { name: item.name })} onClick={() => onPlace(item.relativePath)}><Plus size={15} aria-hidden="true"/></button>
          </div>}
        </div>
        {item.kind === 'directory' && expanded.has(item.relativePath) && <div className="ow-project-file-branch">{renderTree(item.relativePath)}</div>}
      </li>)}</ul>
      {pageStatus(path)}
    </>;
  };
  const currentPath = view === 'tree' ? '' : location;
  const current = pages[key(currentPath)];
  const busy = Object.values(pages).some(page => page.loading);
  const available = !!projectId && ready;
  const folders = current?.items.filter(item => item.kind === 'directory').length ?? 0;
  const files = (current?.items.length ?? 0) - folders;
  return <section className="ow-project-files-panel" aria-label={t('Project files')}>
    <div className="ow-project-file-controls">
      <div className="ow-project-file-toolbar">
        <div className="ow-project-file-views" role="group" aria-label={t('File view')}>
          <button type="button" title={t('Tree view')} aria-label={t('Tree view')} aria-pressed={view === 'tree'} onClick={() => setView('tree')}><ListTree size={15}/><span>{t('List')}</span></button>
          <button type="button" title={t('Large icon view')} aria-label={t('Large icon view')} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={15}/><span>{t('Icons')}</span></button>
        </div>
        {view === 'tree' && <button type="button" className="ow-project-file-action" aria-label={t('Collapse all directories')} title={t('Collapse all directories')} disabled={!expanded.size} onClick={() => setExpanded(new Set())}><ChevronsDownUp size={16}/></button>}
        <button type="button" className="ow-project-file-action" title={t('Refresh project files')} aria-label={t('Refresh project files')} onClick={refresh} disabled={!available || busy}><RefreshCw size={16} className={busy ? 'is-spinning' : undefined}/></button>
      </div>
      <label className="ow-project-file-hidden"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)}/><span>{t('Show hidden files')}</span></label>
      <nav className="ow-project-file-location" aria-label={t('Project directory path')}>
        <button type="button" title={t('Project root')} aria-current={!currentPath ? 'location' : undefined} onClick={() => navigate('')}><FolderTree size={15} aria-hidden="true"/><span>{t('Project root')}</span></button>
        {currentPath.split('/').filter(Boolean).map((part, index, parts) => <span className="ow-project-file-crumb" key={index}><ChevronRight size={12} aria-hidden="true"/><button type="button" title={parts.slice(0, index + 1).join('/')} aria-current={index === parts.length - 1 ? 'location' : undefined} onClick={() => navigate(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}
      </nav>
    </div>
    {!available ? <div className="ow-project-file-unavailable">{!projectId ? <FolderTree size={32} strokeWidth={1.5}/> : <Unplug size={32} strokeWidth={1.5}/>}<strong>{!projectId ? t('No project linked') : t('Workspace unavailable')}</strong><p>{!projectId ? t('Link a project to browse files and add them to the Work Graph.') : t('Connect the Workspace to continue browsing project files.')}</p></div> : <>
      <div className="ow-project-file-summary"><span>{view === 'tree' ? t('Root directory') : t('Current directory')}</span><span>{current?.loading ? t('Reading') : current?.error ? t('Read failed') : t('{folders} directories · {files} files', { folders, files }) + (current?.nextCursor ? t(' · More available') : '')}</span></div>
      {view === 'tree' ? <div ref={tree} className="ow-project-file-tree" aria-label={t('Project directory')}>{renderTree('')}</div> : <div className="ow-project-file-grid">
        {location && <button type="button" className="ow-project-file-tile ow-project-file-parent" onClick={() => navigate(location.split('/').slice(0, -1).join('/'))}><span className="ow-project-file-tile-icon"><ArrowUp size={24}/></span><span className="ow-project-file-label">{t('Go up one level')}</span></button>}
        {current?.items.map(item => <div key={item.relativePath} className={'ow-project-file-tile-wrap' + (selected === item.relativePath ? ' is-selected' : '')}>
          <button type="button" draggable={item.kind === 'file'} onDragStart={event => drag(event, item)} className="ow-project-file-tile" title={item.relativePath}
            onClick={() => setSelected(item.relativePath)} onFocus={() => setSelected(item.relativePath)}
            onDoubleClick={() => item.kind === 'directory' ? navigate(item.relativePath) : onPlace(item.relativePath)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (item.kind === 'directory') navigate(item.relativePath); else onPlace(item.relativePath); } }}>
            <GridThumbnail key={projectId + ':' + generation.current + ':' + item.relativePath} item={item} projectId={projectId!} request={request}/><span className="ow-project-file-label">{item.name}</span>
            <span className="ow-project-file-tile-meta">{item.kind === 'directory' ? t('Folder') : item.bytes !== undefined ? formatFileSize(item.bytes) : t('File')}</span>
          </button>
          {item.kind === 'file' && <button type="button" className="ow-project-file-add" title={t('Add to Work Graph')} aria-label={t('Add {name} to Work Graph', { name: item.name })} onClick={() => onPlace(item.relativePath)}><Plus size={15}/></button>}
        </div>)}
        {pageStatus(location)}
      </div>}
      <footer className="ow-project-file-footer"><Link2 size={14} aria-hidden="true"/><span>{t('Drag a file in, or click')} <Plus size={12} aria-label={t('plus')}/> {t('to add a reference')}{view === 'grid' && <small>{t('Double-click a folder to open it')}</small>}</span></footer>
    </>}
  </section>;
}
