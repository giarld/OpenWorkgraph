export type ProjectFileMentionKind = "file" | "directory";

export interface ProjectFileMentionCandidate {
  name: string;
  relativePath: string;
  kind: ProjectFileMentionKind;
}

export interface MentionQuery {
  start: number;
  query: string;
}

const MENTION_TRIGGER = "@";

/** Keep link labels literal: no nested links, emphasis, code, HTML or entities. */
export function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/[\\[\]`*_<>!&]/g, "\\$&");
}

/** Build a standard Markdown link for a project file or directory candidate. */
export function projectFileMarkdownLink(item: ProjectFileMentionCandidate): string {
  const label = escapeMarkdownLinkLabel(item.name);
  const path = item.relativePath + (item.kind === "directory" ? "/" : "");
  // Angle destinations keep spaces/parentheses readable and distinguish literal
  // percent signs from links saved by the older URI-encoding implementation.
  const destination = /[\s()%#?<>\\&]/.test(path) ? `<${path.replace(/[<>\\&]/g, '\\$&')}>` : path;
  return `[${label}](${destination})`;
}

/** Insert with whitespace boundaries without duplicating existing separators. */
export function insertProjectFileMarkdownLink(text: string, start: number, end: number, item: ProjectFileMentionCandidate): { value: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const inserted = (/\s$/.test(before) ? '' : ' ') + projectFileMarkdownLink(item) + (/^\s/.test(after) ? '' : ' ');
  return { value: before + inserted + after, caret: before.length + inserted.length };
}

/** Read only the relative Markdown links produced by projectFileMarkdownLink. */
export function extractProjectFileMarkdownLinks(value: string): ProjectFileMentionCandidate[] {
  const result: ProjectFileMentionCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /\[((?:\\.|[^\]])*)\]\((?:<((?:\\.|[^>\r\n])*)>|([^)\s]+))\)/g;
  for (const match of value.matchAll(pattern)) {
    const raw = match[2] !== undefined;
    const href = raw ? match[2]!.replace(/\\([<>\\&])/g, '$1') : match[3]!;
    if (!href || href.startsWith('/') || href.includes(String.fromCharCode(92)) || href.includes(':') || (!raw && (href.includes('?') || href.includes('#')))) continue;
    const directory = href.endsWith('/');
    const encoded = directory ? href.slice(0, -1) : href;
    try {
      const parts = encoded.split('/').map(segment => raw ? segment : decodeURIComponent(segment));
      if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[/\\:]/.test(part))) continue;
      const relativePath = parts.join('/');
      const kind: ProjectFileMentionKind = directory ? 'directory' : 'file';
      const key = kind + ':' + relativePath;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ name:match[1]!.replace(/\\([\\[\]`*_<>!&])/g, '$1'), relativePath, kind });
    } catch { /* Ignore malformed percent-encoding and ordinary non-project links. */ }
  }
  return result;
}

/**
 * Locate an active @mention before the cursor. Only a token whose first
 * character is `@` (i.e. preceded by whitespace or the start of the text)
 * qualifies, so ordinary emails and inline `@`s do not trigger suggestions.
 */
export function findMentionQuery(value: string, cursor: number): MentionQuery | null {
  const position = Math.max(0, Math.min(Math.trunc(cursor), value.length));
  let start = position;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  if (value[start] !== MENTION_TRIGGER) return null;
  const query = value.slice(start + 1, position);
  if (query.includes(MENTION_TRIGGER)) return null;
  return { start, query };
}
