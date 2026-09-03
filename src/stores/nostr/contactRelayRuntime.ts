import NDK, {
  NDKEvent,
  NDKKind,
  NDKRelayList,
  NDKSubscriptionCacheUsage,
  type NDKUser,
  type NDKUserProfile,
} from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import type { MuteListContent } from 'src/stores/nostr/muteListRuntime';
import { createReadyRelaySet, fetchEventWithRelayTimeout } from 'src/stores/nostr/relayQueryUtils';
import { isPlainRecord } from 'src/stores/nostr/shared';
import type {
  ContactProfileEventState,
  ContactRelayListEventState,
  ContactRelayListFetchResult,
} from 'src/stores/nostr/types';
import {
  mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue,
  relayEntriesFromDirectMessageReceiveRelayEventValue,
} from 'src/stores/nostr/valueUtils';
import type { ContactRecord, ContactRelay } from 'src/types/contact';

interface ContactRelayRuntimeDeps {
  applyContactRelayListEventStateToMeta: (
    meta: ContactRecord['meta'] | undefined,
    eventState: ContactRelayListEventState | null | undefined
  ) => ContactRecord['meta'];
  bumpContactListVersion: () => void;
  contactMetadataEqual: (
    first: ContactRecord['meta'] | undefined,
    second: ContactRecord['meta'] | undefined
  ) => boolean;
  contactRelayListsEqual: (
    first: ContactRelay[] | undefined,
    second: ContactRelay[] | undefined
  ) => boolean;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  isPubkeyBlocked: (pubkeyHex: string) => boolean;
  markContactRelayListEventApplied: (
    pubkeyHex: string,
    eventState: ContactRelayListEventState
  ) => void;
  ndk: NDK;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  normalizeWritableRelayUrlsValue: (relays: ContactRelay[] | undefined) => string[];
  readContactProfileEventSince: (meta: ContactRecord['meta'] | undefined) => number | null;
  readContactRelayListEventSince: (meta: ContactRecord['meta'] | undefined) => number | null;
  relayEntriesFromRelayList: (relayList: NDKRelayList | null | undefined) => ContactRelay[];
  relayStore: { init: () => void; relays: string[] };
  resolveGroupPublishRelayUrlsValue: (
    relays: ContactRelay[] | undefined,
    seedRelayUrls?: string[]
  ) => string[];
  shouldPreserveExistingGroupRelays: (
    contact: Pick<ContactRecord, 'type' | 'public_key' | 'relays'> | null | undefined,
    nextRelayEntries: ContactRelay[] | undefined
  ) => boolean;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
}

interface ContactProfileFetchOptions {
  relayEntries?: ContactRelay[];
  seedRelayUrls?: string[];
  ignoreStoredSince?: boolean;
  onlyExplicitRelayEntries?: boolean;
}

