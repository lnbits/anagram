import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
} from '@nostr-dev-kit/ndk';
import { GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG } from 'src/stores/nostr/constants';
import {
  bucketRelayTargets,
  createDesiredSubscriptions,
  subscriptionSignature,
} from 'src/stores/nostr/desiredSubscriptions';

interface GroupRosterSubscriptionRuntimeDeps {
  applyGroupMembershipRosterEvent: (
    event: NDKEvent,
    options?: {
      refreshMemberProfiles?: boolean;
      seedRelayUrls?: string[];
    }
  ) => Promise<boolean>;
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getStoredAuthMethod: () => string | null;
  listGroupMembershipRosterSubscriptionContexts: (seedRelayUrls?: string[]) => Promise<
    Array<{
      currentEpochPublicKey: string;
      groupPublicKey: string;
      relayUrls: string[];
    }>
  >;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  ndk: NDK;
  relaySignature: (relays: string[]) => string;
  restoreGroupMembershipRoster: (
    groupPublicKey: string,
    seedRelayUrls?: string[]
  ) => Promise<boolean>;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NDKFilter | NDKFilter[],
    options: NDKSubscriptionOptions & {
      onEvent?: (event: NDKEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>
  ) => ReturnType<NDK['subscribe']>;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
}

export function createGroupRosterSubscriptionRuntime({
  applyGroupMembershipRosterEvent,
  buildSubscriptionEventDetails,
  buildSubscriptionRelayDetails,
  ensureRelayConnections,
  extractRelayUrlsFromEvent,
  formatSubscriptionLogValue,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getStoredAuthMethod,
  listGroupMembershipRosterSubscriptionContexts,
  logSubscription,
  ndk,
  relaySignature,
  restoreGroupMembershipRoster,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
}: GroupRosterSubscriptionRuntimeDeps) {
  const subscriptions = createDesiredSubscriptions();
  let groupRosterApplyQueue = Promise.resolve();
  const latestEvents = new Map<string, NDKEvent>();
  const epochs = new Map<string, string>();

  function apply(event: NDKEvent, relayUrls: string[]): void {
    groupRosterApplyQueue = groupRosterApplyQueue
      .then(async () => {
        await applyGroupMembershipRosterEvent(event, {
          seedRelayUrls: relayUrls,
          refreshMemberProfiles: false,
        });
      })
      .catch((error) => console.warn('Failed to apply group roster', error));
  }

  async function subscribeGroupMembershipRosterUpdates(
    seedRelayUrls: string[] = [],
    _force = false
  ): Promise<void> {
    if (!getLoggedInPublicKeyHex() || !getStoredAuthMethod()) {
      subscriptions.stop();
      return;
    }
    const contexts = await listGroupMembershipRosterSubscriptionContexts(seedRelayUrls);
    for (const context of contexts) {
      if (epochs.get(context.groupPublicKey) !== context.currentEpochPublicKey) {
        epochs.set(context.groupPublicKey, context.currentEpochPublicKey);
        const event = latestEvents.get(context.groupPublicKey);
        if (event) apply(event, context.relayUrls);
      }
    }
    const buckets = bucketRelayTargets(
      contexts.map((context) => ({
        publicKey: context.groupPublicKey,
        relayUrls: context.relayUrls,
      }))
    );
    await subscriptions.reconcile(
      buckets.map(({ publicKeys, relayUrls }) => {
        const filters: NDKFilter = {
          kinds: [NDKKind.FollowSet],
          authors: publicKeys,
          '#d': [GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG],
        };
        const signature = subscriptionSignature(filters, relayUrls);
        return {
          key: relayUrls.join('|'),
          signature,
          prepare: () => ensureRelayConnections(relayUrls),
          applied: () => groupRosterApplyQueue,
          start: (onEose: () => void, onClose: () => void) =>
            subscribeWithReqLogging(
              'group-roster',
              'group-roster',
              filters,
              {
                relaySet: NDKRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                onEvent: (event) => {
                  const wrapped = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
                  const previous = latestEvents.get(wrapped.pubkey);
                  if (
                    previous &&
                    ((previous.created_at ?? 0) > (wrapped.created_at ?? 0) ||
                      (previous.created_at === wrapped.created_at && previous.id <= wrapped.id))
                  )
                    return;
                  latestEvents.set(wrapped.pubkey, wrapped);
                  updateStoredEventSinceFromCreatedAt(wrapped.created_at);
                  apply(wrapped, relayUrls);
                },
                onEose,
                onClose,
              },
              { signature, ...buildSubscriptionRelayDetails(relayUrls) }
            ),
        };
      })
    );
    await subscriptions.waitForEose();
  }

  function stopGroupRosterSubscription(_reason = 'replace'): void {
    subscriptions.stop();
  }
  function resetGroupRosterSubscriptionRuntimeState(reason = 'replace'): void {
    stopGroupRosterSubscription(reason);
    groupRosterApplyQueue = Promise.resolve();
    latestEvents.clear();
    epochs.clear();
  }
  return {
    resetGroupRosterSubscriptionRuntimeState,
    stopGroupRosterSubscription,
    subscribeGroupMembershipRosterUpdates,
  };
}
