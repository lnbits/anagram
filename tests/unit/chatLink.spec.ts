import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { chatLinkTarget } from '#src/utils/chatLink.ts';

describe('chat route identity', () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  it('normalizes public identities and preserves bounded profile relay hints', () => {
    for (const id of [pubkey, pubkey.toUpperCase(), nip19.npubEncode(pubkey)])
      expect(chatLinkTarget(`/chats/${id}/`)).toEqual({ pubkey, relays: [] });
    const relays = Array.from({ length: 10 }, (_, i) => `wss://relay${i}.example.org`);
    expect(chatLinkTarget(`/chats/${nip19.nprofileEncode({ pubkey, relays })}`)).toEqual({
      pubkey,
      relays: relays.slice(0, 8),
    });
  });
  it('rejects secrets, malformed identities and other application routes', () => {
    for (const path of [
      '/chats',
      '/chats/requests',
      '/chats/not-a-key',
      '/chats/%',
      `/chats/${pubkey}/extra`,
      `/contacts/${pubkey}`,
      `/public/${pubkey}`,
      `/chats/${nip19.nsecEncode(secret)}`,
      `/chats/${'a'.repeat(8192)}`,
    ])
      expect(chatLinkTarget(path)).toBeNull();
  });
});
