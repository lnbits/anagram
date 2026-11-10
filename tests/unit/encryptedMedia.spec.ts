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
    ['video/quicktime', 'video', 20 * MIB],
    ['video/webm', 'video', 20 * MIB],
    ['audio/mpeg', 'audio', 20 * MIB],
    ['audio/mp4', 'audio', 20 * MIB],
    ['audio/aac', 'audio', 20 * MIB],
    ['audio/ogg', 'audio', 20 * MIB],
    ['audio/webm', 'audio', 20 * MIB],
    ['audio/wav', 'audio', 20 * MIB],
    ['audio/flac', 'audio', 20 * MIB],
  ])('resolves %s as %s with a %d byte limit', (mime, kind, maxBytes) => {
    expect(resolveEncryptedMediaKind(mime)).toEqual({ kind, maxBytes, canonicalMime: mime });
  });

  it('normalizes case, parameters and common aliases', () => {
    expect(resolveEncryptedMediaKind(' Video/WebM; codecs=vp9 ')?.canonicalMime).toBe('video/webm');
    expect(resolveEncryptedMediaKind('image/jpg')?.canonicalMime).toBe('image/jpeg');
    expect(resolveEncryptedMediaKind('audio/x-m4a')?.canonicalMime).toBe('audio/mp4');
    expect(resolveEncryptedMediaKind('audio/mp3')?.canonicalMime).toBe('audio/mpeg');
    expect(resolveEncryptedMediaKind('audio/x-wav')?.canonicalMime).toBe('audio/wav');
  });

  it.each([
    'video/x-matroska',
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

    expect(video && getMaxEncryptedBlobBytes(video)).toBe(20 * MIB + 16);
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
