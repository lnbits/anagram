import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelaySet,
  type NostrSubscriptionOptions,
  NostrSubscriptionCacheUsage,
  type NostrUser,
} from '#src/lib/nostr/client.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import { blossomServerUrlsFromTagsValue } from '#src/utils/blossomServerList.ts';

const BLOSSOM_SERVER_LIST_SUBSCRIPTION_KEY = 'my-blossom-server-list';

interface BlossomServerListRuntimeDeps {
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NostrUser>;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  ndk: NostrClient;
  // Called when the applied list changes, so reactive surfaces can re-read it.
  onBlossomServerListApplied?: (serverUrls: string[]) => void;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NostrFilter | NostrFilter[],
    options: NostrSubscriptionOptions & {
      onEvent?: (event: ClientEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>,
  ) => ReturnType<NostrClient['subscribe']>;
}

/**
 * Reads the logged-in user's published Blossom server list (kind 10063, BUD-03).
 *
 * The list is a replaceable event, so only the newest snapshot is kept and the cache is
 * dropped as soon as the logged-in account changes - a list fetched for one account must
 * never decide where another account uploads. Nothing is persisted: uploads fall back to
 * the app's own setting and default until the relays answer.
 */
export function createBlossomServerListRuntime({
  buildSubscriptionRelayDetails,
  ensureRelayConnections,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  logSubscription,
  ndk,
  onBlossomServerListApplied,
  resolveLoggedInReadRelayUrls,
  subscribeWithReqLogging,
}: BlossomServerListRuntimeDeps) {
  let subscription: ReturnType<NostrClient['subscribe']> | null = null;
  let appliedSubscriptionSignature = '';
  let generation = 0;
  let owner = '';
  let serverUrls: string[] = [];
  let appliedCreatedAt: number | null = null;
  let applyQueue = Promise.resolve();
  const desiredSubscriptions = createDesiredSubscriptions();

  function getBlossomServerUrls(): string[] {
    // Own only: after a logout or account switch the cached list belongs to nobody.
    if (!owner || getLoggedInPublicKeyHex() !== owner) {
      return [];
    }

    return serverUrls;
  }

  function isCurrent(runOwner: string, runGeneration: number): boolean {
    return runGeneration === generation && getLoggedInPublicKeyHex() === runOwner;
  }

  function applyBlossomServerListEvent(event: ClientEvent): Promise<void> {
    const runOwner = getLoggedInPublicKeyHex(),
      runGeneration = generation;
    if (!runOwner || event.pubkey !== runOwner || event.kind !== NostrKind.BlossomServerList) {
      return Promise.resolve();
    }

    const nextCreatedAt = Number(event.created_at ?? 0);
    applyQueue = applyQueue
      .catch(() => {
        // A failed snapshot must not poison the ones after it.
      })
      .then(() => {
        if (!isCurrent(runOwner, runGeneration)) return;
        // The list is replaceable, so a strictly older snapshot never wins. Two lists can
        // share a second - a replacement published twice in quick succession - and there
        // the arriving one is the newer of the two.
        if (appliedCreatedAt !== null && appliedCreatedAt > nextCreatedAt) {
          return;
        }

        const nextServerUrls = blossomServerUrlsFromTagsValue(event.tags);
        const changed =
          nextServerUrls.length !== serverUrls.length ||
          nextServerUrls.some((serverUrl, index) => serverUrl !== serverUrls[index]);
        owner = runOwner;
        serverUrls = nextServerUrls;
        appliedCreatedAt = nextCreatedAt;
        logSubscription('my-blossom-server-list', 'apply', {
          createdAt: nextCreatedAt,
          serverCount: nextServerUrls.length,
        });
        if (changed) {
          onBlossomServerListApplied?.(nextServerUrls);
        }
      });

    return applyQueue;
  }

  async function subscribeMyBlossomServerListUpdates(
    seedRelayUrls: string[] = [],
    force = false,
  ): Promise<void> {
    const runGeneration = generation;
    const runOwner = getLoggedInPublicKeyHex();
    if (!runOwner) {
      desiredSubscriptions.stop();
      return;
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (runGeneration !== generation || runOwner !== getLoggedInPublicKeyHex()) return;
    if (!relayUrls.length) {
      desiredSubscriptions.stop();
      return;
    }

    const filters: NostrFilter[] = [
      { kinds: [NostrKind.BlossomServerList], authors: [runOwner], limit: 1 },
    ];
    const signature = subscriptionSignature(filters, relayUrls);
    await desiredSubscriptions.reconcile(
      [
        {
          key: BLOSSOM_SERVER_LIST_SUBSCRIPTION_KEY,
          signature,
          prepare: async () => {
            await ensureRelayConnections(relayUrls);
            await getLoggedInSignerUser();
          },
          applied: () => applyQueue,
          start: (onEose, onClose) => {
            appliedSubscriptionSignature = signature;
            subscription = subscribeWithReqLogging(
              'my-blossom-server-list',
              'my-blossom-server-list',
              filters,
              {
                relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
                onEvent: (event) => {
                  if (runGeneration !== generation || runOwner !== getLoggedInPublicKeyHex())
                    return;
                  void applyBlossomServerListEvent(
                    event instanceof ClientEvent ? event : new ClientEvent(ndk, event),
                  );
                },
                onEose,
                onClose,
              },
              { signature, ...buildSubscriptionRelayDetails(relayUrls) },
            );
            return subscription;
          },
        },
      ],
      force,
    );
  }

  function resetBlossomServerListRuntimeState(reason = 'replace'): void {
    generation += 1;
    desiredSubscriptions.stop();
    if (subscription) {
      logSubscription('my-blossom-server-list', 'stop', {
        reason,
        signature: appliedSubscriptionSignature || null,
      });
      subscription = null;
    }

    appliedSubscriptionSignature = '';
    owner = '';
    serverUrls = [];
    appliedCreatedAt = null;
    applyQueue = Promise.resolve();
  }

  return {
    applyBlossomServerListEvent,
    getBlossomServerUrls,
    resetBlossomServerListRuntimeState,
    subscribeMyBlossomServerListUpdates,
  };
}
