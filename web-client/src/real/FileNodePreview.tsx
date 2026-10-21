import { useEffect, useState, useSyncExternalStore } from 'react';
import { File as FileIcon } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { formatFileSize } from '../domain/file-types';
import { graphPath, type Request } from './contracts';
import { ProjectFilePreview, ResourceFilePreview } from './PreviewNode';
import { previewMode, type PreviewMode } from './preview-formats';
import { getPreviewRegistryVersion, resolvePreviewRenderer, subscribePreviewRegistry } from './preview-registry';
import './file-node-preview.css';
import { FilePreviewModeSelect } from './FilePreviewModeSelect';

export type FilePreviewMode = PreviewMode | 'metadata';
export function filePreviewMode(value: unknown): FilePreviewMode | undefined {
  return value === 'metadata' ? value : previewMode(value);
}

/** File nodes own their display preference; resources and reference edges stay intact. */
export function FileNodePreview({ request, projectId, graphId, resourceId, version, relativePath, name, mime, bytes, preferredMode, onModeChange, onError }: {
  request: Request; projectId: string; graphId: string; resourceId?: string; version?: number; relativePath?: string;
  name: string; mime: string; bytes?: number; preferredMode?: FilePreviewMode; onModeChange?: (mode: FilePreviewMode) => void; onError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  useSyncExternalStore(subscribePreviewRegistry, getPreviewRegistryVersion, getPreviewRegistryVersion);
  const previewName = relativePath?.split('/').at(-1) ?? name;
  const renderer = resolvePreviewRenderer({ name: previewName, mime });
  const defaultMode = renderer.initialView === 'metadata' ? 'metadata' : renderer.defaultMode;
  const [selected, setSelected] = useState(preferredMode ?? defaultMode);
  const mode = selected === 'metadata' || renderer.modes.includes(selected) ? selected : defaultMode;
  const [size, setSize] = useState(bytes);
  const [error, setError] = useState('');
  useEffect(() => { setSelected(preferredMode ?? defaultMode); }, [preferredMode, defaultMode, renderer.id]);
  useEffect(() => {
    setSize(bytes); setError('');
    if (bytes !== undefined && relativePath === undefined) return;
    let active = true;
    void (async () => {
      if (relativePath !== undefined) {
        const [stat] = await request<Array<{ state: string; bytes: number | null }>>('/v1/projects/' + encodeURIComponent(projectId) + '/files/stat', { paths: [relativePath] }, 'POST');
        if (!active) return;
        if (stat?.state !== 'available') setError(t(stat?.state === 'missing' ? 'The project file no longer exists. The reference is preserved.' : 'The project file is currently unavailable.'));
        else setSize(typeof stat.bytes === 'number' && Number.isSafeInteger(stat.bytes) && stat.bytes >= 0 ? stat.bytes : undefined);
      } else if (resourceId && version) {
        const stat = await request<{ bytes: number }>(graphPath(projectId, graphId) + '/resources/' + encodeURIComponent(resourceId) + '/versions/' + version);
        if (active && Number.isSafeInteger(stat.bytes) && stat.bytes >= 0) setSize(stat.bytes);
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [request, projectId, graphId, resourceId, version, relativePath, bytes, t]);
  return <div className="ow-file-node-preview" data-canvas-interactive data-canvas-file-preview>
    <FilePreviewModeSelect mode={mode} options={[
      { value: 'metadata', label: t('File information') },
      ...renderer.modes.map(value => ({ value, label: value === 'rendered' ? t(renderer.label) : value === 'text' ? t('Plain text') : t('Hexadecimal') })),
    ]} onChange={next => { setSelected(next); onModeChange?.(next); }}/>
    {mode === 'metadata' ? <div className="node-content ow-file-node">
      <FileIcon size={32} aria-hidden="true"/>
      <div className="ow-file-metadata"><strong title={name}>{name}</strong>{size !== undefined && <span className="ow-file-size">{formatFileSize(size)}</span>}</div>
      {error && <span role="status">{error}</span>}
    </div> : relativePath !== undefined
      ? <ProjectFilePreview request={request} projectId={projectId} relativePath={relativePath} name={previewName} mime={mime} preferredMode={mode} showName={false} onError={onError}/>
      : resourceId && version ? <ResourceFilePreview request={request} projectId={projectId} graphId={graphId} resourceId={resourceId} version={version} name={name} mime={mime} preferredMode={mode} download={false} showName={false} onError={onError}/> : null}
  </div>;
}
