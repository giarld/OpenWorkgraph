import { translate } from "../i18n/translate";
/** UUID v4 on HTTP too: randomUUID is secure-context-only, getRandomValues is not. */
export function randomId(source: Pick<Crypto, 'getRandomValues'> & { randomUUID?: Crypto['randomUUID'] } = globalThis.crypto): string {
  if (source?.randomUUID) return source.randomUUID();
  if (!source?.getRandomValues) throw new Error(translate("The browser does not provide a cryptographically secure random source."));
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
