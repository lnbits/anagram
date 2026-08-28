import NDK, { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import type { ContactRecord } from 'src/types/contact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getMessageById: vi.fn(async () => null),
  updateMessageEventId: vi.fn(async () => {}),
  getChatByPublicKey: vi.fn(async () => null),
  createChat: vi.fn(async () => null),
  updateChat: vi.fn(async () => null),
  updateChatPreview: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
}));

const contactsServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getContactByPublicKey: vi.fn(async () => null),
  createContact: vi.fn(async () => null),
  updateContact: vi.fn(async () => null),
}));

const nostrEventDataServiceMock = vi.hoisted(() => ({
  appendRelayStatuses: vi.fn(async () => {}),
}));

const messageStoreMock = vi.hoisted(() => ({
  refreshPersistedMessage: vi.fn(async () => {}),
  reloadLoadedMessages: vi.fn(async () => {}),
  syncChatUnseenReactionCount: vi.fn(async () => {}),
  syncChatsReadStateFromSeenBoundary: vi.fn(async () => {}),
}));

const logoutCleanupMock = vi.hoisted(() => ({
  clearPersistedAppState: vi.fn(async () => {}),
}));

const androidSecurePrivateKeyStorageMock = vi.hoisted(() => ({
  clearAndroidPrivateKeyMemoryOnlySession: vi.fn(),
  isAndroidSecurePrivateKeyStorageAvailable: vi.fn(() => false),
  markAndroidPrivateKeyMemoryOnlySession: vi.fn(),
  readAndroidSecurePrivateKeyHex: vi.fn(async () => null as string | null),
  removeAndroidSecurePrivateKeyHex: vi.fn(async () => {}),
  writeAndroidSecurePrivateKeyHex: vi.fn(async () => {}),
}));

const electronSecurePrivateKeyStorageMock = vi.hoisted(() => ({
  clearElectronPrivateKeyMemoryOnlySession: vi.fn(),
  isElectronSecurePrivateKeyStorageAvailable: vi.fn(() => false),
  markElectronPrivateKeyMemoryOnlySession: vi.fn(),
  readElectronSecurePrivateKeyHex: vi.fn(async () => null as string | null),
  removeElectronSecurePrivateKeyHex: vi.fn(async () => {}),
  writeElectronSecurePrivateKeyHex: vi.fn(async () => {}),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/services/androidSecurePrivateKeyStorage', () => androidSecurePrivateKeyStorageMock);

vi.mock('src/services/electronSecurePrivateKeyStorage', () => electronSecurePrivateKeyStorageMock);

vi.mock('src/services/contactsService', () => ({
  contactsService: contactsServiceMock,
}));

vi.mock('src/services/nostrEventDataService', () => ({
  nostrEventDataService: nostrEventDataServiceMock,
}));

vi.mock('src/stores/messageStore', () => ({
  useMessageStore: () => messageStoreMock,
}));

vi.mock('src/utils/logoutCleanup', () => ({
  clearPersistedAppState: logoutCleanupMock.clearPersistedAppState,
}));

import { createAuthSessionRuntime } from 'src/stores/nostr/authSessionRuntime';
import {
  AUTH_METHOD_STORAGE_KEY,
  NIP46_SIGNER_PAYLOAD_STORAGE_KEY,
  PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from 'src/stores/nostr/constants';
import { createGroupInviteRuntime } from 'src/stores/nostr/groupInviteRuntime';
import { createMessageRelayRuntime } from 'src/stores/nostr/messageRelayRuntime';
import { createPrivateContactMembershipRuntime } from 'src/stores/nostr/privateContactMembershipRuntime';
import { createPrivateMessagesUiRuntime } from 'src/stores/nostr/privateMessagesUiRuntime';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const GROUP_KEY = 'c'.repeat(64);
const EVENT_ID_A = 'd'.repeat(64);
const EVENT_ID_B = 'e'.repeat(64);

function createMockStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));

  return {
    store,
    api: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    },
  };
}

function normalizeEventId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeRelayStatusUrls(relayUrls: string[]): string[] {
  return Array.from(
    new Set(
      relayUrls
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.endsWith('/') ? value : `${value}/`))
    )
  );
}

