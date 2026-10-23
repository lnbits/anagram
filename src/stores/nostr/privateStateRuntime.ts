import type NostrClient from '#src/lib/nostr/client.ts';
import type { NostrFilter, NostrSubscriptionOptions } from '#src/lib/nostr/client.ts';
import {
  ClientEvent,
  NostrKind,
  NostrPrivateKeySigner,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  NostrUser,
} from '#src/lib/nostr/client.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  CONTACT_CURSOR_FETCH_BATCH_SIZE,
  CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS,
  CONTACT_CURSOR_PUBLISH_DELAY_MS,
  CONTACT_CURSOR_PUBLISH_JITTER_MS,
  CONTACT_CURSOR_SYNC_TIMEOUT_MS,
  CONTACT_CURSOR_VERSION,
  GROUP_IDENTITY_SECRET_TAG,
  GROUP_MEMBERS_FOLLOW_SET_D_TAG,
  GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG,
  LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
  PRIVATE_PREFERENCES_D_TAG,
  PRIVATE_PREFERENCES_KIND,
} from '#src/stores/nostr/constants.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import {
  createReadyRelaySet,
  fetchEventsWithRelayTimeout,
  fetchEventWithRelayTimeout,
} from '#src/stores/nostr/relayQueryUtils.ts';
import type {
  ContactCursorContent,
  ContactCursorState,
  CreateGroupChatInput,
  CreateGroupChatResult,
  GroupIdentitySecretContent,
  MessageRow,
  PrivatePreferences,
  RelaySaveStatus,
} from '#src/stores/nostr/types.ts';
import {
  normalizeRelayStatusUrlsValue,
  resolveCurrentGroupChatEpochEntryValue,
  resolveGroupPublishRelayUrlsValue,
  resolveGroupReadRelayUrlsValue,
  resolveLatestReadBoundaryAtValue,
} from '#src/stores/nostr/valueUtils.ts';
import type { ContactMetadata, ContactRecord, ContactRelay } from '#src/types/contact.ts';
import {
  buildGroupMembershipFollowSetPrivateTags,
  normalizeGroupMembershipSnapshotPubkeys,
  parseGroupMembershipFollowSetPrivateTags,
} from '#src/utils/groupMembershipFollowSet.ts';
import {
  areMessageReactionsEqual,
  buildMetaWithReactions,
  countUnseenReactionsForAuthor,
  normalizeMessageReactions,
} from '#src/utils/messageReactions.ts';


interface RestoreRuntimeState {
  restoreContactCursorStatePromise: Promise<void> | null;
  restoreGroupIdentitySecretsPromise: Promise<void> | null;
  restorePrivatePreferencesPromise: Promise<void> | null;
}

interface GroupMembershipRosterRefreshResult {
  didChange: boolean;
  fallbackProfileCount: number;
  memberPublicKeys: string[];
  ownerIncluded: boolean;
  refreshedProfileCount: number;
}

const GROUP_MEMBER_PROFILE_REFRESH_RETRY_DELAY_MS = 500;
const GROUP_MEMBER_PROFILE_REFRESH_RETRY_ATTEMPTS = 4;

interface PrivateStateRuntimeDeps {
  createRecoverableGroup: (phrase: string, name: string, about: string, relays: string[]) => Promise<GroupIdentitySecretContent>;
  beginStartupStep: (stepId: any) => void;
  buildFreshPrivatePreferences: (existing?: Record<string, unknown>) => PrivatePreferences;
  buildRelaySaveStatus: (relayStatuses: any[]) => RelaySaveStatus;
  bumpContactListVersion: () => void;
  chatStore: { reload: () => Promise<void>; refreshChat: (chatId: string) => Promise<void> };
  chunkValues: <T>(values: T[], chunkSize: number) => T[][];
  compareReplaceableEventState: (
    first: Pick<ClientEvent, 'created_at' | 'id'> | null | undefined,
    second: Pick<ClientEvent, 'created_at' | 'id'> | null | undefined,
  ) => number;
  completeStartupStep: (stepId: any) => void;
  contactRelayListsEqual: (
    first: ContactRelay[] | undefined,
    second: ContactRelay[] | undefined,
  ) => boolean;
  createStartupBatchTracker: (stepId: any) => {
    beginItem: () => void;
    finishItem: (error?: unknown) => void;
    seal: () => void;
  };
  decryptContactCursorContent: (content: string) => Promise<ContactCursorContent | null>;
  decryptGroupIdentitySecretContent: (
    content: string,
  ) => Promise<GroupIdentitySecretContent | null>;
  decryptPrivatePreferencesContent: (content: string) => Promise<PrivatePreferences | null>;
  decryptPrivateStringContent: (content: string) => Promise<string | null>;
  deriveContactCursorDTag: (contactPublicKey: string) => Promise<string | null>;
  encryptContactCursorContent: (cursor: ContactCursorState) => Promise<string>;
  encryptGroupIdentitySecretContent: (content: GroupIdentitySecretContent) => Promise<string>;
  encryptPrivatePreferencesContent: (preferences: PrivatePreferences) => Promise<string>;
  ensureGroupContactAndChat: (
    groupPublicKey: string,
    encryptedPrivateKey: string,
    profile?: { name?: string; about?: string },
  ) => Promise<boolean>;
  ensureLoggedInSignerUser: () => Promise<any>;
  ensurePrivatePreferences: (options?: {
    publishIfCreated?: boolean;
  }) => Promise<PrivatePreferences>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  failStartupStep: (stepId: any, error: unknown) => void;
  fetchContactPreviewByPublicKey: (
    pubkeyHex: string,
    fallbackName?: string,
    options?: {
      relayEntries?: ContactRelay[];
      seedRelayUrls?: string[];
    },
  ) => Promise<Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'> | null>;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getStartupStepSnapshot: (stepId: any) => { status: string };
  isRestoringStartupState: boolean;
  ndk: NostrClient;
  normalizeEventId: (value: unknown) => string | null;
  normalizeTimestamp: (value: unknown) => string | null;
  pendingContactCursorPublishStates: Map<string, ContactCursorState>;
  pendingContactCursorPublishTimers: Map<string, ReturnType<typeof globalThis.setTimeout>>;
  persistIncomingGroupEpochTicket: (
    groupPublicKey: string,
    epochNumber: number,
    epochPrivateKey: string,
    options?: {
      fallbackName?: string;
      accepted?: boolean;
      invitationCreatedAt?: string | null;
      seedRelayUrls?: string[];
    },
  ) => Promise<void>;
  publishGroupRelayList: (
    groupPublicKey: string,
    relayEntries: ContactRelay[],
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus>;
  publishPrivateContactList: (seedRelayUrls?: string[]) => Promise<void>;
  publishEventWithRelayStatuses: (
    event: ClientEvent,
    relayUrls: string[],
    scope?: 'recipient' | 'self',
  ) => Promise<{ relayStatuses: any[]; error: Error | null }>;
  publishReplaceableEventWithRelayStatuses: (
    event: ClientEvent,
    relayUrls: string[],
    scope?: 'recipient' | 'self',
  ) => Promise<{ relayStatuses: any[]; error: Error | null }>;
  queueTrackedContactSubscriptionsRefresh: () => void;
  readPrivatePreferencesFromStorage: () => PrivatePreferences | null;
  refreshContactRelayList: (
    pubkeyHex: string,
    seedRelayUrls?: string[],
  ) => Promise<ContactRelay[] | null>;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  restoreState: RestoreRuntimeState;
  scheduleChatChecks: (chatIds?: string[], options?: { allChats?: boolean }) => void;
  sha256Hex: (value: string) => Promise<string>;
  shouldApplyPrivateContactListEvent: (event: ClientEvent) => boolean;
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
  toComparableTimestamp: (value: string | null | undefined) => number;
  toIsoTimestampFromUnix: (value: number | undefined) => string;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  writePrivatePreferencesToStorage: (preferences: PrivatePreferences) => void;
}

export function createPrivateStateRuntime({
  createRecoverableGroup,
  beginStartupStep,
  buildRelaySaveStatus,
  bumpContactListVersion,
  chatStore,
  chunkValues,
  compareReplaceableEventState,
  completeStartupStep,
  contactRelayListsEqual,
  decryptContactCursorContent,
  decryptGroupIdentitySecretContent,
  decryptPrivatePreferencesContent,
  decryptPrivateStringContent,
  deriveContactCursorDTag,
  encryptContactCursorContent,
  encryptGroupIdentitySecretContent,
  encryptPrivatePreferencesContent,
  ensureGroupContactAndChat,
  ensureLoggedInSignerUser,
  ensurePrivatePreferences,
  ensureRelayConnections,
  failStartupStep,
  fetchContactPreviewByPublicKey,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getStartupStepSnapshot,
  ndk,
  normalizeEventId,
  normalizeTimestamp,
  pendingContactCursorPublishStates,
  pendingContactCursorPublishTimers,
  persistIncomingGroupEpochTicket,
  publishGroupRelayList,
  publishPrivateContactList,
  publishEventWithRelayStatuses,
  publishReplaceableEventWithRelayStatuses,

  readPrivatePreferencesFromStorage,

  refreshContactRelayList,
  resolveLoggedInPublishRelayUrls,
  resolveLoggedInReadRelayUrls,
  restoreState,
  scheduleChatChecks,
  sha256Hex,
  subscribeWithReqLogging,
  toComparableTimestamp,
  toIsoTimestampFromUnix,
  updateStoredEventSinceFromCreatedAt,
  writePrivatePreferencesToStorage,
}: PrivateStateRuntimeDeps) {
  const lastReplaceableCreatedAtByStream = new Map<string, number>();
  // Newest cursor per contact known to be on relays, whether restored, received live or
  // published here. Publishing never goes below it, so older devices cannot rewind reads.
  const knownContactCursors = new Map<string, ContactCursorState>();
  // Newest cursor event seen per contact, by created_at. Relays keep the newest event, so
  // this is our best view of what they serve; it lets devices heal a buried newer cursor.
  const latestContactCursorEvents = new Map<
    string,
    { cursor: ContactCursorState; createdAt: number }
  >();
  const contactCursorPublishQueues = new Map<string, Promise<void>>();
  const deferredContactCursorPublishes = new Set<string>();
  const contactCursorSubscriptions = createDesiredSubscriptions();
  // Last cursor event handled per d-tag. Relays keep one event per d-tag, so replays and the
  // echo of our own publish repeat the cached id and skip decryption.
  const contactCursorEvents = new Map<string, { id: string; cursor: ContactCursorContent }>();
  let contactCursorDTagIndex: {
    secret: string;
    contacts: Map<string, string>;
    publicKeys: Set<string>;
  } | null = null;
  let contactCursorApplyQueue = Promise.resolve();
  let contactCursorGeneration = 0;
  let contactCursorSince = 0;
  // Every relay in `relays` finished replaying its history and then stayed subscribed, so later
  // subscriptions to only those relays need events from `since` on. Other relays start from
  // `contactCursorSince`, as they never delivered their history here.
  let contactCursorResume: { relays: string[]; since: number } | null = null;
  // A cursor failed to apply. Until a replay from `contactCursorSince` starts, no resume point
  // is recorded, so that replay delivers the event again.
  let contactCursorApplyFailed = false;
  // The open subscription's filter, reused so a repeated call does not restart it.
  let contactCursorLiveFilter: { relays: string[]; since: number } | null = null;
  let contactCursorSeedRelayUrls: string[] | null = null;

  function allocateReplaceableCreatedAt(streamKey: string): number {
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const lastCreatedAt = lastReplaceableCreatedAtByStream.get(streamKey) ?? 0;
    const nextCreatedAt = Math.max(nowInSeconds, lastCreatedAt + 1);
    lastReplaceableCreatedAtByStream.set(streamKey, nextCreatedAt);
    return nextCreatedAt;
  }

  function compareContactCursorState(
    first: ContactCursorState | ContactCursorContent | null | undefined,
    second: ContactCursorState | ContactCursorContent | null | undefined,
  ): number {
    const firstTimestamp =
      first && 'last_seen_incoming_activity_at' in first
        ? first.last_seen_incoming_activity_at
        : first && 'at' in first
          ? first.at
          : null;
    const secondTimestamp =
      second && 'last_seen_incoming_activity_at' in second
        ? second.last_seen_incoming_activity_at
        : second && 'at' in second
          ? second.at
          : null;
    const byTimestamp =
      toComparableTimestamp(firstTimestamp) - toComparableTimestamp(secondTimestamp);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }

    const firstEventId =
      normalizeEventId(
        first && 'last_seen_incoming_activity_event_id' in first
          ? first.last_seen_incoming_activity_event_id
          : first && 'eventId' in first
            ? first.eventId
            : null,
      ) ?? '';
    const secondEventId =
      normalizeEventId(
        second && 'last_seen_incoming_activity_event_id' in second
          ? second.last_seen_incoming_activity_event_id
          : second && 'eventId' in second
            ? second.eventId
            : null,
      ) ?? '';

    return firstEventId.localeCompare(secondEventId);
  }

