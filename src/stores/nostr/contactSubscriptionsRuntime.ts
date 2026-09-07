import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelayList,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
  type NDKUser,
  type NDKUserProfile,
} from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  bucketRelayTargets,
  createDesiredSubscriptions,
  subscriptionSignature,
} from 'src/stores/nostr/desiredSubscriptions';
import {
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from 'src/stores/nostr/valueUtils';
import type { ContactMetadata, ContactRecord, ContactRelay } from 'src/types/contact';

interface ContactSubscriptionsRuntimeDeps {
  applyContactProfileEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState: {
      createdAt: number;
      eventId: string;
    }
  ) => ContactMetadata;
  applyContactRelayListEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState: {
      createdAt: number;
      eventId: string;
    }
  ) => ContactMetadata;
  buildContactProfileEventState: (event: Pick<NDKEvent, 'created_at' | 'id'>) => {
    createdAt: number;
    eventId: string;
  };
  buildContactRelayListEventState: (event: Pick<NDKEvent, 'created_at' | 'id'>) => {
    createdAt: number;
    eventId: string;
  };
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  buildTrackedContactSubscriptionTargetDetails: (
    contactPubkeys: string[]
  ) => Promise<Record<string, unknown>>;
  buildUpdatedContactMeta: (
    existingMeta: ContactMetadata | undefined,
    profile: NDKUserProfile | null,
    resolvedNpub: string | null,
    resolvedNprofile: string | null
  ) => ContactMetadata;
  bumpContactListVersion: () => void;
  chatStore: {
    syncContactProfile: (pubkeyHex: string) => Promise<void>;
  };
  contactMetadataEqual: (
    first: ContactMetadata | undefined,
    second: ContactMetadata | undefined
  ) => boolean;
  contactRelayListsEqual: (
    first: ContactRelay[] | undefined,
    second: ContactRelay[] | undefined
  ) => boolean;
  encodeNprofile: (pubkeyHex: string) => string | null;
  encodeNpub: (pubkeyHex: string) => string | null;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  isPubkeyBlocked: (pubkeyHex: string) => boolean;
  listTrackedContactPubkeys: () => Promise<string[]>;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  markContactProfileEventApplied: (
    pubkeyHex: string,
    eventState: { createdAt: number; eventId: string }
  ) => void;
  markContactRelayListEventApplied: (
    pubkeyHex: string,
    eventState: { createdAt: number; eventId: string }
  ) => void;
  ndk: NDK;
  parseContactProfileEvent: (event: Pick<NDKEvent, 'content'>) => NDKUserProfile | null;
  pruneTrackedContactProfileEventState: (activePubkeys: string[]) => void;
  pruneTrackedContactRelayListEventState: (activePubkeys: string[]) => void;
  relayEntriesFromRelayList: (relayList: NDKRelayList | null | undefined) => ContactRelay[];
  relaySignature: (relays: string[]) => string;
  resolveTrackedContactReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  shouldApplyContactProfileEvent: (
    event: Pick<NDKEvent, 'created_at' | 'id' | 'pubkey'>
  ) => boolean;
  shouldApplyContactRelayListEvent: (
    event: Pick<NDKEvent, 'created_at' | 'id' | 'pubkey'>
  ) => boolean;
  shouldPreserveExistingGroupRelays: (
    contact: Pick<ContactRecord, 'type' | 'public_key' | 'relays'> | null | undefined,
    nextRelayEntries: ContactRelay[] | undefined
  ) => boolean;
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

