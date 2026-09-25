import { translate } from "../i18n/translate";
/** Browser File.type may be empty (notably Markdown and WAV on some systems). */
export function fileMime(file: { name: string; type: string }): string {
  if (/[.]svg$/i.test(file.name)) return 'image/svg+xml';
  if (file.type && file.type.toLowerCase() !== "application/octet-stream")
    return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
  };
  return types[extension] ?? "application/octet-stream";
}

/** Only MIME types with a supported plain-text representation are decoded on import. */
export function isTextMime(mimeType: string): boolean {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (!mime.startsWith("application/")) return false;
  const subtype = mime.slice("application/".length);
  return (
    ["json", "xml", "yaml", "x-yaml"].includes(subtype) ||
    subtype.endsWith("+json") ||
    subtype.endsWith("+xml")
  );
}

/** UI and editing commands share the same concrete content capability. */
export function hasTextContent(asset: { text?: string }): boolean {
  return typeof asset.text === "string";
}

export { WORKGRAPH_UPLOAD_MAX_BYTES as FILE_NODE_MAX_BYTES } from '@openworkgraph/protocol';
export const PROJECT_FILE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export function formatFileSize(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error(translate("File size must be a non-negative safe integer."));
  if (bytes < 1024) return `${bytes} byte`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  const divisor = unit === 'KB' ? 1024 : 1024 * 1024;
  return `${Number((bytes / divisor).toFixed(2))} ${unit}`;
}
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
