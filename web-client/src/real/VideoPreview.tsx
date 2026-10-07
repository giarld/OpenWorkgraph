import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertCircle, LoaderCircle, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { Request } from './contracts';
import { registerVideoStream, VIDEO_FULL_LOAD_BYTES } from './video-stream';
import './video-preview.css';

function videoTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60);
  return (hours ? hours + ':' + String(minutes % 60).padStart(2, '0') : minutes) + ':' + String(whole % 60).padStart(2, '0');
}
const fill = (value: number): CSSProperties => ({ '--video-fill': value * 100 + '%' } as CSSProperties);

export function StreamingVideoPreview({request,path,bytes,name}: {request:Request;path:string;bytes:number;name:string}) {
  const {t} = useI18n();
  const [state,setState] = useState<{src?:string;blob?:Blob;error?:string}>({});
  useEffect(() => {
    let active = true;
    let release: (()=>void) | undefined;
    setState({});
    void registerVideoStream(request,path,bytes).then(stream => {
      if (active) { release = stream.release; setState({src:stream.src}); }
      else stream.release();
    }).catch(async error => {
      if (bytes > VIDEO_FULL_LOAD_BYTES) { if (active) setState({error:error instanceof Error ? error.message : String(error)}); return; }
      try {
        let blob: Blob;
        if (path.includes('/files/content?')) {
          const result=await request<{base64:string}>(path);
          blob=new Blob([Uint8Array.from(atob(result.base64),char=>char.charCodeAt(0))],{type:'video/mp4'});
        } else blob=await request<Blob>(path,undefined,'BLOB');
        if (active) setState({blob});
      } catch (cause) { if (active) setState({error:cause instanceof Error ? cause.message : String(cause)}); }
    });
    return () => { active=false; release?.(); };
  },[request,path,bytes]);
  if (state.error) return <p role="status">{t('Video preview failed: {error}',{error:state.error})}</p>;
  return state.src ? <VideoPreview key={state.src} src={state.src} name={name}/> : state.blob ? <VideoPreview key={path} blob={state.blob} name={name}/> : <p role="status">{t('Preparing video stream…')}</p>;
}

export function VideoPreview({ blob, name, src }: {blob?:Blob;name:string;src?:string}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState('');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const seekDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const effectiveVolume = muted ? 0 : volume;

  useEffect(() => {
    if (src || !blob) { setUrl(''); setTime(0); setDuration(0); setPlaying(false); setFailed(false); setLoading(true); return; }
    const next = URL.createObjectURL(new Blob([blob], { type: blob.type || 'video/mp4' }));
    setUrl(next); setTime(0); setDuration(0); setPlaying(false);
    setFailed(false); setLoading(true); setFullscreenError(false);
    return () => URL.revokeObjectURL(next);
  }, [blob,src]);
  const source = src || url;
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const toggle = () => {
    const element = video.current;
    if (!element || failed) return;
    if (element.paused) {
      void element.play().catch((error: unknown) => {
        // A rapid pause or source switch may cancel a pending play request.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (video.current === element && element.getAttribute('src') === source) {
          setFailed(true); setLoading(false);
        }
      });
    } else element.pause();
  };
  const toggleFullscreen = async () => {
    setFullscreenError(false);
    try {
      if (document.fullscreenElement === container.current) await document.exitFullscreen();
      else await container.current?.requestFullscreen();
    } catch { setFullscreenError(true); }
  };
  const playLabel = playing ? t('Pause video') : t('Play video');
  const muteLabel = effectiveVolume === 0 ? t('Unmute video') : t('Mute video');
  const fullscreenLabel = fullscreen ? t('Exit video fullscreen') : t('Video fullscreen');

  return <div ref={container} className="ow-preview-video" data-canvas-interactive>
    <div className="ow-preview-video-stage">
      {source && <video ref={video} src={source} preload="metadata" playsInline aria-label={name}
        onLoadedMetadata={event => setDuration(event.currentTarget.duration)}
        onLoadedData={() => setLoading(false)} onCanPlay={() => setLoading(false)}
        onWaiting={() => setLoading(true)} onPlaying={() => setLoading(false)}
        onDurationChange={event => setDuration(event.currentTarget.duration)}
        onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setLoading(false); }}
        onVolumeChange={event => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
        onError={() => { setFailed(true); setLoading(false); setPlaying(false); }}/>}
      {failed ? <div className="ow-preview-video-message" role="status">
        <AlertCircle size={28} aria-hidden="true"/>
        <span>{t('Video preview failed. Check the file format or codec.')}</span>
      </div> : loading ? <div className="ow-preview-video-message" role="status">
        <LoaderCircle className="ow-preview-video-spinner" size={28} aria-hidden="true"/>
        <span>{t('Loading video…')}</span>
      </div> : !playing && <button className="ow-preview-video-center" type="button"
        onClick={toggle} aria-label={t('Start video playback')} title={t('Play video')}>
        <Play size={28} fill="currentColor" aria-hidden="true"/>
      </button>}
    </div>
    <div className="ow-preview-video-controls">
      <input className="ow-preview-video-seek" type="range" min="0" max={seekDuration} step="0.01"
        value={Math.min(time, seekDuration)} disabled={!seekDuration || failed}
        style={fill(seekDuration ? Math.min(time / seekDuration, 1) : 0)}
        aria-label={t('Video progress')} aria-valuetext={videoTime(time) + ' / ' + videoTime(duration)}
        onChange={event => { if (video.current) { video.current.currentTime = Number(event.target.value); setTime(video.current.currentTime); } }}/>
      <div className="ow-preview-video-toolbar">
        <button className="ow-preview-video-play" type="button" onClick={toggle} aria-label={playLabel} title={playLabel} disabled={!source || failed}>
          {playing ? <Pause size={18} fill="currentColor" aria-hidden="true"/> : <Play size={18} fill="currentColor" aria-hidden="true"/>}
        </button>
        <span className="ow-preview-video-time" role="timer" aria-label={t('Video time')}>
          <span>{videoTime(time)}</span><span className="ow-preview-video-duration"> / {videoTime(duration)}</span>
        </span>
        <div className="ow-preview-video-audio">
          <button type="button" aria-label={muteLabel} title={muteLabel} disabled={failed} onClick={() => {
            const element = video.current;
            if (!element) return;
            if (effectiveVolume === 0) { element.muted = false; if (element.volume === 0) element.volume = 1; }
            else element.muted = true;
          }}>
            {effectiveVolume === 0 ? <VolumeX size={18} aria-hidden="true"/> : <Volume2 size={18} aria-hidden="true"/>}
          </button>
          <input className="ow-preview-video-volume" type="range" min="0" max="1" step="0.01"
            value={effectiveVolume} style={fill(effectiveVolume)} disabled={failed}
            aria-label={t('Video volume')} aria-valuetext={Math.round(effectiveVolume * 100) + '%'}
            onChange={event => { if (video.current) { video.current.muted = false; video.current.volume = Number(event.target.value); } }}/>
        </div>
        {document.fullscreenEnabled && <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreenLabel} title={fullscreenLabel}>
          {fullscreen ? <Minimize size={18} aria-hidden="true"/> : <Maximize size={18} aria-hidden="true"/>}
        </button>}
      </div>
      {fullscreenError && <p className="ow-preview-video-notice" role="status">{t('Fullscreen is unavailable. Try again.')}</p>}
    </div>
  </div>;
}
