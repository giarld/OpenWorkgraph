import { translate } from "../i18n/translate";
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeBase64Url, encodeClientCode, parseClientCode, parsePairAuthorization, pairingProofMessage, normalizeShortPairingCode } from '../../../packages/protocol/src/pairing';

export interface PairingIdentity {
  clientCode: string;
  fingerprint: string;
  sign(authorization: string, serviceId: string, browserName: string): Promise<{ clientCode: string; proof: string }>;
  dispose(): void;
}
/** Per-page identity: never persisted to localStorage, URLs, logs, or a server.
 * HTTP is supported using bundled P-256 when subtle is unavailable. In both
 * paths entropy comes exclusively from crypto.getRandomValues. */
export async function createPairingIdentity(origin: string, cryptoProvider: Pick<Crypto, 'getRandomValues'> & { subtle?: SubtleCrypto } = globalThis.crypto): Promise<PairingIdentity> {
  if (!cryptoProvider?.getRandomValues) throw new Error(translate("The browser does not provide a secure random source, so a client code cannot be generated. Use a browser that supports cryptographic randomness."));
  let publicKey: Uint8Array;
  let sign: (message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
  let release = () => {};
  if (cryptoProvider.subtle) {
    const subtle = cryptoProvider.subtle;
    let pair: CryptoKeyPair | undefined = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    sign = async message => {
      if (!pair) throw new Error(translate("The client code is no longer valid. Generate a new one."));
      return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message));
    };
    release = () => { pair = undefined; };
  } else {
    const { p256 } = await import('@noble/curves/nist.js');
    const secret = new Uint8Array(32);
    // Uniform rejection sampling, never reduce random bytes modulo the order.
    do { cryptoProvider.getRandomValues(secret); } while (!p256.utils.isValidSecretKey(secret));
    publicKey = p256.getPublicKey(secret, false);
    sign = async message => p256.sign(message, secret, { prehash: true, lowS: true, format: 'compact' });
    release = () => { secret.fill(0); };
  }
  let disposed = false;
  try {
    const clientCode = encodeClientCode({ version: 1, origin, publicKey: encodeBase64Url(publicKey), nonce: encodeBase64Url(cryptoProvider.getRandomValues(new Uint8Array(32))) });
    parseClientCode(clientCode);
    const clientHash = bytesToHex(sha256(new TextEncoder().encode(clientCode)));
    return {
      clientCode, fingerprint: bytesToHex(sha256(publicKey)),
      async sign(authorization, serviceId, browserName) {
        if (disposed) throw new Error(translate("The client code is no longer valid. Generate a new one."));
        if (!normalizeShortPairingCode(authorization)) {
          const grant = parsePairAuthorization(authorization);
          if (grant.serviceId !== serviceId) throw new Error(translate("The authorization code belongs to another Workspace. Check the Workspace address."));
          if (grant.clientHash !== clientHash) throw new Error(translate("The authorization code does not match this page’s client code. Copy the client code again and authorize it."));
        }
        // Expiry is authoritative on the service, not the client's wall clock.
        const proof = encodeBase64Url(await sign(pairingProofMessage(serviceId, origin, authorization, clientCode, browserName)));
        if (disposed) throw new Error(translate("The client code is no longer valid. Generate a new one."));
        return { clientCode, proof };
      },
      dispose() { disposed = true; release(); },
    };
  } catch (error) { release(); throw error; }
}
