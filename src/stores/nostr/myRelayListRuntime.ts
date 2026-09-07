import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelayList,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
  type NDKUser,
} from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from 'src/stores/nostr/desiredSubscriptions';
import { createReadyRelaySet, fetchEventWithRelayTimeout } from 'src/stores/nostr/relayQueryUtils';
import type { AuthMethod, RelayListMetadataEntry } from 'src/stores/nostr/types';
import {
  contactRelayListsEqualValue,
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
} from 'src/stores/nostr/valueUtils';
import type { ContactRelay } from 'src/types/contact';

const DIRECT_MESSAGE_RECEIVE_RELAY_TAG = 'relay';

interface MyRelayListRuntimeDeps {
  beginStartupStep: (stepId: 'my-relay-list') => void;
  bumpContactListVersion: () => void;
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  completeStartupStep: (stepId: 'my-relay-list') => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  failStartupStep: (stepId: 'my-relay-list', error: unknown) => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  getRelaySnapshots: (relayUrls: string[]) => unknown[];
  getStoredAuthMethod: () => AuthMethod | null;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  ndk: NDK;
  queueTrackedContactSubscriptionsRefresh: (seedRelayUrls?: string[], force?: boolean) => void;
  relayEntriesFromRelayList: (relayList: NDKRelayList | null | undefined) => ContactRelay[];
  relaySignature: (relays: string[]) => string;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  subscribePrivateMessagesForLoggedInUser: (force?: boolean) => Promise<void>;
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

interface ApplyMyRelayListEntriesOptions {
  refreshSubscriptions?: boolean;
}

export function createMyRelayListRuntime({
  beginStartupStep,
  bumpContactListVersion,
  buildSubscriptionRelayDetails,
  completeStartupStep,
  ensureRelayConnections,
  failStartupStep,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  getStoredAuthMethod,
  logSubscription,
  ndk,
  queueTrackedContactSubscriptionsRefresh,
  relayEntriesFromRelayList,
  resolveLoggedInPublishRelayUrls,
  resolveLoggedInReadRelayUrls,
  subscribePrivateMessagesForLoggedInUser,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
}: MyRelayListRuntimeDeps) {
  let restoreMyRelayListPromise: Promise<void> | null = null;
  let myRelayListSubscription: ReturnType<NDK['subscribe']> | null = null;
  let myRelayListSubscriptionSignature = '';
  const desiredSubscriptions = createDesiredSubscriptions();
  let generation = 0;
  let myRelayListApplyQueue = Promise.resolve();
  let latestRelaySnapshot: { createdAt: number; id: string } | null = null;

  async function publishMyRelayList(
    relayEntries: RelayListMetadataEntry[],
    publishRelayUrls: string[] = []
  ): Promise<void> {
    const normalizedRelayEntries =
      inputSanitizerService.normalizeRelayListMetadataEntries(relayEntries);
    const directMessageReceiveRelayUrls = normalizedRelayEntries
      .filter((relay) => relay.read)
      .map((relay) => relay.url);
    const relayUrls = await resolveLoggedInPublishRelayUrls([
      ...publishRelayUrls,
      ...normalizedRelayEntries.map((relay) => relay.url),
    ]);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish relay list without at least one publish relay.');
    }

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();

    const relayListEvent = new NDKRelayList(ndk);
    relayListEvent.content = '';
    relayListEvent.tags = [];
    relayListEvent.bothRelayUrls = normalizedRelayEntries
      .filter((relay) => relay.read && relay.write)
      .map((relay) => relay.url);
    relayListEvent.readRelayUrls = normalizedRelayEntries
      .filter((relay) => relay.read && !relay.write)
      .map((relay) => relay.url);
    relayListEvent.writeRelayUrls = normalizedRelayEntries
      .filter((relay) => !relay.read && relay.write)
      .map((relay) => relay.url);

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    await relayListEvent.publishReplaceable(relaySet);
    updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);

