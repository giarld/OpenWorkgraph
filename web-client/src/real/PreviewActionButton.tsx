import { CopyPlus, Download, LoaderCircle } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import './preview-actions.css';

export function PreviewActionButton({action,busy=false,disabled=false,progress,onClick}: {action:'download'|'copy';busy?:boolean;disabled?:boolean;progress?:number;onClick:()=>void}) {
  const {t} = useI18n();
  const label = action === 'copy' ? t(busy ? 'Copying to Work Graph…' : 'Copy to Work Graph') : t(busy ? 'Downloading…' : 'Download original file');
  const description = label + (progress === undefined ? '' : ' ' + Math.round(progress * 100) + '%');
  const Icon = busy ? LoaderCircle : action === 'copy' ? CopyPlus : Download;
  return <button type="button" className="ow-preview-action" title={description} aria-label={description} aria-busy={busy} disabled={disabled || busy} onClick={onClick}>
    <Icon size={18} strokeWidth={1.75} aria-hidden="true" className={busy ? 'ow-preview-action-spinner' : undefined}/>
    {progress !== undefined && <span className="ow-preview-action-progress" aria-hidden="true">{Math.round(progress * 100)}%</span>}
  </button>;
}