  function buildChatMetaWithUnseenReactionCount(
    meta: Record<string, unknown>,
    unseenReactionCount: number,
  ): Record<string, unknown> {
    const normalizedCount = Math.max(0, Math.floor(Number(unseenReactionCount) || 0));
    const nextMeta = { ...meta };

    if (normalizedCount > 0) {
      nextMeta.unseen_reaction_count = normalizedCount;
    } else {
      delete nextMeta.unseen_reaction_count;
    }

    return nextMeta;
  }

  function hasContactSeenBoundary(contact: ContactRecord): boolean {
    const contactMeta =
      contact.meta && typeof contact.meta === 'object' && !Array.isArray(contact.meta)
        ? (contact.meta as ContactMetadata)
        : {};

    return (
      toComparableTimestamp(normalizeTimestamp(contactMeta.last_seen_incoming_activity_at)) > 0
    );
  }

  async function publishPrivatePreferences(
    preferences: PrivatePreferences,
    seedRelayUrls: string[] = [],
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    const relayUrls = await resolveLoggedInPublishRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish private preferences without at least one relay.');
    }

    await ensureRelayConnections(relayUrls);
    const user = await ensureLoggedInSignerUser();

    const preferencesEvent = new ClientEvent(ndk, {
      kind: PRIVATE_PREFERENCES_KIND,
      created_at: allocateReplaceableCreatedAt(`preferences:${user.pubkey}`),
      pubkey: user.pubkey,
      content: await encryptPrivatePreferencesContent(preferences),
      tags: [['d', PRIVATE_PREFERENCES_D_TAG]],
    });

