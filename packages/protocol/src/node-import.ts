const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const textTypes = new Set(['text/plain', 'text/markdown', 'application/json', 'application/xml', 'text/xml', 'text/yaml', 'text/x-yaml', 'application/yaml', 'application/x-yaml']);
const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml']);
/** SVG is an image; CSV and PDF are files even though CSV has textual contents. */
export function importedNodeType(name: string, mimeType: string): 'image' | 'text' | 'file' {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (extension === 'csv' || mime === 'text/csv') return 'file';
  if (extension === 'svg') return 'image';
  if (imageTypes.has(mime)) return 'image';
  if (textExtensions.has(extension) && textTypes.has(mime)) return 'text';
  return 'file';
}
