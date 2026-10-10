import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
const naddr = nip19.naddrEncode({
  kind: 34550,
  pubkey: 'a'.repeat(64),
  identifier: 'lounge',
  relays: ['wss://relay.example/'],
});

describe('public group message links', () => {
  it('opens direct and social-share invitations in this client, regardless of the pasted host', () => {
    for (const url of [
      `http://127.0.0.1:5173/public/${naddr}`,
      `https://anagram.chat/public/${naddr}`,
      `https://another-client.example/join/chat.html#/public/${naddr}`,
      `https://anagram.chat/join/chat#/public/${naddr}`,
    ])
      expect(publicGroupLinkTarget(url)).toBe(`/public/${naddr}`);
  });
  it('leaves malformed, unrelated, credential-bearing and wrong-kind links as ordinary links', () => {
    for (const url of [
      'https://example.org/',
      'http://127.0.0.1:5173/public/naddr1broken',
      `https://username:password@example.org/public/${naddr}`,
      `javascript:/public/${naddr}`,
      `https://example.org/other/${naddr}`,
      `https://example.org/public/${nip19.naddrEncode({ kind: 30023, pubkey: 'a'.repeat(64), identifier: 'article' })}`,
      `https://example.org/public/${'a'.repeat(8193)}`,
    ])
      expect(publicGroupLinkTarget(url)).toBeNull();
  });
});
