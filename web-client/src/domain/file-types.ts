import { translate } from "../i18n/translate";
import { audioMimeByExtension } from './audio-formats';

const downloadExtensionByMime: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'text/csv': 'csv',
  'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'application/yaml': 'yaml', 'application/x-yaml': 'yaml', 'text/yaml': 'yaml', 'text/x-yaml': 'yaml',
  'text/javascript': 'js', 'application/javascript': 'js', 'text/css': 'css', 'text/x-python': 'py',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'weba', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** Titles can omit extensions. Preserve existing suffixes and only infer known types. */
export function fileDownloadName(name: string, ...mimeTypes: Array<string | undefined>): string {
  const safeName = name.replaceAll(/[\\/]/g, '_');
  if (safeName.lastIndexOf('.') > 0 && !safeName.endsWith('.')) return safeName;
  for (const mime of mimeTypes) {
    const type = (mime ?? '').split(';')[0].trim().toLowerCase();
    const extension = Object.hasOwn(downloadExtensionByMime, type) ? downloadExtensionByMime[type] : undefined;
    if (extension) return safeName.replace(/[.]+$/, '') + '.' + extension;
  }
  return safeName;
}

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
    ...audioMimeByExtension,
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

export { WORKGRAPH_UPLOAD_MAX_BYTES as FILE_NODE_MAX_BYTES } from '../../../packages/protocol/src/index';
export const PROJECT_FILE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export function formatFileSize(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error(translate("File size must be a non-negative safe integer."));
  if (bytes < 1024) return `${bytes} byte`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  const divisor = unit === 'KB' ? 1024 : 1024 * 1024;
  return `${Number((bytes / divisor).toFixed(2))} ${unit}`;
}
export { importedNodeType } from '../../../packages/protocol/src/node-import';
