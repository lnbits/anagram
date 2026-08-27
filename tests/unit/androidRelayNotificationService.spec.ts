import {
  createAndroidNotificationWatchPlan,
  readAndroidRelayConversationDetailsPreference,
} from 'src/services/androidRelayNotificationService';
import { describe, expect, it } from 'vitest';

const OWNER_PUBKEY = '11'.repeat(32);
const GROUP_EPOCH_PUBKEY = '22'.repeat(32);

describe('androidRelayNotificationService', () => {
  it('builds a normalized watch plan from private-message relays and recipient pubkeys', () => {
    const watchPlan = createAndroidNotificationWatchPlan({
      ownerPubkey: OWNER_PUBKEY.toUpperCase(),
      relayUrls: [
        ' wss://relay.example ',
        'wss://relay.example/',
        'ws://localhost:8080/nostr',
        'wss://group-relay.example',
        'https://not-a-relay.example',
      ],
      watchedPubkeys: [GROUP_EPOCH_PUBKEY.toUpperCase(), GROUP_EPOCH_PUBKEY, 'invalid'],
    });

    expect(watchPlan).toEqual({
      ownerPubkey: OWNER_PUBKEY,
      relays: ['ws://localhost:8080/nostr/', 'wss://group-relay.example/', 'wss://relay.example/'],
      recipientPubkeys: [OWNER_PUBKEY, GROUP_EPOCH_PUBKEY],
    });
    expect(Object.keys(watchPlan)).toEqual(['ownerPubkey', 'relays', 'recipientPubkeys']);
  });

  it('enables per-conversation details by default', () => {
    expect(readAndroidRelayConversationDetailsPreference()).toBe(true);
  });

  it('rejects a watch plan without a valid owner public key', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: 'invalid',
        relayUrls: ['wss://relay.example'],
        watchedPubkeys: [],
      })
    ).toThrow('logged-in public key');
  });

  it('rejects a watch plan without a readable websocket relay', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: OWNER_PUBKEY,
        relayUrls: ['https://not-a-relay.example'],
        watchedPubkeys: [],
      })
    ).toThrow('readable relay');
  });
});
