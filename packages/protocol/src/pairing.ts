/** Versioned, bounded pairing envelopes. These are encodings, not encryption.
 * Algorithms are fixed per version; never accept an algorithm from the caller. */
export const CLIENT_CODE_PREFIX = 'wgpc1_';
export const PAIR_AUTHORIZATION_PREFIX = 'wgpa1_';
/** Human-entered codes accept optional whitespace or a separator between groups. */
export function normalizeShortPairingCode(value: string): string | undefined {
  const compact = value.trim().replace(/[\s-]/g, '');
  return /^\d{8}$/.test(compact) ? compact : undefined;
}
/** Display/copy exactly eight digits; separators are accepted only on input. */
export function formatShortPairingCode(value: string): string {
  const code = normalizeShortPairingCode(value);
  if (!code) throw new Error('短码必须为 8 位数字');
  return code;
}
export interface PairingClient { version: 1; origin: string; publicKey: string; nonce: string }
export interface PairingAuthorization { version: 1; serviceId: string; code: string; clientHash: string; expiresAt: number }
export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeBase64Url(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('无效的配对编码');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (bytes.length > maxBytes || encodeBase64Url(bytes) !== value) throw new Error('无效的配对编码');
  return bytes;
}
function encode(prefix: string, value: unknown): string { return prefix + encodeBase64Url(new TextEncoder().encode(JSON.stringify(value))); }
function decode(prefix: string, code: string): Record<string, unknown> {
  if (typeof code !== 'string' || !code.startsWith(prefix)) throw new Error('配对码版本不支持');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(code.slice(prefix.length), 2048)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的配对码');
  return value as Record<string, unknown>;
}
export function encodeClientCode(value: PairingClient): string {
  return encode(CLIENT_CODE_PREFIX, { version: value.version, origin: value.origin, publicKey: value.publicKey, nonce: value.nonce });
}
export function parseClientCode(code: string): PairingClient {
  const value = decode(CLIENT_CODE_PREFIX, code);
  if (value.version !== 1 || typeof value.origin !== 'string' || value.origin.length > 512 || typeof value.publicKey !== 'string' || typeof value.nonce !== 'string') throw new Error('无效的客户端码');
  const origin = new URL(value.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.origin || origin.hostname.includes('*')) throw new Error('客户端码来源无效');
  const key = decodeBase64Url(value.publicKey, 65);
  if (key.length !== 65 || key[0] !== 4 || decodeBase64Url(value.nonce, 32).length !== 32) throw new Error('客户端公钥或挑战无效');
  const result: PairingClient = { version: 1, origin: value.origin, publicKey: value.publicKey, nonce: value.nonce };
  if (encodeClientCode(result) !== code) throw new Error('客户端码字段或格式无效');
  return result;
}
export function encodePairAuthorization(value: PairingAuthorization): string {
  return encode(PAIR_AUTHORIZATION_PREFIX, { version: value.version, serviceId: value.serviceId, code: value.code, clientHash: value.clientHash, expiresAt: value.expiresAt });
}
export function parsePairAuthorization(code: string): PairingAuthorization {
  const value = decode(PAIR_AUTHORIZATION_PREFIX, code);
  if (value.version !== 1 || typeof value.serviceId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.serviceId) || typeof value.code !== 'string' || !/^[A-F0-9]{32}$/.test(value.code) || typeof value.clientHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.clientHash) || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error('无效的配对授权码');
  const result = value as unknown as PairingAuthorization;
  if (encodePairAuthorization(result) !== code) throw new Error('授权码字段或格式无效');
  return result;
}
/** UTF-8 JSON array gives unambiguous domain-separated signing bytes. */
export function pairingProofMessage(serviceId: string, origin: string, authorization: string, clientCode: string, browserName: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['openworkgraph:pair:v1', serviceId, origin, authorization, clientCode, browserName.trim()]));
}
