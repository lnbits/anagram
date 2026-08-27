import { createAndroidNotificationWatchPlan } from 'src/services/androidRelayNotificationService';
import { describe, expect, it } from 'vitest';

const OWNER_PUBKEY = '11'.repeat(32);
const GROUP_EPOCH_PUBKEY = '22'.repeat(32);

describe('androidRelayNotificationService', () => {
  it('builds a normalized, keyless watch plan from readable relays and recipient pubkeys', () => {
    const watchPlan = createAndroidNotificationWatchPlan({
      ownerPubkey: OWNER_PUBKEY.toUpperCase(),
      relayEntries: [
        { url: ' wss://relay.example ', read: true, write: true },
        { url: 'wss://relay.example/', read: true, write: false },
        { url: 'ws://localhost:8080/nostr', read: true, write: false },
        { url: 'wss://write-only.example', read: false, write: true },
        { url: 'https://not-a-relay.example', read: true, write: true },
      ],
      watchedPubkeys: [GROUP_EPOCH_PUBKEY.toUpperCase(), GROUP_EPOCH_PUBKEY, 'invalid'],
    });

    expect(watchPlan).toEqual({
      relays: ['ws://localhost:8080/nostr/', 'wss://relay.example/'],
      recipientPubkeys: [OWNER_PUBKEY, GROUP_EPOCH_PUBKEY],
    });
    expect(Object.keys(watchPlan)).toEqual(['relays', 'recipientPubkeys']);
  });

  it('rejects a watch plan without a valid owner public key', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: 'invalid',
        relayEntries: [{ url: 'wss://relay.example', read: true, write: true }],
        watchedPubkeys: [],
      })
    ).toThrow('logged-in public key');
  });

  it('rejects a watch plan without a readable websocket relay', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: OWNER_PUBKEY,
        relayEntries: [
          { url: 'wss://write-only.example', read: false, write: true },
          { url: 'https://not-a-relay.example', read: true, write: true },
        ],
        watchedPubkeys: [],
      })
    ).toThrow('readable relay');
  });
});
