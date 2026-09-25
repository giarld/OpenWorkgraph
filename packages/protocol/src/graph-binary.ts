import type { GraphBundle } from './index.js';
import { WORKGRAPH_TRANSFER_TOTAL_BYTES, WORKGRAPH_UPLOAD_MAX_BYTES } from './index.js';

/** HTTP representation: an 8-byte header, JSON metadata, then raw assets.
 * The user-facing ZIP archive format remains separate and unchanged. */
export const GRAPH_BINARY_MIME = 'application/vnd.openworkgraph.bundle+octet-stream';
export const GRAPH_METADATA_MAX_BYTES = 128 * 1024 * 1024;
const encoder = new TextEncoder();
function invalid(): never { throw new Error('Invalid or oversized Work Graph binary bundle'); }
export function base64Bytes(value: string): Uint8Array {
  const raw = atob(value);
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
  return result;
}
export function bytesBase64(value: Uint8Array): string {
  const parts: string[] = [];
  // Divisible by three: concatenation preserves base64 padding semantics.
  for (let i = 0; i < value.length; i += 49152)
    parts.push(btoa(String.fromCharCode(...value.subarray(i, i + 49152))));
  return parts.join('');
}
export function graphBinaryParts(bundle: GraphBundle, idempotencyKey?: string): Uint8Array[] {
  let total = 0;
  if (!Array.isArray(bundle.resources) || bundle.resources.length > 256) invalid();
  const resources = bundle.resources.map(({ base64: _base64, ...resource }) => {
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > WORKGRAPH_UPLOAD_MAX_BYTES) invalid();
    total += resource.bytes;
    if (total > WORKGRAPH_TRANSFER_TOTAL_BYTES) invalid();
    return resource;
  });
  const metadata = encoder.encode(JSON.stringify({ bundle: { ...bundle, resources }, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }));
  if (metadata.length > GRAPH_METADATA_MAX_BYTES || total + metadata.length > WORKGRAPH_TRANSFER_TOTAL_BYTES) invalid();
  const header = new Uint8Array(8);
  header.set([79, 87, 71, 66]); // OWGB
  new DataView(header.buffer).setUint32(4, metadata.length);
  return [header, metadata, ...bundle.resources.map(resource => {
    if (resource.base64.length !== Math.ceil(resource.bytes / 3) * 4) invalid();
    const bytes = base64Bytes(resource.base64);
    if (bytes.length !== resource.bytes) invalid();
    return bytes;
  })];
}
/** Bounded incremental reads avoid an aggregate JSON string or binary buffer. */
export async function readGraphBinary(source: AsyncIterable<Uint8Array>): Promise<{ bundle: GraphBundle; idempotencyKey?: string }> {
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(0), offset = 0, received = 0;
  async function next(): Promise<boolean> {
    const item = await iterator.next();
    if (item.done) return false;
    chunk = item.value; offset = 0; received += chunk.length;
    if (received > WORKGRAPH_TRANSFER_TOTAL_BYTES + 8) invalid();
    return true;
  }
  async function read(size: number): Promise<Uint8Array> {
    const result = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (offset === chunk.length) { if (!await next()) invalid(); continue; }
      const length = Math.min(size - filled, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + length), filled);
      filled += length; offset += length;
    }
    return result;
  }
  try {
    const header = await read(8);
    if (header[0] !== 79 || header[1] !== 87 || header[2] !== 71 || header[3] !== 66) invalid();
    const length = new DataView(header.buffer).getUint32(4);
    if (!length || length > GRAPH_METADATA_MAX_BYTES) invalid();
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(length))) as { bundle: GraphBundle; idempotencyKey?: string };
    if (!envelope || Object.keys(envelope).some(key => !['bundle', 'idempotencyKey'].includes(key)) || !envelope.bundle || !Array.isArray(envelope.bundle.resources) || envelope.bundle.resources.length > 256) invalid();
    let total = length;
    // Validate all lengths before allocating any asset buffers.
    for (const resource of envelope.bundle.resources) {
      if (!resource || Object.hasOwn(resource, 'base64') || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > WORKGRAPH_UPLOAD_MAX_BYTES) invalid();
      total += resource.bytes;
      if (total > WORKGRAPH_TRANSFER_TOTAL_BYTES) invalid();
    }
    for (const resource of envelope.bundle.resources) resource.base64 = bytesBase64(await read(resource.bytes));
    if (offset !== chunk.length) invalid();
    while (await next()) if (chunk.length) invalid();
    return envelope;
  } finally { await iterator.return?.(); }
}

/** Count JSON bytes without stringifying the aggregate bundle. */
export function jsonByteLength(value: unknown): number {
  if (value === null || typeof value !== 'object') return encoder.encode(JSON.stringify(value)).length;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce<number>((sum, item) => sum + jsonByteLength(item), 0);
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, item]) => sum + encoder.encode(JSON.stringify(key)).length + 1 + jsonByteLength(item), 0);
}
