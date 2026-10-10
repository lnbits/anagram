import { beforeEach, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { privateStorageRelayService as service } from '#src/services/privateStorageRelayService.ts';

beforeEach(async () => service.clearAllData());
function fixture(created_at = 100) {
  const key = generateSecretKey(),
    pubkey = getPublicKey(key);
  const signer = new NostrPrivateKeySigner(key);
  const event = finalizeEvent(
    {
      kind: 10013,
      created_at,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify([
          ['relay', 'wss://private.example'],
          ['relay', 'javascript:invalid'],
        ]),
        nip44.v2.utils.getConversationKey(key, pubkey),
      ),
    },
    key,
  );
  return { key, pubkey, signer, event };
}
it('restores an encrypted private-storage relay list from IndexedDB without persisting decrypted URLs', async () => {
  const { pubkey, signer, event } = fixture();
  expect(await service.apply(event, signer, () => true)).toBe(true);
  expect(service.urls(pubkey)).toEqual(['wss://private.example/']);
  service.reset();
  expect(service.urls(pubkey)).toEqual([]);
  await service.restore(signer, () => true);
  expect(service.urls(pubkey)).toEqual(['wss://private.example/']);
  const request = indexedDB.open('anagram-private-relays', 1);
  const stored = await new Promise<unknown>((resolve) => {
    request.onsuccess = () => {
      const row = request.result.transaction('events').objectStore('events').get(pubkey);
      row.onsuccess = () => {
        resolve(row.result);
        request.result.close();
      };
    };
  });
  expect(stored).toEqual(JSON.parse(JSON.stringify(event)));
  expect(JSON.stringify(stored)).not.toContain('private.example');
});
it('rejects other accounts, forged events and late decryptions after account switching', async () => {
  const { pubkey, signer, event } = fixture();
  const other = fixture();
  expect(await service.apply(event, other.signer, () => true)).toBe(false);
  expect(await service.apply({ ...event, content: 'forged' }, signer, () => true)).toBe(false);
  let active = true;
  const switched = {
    ...signer,
    pubkey: signer.pubkey,
    decrypt: async (...args: Parameters<typeof signer.decrypt>) => {
      const plaintext = await signer.decrypt(...args);
      active = false;
      return plaintext;
    },
  };
  await service.apply(event, switched as typeof signer, () => active);
  expect(service.urls(pubkey)).toEqual([]);
});
it('retains the latest valid list and accepts an explicit empty replacement', async () => {
  const { key, pubkey, signer, event } = fixture();
  await service.apply(event, signer, () => true);
  const cleared = finalizeEvent(
    {
      kind: 10013,
      created_at: 101,
      tags: [],
      content: nip44.v2.encrypt('[]', nip44.v2.utils.getConversationKey(key, pubkey)),
    },
    key,
  );
  await service.apply(cleared, signer, () => true);
  expect(await service.apply(event, signer, () => true)).toBe(false);
  expect(service.urls(pubkey)).toEqual([]);
});
