import { validateVisualizeBridgeRequest } from './visualize-bridge.js';
import type { VisualizeBridgeRequest } from './visualize.js';
import { VisualizeValidationError } from './visualize-validation.js';

export const VISUALIZE_ASSET_MAX_BYTES = 300 * 1024 * 1024;
export const VISUALIZE_ASSET_BINARY_MIME = 'application/vnd.openworkgraph.visualize-asset';
export const VISUALIZE_ASSET_HEADER_MAX_BYTES = 65_536;
export function visualizeAssetHeader(request: VisualizeBridgeRequest): Uint8Array {
  const value = validateVisualizeBridgeRequest(request);
  if (value.method !== 'exportAsset') throw new VisualizeValidationError('INVALID_REQUEST', 'Expected asset export');
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (json.length > VISUALIZE_ASSET_HEADER_MAX_BYTES) throw new VisualizeValidationError('PAYLOAD_TOO_LARGE', 'Asset header is too large');
  const header = new Uint8Array(4 + json.length);
  new DataView(header.buffer).setUint32(0, json.length); header.set(json, 4); return header;
}
export function readVisualizeAssetBinary(value: Uint8Array): { request: Extract<VisualizeBridgeRequest, { method: 'exportAsset' }>; bytes: Uint8Array } {
  if (value.length < 4) throw new VisualizeValidationError('INVALID_REQUEST', 'Incomplete asset header');
  const size = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
  if (!size || size > VISUALIZE_ASSET_HEADER_MAX_BYTES || size + 4 > value.length) throw new VisualizeValidationError('INVALID_REQUEST', 'Invalid asset header');
  let request: VisualizeBridgeRequest;
  try { request = validateVisualizeBridgeRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(4, size + 4)))); }
  catch { throw new VisualizeValidationError('INVALID_REQUEST', 'Invalid asset export metadata'); }
  const bytes = value.subarray(size + 4);
  if (request.method !== 'exportAsset' || bytes.length !== request.params.bytes || bytes.length > VISUALIZE_ASSET_MAX_BYTES) throw new VisualizeValidationError('INVALID_REQUEST', 'Asset byte count does not match');
  return { request, bytes };
}