function normalizeThrottleMs(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function buildContactRecord(
  overrides: Partial<ContactRecord> & Pick<ContactRecord, 'public_key'>
): ContactRecord {
  return {
    id: overrides.id ?? 1,
    public_key: overrides.public_key,
    type: overrides.type ?? 'user',
    name: overrides.name ?? 'Contact',
    given_name: overrides.given_name ?? null,
    meta: overrides.meta ?? {},
    ...(overrides.relays ? { relays: overrides.relays } : {}),
    sendMessagesToAppRelays: overrides.sendMessagesToAppRelays ?? false,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.dynamicImportSettled();
}

function createAuthSessionHarness() {
  const ndk = new NDK();
  const pendingContactCursorPublishTimers = new Map<
    string,
    ReturnType<typeof globalThis.setTimeout>
  >();
  pendingContactCursorPublishTimers.set(
    'chat',
    globalThis.setTimeout(() => {}, 1000)
  );
  let refreshTimerId: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout(
    () => {},
    1000
  );

  const refs = {
    contactListVersion: ref(4),
    eventSince: ref(88),
    isRestoringStartupState: ref(true),
    relayStatusVersion: ref(2),
  };
  const restoreRuntimeState = {
    restoreContactCursorStatePromise: Promise.resolve(),
    restoreGroupIdentitySecretsPromise: Promise.resolve(),
    restorePrivatePreferencesPromise: Promise.resolve(),
  };

  const deps = {
    authenticatedRelayUrls: { clear: vi.fn() },
    backgroundGroupContactRefreshStartedAt: { clear: vi.fn() },
    bumpDeveloperDiagnosticsVersion: vi.fn(),
    chatStoreClearAllComposerDrafts: vi.fn(),
    clearDeveloperTraceEntries: vi.fn(async () => {}),
    clearNip65RelayStoreState: vi.fn(),
    clearPrivateMessagesBackfillState: vi.fn(),
    clearPrivatePreferencesStorage: vi.fn(),
    clearRelayStoreState: vi.fn(),
    clearStoredPrivateMessagesLastReceivedCreatedAt: vi.fn(),
    configuredRelayUrls: { clear: vi.fn() },
    contactListVersion: refs.contactListVersion,
    eventSince: refs.eventSince,
    getPrivateMessagesEpochSubscriptionRefreshTimerId: () => refreshTimerId,
    groupContactRefreshPromises: { clear: vi.fn() },
    hasNip07Extension: () => false,
    isRestoringStartupState: refs.isRestoringStartupState,
    loggedInvalidGroupEpochConflictKeys: { clear: vi.fn() },
    ndk,
    pendingContactCursorPublishStates: { clear: vi.fn() },
    pendingContactCursorPublishTimers,
    pendingEventSinceState: {
      pendingEventSinceUpdate: 9,
    },
    pendingIncomingDeletions: { clear: vi.fn() },
    pendingIncomingReactions: { clear: vi.fn() },
    relayConnectFailureCooldownUntilByUrl: { clear: vi.fn() },
    relayConnectPromises: { clear: vi.fn() },
    relayStatusVersion: refs.relayStatusVersion,
    resetContactSubscriptionsRuntimeState: vi.fn(),
    resetEventSinceForFreshLogin: vi.fn(),
    resetGroupRosterSubscriptionRuntimeState: vi.fn(),
    resetMyRelayListRuntimeState: vi.fn(),
    resetMuteListRuntimeState: vi.fn(),
    resetOutboundMessageReplayRuntimeState: vi.fn(),
    resetPrivateMessagesBackfillRuntimeState: vi.fn(),
    resetPrivateContactListRuntimeState: vi.fn(),
    resetReconnectHealingRuntimeState: vi.fn(),
    resetPrivateMessagesIngestRuntimeState: vi.fn(),
    resetPrivateMessagesSubscriptionRuntimeState: vi.fn(),
    resetPrivateMessagesUiRuntimeState: vi.fn(),
    resetStartupSessionInitialization: vi.fn(),
    resetStartupStepTracking: vi.fn(),
    resetTrackedContactEventState: vi.fn(),
    restoreRuntimeState,
    setCachedSigner: vi.fn(),
    setCachedSignerSessionKey: vi.fn(),
    setPendingPrivateMessagesEpochSubscriptionRefreshOptions: vi.fn(),
    setPrivateMessagesEpochSubscriptionRefreshQueue: vi.fn(),
    setPrivateMessagesEpochSubscriptionRefreshTimerId: vi.fn((timerId) => {
      refreshTimerId = timerId;
    }),
    setRestoreStartupStatePromise: vi.fn(),
    setSyncLoggedInContactProfilePromise: vi.fn(),
    setSyncRecentChatContactsPromise: vi.fn(),
    stopPrivateMessagesSubscription: vi.fn(),
  };

  const runtime = createAuthSessionRuntime(deps);

  return {
    deps,
    ndk,
    refs,
    restoreRuntimeState,
    runtime,
  };
}

describe('nostr runtime messaging logic', () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    chatDataServiceMock.getMessageById.mockResolvedValue(null);
    chatDataServiceMock.getChatByPublicKey.mockResolvedValue(null);
    chatDataServiceMock.listChats.mockResolvedValue([]);
    contactsServiceMock.getContactByPublicKey.mockResolvedValue(null);
    (globalThis as Record<string, unknown>).window = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    androidSecurePrivateKeyStorageMock.clearAndroidPrivateKeyMemoryOnlySession.mockClear();
    androidSecurePrivateKeyStorageMock.isAndroidSecurePrivateKeyStorageAvailable.mockReturnValue(
      false
    );
    androidSecurePrivateKeyStorageMock.markAndroidPrivateKeyMemoryOnlySession.mockClear();
    androidSecurePrivateKeyStorageMock.readAndroidSecurePrivateKeyHex.mockResolvedValue(null);
    androidSecurePrivateKeyStorageMock.removeAndroidSecurePrivateKeyHex.mockResolvedValue();
    androidSecurePrivateKeyStorageMock.writeAndroidSecurePrivateKeyHex.mockResolvedValue();
    electronSecurePrivateKeyStorageMock.clearElectronPrivateKeyMemoryOnlySession.mockClear();
    electronSecurePrivateKeyStorageMock.isElectronSecurePrivateKeyStorageAvailable.mockReturnValue(
      false
    );
    electronSecurePrivateKeyStorageMock.markElectronPrivateKeyMemoryOnlySession.mockClear();
    electronSecurePrivateKeyStorageMock.readElectronSecurePrivateKeyHex.mockResolvedValue(null);
    electronSecurePrivateKeyStorageMock.removeElectronSecurePrivateKeyHex.mockResolvedValue();
    electronSecurePrivateKeyStorageMock.writeElectronSecurePrivateKeyHex.mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it('appends relay statuses and manages pending message diagnostics state', async () => {
    const pendingIncomingReactions = new Map<string, unknown[]>();
    const pendingIncomingDeletions = new Map<string, unknown[]>();
    const bumpDeveloperDiagnosticsVersion = vi.fn();
    const logMessageRelayDiagnostics = vi.fn();
    const queuePrivateMessagesUiRefresh = vi.fn();
    const refreshPendingIncomingQueues = vi.fn(async () => {});
    const runtime = createMessageRelayRuntime({
      bumpDeveloperDiagnosticsVersion,
      formatSubscriptionLogValue: (value) => value?.trim() ?? null,
      logMessageRelayDiagnostics,
      normalizeEventId,
      normalizeRelayStatusUrls,
      normalizeThrottleMs,
      pendingIncomingDeletions: pendingIncomingDeletions as never,
      pendingIncomingReactions: pendingIncomingReactions as never,
      queuePrivateMessagesUiRefresh,
      refreshPendingIncomingQueues,
    });
    const relayStatuses = [
      {
        relay_url: 'wss://relay.example/',
        direction: 'out',
        status: 'sent',
        scope: 'publish',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ] as never;

    await runtime.appendRelayStatusesToMessageEvent(0, relayStatuses);
    chatDataServiceMock.getMessageById.mockResolvedValueOnce(null);
    await runtime.appendRelayStatusesToMessageEvent(1, relayStatuses, {
      eventId: EVENT_ID_A,
    });
    chatDataServiceMock.getMessageById.mockResolvedValueOnce({
      id: 2,
      event_id: null,
    } as never);
    await runtime.appendRelayStatusesToMessageEvent(2, relayStatuses);

    chatDataServiceMock.getMessageById.mockResolvedValueOnce({
      id: 3,
      event_id: EVENT_ID_A,
    } as never);
    await runtime.appendRelayStatusesToMessageEvent(3, relayStatuses, {
      eventId: EVENT_ID_B,
      direction: 'out',
      uiThrottleMs: 25,
    });
    chatDataServiceMock.getMessageById.mockResolvedValueOnce({
      id: 4,
      event_id: EVENT_ID_B,
    } as never);
    await runtime.appendRelayStatusesToMessageEvent(4, relayStatuses, {
      eventId: EVENT_ID_B,
    });

    expect(chatDataServiceMock.updateMessageEventId).toHaveBeenCalledWith(3, EVENT_ID_B);
    expect(nostrEventDataServiceMock.appendRelayStatuses).toHaveBeenNthCalledWith(
      1,
      EVENT_ID_B,
      relayStatuses,
      {
        event: undefined,
        direction: 'out',
      }
    );
    expect(queuePrivateMessagesUiRefresh).toHaveBeenCalledWith({
      throttleMs: 25,
      reloadMessages: true,
    });
    expect(messageStoreMock.refreshPersistedMessage).toHaveBeenCalledWith(4);
    expect(
      runtime.buildInboundRelayStatuses(['wss://relay.example', 'wss://relay.example/'])
    ).toEqual([
      expect.objectContaining({
        relay_url: 'wss://relay.example/',
        direction: 'inbound',
        status: 'received',
      }),
    ]);
    expect(logMessageRelayDiagnostics).toHaveBeenCalledWith(
      'skip',
      expect.objectContaining({
        reason: 'invalid-message-id',
      })
    );

    runtime.queuePendingIncomingReaction(EVENT_ID_A, {
      chatPublicKey: PUBKEY_A,
      targetAuthorPublicKey: PUBKEY_B,
      reaction: {
        emoji: '👍',
        reactorPublicKey: PUBKEY_A,
        eventId: EVENT_ID_B,
      },
    } as never);
    runtime.queuePendingIncomingReaction(EVENT_ID_A, {
      chatPublicKey: PUBKEY_A,
      targetAuthorPublicKey: PUBKEY_B,
      reaction: {
        emoji: '👍',
        reactorPublicKey: PUBKEY_A,
        eventId: EVENT_ID_B,
      },
    } as never);
    runtime.queuePendingIncomingDeletion(EVENT_ID_A, {
      deletionAuthorPublicKey: PUBKEY_A,
      targetKind: 7,
    } as never);
    runtime.queuePendingIncomingDeletion(EVENT_ID_A, {
      deletionAuthorPublicKey: PUBKEY_A,
      targetKind: 7,
    } as never);
    expect(runtime.consumePendingIncomingReactions(EVENT_ID_A)).toHaveLength(1);
    expect(runtime.consumePendingIncomingDeletions(EVENT_ID_A)).toHaveLength(1);

    runtime.queuePendingIncomingReaction(EVENT_ID_A, {
      chatPublicKey: PUBKEY_A,
      targetAuthorPublicKey: PUBKEY_B,
      reaction: {
        emoji: '🔥',
        reactorPublicKey: PUBKEY_A,
        eventId: EVENT_ID_B,
      },
    } as never);
    runtime.removePendingIncomingReaction(
      EVENT_ID_A,
      EVENT_ID_B.toUpperCase(),
      PUBKEY_A.toUpperCase()
    );
    expect(runtime.consumePendingIncomingReactions(EVENT_ID_A)).toEqual([]);
    expect(bumpDeveloperDiagnosticsVersion).toHaveBeenCalled();
  });

  it('creates and accepts group invite chats with refresh and publish fallbacks', async () => {
    const chatStore = {
      init: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      syncContactProfile: vi.fn(async () => {}),
    };
    const ensureContactStoredAsGroup = vi.fn<
      (groupPublicKey: string, options?: { fallbackName?: string }) => Promise<ContactRecord | null>
    >(async () =>
      buildContactRecord({
        public_key: GROUP_KEY,
        type: 'group',
        name: 'Accepted Group',
      })
    );
    const ensureContactListedInPrivateContactList = vi.fn<
      (
        targetPubkeyHex: string,
        options?: { fallbackName?: string; type?: 'user' | 'group' }
      ) => Promise<{ contact: ContactRecord; didChange: boolean }>
    >(async () => ({
      contact: buildContactRecord({
        public_key: GROUP_KEY,
        type: 'group',
        name: 'Accepted Group',
      }),
      didChange: true,
    }));
    const subscribePrivateMessagesForLoggedInUser = vi.fn(async () => {});
    const refreshGroupContactByPublicKey = vi.fn(async () => null);
    const publishPrivateContactList = vi.fn(async () => {});
    const restoreGroupEpochHistory = vi.fn(async () => {});
    const subscribeGroupMembershipRosterUpdates = vi.fn(async () => {});
    const runtime = createGroupInviteRuntime({
      bumpContactListVersion: vi.fn(),
      chatStore,
      ensureContactListedInPrivateContactList,
      ensureContactStoredAsGroup,
      getAppRelayUrls: () => ['wss://relay.example/'],
      getLoggedInPublicKeyHex: () => PUBKEY_A,
      publishPrivateContactList,
      refreshGroupContactByPublicKey,
      restoreGroupEpochHistory,
      subscribeGroupMembershipRosterUpdates,
      subscribePrivateMessagesForLoggedInUser,
    });

    chatDataServiceMock.getChatByPublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        public_key: GROUP_KEY,
        type: 'group',
        name: 'Existing Group',
        meta: {
          inbox_state: 'request',
          request_type: 'group_invite',
          request_message: 'This is an invitation to a group.',
        },
      } as never)
      .mockResolvedValueOnce({
        public_key: GROUP_KEY,
        type: 'group',
        name: 'Pending Group',
        meta: {
          inbox_state: 'request',
          request_type: 'group_invite',
          request_message: 'This is an invitation to a group.',
        },
      } as never);

    await runtime.upsertIncomingGroupInviteRequestChat(GROUP_KEY, '2026-01-05T00:00:00.000Z', {
      name: 'Preview Name',
      meta: {
        display_name: 'Preview Display',
      },
    } as never);
    await runtime.upsertIncomingGroupInviteRequestChat(GROUP_KEY, '2026-01-06T00:00:00.000Z', {
      name: 'Ignored',
      meta: {
        display_name: 'Updated Display',
      },
    } as never);

    subscribePrivateMessagesForLoggedInUser.mockRejectedValueOnce(new Error('subscription failed'));
    refreshGroupContactByPublicKey.mockRejectedValueOnce(new Error('profile failed'));
    publishPrivateContactList.mockRejectedValueOnce(new Error('publish failed'));
    await runtime.ensureGroupInvitePubkeyIsContact(GROUP_KEY, 'Accepted Group');

    expect(chatDataServiceMock.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        public_key: GROUP_KEY,
        type: 'group',
        name: 'Preview Display',
      })
    );
    expect(chatDataServiceMock.updateChat).toHaveBeenCalledWith(
      GROUP_KEY,
      expect.objectContaining({
        type: 'group',
      })
    );
    expect(chatDataServiceMock.updateChatPreview).toHaveBeenCalledWith(
      GROUP_KEY,
      'This is an invitation to a group.',
      '2026-01-06T00:00:00.000Z',
      expect.any(Number)
    );
    expect(ensureContactStoredAsGroup).toHaveBeenCalledWith(GROUP_KEY, {
      fallbackName: 'Accepted Group',
    });
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledWith(GROUP_KEY, {
      fallbackName: 'Accepted Group',
      type: 'group',
    });
    expect(chatStore.syncContactProfile).toHaveBeenCalledWith(GROUP_KEY);
    expect(subscribeGroupMembershipRosterUpdates).toHaveBeenCalledWith(
      ['wss://relay.example/'],
      true
    );
    expect(publishPrivateContactList).toHaveBeenCalledWith(['wss://relay.example/']);
    expect(chatStore.reload).toHaveBeenCalled();
  });

  it('restores current group epoch history after accepting an invite with a tracked epoch', async () => {
    const chatStore = {
      init: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
      syncContactProfile: vi.fn(async () => {}),
    };
    const restoreGroupEpochHistory = vi.fn(async () => {});
    const subscribePrivateMessagesForLoggedInUser = vi.fn(async () => {});
    const subscribeGroupMembershipRosterUpdates = vi.fn(async () => {});
    const runtime = createGroupInviteRuntime({
      bumpContactListVersion: vi.fn(),
      chatStore,
      ensureContactListedInPrivateContactList: vi.fn(async () => ({
        contact: buildContactRecord({
          public_key: GROUP_KEY,
          type: 'group',
          name: 'Accepted Group',
        }),
        didChange: true,
      })),
      ensureContactStoredAsGroup: vi.fn(async () =>
        buildContactRecord({
          public_key: GROUP_KEY,
          type: 'group',
          name: 'Accepted Group',
        })
      ),
      getAppRelayUrls: () => ['wss://relay.example/'],
      getLoggedInPublicKeyHex: () => PUBKEY_A,
      publishPrivateContactList: vi.fn(async () => {}),
      refreshGroupContactByPublicKey: vi.fn(async () => null),
      restoreGroupEpochHistory,
      subscribeGroupMembershipRosterUpdates,
      subscribePrivateMessagesForLoggedInUser,
    });

    chatDataServiceMock.getChatByPublicKey.mockResolvedValueOnce({
      public_key: GROUP_KEY,
      type: 'group',
      name: 'Pending Group',
      meta: {
        inbox_state: 'request',
        request_type: 'group_invite',
        request_message: 'This is an invitation to a group.',
        current_epoch_public_key: PUBKEY_B,
        group_epoch_keys: [
          {
            epoch_number: 0,
            epoch_public_key: PUBKEY_B,
            epoch_private_key_encrypted: 'encrypted-epoch-private-key',
            event_id: EVENT_ID_A,
            created_at: '2026-01-05T00:00:00.000Z',
          },
        ],
      },
    } as never);

    await runtime.ensureGroupInvitePubkeyIsContact(GROUP_KEY, 'Accepted Group');

    expect(restoreGroupEpochHistory).toHaveBeenCalledWith(GROUP_KEY, PUBKEY_B, {
      force: true,
    });
    expect(subscribeGroupMembershipRosterUpdates).toHaveBeenCalledWith(
      ['wss://relay.example/'],
      true
    );
    expect(subscribePrivateMessagesForLoggedInUser).not.toHaveBeenCalled();
  });

  it('maintains private contact list membership and reconciles accepted chats', async () => {
    const chatStore = {
      acceptChat: vi.fn(async () => {}),
      init: vi.fn(async () => {}),
    };
    const bumpContactListVersion = vi.fn();
    const runtime = createPrivateContactMembershipRuntime({
      bumpContactListVersion,
      chatStore,
    });

    contactsServiceMock.getContactByPublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 10,
        public_key: PUBKEY_A,
        type: 'user',
        name: 'Alice',
        meta: {},
      } as never)
      .mockResolvedValueOnce({
        id: 11,
        public_key: PUBKEY_A,
        type: 'group',
        name: 'Alice',
        meta: {
          [PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY]: true,
        },
      } as never);
    contactsServiceMock.createContact.mockResolvedValueOnce({
      id: 9,
      public_key: PUBKEY_A,
    } as never);
    contactsServiceMock.updateContact.mockResolvedValueOnce({
      id: 10,
      public_key: PUBKEY_A,
      type: 'group',
      meta: {
        [PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY]: true,
      },
    } as never);

    expect(
      await runtime.ensureContactListedInPrivateContactList(PUBKEY_A, {
        fallbackName: 'Alice',
      })
    ).toMatchObject({
      didChange: true,
    });
    expect(
      await runtime.ensureContactListedInPrivateContactList(PUBKEY_A, {
        type: 'group',
      })
    ).toMatchObject({
      didChange: true,
    });
    expect(
      await runtime.ensureContactListedInPrivateContactList(PUBKEY_A, {
        type: 'group',
      })
    ).toMatchObject({
      didChange: false,
    });

    chatDataServiceMock.getChatByPublicKey
      .mockResolvedValueOnce({
        public_key: PUBKEY_A,
        meta: {},
      } as never)
      .mockResolvedValueOnce({
        public_key: PUBKEY_A,
        meta: {
          inbox_state: 'accepted',
          accepted_at: '2026-01-01T00:00:00.000Z',
        },
      } as never);
    await runtime.reconcileAcceptedChatFromPrivateContactList(PUBKEY_A);
    await runtime.reconcileAcceptedChatFromPrivateContactList(PUBKEY_A);

    expect(chatStore.acceptChat).toHaveBeenCalledWith(PUBKEY_A, {
      acceptedAt: expect.any(String),
    });
    expect(bumpContactListVersion).toHaveBeenCalledTimes(2);
  });

  it('clears and persists auth session state for direct key logins and logout', async () => {
    const localStorage = createMockStorage({
      [AUTH_METHOD_STORAGE_KEY]: 'nsec',
      [NIP46_SIGNER_PAYLOAD_STORAGE_KEY]: 'remote-session',
      [PRIVATE_KEY_STORAGE_KEY]: 'f'.repeat(64),
      [PUBLIC_KEY_STORAGE_KEY]: PUBKEY_A,
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { deps, ndk, refs, restoreRuntimeState, runtime } = createAuthSessionHarness();
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;

    expect(runtime.getPrivateKeyHex()).toBe('f'.repeat(64));
    await expect(runtime.savePrivateKeyHex('invalid')).resolves.toBe(false);
    await expect(runtime.savePrivateKeyHex(privateKey)).resolves.toBe(true);
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBe('nsec');
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBe(privateKey);
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBe(expectedPubkey);
    expect(deps.resetEventSinceForFreshLogin).toHaveBeenCalledTimes(1);
    expect(deps.setCachedSignerSessionKey).toHaveBeenCalledWith(`nsec:${expectedPubkey}`);
    expect(ndk.signer).toBeTruthy();

    runtime.clearPrivateKey();
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(NIP46_SIGNER_PAYLOAD_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBeUndefined();
    expect(deps.resetPrivateMessagesSubscriptionRuntimeState).toHaveBeenCalledWith({
      clearLastEventState: true,
    });
    expect(deps.resetPrivateMessagesUiRuntimeState).toHaveBeenCalled();
    expect(deps.clearPrivatePreferencesStorage).toHaveBeenCalled();
    expect(deps.stopPrivateMessagesSubscription).toHaveBeenCalled();
    expect(deps.clearPrivateMessagesBackfillState).toHaveBeenCalled();
    expect(deps.resetPrivateMessagesBackfillRuntimeState).toHaveBeenCalled();
    expect(deps.resetReconnectHealingRuntimeState).toHaveBeenCalled();

    await runtime.logout();
    expect(refs.eventSince.value).toBe(0);
    expect(refs.isRestoringStartupState.value).toBe(false);
    expect(refs.contactListVersion.value).toBe(0);
    expect(refs.relayStatusVersion.value).toBe(3);
    expect(deps.setRestoreStartupStatePromise).toHaveBeenCalledWith(null);
    expect(deps.setSyncLoggedInContactProfilePromise).toHaveBeenCalledWith(null);
    expect(deps.setSyncRecentChatContactsPromise).toHaveBeenCalledWith(null);
    expect(restoreRuntimeState.restoreContactCursorStatePromise).toBeNull();
    expect(restoreRuntimeState.restoreGroupIdentitySecretsPromise).toBeNull();
    expect(restoreRuntimeState.restorePrivatePreferencesPromise).toBeNull();
    expect(deps.clearRelayStoreState).toHaveBeenCalledTimes(1);
    expect(deps.clearNip65RelayStoreState).toHaveBeenCalledTimes(1);
    expect(logoutCleanupMock.clearPersistedAppState).toHaveBeenCalledTimes(1);
  });

  it('uses Android secure storage instead of localStorage for direct key logins', async () => {
    androidSecurePrivateKeyStorageMock.isAndroidSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { deps, ndk, runtime } = createAuthSessionHarness();
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;

    await expect(runtime.savePrivateKeyHex(privateKey)).resolves.toBe(true);

    expect(androidSecurePrivateKeyStorageMock.writeAndroidSecurePrivateKeyHex).toHaveBeenCalledWith(
      privateKey
    );
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBe('nsec');
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBe(expectedPubkey);
    expect(runtime.getPrivateKeyHex()).toBe(privateKey);
    expect(deps.setCachedSignerSessionKey).toHaveBeenCalledWith(`nsec:${expectedPubkey}`);
    expect(ndk.signer).toBeTruthy();
  });

  it('falls back to a memory-only Android private-key session when secure storage fails', async () => {
    androidSecurePrivateKeyStorageMock.isAndroidSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    androidSecurePrivateKeyStorageMock.writeAndroidSecurePrivateKeyHex.mockRejectedValue(
      new Error('secure storage unavailable')
    );
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime } = createAuthSessionHarness();
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;

    await expect(runtime.savePrivateKeyHex(privateKey)).resolves.toBe(true);

    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(runtime.getPrivateKeyHex()).toBe(privateKey);
    expect(
      androidSecurePrivateKeyStorageMock.markAndroidPrivateKeyMemoryOnlySession
    ).toHaveBeenCalledWith(expectedPubkey);
  });

  it('migrates legacy Android localStorage private keys into secure storage', async () => {
    androidSecurePrivateKeyStorageMock.isAndroidSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;
    const localStorage = createMockStorage({
      [PRIVATE_KEY_STORAGE_KEY]: privateKey,
      [PUBLIC_KEY_STORAGE_KEY]: expectedPubkey,
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime } = createAuthSessionHarness();

    await expect(runtime.loadPrivateKeyHex()).resolves.toBe(privateKey);

    expect(androidSecurePrivateKeyStorageMock.writeAndroidSecurePrivateKeyHex).toHaveBeenCalledWith(
      privateKey
    );
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBe('nsec');
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBe(expectedPubkey);
  });

  it('uses Electron secure storage instead of localStorage for direct key logins', async () => {
    electronSecurePrivateKeyStorageMock.isElectronSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { deps, ndk, runtime } = createAuthSessionHarness();
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;

    await expect(runtime.savePrivateKeyHex(privateKey)).resolves.toBe(true);

    expect(
      electronSecurePrivateKeyStorageMock.writeElectronSecurePrivateKeyHex
    ).toHaveBeenCalledWith(privateKey);
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBe('nsec');
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBe(expectedPubkey);
    expect(runtime.getPrivateKeyHex()).toBe(privateKey);
    expect(deps.setCachedSignerSessionKey).toHaveBeenCalledWith(`nsec:${expectedPubkey}`);
    expect(ndk.signer).toBeTruthy();
  });

  it('falls back to a memory-only Electron private-key session when secure storage fails', async () => {
    electronSecurePrivateKeyStorageMock.isElectronSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    electronSecurePrivateKeyStorageMock.writeElectronSecurePrivateKeyHex.mockRejectedValue(
      new Error('secure storage unavailable')
    );
    const localStorage = createMockStorage();
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime } = createAuthSessionHarness();
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;

    await expect(runtime.savePrivateKeyHex(privateKey)).resolves.toBe(true);

    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(runtime.getPrivateKeyHex()).toBe(privateKey);
    expect(
      electronSecurePrivateKeyStorageMock.markElectronPrivateKeyMemoryOnlySession
    ).toHaveBeenCalledWith(expectedPubkey);
  });

  it('migrates legacy Electron localStorage private keys into secure storage', async () => {
    electronSecurePrivateKeyStorageMock.isElectronSecurePrivateKeyStorageAvailable.mockReturnValue(
      true
    );
    const privateKey = NDKPrivateKeySigner.generate().privateKey;
    const expectedPubkey = new NDKPrivateKeySigner(privateKey).pubkey;
    const localStorage = createMockStorage({
      [PRIVATE_KEY_STORAGE_KEY]: privateKey,
      [PUBLIC_KEY_STORAGE_KEY]: expectedPubkey,
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: localStorage.api,
    };

    const { runtime } = createAuthSessionHarness();

    await expect(runtime.loadPrivateKeyHex()).resolves.toBe(privateKey);

    expect(
      electronSecurePrivateKeyStorageMock.writeElectronSecurePrivateKeyHex
    ).toHaveBeenCalledWith(privateKey);
    expect(localStorage.store.get(AUTH_METHOD_STORAGE_KEY)).toBe('nsec');
    expect(localStorage.store.get(PRIVATE_KEY_STORAGE_KEY)).toBeUndefined();
    expect(localStorage.store.get(PUBLIC_KEY_STORAGE_KEY)).toBe(expectedPubkey);
  });

  it('queues UI refreshes, chat checks, and post-EOSE work for private messages', async () => {
    vi.useFakeTimers();

    const chatStore = {
      reload: vi.fn(async () => {}),
    };
    const refreshDeveloperPendingQueues = vi.fn(async () => {});
    const waitForPrivateMessagesIngestQueue = vi.fn(async () => {});
    const runtime = createPrivateMessagesUiRuntime({
      chatStore,
      normalizeThrottleMs,
      refreshDeveloperPendingQueues,
      waitForPrivateMessagesIngestQueue,
    });

    runtime.queuePrivateMessagesUiRefresh({
      reloadChats: true,
      reloadMessages: true,
    });
    runtime.flushPrivateMessagesUiRefreshNow();
    await flushPromises();
    expect(chatStore.reload).toHaveBeenCalledTimes(1);
    expect(messageStoreMock.reloadLoadedMessages).toHaveBeenCalledTimes(1);

    runtime.queuePrivateMessagesUiRefresh({
      reloadChats: true,
      throttleMs: 20,
    });
    runtime.queuePrivateMessagesUiRefresh({
      reloadMessages: true,
      throttleMs: 20,
    });
    await vi.advanceTimersByTimeAsync(20);
    runtime.flushPrivateMessagesUiRefreshNow();
    await flushPromises();
    expect(chatStore.reload).toHaveBeenCalledTimes(2);
    expect(messageStoreMock.reloadLoadedMessages).toHaveBeenCalledTimes(2);

    runtime.scheduleChatChecks([PUBKEY_A, 'invalid']);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(chatStore.reload).toHaveBeenCalledTimes(3);
    expect(messageStoreMock.syncChatUnseenReactionCount).toHaveBeenCalledWith(PUBKEY_A);

    chatDataServiceMock.listChats.mockResolvedValueOnce([
      {
        public_key: PUBKEY_A,
      },
      {
        public_key: PUBKEY_B,
      },
    ] as never);
    runtime.schedulePostPrivateMessagesEoseChecks();
    await vi.runAllTimersAsync();
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();

    expect(waitForPrivateMessagesIngestQueue).toHaveBeenCalledTimes(1);
    expect(refreshDeveloperPendingQueues).toHaveBeenCalledTimes(1);
    expect(messageStoreMock.syncChatsReadStateFromSeenBoundary).toHaveBeenCalledTimes(1);
    expect(messageStoreMock.syncChatUnseenReactionCount).toHaveBeenCalledWith(PUBKEY_A);
    expect(messageStoreMock.syncChatUnseenReactionCount).toHaveBeenCalledWith(PUBKEY_B);

    runtime.queuePrivateMessagesUiRefresh({
      reloadChats: true,
      throttleMs: 50,
    });
    runtime.resetPrivateMessagesUiRuntimeState({
      includeRefreshQueue: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(chatStore.reload).toHaveBeenCalledTimes(4);
  });
});
