import { ServiceError } from './errors.js';

const invalid = (message: string): never => { throw new ServiceError('INVALID_REQUEST', message); };
interface Chunk { kind: string; start: number; length: number }
function* chunks(bytes: Buffer, start: number, end: number): Generator<Chunk> {
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) invalid('Truncated WebP chunk header');
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, next = start + length + (length & 1);
    if (next > end) invalid('Truncated WebP chunk');
    if ((length & 1) && bytes[next - 1] !== 0) invalid('Invalid WebP chunk padding');
    yield { kind, start, length };
    offset = next;
  }
}
function dimensions(width: number, height: number): void {
  if (!width || !height || width * height > 40_000_000) invalid('WebP dimension limit');
}
function imageDimensions(bytes: Buffer, chunk: Chunk): { width: number; height: number } {
  const { kind, start, length } = chunk;
  let width: number, height: number;
  if (kind === 'VP8 ') {
    if (length <= 10 || (bytes[start]! & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) invalid('Invalid VP8 frame');
    width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff;
  } else {
    if (length <= 5 || bytes[start] !== 47) invalid('Invalid VP8L frame');
    const bits = bytes.readUInt32LE(start + 1);
    if (bits >>> 29) invalid('Unsupported VP8L version');
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  }
  dimensions(width, height);
  return { width, height };
}

/** Validate RIFF boundaries and static/animated image structure without decoding pixels. */
export function validatePublicationWebP(bytes: Buffer): void {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('Incomplete WebP');
  let extended = false, animated = false, animationHeader = false, image = false, alpha = false;
  let canvasWidth = 0, canvasHeight = 0, frames = 0, decoded = 0;
  for (const chunk of chunks(bytes, 12, bytes.length)) {
    const { kind, start, length } = chunk;
    if (kind === 'VP8X') {
      if (start !== 20 || length !== 10 || extended) invalid('Invalid WebP extended header');
      extended = true; animated = Boolean(bytes[start]! & 2);
      canvasWidth = bytes.readUIntLE(start + 4, 3) + 1; canvasHeight = bytes.readUIntLE(start + 7, 3) + 1;
      dimensions(canvasWidth, canvasHeight);
    } else if (kind === 'ANIM') {
      if (!animated || animationHeader || frames || image || length !== 6) invalid('Invalid WebP animation header');
      animationHeader = true;
    } else if (kind === 'ANMF') {
      if (!animationHeader || length < 16) invalid('Invalid WebP animation frame');
      const x = bytes.readUIntLE(start, 3) * 2, y = bytes.readUIntLE(start + 3, 3) * 2;
      const width = bytes.readUIntLE(start + 6, 3) + 1, height = bytes.readUIntLE(start + 9, 3) + 1;
      dimensions(width, height);
      if (x + width > canvasWidth || y + height > canvasHeight) invalid('WebP frame exceeds canvas');
      decoded += width * height * 4;
      if (++frames > 256 || decoded > 64 * 1024 * 1024) invalid('WebP animation frame limit');
      let frameImage = false, frameAlpha = false;
      for (const child of chunks(bytes, start + 16, start + length)) {
        if (child.kind === 'ALPH') {
          if (frameAlpha || frameImage || !child.length) invalid('Invalid WebP alpha chunk');
          frameAlpha = true;
        } else if (child.kind === 'VP8 ' || child.kind === 'VP8L') {
          if (frameImage || frameAlpha && child.kind === 'VP8L') invalid('Invalid WebP frame image');
          const actual = imageDimensions(bytes, child);
          if (actual.width !== width || actual.height !== height) invalid('WebP frame dimensions mismatch');
          frameImage = true;
        } else if (['VP8X', 'ANIM', 'ANMF'].includes(child.kind)) invalid('Invalid nested WebP animation');
      }
      if (!frameImage) invalid('WebP frame requires complete image data');
    } else if (kind === 'ALPH') {
      if (!extended || animated || alpha || image || !length) invalid('Invalid WebP alpha chunk');
      alpha = true;
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (animated || image || alpha && kind === 'VP8L') invalid('Invalid WebP image');
      const actual = imageDimensions(bytes, chunk);
      if (extended && (actual.width !== canvasWidth || actual.height !== canvasHeight)) invalid('WebP image dimensions mismatch');
      image = true;
    }
  }
  if (animated ? !animationHeader || !frames : !image) invalid('WebP requires complete image data');
}
