import { nip19 } from '#src/lib/nostr/client.ts';
import { expect, it } from 'vitest';
import { redactPublicLinks } from '#src/utils/publicMessage.ts';
it.each([
  ['visit https://example.org/page.', 'visit [link removed].'],
  ['WWW.example.org https://example.org/picture.png', '[link removed] [link removed]'],
  [
    '[site](https://example.org) and `http://example.org`',
    '[site]([link removed]) and `[link removed]`',
  ],
  ['normal text **bold** 😀', 'normal text **bold** 😀'],
])('redacts public URLs as inert text: %s', (text, expected) =>
  expect(redactPublicLinks(text)).toBe(expected),
);

it('removes bare and NIP-27 profile mentions from untrusted posts, including code and markup', () => {
  const npub = nip19.npubEncode('a'.repeat(64));
  const nprofile = nip19.nprofileEncode({ pubkey: 'b'.repeat(64) });
  expect(
    redactPublicLinks(`Hi ${npub}, **nostr:${nprofile}** and \`${npub}\` https://example.org`),
  ).toBe('Hi [profile removed], **[profile removed]** and `[profile removed]` [link removed]');
});
