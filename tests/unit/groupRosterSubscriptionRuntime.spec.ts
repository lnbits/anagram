import NDK, { NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { createGroupRosterSubscriptionRuntime } from 'src/stores/nostr/groupRosterSubscriptionRuntime';
import { describe, expect, it, vi } from 'vitest';

describe('group roster subscriptions', () => {
  it('buckets authors, joins setup, restores old snapshots through EOSE and changes decryption without REQs', async () => {
    const a = 'a'.repeat(64),
      b = 'b'.repeat(64);
    let epoch = 'c'.repeat(64);
    const apply = vi.fn(async () => true);
    const ndk = new NDK();
    const stop = vi.fn();
    const subscribe = vi.fn((_label, _request, _filters, options) => {
      options.onEvent(
        new NDKEvent(ndk, {
          pubkey: _filters.authors[0],
          created_at: 1,
          id: _filters.authors[0],
          kind: NDKKind.FollowSet,
          content: 'ciphertext',
          tags: [['d', 'roster']],
        })
      );
      options.onEose();
      return { stop };
    });
    const fetchRoster = vi.fn();
    const runtime = createGroupRosterSubscriptionRuntime({
      ndk,
      getLoggedInPublicKeyHex: () => 'd'.repeat(64),
      getStoredAuthMethod: () => 'nsec',
      listGroupMembershipRosterSubscriptionContexts: async () => [
        { groupPublicKey: a, currentEpochPublicKey: epoch, relayUrls: ['wss://a.test/'] },
        { groupPublicKey: b, currentEpochPublicKey: 'e'.repeat(64), relayUrls: ['wss://b.test/'] },
      ],
      applyGroupMembershipRosterEvent: apply,
      ensureRelayConnections: vi.fn(async () => {}),
      restoreGroupMembershipRoster: fetchRoster,
      subscribeWithReqLogging: subscribe as never,
      getFilterSince: () => 99999999,
      buildSubscriptionEventDetails: () => ({}),
      buildSubscriptionRelayDetails: (relayUrls) => ({ relayUrls }),
      extractRelayUrlsFromEvent: () => [],
      formatSubscriptionLogValue: (value) => value ?? null,
      logSubscription: vi.fn(),
      relaySignature: (urls) => urls.join(','),
      updateStoredEventSinceFromCreatedAt: vi.fn(),
    });
    await Promise.all([
      runtime.subscribeGroupMembershipRosterUpdates(),
      runtime.subscribeGroupMembershipRosterUpdates(),
    ]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls.map((call) => call[2])).toEqual([
      { kinds: [NDKKind.FollowSet], authors: [a], '#d': ['roster'] },
      { kinds: [NDKKind.FollowSet], authors: [b], '#d': ['roster'] },
    ]);
    expect(apply).toHaveBeenCalledTimes(2);
    epoch = 'f'.repeat(64);
    await runtime.subscribeGroupMembershipRosterUpdates([], true);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(stop).not.toHaveBeenCalled();
    expect(fetchRoster).not.toHaveBeenCalled();
    runtime.resetGroupRosterSubscriptionRuntimeState();
  });
});
