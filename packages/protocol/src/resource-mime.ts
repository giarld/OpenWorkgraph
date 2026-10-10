const sniffedMediaMimes = new Set(['image/png','image/jpeg','image/gif','image/webp','application/pdf','video/mp4','video/webm']);
const textResourceMimes = new Set(['text/plain','text/markdown','text/csv','application/json','application/xml','text/xml','text/yaml','text/x-yaml','application/yaml','application/x-yaml']);
/** Formats without a byte detector retain their declared MIME across storage and transfer. */
export function isOpaqueResourceMime(mime: string): boolean {
  return /^[a-zA-Z0-9.+-]+[/][a-zA-Z0-9.+-]+$/.test(mime) && mime !== 'application/octet-stream' && !textResourceMimes.has(mime) && !sniffedMediaMimes.has(mime);
}

/** Byte-based MIME detection shared by browser graph bundles and service storage. */
export function sniffResourceMime(bytes: Uint8Array): string {
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  const starts = (signature: number[]) => signature.every((value, i) => bytes[i] === value);
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  if (/^GIF8[79]a/.test(text(0,6))) return 'image/gif';
  if (text(0,4) === 'RIFF' && text(8,12) === 'WEBP') return 'image/webp';
  if (text(0,5) === '%PDF-') return 'application/pdf';
  if (text(4,8) === 'ftyp') return 'video/mp4';
  if (starts([26,69,223,163])) return 'video/webm';
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let printable = true;
    for (const char of content) { const n = char.charCodeAt(0); if (n < 32 && n !== 9 && n !== 10 && n !== 13) { printable = false; break; } }
    if (printable) return 'text/plain';
  } catch { /* Binary data has no text representation. */ }
  return 'application/octet-stream';
}
