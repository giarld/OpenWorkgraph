import { Component, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { graphPath, type GraphSnapshot, type Request } from './contracts';
import { CanvasProjectFilePreview, CanvasResourcePreview } from './ResourcesPanel';
import { hexDump, type PreviewMode } from './preview-formats';
import { getPreviewRegistryVersion, subscribePreviewRegistry, resolvePreviewRenderer, resolvePreviewSource, type PreviewRendererDefinition } from './preview-registry';
import './preview-node.css';
import { PreviewLayout } from './PreviewLayout';
import { File as FileIcon } from 'lucide-react';
import { formatFileSize, PROJECT_FILE_PREVIEW_MAX_BYTES } from '../domain/file-types';
import { useI18n } from '../i18n/I18nProvider';
import { translate } from '../i18n/translate';

const RENDER_LIMIT = 2 * 1024 * 1024;
class PreviewBoundary extends Component<{children: ReactNode; resetKey: string}, {failed: boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() { return {failed:true}; }
  componentDidUpdate(previous: {resetKey:string}) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({failed:false}); }
  render() { return this.state.failed ? <p role="status">{translate('The preview extension cannot display this content.')}</p> : this.props.children; }
}
export function PreviewNode(props: { graph: GraphSnapshot; nodeId: string; request: Request; onError: (e: unknown) => void; preferredMode?: PreviewMode; onModeChange?: (mode: PreviewMode) => void }) {
  const registryVersion = useSyncExternalStore(subscribePreviewRegistry, getPreviewRegistryVersion, getPreviewRegistryVersion);
  const edge = props.graph.edges.find(item => item.targetId === props.nodeId && item.kind === 'reference');
  const source = props.graph.nodes.find(item => item.id === edge?.sourceId);
  // Rebuild the whole presentation when the predecessor identity, schema or
  // content version changes. Renderer-local state must never leak across sources.
  const sourceKey = edge && source ? [edge.id,source.id,source.type,source.schemaVersion,source.contentVersion].join(':') : 'empty';
  return <PreviewBoundary resetKey={props.nodeId + ':' + sourceKey + ':' + registryVersion}><PreviewSourceContent key={sourceKey} {...props}/></PreviewBoundary>;
}
function PreviewSourceContent({ graph, nodeId, request, onError, preferredMode, onModeChange }: { graph: GraphSnapshot; nodeId: string; request: Request; onError: (e: unknown) => void; preferredMode?: PreviewMode; onModeChange?: (mode: PreviewMode) => void }) {
  const {t} = useI18n();
  const resolved = resolvePreviewSource(graph,nodeId);
  if (resolved.state === 'empty') return <div className="ow-preview-empty">{t('Connect a text, image, or file predecessor to preview its content.')}</div>;
  if (resolved.state === 'unsupported') return <p role="status">{t('This predecessor does not support previews yet. Install a compatible preview extension.')}</p>;
  if (resolved.state !== 'ready') return <p role="status">{t('A preview node requires one predecessor that is not a preview node.')}</p>;
  const source = resolved.source;
  if (source.kind === 'empty-project-file') return <div className="ow-preview-empty">{t('The empty reference node is not associated with a project file yet.')}{source.relativePath && <small>{source.relativePath}</small>}</div>;
  if (source.kind === 'project-file') return <ProjectFilePreview key={resolved.nodeId + ':' + source.relativePath} request={request} projectId={graph.projectId} relativePath={source.relativePath} name={source.name} mime={source.mime} preferredMode={preferredMode} onModeChange={onModeChange} onError={onError}/>;
  if (source.kind === 'inline-file') return <InlineFilePreview key={resolved.nodeId} name={source.name} text={source.text} mime={source.mime} preferredMode={preferredMode} onModeChange={onModeChange}/>;
  if (source.kind === 'image') return <CanvasResourcePreview request={request} projectId={graph.projectId} graphId={graph.graphId} resourceId={source.resourceId} version={source.version} mime={source.mime || undefined} name={source.name} imageNode onError={onError}/>;
  if (source.kind === 'text') return <TextPreview key={resolved.nodeId} name={source.name} text={source.text} preferredMode={preferredMode} onModeChange={onModeChange}/>;
  const path = graphPath(graph.projectId,graph.graphId) + '/resources/' + encodeURIComponent(source.resourceId) + '/versions/' + source.version;
  return <FilePreview key={resolved.nodeId + ':' + path} request={request} path={path} name={source.name} mime={source.mime} preferredMode={preferredMode} onModeChange={onModeChange}/>;
}