export function createContactSubscriptionsRuntime({
  applyContactProfileEventStateToMeta,
  applyContactRelayListEventStateToMeta,
  buildContactProfileEventState,
  buildContactRelayListEventState,
  buildSubscriptionEventDetails,
  buildSubscriptionRelayDetails,
  buildTrackedContactSubscriptionTargetDetails,
  buildUpdatedContactMeta,
  bumpContactListVersion,
  chatStore,
  contactMetadataEqual,
  contactRelayListsEqual,
  encodeNprofile,
  encodeNpub,
  ensureRelayConnections,
  extractRelayUrlsFromEvent,
  formatSubscriptionLogValue,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  isPubkeyBlocked,
  listTrackedContactPubkeys,
  logSubscription,
  markContactProfileEventApplied,
  markContactRelayListEventApplied,
  ndk,
  parseContactProfileEvent,
  pruneTrackedContactProfileEventState,
  pruneTrackedContactRelayListEventState,
  relayEntriesFromRelayList,
  relaySignature,
  resolveTrackedContactReadRelayUrls,
  shouldApplyContactProfileEvent,
  shouldApplyContactRelayListEvent,
  shouldPreserveExistingGroupRelays,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
}: ContactSubscriptionsRuntimeDeps) {
  const subscriptions = createDesiredSubscriptions();
  let contactProfileApplyQueue = Promise.resolve();
  let contactRelayListApplyQueue = Promise.resolve();
  const relayEvents = new Map<string, Map<number, NDKEvent>>();

  async function applyContactProfileEvent(event: NDKEvent): Promise<void> {
    if (!shouldApplyContactProfileEvent(event)) {
      return;
    }

    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey) {
      return;
    }

    if (isPubkeyBlocked(normalizedPubkey)) {
      return;
    }

    const nextProfile = parseContactProfileEvent(event);
    if (!nextProfile) {
      return;
    }

    const nextEventState = buildContactProfileEventState(event);
    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (!existingContact) {
      if (normalizedPubkey === getLoggedInPublicKeyHex()) {
        await contactsService.createContact({
          public_key: normalizedPubkey,
          name: nextProfile.displayName || nextProfile.name || normalizedPubkey.slice(0, 16),
          meta: buildUpdatedContactMeta(
            {},
            nextProfile,
            encodeNpub(normalizedPubkey),
            encodeNprofile(normalizedPubkey)
          ),
        });
      }
      markContactProfileEventApplied(normalizedPubkey, nextEventState);
      return;
    }
    if (existingContact.meta.blocked === true) {
      return;
    }

    const nextMeta = buildUpdatedContactMeta(
      existingContact.meta,
      nextProfile,
      existingContact.meta.npub?.trim() || encodeNpub(normalizedPubkey) || '',
      existingContact.meta.nprofile?.trim() || encodeNprofile(normalizedPubkey) || ''
    );
    const persistedMeta = applyContactProfileEventStateToMeta(nextMeta, nextEventState);
    const nextName =
      nextMeta.display_name?.trim() ||
      nextMeta.name?.trim() ||
      existingContact.name?.trim() ||
      normalizedPubkey.slice(0, 16);

    if (
      existingContact.name === nextName &&
      contactMetadataEqual(existingContact.meta, nextMeta) &&
      contactMetadataEqual(existingContact.meta, persistedMeta)
    ) {
      markContactProfileEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      name: nextName,
      ...(nextMeta.group === true ? { type: 'group' as const } : {}),
      meta: persistedMeta,
    });
    if (!updatedContact) {
      return;
    }

    await chatStore.syncContactProfile(normalizedPubkey);
    markContactProfileEventApplied(normalizedPubkey, nextEventState);
    if (
      existingContact.name !== nextName ||
      !contactMetadataEqual(existingContact.meta, nextMeta)
    ) {
      bumpContactListVersion();
    }
  }

  function queueContactProfileEventApplication(event: NDKEvent): void {
    contactProfileApplyQueue = contactRelayListApplyQueue
      .then(() => applyContactProfileEvent(event))
      .catch((error) => {
        console.error('Failed to process contact profile event', error);
      });
    contactRelayListApplyQueue = contactProfileApplyQueue;
  }

  async function applyContactRelayListEvent(event: NDKEvent): Promise<void> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || isPubkeyBlocked(normalizedPubkey)) return;
    const byKind = relayEvents.get(normalizedPubkey) ?? new Map<number, NDKEvent>();
    const kind = event.kind ?? NDKKind.RelayList;
    const previous = byKind.get(kind);
    if (
      previous &&
      ((previous.created_at ?? 0) > (event.created_at ?? 0) ||
        (previous.created_at === event.created_at && previous.id <= event.id))
    )
      return;
    byKind.set(kind, event);
    relayEvents.set(normalizedPubkey, byKind);
    const relayListEvent = byKind.get(NDKKind.RelayList);
    const dmRelayEvent = byKind.get(NDKKind.DirectMessageReceiveRelayList);
    const nextEventState = buildContactRelayListEventState(event);
    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (!existingContact) {
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }
    if (existingContact.meta.blocked === true) {
      return;
    }

    const persistedMeta = applyContactRelayListEventStateToMeta(
      existingContact.meta,
      nextEventState
    );
    const generalEntries = relayListEvent
      ? relayEntriesFromRelayList(NDKRelayList.from(relayListEvent))
      : (existingContact.meta.general_relay_entries ?? existingContact.relays ?? []);
    const dmEntries = dmRelayEvent
      ? relayEntriesFromDirectMessageReceiveRelayEventValue(dmRelayEvent)
      : (existingContact.meta.dm_receive_relay_entries ?? []);
    persistedMeta.general_relay_entries = generalEntries;
    persistedMeta.dm_receive_relay_entries = dmEntries;
    const nextRelayEntries = mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
      generalEntries,
      dmEntries
    );

    if (shouldPreserveExistingGroupRelays(existingContact, nextRelayEntries)) {
      console.warn('Ignoring empty group relay list event to preserve stored relays', {
        pubkey: normalizedPubkey,
        eventId: event.id ?? null,
        existingRelayCount: existingContact.relays.length,
      });
      if (!contactMetadataEqual(existingContact.meta, persistedMeta)) {
        const updatedContact = await contactsService.updateContact(existingContact.id, {
          meta: persistedMeta,
        });
        if (!updatedContact) {
          return;
        }
      }
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    if (
      contactRelayListsEqual(existingContact.relays, nextRelayEntries) &&
      contactMetadataEqual(existingContact.meta, persistedMeta)
    ) {
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      meta: persistedMeta,
      relays: nextRelayEntries,
    });
    if (!updatedContact) {
      return;
    }

    markContactRelayListEventApplied(normalizedPubkey, nextEventState);
    if (!contactRelayListsEqual(existingContact.relays, nextRelayEntries)) {
      bumpContactListVersion();
    }
  }

  function queueContactRelayListEventApplication(event: NDKEvent): void {
    contactRelayListApplyQueue = contactRelayListApplyQueue
      .then(() => applyContactRelayListEvent(event))
      .catch((error) => {
        console.error('Failed to process contact relay list event', error);
      });
  }

  async function subscribeContactProfileUpdates(
    seedRelayUrls: string[] = [],
    _force = false
  ): Promise<void> {
    const self = getLoggedInPublicKeyHex();
    if (!self) {
      subscriptions.stop();
      return;
    }
    const fallback = await resolveTrackedContactReadRelayUrls(seedRelayUrls);
    const pubkeys = [...new Set([self, ...(await listTrackedContactPubkeys())])].sort();
    pruneTrackedContactProfileEventState(pubkeys);
    pruneTrackedContactRelayListEventState(pubkeys);
    const contacts = await contactsService.listContacts();
    const buckets = bucketRelayTargets(
      pubkeys.map((publicKey) => ({
        publicKey,
        relayUrls: inputSanitizerService.normalizeReadableRelayUrls(
          contacts.find((contact) => contact.public_key === publicKey)?.relays
        ),
      })),
      fallback
    );
    await subscriptions.reconcile(
      buckets.map(({ publicKeys, relayUrls }) => {
        const filters: NDKFilter = {
          kinds: [NDKKind.Metadata, NDKKind.RelayList, NDKKind.DirectMessageReceiveRelayList],
          authors: publicKeys,
        };
        const signature = subscriptionSignature(filters, relayUrls);
        return {
          key: relayUrls.join('|'),
          signature,
          prepare: async () => {
            await ensureRelayConnections(relayUrls);
            await getLoggedInSignerUser();
          },
          applied: async () => {
            await Promise.all([contactProfileApplyQueue, contactRelayListApplyQueue]);
          },
          start: (onEose: () => void, onClose: () => void) =>
            subscribeWithReqLogging(
              'contact-profile',
              'contact-hydration',
              filters,
              {
                relaySet: NDKRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
                onEvent: (event) => {
                  const wrapped = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
                  updateStoredEventSinceFromCreatedAt(wrapped.created_at);
                  if (wrapped.kind === NDKKind.Metadata)
                    queueContactProfileEventApplication(wrapped);
                  else queueContactRelayListEventApplication(wrapped);
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

  // Both public entry points converge on the same hydration operation.
  const subscribeContactRelayListUpdates = subscribeContactProfileUpdates;
  function resetContactSubscriptionsRuntimeState(_reason = 'replace'): void {
    subscriptions.stop();
    contactProfileApplyQueue = Promise.resolve();
    contactRelayListApplyQueue = Promise.resolve();
    relayEvents.clear();
  }
  return {
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  };
}
