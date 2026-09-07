import type NDK from '@nostr-dev-kit/ndk';
import type { NDKUser, NDKUserProfile } from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { BACKGROUND_GROUP_CONTACT_REFRESH_COOLDOWN_MS } from 'src/stores/nostr/constants';
import type {
  ContactProfileEventState,
  ContactRefreshLifecycle,
  ContactRelayListFetchResult,
  UserProfileLookupResult,
} from 'src/stores/nostr/types';
import type { ContactMetadata, ContactRecord, ContactRelay } from 'src/types/contact';

interface ContactProfileRuntimeDeps {
  applyContactProfileEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState: ContactProfileEventState | null | undefined
  ) => ContactMetadata;
  applyContactRelayListEventStateToMeta: (
    meta: ContactMetadata | undefined,
    eventState:
      | {
          createdAt: number;
          eventId: string;
        }
      | null
      | undefined
  ) => ContactMetadata;
  backgroundGroupContactRefreshStartedAt: Map<string, number>;
  buildIdentifierFallbacks: (pubkeyHex: string, existingMeta?: ContactMetadata) => string[];
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
  ensureContactListedInPrivateContactList: (
    targetPubkeyHex: string,
    options?: {
      fallbackName?: string;
      type?: 'user' | 'group';
    }
  ) => Promise<{
    contact: ContactRecord | null;
    didChange: boolean;
  }>;
  fetchContactProfile: (
    pubkeyHex: string,
    options?: {
      ignoreStoredSince?: boolean;
      onlyExplicitRelayEntries?: boolean;
      relayEntries?: ContactRelay[];
      seedRelayUrls?: string[];
    }
  ) => Promise<{
    eventState: ContactProfileEventState | null;
    profile: NDKUserProfile | null;
  }>;
  fetchContactRelayList: (
    pubkeyHex: string,
    seedRelayUrls?: string[]
  ) => Promise<ContactRelayListFetchResult | null>;
  getAppRelayUrls: () => string[];
  getLoggedInPublicKeyHex: () => string | null;
  groupContactRefreshPromises: Map<string, Promise<ContactRecord | null>>;
  isContactListedInPrivateContactList: (contact: ContactRecord | null | undefined) => boolean;
  isPubkeyBlocked: (pubkeyHex: string) => boolean;
  markContactProfileEventApplied: (pubkeyHex: string, eventState: ContactProfileEventState) => void;
  markContactRelayListEventApplied: (
    pubkeyHex: string,
    eventState: {
      createdAt: number;
      eventId: string;
    }
  ) => void;
  ndk: NDK;
  publishPrivateContactList: (seedRelayUrls?: string[]) => Promise<void>;
  readContactRelayListEventSince: (meta: ContactMetadata | undefined) => number | null;
  refreshContactRelayList: (
    pubkeyHex: string,
    seedRelayUrls?: string[]
  ) => Promise<ContactRelay[] | null>;
  resolveGroupDisplayName: (groupPublicKey: string) => string;
  shouldPreserveExistingGroupRelays: (
    contact: Pick<ContactRecord, 'type' | 'public_key' | 'relays'> | null | undefined,
    nextRelayEntries: ContactRelay[] | undefined
  ) => boolean;
}