function TextPreview({name,text,preferredMode,onModeChange}: {name:string;text:string;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void}) {
  const {t} = useI18n();
  const mime = 'text/markdown';
  const blob = useMemo(() => new Blob([text], {type:mime}), [text]);
  // Resolve Markdown through the shared registry regardless of the text node title.
  const renderer: PreviewRendererDefinition = {...resolvePreviewRenderer({name:'',mime}),label:'Markdown',modes:['text','rendered'],defaultMode:'text'};
  return <div className="ow-preview-node" data-canvas-interactive><RenderedFile key={renderer.id} blob={blob} name={name} mime={mime} renderer={renderer} textLabel={t('Read-only text preview')} preferredMode={preferredMode} onModeChange={onModeChange}/></div>;
}

function InlineFilePreview({name,text,mime,preferredMode,onModeChange}: {name:string;text:string;mime:string;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void}) {
  const blob = useMemo(() => new Blob([text], {type:mime}), [text,mime]);
  return <div className="ow-preview-node" data-canvas-interactive><FileContent blob={blob} name={name} mime={mime} preferredMode={preferredMode} onModeChange={onModeChange}/></div>;
}

export function ProjectFilePreview({request,projectId,relativePath,name,mime,download=false,preferredMode,onModeChange,onError,missingMessage,showName=true}: {request:Request;projectId:string;relativePath:string;name:string;mime:string;download?:boolean;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void;onError?: (e: unknown) => void;missingMessage?:string;showName?:boolean}) {
  if (mime.startsWith('image/')) return <CanvasProjectFilePreview request={request} projectId={projectId} relativePath={relativePath} mime={mime} name={name} imageNode onError={onError ?? (() => undefined)} missingMessage={missingMessage}/>;
  return <ProjectFileTextPreview request={request} projectId={projectId} relativePath={relativePath} name={name} mime={mime} download={download} preferredMode={preferredMode} onModeChange={onModeChange} missingMessage={missingMessage} showName={showName}/>;
}

export function LinkedFilePreview({base64,name,mime,copying=false,onCopyToGraph}: {base64:string;name:string;mime:string;copying?:boolean;onCopyToGraph?:()=>void}) {
  const {t} = useI18n();
  const blob = useMemo(() => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return new Blob([bytes], {type:mime || 'application/octet-stream'});
  }, [base64,mime]);
  return <div className="ow-preview-node" data-canvas-interactive>
    <FileContent blob={blob} name={name} mime={mime || blob.type} showName={false}/>
    <FileDownload blob={blob} name={name}>{onCopyToGraph && <button type="button" className="primary-button" disabled={copying} onClick={onCopyToGraph}>{copying ? t('Copying to Work Graph…') : t('Copy to Work Graph')}</button>}</FileDownload>
  </div>;
}

function ProjectFileTextPreview({request,projectId,relativePath,name,mime,download=false,preferredMode,onModeChange,missingMessage,showName=true}: {request:Request;projectId:string;relativePath:string;name:string;mime:string;download?:boolean;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void;missingMessage?:string;showName?:boolean}) {
  const {t} = useI18n();
  const [state,setState] = useState<{blob?:Blob;status?:'missing'|'unavailable'|'too-large';error?:string}>();
  const [retry,setRetry] = useState(0);
  useEffect(() => {
    let active=true; setState(undefined);
    const base='/v1/projects/'+encodeURIComponent(projectId)+'/files';
    const query=new URLSearchParams({path:relativePath});
    void request<Array<{state:'available'|'missing'|'unavailable';bytes:number|null}>>(base+'/stat',{paths:[relativePath]},'POST').then(async ([observation])=>{
      if(!active)return;
      if(!observation||observation.state!=='available'){setState({status:observation?.state==='missing'?'missing':'unavailable'});return;}
      if (typeof observation.bytes === 'number' && observation.bytes > PROJECT_FILE_PREVIEW_MAX_BYTES) { setState({status:'too-large'}); return; }
      const result=await request<{base64:string}>(base+'/content?'+query);
      const bytes=Uint8Array.from(atob(result.base64),character=>character.charCodeAt(0));
      if(active)setState({blob:new Blob([bytes],{type:mime||'application/octet-stream'})});
    }).catch(error=>{if(active)setState({status:'unavailable',error:error instanceof Error?error.message:String(error)});});
    return()=>{active=false;};
  },[request,projectId,relativePath,mime,retry]);
  return <div className="ow-preview-node" data-canvas-interactive>
    {!state&&<p role="status">{t('Reading project file…')}</p>}
    {state?.status==='missing'&&<p role="status">{missingMessage ?? t('The project file no longer exists. The reference is preserved.')} <button onClick={()=>setRetry(value=>value+1)}>{t('Check again')}</button></p>}
    {state?.status==='too-large'&&<p role="status">{t('The file exceeds 50 MiB and cannot be previewed. Reduce its size and try again.')} <button onClick={()=>setRetry(value=>value+1)}>{t('Check again')}</button></p>}
    {state?.status==='unavailable'&&<p role="status">{state.error?t('The project file is currently unavailable: {error}', {error:state.error}):t('The project file is currently unavailable.')} <button onClick={()=>setRetry(value=>value+1)}>{t('Retry preview')}</button></p>}
    {state?.blob&&<FileContent blob={state.blob} name={name} mime={mime||state.blob.type} preferredMode={preferredMode} onModeChange={onModeChange} showName={showName}/>}
    {download&&state?.blob&&<FileDownload blob={state.blob} name={name}/>}
  </div>;
}

