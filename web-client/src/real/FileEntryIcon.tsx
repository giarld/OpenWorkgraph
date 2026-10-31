import { File, FileArchive, FileCode2, FileImage, FileJson, FileText, FileVideo, Folder, FolderOpen } from 'lucide-react';

const isVideoFile = (name: string): boolean => /[.](mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv)$/i.test(name);

export function FileEntryIcon({ item, open = false, size = 17 }: { item: { name: string; kind: 'file' | 'directory' }; open?: boolean; size?: number }) {
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
