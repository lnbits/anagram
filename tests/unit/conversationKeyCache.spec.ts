import { it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { ConversationKeyCache } from '#src/lib/nostr/conversationKeyCache.ts';
it('reuses inner keys, isolates recipient identities and wipes evicted secrets', () => {
  const cache = new ConversationKeyCache(1);
  const own = generateSecretKey(),
    other = generateSecretKey();
  const peer = getPublicKey(generateSecretKey()),
    peer2 = getPublicKey(generateSecretKey());
  const first = cache.get(own, peer);
  expect(cache.get(own.slice(), peer)).toBe(first);
  expect(first).toEqual(nip44.v2.utils.getConversationKey(own, peer));
  cache.get(own, peer2);
  expect(first.every((byte) => byte === 0)).toBe(true);
  const beforeSwitch = cache.get(own, peer);
  const afterSwitch = cache.get(other, peer);
  expect(beforeSwitch.every((byte) => byte === 0)).toBe(true);
  expect(afterSwitch).toEqual(nip44.v2.utils.getConversationKey(other, peer));
  cache.clear();
  expect(afterSwitch.every((byte) => byte === 0)).toBe(true);
});
