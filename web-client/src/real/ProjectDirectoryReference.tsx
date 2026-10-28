import { Folder } from 'lucide-react';

export function ProjectDirectoryReference({ path, absolutePath }: { path: string; absolutePath?: string }) {
  return <div className="node-content ow-file-node ow-project-directory-reference" title={absolutePath ?? path}>
    <Folder size={32} aria-hidden="true"/>
    <span>{path.split('/').at(-1)}</span>
  </div>;
}
