import { describe, it, expect } from 'vitest';
import { nip59, verifyEvent, getEventHash } from 'nostr-tools';
import NostrClient, {
  ClientEvent,
  NostrRelayList,
  NostrPrivateKeySigner,
  NostrUser,
  giftWrap,
  giftUnwrap,
} from '#src/lib/nostr/client.ts';
describe('nostr-tools interoperability', () => {
  it.each([undefined, '', 'f'.repeat(64)])(
    'derives the authenticated rumor ID when the supplied ID is %s',
    async (id) => {
      const sender = NostrPrivateKeySigner.generate(),
        recipient = NostrPrivateKeySigner.generate();
      const rumor = {
        kind: 14,
        pubkey: sender.pubkey,
        created_at: 1234,
        content: 'Older incoming message',
        tags: [['p', recipient.pubkey]],
        ...(id === undefined ? {} : { id }),
      };
      const raw = nip59.createWrap(
        nip59.createSeal(rumor as any, sender.secretKey, recipient.pubkey),
        recipient.pubkey,
      );
      const decoded = await giftUnwrap(new ClientEvent(undefined, raw), undefined, recipient);
      expect(decoded.id).toBe(getEventHash(rumor));
      expect(decoded.pubkey).toBe(sender.pubkey);
      expect(decoded.content).toBe(rumor.content);
    },
  );
  it('rejects a correctly signed seal that claims another author inside its rumor', async () => {
    const sender = NostrPrivateKeySigner.generate(),
      recipient = NostrPrivateKeySigner.generate();
    const rumor = nip59.createRumor(
      { kind: 14, tags: [['p', recipient.pubkey]], content: 'Impersonation' },
      recipient.secretKey,
    );
    const raw = nip59.createWrap(
      nip59.createSeal(rumor, sender.secretKey, recipient.pubkey),
      recipient.pubkey,
    );
    await expect(giftUnwrap(new ClientEvent(undefined, raw), undefined, recipient)).rejects.toThrow(
      'Invalid rumor author',
    );
  });

  it('sends NIP-59 messages readable by an independent nostr-tools recipient', async () => {
    const sender = NostrPrivateKeySigner.generate(),
      recipient = NostrPrivateKeySigner.generate();
    const client = new NostrClient({ signer: sender });
    const event = new ClientEvent(client, {
      kind: 14,
      content: 'private payload',
      tags: [['p', recipient.pubkey]],
      pubkey: sender.pubkey,
    });
    const wrapped = await giftWrap(event, new NostrUser({ pubkey: recipient.pubkey }), sender);
    expect(verifyEvent(wrapped.rawEvent() as any)).toBe(true);
    const decoded = nip59.unwrapEvent(wrapped.rawEvent() as any, recipient.secretKey);
    expect(decoded.content).toBe('private payload');
    expect(decoded.pubkey).toBe(sender.pubkey);
  });
  it('receives an independent implementation and rejects tampering', async () => {
    const sender = NostrPrivateKeySigner.generate(),
      recipient = NostrPrivateKeySigner.generate();
    const raw = nip59.wrapEvent(
      { kind: 14, content: 'hello', tags: [['p', recipient.pubkey]] },
      sender.secretKey,
      recipient.pubkey,
    );
    const wrapped = new ClientEvent(undefined, raw);
    expect((await giftUnwrap(wrapped, undefined, recipient)).content).toBe('hello');
    wrapped.content += 'a';
    await expect(giftUnwrap(wrapped, undefined, recipient)).rejects.toThrow();
  });
  it('does not leak a private signature into an ordinary rumor', async () => {
    const sender = NostrPrivateKeySigner.generate(),
      recipient = NostrPrivateKeySigner.generate();
    const event = new ClientEvent(undefined, {
      kind: 14,
      pubkey: sender.pubkey,
      content: 'test',
      tags: [],
    });
    await event.sign(sender);
    const wrap = await giftWrap(event, new NostrUser({ pubkey: recipient.pubkey }), sender);
    const decoded = await giftUnwrap(wrap, undefined, recipient);
    expect(decoded.sig).toBeUndefined();
  });
});

describe('relay lists and secret serialization', () => {
  it('preserves both-use relays when assigning read and write lists', () => {
    const list = new NostrRelayList();
    list.bothRelayUrls = ['wss://both.example'];
    list.readRelayUrls = ['wss://read.example'];
    list.writeRelayUrls = ['wss://write.example'];
    expect(list.tags).toEqual([
      ['r', 'wss://both.example'],
      ['r', 'wss://read.example', 'read'],
      ['r', 'wss://write.example', 'write'],
    ]);
    list.bothRelayUrls = ['wss://new.example'];
    expect(list.relays).not.toContain('wss://both.example');
  });
  it('does not serialize private key material on the signer', () => {
    const signer = NostrPrivateKeySigner.generate();
    const encoded = JSON.stringify(signer);
    expect(encoded.includes(signer.privateKey)).toBe(false);
    expect(Object.keys(signer)).not.toContain('secretKey');
  });
});
