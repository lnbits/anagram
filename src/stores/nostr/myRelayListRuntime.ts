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
import type { AuthMethod, RelayListMetadataEntry } from 'src/stores/nostr/types';
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
  buildSubscriptionEventDetails,
  buildSubscriptionRelayDetails,
  completeStartupStep,
  ensureRelayConnections,
  extractRelayUrlsFromEvent,
  failStartupStep,
  formatSubscriptionLogValue,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  getRelaySnapshots,
  getStoredAuthMethod,
  logSubscription,
  ndk,
  queueTrackedContactSubscriptionsRefresh,
  relayEntriesFromRelayList,
  relaySignature,
  resolveLoggedInPublishRelayUrls,
  resolveLoggedInReadRelayUrls,
  subscribePrivateMessagesForLoggedInUser,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
}: MyRelayListRuntimeDeps) {
  let restoreMyRelayListPromise: Promise<void> | null = null;
  let myRelayListSubscription: ReturnType<NDK['subscribe']> | null = null;
  let myRelayListSubscriptionSignature = '';
  let myRelayListApplyQueue = Promise.resolve();

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
          await subscribePrivateMessagesForLoggedInUser(true);
        } catch (error) {
          console.warn('Failed to subscribe to private messages', error);
        }
        queueTrackedContactSubscriptionsRefresh();
      }
      return;
    }

    await contactsService.updateContact(existingContact.id, {
      relays: normalizedRelayEntries,
    });
    bumpContactListVersion();
    if (shouldRefreshSubscriptions) {
      await subscribePrivateMessagesForLoggedInUser(true);
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
    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const relayListEvent = await ndk.fetchEvent(
      {
        kinds: [NDKKind.RelayList],
        authors: [user.pubkey],
        since: getFilterSince(),
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
        const relayEntries = await fetchMyRelayListEntries(seedRelayUrls);
        if (relayEntries === null) {
          completeStartupStep('my-relay-list');
          return;
        }

        await applyMyRelayListEntries(relayEntries, { refreshSubscriptions: false });
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
    if (myRelayListSubscription) {
      logSubscription('my-relay-list', 'stop', {
        reason,
        signature: myRelayListSubscriptionSignature || null,
      });
      myRelayListSubscription.stop();
      myRelayListSubscription = null;
    }

    myRelayListSubscriptionSignature = '';
  }

  async function subscribeMyRelayListUpdates(
    seedRelayUrls: string[] = [],
    force = false
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      stopMyRelayListSubscription('missing-login');
      return;
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      stopMyRelayListSubscription('no-relays');
      return;
    }

    const signature = `${loggedInPubkeyHex}:${relaySignature(relayUrls)}`;
    if (!force && myRelayListSubscription && myRelayListSubscriptionSignature === signature) {
      logSubscription('my-relay-list', 'skip', {
        reason: 'already-active',
        signature,
        pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
        ...buildSubscriptionRelayDetails(relayUrls),
      });
      return;
    }

    logSubscription('my-relay-list', 'prepare', {
      force,
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      relaySnapshots: getRelaySnapshots(relayUrls),
    });

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();
    stopMyRelayListSubscription();

    logSubscription('my-relay-list', 'start', {
      force,
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      subscriptionTargetType: 'user',
      userTargetCount: 1,
      userTargetPubkeys: [formatSubscriptionLogValue(loggedInPubkeyHex)],
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      relaySnapshots: getRelaySnapshots(relayUrls),
    });

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const myRelayListFilters: NDKFilter = {
      kinds: [NDKKind.RelayList],
      authors: [loggedInPubkeyHex],
      since: getFilterSince(),
    };
    myRelayListSubscription = subscribeWithReqLogging(
      'my-relay-list',
      'my-relay-list',
      myRelayListFilters,
      {
        relaySet,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        onEvent: (event) => {
          const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
          logSubscription('my-relay-list', 'event', {
            signature,
            ...buildSubscriptionEventDetails(wrappedEvent),
            ...buildSubscriptionRelayDetails(extractRelayUrlsFromEvent(wrappedEvent)),
          });
          updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
          myRelayListApplyQueue = myRelayListApplyQueue
            .then(async () => {
              const relayList = NDKRelayList.from(wrappedEvent);
              await applyMyRelayListEntries(relayEntriesFromRelayList(relayList));
            })
            .catch((error) => {
              console.error('Failed to process my relay list event', error);
            });
        },
        onEose: () => {
          logSubscription('my-relay-list', 'eose', {
            signature,
          });
        },
      },
      {
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
      }
    );
    myRelayListSubscriptionSignature = signature;

    logSubscription('my-relay-list', 'active', {
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      ...buildSubscriptionRelayDetails(relayUrls),
      relaySnapshots: getRelaySnapshots(relayUrls),
    });
  }

  function resetMyRelayListRuntimeState(reason = 'replace'): void {
    stopMyRelayListSubscription(reason);
    restoreMyRelayListPromise = null;
    myRelayListApplyQueue = Promise.resolve();
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
