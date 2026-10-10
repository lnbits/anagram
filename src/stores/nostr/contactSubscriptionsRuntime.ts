import {
  metadataIndexerFallbacks,
  PUBLIC_DISCOVERY_INDEXERS,
} from '#src/stores/nostr/metadataIndexers.ts';
import { createProfileHydrationRuntime } from '#src/stores/nostr/profileHydrationRuntime.ts';
import { getPublicProfile, rememberPublicProfile } from '#src/lib/state/publicProfiles.ts';
import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelayList,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrSubscriptionOptions,
  type NostrUser,
  type NostrUserProfile,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  bucketRelayTargets,
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import {
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
  normalizeWritableRelayUrlsValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from '#src/stores/nostr/valueUtils.ts';
import type { ContactMetadata, ContactRecord, ContactRelay } from '#src/types/contact.ts';

interface ContactSubscriptionsRuntimeDeps {
  applyOwnRelayList?: (event: ClientEvent) => Promise<void>;
  applyOwnPrivateRelayList?: (event: ClientEvent) => Promise<void>;
  queueRoutingRefresh?: () => void;
  applyContactProfileEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState: {
      createdAt: number;
      eventId: string;
    },
  ) => ContactMetadata;
  applyContactRelayListEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState: {
      createdAt: number;
      eventId: string;
    },
  ) => ContactMetadata;
  buildContactProfileEventState: (event: Pick<ClientEvent, 'created_at' | 'id'>) => {
    createdAt: number;
    eventId: string;
  };
  buildContactRelayListEventState: (event: Pick<ClientEvent, 'created_at' | 'id'>) => {
    createdAt: number;
    eventId: string;
  };
  buildSubscriptionEventDetails: (
    event: Pick<ClientEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>,
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  buildTrackedContactSubscriptionTargetDetails: (
    contactPubkeys: string[],
  ) => Promise<Record<string, unknown>>;
  buildUpdatedContactMeta: (
    existingMeta: ContactMetadata | undefined,
    profile: NostrUserProfile | null,
    resolvedNpub: string | null,
    resolvedNprofile: string | null,
  ) => ContactMetadata;
  bumpContactListVersion: () => void;
  chatStore: {
    syncContactProfile: (pubkeyHex: string) => Promise<void>;
  };
  contactMetadataEqual: (
    first: ContactMetadata | undefined,
    second: ContactMetadata | undefined,
  ) => boolean;
  contactRelayListsEqual: (
    first: ContactRelay[] | undefined,
    second: ContactRelay[] | undefined,
  ) => boolean;
  encodeNprofile: (pubkeyHex: string) => string | null;
  encodeNpub: (pubkeyHex: string) => string | null;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: ClientEvent) => string[];
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NostrUser>;
  isPubkeyBlocked: (pubkeyHex: string) => boolean;
  listTrackedContactPubkeys: () => Promise<string[]>;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  markContactProfileEventApplied: (
    pubkeyHex: string,
    eventState: { createdAt: number; eventId: string },
  ) => void;
  markContactRelayListEventApplied: (
    pubkeyHex: string,
    eventState: { createdAt: number; eventId: string },
  ) => void;
  ndk: NostrClient;
  parseContactProfileEvent: (event: Pick<ClientEvent, 'content'>) => NostrUserProfile | null;
  pruneTrackedContactProfileEventState: (activePubkeys: string[]) => void;
  pruneTrackedContactRelayListEventState: (activePubkeys: string[]) => void;
  relayEntriesFromRelayList: (relayList: NostrRelayList | null | undefined) => ContactRelay[];
  relaySignature: (relays: string[]) => string;
  resolveTrackedContactReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  shouldApplyContactProfileEvent: (
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>,
  ) => boolean;
  shouldApplyContactRelayListEvent: (
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>,
  ) => boolean;
  shouldPreserveExistingGroupRelays: (
    contact: Pick<ContactRecord, 'type' | 'public_key' | 'relays'> | null | undefined,
    nextRelayEntries: ContactRelay[] | undefined,
  ) => boolean;
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

