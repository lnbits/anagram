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
  normalizeWritableRelayUrlsValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from 'src/stores/nostr/valueUtils';
import type { ContactMetadata, ContactRecord, ContactRelay } from 'src/types/contact';

interface ContactSubscriptionsRuntimeDeps {
  queueRoutingRefresh?: () => void;
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
  queueRoutingRefresh = () => {},
  applyContactProfileEventStateToMeta,
  applyContactRelayListEventStateToMeta,
  buildContactProfileEventState,
  buildContactRelayListEventState,
  buildSubscriptionRelayDetails,
  buildUpdatedContactMeta,
  bumpContactListVersion,
  chatStore,
  contactMetadataEqual,
  contactRelayListsEqual,
  encodeNprofile,
  encodeNpub,
  ensureRelayConnections,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  isPubkeyBlocked,
  listTrackedContactPubkeys,
  markContactProfileEventApplied,
  markContactRelayListEventApplied,
  ndk,
  parseContactProfileEvent,
  pruneTrackedContactProfileEventState,
  pruneTrackedContactRelayListEventState,
  relayEntriesFromRelayList,
  resolveTrackedContactReadRelayUrls,
  shouldApplyContactProfileEvent,
  shouldPreserveExistingGroupRelays,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
}: ContactSubscriptionsRuntimeDeps) {
  const subscriptions = createDesiredSubscriptions();
  let generation = 0;
  let contactProfileApplyQueue = Promise.resolve();
  let contactRelayListApplyQueue = Promise.resolve();
  let activeContactPubkeys = new Set<string>();
  const relayEvents = new Map<string, Map<number, NDKEvent>>();

  async function applyGroupMemberProfile(
    publicKey: string,
    profile: NDKUserProfile
  ): Promise<void> {
    for (const group of await contactsService.listContacts()) {
      if (
        group.type !== 'group' ||
        !group.meta.group_members?.some((member) => member.public_key === publicKey)
      )
        continue;
      const metadata = buildUpdatedContactMeta(
        {},
        profile,
        encodeNpub(publicKey),
        encodeNprofile(publicKey)
      );
      const members = group.meta.group_members.map((member) =>
        member.public_key !== publicKey
          ? member
          : {
              ...member,
              name: metadata.display_name || metadata.name || member.name,
              ...Object.fromEntries(
                ['about', 'picture', 'avatar', 'nip05', 'nprofile'].flatMap((key) => {
                  const value = metadata[key as keyof ContactMetadata];
                  return typeof value === 'string' ? [[key, value]] : [];
                })
              ),
            }
      );
      if (JSON.stringify(members) === JSON.stringify(group.meta.group_members)) continue;
      await contactsService.updateContact(group.id, {
        meta: { ...group.meta, group_members: members },
      });
      bumpContactListVersion();
    }
  }

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
    if (
      existingContact?.meta.blocked === true ||
      (existingContact?.meta.profile_event_created_at ?? 0) > nextEventState.createdAt
    )
      return;
    await applyGroupMemberProfile(normalizedPubkey, nextProfile);
    if (!existingContact) {
      if (normalizedPubkey === getLoggedInPublicKeyHex()) {
        await contactsService.createContact({
          public_key: normalizedPubkey,
          name: nextProfile.displayName || nextProfile.name || normalizedPubkey.slice(0, 16),
          meta: applyContactProfileEventStateToMeta(
            buildUpdatedContactMeta(
              {},
              nextProfile,
              encodeNpub(normalizedPubkey),
              encodeNprofile(normalizedPubkey)
            ),
            nextEventState
          ),
        });
      }
      // A roster preview is not a persisted direct contact profile. Let a later contact
      // hydration apply the same snapshot when that member becomes a saved contact.
      if (normalizedPubkey === getLoggedInPublicKeyHex())
        markContactProfileEventApplied(normalizedPubkey, nextEventState);
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
    const nextEventState = buildContactRelayListEventState(event);
    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (!existingContact) {
      if (kind === NDKKind.RelayList)
        markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }
    if (existingContact.meta.blocked === true) {
      return;
    }

    const isGeneralList = kind === NDKKind.RelayList;
    const storedCreatedAt = isGeneralList
      ? existingContact.meta.relay_list_event_created_at
      : existingContact.meta.dm_receive_relay_event_created_at;
    if ((storedCreatedAt ?? 0) > nextEventState.createdAt) return;
    byKind.set(kind, event);
    relayEvents.set(normalizedPubkey, byKind);
    const relayListEvent = byKind.get(NDKKind.RelayList);
    const dmRelayEvent = byKind.get(NDKKind.DirectMessageReceiveRelayList);
    const persistedMeta = isGeneralList
      ? applyContactRelayListEventStateToMeta(existingContact.meta, nextEventState)
      : { ...existingContact.meta, dm_receive_relay_event_created_at: nextEventState.createdAt };
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
      if (kind === NDKKind.RelayList)
        markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    if (
      contactRelayListsEqual(existingContact.relays, nextRelayEntries) &&
      contactMetadataEqual(existingContact.meta, persistedMeta)
    ) {
      if (kind === NDKKind.RelayList)
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

    if (kind === NDKKind.RelayList)
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
    if (!contactRelayListsEqual(existingContact.relays, nextRelayEntries)) {
      bumpContactListVersion();
      queueRoutingRefresh();
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
    const runGeneration = generation;
    const self = getLoggedInPublicKeyHex();
    if (!self) {
      subscriptions.stop();
      return;
    }
    const fallback = await resolveTrackedContactReadRelayUrls(seedRelayUrls);
    const tracked = new Set([self, ...(await listTrackedContactPubkeys())]);
    const contacts = await contactsService.listContacts();
    const members = contacts
      .filter((contact) => contact.type === 'group' && !contact.meta.blocked)
      .flatMap((contact) => contact.meta.group_members?.map((member) => member.public_key) ?? [])
      .filter((publicKey) => !isPubkeyBlocked(publicKey));
    const pubkeys = [...new Set([...tracked, ...members])].sort();
    pruneTrackedContactProfileEventState(pubkeys);
    pruneTrackedContactRelayListEventState(pubkeys);
    if (runGeneration !== generation) return;
    const buckets = bucketRelayTargets(
      pubkeys.map((publicKey) => {
        const contact = contacts.find((contact) => contact.public_key === publicKey);
        const entries = contact?.meta.general_relay_entries ?? contact?.relays;
        const publishedOn = normalizeWritableRelayUrlsValue(entries);
        return {
          publicKey,
          relayUrls: publishedOn.length
            ? publishedOn
            : inputSanitizerService.normalizeReadableRelayUrls(entries),
        };
      }),
      fallback
    );
    await subscriptions.reconcile(
      buckets.map(({ publicKeys, relayUrls }) => {
        const contacts = publicKeys.filter(
          (publicKey) => publicKey !== self && tracked.has(publicKey)
        );
        const memberKeys = publicKeys.filter((publicKey) => !tracked.has(publicKey));
        const filters: NDKFilter[] = [
          ...(memberKeys.length ? [{ kinds: [NDKKind.Metadata], authors: memberKeys }] : []),
          ...(contacts.length
            ? [
                {
                  kinds: [
                    NDKKind.Metadata,
                    NDKKind.RelayList,
                    NDKKind.DirectMessageReceiveRelayList,
                  ],
                  authors: contacts,
                },
              ]
            : []),
          // My Relay List already owns the logged-in user's kind 10002 snapshot.
          ...(publicKeys.includes(self)
            ? [
                {
                  kinds: [NDKKind.Metadata, NDKKind.DirectMessageReceiveRelayList],
                  authors: [self],
                },
              ]
            : []),
        ];
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
    activeContactPubkeys = new Set(pubkeys);
    await subscriptions.waitForEose();
  }

  // Both public entry points converge on the same hydration operation.
  const subscribeContactRelayListUpdates = subscribeContactProfileUpdates;
  function resetContactSubscriptionsRuntimeState(_reason = 'replace'): void {
    generation += 1;
    subscriptions.stop();
    activeContactPubkeys.clear();
    contactProfileApplyQueue = Promise.resolve();
    contactRelayListApplyQueue = Promise.resolve();
    relayEvents.clear();
  }
  return {
    hasActiveContactHydration: (publicKey: string) =>
      subscriptions.size() > 0 && activeContactPubkeys.has(publicKey),
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  };
}
