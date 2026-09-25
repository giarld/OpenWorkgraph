export type PreviewFormat = 'html' | 'image' | 'svg' | 'markdown' | 'code' | 'pdf' | 'csv' | 'video' | 'hex';
export type PreviewMode = 'rendered' | 'text' | 'hex';
export function previewMode(value: unknown): PreviewMode | undefined {
  return value === 'rendered' || value === 'text' || value === 'hex' ? value : undefined;
}
const languages: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx',
  py: 'python', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  kt: 'kotlin', sh: 'bash', bash: 'bash', ps1: 'powershell', sql: 'sql', json: 'json',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte',
};
export const fileExtension = (name: string) => name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
const imageMimeByExtension: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
export function previewImageMime(name: string, mime = ''): string | undefined {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  if (normalized.startsWith('image/') && normalized !== 'image/svg+xml') return normalized;
  return imageMimeByExtension[fileExtension(name)];
}
export function previewFormat(name: string, mime = ''): PreviewFormat {
  mime = mime.split(';')[0].trim().toLowerCase();
  const ext = fileExtension(name);
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'csv') return 'csv';
  if (ext === 'svg') return 'svg';
  if (imageMimeByExtension[ext]) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'mp4') return 'video';
  if (Object.hasOwn(languages, ext)) return 'code';
  if (ext === 'bin') return 'hex';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/csv') return 'csv';
  if (mime === 'image/svg+xml') return 'svg';
  if (previewImageMime('', mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'video/mp4') return 'video';
  return 'hex';
}
export function codeMarkdown(text: string, name: string): string {
  const tick = String.fromCharCode(96);
  let longest = 0;
  for (const match of text.matchAll(new RegExp(tick + '+', 'g'))) longest = Math.max(longest, match[0].length);
  const fence = tick.repeat(Math.max(3, longest + 1));
  return fence + (languages[fileExtension(name)] ?? '') + '\n' + text + '\n' + fence;
}
export function hexDump(bytes: Uint8Array, offset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    lines.push((offset + i).toString(16).padStart(8, '0') + '  ' +
      Array.from(row, n => n.toString(16).padStart(2, '0')).join(' ').padEnd(47) + '  ' +
      Array.from(row, n => n >= 32 && n <= 126 ? String.fromCharCode(n) : '.').join(''));
  }
  return lines.join('\n');
}
/** Quoted separators, CRLF, embedded newlines, escaped quotes and empty cells. */
export function parseCsv(text: string, maxCells = 100_000): { rows: string[][]; truncated: boolean } {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, cells = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || field === '')) {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field); field = ''; cells++;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
      if (cells >= maxCells) { if (row.length) rows.push(row); return { rows, truncated: i < text.length - 1 }; }
    } else field += c;
  }
  if (field || row.length || (text.length > 0 && !/[\r\n]$/.test(text))) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}