export function createContactProfileRuntime({
  applyContactProfileEventStateToMeta,
  applyContactRelayListEventStateToMeta,
  backgroundGroupContactRefreshStartedAt,
  buildIdentifierFallbacks,
  buildUpdatedContactMeta,
  bumpContactListVersion,
  chatStore,
  contactMetadataEqual,
  contactRelayListsEqual,
  ensureContactListedInPrivateContactList,
  fetchContactProfile,
  fetchContactRelayList,
  getAppRelayUrls,
  getLoggedInPublicKeyHex,
  groupContactRefreshPromises,
  isContactListedInPrivateContactList,
  isPubkeyBlocked,
  markContactProfileEventApplied,
  markContactRelayListEventApplied,
  ndk,
  publishPrivateContactList,
  readContactRelayListEventSince,
  refreshContactRelayList,
  resolveGroupDisplayName,
  shouldPreserveExistingGroupRelays,
}: ContactProfileRuntimeDeps) {
  async function resolveUserByIdentifiers(
    identifiers: string[],
    expectedPubkeyHex: string
  ): Promise<NDKUser | undefined> {
    for (const identifier of identifiers) {
      try {
        const user = await ndk.fetchUser(identifier, true);
        if (!user) {
          continue;
        }

        const resolvedPubkey = inputSanitizerService.normalizeHexKey(user.pubkey);
        if (!resolvedPubkey || resolvedPubkey !== expectedPubkeyHex) {
          continue;
        }

        return user;
      } catch {}
    }

    return undefined;
  }

  async function refreshContactByPublicKey(
    targetPubkeyHex: string,
    fallbackName = '',
    lifecycle: ContactRefreshLifecycle = {}
  ): Promise<void> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    if (!normalizedTargetPubkey) {
      return;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedTargetPubkey);
    if (isPubkeyBlocked(normalizedTargetPubkey) || existingContact?.meta.blocked === true) {
      return;
    }

    const identifiers = buildIdentifierFallbacks(normalizedTargetPubkey, existingContact?.meta);
    const resolvedUser = await resolveUserByIdentifiers(identifiers, normalizedTargetPubkey);
    if (!resolvedUser && !existingContact) {
      return;
    }

    let resolvedNpub = existingContact?.meta.npub?.trim() ?? '';
    if (!resolvedNpub && resolvedUser) {
      try {
        resolvedNpub = resolvedUser.npub;
      } catch {
        resolvedNpub = '';
      }
    }

    let resolvedNprofile = existingContact?.meta.nprofile?.trim() ?? '';
    if (!resolvedNprofile && resolvedUser) {
      try {
        resolvedNprofile = resolvedUser.nprofile;
      } catch {
        resolvedNprofile = '';
      }
    }

    const shouldRefreshRelayList =
      lifecycle.refreshRelayList === true ||
      existingContact?.type === 'group' ||
      readContactRelayListEventSince(existingContact?.meta) === null;
    let explicitRelayList: ContactRelayListFetchResult | null = null;
    let relayError: unknown | null = null;
    if (shouldRefreshRelayList) {
      lifecycle.onRelayFetchStart?.();
      try {
        explicitRelayList = await fetchContactRelayList(
          normalizedTargetPubkey,
          lifecycle.relayListSeedRelayUrls
        );
      } catch (error) {
        relayError = error;
        console.warn('Failed to fetch relay list for contact', normalizedTargetPubkey, error);
      } finally {
        lifecycle.onRelayFetchEnd?.(relayError);
      }
    }

    const fallbackRelayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(
      resolvedUser?.relayUrls ?? []
    );
    let fetchedProfile: NDKUserProfile | null = null;
    let fetchedProfileEventState: ContactProfileEventState | null = null;
    let profileError: unknown | null = null;
    lifecycle.onProfileFetchStart?.();
    try {
      const fetchedProfileResult = await fetchContactProfile(normalizedTargetPubkey, {
        relayEntries:
          explicitRelayList?.relayEntries ??
          (fallbackRelayEntries.length > 0 ? fallbackRelayEntries : existingContact?.relays),
        seedRelayUrls: lifecycle.relayListSeedRelayUrls,
      });
      fetchedProfile = fetchedProfileResult.profile;
      fetchedProfileEventState = fetchedProfileResult.eventState;
    } catch (error) {
      profileError = error;
      console.warn('Failed to fetch profile metadata for contact', normalizedTargetPubkey, error);
    } finally {
      lifecycle.onProfileFetchEnd?.(profileError);
    }

    const baseNextMeta = buildUpdatedContactMeta(
      existingContact?.meta,
      fetchedProfile,
      resolvedNpub,
      resolvedNprofile
    );
    const nextMetaWithProfileState = applyContactProfileEventStateToMeta(
      baseNextMeta,
      fetchedProfileEventState
    );
    const nextMeta =
      explicitRelayList !== null
        ? applyContactRelayListEventStateToMeta(nextMetaWithProfileState, {
            createdAt: explicitRelayList.createdAt,
            eventId: explicitRelayList.eventId,
          })
        : nextMetaWithProfileState;

    const fallbackContactName = fallbackName.trim() || normalizedTargetPubkey.slice(0, 16);
    const nextName =
      baseNextMeta.display_name?.trim() ||
      baseNextMeta.name?.trim() ||
      existingContact?.name?.trim() ||
      fallbackContactName;
    const nextRelays =
      explicitRelayList !== null
        ? explicitRelayList.relayEntries
        : fallbackRelayEntries.length > 0
          ? fallbackRelayEntries
          : (existingContact?.relays ?? []);
    const effectiveNextRelays = shouldPreserveExistingGroupRelays(existingContact, nextRelays)
      ? (existingContact?.relays ?? [])
      : nextRelays;

    const didChangeContact =
      !existingContact ||
      existingContact.name !== nextName ||
      !contactMetadataEqual(existingContact.meta, baseNextMeta) ||
      !contactRelayListsEqual(existingContact.relays, effectiveNextRelays);

    if (existingContact) {
      const updatedContact = await contactsService.updateContact(existingContact.id, {
        name: nextName,
        meta: nextMeta,
        relays: effectiveNextRelays,
      });
      if (!updatedContact) {
        return;
      }
      await chatStore.syncContactProfile(normalizedTargetPubkey);
      if (fetchedProfileEventState) {
        markContactProfileEventApplied(normalizedTargetPubkey, fetchedProfileEventState);
      }
      if (explicitRelayList !== null) {
        markContactRelayListEventApplied(normalizedTargetPubkey, {
          createdAt: explicitRelayList.createdAt,
          eventId: explicitRelayList.eventId,
        });
      }
      if (didChangeContact) {
        bumpContactListVersion();
      }
      return;
    }

    const createdContact = await contactsService.createContact({
      public_key: normalizedTargetPubkey,
      name: nextName,
      given_name: null,
      meta: nextMeta,
      relays: nextRelays,
    });
    if (!createdContact) {
      return;
    }
    await chatStore.syncContactProfile(normalizedTargetPubkey);
    if (fetchedProfileEventState) {
      markContactProfileEventApplied(normalizedTargetPubkey, fetchedProfileEventState);
    }
    if (explicitRelayList !== null) {
      markContactRelayListEventApplied(normalizedTargetPubkey, {
        createdAt: explicitRelayList.createdAt,
        eventId: explicitRelayList.eventId,
      });
    }
    bumpContactListVersion();
  }

  async function ensureContactStoredAsGroup(
    groupPublicKey: string,
    options: {
      fallbackName?: string;
      relays?: ContactRelay[];
    } = {}
  ): Promise<ContactRecord | null> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      return null;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    const fallbackName =
      options.fallbackName?.trim() ||
      existingContact?.name?.trim() ||
      resolveGroupDisplayName(normalizedGroupPublicKey);

    if (!existingContact) {
      const createdContact = await contactsService.createContact({
        public_key: normalizedGroupPublicKey,
        type: 'group',
        name: fallbackName,
        given_name: null,
        ...(options.relays ? { relays: options.relays } : {}),
      });
      if (createdContact) {
        bumpContactListVersion();
      }
      return createdContact;
    }

    const shouldUpdateType = existingContact.type !== 'group';
    const shouldUpdateName = existingContact.name !== fallbackName;
    const shouldUpdateRelays =
      options.relays !== undefined &&
      !contactRelayListsEqual(existingContact.relays, options.relays);

    if (!shouldUpdateType && !shouldUpdateName && !shouldUpdateRelays) {
      return existingContact;
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      ...(shouldUpdateType ? { type: 'group' as const } : {}),
      ...(shouldUpdateName ? { name: fallbackName } : {}),
      ...(shouldUpdateRelays ? { relays: options.relays } : {}),
    });
    if (updatedContact) {
      bumpContactListVersion();
    }

    return updatedContact ?? existingContact;
  }

  async function refreshGroupContactByPublicKey(
    groupPublicKey: string,
    fallbackName = '',
    seedRelayUrls: string[] = []
  ): Promise<ContactRecord | null> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      return null;
    }

    const pendingRefresh = groupContactRefreshPromises.get(normalizedGroupPublicKey);
    if (pendingRefresh) {
      return pendingRefresh;
    }

    const refreshPromise = (async (): Promise<ContactRecord | null> => {
      try {
        await refreshContactByPublicKey(normalizedGroupPublicKey, fallbackName, {
          refreshRelayList: false,
          relayListSeedRelayUrls: seedRelayUrls,
        });
      } catch (error) {
        console.warn('Failed to refresh group contact profile', normalizedGroupPublicKey, error);
      }

      const contact = await ensureContactStoredAsGroup(normalizedGroupPublicKey, {
        fallbackName,
      });
      try {
        await refreshContactRelayList(normalizedGroupPublicKey, seedRelayUrls);
      } catch (error) {
        console.warn('Failed to refresh group contact relay list', normalizedGroupPublicKey, error);
      }
      if (contact) {
        await chatStore.syncContactProfile(normalizedGroupPublicKey);
      }

      return contact;
    })().finally(() => {
      groupContactRefreshPromises.delete(normalizedGroupPublicKey);
    });

    groupContactRefreshPromises.set(normalizedGroupPublicKey, refreshPromise);
    return refreshPromise;
  }

  function queueBackgroundGroupContactRefresh(
    groupPublicKey: string,
    fallbackName = '',
    seedRelayUrls: string[] = []
  ): void {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      return;
    }

    if (groupContactRefreshPromises.has(normalizedGroupPublicKey)) {
      return;
    }

    const now = Date.now();
    const lastStartedAt = backgroundGroupContactRefreshStartedAt.get(normalizedGroupPublicKey) ?? 0;
    if (now - lastStartedAt < BACKGROUND_GROUP_CONTACT_REFRESH_COOLDOWN_MS) {
      return;
    }

    backgroundGroupContactRefreshStartedAt.set(normalizedGroupPublicKey, now);
    void refreshGroupContactByPublicKey(
      normalizedGroupPublicKey,
      fallbackName,
      seedRelayUrls
    ).catch((error) => {
      console.warn(
        'Failed to refresh group contact after epoch ticket',
        normalizedGroupPublicKey,
        error
      );
    });
  }

  async function fetchContactPreviewByPublicKey(
    targetPubkeyHex: string,
    fallbackName = '',
    options: {
      relayEntries?: ContactRelay[];
      seedRelayUrls?: string[];
    } = {}
  ): Promise<Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'> | null> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    if (!normalizedTargetPubkey) {
      return null;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedTargetPubkey);
    const identifiers = buildIdentifierFallbacks(normalizedTargetPubkey, existingContact?.meta);
    const resolvedUser = await resolveUserByIdentifiers(identifiers, normalizedTargetPubkey);

    let explicitRelayList: ContactRelayListFetchResult | null = null;
    if (inputSanitizerService.normalizeStringArray(options.seedRelayUrls ?? []).length > 0) {
      try {
        explicitRelayList = await fetchContactRelayList(
          normalizedTargetPubkey,
          options.seedRelayUrls
        );
      } catch (error) {
        console.warn(
          'Failed to fetch transient relay list metadata for contact preview',
          normalizedTargetPubkey,
          error
        );
      }
    }

    let fetchedProfile: NDKUserProfile | null = null;
    const seedRelayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(
      options.seedRelayUrls ?? []
    );
    const fallbackRelayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(
      resolvedUser?.relayUrls ?? []
    );
    const relayEntries =
      explicitRelayList?.relayEntries ??
      options.relayEntries ??
      (seedRelayEntries.length > 0 ? seedRelayEntries : undefined) ??
      (fallbackRelayEntries.length > 0 ? fallbackRelayEntries : existingContact?.relays);
    if (resolvedUser || relayEntries) {
      try {
        const fetchedProfileResult = await fetchContactProfile(normalizedTargetPubkey, {
          relayEntries,
          seedRelayUrls: options.seedRelayUrls,
        });
        fetchedProfile = fetchedProfileResult.profile;
      } catch (error) {
        console.warn(
          'Failed to fetch transient profile metadata for contact preview',
          normalizedTargetPubkey,
          error
        );
      }
    }

    let resolvedNpub = existingContact?.meta.npub?.trim() ?? '';
    if (!resolvedNpub && resolvedUser) {
      try {
        resolvedNpub = resolvedUser.npub;
      } catch {
        resolvedNpub = '';
      }
    }

    let resolvedNprofile = existingContact?.meta.nprofile?.trim() ?? '';
    if (!resolvedNprofile && resolvedUser) {
      try {
        resolvedNprofile = resolvedUser.nprofile;
      } catch {
        resolvedNprofile = '';
      }
    }

    const nextMeta = buildUpdatedContactMeta(
      existingContact?.meta,
      fetchedProfile,
      resolvedNpub,
      resolvedNprofile
    );
    const fallbackContactName =
      fallbackName.trim() || existingContact?.name?.trim() || normalizedTargetPubkey.slice(0, 16);
    const nextName =
      nextMeta.display_name?.trim() ||
      nextMeta.name?.trim() ||
      existingContact?.name?.trim() ||
      fallbackContactName;

    return {
      public_key: normalizedTargetPubkey,
      name: nextName,
      given_name: existingContact?.given_name ?? null,
      meta: nextMeta,
    };
  }

  async function fetchUserProfileFromRelays(
    targetPubkeyHex: string,
    relayUrls: string[]
  ): Promise<UserProfileLookupResult | null> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    if (!normalizedTargetPubkey) {
      return null;
    }

    const relayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(relayUrls);
    if (relayEntries.length === 0) {
      return null;
    }

    const { eventState, profile } = await fetchContactProfile(normalizedTargetPubkey, {
      ignoreStoredSince: true,
      onlyExplicitRelayEntries: true,
      relayEntries,
    });
    if (!profile) {
      return null;
    }

    const meta = buildUpdatedContactMeta({}, profile, null, null);
    const displayName = meta.display_name?.trim() ?? '';
    const name = meta.name?.trim() ?? '';
    const fallbackName = normalizedTargetPubkey.slice(0, 16);

    return {
      publicKey: normalizedTargetPubkey,
      name: displayName || name || fallbackName,
      displayName,
      about: meta.about?.trim() ?? '',
      picture: meta.picture?.trim() ?? '',
      nip05: meta.nip05?.trim() ?? '',
      relayUrls: inputSanitizerService.normalizeReadableRelayUrls(relayEntries),
      eventCreatedAt: eventState?.createdAt ?? null,
      eventId: eventState?.eventId?.trim() || null,
    };
  }

  async function ensureRespondedPubkeyIsContact(
    targetPubkeyHex: string,
    fallbackName = ''
  ): Promise<void> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (
      !normalizedTargetPubkey ||
      !loggedInPubkeyHex ||
      normalizedTargetPubkey === loggedInPubkeyHex
    ) {
      return;
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedTargetPubkey);
    if (existingContact && isContactListedInPrivateContactList(existingContact)) {
      return;
    }

    const initialName = fallbackName.trim() || normalizedTargetPubkey.slice(0, 16);
    const ensureResult = await ensureContactListedInPrivateContactList(normalizedTargetPubkey, {
      fallbackName: initialName,
    });
    if (!ensureResult.contact) {
      return;
    }

    await chatStore.syncContactProfile(normalizedTargetPubkey);

    try {
      await refreshContactByPublicKey(normalizedTargetPubkey, initialName);
    } catch (error) {
      console.warn('Failed to refresh responded contact profile', normalizedTargetPubkey, error);
    }

    if (ensureResult.didChange) {
      try {
        await publishPrivateContactList(getAppRelayUrls());
      } catch (error) {
        console.warn(
          'Failed to publish private contact list after adding responded contact',
          normalizedTargetPubkey,
          error
        );
      }
    }
  }

  return {
    ensureContactStoredAsGroup,
    ensureRespondedPubkeyIsContact,
    fetchContactPreviewByPublicKey,
    fetchUserProfileFromRelays,
    queueBackgroundGroupContactRefresh,
    refreshContactByPublicKey,
    refreshGroupContactByPublicKey,
    resolveUserByIdentifiers,
  };
}
