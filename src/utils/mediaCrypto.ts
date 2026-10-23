// Client-side encryption for NIP-17 kind 15 file messages.
// Blobs are encrypted with AES-256-GCM before upload; the key and nonce only travel inside the
// gift-wrapped rumor, never to the media server.

import { bytesToHex, hexToBytes as decodeHex } from '@noble/hashes/utils.js';

export const MEDIA_ENCRYPTION_ALGORITHM = 'aes-gcm';
const MEDIA_KEY_BYTES = 32;
const MEDIA_NONCE_BYTES = 12;
// Amethyst generates 16-byte nonces; WebCrypto accepts both lengths for AES-GCM.
const ACCEPTED_MEDIA_NONCE_BYTES = [12, 16];
const AES_GCM_TAG_BITS = 128;

// Strict hex decoding that fails closed: anything that is not even-length hex yields null.
function hexToBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return new Uint8Array(decodeHex(value.trim()));
  } catch {
    return null;
  }
}

export function normalizeSha256Hex(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

export function isValidMediaKeyHex(value: unknown): boolean {
  return hexToBytes(value)?.length === MEDIA_KEY_BYTES;
}

export function isValidMediaNonceHex(value: unknown): boolean {
  const length = hexToBytes(value)?.length;
  return typeof length === 'number' && ACCEPTED_MEDIA_NONCE_BYTES.includes(length);
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

function importAesGcmKey(
  keyBytes: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'decrypt'
): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage]);
}

// Every call generates a new key and nonce, so a key+nonce pair never encrypts two plaintexts.
export async function encryptMediaBytes(
  plaintext: Uint8Array<ArrayBuffer>
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; key: string; nonce: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(MEDIA_KEY_BYTES));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(MEDIA_NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBytes, tagLength: AES_GCM_TAG_BITS },
    await importAesGcmKey(keyBytes, 'encrypt'),
    plaintext
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    key: bytesToHex(keyBytes),
    nonce: bytesToHex(nonceBytes),
  };
}

export async function decryptMediaBytes(
  ciphertext: Uint8Array<ArrayBuffer>,
  keyHex: unknown,
  nonceHex: unknown
): Promise<Uint8Array<ArrayBuffer>> {
  const keyBytes = hexToBytes(keyHex);
  const nonceBytes = hexToBytes(nonceHex);
  if (!keyBytes || keyBytes.length !== MEDIA_KEY_BYTES) {
    throw new Error('Encrypted media key must be 32 hex-encoded bytes.');
  }
  if (!nonceBytes || !ACCEPTED_MEDIA_NONCE_BYTES.includes(nonceBytes.length)) {
    throw new Error('Encrypted media nonce must be 12 or 16 hex-encoded bytes.');
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonceBytes, tagLength: AES_GCM_TAG_BITS },
      await importAesGcmKey(keyBytes, 'decrypt'),
      ciphertext
    );
    return new Uint8Array(plaintext);
  } catch {
    // Covers GCM authentication failures: tampered bytes, wrong key, or wrong nonce.
    throw new Error('Encrypted media could not be decrypted.');
  }
}

// Verifies the ciphertext hash from the message before any decryption is attempted.
export async function verifyAndDecryptMediaBytes(
  ciphertext: Uint8Array<ArrayBuffer>,
  input: { sha256: unknown; key: unknown; nonce: unknown }
): Promise<Uint8Array<ArrayBuffer>> {
  const expectedSha256 = normalizeSha256Hex(input.sha256);
  if (!expectedSha256 || (await sha256Hex(ciphertext)) !== expectedSha256) {
    throw new Error('Encrypted media hash does not match the message.');
  }

  return decryptMediaBytes(ciphertext, input.key, input.nonce);
}
