// GIFs (including single-frame files) need a static snapshot. WebP and PNG
// advertise animation before their image data, so static images avoid decoding.
export async function imageMayAnimate(blob: Blob): Promise<boolean> {
  const header = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const text = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (text(header, 0, 6) === 'GIF87a' || text(header, 0, 6) === 'GIF89a') return true;
  if (text(header, 0, 4) === 'RIFF' && text(header, 8, 4) === 'WEBP')
    return text(header, 12, 4) === 'VP8X' && !!(header[20] & 2);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) return false;
  let offset = 8;
  while (offset + 8 <= blob.size) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    const size = new DataView(chunk.buffer).getUint32(0);
    const type = text(chunk, 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND' || offset + 12 + size > blob.size) return false;
    offset += 12 + size;
  }
  return false;
}

const snapshots = new WeakMap<Blob, Promise<Blob>>();
export function staticImagePreview(blob: Blob): Promise<Blob> {
  const existing = snapshots.get(blob);
  if (existing) return existing;
  const snapshot = (async () => {
    if (!await imageMayAnimate(blob)) return blob;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw Error('Image preview unavailable');
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => {
        if (result) resolve(result);
        else reject(Error('Image preview unavailable'));
      }, 'image/png'));
    } finally { bitmap.close(); }
  })();
  snapshots.set(blob, snapshot);
  void snapshot.catch(() => snapshots.delete(blob));
  return snapshot;
}
