import {
  formatMediaByteSize,
  getMaxEncryptedBlobBytes,
  resolveEncryptedMediaKind,
} from '#src/utils/encryptedMedia.ts';
import { describe, expect, it } from 'vitest';

const MIB = 1024 * 1024;

describe('encrypted media kinds', () => {
  it.each([
    ['image/jpeg', 'image', 20 * MIB],
    ['image/png', 'image', 20 * MIB],
    ['image/gif', 'image', 20 * MIB],
    ['image/webp', 'image', 20 * MIB],
    ['image/avif', 'image', 20 * MIB],
    ['video/mp4', 'video', 20 * MIB],
    ['video/webm', 'video', 20 * MIB],
    ['audio/mpeg', 'audio', 10 * MIB],
    ['audio/mp4', 'audio', 10 * MIB],
    ['audio/aac', 'audio', 10 * MIB],
    ['audio/ogg', 'audio', 10 * MIB],
    ['audio/webm', 'audio', 10 * MIB],
    ['audio/wav', 'audio', 10 * MIB],
    ['audio/flac', 'audio', 10 * MIB],
  ])('resolves %s as %s with a %d byte limit', (mime, kind, maxBytes) => {
    expect(resolveEncryptedMediaKind(mime)).toEqual({ kind, maxBytes, canonicalMime: mime });
  });

  it('normalizes case, parameters and the image/jpg alias', () => {
    expect(resolveEncryptedMediaKind(' Video/WebM; codecs=vp9 ')?.canonicalMime).toBe('video/webm');
    expect(resolveEncryptedMediaKind('image/jpg')?.canonicalMime).toBe('image/jpeg');
  });

  it.each([
    'video/quicktime',
    'video/x-matroska',
    'audio/x-m4a',
    'image/svg+xml',
    'image/heic',
    'text/html',
    'application/octet-stream',
    '',
    'toString',
    '__proto__',
    undefined,
    42,
  ])('does not resolve %s', (mime) => {
    expect(resolveEncryptedMediaKind(mime)).toBeNull();
  });

  it('adds the AES-GCM tag to the receive limit', () => {
    const video = resolveEncryptedMediaKind('video/mp4');
    const audio = resolveEncryptedMediaKind('audio/mpeg');

    expect(video && getMaxEncryptedBlobBytes(video)).toBe(20 * MIB + 16);
    expect(audio && getMaxEncryptedBlobBytes(audio)).toBe(10 * MIB + 16);
  });
});

describe('formatMediaByteSize', () => {
  it('formats placeholder sizes and hides unknown ones', () => {
    expect(formatMediaByteSize(16_044)).toBe('16 KB');
    expect(formatMediaByteSize(300)).toBe('1 KB');
    expect(formatMediaByteSize(5 * 1024 * 1024 + 16)).toBe('5.0 MB');
    expect(formatMediaByteSize(0)).toBe('');
    expect(formatMediaByteSize(undefined)).toBe('');
    expect(formatMediaByteSize(Number.NaN)).toBe('');
  });
});