/** Resource-scoped entry point shared by node previews and file dialogs. */
export function ResourceFilePreview({request,projectId,graphId,resourceId,version,name,mime,showName=true}: {request:Request;projectId:string;graphId:string;resourceId:string;version:number;name:string;mime:string;showName?:boolean}) {
  const path = graphPath(projectId,graphId) + '/resources/' + encodeURIComponent(resourceId) + '/versions/' + version;
  const registryVersion = useSyncExternalStore(subscribePreviewRegistry, getPreviewRegistryVersion, getPreviewRegistryVersion);
  return <PreviewBoundary resetKey={path + ':' + registryVersion}><FilePreview key={path} request={request} path={path} name={name} mime={mime} download showName={showName}/></PreviewBoundary>;
}

function FileDownload({blob,name,children}: {blob:Blob;name:string;children?:ReactNode}) {
  const {t} = useI18n();
  const [url,setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([blob], {type:'application/octet-stream'}));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return <footer className="ow-preview-download">{children}<button type="button" disabled={!url} onClick={() => {
    const anchor = document.createElement('a');
    anchor.href=url; anchor.download=name.replaceAll(/[\\/]/g,'_');
    document.body.append(anchor); anchor.click(); anchor.remove();
  }}>{t('Download original file')}</button></footer>;
}