    const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
    // publishReplaceable resets created_at to the current second, losing rapid edits.
    await preferencesEvent.publish(relaySet);
    updateStoredEventSinceFromCreatedAt(preferencesEvent.created_at);
  }

  async function restorePrivatePreferences(seedRelayUrls: string[] = []): Promise<void> {
    if (restoreState.restorePrivatePreferencesPromise) {
      return restoreState.restorePrivatePreferencesPromise;
    }

    beginStartupStep('private-preferences');
    restoreState.restorePrivatePreferencesPromise = (async () => {
      try {
        const loggedInPubkeyHex = getLoggedInPublicKeyHex();
        if (!loggedInPubkeyHex) {
          completeStartupStep('private-preferences');
          return;
        }

        const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
        if (relayUrls.length === 0) {
          completeStartupStep('private-preferences');
          return;
        }

        await ensureRelayConnections(relayUrls);
        await ensureLoggedInSignerUser();

        const relaySet = createReadyRelaySet(ndk, relayUrls);
        const preferencesEvent = await fetchEventWithRelayTimeout(
          ndk,
          {
            kinds: [PRIVATE_PREFERENCES_KIND],
            authors: [loggedInPubkeyHex],
            '#d': [PRIVATE_PREFERENCES_D_TAG],
          },
          {
            cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
          },
          relaySet,
        );
        if (!preferencesEvent) {
          completeStartupStep('private-preferences');
          return;
        }

        updateStoredEventSinceFromCreatedAt(preferencesEvent.created_at);
        let decryptedPreferences: PrivatePreferences | null = null;
        try {
          decryptedPreferences = await decryptPrivatePreferencesContent(preferencesEvent.content);
        } catch (error) {
          console.warn('Failed to decrypt private preferences event', error);
          failStartupStep('private-preferences', error);
          return;
        }
        if (!decryptedPreferences) {
          completeStartupStep('private-preferences');
          return;
        }

        const streamKey = `preferences:${loggedInPubkeyHex}`;
        lastReplaceableCreatedAtByStream.set(
          streamKey,
          Math.max(
            lastReplaceableCreatedAtByStream.get(streamKey) ?? 0,
            preferencesEvent.created_at ?? 0,
          ),
        );
        writePrivatePreferencesToStorage(decryptedPreferences);
        completeStartupStep('private-preferences');
      } catch (error) {
        failStartupStep('private-preferences', error);
        throw error;
      }
    })().finally(() => {
      restoreState.restorePrivatePreferencesPromise = null;
    });

    return restoreState.restorePrivatePreferencesPromise;
  }

  async function publishGroupIdentitySecret(
    groupPublicKey: string,
    encryptedPrivateKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<RelaySaveStatus> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedEncryptedPrivateKey = encryptedPrivateKey.trim();
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey || !normalizedEncryptedPrivateKey) {
      throw new Error('A valid group identity is required.');
    }

    const relayUrls = await resolveLoggedInPublishRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish group identity secret without at least one relay.');
    }

    await ensureRelayConnections(relayUrls);
    const user = await ensureLoggedInSignerUser();

    const groupSecretEvent = new ClientEvent(ndk, {
      kind: PRIVATE_PREFERENCES_KIND,
      created_at: allocateReplaceableCreatedAt(`group-secret:${user.pubkey}:${normalizedGroupPublicKey}`),
      pubkey: user.pubkey,
      content: normalizedEncryptedPrivateKey,
      tags: [
        ['d', normalizedGroupPublicKey],
        ['t', GROUP_IDENTITY_SECRET_TAG],
      ],
    });

    const publishResult = await publishReplaceableEventWithRelayStatuses(
      groupSecretEvent,
      relayUrls,
      'self',
    );
    if (
      publishResult.relayStatuses.some(
        (entry) => entry.direction === 'outbound' && entry.status === 'published',
      )
    ) {
      updateStoredEventSinceFromCreatedAt(groupSecretEvent.created_at);
    }

    const relaySaveStatus = buildRelaySaveStatus(publishResult.relayStatuses);
    if (publishResult.error && !relaySaveStatus.errorMessage) {
      relaySaveStatus.errorMessage = publishResult.error.message;
    }

    return relaySaveStatus;
  }

  async function encryptGroupMembershipFollowSetContent(
    groupPrivateKey: string,
    groupPublicKey: string,
    memberPublicKeys: string[],
    excludedPubkeys: string[] = [],
  ): Promise<string> {
    const normalizedGroupPrivateKey = inputSanitizerService.normalizeHexKey(groupPrivateKey);
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPrivateKey || !normalizedGroupPublicKey) {
      throw new Error('A valid group identity is required.');
    }

    const groupSigner = new NostrPrivateKeySigner(normalizedGroupPrivateKey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    return groupSigner.encrypt(
      signerUser,
      JSON.stringify(
        buildGroupMembershipFollowSetPrivateTags(memberPublicKeys, [
          normalizedGroupPublicKey,
          ...excludedPubkeys,
        ]),
      ),
      'nip44',
    );
  }

  async function decryptGroupMembershipFollowSetContent(
    groupPrivateKey: string,
    groupPublicKey: string,
    content: string,
    excludedPubkeys: string[] = [],
  ): Promise<string[]> {
    const normalizedGroupPrivateKey = inputSanitizerService.normalizeHexKey(groupPrivateKey);
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedContent = content.trim();
    if (!normalizedGroupPrivateKey || !normalizedGroupPublicKey) {
      throw new Error('A valid group identity is required.');
    }

    if (!normalizedContent) {
      return [];
    }

    const groupSigner = new NostrPrivateKeySigner(normalizedGroupPrivateKey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    const decryptedContent = await groupSigner.decrypt(signerUser, normalizedContent, 'nip44');
    let parsed: unknown;

    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      return [];
    }

    return parseGroupMembershipFollowSetPrivateTags(parsed, [
      normalizedGroupPublicKey,
      ...excludedPubkeys,
    ]);
  }

  async function encryptGroupMembershipRosterContent(
    groupPrivateKey: string,
    groupPublicKey: string,
    epochPublicKey: string,
    memberPublicKeys: string[],
    excludedPubkeys: string[] = [],
  ): Promise<string> {
    const normalizedGroupPrivateKey = inputSanitizerService.normalizeHexKey(groupPrivateKey);
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedEpochPublicKey = inputSanitizerService.normalizeHexKey(epochPublicKey);
    if (!normalizedGroupPrivateKey || !normalizedGroupPublicKey || !normalizedEpochPublicKey) {
      throw new Error('A valid group identity and epoch identity are required.');
    }

    const groupSigner = new NostrPrivateKeySigner(normalizedGroupPrivateKey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    return groupSigner.encrypt(
      new NostrUser({ pubkey: normalizedEpochPublicKey }),
      JSON.stringify(
        buildGroupMembershipFollowSetPrivateTags(memberPublicKeys, [
          normalizedGroupPublicKey,
          ...excludedPubkeys,
        ]),
      ),
      'nip44',
    );
  }

  async function decryptGroupMembershipRosterContent(
    epochPrivateKey: string,
    epochPublicKey: string,
    groupPublicKey: string,
    content: string,
    excludedPubkeys: string[] = [],
  ): Promise<string[]> {
    const normalizedEpochPrivateKey = inputSanitizerService.normalizeHexKey(epochPrivateKey);
    const normalizedEpochPublicKey = inputSanitizerService.normalizeHexKey(epochPublicKey);
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedContent = content.trim();
    if (!normalizedEpochPrivateKey || !normalizedEpochPublicKey || !normalizedGroupPublicKey) {
      throw new Error('A valid epoch identity and group identity are required.');
    }

    if (!normalizedContent) {
      return [];
    }

    const epochSigner = new NostrPrivateKeySigner(normalizedEpochPrivateKey, ndk);
    const signerUser = await epochSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedEpochPublicKey) {
      throw new Error('Decrypted epoch private key does not match the current epoch public key.');
    }

    const decryptedContent = await epochSigner.decrypt(
      new NostrUser({ pubkey: normalizedGroupPublicKey }),
      normalizedContent,
      'nip44',
    );
    let parsed: unknown;

    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      return [];
    }

    return parseGroupMembershipFollowSetPrivateTags(parsed, [
      normalizedGroupPublicKey,
      ...excludedPubkeys,
    ]);
  }

  async function resolveReadableGroupMembershipRosterContext(
    groupPublicKey: string,
    seedRelayUrls: string[] = [],
    options: {
      refreshRelayList?: boolean;
    } = {},
  ): Promise<{
    currentEpochPrivateKey: string;
    currentEpochPublicKey: string;
    groupContact: ContactRecord;
    ownerPublicKey: string | null;
    relayUrls: string[];
  }> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const existingGroupContact =
      await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!existingGroupContact || existingGroupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    if (options.refreshRelayList !== false) {
      try {
        await refreshContactRelayList(normalizedGroupPublicKey, seedRelayUrls);
      } catch (error) {
        console.warn(
          'Failed to refresh group relay list before reading shared roster',
          normalizedGroupPublicKey,
          error,
        );
      }
    }

    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const groupChat = await chatDataService.getChatByPublicKey(normalizedGroupPublicKey);
    if (!groupChat || groupChat.type !== 'group') {
      throw new Error('Group chat not found.');
    }

    const currentEpochEntry = resolveCurrentGroupChatEpochEntryValue(groupChat);
    const currentEpochPublicKey = inputSanitizerService.normalizeHexKey(
      currentEpochEntry?.epoch_public_key ?? '',
    );
    const encryptedCurrentEpochPrivateKey =
      currentEpochEntry?.epoch_private_key_encrypted?.trim() ?? '';
    if (!currentEpochPublicKey || !encryptedCurrentEpochPrivateKey) {
      throw new Error('Current epoch key is not available for this group.');
    }

    const currentEpochPrivateKey = await decryptPrivateStringContent(
      encryptedCurrentEpochPrivateKey,
    );
    if (!currentEpochPrivateKey) {
      throw new Error('Failed to decrypt the current epoch private key.');
    }
    const currentEpochSigner = new NostrPrivateKeySigner(currentEpochPrivateKey, ndk);
    const currentEpochUser = await currentEpochSigner.user();
    if (inputSanitizerService.normalizeHexKey(currentEpochUser.pubkey) !== currentEpochPublicKey) {
      throw new Error('Decrypted epoch private key does not match the current epoch public key.');
    }

    const relayUrls = resolveGroupReadRelayUrlsValue(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot read the shared roster without at least one group relay.');
    }

    return {
      currentEpochPrivateKey,
      currentEpochPublicKey,
      groupContact,
      ownerPublicKey: inputSanitizerService.normalizeHexKey(
        groupContact.meta.owner_public_key ?? '',
      ),
      relayUrls,
    };
  }

  async function listGroupMembershipRosterSubscriptionContexts(
    seedRelayUrls: string[] = [],
  ): Promise<
    Array<{
      currentEpochPublicKey: string;
      groupPublicKey: string;
      relayUrls: string[];
    }>
  > {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return [];
    }

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const chats = await chatDataService.listChats();
    const contexts: Array<{
      currentEpochPublicKey: string;
      groupPublicKey: string;
      relayUrls: string[];
    }> = [];

    for (const chat of chats) {
      if (chat.type !== 'group') {
        continue;
      }

      const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(chat.public_key);
      if (!normalizedGroupPublicKey) {
        continue;
      }

      const currentEpochEntry = resolveCurrentGroupChatEpochEntryValue(chat);
      const currentEpochPublicKey = inputSanitizerService.normalizeHexKey(
        currentEpochEntry?.epoch_public_key ?? '',
      );
      if (!currentEpochPublicKey) {
        continue;
      }

      const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
      if (!groupContact || groupContact.type !== 'group') {
        continue;
      }

      const relayUrls = resolveGroupReadRelayUrlsValue(groupContact.relays, seedRelayUrls);
      if (relayUrls.length === 0) {
        continue;
      }

      contexts.push({
        currentEpochPublicKey,
        groupPublicKey: normalizedGroupPublicKey,
        relayUrls,
      });
    }

    return contexts.sort((first, second) =>
      first.groupPublicKey.localeCompare(second.groupPublicKey),
    );
  }

  async function fetchGroupMembershipFollowSetPubkeys(
    groupPublicKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<string[]> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const existingGroupContact =
      await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!existingGroupContact || existingGroupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      existingGroupContact.meta.owner_public_key ?? '',
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can refresh the group member list.');
    }

    const encryptedGroupPrivateKey =
      existingGroupContact.meta.group_private_key_encrypted?.trim() ?? '';
    if (!encryptedGroupPrivateKey) {
      throw new Error('Encrypted group private key not found.');
    }

    const decryptedSecret = await decryptGroupIdentitySecretContent(encryptedGroupPrivateKey);
    if (
      !decryptedSecret ||
      inputSanitizerService.normalizeHexKey(decryptedSecret.group_pubkey) !==
        normalizedGroupPublicKey
    ) {
      throw new Error('Failed to decrypt the group private key.');
    }

    try {
      await refreshContactRelayList(normalizedGroupPublicKey);
    } catch (error) {
      console.warn(
        'Failed to refresh group relay list before refreshing group members',
        normalizedGroupPublicKey,
        error,
      );
    }

    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const relayUrls = resolveGroupPublishRelayUrlsValue(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot refresh group members without at least one group relay.');
    }

    await ensureRelayConnections(relayUrls);

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const listEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NostrKind.FollowSet],
        authors: [normalizedGroupPublicKey],
        '#d': [GROUP_MEMBERS_FOLLOW_SET_D_TAG],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet,
    );
    if (!listEvent) {
      throw new Error('Published group member list not found on relays.');
    }

    updateStoredEventSinceFromCreatedAt(listEvent.created_at);

    return decryptGroupMembershipFollowSetContent(
      decryptedSecret.group_privkey,
      normalizedGroupPublicKey,
      listEvent.content,
      [normalizedOwnerPublicKey],
    );
  }

  async function fetchGroupMembershipRosterPubkeys(
    groupPublicKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<string[]> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!getLoggedInPublicKeyHex()) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    const context = await resolveReadableGroupMembershipRosterContext(
      normalizedGroupPublicKey,
      seedRelayUrls,
    );
    await ensureRelayConnections(context.relayUrls);

    const relaySet = createReadyRelaySet(ndk, context.relayUrls);
    const listEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NostrKind.FollowSet],
        authors: [normalizedGroupPublicKey],
        '#d': [GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet,
    );
    if (!listEvent) {
      throw new Error('Published group roster not found on relays.');
    }

    updateStoredEventSinceFromCreatedAt(listEvent.created_at);

    return decryptGroupMembershipRosterContent(
      context.currentEpochPrivateKey,
      context.currentEpochPublicKey,
      normalizedGroupPublicKey,
      listEvent.content,
    );
  }

  async function publishGroupMembershipFollowSet(
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls: string[] = [],
  ): Promise<RelaySaveStatus> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? '',
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can publish the group member list.');
    }

    const encryptedGroupPrivateKey = groupContact.meta.group_private_key_encrypted?.trim() ?? '';
    if (!encryptedGroupPrivateKey) {
      throw new Error('Encrypted group private key not found.');
    }

    const decryptedSecret = await decryptGroupIdentitySecretContent(encryptedGroupPrivateKey);
    if (
      !decryptedSecret ||
      inputSanitizerService.normalizeHexKey(decryptedSecret.group_pubkey) !==
        normalizedGroupPublicKey
    ) {
      throw new Error('Failed to decrypt the group private key.');
    }

    const relayUrls = resolveGroupPublishRelayUrlsValue(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish group member list without at least one group relay.');
    }

    await ensureRelayConnections(relayUrls);

    const createdAt = allocateReplaceableCreatedAt(
      `${normalizedGroupPublicKey}:${GROUP_MEMBERS_FOLLOW_SET_D_TAG}`,
    );
    const listEvent = new ClientEvent(ndk, {
      kind: NostrKind.FollowSet,
      created_at: createdAt,
      pubkey: normalizedGroupPublicKey,
      content: await encryptGroupMembershipFollowSetContent(
        decryptedSecret.group_privkey,
        normalizedGroupPublicKey,
        memberPublicKeys,
        [normalizedOwnerPublicKey],
      ),
      tags: [['d', GROUP_MEMBERS_FOLLOW_SET_D_TAG]],
    });

    const groupSigner = new NostrPrivateKeySigner(decryptedSecret.group_privkey, ndk);
    await listEvent.sign(groupSigner);

    const publishResult = await publishEventWithRelayStatuses(listEvent, relayUrls, 'self');
    if (
      publishResult.relayStatuses.some(
        (entry) => entry.direction === 'outbound' && entry.status === 'published',
      )
    ) {
      updateStoredEventSinceFromCreatedAt(listEvent.created_at);
    }

    const relaySaveStatus = buildRelaySaveStatus(publishResult.relayStatuses);
    if (publishResult.error && !relaySaveStatus.errorMessage) {
      relaySaveStatus.errorMessage = publishResult.error.message;
    }

    if (publishResult.error && relaySaveStatus.publishedRelayUrls.length === 0) {
      throw publishResult.error;
    }

    return relaySaveStatus;
  }

  async function publishGroupMembershipRosterFollowSet(
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls: string[] = [],
  ): Promise<RelaySaveStatus> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? '',
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can publish the group roster.');
    }

    const encryptedGroupPrivateKey = groupContact.meta.group_private_key_encrypted?.trim() ?? '';
    if (!encryptedGroupPrivateKey) {
      throw new Error('Encrypted group private key not found.');
    }

    const decryptedSecret = await decryptGroupIdentitySecretContent(encryptedGroupPrivateKey);
    if (
      !decryptedSecret ||
      inputSanitizerService.normalizeHexKey(decryptedSecret.group_pubkey) !==
        normalizedGroupPublicKey
    ) {
      throw new Error('Failed to decrypt the group private key.');
    }

    const currentEpochPrivateKey = inputSanitizerService.normalizeHexKey(
      decryptedSecret.epoch_privkey ?? '',
    );
    if (!currentEpochPrivateKey) {
      throw new Error('Current epoch private key not found.');
    }

    const currentEpochSigner = new NostrPrivateKeySigner(currentEpochPrivateKey, ndk);
    const currentEpochUser = await currentEpochSigner.user();
    const currentEpochPublicKey = inputSanitizerService.normalizeHexKey(currentEpochUser.pubkey);
    if (!currentEpochPublicKey) {
      throw new Error('Current epoch public key not found.');
    }

    const relayUrls = resolveGroupPublishRelayUrlsValue(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish the group roster without at least one group relay.');
    }

    await ensureRelayConnections(relayUrls);

    const rosterPubkeys = Array.from(new Set([normalizedOwnerPublicKey, ...memberPublicKeys]));
    const createdAt = allocateReplaceableCreatedAt(
      `${normalizedGroupPublicKey}:${GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG}`,
    );
    const listEvent = new ClientEvent(ndk, {
      kind: NostrKind.FollowSet,
      created_at: createdAt,
      pubkey: normalizedGroupPublicKey,
      content: await encryptGroupMembershipRosterContent(
        decryptedSecret.group_privkey,
        normalizedGroupPublicKey,
        currentEpochPublicKey,
        rosterPubkeys,
      ),
      tags: [['d', GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG]],
    });

    const groupSigner = new NostrPrivateKeySigner(decryptedSecret.group_privkey, ndk);
    await listEvent.sign(groupSigner);

    const publishResult = await publishEventWithRelayStatuses(listEvent, relayUrls, 'self');
    if (
      publishResult.relayStatuses.some(
        (entry) => entry.direction === 'outbound' && entry.status === 'published',
      )
    ) {
      updateStoredEventSinceFromCreatedAt(listEvent.created_at);
    }

    const relaySaveStatus = buildRelaySaveStatus(publishResult.relayStatuses);
    if (publishResult.error && !relaySaveStatus.errorMessage) {
      relaySaveStatus.errorMessage = publishResult.error.message;
    }

    if (publishResult.error && relaySaveStatus.publishedRelayUrls.length === 0) {
      throw publishResult.error;
    }

    return relaySaveStatus;
  }

  function buildStoredGroupMemberFromContact(
    memberPublicKey: string,
    storedContact: Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'> | null,
    existingMember: NonNullable<ContactMetadata['group_members']>[number] | null,
  ): NonNullable<ContactMetadata['group_members']>[number] {
    const fallbackName =
      existingMember?.name?.trim() || storedContact?.name?.trim() || memberPublicKey.slice(0, 16);
    const about = storedContact?.meta?.about?.trim() || existingMember?.about?.trim() || '';
    const picture = storedContact?.meta?.picture?.trim() || existingMember?.picture?.trim() || '';
    const avatar = storedContact?.meta?.avatar?.trim() || existingMember?.avatar?.trim() || '';
    const nip05 = storedContact?.meta?.nip05?.trim() || existingMember?.nip05?.trim() || '';
    const nprofile =
      storedContact?.meta?.nprofile?.trim() || existingMember?.nprofile?.trim() || '';

    return {
      public_key: memberPublicKey,
      name:
        storedContact?.meta?.name?.trim() ||
        storedContact?.meta?.display_name?.trim() ||
        storedContact?.name?.trim() ||
        fallbackName,
      ...(storedContact?.given_name?.trim() || existingMember?.given_name?.trim()
        ? {
            given_name:
              storedContact?.given_name?.trim() || existingMember?.given_name?.trim() || null,
          }
        : {}),
      ...(about ? { about } : {}),
      ...(picture ? { picture } : {}),
      ...(avatar ? { avatar } : {}),
      ...(nip05 ? { nip05 } : {}),
      ...(nprofile ? { nprofile } : {}),
    };
  }

  async function waitForGroupMemberProfileRefreshRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, GROUP_MEMBER_PROFILE_REFRESH_RETRY_DELAY_MS);
    });
  }

  function hasResolvedGroupMemberPreview(
    previewContact: Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'>,
    fallbackName: string,
  ): boolean {
    if (
      previewContact.meta?.display_name?.trim() ||
      previewContact.meta?.name?.trim() ||
      previewContact.given_name?.trim()
    ) {
      return true;
    }

    const previewName = previewContact.name.trim();
    return (
      previewName.length > 0 &&
      previewName !== fallbackName &&
      previewName !== previewContact.public_key
    );
  }

  async function fetchGroupMemberPreviewWithRetry(
    memberPublicKey: string,
    fallbackName: string,
    seedRelayUrls: string[],
  ): Promise<Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'> | null> {
    for (let attempt = 0; attempt < GROUP_MEMBER_PROFILE_REFRESH_RETRY_ATTEMPTS; attempt += 1) {
      const previewContact = await fetchContactPreviewByPublicKey(memberPublicKey, fallbackName, {
        seedRelayUrls,
      });
      if (previewContact && hasResolvedGroupMemberPreview(previewContact, fallbackName)) {
        return previewContact;
      }

      if (attempt < GROUP_MEMBER_PROFILE_REFRESH_RETRY_ATTEMPTS - 1 && seedRelayUrls.length > 0) {
        await waitForGroupMemberProfileRefreshRetry();
        continue;
      }

      return previewContact;
    }

    return null;
  }

  async function readStoredGroupContact(groupPublicKey: string): Promise<ContactRecord | null> {
    const groupContact = await contactsService.getContactByPublicKey(groupPublicKey);
    return groupContact && groupContact.type === 'group' ? groupContact : null;
  }

  async function persistGroupContactMetaWithRetry(
    groupPublicKey: string,
    buildNextMeta: (groupContact: ContactRecord) => ContactMetadata,
  ): Promise<ContactRecord | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const groupContact = await readStoredGroupContact(groupPublicKey);
      if (!groupContact) {
        return null;
      }

      const updatedContact = await contactsService.updateContact(groupContact.id, {
        metaBase: groupContact.meta,
        meta: buildNextMeta(groupContact),
      });
      if (updatedContact) {
        return updatedContact;
      }
    }

    return null;
  }

  async function applyGroupMembershipRosterPubkeys(
    groupPublicKey: string,
    memberPubkeys: string[],
    options: {
      refreshMemberProfiles?: boolean;
      seedRelayUrls?: string[];
    } = {},
  ): Promise<GroupMembershipRosterRefreshResult> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const groupContact = await readStoredGroupContact(normalizedGroupPublicKey);
    if (!groupContact) {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? '',
    );
    const normalizedRosterPubkeys = normalizeGroupMembershipSnapshotPubkeys(memberPubkeys, [
      normalizedGroupPublicKey,
    ]);
    const ownerIncluded = Boolean(
      normalizedOwnerPublicKey && normalizedRosterPubkeys.includes(normalizedOwnerPublicKey),
    );
    const nonOwnerMemberPubkeys = normalizedRosterPubkeys.filter(
      (memberPublicKey) => memberPublicKey !== normalizedOwnerPublicKey,
    );

    const existingMembers = inputSanitizerService.normalizeContactGroupMembers(
      groupContact.meta.group_members,
    );
    const existingMembersByPubkey = new Map(
      existingMembers.map((member) => [member.public_key, member] as const),
    );
    const previewSeedRelayUrls = resolveGroupPublishRelayUrlsValue(
      groupContact.relays,
      options.seedRelayUrls,
    );

    let refreshedProfileCount = 0;
    let fallbackProfileCount = 0;
    const nextMembers = await Promise.all(
      nonOwnerMemberPubkeys.map(async (memberPublicKey) => {
        const existingMember = existingMembersByPubkey.get(memberPublicKey) ?? null;
        const shouldRefreshProfile = options.refreshMemberProfiles === true;
        let previewContact: Pick<
          ContactRecord,
          'public_key' | 'name' | 'given_name' | 'meta'
        > | null = null;
        if (shouldRefreshProfile) {
          try {
            previewContact = await fetchGroupMemberPreviewWithRetry(
              memberPublicKey,
              memberPublicKey.slice(0, 16),
              previewSeedRelayUrls,
            );
            if (previewContact) {
              refreshedProfileCount += 1;
            } else {
              fallbackProfileCount += 1;
            }
          } catch (error) {
            fallbackProfileCount += 1;
            console.warn('Failed to refresh group member profile from shared roster', {
              groupPublicKey: normalizedGroupPublicKey,
              memberPublicKey,
              error,
            });
          }
        }

        const storedContact =
          previewContact ?? (await contactsService.getContactByPublicKey(memberPublicKey));
        return buildStoredGroupMemberFromContact(memberPublicKey, storedContact, existingMember);
      }),
    );

    if (JSON.stringify(existingMembers) === JSON.stringify(nextMembers)) {
      return {
        didChange: false,
        fallbackProfileCount,
        memberPublicKeys: normalizedRosterPubkeys,
        ownerIncluded,
        refreshedProfileCount,
      };
    }

    const updatedContact = await persistGroupContactMetaWithRetry(
      normalizedGroupPublicKey,
      (storedGroupContact) => {
        const nextMeta: ContactMetadata = {
          ...(storedGroupContact.meta ?? {}),
        };
        if (nextMembers.length > 0) {
          nextMeta.group_members = nextMembers;
        } else {
          delete nextMeta.group_members;
        }

        return nextMeta;
      },
    );
    if (!updatedContact) {
      throw new Error('Failed to persist refreshed group members.');
    }

    bumpContactListVersion();
    await chatStore.reload();

    return {
      didChange: true,
      fallbackProfileCount,
      memberPublicKeys: normalizedRosterPubkeys,
      ownerIncluded,
      refreshedProfileCount,
    };
  }

  async function refreshGroupMembershipRoster(
    groupPublicKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<GroupMembershipRosterRefreshResult> {
    const memberPublicKeys = await fetchGroupMembershipRosterPubkeys(groupPublicKey, seedRelayUrls);
    return applyGroupMembershipRosterPubkeys(groupPublicKey, memberPublicKeys, {
      refreshMemberProfiles: true,
      seedRelayUrls,
    });
  }

  async function restoreGroupMembershipRoster(
    groupPublicKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<boolean> {
    try {
      const memberPublicKeys = await fetchGroupMembershipRosterPubkeys(
        groupPublicKey,
        seedRelayUrls,
      );
      const result = await applyGroupMembershipRosterPubkeys(groupPublicKey, memberPublicKeys, {
        seedRelayUrls,
      });
      return result.didChange;
    } catch (error) {
      console.warn('Failed to restore group roster from relays', groupPublicKey, error);
      return false;
    }
  }

  function isSkippableGroupMembershipRosterEventError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');

    return (
      message.includes('invalid MAC') ||
      message.includes('Group contact not found.') ||
      message.includes('Group chat not found.') ||
      message.includes('Current epoch key is not available for this group.') ||
      message.includes('Failed to decrypt the current epoch private key.') ||
      message.includes(
        'Decrypted epoch private key does not match the current epoch public key.',
      ) ||
      message.includes('Failed to persist refreshed group members.')
    );
  }

  async function applyGroupMembershipRosterEvent(
    event: ClientEvent,
    options: {
      refreshMemberProfiles?: boolean;
      seedRelayUrls?: string[];
    } = {},
  ): Promise<boolean> {
    if (event.kind !== NostrKind.FollowSet) {
      return false;
    }

    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(event.pubkey ?? '');
    const dTag = event.getMatchingTags('d')[0]?.[1]?.trim() ?? '';
    if (!normalizedGroupPublicKey || dTag !== GROUP_SHARED_ROSTER_FOLLOW_SET_D_TAG) {
      return false;
    }

    try {
      const context = await resolveReadableGroupMembershipRosterContext(
        normalizedGroupPublicKey,
        options.seedRelayUrls ?? [],
        {
          refreshRelayList: false,
        },
      );
      const memberPublicKeys = await decryptGroupMembershipRosterContent(
        context.currentEpochPrivateKey,
        context.currentEpochPublicKey,
        normalizedGroupPublicKey,
        event.content,
      );
      updateStoredEventSinceFromCreatedAt(event.created_at);
      const result = await applyGroupMembershipRosterPubkeys(
        normalizedGroupPublicKey,
        memberPublicKeys,
        {
          refreshMemberProfiles: options.refreshMemberProfiles,
          seedRelayUrls: options.seedRelayUrls,
        },
      );

      return result.didChange;
    } catch (error) {
      if (isSkippableGroupMembershipRosterEventError(error)) {
        console.warn('Skipping group roster event until group context is ready or readable', {
          eventId: normalizeEventId(event.id),
          groupPublicKey: normalizedGroupPublicKey,
          error,
        });
        return false;
      }

      throw error;
    }
  }

  function buildRestoredGroupMembers(
    memberPubkeys: string[],
    existingMembers: ContactMetadata['group_members'],
  ): NonNullable<ContactMetadata['group_members']> {
    const existingMembersByPubkey = new Map(
      inputSanitizerService
        .normalizeContactGroupMembers(existingMembers)
        .map((member) => [member.public_key, member] as const),
    );

    return memberPubkeys.map((memberPublicKey) => {
      return (
        existingMembersByPubkey.get(memberPublicKey) ?? {
          public_key: memberPublicKey,
          name: memberPublicKey,
        }
      );
    });
  }

  async function restoreGroupMembershipFollowSet(
    groupPublicKey: string,
    groupPrivateKey: string,
    ownerPublicKey: string,
    seedRelayUrls: string[] = [],
  ): Promise<boolean> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedGroupPrivateKey = inputSanitizerService.normalizeHexKey(groupPrivateKey);
    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(ownerPublicKey);
    if (!normalizedGroupPublicKey || !normalizedGroupPrivateKey || !normalizedOwnerPublicKey) {
      return false;
    }

    await contactsService.init();
    const existingGroupContact =
      await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!existingGroupContact || existingGroupContact.type !== 'group') {
      return false;
    }

    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      return false;
    }

    const relayUrls = resolveGroupReadRelayUrlsValue(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      return false;
    }

    await ensureRelayConnections(relayUrls);

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const listEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [NostrKind.FollowSet],
        authors: [normalizedGroupPublicKey],
        '#d': [GROUP_MEMBERS_FOLLOW_SET_D_TAG],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet,
    );
    if (!listEvent) {
      return false;
    }

    updateStoredEventSinceFromCreatedAt(listEvent.created_at);
    const memberPubkeys = await decryptGroupMembershipFollowSetContent(
      normalizedGroupPrivateKey,
      normalizedGroupPublicKey,
      listEvent.content,
      [normalizedOwnerPublicKey],
    );
    const existingMembers = inputSanitizerService.normalizeContactGroupMembers(
      groupContact.meta.group_members,
    );
    const nextMembers = buildRestoredGroupMembers(memberPubkeys, existingMembers);
    if (JSON.stringify(existingMembers) === JSON.stringify(nextMembers)) {
      return false;
    }

    const nextMeta: ContactMetadata = {
      ...(groupContact.meta ?? {}),
    };
    if (nextMembers.length > 0) {
      nextMeta.group_members = nextMembers;
    } else {
      delete nextMeta.group_members;
    }

    const updatedContact = await persistGroupContactMetaWithRetry(
      normalizedGroupPublicKey,
      (storedGroupContact) => {
        const updatedMeta: ContactMetadata = {
          ...(storedGroupContact.meta ?? {}),
        };
        if (nextMembers.length > 0) {
          updatedMeta.group_members = nextMembers;
        } else {
          delete updatedMeta.group_members;
        }

        return updatedMeta;
      },
    );
    if (!updatedContact) {
      throw new Error('Failed to persist restored group members.');
    }

    return true;
  }

  async function fetchGroupIdentitySecretEvents(
    seedRelayUrls: string[] = [],
  ): Promise<Map<string, ClientEvent>> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return new Map<string, ClientEvent>();
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      return new Map<string, ClientEvent>();
    }

    await ensureRelayConnections(relayUrls);
    await ensureLoggedInSignerUser();

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const events = await fetchEventsWithRelayTimeout(
      ndk,
      {
        kinds: [PRIVATE_PREFERENCES_KIND],
        authors: [loggedInPubkeyHex],
        '#t': [GROUP_IDENTITY_SECRET_TAG],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet,
    );

    const eventsByGroupPubkey = new Map<string, ClientEvent>();

    for (const event of events) {
      updateStoredEventSinceFromCreatedAt(event.created_at);
      const dTag = inputSanitizerService.normalizeHexKey(
        event.getMatchingTags('d')[0]?.[1]?.trim() ?? '',
      );
      if (!dTag) {
        continue;
      }

      const existingEvent = eventsByGroupPubkey.get(dTag);
      if (existingEvent && compareReplaceableEventState(existingEvent, event) >= 0) {
        continue;
      }

      eventsByGroupPubkey.set(dTag, event);
    }

    return eventsByGroupPubkey;
  }

  async function restoreGroupIdentitySecrets(seedRelayUrls: string[] = []): Promise<void> {
    if (restoreState.restoreGroupIdentitySecretsPromise) {
      return restoreState.restoreGroupIdentitySecretsPromise;
    }

    beginStartupStep('group-identity-secrets');
    restoreState.restoreGroupIdentitySecretsPromise = (async () => {
      try {
        const eventsByGroupPubkey = await fetchGroupIdentitySecretEvents(seedRelayUrls);
        if (eventsByGroupPubkey.size === 0) {
          completeStartupStep('group-identity-secrets');
          return;
        }

        let didChange = false;
        const loggedInPubkeyHex = getLoggedInPublicKeyHex();
        for (const [groupPublicKey, event] of eventsByGroupPubkey.entries()) {
          let decryptedSecret: GroupIdentitySecretContent | null = null;
          try {
            decryptedSecret = await decryptGroupIdentitySecretContent(event.content);
          } catch (error) {
            console.warn('Failed to decrypt group identity secret event', groupPublicKey, error);
            continue;
          }

          if (!decryptedSecret || decryptedSecret.group_pubkey !== groupPublicKey) {
            continue;
          }

          didChange =
            (await ensureGroupContactAndChat(groupPublicKey, event.content, {
              name: decryptedSecret.name,
              about: decryptedSecret.about,
            })) || didChange;
          if (
            Number.isInteger(decryptedSecret.epoch_number) &&
            Number(decryptedSecret.epoch_number) >= 0 &&
            decryptedSecret.epoch_privkey
          ) {
            await persistIncomingGroupEpochTicket(
              groupPublicKey,
              Math.floor(Number(decryptedSecret.epoch_number)),
              decryptedSecret.epoch_privkey,
              {
                fallbackName: decryptedSecret.name,
                accepted: true,
                invitationCreatedAt: toIsoTimestampFromUnix(event.created_at),
              },
            );
          }

          if (loggedInPubkeyHex) {
            try {
              didChange =
                (await restoreGroupMembershipFollowSet(
                  groupPublicKey,
                  decryptedSecret.group_privkey,
                  loggedInPubkeyHex,
                  seedRelayUrls,
                )) || didChange;
            } catch (error) {
              console.warn(
                'Failed to restore group members from follow set',
                groupPublicKey,
                error,
              );
            }
          }
        }

        if (didChange) {
          bumpContactListVersion();
          await chatStore.reload();
        }

        completeStartupStep('group-identity-secrets');
      } catch (error) {
        failStartupStep('group-identity-secrets', error);
        throw error;
      }
    })().finally(() => {
      restoreState.restoreGroupIdentitySecretsPromise = null;
    });

    return restoreState.restoreGroupIdentitySecretsPromise;
  }

  async function createGroupChat(
    options: CreateGroupChatInput = {},
  ): Promise<CreateGroupChatResult> {
    const candidateRelayUrls = Array.isArray(options.relayUrls) ? options.relayUrls : [];
    if (!options.recoveryPhrase) throw new Error('Back up and verify the group recovery phrase before creating the group.');
    const recovered = await createRecoverableGroup(options.recoveryPhrase, options.name?.trim() ?? '', options.about?.trim() ?? '', candidateRelayUrls);
    const relayUrls = recovered.recovery_state?.relays ?? candidateRelayUrls;
    const relayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(relayUrls);
    const initialEpochState = { epoch_number: recovered.epoch_number!, epoch_privkey: recovered.epoch_privkey! };
    const groupPublicKey = recovered.group_pubkey;
    const encryptedPrivateKey = await encryptGroupIdentitySecretContent(recovered);

    const didChange = await ensureGroupContactAndChat(groupPublicKey, encryptedPrivateKey, {
      name: options.name,
      about: options.about,
    });
    await persistIncomingGroupEpochTicket(
      groupPublicKey,
      initialEpochState.epoch_number,
      initialEpochState.epoch_privkey,
      {
        fallbackName: options.name,
        accepted: true,
        invitationCreatedAt: new Date().toISOString(),
      },
    );
    if (didChange) {
      bumpContactListVersion();
      await chatStore.reload();
    }

    if (relayEntries.length > 0) {
      await contactsService.init();
      const groupContact = await contactsService.getContactByPublicKey(groupPublicKey);
      if (groupContact && !contactRelayListsEqual(groupContact.relays, relayEntries)) {
        const updatedGroupContact = await contactsService.updateContact(groupContact.id, {
          relays: relayEntries,
        });
        if (updatedGroupContact) {
          bumpContactListVersion();
        }
      }
    }

    let groupSecretSave: RelaySaveStatus;
    try {
      groupSecretSave = await publishGroupIdentitySecret(
        groupPublicKey,
        encryptedPrivateKey,
        relayUrls,
      );
    } catch (error) {
      groupSecretSave = {
        relayUrls: [],
        publishedRelayUrls: [],
        failedRelayUrls: [],
        errorMessage:
          error instanceof Error ? error.message : 'Failed to publish group identity secret.',
      };
    }

    if (relayEntries.length > 0) {
      try {
        await publishGroupRelayList(groupPublicKey, relayEntries, relayUrls);
      } catch (error) {
        console.warn('Failed to publish group relay list during group creation', error);
      }
    }

    const memberListSyncErrors: string[] = [];
    try {
      await publishGroupMembershipFollowSet(groupPublicKey, [], relayUrls);
    } catch (error) {
      memberListSyncErrors.push(
        error instanceof Error ? error.message : 'Failed to publish group member list.',
      );
    }
    try {
      await publishGroupMembershipRosterFollowSet(groupPublicKey, [], relayUrls);
    } catch (error) {
      memberListSyncErrors.push(
        error instanceof Error ? error.message : 'Failed to publish shared group roster.',
      );
    }
    const memberListSyncError =
      memberListSyncErrors.length > 0 ? memberListSyncErrors.join(' ') : null;

    let contactListSyncError: string | null = null;
    try {
      await publishPrivateContactList(relayUrls);
    } catch (error) {
      contactListSyncError =
        error instanceof Error ? error.message : 'Failed to publish private contact list.';
    }

    return {
      groupPublicKey,
      relayUrls,
      encryptedPrivateKey,
      groupSecretSave,
      memberListSyncError,
      contactListSyncError,
    };
  }

  async function fetchContactCursorEvents(
    contacts: ContactRecord[],
    seedRelayUrls: string[] = [],
  ): Promise<Map<string, ContactCursorContent>> {
    const contactDTagEntries = await Promise.all(
      contacts.map(async (contact) => {
        const dTag = await deriveContactCursorDTag(contact.public_key);
        return dTag ? ([dTag, contact.public_key] as const) : null;
      }),
    );

    const normalizedContactDTags = contactDTagEntries
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
      .map(([dTag]) => dTag);
    if (normalizedContactDTags.length === 0) {
      return new Map<string, ContactCursorContent>();
    }

    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return new Map<string, ContactCursorContent>();
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      return new Map<string, ContactCursorContent>();
    }

    await ensureRelayConnections(relayUrls);
    await ensureLoggedInSignerUser();

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const eventsByDTag = new Map<string, ContactCursorContent>();

    for (const dTagBatch of chunkValues(normalizedContactDTags, CONTACT_CURSOR_FETCH_BATCH_SIZE)) {
      const events = await fetchEventsWithRelayTimeout(
        ndk,
        {
          kinds: [PRIVATE_PREFERENCES_KIND],
          authors: [loggedInPubkeyHex],
          '#d': dTagBatch,
        },
        {
          cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
        },
        relaySet,
      );

      for (const event of events) {
        updateStoredEventSinceFromCreatedAt(event.created_at);
        const eventDTag = event.getMatchingTags('d')[0]?.[1]?.trim();
        if (!eventDTag) {
          continue;
        }

        let cursorContent: ContactCursorContent | null = null;
        try {
          cursorContent = await decryptContactCursorContent(event.content);
        } catch (error) {
          console.warn('Failed to decrypt contact cursor event', eventDTag, error);
          continue;
        }
        if (!cursorContent) {
          continue;
        }

        const existingCursor = eventsByDTag.get(eventDTag);
        if (existingCursor && compareContactCursorState(existingCursor, cursorContent) >= 0) {
          continue;
        }

        eventsByDTag.set(eventDTag, cursorContent);
      }
    }

    return eventsByDTag;
  }

  async function applyContactCursorStateToContact(
    contact: ContactRecord,
    cursor: ContactCursorContent,
    updatedMessageRows?: MessageRow[],
  ): Promise<boolean> {
    const normalizedContactPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!normalizedContactPubkey || !loggedInPubkeyHex) {
      return false;
    }

    // Remembered once stored, so a failed apply is retried when relays replay the event.
    const rememberApplied = () =>
      rememberContactCursor(normalizedContactPubkey, {
        at: cursor.last_seen_incoming_activity_at,
        eventId: normalizeEventId(cursor.last_seen_incoming_activity_event_id),
      });
    let didChange = false;
    const contactMeta =
      contact.meta && typeof contact.meta === 'object' && !Array.isArray(contact.meta)
        ? (contact.meta as ContactMetadata)
        : {};
    const existingContactCursor: ContactCursorContent | null = normalizeTimestamp(
      contactMeta.last_seen_incoming_activity_at,
    )
      ? {
          version: '0.1',
          last_seen_incoming_activity_at: contactMeta.last_seen_incoming_activity_at,
          last_seen_incoming_activity_event_id:
            normalizeEventId(contactMeta.last_seen_incoming_activity_event_id) ?? null,
        }
      : null;
    const shouldAdvanceContactCursor = compareContactCursorState(cursor, existingContactCursor) > 0;
    const nextContactMeta: ContactMetadata = {
      ...contactMeta,
      last_seen_incoming_activity_at: shouldAdvanceContactCursor
        ? cursor.last_seen_incoming_activity_at
        : contactMeta.last_seen_incoming_activity_at,
    };
    if (shouldAdvanceContactCursor && cursor.last_seen_incoming_activity_event_id) {
      nextContactMeta.last_seen_incoming_activity_event_id =
        cursor.last_seen_incoming_activity_event_id;
    } else if (shouldAdvanceContactCursor) {
      delete nextContactMeta.last_seen_incoming_activity_event_id;
    }

    const didChangeLastSeenIncomingActivityAt =
      contactMeta.last_seen_incoming_activity_at !==
        nextContactMeta.last_seen_incoming_activity_at ||
      (contactMeta.last_seen_incoming_activity_event_id ?? null) !==
        (nextContactMeta.last_seen_incoming_activity_event_id ?? null);

    if (didChangeLastSeenIncomingActivityAt) {
      await contactsService.updateContact(contact.id, {
        metaBase: contact.meta,
        meta: nextContactMeta,
      });
      didChange = true;
    }

    const chatRow = await chatDataService.getChatByPublicKey(normalizedContactPubkey);
    if (!chatRow) {
      rememberApplied();
      return didChange;
    }

    const currentChatLastSeenReceivedActivityAt =
      typeof chatRow.meta?.[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY] === 'string'
        ? chatRow.meta[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY].trim()
        : '';
    const currentChatLastOutgoingMessageAt =
      typeof chatRow.meta?.last_outgoing_message_at === 'string'
        ? chatRow.meta.last_outgoing_message_at.trim()
        : '';
    const latestOwnMessageAt =
      (await chatDataService.findLatestMessageByAuthor(normalizedContactPubkey, loggedInPubkeyHex))
        ?.created_at ?? '';
    const effectiveCursorAt = resolveLatestReadBoundaryAtValue(
      cursor.last_seen_incoming_activity_at,
      contactMeta.last_seen_incoming_activity_at,
      currentChatLastSeenReceivedActivityAt,
      currentChatLastOutgoingMessageAt,
      latestOwnMessageAt,
    );
    const cursorTimestamp = toComparableTimestamp(effectiveCursorAt);
    let nextUnreadMessageCount = 0;
    for await (const batch of chatDataService.messageBatches(
      normalizedContactPubkey,
      250,
      effectiveCursorAt,
    )) {
      for (const messageRow of batch) {
        if (
          inputSanitizerService.normalizeHexKey(messageRow.author_public_key) !==
            loggedInPubkeyHex &&
          toComparableTimestamp(messageRow.created_at) > cursorTimestamp
        )
          nextUnreadMessageCount++;
      }
    }

    let nextUnseenReactionCount = 0;
    for await (const batch of chatDataService.reactionMessageBatches(normalizedContactPubkey))
      for (const messageRow of batch) {
        if (
          inputSanitizerService.normalizeHexKey(messageRow.author_public_key) !== loggedInPubkeyHex
        ) {
          continue;
        }

        const currentReactions = normalizeMessageReactions(messageRow.meta.reactions);
        const nextReactions = currentReactions.map((reaction) => {
          const normalizedReactionAt = normalizeTimestamp(reaction.createdAt);
          if (
            !normalizedReactionAt ||
            inputSanitizerService.normalizeHexKey(reaction.reactorPublicKey) === loggedInPubkeyHex
          ) {
            return reaction;
          }

          if (toComparableTimestamp(normalizedReactionAt) <= cursorTimestamp) {
            if (reaction.viewedByAuthorAt) {
              return reaction;
            }

            return {
              ...reaction,
              viewedByAuthorAt: effectiveCursorAt,
            };
          }

          if (!reaction.viewedByAuthorAt) {
            return reaction;
          }

          const { viewedByAuthorAt: _viewedByAuthorAt, ...reactionWithoutViewedAt } = reaction;
          return reactionWithoutViewedAt;
        });

        nextUnseenReactionCount += countUnseenReactionsForAuthor(nextReactions, loggedInPubkeyHex);

        const didChangeReactions =
          currentReactions.length !== nextReactions.length ||
          currentReactions.some((reaction, index) => {
            const nextReaction = nextReactions[index];
            return nextReaction ? !areMessageReactionsEqual(reaction, nextReaction) : true;
          });
        if (!didChangeReactions) {
          continue;
        }

        const updatedRow = await chatDataService.updateMessageMeta(
          messageRow.id,
          buildMetaWithReactions(messageRow.meta, nextReactions),
        );
        if (updatedRow) updatedMessageRows?.push(updatedRow);
        didChange = true;
      }

    const nextChatMeta = buildChatMetaWithUnseenReactionCount(
      {
        ...chatRow.meta,
        [LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY]: effectiveCursorAt,
      },
      nextUnseenReactionCount,
    );

    if (JSON.stringify(chatRow.meta) !== JSON.stringify(nextChatMeta)) {
      await chatDataService.updateChatMeta(normalizedContactPubkey, nextChatMeta);
      didChange = true;
    }

    if (Number(chatRow.unread_count ?? 0) !== nextUnreadMessageCount) {
      await chatDataService.updateChatUnreadCount(normalizedContactPubkey, nextUnreadMessageCount);
      didChange = true;
    }

    if (didChangeLastSeenIncomingActivityAt) {
      scheduleChatChecks([normalizedContactPubkey]);
    }

    rememberApplied();
    return didChange;
  }

  async function restoreContactCursorState(seedRelayUrls: string[] = []): Promise<void> {
    if (restoreState.restoreContactCursorStatePromise) {
      return restoreState.restoreContactCursorStatePromise;
    }

    beginStartupStep('contact-cursor-data');
    restoreState.restoreContactCursorStatePromise = (async () => {
      try {
        if (!readPrivatePreferencesFromStorage()) {
          const privatePreferencesStep = getStartupStepSnapshot('private-preferences');
          if (privatePreferencesStep.status === 'pending') {
            await restorePrivatePreferences(seedRelayUrls);
          }
        }

        if (!readPrivatePreferencesFromStorage()) {
          completeStartupStep('contact-cursor-data');
          return;
        }

        await contactsService.init();
        const contacts = await contactsService.listContacts();
        if (contacts.length === 0) {
          completeStartupStep('contact-cursor-data');
          return;
        }

        const cursorsByDTag = await fetchContactCursorEvents(contacts, seedRelayUrls);

        let didApplyCursorState = false;
        if (cursorsByDTag.size > 0) {
          for (const contact of contacts) {
            const contactDTag = await deriveContactCursorDTag(contact.public_key);
            if (!contactDTag) {
              continue;
            }

            const cursor = cursorsByDTag.get(contactDTag);
            if (!cursor) {
              continue;
            }

            didApplyCursorState =
              (await applyContactCursorStateToContact(contact, cursor)) || didApplyCursorState;
          }
        }

        const shouldReconcileContactReadState =
          didApplyCursorState || contacts.some((contact) => hasContactSeenBoundary(contact));
        if (!shouldReconcileContactReadState) {
          completeStartupStep('contact-cursor-data');
          return;
        }

        const { useMessageStore } = await import('#src/stores/messageStore.svelte.ts');
        const messageStore = useMessageStore();
        const readStateSyncSummary = await messageStore.syncChatsReadStateFromSeenBoundary(
          contacts.map((contact) => contact.public_key),
        );
        const didSyncReadState =
          Number(readStateSyncSummary?.boundaryAdvancedCount ?? 0) > 0 ||
          Number(readStateSyncSummary?.unreadCountAdjustedCount ?? 0) > 0 ||
          Number(readStateSyncSummary?.reactionsMarkedCount ?? 0) > 0;

        if (!didApplyCursorState && !didSyncReadState) {
          completeStartupStep('contact-cursor-data');
          return;
        }

        await Promise.all([chatStore.reload(), messageStore.reloadLoadedMessages()]);
        completeStartupStep('contact-cursor-data');
      } catch (error) {
        failStartupStep('contact-cursor-data', error);
        throw error;
      }
    })().finally(() => {
      restoreState.restoreContactCursorStatePromise = null;
    });

    return restoreState.restoreContactCursorStatePromise;
  }

  function rememberContactCursor(contactPublicKey: string, cursor: ContactCursorState): void {
    if (compareContactCursorState(knownContactCursors.get(contactPublicKey), cursor) < 0) {
      knownContactCursors.set(contactPublicKey, cursor);
    }
  }

  function isCurrentContactCursorSession(account: string, generation: number): boolean {
    return generation === contactCursorGeneration && getLoggedInPublicKeyHex() === account;
  }

  function observeContactCursorEvent(
    contactPublicKey: string,
    cursor: ContactCursorState,
    createdAt: number,
  ): void {
    const latest = latestContactCursorEvents.get(contactPublicKey);
    // Relays break created_at ties by event id, so a tie keeps the older cursor to stay safe.
    if (
      !latest ||
      createdAt > latest.createdAt ||
      (createdAt === latest.createdAt && compareContactCursorState(cursor, latest.cursor) < 0)
    ) {
      latestContactCursorEvents.set(contactPublicKey, { cursor, createdAt });
    }
  }

  async function waitForContactCursorSync(): Promise<void> {
    // EOSE means each relay sent what it stores, not that relays agree. The wait is bounded,
    // so a relay that never sends EOSE delays a publish but cannot block it.
    await contactCursorSubscriptions.waitForEose(CONTACT_CURSOR_SYNC_TIMEOUT_MS).catch(() => {});
  }

  async function readKnownContactCursor(
    contactPublicKey: string,
  ): Promise<ContactCursorState | null> {
    await contactsService.init();
    const contactMeta = (await contactsService.getContactByPublicKey(contactPublicKey))?.meta;
    const storedAt = normalizeTimestamp(contactMeta?.last_seen_incoming_activity_at);
    const stored = storedAt
      ? {
          at: storedAt,
          eventId: normalizeEventId(contactMeta?.last_seen_incoming_activity_event_id),
        }
      : null;
    const known = knownContactCursors.get(contactPublicKey) ?? null;
    return compareContactCursorState(known, stored) >= 0 ? known : stored;
  }

  async function publishContactCursor(
    contactPublicKey: string,
    cursor: ContactCursorState,
    seedRelayUrls: string[] = [],
    options: { republish?: boolean } = {},
  ): Promise<void> {
    const normalizedContactPublicKey = inputSanitizerService.normalizeHexKey(contactPublicKey);
    const account = getLoggedInPublicKeyHex();
    if (!normalizedContactPublicKey || !normalizeTimestamp(cursor.at) || !account) {
      return;
    }

    // One publish per contact at a time, so created_at order always matches cursor order.
    const generation = contactCursorGeneration;
    const previous = contactCursorPublishQueues.get(normalizedContactPublicKey);
    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // A startup restore or live replay may still be applying a newer cursor from another
        // device. Waiting for them keeps a stale device from replacing it on relays.
        await restoreState.restoreContactCursorStatePromise?.catch(() => {});
        await waitForContactCursorSync();
        if (!isCurrentContactCursorSession(account, generation)) {
          return;
        }

        const known = await readKnownContactCursor(normalizedContactPublicKey);
        const order = compareContactCursorState(known, cursor);
        if (order > 0 || (order === 0 && !options.republish)) {
          return;
        }
        // A republish is redundant once relays serve this cursor, e.g. another device healed first.
        const latest = latestContactCursorEvents.get(normalizedContactPublicKey);
        if (options.republish && latest && compareContactCursorState(latest.cursor, cursor) >= 0) {
          return;
        }

        const preferences = await ensurePrivatePreferences({
          publishIfCreated: true,
        });
        const dTag = await sha256Hex(`${preferences.contactSecret}${normalizedContactPublicKey}`);
        const relayUrls = await resolveLoggedInPublishRelayUrls(seedRelayUrls);
        if (relayUrls.length === 0) {
          throw new Error('Cannot publish contact cursor without at least one relay.');
        }

        await ensureRelayConnections(relayUrls);
        const user = await ensureLoggedInSignerUser();
        const content = await encryptContactCursorContent(cursor);
        if (!isCurrentContactCursorSession(account, generation)) {
          return;
        }

        const createdAt = allocateReplaceableCreatedAt(
          `cursor:${account}:${normalizedContactPublicKey}`,
        );
        const cursorEvent = new ClientEvent(ndk, {
          kind: PRIVATE_PREFERENCES_KIND,
          created_at: createdAt,
          pubkey: user.pubkey,
          content,
          tags: [['d', dTag]],
        });

        const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
        await cursorEvent.publishReplaceable(relaySet);
        updateStoredEventSinceFromCreatedAt(cursorEvent.created_at);
        if (!isCurrentContactCursorSession(account, generation)) {
          return;
        }

        rememberContactCursor(normalizedContactPublicKey, cursor);
        observeContactCursorEvent(normalizedContactPublicKey, cursor, createdAt);
        if (cursorEvent.id) {
          contactCursorEvents.set(dTag, {
            id: cursorEvent.id,
            cursor: {
              version: CONTACT_CURSOR_VERSION,
              last_seen_incoming_activity_at: cursor.at,
              last_seen_incoming_activity_event_id: cursor.eventId ?? null,
            },
          });
        }
      });
    contactCursorPublishQueues.set(normalizedContactPublicKey, next);
    try {
      await next;
    } finally {
      if (contactCursorPublishQueues.get(normalizedContactPublicKey) === next) {
        contactCursorPublishQueues.delete(normalizedContactPublicKey);
      }
    }
  }

  async function resolveContactCursorDTag(dTag: string): Promise<string | null> {
    const secret = readPrivatePreferencesFromStorage()?.contactSecret ?? '';
    if (!secret) {
      return null;
    }

    if (contactCursorDTagIndex?.secret !== secret) {
      contactCursorDTagIndex = { secret, contacts: new Map(), publicKeys: new Set() };
    }
    const index = contactCursorDTagIndex;
    const indexed = index.contacts.get(dTag);
    if (indexed) {
      return indexed;
    }

    // Contacts can be added at any time, so an unknown d-tag hashes only contacts not yet
    // indexed. Other apps' kind 30078 events then cost one contact listing, not a hash each.
    await contactsService.init();
    for (const contact of await contactsService.listContacts()) {
      const contactPublicKey = inputSanitizerService.normalizeHexKey(contact.public_key);
      if (!contactPublicKey || index.publicKeys.has(contactPublicKey)) {
        continue;
      }

      const contactDTag = await deriveContactCursorDTag(contactPublicKey);
      if (contactDTag) {
        index.contacts.set(contactDTag, contactPublicKey);
        index.publicKeys.add(contactPublicKey);
      }
    }
    return index.contacts.get(dTag) ?? null;
  }

  async function applyLiveContactCursorEvent(
    event: ClientEvent,
    account: string,
    generation: number,
  ): Promise<void> {
    const dTag = event.getMatchingTags('d')[0]?.[1]?.trim();
    if (
      !dTag ||
      dTag === PRIVATE_PREFERENCES_D_TAG ||
      event.getMatchingTags('t').some((tag) => tag[1] === GROUP_IDENTITY_SECRET_TAG) ||
      inputSanitizerService.normalizeHexKey(event.pubkey ?? '') !== account
    ) {
      return;
    }

    const contactPublicKey = await resolveContactCursorDTag(dTag);
    if (!contactPublicKey || !isCurrentContactCursorSession(account, generation)) {
      return;
    }

    const cached = event.id ? contactCursorEvents.get(dTag) : undefined;
    let cursor: ContactCursorContent | null =
      cached && cached.id === event.id ? cached.cursor : null;
    if (!cursor) {
      try {
        cursor = await decryptContactCursorContent(event.content);
      } catch (error) {
        console.warn('Failed to decrypt live contact cursor event', error);
        return;
      }
    }
    const contact = cursor ? await contactsService.getContactByPublicKey(contactPublicKey) : null;
    if (!cursor || !contact || !isCurrentContactCursorSession(account, generation)) {
      return;
    }
    if (event.id) {
      contactCursorEvents.set(dTag, { id: event.id, cursor });
    }

    const eventCreatedAt = event.created_at ?? 0;
    updateStoredEventSinceFromCreatedAt(eventCreatedAt);
    // A later publish from this device must replace this event even across clock skew.
    const streamKey = `cursor:${account}:${contactPublicKey}`;
    lastReplaceableCreatedAtByStream.set(
      streamKey,
      Math.max(lastReplaceableCreatedAtByStream.get(streamKey) ?? 0, eventCreatedAt),
    );
    const cursorState = {
      at: cursor.last_seen_incoming_activity_at,
      eventId: normalizeEventId(cursor.last_seen_incoming_activity_event_id),
    };
    observeContactCursorEvent(contactPublicKey, cursorState, eventCreatedAt);
    // Our own echo, a replay or a delayed event cannot move the read state, so skip the
    // chat and reaction scans for cursors this device already applied or published.
    const updatedMessageRows: MessageRow[] = [];
    const didChange =
      compareContactCursorState(cursorState, knownContactCursors.get(contactPublicKey)) > 0 &&
      (await applyContactCursorStateToContact(contact, cursor, updatedMessageRows));

    // A stale device, a same-second publish or a skewed clock can leave relays serving an older
    // cursor than one known here. Only the newest event counts, so delayed events are ignored,
    // and only a device holding a strictly newer cursor answers. Cursors are totally ordered,
    // so the newest cursor ends up newest on relays and the exchange settles.
    const latest = latestContactCursorEvents.get(contactPublicKey);
    const known = await readKnownContactCursor(contactPublicKey);
    if (
      latest?.createdAt === eventCreatedAt &&
      known &&
      compareContactCursorState(latest.cursor, known) < 0 &&
      isCurrentContactCursorSession(account, generation)
    ) {
      void publishContactCursor(contactPublicKey, known, [], {
        republish: true,
      }).catch((error) => {
        console.error('Failed to republish contact cursor event', contactPublicKey, error);
      });
    }

    if (!didChange || !isCurrentContactCursorSession(account, generation)) {
      return;
    }

    // Only this contact's chat and the reactions marked seen changed.
    const { useMessageStore } = await import('#src/stores/messageStore.svelte.ts');
    const messageStore = useMessageStore();
    await Promise.all([
      chatStore.refreshChat(contactPublicKey),
      ...updatedMessageRows.map((row) => messageStore.upsertPersistedMessage(row)),
    ]);
  }

  async function subscribeContactCursorUpdates(seedRelayUrls: string[] = []): Promise<void> {
    const generation = contactCursorGeneration;
    const account = getLoggedInPublicKeyHex();
    if (!account) {
      contactCursorSubscriptions.stop();
      return;
    }

    contactCursorSeedRelayUrls = [...seedRelayUrls];

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (!isCurrentContactCursorSession(account, generation)) {
      return;
    }
    if (relayUrls.length === 0) {
      contactCursorSubscriptions.stop();
      return;
    }

    // The filter names only the account and kind. Contact d-tags stay out of the REQ, and
    // other kind 30078 events are discarded locally. A resumed session starts from the
    // stored event boundary, so reads made elsewhere while this device was closed arrive.
    if (!contactCursorSince) {
      const lookbackSince = Math.floor(Date.now() / 1000) - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS;
      const storedSince = getFilterSince();
      contactCursorSince = storedSince > 0 ? Math.min(storedSince, lookbackSince) : lookbackSince;
    }
    const relays = normalizeRelayStatusUrlsValue(relayUrls).sort();
    const live = contactCursorSubscriptions.size() > 0 ? contactCursorLiveFilter : null;
    const resume = contactCursorResume;
    const since =
      live && live.relays.join(' ') === relays.join(' ')
        ? live.since
        : resume && relays.every((url) => resume.relays.includes(url))
          ? Math.max(contactCursorSince, resume.since)
          : contactCursorSince;
    contactCursorLiveFilter = { relays, since };
    const filters: NostrFilter = {
      kinds: [PRIVATE_PREFERENCES_KIND],
      authors: [account],
      since,
    };
    const signature = subscriptionSignature(filters, relayUrls);
    await contactCursorSubscriptions.reconcile([
      {
        key: 'contact-cursors',
        signature,
        prepare: async () => {
          await ensureRelayConnections(relayUrls);
          await ensureLoggedInSignerUser();
        },
        applied: () => contactCursorApplyQueue,
        start: (onEose, onClose) => {
          if (since === contactCursorSince) contactCursorApplyFailed = false;
          const subscription = subscribeWithReqLogging(
            'contact-cursors',
            'contact-cursors',
            filters,
            {
              relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
              cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
              onEvent: (event) => {
                if (!isCurrentContactCursorSession(account, generation)) {
                  return;
                }

                const wrappedEvent =
                  event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                contactCursorApplyQueue = contactCursorApplyQueue
                  .then(() => applyLiveContactCursorEvent(wrappedEvent, account, generation))
                  .catch((error) => {
                    // A later subscription replays from the boundary to retry this event.
                    contactCursorApplyFailed = true;
                    contactCursorResume = null;
                    console.warn('Failed to apply live contact cursor event', error);
                  });
              },
              onEose,
              onClose,
            },
            { signature },
          );
          // The client emits 'eose' only once every relay of the set has finished its replay
          // and is still subscribed; the onEose above may fire with offline relays pending.
          // Events from now on arrive live, and the lookback covers skewed clocks.
          subscription.on('eose', () => {
            if (!contactCursorApplyFailed && isCurrentContactCursorSession(account, generation)) {
              contactCursorResume = {
                relays,
                since: Math.floor(Date.now() / 1000) - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS,
              };
            }
          });
          return subscription;
        },
      },
    ]);
  }

  // A subscription whose relays all disconnect closes itself. Reconnect healing and relay
  // reconnects call this to restore it, and the replay from `since` delivers cursors published
  // meanwhile. A live subscription makes this a no-op.
  async function recoverContactCursorSubscription(): Promise<void> {
    const seedRelayUrls = contactCursorSeedRelayUrls;
    if (!seedRelayUrls || !getLoggedInPublicKeyHex() || contactCursorSubscriptions.size() > 0) {
      return;
    }

    try {
      await subscribeContactCursorUpdates(seedRelayUrls);
    } catch (error) {
      // The next relay reconnect or healing pass tries again.
      console.warn('Failed to recover contact cursor subscription', error);
    }
  }

  function resetContactCursorSyncState(): void {
    contactCursorGeneration += 1;
    contactCursorSubscriptions.stop();
    knownContactCursors.clear();
    latestContactCursorEvents.clear();
    contactCursorPublishQueues.clear();
    deferredContactCursorPublishes.clear();
    contactCursorEvents.clear();
    contactCursorDTagIndex = null;
    contactCursorApplyQueue = Promise.resolve();
    contactCursorSince = 0;
    contactCursorResume = null;
    contactCursorApplyFailed = false;
    contactCursorLiveFilter = null;
    contactCursorSeedRelayUrls = null;
  }

  // A manual read publishes at once, then coalesces for a delay. An automatic read from a
  // focused chat only starts the delay, plus jitter, so incoming messages do not each publish
  // a cursor right as they arrive. Either way there is at most one timer per contact.
  function scheduleContactCursorPublish(
    contactPublicKey: string,
    cursor: ContactCursorState,
    options: { deferred?: boolean } = {},
  ): void {
    const normalizedContactPublicKey = inputSanitizerService.normalizeHexKey(contactPublicKey);
    const normalizedCursorAt = normalizeTimestamp(cursor.at);
    if (!normalizedContactPublicKey || !normalizedCursorAt) {
      return;
    }

    let nextCursorState: ContactCursorState = {
      at: normalizedCursorAt,
      eventId: normalizeEventId(cursor.eventId),
    };
    const deferred = options.deferred === true;
    const existingTimer = pendingContactCursorPublishTimers.get(normalizedContactPublicKey);
    const pendingCursor = pendingContactCursorPublishStates.get(normalizedContactPublicKey);
    if (
      existingTimer &&
      (deferred || !deferredContactCursorPublishes.has(normalizedContactPublicKey))
    ) {
      if (!pendingCursor || compareContactCursorState(pendingCursor, nextCursorState) < 0) {
        pendingContactCursorPublishStates.set(normalizedContactPublicKey, nextCursorState);
      }
      return;
    }

    if (existingTimer) {
      // A manual read takes over a pending automatic one and publishes now.
      globalThis.clearTimeout(existingTimer);
      pendingContactCursorPublishTimers.delete(normalizedContactPublicKey);
      deferredContactCursorPublishes.delete(normalizedContactPublicKey);
      if (pendingCursor && compareContactCursorState(pendingCursor, nextCursorState) > 0) {
        nextCursorState = pendingCursor;
      }
    }

    pendingContactCursorPublishStates.set(normalizedContactPublicKey, nextCursorState);
    const publishedCursor = deferred ? null : nextCursorState;
    if (publishedCursor) {
      void publishContactCursor(normalizedContactPublicKey, publishedCursor).catch((error) => {
        console.error('Failed to publish contact cursor event', normalizedContactPublicKey, error);
      });
    } else {
      deferredContactCursorPublishes.add(normalizedContactPublicKey);
    }

    const delayMs =
      CONTACT_CURSOR_PUBLISH_DELAY_MS +
      (deferred ? Math.floor(Math.random() * CONTACT_CURSOR_PUBLISH_JITTER_MS) : 0);
    const nextTimer = globalThis.setTimeout(() => {
      pendingContactCursorPublishTimers.delete(normalizedContactPublicKey);
      deferredContactCursorPublishes.delete(normalizedContactPublicKey);
      const cursorToPublish = pendingContactCursorPublishStates.get(normalizedContactPublicKey);
      pendingContactCursorPublishStates.delete(normalizedContactPublicKey);
      if (!cursorToPublish || compareContactCursorState(cursorToPublish, publishedCursor) <= 0) {
        return;
      }

      void publishContactCursor(normalizedContactPublicKey, cursorToPublish).catch((error) => {
        console.error('Failed to publish contact cursor event', normalizedContactPublicKey, error);
      });
    }, delayMs);

    pendingContactCursorPublishTimers.set(normalizedContactPublicKey, nextTimer);
  }

  return {
    applyGroupMembershipRosterEvent,
    applyContactCursorStateToContact,
    buildChatMetaWithUnseenReactionCount,
    compareContactCursorState,
    createGroupChat,
    fetchContactCursorEvents,
    fetchGroupMembershipFollowSetPubkeys,
    fetchGroupMembershipRosterPubkeys,
    fetchGroupIdentitySecretEvents,
    listGroupMembershipRosterSubscriptionContexts,
    publishContactCursor,
    publishGroupMembershipFollowSet,
    publishGroupMembershipRosterFollowSet,
    publishGroupIdentitySecret,
    publishPrivatePreferences,
    refreshGroupMembershipRoster,
    restoreContactCursorState,
    restoreGroupIdentitySecrets,
    restoreGroupMembershipRoster,
    restorePrivatePreferences,
    recoverContactCursorSubscription,
    resetContactCursorSyncState,
    scheduleContactCursorPublish,
    subscribeContactCursorUpdates,
  };
}