export function createContactSubscriptionsRuntime({
  applyOwnPrivateRelayList = async () => {},
  applyOwnRelayList,
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
  const metadataClient = new NostrClient({ authenticate: false });
  const profileHydration = createProfileHydrationRuntime({
    isBlocked: isPubkeyBlocked,
    getOwnPublicKey: getLoggedInPublicKeyHex,
    onPrivateRelayList: (event) => {
      void applyOwnPrivateRelayList(event).catch(() => {});
    },
    onProfile: queueContactProfileEventApplication,
    onRelayList: queueContactRelayListEventApplication,
    subscribe: (filters, relayUrls, onEvent, onDone) => {
      if (relayUrls.every((url) => PUBLIC_DISCOVERY_INDEXERS.includes(url)))
        return metadataClient.subscribe(filters, {
          relayUrls,
          onEvent,
          onEose: () => onDone(true),
          onClose: () => onDone(false),
          closeOnEose: true,
        });
      return subscribeWithReqLogging('profile-lookup', 'profile-lookup', filters, {
        relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
        onEvent,
        onEose: () => onDone(true),
        onClose: () => onDone(false),
        closeOnEose: true,
      });
    },
  });
  let generation = 0;
  let contactProfileApplyQueue = Promise.resolve();
  let contactRelayListApplyQueue = Promise.resolve();
  let activeContactPubkeys = new Set<string>();
  let trackedContactPubkeys = new Set<string>();
  let visibleProfileKeys: string[] = [];
  let baseVisibleProfileKeys: string[] = [];
  const mountedProfiles = new Map<string, number>();
  let visibleGroupKey = '';
  let visibleProfileSignature = '';
  let visibleProfileTimer: ReturnType<typeof setTimeout> | undefined;
  function setVisibleProfileTargets(publicKeys: string[], groupPublicKey = ''): void {
    baseVisibleProfileKeys = publicKeys;
    const targets = [...publicKeys, ...mountedProfiles.keys()];
    const keys = [
      ...new Set(targets.filter((key) => /^[a-f0-9]{64}$/.test(key) && !isPubkeyBlocked(key))),
    ].sort();
    const groupKey = inputSanitizerService.normalizeHexKey(groupPublicKey) ?? '';
    const signature = JSON.stringify([keys, groupKey]);
    if (signature === visibleProfileSignature) return;
    visibleProfileSignature = signature;
    visibleProfileKeys = keys;
    void contactsService.restorePublicProfiles(keys).catch(() => {});
    visibleGroupKey = groupKey;
    clearTimeout(visibleProfileTimer);
    visibleProfileTimer = setTimeout(() => {
      visibleProfileTimer = undefined;
      void subscribeContactProfileUpdates().catch(() => {});
    }, 50);
  }
  // Mounted mention labels share the same batched, account-scoped profile queue.
  function retainVisibleProfileTarget(publicKey: string): () => void {
    if (!/^[a-f0-9]{64}$/.test(publicKey) || isPubkeyBlocked(publicKey)) return () => {};
    const token = generation;
    mountedProfiles.set(publicKey, (mountedProfiles.get(publicKey) ?? 0) + 1);
    setVisibleProfileTargets(baseVisibleProfileKeys, visibleGroupKey);
    let released = false;
    return () => {
      if (released || token !== generation) return;
      released = true;
      const count = (mountedProfiles.get(publicKey) ?? 1) - 1;
      if (count) mountedProfiles.set(publicKey, count);
      else mountedProfiles.delete(publicKey);
      setVisibleProfileTargets(baseVisibleProfileKeys, visibleGroupKey);
    };
  }
  async function ensureTrackedContact(publicKey: string): Promise<ContactRecord | null> {
    const existing = await contactsService.getContactByPublicKey(publicKey);
    if (existing || !trackedContactPubkeys.has(publicKey) || isPubkeyBlocked(publicKey))
      return existing;
    // A local profile cache is not membership in the private contact list.
    return (
      (await contactsService.createContact({
        public_key: publicKey,
        name: publicKey.slice(0, 16),
        meta: {},
      })) ?? contactsService.getContactByPublicKey(publicKey)
    );
  }
  const relayEvents = new Map<string, Map<number, ClientEvent>>();
  const profileSnapshots = new Map<
    string,
    {
      profile: NostrUserProfile;
      event: ClientEvent;
      createdAt: number;
      eventId: string;
    }
  >();

  async function applyGroupMemberProfile(
    publicKey: string,
    profile: NostrUserProfile,
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
        encodeNprofile(publicKey),
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
                }),
              ),
            },
      );
      if (JSON.stringify(members) === JSON.stringify(group.meta.group_members)) continue;
      await contactsService.updateContact(group.id, {
        metaBase: group.meta,
        meta: { ...group.meta, group_members: members },
      });
      bumpContactListVersion();
    }
  }

  async function applyContactProfileEvent(event: ClientEvent, replay = false): Promise<void> {
    if (!replay && !shouldApplyContactProfileEvent(event)) {
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
    const cached = profileSnapshots.get(normalizedPubkey);
    if (
      cached &&
      (cached.createdAt > nextEventState.createdAt ||
        (cached.createdAt === nextEventState.createdAt && cached.eventId < nextEventState.eventId))
    )
      return;
    profileSnapshots.set(normalizedPubkey, { profile: nextProfile, event, ...nextEventState });
    await contactsService.init();
    const existingContact = await ensureTrackedContact(normalizedPubkey);
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
              encodeNprofile(normalizedPubkey),
            ),
            nextEventState,
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
      existingContact.meta.nprofile?.trim() || encodeNprofile(normalizedPubkey) || '',
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
      metaBase: existingContact.meta,
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

  function queueContactProfileEventApplication(event: ClientEvent): void {
    const publicKey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!publicKey || isPubkeyBlocked(publicKey)) return;
    const profile = parseContactProfileEvent(event);
    if (!profile) return;
    const state = buildContactProfileEventState(event);
    // The verified kind-0 event reaches every visible identity before any IDB
    // work or relay-list reconciliation can hold up profile persistence.
    rememberPublicProfile(publicKey, profile, state.createdAt, state.eventId);
    const displayProfile = getPublicProfile(publicKey);
    if (displayProfile?.eventId === state.eventId)
      void contactsService.savePublicProfile(publicKey, displayProfile).catch(() => {});
    const runGeneration = generation;
    contactProfileApplyQueue = contactRelayListApplyQueue
      .then(() => (runGeneration === generation ? applyContactProfileEvent(event) : undefined))
      .catch((error) => {
        console.error('Failed to process contact profile event', error);
      });
    contactRelayListApplyQueue = contactProfileApplyQueue;
  }

  async function applyContactRelayListEvent(event: ClientEvent): Promise<void> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey || isPubkeyBlocked(normalizedPubkey)) return;
    const byKind = new Map(relayEvents.get(normalizedPubkey));
    const kind = event.kind ?? NostrKind.RelayList;
    const previous = byKind.get(kind);
    if (
      previous &&
      ((previous.created_at ?? 0) > (event.created_at ?? 0) ||
        (previous.created_at === event.created_at && previous.id <= event.id))
    )
      return;
    const nextEventState = buildContactRelayListEventState(event);
    await contactsService.init();
    const existingContact = await ensureTrackedContact(normalizedPubkey);
    if (!existingContact) {
      if (kind === NostrKind.RelayList)
        markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }
    if (existingContact.meta.blocked === true) {
      return;
    }

    const isGeneralList = kind === NostrKind.RelayList;
    const storedCreatedAt = isGeneralList
      ? existingContact.meta.relay_list_event_created_at
      : existingContact.meta.dm_receive_relay_event_created_at;
    if ((storedCreatedAt ?? 0) > nextEventState.createdAt) return;
    byKind.set(kind, event);
    const relayListEvent = byKind.get(NostrKind.RelayList);
    const dmRelayEvent = byKind.get(NostrKind.DirectMessageReceiveRelayList);
    const persistedMeta = isGeneralList
      ? applyContactRelayListEventStateToMeta(existingContact.meta, nextEventState)
      : { ...existingContact.meta, dm_receive_relay_event_created_at: nextEventState.createdAt };
    const generalEntries = relayListEvent
      ? relayEntriesFromRelayList(NostrRelayList.from(relayListEvent))
      : (existingContact.meta.general_relay_entries ?? existingContact.relays ?? []);
    const dmEntries = dmRelayEvent
      ? relayEntriesFromDirectMessageReceiveRelayEventValue(dmRelayEvent)
      : (existingContact.meta.dm_receive_relay_entries ?? []);
    persistedMeta.general_relay_entries = generalEntries;
    persistedMeta.dm_receive_relay_entries = dmEntries;
    const nextRelayEntries = mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
      generalEntries,
      dmEntries,
    );

    if (shouldPreserveExistingGroupRelays(existingContact, nextRelayEntries)) {
      console.warn('Ignoring empty group relay list event to preserve stored relays', {
        pubkey: normalizedPubkey,
        eventId: event.id ?? null,
        existingRelayCount: existingContact.relays.length,
      });
      if (!contactMetadataEqual(existingContact.meta, persistedMeta)) {
        const updatedContact = await contactsService.updateContact(existingContact.id, {
          metaBase: existingContact.meta,
          meta: persistedMeta,
        });
        if (!updatedContact) {
          return;
        }
      }
      relayEvents.set(normalizedPubkey, byKind);
      if (kind === NostrKind.RelayList)
        markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    if (
      contactRelayListsEqual(existingContact.relays, nextRelayEntries) &&
      contactMetadataEqual(existingContact.meta, persistedMeta)
    ) {
      relayEvents.set(normalizedPubkey, byKind);
      if (kind === NostrKind.RelayList)
        markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return;
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      metaBase: existingContact.meta,
      meta: persistedMeta,
      relays: nextRelayEntries,
    });
    if (!updatedContact) {
      return;
    }

    relayEvents.set(normalizedPubkey, byKind);
    if (kind === NostrKind.RelayList)
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
    if (!contactRelayListsEqual(existingContact.relays, nextRelayEntries)) {
      bumpContactListVersion();
      queueRoutingRefresh();
    }
  }

  function queueContactRelayListEventApplication(event: ClientEvent): void {
    if (event.pubkey === getLoggedInPublicKeyHex() && applyOwnRelayList) {
      void applyOwnRelayList(event).catch(() => {});
      return;
    }
    const runGeneration = generation;
    contactRelayListApplyQueue = contactRelayListApplyQueue
      .then(() => (runGeneration === generation ? applyContactRelayListEvent(event) : undefined))
      .catch((error) => {
        console.error('Failed to process contact relay list event', error);
      });
  }

  async function subscribeContactProfileUpdates(
    seedRelayUrls: string[] = [],
    _force = false,
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
    const visibleRelayUrls = inputSanitizerService.normalizeReadableRelayUrls(
      contacts.find((contact) => contact.public_key === visibleGroupKey)?.relays,
    );
    const members = contacts
      .filter((contact) => contact.type === 'group' && !contact.meta.blocked)
      .flatMap((contact) => contact.meta.group_members?.map((member) => member.public_key) ?? [])
      .filter((publicKey) => !isPubkeyBlocked(publicKey));
    const pubkeys = [...new Set([...tracked, ...members, ...visibleProfileKeys])]
      .filter((key) => !isPubkeyBlocked(key))
      .sort();
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
          relayUrls: [
            ...new Set([
              ...(publishedOn.length
                ? publishedOn
                : inputSanitizerService.normalizeReadableRelayUrls(entries)),
              ...inputSanitizerService.normalizeReadableRelayUrls(contact?.relays),
              ...(visibleProfileKeys.includes(publicKey) ? visibleRelayUrls : []),
              ...metadataIndexerFallbacks(fallback, publicKey === self),
              ...fallback,
            ]),
          ],
        };
      }),
      fallback,
    );
    // Refresh tracked routes even when their names/pictures are already cached.
    // A profile is not evidence that its older relay lists were also fetched.
    // Refresh missing/visible identities independently of the broad live snapshot.
    // Historical group authors may have no contact record or current roster entry.
    void contactsService.restorePublicProfiles(pubkeys).catch(() => {});
    profileHydration.request(
      buckets.flatMap(({ publicKeys, relayUrls }) =>
        publicKeys
          .filter(
            (key) =>
              tracked.has(key) ||
              visibleProfileKeys.includes(key) ||
              !getPublicProfile(key)?.name ||
              !getPublicProfile(key)?.picture,
          )
          .map((publicKey) => ({
            publicKey,
            relayUrls: [...relayUrls].sort(
              (a, b) =>
                Number(PUBLIC_DISCOVERY_INDEXERS.includes(b)) -
                Number(PUBLIC_DISCOVERY_INDEXERS.includes(a)),
            ),
          })),
      ),
      visibleProfileKeys,
    );
    trackedContactPubkeys = tracked;
    activeContactPubkeys = new Set(pubkeys);
    await subscriptions.reconcile(
      buckets.map(({ publicKeys, relayUrls: lookupRelayUrls }) => {
        const relayUrls = lookupRelayUrls.filter(
          (url) => !PUBLIC_DISCOVERY_INDEXERS.includes(url) || fallback.includes(url),
        );
        const contacts = publicKeys.filter(
          (publicKey) => publicKey !== self && tracked.has(publicKey),
        );
        const memberKeys = publicKeys.filter((publicKey) => !tracked.has(publicKey));
        const filters: NostrFilter[] = [
          ...(memberKeys.length ? [{ kinds: [NostrKind.Metadata], authors: memberKeys }] : []),
          ...(contacts.length
            ? [
                {
                  kinds: [
                    NostrKind.Metadata,
                    NostrKind.RelayList,
                    NostrKind.DirectMessageReceiveRelayList,
                  ],
                  authors: contacts,
                },
              ]
            : []),
          // My Relay List already owns the logged-in user's kind 10002 snapshot.
          ...(publicKeys.includes(self)
            ? [
                {
                  kinds: [NostrKind.Metadata, NostrKind.DirectMessageReceiveRelayList],
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
                relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
                cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
                onEvent: (event) => {
                  if (runGeneration !== generation) return;
                  const wrapped =
                    event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                  updateStoredEventSinceFromCreatedAt(wrapped.created_at);
                  if (wrapped.kind === NostrKind.Metadata)
                    queueContactProfileEventApplication(wrapped);
                  else queueContactRelayListEventApplication(wrapped);
                },
                onEose,
                onClose,
              },
              { signature, ...buildSubscriptionRelayDetails(relayUrls) },
            ),
        };
      }),
    );
    activeContactPubkeys = new Set(pubkeys);
    await subscriptions.waitForEose();
    if (runGeneration !== generation) return;
    // Relays/pool deduplicate kind-0 events. Reuse snapshots for new rosters and
    // contacts recreated by private-list reconciliation, without refetching or
    // rewriting every profile in an established account.
    contactProfileApplyQueue = contactRelayListApplyQueue.then(async () => {
      if (runGeneration !== generation) return;
      const stored = new Map(
        (await contactsService.listContacts()).map((contact) => [contact.public_key, contact]),
      );
      const memberKeys = new Set(members);
      for (const key of new Set([...tracked, ...memberKeys])) {
        const snapshot = profileSnapshots.get(key);
        if (!snapshot) continue;
        const contact = stored.get(key);
        if (
          tracked.has(key) &&
          (!contact ||
            contact.meta.profile_event_created_at === undefined ||
            contact.meta.profile_event_created_at < snapshot.createdAt)
        ) {
          await applyContactProfileEvent(snapshot.event, true);
        } else if (memberKeys.has(key)) await applyGroupMemberProfile(key, snapshot.profile);
      }
    });
    contactRelayListApplyQueue = contactProfileApplyQueue;
    await contactProfileApplyQueue;
  }

  // Both public entry points converge on the same hydration operation.
  const subscribeContactRelayListUpdates = subscribeContactProfileUpdates;
  function resetContactSubscriptionsRuntimeState(_reason = 'replace'): void {
    generation += 1;
    profileHydration.reset();
    for (const relay of metadataClient.pool.relays.values()) relay.disconnect();
    clearTimeout(visibleProfileTimer);
    visibleProfileTimer = undefined;
    visibleProfileKeys = [];
    baseVisibleProfileKeys = [];
    mountedProfiles.clear();
    visibleGroupKey = '';
    visibleProfileSignature = '';
    subscriptions.stop();
    activeContactPubkeys.clear();
    trackedContactPubkeys.clear();
    contactProfileApplyQueue = Promise.resolve();
    contactRelayListApplyQueue = Promise.resolve();
    relayEvents.clear();
    profileSnapshots.clear();
  }
  return {
    retainVisibleProfileTarget,
    setVisibleProfileTargets,
    hasActiveContactHydration: (publicKey: string) =>
      subscriptions.size() > 0 && activeContactPubkeys.has(publicKey),
    resetContactSubscriptionsRuntimeState,
    subscribeContactProfileUpdates,
    subscribeContactRelayListUpdates,
  };
}
