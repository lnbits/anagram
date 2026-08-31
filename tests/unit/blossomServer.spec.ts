import {
  buildBlossomUploadAuthorization,
  buildBlossomUploadUrl,
  DEFAULT_BLOSSOM_SERVER_URL,
  getBlossomServerHost,
  normalizeBlossomServerUrl,
  requireBlossomServerUrl,
} from 'src/utils/blossomServer';
import { describe, expect, it } from 'vitest';

describe('Blossom server helpers', () => {
  it('normalizes HTTPS server origins', () => {
    expect(normalizeBlossomServerUrl(' HTTPS://Media.Example.com:443/ ')).toBe(
      'https://media.example.com'
    );
    expect(normalizeBlossomServerUrl('https://media.example.com:8443/')).toBe(
      'https://media.example.com:8443'
    );
    expect(normalizeBlossomServerUrl(DEFAULT_BLOSSOM_SERVER_URL)).toBe(DEFAULT_BLOSSOM_SERVER_URL);
  });

  it('rejects insecure URLs and values that are not server origins', () => {
    expect(normalizeBlossomServerUrl('http://media.example.com')).toBeNull();
    expect(normalizeBlossomServerUrl('https://media.example.com/upload')).toBeNull();
    expect(normalizeBlossomServerUrl('https://media.example.com?token=value')).toBeNull();
    expect(normalizeBlossomServerUrl('https://user@media.example.com')).toBeNull();
    expect(normalizeBlossomServerUrl('not a URL')).toBeNull();
    expect(() => requireBlossomServerUrl('ws://relay.example.com')).toThrow(
      'Enter a valid HTTPS Blossom server URL without a path.'
    );
  });

  it('builds the upload URL and server-scoped BUD-11 authorization fields', () => {
    const sha256 = 'A'.repeat(64);

    expect(buildBlossomUploadUrl('https://media.example.com/')).toBe(
      'https://media.example.com/upload'
    );
    expect(getBlossomServerHost('https://media.example.com:8443')).toBe('media.example.com:8443');
    expect(
      buildBlossomUploadAuthorization('https://media.example.com:8443', sha256, 1_000)
    ).toEqual({
      content: 'Authorize media upload to media.example.com:8443',
      tags: [
        ['t', 'upload'],
        ['expiration', '1900'],
        ['server', 'media.example.com:8443'],
        ['x', 'a'.repeat(64)],
      ],
    });
  });
});
