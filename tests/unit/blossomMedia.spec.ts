import {
  blossomMediaExtensionFromUrl,
  blossomMediaSha256FromUrl,
  buildBlossomServingUrl,
  normalizeBlossomSha256,
} from '#src/utils/blossomMedia.ts';
import { describe, expect, it } from 'vitest';

const HASH = 'a1'.repeat(32);

describe('Blossom media addressing', () => {
  it('reads the hash out of a Blossom media URL, with or without an extension', () => {
    expect(blossomMediaSha256FromUrl(`https://blossom.example.com/${HASH}.png`)).toBe(HASH);
    expect(blossomMediaSha256FromUrl(`https://blossom.example.com/${HASH}`)).toBe(HASH);
    expect(blossomMediaSha256FromUrl(`https://blossom.example.com/a/b/${HASH}.jpg`)).toBe(HASH);
    expect(blossomMediaSha256FromUrl(`https://blossom.example.com/${HASH.toUpperCase()}.png`)).toBe(
      HASH,
    );
  });

  it('finds no hash in an ordinary link or a malformed one', () => {
    expect(blossomMediaSha256FromUrl('https://example.com/photo.png')).toBeNull();
    expect(
      blossomMediaSha256FromUrl('https://example.com/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.png'),
    ).toBeNull();
    expect(blossomMediaSha256FromUrl('not a url')).toBeNull();
    expect(blossomMediaSha256FromUrl(undefined)).toBeNull();
  });

  it('keeps the extension of the stored link and nothing else', () => {
    expect(blossomMediaExtensionFromUrl(`https://blossom.example.com/${HASH}.png`)).toBe('.png');
    expect(blossomMediaExtensionFromUrl(`https://blossom.example.com/${HASH}`)).toBe('');
    expect(blossomMediaExtensionFromUrl('https://blossom.example.com/photo.png')).toBe('');
  });

  it('builds a serving URL only from a valid server and hash', () => {
    expect(buildBlossomServingUrl('https://other.example.com/', HASH, '.png')).toBe(
      `https://other.example.com/${HASH}.png`,
    );
    expect(buildBlossomServingUrl('https://other.example.com', HASH)).toBe(
      `https://other.example.com/${HASH}`,
    );
    expect(buildBlossomServingUrl('http://insecure.example.com', HASH)).toBeNull();
    expect(buildBlossomServingUrl('https://other.example.com', 'nope')).toBeNull();
  });

  it('accepts only a 64-character hex hash', () => {
    expect(normalizeBlossomSha256(HASH)).toBe(HASH);
    expect(normalizeBlossomSha256(` ${HASH.toUpperCase()} `)).toBe(HASH);
    expect(normalizeBlossomSha256('a1'.repeat(31))).toBeNull();
    expect(normalizeBlossomSha256(42)).toBeNull();
  });
});
