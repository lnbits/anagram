import {
  decryptMediaBytes,
  encryptMediaBytes,
  isValidMediaKeyHex,
  isValidMediaNonceHex,
  normalizeSha256Hex,
  sha256Hex,
  verifyAndDecryptMediaBytes,
} from '#src/utils/mediaCrypto.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DECRYPTION_FAILED = 'Encrypted media could not be decrypted.';
const HASH_MISMATCH = 'Encrypted media hash does not match the message.';

function plaintextBytes(text = 'a private photo'): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function flipByte(bytes: Uint8Array<ArrayBuffer>, index: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  copy[index] ^= 0x01;
  return copy;
}

describe('mediaCrypto', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips bytes through AES-256-GCM', async () => {
    const plaintext = plaintextBytes();
    const encrypted = await encryptMediaBytes(plaintext);

    await expect(
      decryptMediaBytes(encrypted.ciphertext, encrypted.key, encrypted.nonce)
    ).resolves.toEqual(plaintext);
  });

  it('produces ciphertext that differs from the plaintext and carries a 16-byte GCM tag', async () => {
    const plaintext = plaintextBytes('x'.repeat(64));
    const encrypted = await encryptMediaBytes(plaintext);

    expect(encrypted.ciphertext.byteLength).toBe(plaintext.byteLength + 16);
    expect(hex(encrypted.ciphertext)).not.toContain(hex(plaintext));
  });

  it('uses a 256-bit key and a 96-bit nonce encoded as lowercase hex', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    expect(encrypted.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(encrypted.nonce).toMatch(/^[a-f0-9]{24}$/u);
  });

  it('generates a fresh key and nonce for every encryption of the same bytes', async () => {
    const plaintext = plaintextBytes();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => encryptMediaBytes(plaintext))
    );

    expect(new Set(results.map((result) => result.key)).size).toBe(results.length);
    expect(new Set(results.map((result) => result.nonce)).size).toBe(results.length);
    expect(new Set(results.map((result) => hex(result.ciphertext))).size).toBe(results.length);
  });

  it('draws keys and nonces from crypto.getRandomValues', async () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

    await encryptMediaBytes(plaintextBytes());

    const requestedLengths = getRandomValues.mock.calls.map(
      ([array]) => (array as Uint8Array).length
    );
    expect(requestedLengths.sort()).toEqual([12, 32]);
  });

  it.each([
    ['tampered ciphertext', (bytes: Uint8Array<ArrayBuffer>) => flipByte(bytes, 0)],
    [
      'a tampered authentication tag',
      (bytes: Uint8Array<ArrayBuffer>) => flipByte(bytes, bytes.byteLength - 1),
    ],
    ['ciphertext shorter than the tag', (bytes: Uint8Array<ArrayBuffer>) => bytes.slice(0, 16)],
  ])('rejects %s', async (_label, mutate) => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(mutate(encrypted.ciphertext), encrypted.key, encrypted.nonce)
    ).rejects.toThrow(DECRYPTION_FAILED);
  });

  it('rejects an incorrect key or nonce', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const other = await encryptMediaBytes(plaintextBytes());

    await expect(
      decryptMediaBytes(encrypted.ciphertext, other.key, encrypted.nonce)
    ).rejects.toThrow(DECRYPTION_FAILED);
    await expect(
      decryptMediaBytes(encrypted.ciphertext, encrypted.key, other.nonce)
    ).rejects.toThrow(DECRYPTION_FAILED);
  });

  it('decrypts AES-GCM blobs that use 16-byte nonces from other clients', async () => {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const plaintext = plaintextBytes('from amethyst');
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
      'encrypt',
    ]);
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plaintext)
    );

    await expect(decryptMediaBytes(ciphertext, hex(key), hex(nonce))).resolves.toEqual(plaintext);
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'z'.repeat(64)],
    ['odd length', 'a'.repeat(63)],
    ['16 bytes', 'a'.repeat(32)],
    ['33 bytes', 'a'.repeat(66)],
    ['not a string', 42],
  ])('rejects a malformed key (%s) before decrypting', async (_label, value) => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    expect(isValidMediaKeyHex(value)).toBe(false);
    await expect(decryptMediaBytes(encrypted.ciphertext, value, encrypted.nonce)).rejects.toThrow(
      'Encrypted media key must be 32 hex-encoded bytes.'
    );
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'g'.repeat(24)],
    ['8 bytes', 'a'.repeat(16)],
    ['20 bytes', 'a'.repeat(40)],
    ['not a string', null],
  ])('rejects a malformed nonce (%s) before decrypting', async (_label, value) => {
    const encrypted = await encryptMediaBytes(plaintextBytes());

    expect(isValidMediaNonceHex(value)).toBe(false);
    await expect(decryptMediaBytes(encrypted.ciphertext, encrypted.key, value)).rejects.toThrow(
      'Encrypted media nonce must be 12 or 16 hex-encoded bytes.'
    );
  });

  it('accepts uppercase hex for keys and nonces', () => {
    expect(isValidMediaKeyHex('AB'.repeat(32))).toBe(true);
    expect(isValidMediaNonceHex('CD'.repeat(12))).toBe(true);
    expect(isValidMediaNonceHex('CD'.repeat(16))).toBe(true);
  });

  it('hashes with SHA-256 and normalizes hex digests', async () => {
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

    await expect(sha256Hex(plaintextBytes('hello'))).resolves.toBe(expected);
    expect(normalizeSha256Hex(` ${expected.toUpperCase()} `)).toBe(expected);
    expect(normalizeSha256Hex('not-a-hash')).toBeNull();
  });

  it('checks the ciphertext hash before attempting decryption', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const decryptSpy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');

    for (const sha256 of ['0'.repeat(64), 'not-a-hash', undefined]) {
      await expect(
        verifyAndDecryptMediaBytes(encrypted.ciphertext, {
          sha256,
          key: encrypted.key,
          nonce: encrypted.nonce,
        })
      ).rejects.toThrow(HASH_MISMATCH);
    }
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the hash matches but GCM authentication fails', async () => {
    const encrypted = await encryptMediaBytes(plaintextBytes());
    const tampered = flipByte(encrypted.ciphertext, 2);

    await expect(
      verifyAndDecryptMediaBytes(tampered, {
        sha256: await sha256Hex(tampered),
        key: encrypted.key,
        nonce: encrypted.nonce,
      })
    ).rejects.toThrow(DECRYPTION_FAILED);
  });
});
