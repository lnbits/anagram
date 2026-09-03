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
import { createReadyRelaySet, fetchEventWithRelayTimeout } from 'src/stores/nostr/relayQueryUtils';
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
  let contactProfileSubscription: ReturnType<NDK['subscribe']> | null = null;
  let contactProfileSubscriptionSignature = '';
  let contactProfileApplyQueue = Promise.resolve();
  let contactRelayListSubscription: ReturnType<NDK['subscribe']> | null = null;
  let contactRelayListSubscriptionSignature = '';
  let contactRelayListApplyQueue = Promise.resolve();

  async function fetchDirectMessageReceiveRelayEntries(
    pubkeyHex: string,
    seedRelayUrls: string[] = []
  ): Promise<ContactRelay[]> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return [];
    }

    const relayUrls = await resolveTrackedContactReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      return [];
    }

    await ensureRelayConnections(relayUrls);

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const directMessageReceiveRelayEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NDKKind.DirectMessageReceiveRelayList],
        authors: [normalizedPubkey],
      },
      {
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet
    );
    if (!directMessageReceiveRelayEvent) {
      return [];
    }

    const wrappedEvent =
      directMessageReceiveRelayEvent instanceof NDKEvent
        ? directMessageReceiveRelayEvent
        : new NDKEvent(ndk, directMessageReceiveRelayEvent);
    updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);

    return relayEntriesFromDirectMessageReceiveRelayEventValue(wrappedEvent);
  }

  async function applyContactProfileEvent(event: NDKEvent): Promise<void> {
    if (!shouldApplyContactProfileEvent(event)) {
      return;
    }

    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || normalizedPubkey === getLoggedInPublicKeyHex()) {
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
    contactProfileApplyQueue = contactProfileApplyQueue
      .then(() => applyContactProfileEvent(event))
      .catch((error) => {
        console.error('Failed to process contact profile event', error);
      });
  }

  async function applyContactRelayListEvent(event: NDKEvent): Promise<void> {
    if (!shouldApplyContactRelayListEvent(event)) {
      return;
    }

    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || normalizedPubkey === getLoggedInPublicKeyHex()) {
      return;
    }

    if (isPubkeyBlocked(normalizedPubkey)) {
      return;
    }

    const nextEventState = buildContactRelayListEventState(event);
    const relayList = NDKRelayList.from(event);
    let directMessageReceiveRelayEntries: ContactRelay[] = [];
    try {
      directMessageReceiveRelayEntries = await fetchDirectMessageReceiveRelayEntries(
        normalizedPubkey,
        extractRelayUrlsFromEvent(event)
      );
    } catch (error) {
      console.warn(
        'Failed to fetch direct message receive relays for contact',
        normalizedPubkey,
        error
      );
    }
    const nextRelayEntries = mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
      relayEntriesFromRelayList(relayList),
      directMessageReceiveRelayEntries
    );

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

  function stopContactProfileSubscription(reason = 'replace'): void {
    if (contactProfileSubscription) {
      logSubscription('contact-profile', 'stop', {
        reason,
        signature: contactProfileSubscriptionSignature || null,
      });
      contactProfileSubscription.stop();
      contactProfileSubscription = null;
    }

    contactProfileSubscriptionSignature = '';
  }

  async function subscribeContactProfileUpdates(
    seedRelayUrls: string[] = [],
    force = false
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      pruneTrackedContactProfileEventState([]);
      stopContactProfileSubscription('missing-login');
      return;
    }

    const relayUrls = await resolveTrackedContactReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      stopContactProfileSubscription('no-relays');
      return;
    }

    const contactPubkeys = await listTrackedContactPubkeys();
    pruneTrackedContactProfileEventState(contactPubkeys);
    if (contactPubkeys.length === 0) {
      stopContactProfileSubscription('no-contacts');
      return;
    }

    const signature = `${relaySignature(relayUrls)}:${contactPubkeys.join(',')}`;
    if (!force && contactProfileSubscription && contactProfileSubscriptionSignature === signature) {
      logSubscription('contact-profile', 'skip', {
        reason: 'already-active',
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
        recipientCount: contactPubkeys.length,
        recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
      });
      return;
    }

    logSubscription('contact-profile', 'prepare', {
      force,
      signature,
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
    });

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();
    stopContactProfileSubscription();
    const contactProfileTargetDetails =
      await buildTrackedContactSubscriptionTargetDetails(contactPubkeys);

    logSubscription('contact-profile', 'start', {
      force,
      signature,
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
      ...contactProfileTargetDetails,
    });

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const contactProfileFilters: NDKFilter = {
      kinds: [NDKKind.Metadata],
      authors: contactPubkeys,
      since: getFilterSince(),
    };
    contactProfileSubscription = subscribeWithReqLogging(
      'contact-profile',
      'contact-profile',
      contactProfileFilters,
      {
        relaySet,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        onEvent: (event) => {
          const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
          logSubscription('contact-profile', 'event', {
            signature,
            ...buildSubscriptionEventDetails(wrappedEvent),
            ...buildSubscriptionRelayDetails(extractRelayUrlsFromEvent(wrappedEvent)),
          });
          updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
          queueContactProfileEventApplication(wrappedEvent);
        },
        onEose: () => {
          logSubscription('contact-profile', 'eose', {
            signature,
          });
        },
      },
      {
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
      }
    );
    contactProfileSubscriptionSignature = signature;

    logSubscription('contact-profile', 'active', {
      signature,
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
    });
  }

  function stopContactRelayListSubscription(reason = 'replace'): void {
    if (contactRelayListSubscription) {
      logSubscription('contact-relay-list', 'stop', {
        reason,
        signature: contactRelayListSubscriptionSignature || null,
      });
      contactRelayListSubscription.stop();
      contactRelayListSubscription = null;
    }

    contactRelayListSubscriptionSignature = '';
  }

  async function subscribeContactRelayListUpdates(
    seedRelayUrls: string[] = [],
    force = false
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      pruneTrackedContactRelayListEventState([]);
      stopContactRelayListSubscription('missing-login');
      return;
    }

    const relayUrls = await resolveTrackedContactReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      stopContactRelayListSubscription('no-relays');
      return;
    }

    const contactPubkeys = await listTrackedContactPubkeys();
    pruneTrackedContactRelayListEventState(contactPubkeys);
    if (contactPubkeys.length === 0) {
      stopContactRelayListSubscription('no-contacts');
      return;
    }

    const signature = `${relaySignature(relayUrls)}:${contactPubkeys.join(',')}`;
    if (
      !force &&
      contactRelayListSubscription &&
      contactRelayListSubscriptionSignature === signature
    ) {
      logSubscription('contact-relay-list', 'skip', {
        reason: 'already-active',
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
        recipientCount: contactPubkeys.length,
        recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
      });
      return;
    }

    logSubscription('contact-relay-list', 'prepare', {
      force,
      signature,
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
    });

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();
    stopContactRelayListSubscription();
    const contactRelayTargetDetails =
      await buildTrackedContactSubscriptionTargetDetails(contactPubkeys);

    logSubscription('contact-relay-list', 'start', {
      force,
      signature,
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
      ...contactRelayTargetDetails,
    });

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const contactRelayListFilters: NDKFilter = {
      kinds: [NDKKind.RelayList],
      authors: contactPubkeys,
      since: getFilterSince(),
    };
    contactRelayListSubscription = subscribeWithReqLogging(
      'contact-relay-list',
      'contact-relay-list',
      contactRelayListFilters,
      {
        relaySet,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        onEvent: (event) => {
          const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
          logSubscription('contact-relay-list', 'event', {
            signature,
            ...buildSubscriptionEventDetails(wrappedEvent),
            ...buildSubscriptionRelayDetails(extractRelayUrlsFromEvent(wrappedEvent)),
          });
          updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
          queueContactRelayListEventApplication(wrappedEvent);
        },
        onEose: () => {
          logSubscription('contact-relay-list', 'eose', {
            signature,
          });
        },
      },
      {
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
      }
    );
    contactRelayListSubscriptionSignature = signature;

    logSubscription('contact-relay-list', 'active', {
      signature,
      ...buildSubscriptionRelayDetails(relayUrls),
      recipientCount: contactPubkeys.length,
      recipients: contactPubkeys.map((value) => formatSubscriptionLogValue(value)),
    });
  }

  function resetContactSubscriptionsRuntimeState(reason = 'replace'): void {
    stopContactProfileSubscription(reason);
    stopContactRelayListSubscription(reason);
    contactProfileApplyQueue = Promise.resolve();
    contactRelayListApplyQueue = Promise.resolve();
  }

  return {
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  };
}
