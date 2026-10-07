import { escapeMarkdownLinkLabel } from './project-file-mentions';

export interface ReferenceMentionCandidate {
  id: string;
  name: string;
  kind: 'reference';
}

// Stable node IDs distinguish equal titles and never masquerade as project paths.
export function insertReferenceMention(text: string, start: number, end: number, item: ReferenceMentionCandidate): { value: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const link = `[${escapeMarkdownLinkLabel(item.name)}](workgraph-node:${encodeURIComponent(item.id).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16))})`;
  const inserted = (/\s$/.test(before) ? '' : ' ') + link + (/^\s/.test(after) ? '' : ' ');
  return { value: before + inserted + after, caret: before.length + inserted.length };
}

export function extractReferenceMention(link: string): ReferenceMentionCandidate | undefined {
  const match = /^\[((?:\\.|[^\]])*)\]\(workgraph-node:([^)\s]+)\)$/.exec(link);
  if (!match) return;
  try {
    const id = decodeURIComponent(match[2]);
    if (!id) return;
    return { id, name: match[1].replace(/\\([\\[\]`*_<>!&])/g, '$1'), kind: 'reference' };
  } catch { return; }
}
