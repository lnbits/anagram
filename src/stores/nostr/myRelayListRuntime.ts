import { privateStorageRelayService } from '#src/services/privateStorageRelayService.ts';
import type { Event } from 'nostr-tools';
import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelayList,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrSubscriptionOptions,
  type NostrUser,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { useNip65RelayStore } from '#src/stores/nip65RelayStore.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import {
  createReadyRelaySet,
  fetchEventWithRelayTimeout,
} from '#src/stores/nostr/relayQueryUtils.ts';
import type { AuthMethod, RelayListMetadataEntry } from '#src/stores/nostr/types.ts';
import {
  contactRelayListsEqualValue,
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from '#src/stores/nostr/valueUtils.ts';
import type { ContactRelay } from '#src/types/contact.ts';

const DIRECT_MESSAGE_RECEIVE_RELAY_TAG = 'relay';

interface MyRelayListRuntimeDeps {
  beginStartupStep: (stepId: 'my-relay-list') => void;
  bumpContactListVersion: () => void;
  buildSubscriptionEventDetails: (
    event: Pick<ClientEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>,
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  completeStartupStep: (stepId: 'my-relay-list') => void;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: ClientEvent) => string[];
  failStartupStep: (stepId: 'my-relay-list', error: unknown) => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NostrUser>;
  getRelaySnapshots: (relayUrls: string[]) => unknown[];
  getStoredAuthMethod: () => AuthMethod | null;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  ndk: NostrClient;
  queueTrackedContactSubscriptionsRefresh: (seedRelayUrls?: string[], force?: boolean) => void;
  relayEntriesFromRelayList: (relayList: NostrRelayList | null | undefined) => ContactRelay[];
  relaySignature: (relays: string[]) => string;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  subscribePrivateMessagesForLoggedInUser: (force?: boolean) => Promise<void>;
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
  let myRelayListSubscription: ReturnType<NostrClient['subscribe']> | null = null;
  let myRelayListSubscriptionSignature = '';
  const desiredSubscriptions = createDesiredSubscriptions();
  let generation = 0;
  let myRelayListApplyQueue = Promise.resolve();
  let privateRelayRestore:
    { owner: string; generation: number; promise: Promise<void> } | undefined;
  const latestRelaySnapshots = new Map<number, { createdAt: number; id: string }>();

  function applyOwnPrivateRelayList(event: ClientEvent): Promise<void> {
    const owner = getLoggedInPublicKeyHex(),
      runGeneration = generation;
    if (!owner || event.pubkey !== owner || event.kind !== NostrKind.PrivateStorageRelayList)
      return Promise.resolve();
    const current = () => generation === runGeneration && getLoggedInPublicKeyHex() === owner;
    // Share the application queue with the public relay lists. A malformed list
    // must not poison later list updates or interrupt message hydration.
    myRelayListApplyQueue = myRelayListApplyQueue
      .catch(() => {})
      .then(async () => {
        if (!current()) return;
        await getLoggedInSignerUser();
        if (!current() || !ndk.signer) return;
        const changed = await privateStorageRelayService.apply(
          event.rawEvent() as Event,
          ndk.signer,
          current,
        );
        if (changed && current()) {
          bumpContactListVersion();
          await subscribePrivateMessagesForLoggedInUser();
        }
      })
      .catch(() => {
        /* Keep the last usable private relay list; retry on discovery. */
      });
    return myRelayListApplyQueue;
  }

  async function publishMyRelayList(
    relayEntries: RelayListMetadataEntry[],
    publishRelayUrls: string[] = [],
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

    const relayListEvent = new NostrRelayList(ndk);
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

    const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
    await relayListEvent.publishReplaceable(relaySet);
    updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);

    const directMessageRelayListEvent = new ClientEvent(ndk);
    directMessageRelayListEvent.kind = NostrKind.DirectMessageReceiveRelayList;
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
    options: ApplyMyRelayListEntriesOptions = {},
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
        normalizedRelayEntries,
      )
    )
      return;

    await contactsService.updateContact(existingContact.id, {
      metaBase: existingContact.meta,
      meta: { ...existingContact.meta, general_relay_entries: normalizedRelayEntries },
      relays: mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
        normalizedRelayEntries,
        existingContact.meta?.dm_receive_relay_entries ?? [],
      ),
    });
    bumpContactListVersion();
    if (shouldRefreshSubscriptions) {
      await subscribePrivateMessagesForLoggedInUser();
      queueTrackedContactSubscriptionsRefresh();
    }
  }

  async function fetchMyRelayListEntries(
    seedRelayUrls: string[] = [],
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
        kinds: [NostrKind.RelayList],
        authors: [user.pubkey],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet,
    );
    if (!relayListEvent) {
      return null;
    }

    updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);

    const parsedRelayList = NostrRelayList.from(
      relayListEvent instanceof ClientEvent ? relayListEvent : new ClientEvent(ndk, relayListEvent),
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
    options: ApplyMyRelayListEntriesOptions = {},
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

  // Inbox discoveries from indexers and live account subscriptions share one
  // ordered application queue, so stale snapshots cannot race newer routes.
  function applyOwnRelayList(wrappedEvent: ClientEvent): Promise<void> {
    const pubkey = getLoggedInPublicKeyHex(),
      runGeneration = generation;
    if (
      !pubkey ||
      wrappedEvent.pubkey !== pubkey ||
      (wrappedEvent.kind !== NostrKind.RelayList &&
        wrappedEvent.kind !== NostrKind.DirectMessageReceiveRelayList)
    )
      return Promise.resolve();
    updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
    myRelayListApplyQueue = myRelayListApplyQueue
      .catch(() => {})
      .then(async () => {
        if (runGeneration !== generation) return;
        const next = {
          createdAt: wrappedEvent.created_at ?? 0,
          id: wrappedEvent.id ?? '',
        };
        const latestRelaySnapshot = latestRelaySnapshots.get(wrappedEvent.kind);
        if (
          latestRelaySnapshot &&
          (latestRelaySnapshot.createdAt > next.createdAt ||
            (latestRelaySnapshot.createdAt === next.createdAt && latestRelaySnapshot.id <= next.id))
        )
          return;
        if (wrappedEvent.kind === NostrKind.DirectMessageReceiveRelayList) {
          await contactsService.init();
          let contact = await contactsService.getContactByPublicKey(pubkey);
          if (!contact) {
            await updateLoggedInUserRelayList([], { refreshSubscriptions: false });
            contact = await contactsService.getContactByPublicKey(pubkey);
          }
          if (!contact) throw new Error('Unable to restore account DM relays');
          if ((contact.meta.dm_receive_relay_event_created_at ?? 0) > next.createdAt) return;
          const general = contact.meta.general_relay_entries ?? contact.relays;
          const dm = relayEntriesFromDirectMessageReceiveRelayEventValue(wrappedEvent);
          await contactsService.updateContact(contact.id, {
            metaBase: contact.meta,
            meta: {
              ...contact.meta,
              general_relay_entries: general,
              dm_receive_relay_entries: dm,
              dm_receive_relay_event_created_at: next.createdAt,
            },
            relays: mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(general, dm),
          });
          bumpContactListVersion();
          if (!restoreMyRelayListPromise) await subscribePrivateMessagesForLoggedInUser();
          if (runGeneration === generation) latestRelaySnapshots.set(wrappedEvent.kind, next);
          return;
        }
        await applyMyRelayListEntries(
          relayEntriesFromRelayList(NostrRelayList.from(wrappedEvent)),
          { refreshSubscriptions: !restoreMyRelayListPromise },
        );
        if (runGeneration === generation) latestRelaySnapshots.set(wrappedEvent.kind, next);
      })
      .catch(() => {
        // A failed write must not poison all later inbox lists, or mark
        // this snapshot applied before it can be retried.
      });
    return myRelayListApplyQueue;
  }

  async function subscribeMyRelayListUpdates(
    seedRelayUrls: string[] = [],
    _force = false,
  ): Promise<void> {
    const runGeneration = generation;
    const pubkey = getLoggedInPublicKeyHex();
    if (!pubkey) {
      desiredSubscriptions.stop();
      return;
    }
    // Fast startup skips the full relay-list restore, but must still restore
    // encrypted backup routes before opening the personal DM subscriptions.
    if (privateRelayRestore?.owner !== pubkey || privateRelayRestore.generation !== runGeneration) {
      const current = () => generation === runGeneration && getLoggedInPublicKeyHex() === pubkey;
      privateRelayRestore = {
        owner: pubkey,
        generation: runGeneration,
        promise: (async () => {
          await getLoggedInSignerUser();
          if (current() && ndk.signer)
            await privateStorageRelayService.restore(ndk.signer, current);
        })().catch(() => {}),
      };
    }
    await privateRelayRestore.promise;
    if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
    if (!relayUrls.length) {
      desiredSubscriptions.stop();
      return;
    }
    const filters: NostrFilter[] = [
      NostrKind.RelayList,
      NostrKind.DirectMessageReceiveRelayList,
      NostrKind.PrivateStorageRelayList,
    ].map((kind) => ({ kinds: [kind], authors: [pubkey], limit: 1 }));
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
              relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
              cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
              onEvent: (event) => {
                if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
                const wrappedEvent =
                  event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                if (wrappedEvent.kind === NostrKind.PrivateStorageRelayList) {
                  void applyOwnPrivateRelayList(wrappedEvent);
                  return;
                }
                void applyOwnRelayList(wrappedEvent);
              },
              onEose,
              onClose,
            },
            { signature, ...buildSubscriptionRelayDetails(relayUrls) },
          );
          return myRelayListSubscription;
        },
      },
    ]);
  }

  function resetMyRelayListRuntimeState(reason = 'replace'): void {
    stopMyRelayListSubscription(reason);
    privateStorageRelayService.reset();
    privateRelayRestore = undefined;
    restoreMyRelayListPromise = null;
    myRelayListApplyQueue = Promise.resolve();
    latestRelaySnapshots.clear();
  }

  return {
    applyOwnPrivateRelayList,
    applyOwnRelayList,
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
