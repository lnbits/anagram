import { buildAvatarText } from '#src/utils/avatarText.ts';
import { formatCompactPublicKey } from '#src/utils/publicKeyText.ts';
import { buildRelayLookupKey, uniqueRelayUrls } from '#src/utils/relayUrls.ts';
import { describe, expect, it } from 'vitest';

describe('shared helper utils', () => {
  it('builds stable avatar text from names and compact identifiers', () => {
    expect(buildAvatarText('Alice Bob')).toBe('AB');
    expect(buildAvatarText(' alice ')).toBe('AL');
    expect(buildAvatarText('')).toBe('NA');
  });

  it('formats long public keys without changing shorter values', () => {
    expect(formatCompactPublicKey('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(formatCompactPublicKey('abcdefghijklmnopqrstuvwx')).toBe('abcdefgh...qrstuvwx');
  });

  it('normalizes relay lookup keys and preserves first unique relay entries', () => {
    expect(buildRelayLookupKey(' WSS://Relay.Example.com ')).toBe('wss://relay.example.com/');
    expect(
      uniqueRelayUrls([
        'wss://relay.example.com',
        'wss://relay.example.com/',
        'wss://other.example.com',
        '   ',
      ])
    ).toEqual(['wss://relay.example.com', 'wss://other.example.com']);
  });
});