export function createContactRelayRuntime({
  applyContactRelayListEventStateToMeta,
  bumpContactListVersion,
  contactMetadataEqual,
  contactRelayListsEqual,
  ensureRelayConnections,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  isPubkeyBlocked,
  markContactRelayListEventApplied,
  ndk,
  normalizeRelayStatusUrls,
  normalizeWritableRelayUrlsValue,
  readContactProfileEventSince,
  readContactRelayListEventSince,
  relayEntriesFromRelayList,
  relayStore,
  resolveGroupPublishRelayUrlsValue,
  shouldPreserveExistingGroupRelays,
  updateStoredEventSinceFromCreatedAt,
}: ContactRelayRuntimeDeps) {
  async function fetchContactProfile(
    pubkeyHex: string,
    options: ContactProfileFetchOptions = {}
  ): Promise<{
    eventState: ContactProfileEventState | null;
    profile: NDKUserProfile | null;
  }> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return {
        eventState: null,
        profile: null,
      };
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (isPubkeyBlocked(normalizedPubkey) || existingContact?.meta.blocked === true) {
      return {
        eventState: null,
        profile: null,
      };
    }

    const relayUrls = await resolveContactProfileReadRelayUrls(normalizedPubkey, {
      relayEntries: options.relayEntries,
      onlyExplicitRelayEntries: options.onlyExplicitRelayEntries,
      seedRelayUrls: options.seedRelayUrls ?? [],
    });
    if (relayUrls.length === 0) {
      return {
        eventState: null,
        profile: null,
      };
    }

    await ensureRelayConnections(relayUrls);

    const since = options.ignoreStoredSince
      ? null
      : readContactProfileEventSince(existingContact?.meta);
    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const profileEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NDKKind.Metadata],
        authors: [normalizedPubkey],
        ...(since !== null ? { since } : {}),
      },
      {
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet
    );
    if (!profileEvent) {
      return {
        eventState: null,
        profile: null,
      };
    }

    updateStoredEventSinceFromCreatedAt(profileEvent.created_at);

    const wrappedEvent =
      profileEvent instanceof NDKEvent ? profileEvent : new NDKEvent(ndk, profileEvent);

    return {
      eventState: buildContactProfileEventState(wrappedEvent),
      profile: parseContactProfileEvent(wrappedEvent),
    };
  }

  async function fetchContactRelayList(
    pubkeyHex: string,
    seedRelayUrls: string[] = []
  ): Promise<ContactRelayListFetchResult | null> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return null;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (isPubkeyBlocked(normalizedPubkey) || existingContact?.meta.blocked === true) {
      return null;
    }

    const relayUrls = await resolveContactRelayListReadRelayUrls(normalizedPubkey, seedRelayUrls);
    if (relayUrls.length === 0) {
      return null;
    }

    await ensureRelayConnections(relayUrls);

    const since = readContactRelayListEventSince(existingContact?.meta);
    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const [relayListEvent, directMessageReceiveRelayEvent] = await Promise.all([
      fetchEventWithRelayTimeout(
        ndk,
        {
          kinds: [NDKKind.RelayList],
          authors: [normalizedPubkey],
          ...(since !== null ? { since } : {}),
        },
        {
          cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        },
        relaySet
      ),
      fetchEventWithRelayTimeout(
        ndk,
        {
          kinds: [NDKKind.DirectMessageReceiveRelayList],
          authors: [normalizedPubkey],
        },
        {
          cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        },
        relaySet
      ),
    ]);
    if (!relayListEvent && !directMessageReceiveRelayEvent) {
      return null;
    }

    let relayList: NDKRelayList | null = null;
    if (relayListEvent) {
      updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);

      relayList = NDKRelayList.from(
        relayListEvent instanceof NDKEvent ? relayListEvent : new NDKEvent(ndk, relayListEvent)
      );
    }

    const wrappedDirectMessageReceiveRelayEvent = directMessageReceiveRelayEvent
      ? directMessageReceiveRelayEvent instanceof NDKEvent
        ? directMessageReceiveRelayEvent
        : new NDKEvent(ndk, directMessageReceiveRelayEvent)
      : null;
    if (wrappedDirectMessageReceiveRelayEvent) {
      updateStoredEventSinceFromCreatedAt(wrappedDirectMessageReceiveRelayEvent.created_at);
    }

    const relayEntries = relayList
      ? relayEntriesFromRelayList(relayList)
      : inputSanitizerService.normalizeRelayListMetadataEntries(existingContact?.relays ?? []);
    const directMessageReceiveRelayEntries = relayEntriesFromDirectMessageReceiveRelayEventValue(
      wrappedDirectMessageReceiveRelayEvent
    );
    const mergedRelayEntries = mergeRelayEntriesWithDirectMessageReceiveRelayEntriesValue(
      relayEntries,
      directMessageReceiveRelayEntries
    );

    return {
      createdAt: Number(relayList?.created_at ?? 0),
      eventId: relayList?.id?.trim() ?? '',
      relayEntries: mergedRelayEntries,
    };
  }

  async function refreshContactRelayList(
    pubkeyHex: string,
    seedRelayUrls: string[] = []
  ): Promise<ContactRelay[] | null> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return null;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);
    if (!existingContact) {
      return null;
    }

    const relayList = await fetchContactRelayList(normalizedPubkey, seedRelayUrls);
    if (!relayList) {
      return existingContact.relays ?? [];
    }

    const nextEventState: ContactRelayListEventState = {
      createdAt: relayList.createdAt,
      eventId: relayList.eventId,
    };
    const nextRelayEntries = relayList.relayEntries;
    const nextMeta = applyContactRelayListEventStateToMeta(existingContact.meta, nextEventState);
    if (shouldPreserveExistingGroupRelays(existingContact, nextRelayEntries)) {
      console.warn('Preserving existing group relays after empty relay list refresh', {
        pubkey: normalizedPubkey,
        existingRelayCount: existingContact.relays.length,
      });
      if (!contactMetadataEqual(existingContact.meta, nextMeta)) {
        const updatedContact = await contactsService.updateContact(existingContact.id, {
          meta: nextMeta,
        });
        if (!updatedContact) {
          throw new Error('Failed to persist refreshed contact relay list metadata.');
        }
      }

      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return existingContact.relays ?? [];
    }

    if (
      contactRelayListsEqual(existingContact.relays, nextRelayEntries) &&
      contactMetadataEqual(existingContact.meta, nextMeta)
    ) {
      markContactRelayListEventApplied(normalizedPubkey, nextEventState);
      return nextRelayEntries;
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      meta: nextMeta,
      relays: nextRelayEntries,
    });
    if (!updatedContact) {
      throw new Error('Failed to persist refreshed contact relay list.');
    }

    markContactRelayListEventApplied(normalizedPubkey, nextEventState);
    if (!contactRelayListsEqual(existingContact.relays, nextRelayEntries)) {
      bumpContactListVersion();
    }
    return updatedContact.relays ?? [];
  }

  async function refreshGroupRelayListsOnStartup(seedRelayUrls: string[] = []): Promise<void> {
    await contactsService.init();

    const groupContacts = (await contactsService.listContacts()).filter(
      (contact) => contact.type === 'group'
    );
    if (groupContacts.length === 0) {
      return;
    }

    const knownGroupRelayUrls = groupContacts.flatMap((contact) =>
      inputSanitizerService.normalizeReadableRelayUrls(contact.relays)
    );
    const relayUrls = normalizeRelayStatusUrls([
      ...(await resolveLoggedInReadRelayUrls(seedRelayUrls)),
      ...knownGroupRelayUrls,
    ]);
    if (relayUrls.length > 0) {
      await ensureRelayConnections(relayUrls);
    }

    for (const groupContact of groupContacts) {
      const groupPublicKey = inputSanitizerService.normalizeHexKey(groupContact.public_key);
      if (!groupPublicKey) {
        continue;
      }

      try {
        await refreshContactRelayList(groupPublicKey);
      } catch (error) {
        console.warn('Failed to refresh group relay list on startup', groupPublicKey, error);
      }
    }
  }

  async function listTrackedContactPubkeys(): Promise<string[]> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    await contactsService.init();

    const trackedPubkeys = new Set<string>();
    for (const contact of await contactsService.listContacts()) {
      const normalizedPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
      if (!normalizedPubkey || normalizedPubkey === loggedInPubkeyHex) {
        continue;
      }

      if (isPubkeyBlocked(normalizedPubkey) || contact.meta.blocked === true) {
        continue;
      }

      trackedPubkeys.add(normalizedPubkey);
    }

    return Array.from(trackedPubkeys).sort((first, second) => first.localeCompare(second));
  }

  function normalizeWritableRelayUrls(relays: ContactRelay[] | undefined): string[] {
    return normalizeWritableRelayUrlsValue(relays);
  }

  function getAppRelayUrls(): string[] {
    relayStore.init();
    return normalizeRelayStatusUrls(relayStore.relays);
  }

  async function resolveLoggedInReadRelayUrls(seedRelayUrls: string[] = []): Promise<string[]> {
    const appRelayUrls = getAppRelayUrls();
    const relayUrls = normalizeRelayStatusUrls([
      ...appRelayUrls,
      ...inputSanitizerService.normalizeStringArray(seedRelayUrls),
    ]);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return relayUrls;
    }

    await contactsService.init();
    const loggedInContact = await contactsService.getContactByPublicKey(loggedInPubkeyHex);

    return normalizeRelayStatusUrls([
      ...relayUrls,
      ...inputSanitizerService.normalizeReadableRelayUrls(loggedInContact?.relays),
    ]);
  }

  async function resolvePrivateMessageReadRelayUrls(
    seedRelayUrls: string[] = []
  ): Promise<string[]> {
    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const contactsByPubkey = new Map(
      (await contactsService.listContacts())
        .map((contact) => {
          const normalizedPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
          return normalizedPubkey ? ([normalizedPubkey, contact] as const) : null;
        })
        .filter((entry): entry is readonly [string, ContactRecord] => Boolean(entry))
    );
    const groupRelayUrls = (await chatDataService.listChats())
      .filter((chat) => chat.type === 'group')
      .flatMap((chat) => {
        const normalizedChatPublicKey = inputSanitizerService.normalizeHexKey(chat.public_key);
        if (!normalizedChatPublicKey) {
          return [];
        }

        return inputSanitizerService.normalizeReadableRelayUrls(
          contactsByPubkey.get(normalizedChatPublicKey)?.relays
        );
      });

    return normalizeRelayStatusUrls([...relayUrls, ...groupRelayUrls]);
  }

  async function resolveTrackedContactReadRelayUrls(
    seedRelayUrls: string[] = []
  ): Promise<string[]> {
    return resolvePrivateMessageReadRelayUrls(seedRelayUrls);
  }

  async function resolveContactRelayListReadRelayUrls(
    pubkeyHex: string,
    seedRelayUrls: string[] = []
  ): Promise<string[]> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return [];
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);

    return normalizeRelayStatusUrls([
      ...(await resolveLoggedInReadRelayUrls(seedRelayUrls)),
      ...inputSanitizerService.normalizeReadableRelayUrls(existingContact?.relays),
    ]);
  }

  async function resolveContactProfileReadRelayUrls(
    pubkeyHex: string,
    options: ContactProfileFetchOptions = {}
  ): Promise<string[]> {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
    if (!normalizedPubkey) {
      return [];
    }

    const explicitRelayUrls = inputSanitizerService.normalizeReadableRelayUrls(
      options.relayEntries
    );
    if (options.onlyExplicitRelayEntries) {
      return normalizeRelayStatusUrls(explicitRelayUrls);
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedPubkey);

    return normalizeRelayStatusUrls([
      ...(await resolveLoggedInReadRelayUrls(options.seedRelayUrls ?? [])),
      ...inputSanitizerService.normalizeReadableRelayUrls(existingContact?.relays),
      ...explicitRelayUrls,
    ]);
  }

  function resolveGroupPublishRelayUrls(
    relays: ContactRelay[] | undefined,
    seedRelayUrls: string[] = []
  ): string[] {
    return resolveGroupPublishRelayUrlsValue(relays, seedRelayUrls);
  }

  async function resolveLoggedInPublishRelayUrls(seedRelayUrls: string[] = []): Promise<string[]> {
    const relayUrls = normalizeRelayStatusUrls([
      ...getAppRelayUrls(),
      ...inputSanitizerService.normalizeStringArray(seedRelayUrls),
    ]);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return relayUrls;
    }

    await contactsService.init();
    const loggedInContact = await contactsService.getContactByPublicKey(loggedInPubkeyHex);

    return normalizeRelayStatusUrls([
      ...relayUrls,
      ...normalizeWritableRelayUrls(loggedInContact?.relays),
    ]);
  }

  async function resolvePrivateContactListReadRelayUrls(
    seedRelayUrls: string[] = []
  ): Promise<string[]> {
    return resolveLoggedInReadRelayUrls(seedRelayUrls);
  }

  async function resolvePrivateContactListPublishRelayUrls(
    seedRelayUrls: string[] = []
  ): Promise<string[]> {
    return resolveLoggedInPublishRelayUrls(seedRelayUrls);
  }

  function normalizeUniquePubkeys(pubkeys: string[]): string[] {
    return pubkeys
      .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
      .filter((pubkey): pubkey is string => Boolean(pubkey))
      .filter((pubkey, index, list) => list.indexOf(pubkey) === index);
  }

  function buildPrivateContactListTags(pubkeys: string[]): string[][] {
    return normalizeUniquePubkeys(pubkeys).map((pubkey) => ['p', pubkey]);
  }

  function buildMuteListTags(mutedPubkeys: string[], blockedPubkeys: string[]): string[][] {
    const normalizedBlockedPubkeys = normalizeUniquePubkeys(blockedPubkeys);
    const blockedPubkeySet = new Set(normalizedBlockedPubkeys);
    const normalizedMutedPubkeys = normalizeUniquePubkeys(mutedPubkeys).filter(
      (pubkey) => !blockedPubkeySet.has(pubkey)
    );

    return [
      ...normalizedMutedPubkeys.map((pubkey) => ['p', pubkey]),
      ...normalizedBlockedPubkeys.map((pubkey) => ['bp', pubkey]),
    ];
  }

  function parsePrivateContactListPubkeysByTag(value: unknown, tagName: 'p' | 'bp'): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const pubkeys = value
      .map((entry) => {
        if (!Array.isArray(entry) || entry[0] !== tagName) {
          return null;
        }

        return inputSanitizerService.normalizeHexKey(String(entry[1] ?? ''));
      })
      .filter((pubkey): pubkey is string => Boolean(pubkey));

    return pubkeys.filter((pubkey, index, list) => list.indexOf(pubkey) === index);
  }

  function parsePrivateContactListPubkeys(value: unknown): string[] {
    return parsePrivateContactListPubkeysByTag(value, 'p');
  }

  async function encryptPrivateContactListTags(tags: string[][]): Promise<string> {
    const user = await getLoggedInSignerUser();
    ndk.assertSigner();

    return ndk.signer.encrypt(user, JSON.stringify(tags), 'nip44');
  }

  async function decryptPrivateContactListJson(content: string): Promise<unknown> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return [];
    }

    const user = await getLoggedInSignerUser();
    ndk.assertSigner();

    const decryptedContent = await ndk.signer.decrypt(user, normalizedContent, 'nip44');
    let parsed: unknown;

    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      return [];
    }

    return parsed;
  }

  async function decryptPrivateContactListContent(content: string): Promise<string[]> {
    const parsed = await decryptPrivateContactListJson(content);
    return parsePrivateContactListPubkeys(parsed);
  }

  async function decryptMuteListContent(content: string): Promise<MuteListContent> {
    const parsed = await decryptPrivateContactListJson(content);
    return {
      mutedPubkeys: parsePrivateContactListPubkeysByTag(parsed, 'p'),
      blockedPubkeys: parsePrivateContactListPubkeysByTag(parsed, 'bp'),
    };
  }

  function parseContactProfileEvent(event: Pick<NDKEvent, 'content'>): NDKUserProfile | null {
    const content = event.content?.trim() ?? '';
    if (!content) {
      return null;
    }

    try {
      const parsed = JSON.parse(content);
      return isPlainRecord(parsed) ? (parsed as NDKUserProfile) : null;
    } catch {
      return null;
    }
  }

  function extractContactProfileEventStateFromProfile(
    profile: NDKUserProfile | null
  ): ContactProfileEventState | null {
    const rawProfileEvent = profile?.profileEvent;
    if (typeof rawProfileEvent !== 'string' || !rawProfileEvent.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawProfileEvent);
      if (!isPlainRecord(parsed)) {
        return null;
      }

      return {
        createdAt:
          Number.isInteger(parsed.created_at) || typeof parsed.created_at === 'number'
            ? Number(parsed.created_at)
            : 0,
        eventId: typeof parsed.id === 'string' ? parsed.id.trim() : '',
      };
    } catch {
      return null;
    }
  }

  function buildContactRelayListEventState(
    event: Pick<NDKEvent, 'created_at' | 'id'>
  ): ContactRelayListEventState {
    return {
      createdAt: Number(event.created_at ?? 0),
      eventId: event.id?.trim() ?? '',
    };
  }

  function buildContactProfileEventState(
    event: Pick<NDKEvent, 'created_at' | 'id'>
  ): ContactProfileEventState {
    return {
      createdAt: Number(event.created_at ?? 0),
      eventId: event.id?.trim() ?? '',
    };
  }

  return {
    buildContactProfileEventState,
    buildContactRelayListEventState,
    buildMuteListTags,
    buildPrivateContactListTags,
    decryptMuteListContent,
    decryptPrivateContactListContent,
    encryptPrivateContactListTags,
    extractContactProfileEventStateFromProfile,
    fetchContactProfile,
    fetchContactRelayList,
    getAppRelayUrls,
    listTrackedContactPubkeys,
    normalizeWritableRelayUrls,
    parseContactProfileEvent,
    refreshContactRelayList,
    refreshGroupRelayListsOnStartup,
    resolveContactRelayListReadRelayUrls,
    resolveGroupPublishRelayUrls,
    resolveLoggedInPublishRelayUrls,
    resolveLoggedInReadRelayUrls,
    resolvePrivateContactListPublishRelayUrls,
    resolvePrivateContactListReadRelayUrls,
    resolvePrivateMessageReadRelayUrls,
    resolveTrackedContactReadRelayUrls,
  };
}