    const directMessageRelayListEvent = new NDKEvent(ndk);
    directMessageRelayListEvent.kind = NDKKind.DirectMessageReceiveRelayList;
    directMessageRelayListEvent.content = '';
    directMessageRelayListEvent.tags = directMessageReceiveRelayUrls.map((relayUrl) => [
      DIRECT_MESSAGE_RECEIVE_RELAY_TAG,
      relayUrl,
    ]);

    await directMessageRelayListEvent.publishReplaceable(relaySet);
    updateStoredEventSinceFromCreatedAt(directMessageRelayListEvent.created_at);
  }

  async function updateLoggedInUserRelayList(
    relayEntries: RelayListMetadataEntry[],
    options: ApplyMyRelayListEntriesOptions = {}
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return;
    }

    const normalizedRelayEntries =
      inputSanitizerService.normalizeRelayListMetadataEntries(relayEntries);
    const shouldRefreshSubscriptions = options.refreshSubscriptions !== false;
    await contactsService.init();

    const existingContact = await contactsService.getContactByPublicKey(loggedInPubkeyHex);
    if (!existingContact) {
      await contactsService.createContact({
        public_key: loggedInPubkeyHex,
        name: loggedInPubkeyHex.slice(0, 16),
        given_name: null,
        meta: {},
        relays: normalizedRelayEntries,
      });
      bumpContactListVersion();
      if (shouldRefreshSubscriptions) {
        try {
          await subscribePrivateMessagesForLoggedInUser();
        } catch (error) {
          console.warn('Failed to subscribe to private messages', error);
        }
        queueTrackedContactSubscriptionsRefresh();
      }
      return;
    }

    if (
      contactRelayListsEqualValue(
        existingContact.meta?.general_relay_entries ?? existingContact.relays,
        normalizedRelayEntries
      )
    )
      return;

    await contactsService.updateContact(existingContact.id, {
      meta: { ...existingContact.meta, general_relay_entries: normalizedRelayEntries },
      relays: mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
        normalizedRelayEntries,
        existingContact.meta?.dm_receive_relay_entries ?? []
      ),
    });
    bumpContactListVersion();
    if (shouldRefreshSubscriptions) {
      await subscribePrivateMessagesForLoggedInUser();
      queueTrackedContactSubscriptionsRefresh();
    }
  }

  async function fetchMyRelayListEntries(
    seedRelayUrls: string[] = []
  ): Promise<ContactRelay[] | null> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex || !getStoredAuthMethod()) {
      return null;
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      return null;
    }

    await ensureRelayConnections(relayUrls);

    const user = await getLoggedInSignerUser();
    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const relayListEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NDKKind.RelayList],
        authors: [user.pubkey],
      },
      {
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet
    );
    if (!relayListEvent) {
      return null;
    }

    updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);

    const parsedRelayList = NDKRelayList.from(
      relayListEvent instanceof NDKEvent ? relayListEvent : new NDKEvent(ndk, relayListEvent)
    );

    return relayEntriesFromRelayList(parsedRelayList);
  }

  async function fetchMyRelayList(seedRelayUrls: string[] = []): Promise<string[]> {
    const relayEntries = await fetchMyRelayListEntries(seedRelayUrls);
    if (relayEntries === null) {
      return [];
    }

    return relayEntries.map((relay) => relay.url);
  }

  async function applyMyRelayListEntries(
    relayEntries: RelayListMetadataEntry[],
    options: ApplyMyRelayListEntriesOptions = {}
  ): Promise<void> {
    const normalizedRelayEntries =
      inputSanitizerService.normalizeRelayListMetadataEntries(relayEntries);
    const nip65RelayStore = useNip65RelayStore();
    nip65RelayStore.init();
    nip65RelayStore.replaceRelayEntries(normalizedRelayEntries);
    await updateLoggedInUserRelayList(normalizedRelayEntries, options);
  }

  async function restoreMyRelayList(seedRelayUrls: string[] = []): Promise<void> {
    if (restoreMyRelayListPromise) {
      return restoreMyRelayListPromise;
    }

    beginStartupStep('my-relay-list');
    restoreMyRelayListPromise = (async () => {
      try {
        await subscribeMyRelayListUpdates(seedRelayUrls);
        await desiredSubscriptions.waitForEose();
        completeStartupStep('my-relay-list');
      } catch (error) {
        failStartupStep('my-relay-list', error);
        throw error;
      }
    })().finally(() => {
      restoreMyRelayListPromise = null;
    });

    return restoreMyRelayListPromise;
  }

  function stopMyRelayListSubscription(reason = 'replace'): void {
    generation += 1;
    desiredSubscriptions.stop();
    if (myRelayListSubscription) {
      logSubscription('my-relay-list', 'stop', {
        reason,
        signature: myRelayListSubscriptionSignature || null,
      });
      myRelayListSubscription = null;
    }

    myRelayListSubscriptionSignature = '';
  }

  async function subscribeMyRelayListUpdates(
    seedRelayUrls: string[] = [],
    _force = false
  ): Promise<void> {
    const runGeneration = generation;
    const pubkey = getLoggedInPublicKeyHex();
    if (!pubkey) {
      desiredSubscriptions.stop();
      return;
    }
    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
    if (!relayUrls.length) {
      desiredSubscriptions.stop();
      return;
    }
    const filters: NDKFilter = { kinds: [NDKKind.RelayList], authors: [pubkey] };
    const signature = subscriptionSignature(filters, relayUrls);
    await desiredSubscriptions.reconcile([
      {
        key: 'my-relay-list',
        signature,
        prepare: async () => {
          await ensureRelayConnections(relayUrls);
          await getLoggedInSignerUser();
        },
        applied: () => myRelayListApplyQueue,
        start: (onEose, onClose) => {
          myRelayListSubscriptionSignature = signature;
          myRelayListSubscription = subscribeWithReqLogging(
            'my-relay-list',
            'my-relay-list',
            filters,
            {
              relaySet: NDKRelaySet.fromRelayUrls(relayUrls, ndk, false),
              cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
              onEvent: (event) => {
                if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
                const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
                updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
                myRelayListApplyQueue = myRelayListApplyQueue.then(async () => {
                  if (runGeneration !== generation) return;
                  const next = {
                    createdAt: wrappedEvent.created_at ?? 0,
                    id: wrappedEvent.id ?? '',
                  };
                  if (
                    latestRelaySnapshot &&
                    (latestRelaySnapshot.createdAt > next.createdAt ||
                      (latestRelaySnapshot.createdAt === next.createdAt &&
                        latestRelaySnapshot.id <= next.id))
                  )
                    return;
                  latestRelaySnapshot = next;
                  await applyMyRelayListEntries(
                    relayEntriesFromRelayList(NDKRelayList.from(wrappedEvent)),
                    { refreshSubscriptions: !restoreMyRelayListPromise }
                  );
                });
              },
              onEose,
              onClose,
            },
            { signature, ...buildSubscriptionRelayDetails(relayUrls) }
          );
          return myRelayListSubscription;
        },
      },
    ]);
  }

  function resetMyRelayListRuntimeState(reason = 'replace'): void {
    stopMyRelayListSubscription(reason);
    restoreMyRelayListPromise = null;
    myRelayListApplyQueue = Promise.resolve();
    latestRelaySnapshot = null;
  }

  return {
    applyMyRelayListEntries,
    fetchMyRelayList,
    fetchMyRelayListEntries,
    publishMyRelayList,
    resetMyRelayListRuntimeState,
    restoreMyRelayList,
    stopMyRelayListSubscription,
    subscribeMyRelayListUpdates,
    updateLoggedInUserRelayList,
  };
}
