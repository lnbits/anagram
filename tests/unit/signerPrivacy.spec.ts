import { afterEach, expect, it, vi } from 'vitest';
import { nip59, nip19 } from 'nostr-tools';
import {
  ClientEvent,
  NostrPrivateKeySigner,
  NostrNip07Signer,
  NostrNip46Signer,
  NostrUser,
  giftUnwrap,
} from '#src/lib/nostr/client.ts';
import {
  profileSearchAllowed,
  searchRelayProfiles,
} from '#src/stores/nostr/profileSearchRuntime.ts';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['seal', 'rumor'])(
  'does not expose malformed decrypted %s contents in exceptions',
  async (stage) => {
    const sender = NostrPrivateKeySigner.generate(),
      recipient = NostrPrivateKeySigner.generate();
    const wrap = nip59.wrapEvent(
      { kind: 14, tags: [['p', recipient.pubkey]], content: 'message' },
      sender.secretKey,
      recipient.pubkey,
    );
    const original = recipient.decrypt.bind(recipient);
    const spy = vi.spyOn(recipient, 'decrypt');
    if (stage === 'rumor') spy.mockImplementationOnce(original);
    spy.mockResolvedValueOnce('{"private": "confidential fragment');
    await expect(
      giftUnwrap(new ClientEvent(undefined, wrap), undefined, recipient),
    ).rejects.toThrow('Invalid encrypted message payload');
  },
);

it.each(['encrypt', 'decrypt', 'sign'] as const)(
  'does not expose a NIP-07 %s error containing private input',
  async (operation) => {
    const key = NostrPrivateKeySigner.generate();
    const failure = () => {
      throw new Error(`private fragment ${key.privateKey} ${nip19.nsecEncode(key.secretKey)}`);
    };
    vi.stubGlobal('nostr', { signEvent: failure, nip44: { encrypt: failure, decrypt: failure } });
    const signer = new NostrNip07Signer();
    const result =
      operation === 'sign'
        ? signer.sign({
            kind: 14,
            pubkey: key.pubkey,
            tags: [],
            content: 'sensitive input',
            created_at: 1,
          })
        : signer[operation](new NostrUser({ pubkey: key.pubkey }), 'sensitive input');
    await expect(result).rejects.toThrow(
      operation === 'sign' ? 'Unable to sign event' : `Unable to ${operation} private content`,
    );
  },
);

it('incidental NIP-46 serialization never includes session secrets; explicit persistence still restores', () => {
  const signer = NostrNip46Signer.bunker(
    null as any,
    `bunker://${'a'.repeat(64)}?relay=wss://relay.test&secret=pairing-secret`,
  );
  signer.nostrConnectSecret = 'nostrconnect-secret';
  signer.nostrConnectUri = 'nostrconnect://client?secret=uri-secret';
  (signer as any).remote = { secretKey: [...signer.localSigner.secretKey] };
  const json = JSON.stringify(signer);
  for (const value of [
    signer.localSigner.privateKey,
    'pairing-secret',
    'nostrconnect-secret',
    'uri-secret',
  ])
    expect(json).not.toContain(value);
  expect(json).not.toContain('secretKey');
  const restored = NostrNip46Signer.fromPayload(signer.toPayload());
  expect(restored.localSigner.privateKey).toBe(signer.localSigner.privateKey);
  expect(restored.bunkerPubkey).toBe(signer.bunkerPubkey);
});

it('refuses private credentials in public profile discovery without subscribing or resolving NIP-05', async () => {
  const signer = NostrPrivateKeySigner.generate();
  const subscribe = vi.fn(),
    resolveNip05 = vi.fn();
  for (const query of [
    nip19.nsecEncode(signer.secretKey),
    'bunker://example?secret=secret',
    'nostrconnect://example?secret=secret',
  ]) {
    expect(
      await searchRelayProfiles({ subscribe } as any, query, ['wss://relay.test'], {
        signal: new AbortController().signal,
        onResults: vi.fn(),
        isBlocked: () => false,
        resolveNip05,
      }),
    ).toBe('invalid');
  }
  expect(profileSearchAllowed(signer.privateKey.toUpperCase(), [signer.privateKey])).toBe(false);
  expect(profileSearchAllowed(signer.pubkey, [signer.privateKey])).toBe(true);
  expect(subscribe).not.toHaveBeenCalled();
  expect(resolveNip05).not.toHaveBeenCalled();
});