function FilePreview({ request, path, name, mime, download=false, preferredMode, onModeChange, showName=true }: { request: Request; path: string; name: string; mime: string; download?:boolean; preferredMode?:PreviewMode; onModeChange?:(mode:PreviewMode)=>void; showName?:boolean }) {
  const {t} = useI18n();
  const [state, setState] = useState<{ blob?: Blob; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState(undefined);
    void request<Blob>(path + '/content', undefined, 'BLOB').then(blob => {
      if (active) setState({ blob });
    }).catch(e => { if (active) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { active = false; };
  }, [request, path, retry]);
  return <div className="ow-preview-node" data-canvas-interactive>
    {!state && <p role="status">{t('Reading predecessor resource…')}</p>}
    {state?.error && <p role="status">{t('Preview failed: {error}', {error:state.error})} <button onClick={() => setRetry(n => n + 1)}>{t('Retry preview')}</button></p>}
    {state?.blob && <FileContent blob={state.blob} name={name} mime={mime || state.blob.type} preferredMode={preferredMode} onModeChange={onModeChange} showName={showName}/>}
    {download && state?.blob && <FileDownload blob={state.blob} name={name}/>}
  </div>;
}

function FileContent({ blob, name, mime, preferredMode, onModeChange, showName=true }: { blob: Blob; name: string; mime: string; preferredMode?:PreviewMode; onModeChange?:(mode:PreviewMode)=>void; showName?:boolean }) {
  useSyncExternalStore(subscribePreviewRegistry, getPreviewRegistryVersion, getPreviewRegistryVersion);
  const renderer = resolvePreviewRenderer({name,mime});
  return <FilePresentation key={renderer.id} blob={blob} name={name} mime={mime} renderer={renderer} preferredMode={preferredMode} onModeChange={onModeChange} showName={showName}/>;
}
function FilePresentation({blob,name,mime,renderer,preferredMode,onModeChange,showName}: {blob:Blob;name:string;mime:string;renderer:PreviewRendererDefinition;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void;showName:boolean}) {
  const {t} = useI18n();
  const [openedBlob,setOpenedBlob] = useState<Blob>();
  if (renderer.initialView === 'metadata' && openedBlob !== blob) return <div className="ow-preview-file-summary">
    <FileIcon size={32} aria-hidden="true"/>
    <div className="ow-file-metadata">{showName && <strong title={name}>{name}</strong>}<span className="ow-file-size">{formatFileSize(blob.size)}</span></div>
    <button type="button" onClick={() => setOpenedBlob(blob)}>{t('View content')}</button>
  </div>;
  return <RenderedFile blob={blob} name={name} mime={mime} renderer={renderer} preferredMode={preferredMode} onModeChange={onModeChange} showName={showName}/>;
}
function RenderedFile({blob,name,mime,renderer,textLabel,preferredMode,onModeChange,showName=true}: {blob:Blob;name:string;mime:string;renderer:PreviewRendererDefinition;textLabel?:string;preferredMode?:PreviewMode;onModeChange?:(mode:PreviewMode)=>void;showName?:boolean}) {
  const {t} = useI18n();
  const resolvedTextLabel = textLabel ?? t('Plain text preview');
  const [selectedMode,setMode] = useState<PreviewMode>(() => preferredMode && renderer.modes.includes(preferredMode) ? preferredMode : renderer.defaultMode);
  const mode = renderer.modes.includes(selectedMode) ? selectedMode : renderer.defaultMode;
  const [page,setPage] = useState(0);
  const [decoded,setDecoded] = useState<{blob:Blob;key:string;text:string;bytes:Uint8Array}>();
  const [error,setError] = useState('');
  const pageSize = mode === 'hex' ? 256 : 64 * 1024;
  const offset = mode === 'rendered' ? 0 : page * pageSize;
  const key = mode + ':' + offset;
  const paginated = mode !== 'rendered';
  const pages = Math.max(1,Math.ceil(blob.size / pageSize));
  const needsText = mode === 'rendered' && renderer.input === 'text';
  const modesKey = renderer.modes.join(':');
  useEffect(() => {
    setMode(preferredMode && renderer.modes.includes(preferredMode) ? preferredMode : renderer.defaultMode);
    setPage(0);
  }, [preferredMode,renderer.id,renderer.defaultMode,modesKey]);
  useEffect(() => { setPage(0); }, [blob]);
  useEffect(() => {
    if (mode === 'rendered' && !needsText) return;
    let active = true;
    setError('');
    const size = mode === 'rendered' ? RENDER_LIMIT : pageSize;
    // Text chunks include the rest of the final UTF-8 codepoint; the next chunk
    // skips its continuation bytes. Hex offsets always remain exact.
    void blob.slice(offset,offset + size + (mode === 'hex' ? 0 : 3)).arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      let start = 0, end = Math.min(size,bytes.length);
      if (mode !== 'hex') {
        if (offset > 0) while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
      }
      if (active) setDecoded({blob,key,text:new TextDecoder().decode(bytes.subarray(start,end)),bytes:bytes.subarray(0,size)});
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  },[blob,key,offset,mode,pageSize,needsText]);
  const current = decoded?.blob === blob && decoded.key === key ? decoded : undefined;
  const View = renderer.Component;
  return <>
    <header className={'ow-preview-controls' + (showName ? '' : ' ow-preview-controls-name-hidden')}>{showName && <span title={name} data-canvas-draggable>{name}</span>}<label>{t('Display mode')}<select aria-label={t('Preview display mode')} value={mode} onChange={e => {const next=e.target.value as PreviewMode;setMode(next);setPage(0);onModeChange?.(next);}}>
      {renderer.modes.map(value => <option key={value} value={value}>{value === 'rendered' ? t(renderer.label) : value === 'text' ? t('Plain text') : t('Hexadecimal')}</option>)}
    </select></label></header>
    {error && <p role="status">{t('Read failed: {error}', {error})}</p>}
    <PreviewLayout scrollable={mode !== 'rendered' || renderer.layout !== 'fill'} footer={paginated && <nav aria-label={t('Content pagination')}><button disabled={page === 0} onClick={() => setPage(p => p-1)}>{t('Previous section')}</button><span>{t('{page} / {pages} · {bytes} bytes', {page:page+1,pages,bytes:blob.size})}</span><button disabled={page+1 >= pages} onClick={() => setPage(p => p+1)}>{t('Next section')}</button></nav>}>
      {mode === 'rendered' && View ? <>
        {needsText && blob.size > RENDER_LIMIT && <p role="status">{t('Rendered preview shows only the first 2 MiB. Switch to paginated plain text to view the complete content.')}</p>}
        {!needsText || current ? <View blob={blob} name={name} mime={mime} text={current?.text ?? ''}/> : <p role="status">{t('Decoding content…')}</p>}
      </> : current ? mode === 'hex' ? <pre className="ow-preview-hex" aria-label={t('Hexadecimal preview')}>{hexDump(current.bytes,offset) || t('Empty file')}</pre> : <pre className="ow-preview-text" aria-label={resolvedTextLabel}>{current.text || t('Empty file')}</pre> : <p role="status">{t('Decoding content…')}</p>}
    </PreviewLayout>
  </>;
}
