import { createHash, createPublicKey, verify } from 'node:crypto';
import { decodeBase64Url, parseClientCode, pairingProofMessage } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export function clientCodeHash(code: string): string { return createHash('sha256').update(code).digest('hex'); }
export function inspectClientCode(code: string) {
  try {
    const client = parseClientCode(code);
    const raw = Buffer.from(decodeBase64Url(client.publicKey, 65));
    // OpenSSL validates that the exact uncompressed point is on P-256.
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
    return { client, key, fingerprint: createHash('sha256').update(raw).digest('hex'), clientHash: clientCodeHash(code) };
  } catch { throw new ServiceError('PAIRING_CODE_INVALID', 'The client code is invalid or unsupported. Copy it from the browser again.'); }
}
export function requirePairingProof(clientCode: string, proof: unknown, serviceId: string, origin: string, authorization: string, browserName: string): void {
  const { client, key } = inspectClientCode(clientCode);
  if (client.origin !== origin) throw new ServiceError('ORIGIN_DENIED', 'The client code does not belong to the current web origin.');
  try {
    const signature = decodeBase64Url(proof as string, 64);
    if (signature.length !== 64 || !verify('sha256', pairingProofMessage(serviceId, origin, authorization, clientCode, browserName), { key, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error();
  } catch { throw new ServiceError('PAIRING_CODE_INVALID', 'The client private-key proof is invalid. Pair from the original page that generated the client code.'); }
}
