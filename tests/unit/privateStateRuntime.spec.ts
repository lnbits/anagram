import { type ClientEvent, NostrKind } from '#src/lib/nostr/client.ts';
import {
  CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS,
  CONTACT_CURSOR_PUBLISH_DELAY_MS,
  CONTACT_CURSOR_PUBLISH_JITTER_MS,
  CONTACT_CURSOR_SYNC_TIMEOUT_MS,
  PRIVATE_PREFERENCES_KIND,
} from '#src/stores/nostr/constants.ts';
import { createPrivateStateRuntime } from '#src/stores/nostr/privateStateRuntime.ts';
import type { MessageRelayStatus } from '#src/types/chat.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const ndkMocks = vi.hoisted(() => {
  const groupPubkey = 'a'.repeat(64);
  const publishReplaceable = vi.fn().mockResolvedValue(undefined);
  const publish = vi.fn().mockResolvedValue(undefined);
  const relaySetFromRelayUrls = vi.fn((relayUrls: string[]) => ({
    relayUrls,
  }));
  const signerEncrypt = vi.fn(
    async (_user: unknown, content: string, _algorithm?: string) => `encrypted:${content}`,
  );
  const signerDecrypt = vi.fn(async (_user: unknown, content: string, _algorithm?: string) =>
    content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content,
  );

  const signEvent = vi.fn().mockResolvedValue(undefined);

  class MockNDKEvent {
    id?: string;
    kind?: number;
    created_at?: number;
    pubkey?: string;
    content = '';
    tags: string[][] = [];

    constructor(_ndk: unknown, event: Partial<ClientEvent>) {
      Object.assign(this, event);
    }

    getMatchingTags(tagName: string): string[][] {
      return this.tags.filter((tag) => tag[0] === tagName);
    }

    async sign(_signer: unknown): Promise<void> {
      await signEvent(this, _signer);
    }

    async publish(relaySet: unknown): Promise<void> {
      await publish(this, relaySet);
    }

    async publishReplaceable(relaySet: unknown): Promise<void> {
      await publishReplaceable(this, relaySet);
    }
  }

  class MockNDKPrivateKeySigner {
    pubkey: string;
    privateKey: string;

    constructor(privateKey: string) {
      this.privateKey = privateKey;
      this.pubkey = groupPubkey;
    }

    static generate = vi.fn(() => ({
      pubkey: groupPubkey,
      privateKey: 'b'.repeat(64),
    }));

    async user(): Promise<{ pubkey: string }> {
      return {
        pubkey: this.pubkey,
      };
    }

    async encrypt(user: unknown, content: string, algorithm?: string): Promise<string> {
      return signerEncrypt(user, content, algorithm);
    }

    async decrypt(user: unknown, content: string, algorithm?: string): Promise<string> {
      return signerDecrypt(user, content, algorithm);
    }
  }

  return {
    MockNDKEvent,
    MockNDKPrivateKeySigner,
    MockNDKRelaySet: {
      fromRelayUrls: relaySetFromRelayUrls,
    },
    groupPubkey,
    publishReplaceable,
    publish,
    relaySetFromRelayUrls,
    signEvent,
    signerDecrypt,
    signerEncrypt,
  };
});

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    getChatByPublicKey: vi.fn(),
    init: vi.fn(),
    listMessages: vi.fn(),
    messageBatches: vi.fn(),
    reactionMessageBatches: vi.fn(),
    findLatestMessageByAuthor: vi.fn(),
    updateChatMeta: vi.fn(),
    updateChatUnreadCount: vi.fn(),
    updateMessageMeta: vi.fn(),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn(),
    listContacts: vi.fn(),
    updateContact: vi.fn(),
  },
}));

const messageStoreMock = vi.hoisted(() => ({
  reloadLoadedMessages: vi.fn(async () => {}),
  upsertPersistedMessage: vi.fn(async () => {}),
  syncChatsReadStateFromSeenBoundary: vi.fn(async () => ({
    chatCount: 0,
    boundaryAdvancedCount: 0,
    unreadCountAdjustedCount: 0,
    reactionMessageCount: 0,
    reactionsMarkedCount: 0,
  })),
}));

vi.mock('#src/lib/nostr/client.ts', async () => {
  const actual = await vi.importActual<typeof import('#src/lib/nostr/client.ts')>(
    '#src/lib/nostr/client.ts',
  );

  return {
    ...actual,
    ClientEvent: ndkMocks.MockNDKEvent,
    NostrPrivateKeySigner: ndkMocks.MockNDKPrivateKeySigner,
    NostrRelaySet: ndkMocks.MockNDKRelaySet,
  };
});

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: serviceMocks.contactsService,
}));

vi.mock('#src/stores/messageStore.svelte.ts', () => ({
  useMessageStore: () => messageStoreMock,
}));

afterEach(() => {
  vi.useRealTimers();
});

function makeRelayStatus(overrides: Partial<MessageRelayStatus> = {}): MessageRelayStatus {
  return {
    relay_url: 'wss://relay.example/',
    direction: 'outbound',
    scope: 'self',
    status: 'published',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeps(overrides: Record<string, unknown> = {}) {
  const restoreState = {
    restoreContactCursorStatePromise: null,
    restoreGroupIdentitySecretsPromise: null,
    restorePrivatePreferencesPromise: null,
  };
  const ndk = {
    fetchEvent: vi.fn(),
    fetchEvents: vi.fn(),
  };

  const deps = {
    createRecoverableGroup: vi.fn(async () => ({ version: 2, group_pubkey: ndkMocks.groupPubkey,
      group_privkey: 'b'.repeat(64), epoch_number: 0, epoch_privkey: 'epoch-private-key' })),
    beginStartupStep: vi.fn(),
    buildFreshPrivatePreferences: vi.fn((existing?: Record<string, unknown>) => ({
      ...existing,
      contactSecret: 'secret',
    })),
    buildRelaySaveStatus: vi.fn((relayStatuses: MessageRelayStatus[]) => ({
      relayUrls: relayStatuses.map((relayStatus) => relayStatus.relay_url),
      publishedRelayUrls: relayStatuses
        .filter((relayStatus) => relayStatus.status === 'published')
        .map((relayStatus) => relayStatus.relay_url),
      failedRelayUrls: relayStatuses
        .filter((relayStatus) => relayStatus.status === 'failed')
        .map((relayStatus) => relayStatus.relay_url),
      errorMessage: null,
    })),
    bumpContactListVersion: vi.fn(),
    chatStore: {
      reload: vi.fn().mockResolvedValue(undefined),
      refreshChat: vi.fn().mockResolvedValue(undefined),
    },
    chunkValues: vi.fn(<T>(values: T[], chunkSize: number) => {
      const chunks: T[][] = [];
      for (let index = 0; index < values.length; index += chunkSize) {
        chunks.push(values.slice(index, index + chunkSize));
      }
      return chunks;
    }),
    compareReplaceableEventState: vi.fn((first, second) => {
      const firstCreatedAt = Number(first?.created_at ?? 0);
      const secondCreatedAt = Number(second?.created_at ?? 0);
      if (firstCreatedAt !== secondCreatedAt) {
        return firstCreatedAt - secondCreatedAt;
      }

      return String(first?.id ?? '').localeCompare(String(second?.id ?? ''));
    }),
    completeStartupStep: vi.fn(),
    contactRelayListsEqual: vi.fn(
      (first, second) => JSON.stringify(first) === JSON.stringify(second),
    ),
    createInitialGroupEpochSecretState: vi.fn(() => ({
      epoch_number: 0,
      epoch_privkey: 'epoch-private-key',
    })),
    createStartupBatchTracker: vi.fn(() => ({
      beginItem: vi.fn(),
      finishItem: vi.fn(),
      seal: vi.fn(),
    })),
    decryptContactCursorContent: vi.fn(),
    decryptGroupIdentitySecretContent: vi.fn(),
    decryptPrivatePreferencesContent: vi.fn(),
    decryptPrivateStringContent: vi.fn(async () => 'b'.repeat(64)),
    deriveContactCursorDTag: vi.fn(async (contactPublicKey: string) => `dtag-${contactPublicKey}`),
    encryptContactCursorContent: vi.fn(),
    encryptGroupIdentitySecretContent: vi.fn(),
    encryptPrivatePreferencesContent: vi.fn(),
    ensureGroupContactAndChat: vi.fn().mockResolvedValue(false),
    ensureLoggedInSignerUser: vi.fn().mockResolvedValue({
      pubkey: 'f'.repeat(64),
    }),
    ensurePrivatePreferences: vi.fn().mockResolvedValue({
      contactSecret: 'secret',
    }),
    ensureRelayConnections: vi.fn().mockResolvedValue(undefined),
    failStartupStep: vi.fn(),
    fetchContactPreviewByPublicKey: vi.fn().mockResolvedValue(null),
    getFilterSince: vi.fn(() => 0),
    getLoggedInPublicKeyHex: vi.fn(() => 'f'.repeat(64)),
    getStartupStepSnapshot: vi.fn(() => ({
      status: 'pending',
    })),
    isRestoringStartupState: false,
    ndk,
    normalizeEventId: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
    ),
    normalizeTimestamp: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null,
    ),
    pendingContactCursorPublishStates: new Map(),
    pendingContactCursorPublishTimers: new Map(),
    persistIncomingGroupEpochTicket: vi.fn().mockResolvedValue(undefined),
    publishGroupRelayList: vi.fn().mockResolvedValue({
      relayUrls: [],
      publishedRelayUrls: [],
      failedRelayUrls: [],
      errorMessage: null,
    }),
    publishPrivateContactList: vi.fn().mockResolvedValue(undefined),
    publishEventWithRelayStatuses: vi.fn().mockResolvedValue({
      relayStatuses: [makeRelayStatus()],
      error: null,
    }),
    publishReplaceableEventWithRelayStatuses: vi.fn().mockResolvedValue({
      relayStatuses: [makeRelayStatus()],
      error: null,
    }),
    queueTrackedContactSubscriptionsRefresh: vi.fn(),
    readPrivatePreferencesFromStorage: vi.fn(() => null),
    refreshContactRelayList: vi.fn().mockResolvedValue(null),
    resolveLoggedInPublishRelayUrls: vi.fn().mockResolvedValue(['wss://relay.example/']),
    resolveLoggedInReadRelayUrls: vi.fn().mockResolvedValue(['wss://relay.example/']),
    restoreState,
    scheduleChatChecks: vi.fn(),
    sha256Hex: vi.fn(async (value: string) => `sha256:${value}`),
    shouldApplyPrivateContactListEvent: vi.fn(() => true),
    toComparableTimestamp: vi.fn((value: string | null | undefined) =>
      value ? Date.parse(value) || 0 : 0,
    ),
    toIsoTimestampFromUnix: vi.fn((value: number | undefined) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : '',
    ),
    updateStoredEventSinceFromCreatedAt: vi.fn(),
    writePrivatePreferencesToStorage: vi.fn(),
    ...overrides,
  };

  return deps as Parameters<typeof createPrivateStateRuntime>[0] & typeof deps;
}

describe('privateStateRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(null);
    serviceMocks.chatDataService.listMessages.mockResolvedValue([]);
    serviceMocks.chatDataService.messageBatches.mockImplementation(async function* () {
      yield await serviceMocks.chatDataService.listMessages();
    });
    serviceMocks.chatDataService.reactionMessageBatches.mockImplementation(async function* () {
      yield (await serviceMocks.chatDataService.listMessages()).filter(
        (row) => row.meta?.reactions?.length,
      );
    });
    serviceMocks.chatDataService.findLatestMessageByAuthor.mockImplementation(
      async (_chat, author) =>
        (await serviceMocks.chatDataService.listMessages())
          .filter((row) => row.author_public_key === author)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null,
    );

    serviceMocks.chatDataService.updateChatMeta.mockResolvedValue(undefined);
    serviceMocks.chatDataService.updateChatUnreadCount.mockResolvedValue(undefined);
    serviceMocks.chatDataService.updateMessageMeta.mockResolvedValue(undefined);
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(null);
    serviceMocks.contactsService.listContacts.mockResolvedValue([]);
    serviceMocks.contactsService.updateContact.mockResolvedValue(null);
    messageStoreMock.reloadLoadedMessages.mockClear();
    messageStoreMock.syncChatsReadStateFromSeenBoundary.mockClear();
    messageStoreMock.syncChatsReadStateFromSeenBoundary.mockResolvedValue({
      chatCount: 0,
      boundaryAdvancedCount: 0,
      unreadCountAdjustedCount: 0,
      reactionMessageCount: 0,
      reactionsMarkedCount: 0,
    });
    ndkMocks.publishReplaceable.mockClear();
    ndkMocks.publish.mockClear();
    ndkMocks.relaySetFromRelayUrls.mockClear();
    ndkMocks.MockNDKPrivateKeySigner.generate.mockClear();
    ndkMocks.signEvent.mockClear();
    ndkMocks.signerDecrypt.mockClear();
    ndkMocks.signerEncrypt.mockClear();
  });

  it('orders contact cursor state by timestamp first and event id second', () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);

    expect(
      runtime.compareContactCursorState(
        {
          at: '2026-01-01T00:00:00.000Z',
          eventId: 'b',
        },
        {
          at: '2026-01-02T00:00:00.000Z',
          eventId: 'a',
        },
      ),
    ).toBeLessThan(0);

    expect(
      runtime.compareContactCursorState(
        {
          at: '2026-01-02T00:00:00.000Z',
          eventId: 'b',
        },
        {
          at: '2026-01-02T00:00:00.000Z',
          eventId: 'c',
        },
      ),
    ).toBeLessThan(0);
  });

  it('publishes the first contact cursor immediately and coalesces trailing updates', async () => {
    vi.useFakeTimers();
    const deps = createDeps({
      encryptContactCursorContent: vi.fn(async (cursor) => `cursor:${cursor.at}:${cursor.eventId}`),
    });
    const runtime = createPrivateStateRuntime(deps);
    const contactPublicKey = 'a'.repeat(64);

    runtime.scheduleContactCursorPublish(contactPublicKey, {
      at: '2026-01-01T00:00:00.000Z',
      eventId: 'first-event',
    });

    await vi.waitFor(() => expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1));
    expect(deps.pendingContactCursorPublishStates.get(contactPublicKey)).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      eventId: 'first-event',
    });
    expect(deps.encryptContactCursorContent).toHaveBeenLastCalledWith({
      at: '2026-01-01T00:00:00.000Z',
      eventId: 'first-event',
    });

    runtime.scheduleContactCursorPublish(contactPublicKey, {
      at: '2026-01-02T00:00:00.000Z',
      eventId: 'second-event',
    });

    await flushPromises();

    expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1);
    expect(deps.pendingContactCursorPublishStates.get(contactPublicKey)).toEqual({
      at: '2026-01-02T00:00:00.000Z',
      eventId: 'second-event',
    });

    await vi.runOnlyPendingTimersAsync();
    await flushPromises();

    expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(2);
    expect(deps.encryptContactCursorContent).toHaveBeenLastCalledWith({
      at: '2026-01-02T00:00:00.000Z',
      eventId: 'second-event',
    });
    expect(deps.pendingContactCursorPublishStates.has(contactPublicKey)).toBe(false);
  });

  it('publishes rapid private preference changes after the restored timestamp without collisions', async () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);
    const restoredAt = Math.floor(Date.now() / 1000) + 10;
    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: restoredAt,
      content: 'encrypted',
    });
    deps.decryptPrivatePreferencesContent.mockResolvedValue({ contactSecret: 'a'.repeat(64) });
    await runtime.restorePrivatePreferences();
    await runtime.publishPrivatePreferences({
      contactSecret: 'a'.repeat(64),
      irohRelaySettings: { mode: 'custom', customRelays: ['https://one.example.com/'] },
    });
    await runtime.publishPrivatePreferences({
      contactSecret: 'a'.repeat(64),
      irohRelaySettings: { mode: 'custom', customRelays: ['https://two.example.com/'] },
    });
    expect(ndkMocks.publish.mock.calls.map((call) => (call[0] as ClientEvent).created_at)).toEqual([
      restoredAt + 1,
      restoredAt + 2,
    ]);
    expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
  });

  it('restores and persists decrypted private preferences from relays', async () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);

    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: 1700000000,
      content: 'encrypted-preferences',
    });
    deps.decryptPrivatePreferencesContent.mockResolvedValue({
      contactSecret: 'secret-value',
      notifications: true,
    });

    await runtime.restorePrivatePreferences(['wss://seed.example']);

    expect(deps.beginStartupStep).toHaveBeenCalledWith('private-preferences');
    expect(deps.ensureRelayConnections).toHaveBeenCalledWith(['wss://relay.example/']);
    expect(ndkMocks.relaySetFromRelayUrls).toHaveBeenCalledWith(
      ['wss://relay.example/'],
      deps.ndk,
      false,
    );
    expect(deps.decryptPrivatePreferencesContent).toHaveBeenCalledWith('encrypted-preferences');
    expect(deps.writePrivatePreferencesToStorage).toHaveBeenCalledWith({
      contactSecret: 'secret-value',
      notifications: true,
    });
    expect(deps.completeStartupStep).toHaveBeenCalledWith('private-preferences');
    expect(deps.updateStoredEventSinceFromCreatedAt).toHaveBeenCalledWith(1700000000);
  });

  it('creates group chats, publishes the secret, and reports contact-list sync failures without throwing', async () => {
    const deps = createDeps({
      createRecoverableGroup: vi.fn().mockResolvedValue({
        version: 2,
        group_pubkey: ndkMocks.groupPubkey,
        group_privkey: 'b'.repeat(64),
        epoch_number: 0,
        epoch_privkey: 'epoch-private-key',
        recovery_state: { relays: ['wss://relay.example'] },
      }),
      decryptGroupIdentitySecretContent: vi.fn().mockResolvedValue({
        version: 1,
        group_pubkey: ndkMocks.groupPubkey,
        group_privkey: 'b'.repeat(64),
        epoch_number: 0,
        epoch_privkey: 'c'.repeat(64),
      }),
      encryptGroupIdentitySecretContent: vi.fn().mockResolvedValue('encrypted-group-secret'),
      ensureGroupContactAndChat: vi.fn().mockResolvedValue(true),
      publishGroupRelayList: vi.fn().mockResolvedValue({
        relayUrls: ['wss://relay.example/'],
        publishedRelayUrls: ['wss://relay.example/'],
        failedRelayUrls: [],
        errorMessage: null,
      }),
      publishPrivateContactList: vi
        .fn()
        .mockRejectedValue(new Error('Failed to publish private contact list.')),
    });
    const runtime = createPrivateStateRuntime(deps);

    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Launch Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_private_key_encrypted: 'encrypted-group-secret',
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.contactsService.updateContact.mockResolvedValue({
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Launch Group',
      given_name: null,
      meta: {},
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    });

    const result = await runtime.createGroupChat({
      recoveryPhrase: 'test-phrase-handled-by-mock',
      name: 'Launch Group',
      about: 'Roadmap',
      relayUrls: ['wss://relay.example', 'wss://unavailable.example'],
    });

    expect(result.relayUrls).toEqual(['wss://relay.example']);
    expect(deps.publishPrivateContactList).toHaveBeenCalledWith(['wss://relay.example']);
    expect(result.groupPublicKey).toBe(ndkMocks.groupPubkey);
    expect(result.encryptedPrivateKey).toBe('encrypted-group-secret');
    expect(result.groupSecretSave).toEqual({
      relayUrls: ['wss://relay.example/'],
      publishedRelayUrls: ['wss://relay.example/'],
      failedRelayUrls: [],
      errorMessage: null,
    });
    expect(result.memberListSyncError).toBeNull();
    expect(result.contactListSyncError).toBe('Failed to publish private contact list.');
    const publishEventMock = deps.publishEventWithRelayStatuses as ReturnType<typeof vi.fn>;
    const groupListPublishCalls = publishEventMock.mock.calls.filter(
      ([event]) => event.kind === 30000,
    );
    const ownerListPublishCall = groupListPublishCalls.find(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'members',
    );
    const sharedRosterPublishCall = groupListPublishCalls.find(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'roster',
    );
    expect(ownerListPublishCall?.[0]).toMatchObject({
      kind: 30000,
      pubkey: ndkMocks.groupPubkey,
      tags: [['d', 'members']],
    });
    expect(String(ownerListPublishCall?.[0]?.content ?? '')).toBe('encrypted:[]');
    expect(sharedRosterPublishCall?.[0]).toMatchObject({
      kind: 30000,
      pubkey: ndkMocks.groupPubkey,
      tags: [['d', 'roster']],
    });
    expect(String(sharedRosterPublishCall?.[0]?.content ?? '')).toBe(
      `encrypted:${JSON.stringify([['p', 'f'.repeat(64)]])}`,
    );
    expect(deps.persistIncomingGroupEpochTicket).toHaveBeenCalledWith(
      ndkMocks.groupPubkey,
      0,
      'epoch-private-key',
      expect.objectContaining({
        accepted: true,
        fallbackName: 'Launch Group',
      }),
    );
    expect(deps.publishGroupRelayList).toHaveBeenCalledWith(
      ndkMocks.groupPubkey,
      [
        expect.objectContaining({
          url: 'wss://relay.example',
          read: true,
          write: true,
        }),
      ],
      ['wss://relay.example'],
    );
    expect(deps.chatStore.reload).toHaveBeenCalled();
  });

  it('publishes rapid same-stream group follow-set updates with increasing timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Roster Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_private_key_encrypted: 'encrypted-group-secret',
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const deps = createDeps({
      decryptGroupIdentitySecretContent: vi.fn().mockResolvedValue({
        version: 1,
        group_pubkey: ndkMocks.groupPubkey,
        group_privkey: 'b'.repeat(64),
        epoch_number: 0,
        epoch_privkey: 'c'.repeat(64),
      }),
    });
    const runtime = createPrivateStateRuntime(deps);

    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(groupContact);

    await runtime.publishGroupMembershipRosterFollowSet(
      ndkMocks.groupPubkey,
      ['c'.repeat(64)],
      ['wss://relay.example'],
    );
    await runtime.publishGroupMembershipRosterFollowSet(
      ndkMocks.groupPubkey,
      ['d'.repeat(64)],
      ['wss://relay.example'],
    );
    await runtime.publishGroupMembershipFollowSet(
      ndkMocks.groupPubkey,
      ['c'.repeat(64)],
      ['wss://relay.example'],
    );
    await runtime.publishGroupMembershipFollowSet(
      ndkMocks.groupPubkey,
      ['d'.repeat(64)],
      ['wss://relay.example'],
    );

    const publishEventMock = deps.publishEventWithRelayStatuses as ReturnType<typeof vi.fn>;
    const rosterCalls = publishEventMock.mock.calls.filter(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'roster',
    );
    const memberCalls = publishEventMock.mock.calls.filter(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'members',
    );

    expect(rosterCalls).toHaveLength(2);
    expect(memberCalls).toHaveLength(2);
    expect(rosterCalls[0]?.[0]?.created_at).toBe(1767225600);
    expect(rosterCalls[1]?.[0]?.created_at).toBe(1767225601);
    expect(memberCalls[0]?.[0]?.created_at).toBe(1767225600);
    expect(memberCalls[1]?.[0]?.created_at).toBe(1767225601);
  });

  it('refreshes group members from the shared roster and persists non-owner members only', async () => {
    const deps = createDeps({
      decryptPrivateStringContent: vi.fn(async () => 'b'.repeat(64)),
      fetchContactPreviewByPublicKey: vi.fn().mockImplementation(async (pubkeyHex: string) => {
        if (pubkeyHex === 'c'.repeat(64)) {
          return {
            public_key: 'c'.repeat(64),
            name: 'Charlie',
            given_name: 'Charlie',
            meta: {
              about: 'New member',
              picture: 'https://example.com/charlie.png',
              avatar: 'CH',
              nip05: 'charlie@example.com',
              nprofile: 'nprofile-charlie',
            },
          };
        }

        return null;
      }),
      refreshContactRelayList: vi
        .fn()
        .mockResolvedValue([{ url: 'wss://relay.example/', read: true, write: true }]),
    });
    const runtime = createPrivateStateRuntime(deps);
    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Roster Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_members: [{ public_key: 'd'.repeat(64), name: 'Old Member' }],
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const groupChat = {
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      meta: {
        current_epoch_public_key: ndkMocks.groupPubkey,
        current_epoch_private_key_encrypted: 'encrypted-current-epoch',
      },
    };

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(
      async (pubkey: string) => {
        if (pubkey === ndkMocks.groupPubkey) {
          return groupContact;
        }

        if (pubkey === 'c'.repeat(64)) {
          return {
            id: 11,
            public_key: 'c'.repeat(64),
            type: 'user',
            name: 'Charlie',
            given_name: 'Charlie',
            meta: {
              about: 'New member',
              picture: 'https://example.com/charlie.png',
              avatar: 'CH',
              nip05: 'charlie@example.com',
              nprofile: 'nprofile-charlie',
            },
            relays: [],
            sendMessagesToAppRelays: false,
          };
        }

        return null;
      },
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);
    serviceMocks.contactsService.updateContact.mockResolvedValue({
      ...groupContact,
      meta: {
        ...groupContact.meta,
        group_members: [
          {
            public_key: 'c'.repeat(64),
            name: 'Charlie',
            given_name: 'Charlie',
            about: 'New member',
            picture: 'https://example.com/charlie.png',
            avatar: 'CH',
            nip05: 'charlie@example.com',
            nprofile: 'nprofile-charlie',
          },
        ],
      },
    });
    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: 1700000002,
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    });
    ndkMocks.signerDecrypt.mockImplementation(async (_user: unknown, content: string) => {
      if (content === 'encrypted-roster') {
        return JSON.stringify([
          ['p', 'f'.repeat(64)],
          ['p', 'c'.repeat(64)],
        ]);
      }

      return content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content;
    });

    const result = await runtime.refreshGroupMembershipRoster(ndkMocks.groupPubkey, [
      'wss://seed.example',
    ]);

    expect(result.ownerIncluded).toBe(true);
    expect(result.memberPublicKeys).toEqual(['c'.repeat(64), 'f'.repeat(64)]);
    expect(deps.fetchContactPreviewByPublicKey).toHaveBeenCalledWith(
      'c'.repeat(64),
      'cccccccccccccccc',
      expect.objectContaining({
        seedRelayUrls: expect.arrayContaining(['wss://seed.example/', 'wss://relay.example/']),
      }),
    );
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      metaBase: groupContact.meta,
      meta: expect.objectContaining({
        owner_public_key: 'f'.repeat(64),
        group_members: [
          expect.objectContaining({
            public_key: 'c'.repeat(64),
            name: 'Charlie',
            picture: 'https://example.com/charlie.png',
            avatar: 'CH',
          }),
        ],
      }),
    });
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(1);
  });

  it('retries shared roster persistence when the first group contact write misses', async () => {
    const deps = createDeps({
      decryptPrivateStringContent: vi.fn(async () => 'b'.repeat(64)),
      fetchContactPreviewByPublicKey: vi.fn().mockResolvedValue({
        public_key: 'c'.repeat(64),
        name: 'Charlie Retry Persist',
        given_name: 'Charlie',
        meta: {
          about: 'Retried write',
          nip05: 'charlie-retry@example.com',
          nprofile: 'nprofile-charlie-retry',
        },
      }),
      refreshContactRelayList: vi
        .fn()
        .mockResolvedValue([{ url: 'wss://relay.example/', read: true, write: true }]),
    });
    const runtime = createPrivateStateRuntime(deps);
    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Retry Persist Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_members: [],
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const groupChat = {
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      meta: {
        current_epoch_public_key: ndkMocks.groupPubkey,
        current_epoch_private_key_encrypted: 'encrypted-current-epoch',
      },
    };

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(
      async (pubkey: string) => {
        if (pubkey === ndkMocks.groupPubkey) {
          return groupContact;
        }

        return null;
      },
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);
    serviceMocks.contactsService.updateContact.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...groupContact,
      meta: {
        ...groupContact.meta,
        group_members: [
          {
            public_key: 'c'.repeat(64),
            name: 'Charlie Retry Persist',
            given_name: 'Charlie',
            about: 'Retried write',
            nip05: 'charlie-retry@example.com',
            nprofile: 'nprofile-charlie-retry',
          },
        ],
      },
    });
    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: 1700000002,
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    });
    ndkMocks.signerDecrypt.mockImplementation(async (_user: unknown, content: string) => {
      if (content === 'encrypted-roster') {
        return JSON.stringify([
          ['p', 'f'.repeat(64)],
          ['p', 'c'.repeat(64)],
        ]);
      }

      return content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content;
    });

    const result = await runtime.refreshGroupMembershipRoster(ndkMocks.groupPubkey, [
      'wss://seed.example',
    ]);

    expect(result.didChange).toBe(true);
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(2);
    expect(serviceMocks.contactsService.updateContact).toHaveBeenLastCalledWith(7, {
      metaBase: groupContact.meta,
      meta: expect.objectContaining({
        owner_public_key: 'f'.repeat(64),
        group_members: [
          expect.objectContaining({
            public_key: 'c'.repeat(64),
            name: 'Charlie Retry Persist',
          }),
        ],
      }),
    });
  });

  it('skips incoming group roster events until the group contact exists locally', async () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rosterEvent = {
      kind: NostrKind.FollowSet,
      id: 'ROSTER-EVENT',
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    } as unknown as ClientEvent;

    await expect(
      runtime.applyGroupMembershipRosterEvent(rosterEvent, {
        seedRelayUrls: ['wss://seed.example'],
      }),
    ).resolves.toBe(false);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Skipping group roster event until group context is ready or readable',
      expect.objectContaining({
        eventId: 'roster-event',
        groupPublicKey: ndkMocks.groupPubkey,
        error: expect.objectContaining({
          message: 'Group contact not found.',
        }),
      }),
    );

    consoleWarnSpy.mockRestore();
  });

  it('skips incoming group roster events when shared-roster persistence misses during startup races', async () => {
    const deps = createDeps({
      decryptPrivateStringContent: vi.fn(async () => 'b'.repeat(64)),
    });
    const runtime = createPrivateStateRuntime(deps);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Race Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_members: [],
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const groupChat = {
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      meta: {
        current_epoch_public_key: ndkMocks.groupPubkey,
        current_epoch_private_key_encrypted: 'encrypted-current-epoch',
      },
    };
    const rosterEvent = {
      kind: NostrKind.FollowSet,
      id: 'roster-persist-race',
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    } as unknown as ClientEvent;

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(
      async (pubkey: string) => {
        if (pubkey === ndkMocks.groupPubkey) {
          return groupContact;
        }

        return null;
      },
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);
    serviceMocks.contactsService.updateContact.mockResolvedValue(null);
    ndkMocks.signerDecrypt.mockImplementation(async (_user: unknown, content: string) => {
      if (content === 'encrypted-roster') {
        return JSON.stringify([
          ['p', 'f'.repeat(64)],
          ['p', 'c'.repeat(64)],
        ]);
      }

      return content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content;
    });

    await expect(
      runtime.applyGroupMembershipRosterEvent(rosterEvent, {
        seedRelayUrls: ['wss://seed.example'],
      }),
    ).resolves.toBe(false);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(2);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Skipping group roster event until group context is ready or readable',
      expect.objectContaining({
        eventId: 'roster-persist-race',
        groupPublicKey: ndkMocks.groupPubkey,
        error: expect.objectContaining({
          message: 'Failed to persist refreshed group members.',
        }),
      }),
    );

    consoleWarnSpy.mockRestore();
  });

  it('retries missing member previews once when refreshing the shared roster', async () => {
    vi.useFakeTimers();

    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Retry Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_private_key_encrypted: 'encrypted-group-secret-event',
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const groupChat = {
      id: 8,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      meta: {
        current_epoch_public_key: ndkMocks.groupPubkey,
        current_epoch_private_key_encrypted: 'encrypted-current-epoch',
      },
    };
    const deps = createDeps({
      decryptGroupIdentitySecretContent: vi.fn().mockImplementation(async (content: string) => {
        if (content !== 'encrypted-group-secret-event') {
          return null;
        }

        return {
          version: 1,
          group_pubkey: ndkMocks.groupPubkey,
          group_privkey: 'b'.repeat(64),
          epoch_number: 0,
          epoch_privkey: 'epoch-private-key',
          name: 'Retry Group',
        };
      }),
      ensureGroupContactAndChat: vi.fn().mockResolvedValue(false),
      fetchContactPreviewByPublicKey: vi
        .fn()
        .mockResolvedValueOnce({
          public_key: 'c'.repeat(64),
          name: 'cccccccccccccccc',
          given_name: null,
          meta: {},
        })
        .mockResolvedValueOnce({
          public_key: 'c'.repeat(64),
          name: 'Charlie Retry',
          given_name: 'Charlie',
          meta: {
            name: 'Charlie Retry',
            about: 'Retried member preview',
          },
        }),
      refreshContactRelayList: vi.fn().mockResolvedValue(groupContact.relays),
    });
    const runtime = createPrivateStateRuntime(deps);

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(async (pubkey: string) =>
      pubkey === ndkMocks.groupPubkey ? groupContact : null,
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);
    serviceMocks.contactsService.updateContact.mockResolvedValue({
      ...groupContact,
      meta: {
        ...groupContact.meta,
        group_members: [
          {
            public_key: 'c'.repeat(64),
            name: 'Charlie Retry',
            given_name: 'Charlie',
            about: 'Retried member preview',
          },
        ],
      },
    });
    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: 1700000002,
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    });
    ndkMocks.signerDecrypt.mockImplementation(async (_user: unknown, content: string) => {
      if (content === 'encrypted-roster') {
        return JSON.stringify([
          ['p', 'f'.repeat(64)],
          ['p', 'c'.repeat(64)],
        ]);
      }

      return content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content;
    });

    const refreshPromise = runtime.refreshGroupMembershipRoster(ndkMocks.groupPubkey, [
      'wss://seed.example',
    ]);
    await vi.advanceTimersByTimeAsync(500);
    const result = await refreshPromise;

    expect(result.fallbackProfileCount).toBe(0);
    expect(result.refreshedProfileCount).toBe(1);
    expect(deps.fetchContactPreviewByPublicKey).toHaveBeenCalledTimes(2);
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      metaBase: groupContact.meta,
      meta: expect.objectContaining({
        group_members: [
          expect.objectContaining({
            public_key: 'c'.repeat(64),
            name: 'Charlie Retry',
          }),
        ],
      }),
    });
  });

  it('restores group members from the latest group-authored follow set and excludes owner and group pubkeys', async () => {
    const groupContact = {
      id: 7,
      public_key: ndkMocks.groupPubkey,
      type: 'group',
      name: 'Restored Group',
      given_name: null,
      meta: {
        owner_public_key: 'f'.repeat(64),
        group_private_key_encrypted: 'encrypted-group-secret-event',
      },
      relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    const deps = createDeps({
      decryptGroupIdentitySecretContent: vi.fn().mockImplementation(async (content: string) => {
        if (content !== 'encrypted-group-secret-event') {
          return null;
        }

        return {
          version: 1,
          group_pubkey: ndkMocks.groupPubkey,
          group_privkey: 'b'.repeat(64),
          epoch_number: 0,
          epoch_privkey: 'epoch-private-key',
          name: 'Restored Group',
        };
      }),
      ensureGroupContactAndChat: vi.fn().mockResolvedValue(false),
      refreshContactRelayList: vi.fn().mockResolvedValue(groupContact.relays),
    });
    const runtime = createPrivateStateRuntime(deps);

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(async (pubkey: string) =>
      pubkey === ndkMocks.groupPubkey ? groupContact : null,
    );
    serviceMocks.contactsService.updateContact.mockResolvedValue({
      ...groupContact,
      meta: {
        ...groupContact.meta,
        group_members: [{ public_key: 'b'.repeat(64), name: 'b'.repeat(64) }],
      },
    });
    (deps.ndk.fetchEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        created_at: 1700000000,
        content: 'encrypted-group-secret-event',
        getMatchingTags: (tagName: string) =>
          tagName === 'd' ? [['d', ndkMocks.groupPubkey]] : [],
      },
    ]);
    (deps.ndk.fetchEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      created_at: 1700000001,
      content: 'encrypted-members',
    });
    ndkMocks.signerDecrypt.mockImplementation(async (_user: unknown, content: string) => {
      if (content === 'encrypted-members') {
        return JSON.stringify([
          ['p', 'b'.repeat(64)],
          ['p', 'f'.repeat(64)],
          ['p', ndkMocks.groupPubkey],
        ]);
      }

      return content;
    });

    await runtime.restoreGroupIdentitySecrets(['wss://seed.example']);

    expect(deps.refreshContactRelayList).not.toHaveBeenCalled();
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      metaBase: groupContact.meta,
      meta: expect.objectContaining({
        owner_public_key: 'f'.repeat(64),
        group_private_key_encrypted: 'encrypted-group-secret-event',
        group_members: [{ public_key: 'b'.repeat(64), name: 'b'.repeat(64) }],
      }),
    });
    expect(deps.persistIncomingGroupEpochTicket).toHaveBeenCalledWith(
      ndkMocks.groupPubkey,
      0,
      'epoch-private-key',
      expect.objectContaining({
        accepted: true,
        fallbackName: 'Restored Group',
      }),
    );
    expect(deps.chatStore.reload).toHaveBeenCalled();
  });

  it('applies contact cursor state by viewing older reactions, reopening newer ones, and recalculating counts', async () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);
    const contactPublicKey = 'a'.repeat(64);
    const loggedInPublicKey = 'f'.repeat(64);
    const cursorAt = '2026-01-03T00:00:00.000Z';

    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: contactPublicKey,
      public_key: contactPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Latest',
      last_message_at: '2026-01-04T00:00:00.000Z',
      unread_count: 5,
      meta: {},
    });
    serviceMocks.chatDataService.listMessages.mockResolvedValue([
      {
        id: 11,
        chat_public_key: contactPublicKey,
        author_public_key: loggedInPublicKey,
        created_at: '2026-01-02T00:00:00.000Z',
        meta: {
          reactions: [
            {
              emoji: '👍',
              name: 'thumbs up',
              reactorPublicKey: contactPublicKey,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
            {
              emoji: '🔥',
              name: 'fire',
              reactorPublicKey: contactPublicKey,
              createdAt: '2026-01-04T00:00:00.000Z',
              viewedByAuthorAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      },
      {
        id: 12,
        chat_public_key: contactPublicKey,
        author_public_key: contactPublicKey,
        created_at: '2026-01-04T00:00:00.000Z',
        meta: {},
      },
    ]);

    await expect(
      runtime.applyContactCursorStateToContact(
        {
          id: 7,
          public_key: contactPublicKey,
          type: 'user',
          name: 'Alice',
          given_name: null,
          meta: {
            last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
            last_seen_incoming_activity_event_id: 'older-event',
          },
          relays: [],
          sendMessagesToAppRelays: false,
        },
        {
          version: '0.1',
          last_seen_incoming_activity_at: cursorAt,
          last_seen_incoming_activity_event_id: 'cursor-event',
        },
      ),
    ).resolves.toBe(true);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      metaBase: {
        last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
        last_seen_incoming_activity_event_id: 'older-event',
      },
      meta: {
        last_seen_incoming_activity_at: cursorAt,
        last_seen_incoming_activity_event_id: 'cursor-event',
      },
    });
    expect(serviceMocks.chatDataService.updateMessageMeta).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        reactions: [
          {
            emoji: '👍',
            name: 'thumbs up',
            reactorPublicKey: contactPublicKey,
            createdAt: '2026-01-02T00:00:00.000Z',
            viewedByAuthorAt: cursorAt,
          },
          {
            emoji: '🔥',
            name: 'fire',
            reactorPublicKey: contactPublicKey,
            createdAt: '2026-01-04T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(serviceMocks.chatDataService.updateChatMeta).toHaveBeenCalledWith(contactPublicKey, {
      last_seen_received_activity_at: cursorAt,
      unseen_reaction_count: 1,
    });
    expect(serviceMocks.chatDataService.updateChatUnreadCount).toHaveBeenCalledWith(
      contactPublicKey,
      1,
    );
    expect(deps.scheduleChatChecks).toHaveBeenCalledWith([contactPublicKey]);
  });

  it('uses the latest own message as the local read boundary when the relay cursor is older', async () => {
    const deps = createDeps();
    const runtime = createPrivateStateRuntime(deps);
    const contactPublicKey = 'a'.repeat(64);
    const loggedInPublicKey = 'f'.repeat(64);

    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: contactPublicKey,
      public_key: contactPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Latest',
      last_message_at: '2026-01-06T00:00:00.000Z',
      unread_count: 5,
      meta: {
        last_seen_received_activity_at: '2026-01-05T00:00:00.000Z',
      },
    });
    serviceMocks.chatDataService.listMessages.mockResolvedValue([
      {
        id: 11,
        chat_public_key: contactPublicKey,
        author_public_key: contactPublicKey,
        created_at: '2026-01-04T00:00:00.000Z',
        meta: {},
      },
      {
        id: 12,
        chat_public_key: contactPublicKey,
        author_public_key: contactPublicKey,
        created_at: '2026-01-06T00:00:00.000Z',
        meta: {},
      },
      {
        id: 13,
        chat_public_key: contactPublicKey,
        author_public_key: loggedInPublicKey,
        created_at: '2026-01-07T00:00:00.000Z',
        meta: {},
      },
    ]);

    await expect(
      runtime.applyContactCursorStateToContact(
        {
          id: 7,
          public_key: contactPublicKey,
          type: 'user',
          name: 'Alice',
          given_name: null,
          meta: {
            last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
            last_seen_incoming_activity_event_id: 'older-event',
          },
          relays: [],
          sendMessagesToAppRelays: false,
        },
        {
          version: '0.1',
          last_seen_incoming_activity_at: '2026-01-03T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'cursor-event',
        },
      ),
    ).resolves.toBe(true);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      metaBase: {
        last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
        last_seen_incoming_activity_event_id: 'older-event',
      },
      meta: {
        last_seen_incoming_activity_at: '2026-01-03T00:00:00.000Z',
        last_seen_incoming_activity_event_id: 'cursor-event',
      },
    });
    expect(serviceMocks.chatDataService.updateChatMeta).toHaveBeenCalledWith(contactPublicKey, {
      last_seen_received_activity_at: '2026-01-07T00:00:00.000Z',
    });
    expect(serviceMocks.chatDataService.updateChatUnreadCount).toHaveBeenCalledWith(
      contactPublicKey,
      0,
    );
  });

  it('treats missing private preferences as a no-op contact-cursor restore', async () => {
    const deps = createDeps({
      getStartupStepSnapshot: vi.fn(() => ({
        status: 'success',
      })),
      readPrivatePreferencesFromStorage: vi.fn(() => null),
    });
    const runtime = createPrivateStateRuntime(deps);

    await runtime.restoreContactCursorState(['wss://seed.example']);

    expect(deps.beginStartupStep).toHaveBeenCalledWith('contact-cursor-data');
    expect(deps.completeStartupStep).toHaveBeenCalledWith('contact-cursor-data');
    expect(serviceMocks.contactsService.init).not.toHaveBeenCalled();
    expect(deps.chatStore.reload).not.toHaveBeenCalled();
  });

  it('skips chat and message reloads when no contact cursors are restored from relays', async () => {
    const deps = createDeps({
      readPrivatePreferencesFromStorage: vi.fn(() => ({
        contactSecret: 'secret',
      })),
    });
    const runtime = createPrivateStateRuntime(deps);

    serviceMocks.contactsService.listContacts.mockResolvedValue([
      {
        id: 7,
        public_key: 'a'.repeat(64),
        type: 'user',
        name: 'Alice',
        given_name: null,
        meta: {},
        relays: [],
        sendMessagesToAppRelays: false,
      },
    ]);
    (deps.ndk.fetchEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await runtime.restoreContactCursorState(['wss://seed.example']);

    expect(deps.completeStartupStep).toHaveBeenCalledWith('contact-cursor-data');
    expect(serviceMocks.contactsService.updateContact).not.toHaveBeenCalled();
    expect(deps.chatStore.reload).not.toHaveBeenCalled();
    expect(messageStoreMock.syncChatsReadStateFromSeenBoundary).not.toHaveBeenCalled();
  });

  it('reconciles local contact cursor read state when relays have no newer cursor', async () => {
    const deps = createDeps({
      readPrivatePreferencesFromStorage: vi.fn(() => ({
        contactSecret: 'secret',
      })),
    });
    const runtime = createPrivateStateRuntime(deps);
    const contactPublicKey = 'a'.repeat(64);

    serviceMocks.contactsService.listContacts.mockResolvedValue([
      {
        id: 7,
        public_key: contactPublicKey,
        type: 'user',
        name: 'Alice',
        given_name: null,
        meta: {
          last_seen_incoming_activity_at: '2026-01-03T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'cursor-event',
        },
        relays: [],
        sendMessagesToAppRelays: false,
      },
    ]);
    (deps.ndk.fetchEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    messageStoreMock.syncChatsReadStateFromSeenBoundary.mockResolvedValueOnce({
      chatCount: 1,
      boundaryAdvancedCount: 1,
      unreadCountAdjustedCount: 1,
      reactionMessageCount: 0,
      reactionsMarkedCount: 0,
    });

    await runtime.restoreContactCursorState(['wss://seed.example']);

    expect(serviceMocks.contactsService.updateContact).not.toHaveBeenCalled();
    expect(messageStoreMock.syncChatsReadStateFromSeenBoundary).toHaveBeenCalledWith([
      contactPublicKey,
    ]);
    expect(deps.chatStore.reload).toHaveBeenCalledTimes(1);
    expect(messageStoreMock.reloadLoadedMessages).toHaveBeenCalledTimes(1);
    expect(deps.completeStartupStep).toHaveBeenCalledWith('contact-cursor-data');
  });

  describe('live contact cursor sync', () => {
    const account = 'f'.repeat(64);
    const contactPublicKey = 'a'.repeat(64);

    function makeContact(meta: Record<string, unknown> = {}) {
      return {
        id: 7,
        public_key: contactPublicKey,
        type: 'user',
        name: 'Alice',
        given_name: null,
        meta,
        relays: [],
        sendMessagesToAppRelays: false,
      };
    }

    function makeCursorEvent(at: string, overrides: Record<string, unknown> = {}): ClientEvent {
      return new ndkMocks.MockNDKEvent(undefined, {
        kind: PRIVATE_PREFERENCES_KIND,
        pubkey: account,
        created_at: 1_800_000_000,
        content: JSON.stringify({
          version: '0.1',
          last_seen_incoming_activity_at: at,
          last_seen_incoming_activity_event_id: `event-${at}`,
        }),
        tags: [['d', `dtag-${contactPublicKey}`]],
        ...overrides,
      } as Partial<ClientEvent>) as unknown as ClientEvent;
    }

    function createLiveRuntime(
      overrides: Record<string, unknown> = {},
      // 'connected': only the relays connected at the time finished their replay.
      options: { sendEose?: boolean | 'connected' } = {},
    ) {
      const subscriptions: Array<{
        filters: unknown;
        onEvent: (event: ClientEvent) => void;
        onEose: () => void;
        // Called by the client once every relay of the subscription has closed.
        onClose: () => void;
        on: ReturnType<typeof vi.fn>;
        // Every relay of the subscription finished its replay (the client's 'eose' event).
        completeSync: () => void;
        stop: ReturnType<typeof vi.fn>;
      }> = [];
      const deps = createDeps({
        readPrivatePreferencesFromStorage: vi.fn(() => ({ contactSecret: 'secret' })),
        decryptContactCursorContent: vi.fn(async (content: string) => JSON.parse(content)),
        encryptContactCursorContent: vi.fn(async (cursor) => `cursor:${cursor.at}`),
        getFilterSince: vi.fn(() => 1_700_000_000),
        subscribeWithReqLogging: vi.fn((_label, _request, filters, subscriptionOptions) => {
          const eoseListeners: Array<() => void> = [];
          const subscription = {
            filters,
            onEvent: subscriptionOptions.onEvent,
            onEose: subscriptionOptions.onEose,
            onClose: subscriptionOptions.onClose,
            on: vi.fn((name: string, listener: () => void) => {
              if (name === 'eose') eoseListeners.push(listener);
            }),
            completeSync: () => {
              subscription.onEose?.();
              for (const listener of eoseListeners) listener();
            },
            // Like the client, a stopped subscription reports its close.
            stop: vi.fn(() => subscription.onClose?.()),
          };
          subscriptions.push(subscription);
          // Relays finish their replay at once unless a test holds EOSE back.
          if (options.sendEose === 'connected') queueMicrotask(() => subscription.onEose?.());
          else if (options.sendEose !== false) queueMicrotask(() => subscription.completeSync());
          return subscription;
        }),
        ...overrides,
      });
      return { deps, runtime: createPrivateStateRuntime(deps), subscriptions };
    }

    function cursorContent(at: string, eventId = `event-${at}`): string {
      return JSON.stringify({
        version: '0.1',
        last_seen_incoming_activity_at: at,
        last_seen_incoming_activity_event_id: eventId,
      });
    }

    function publishedCursors(): Array<{ content: string; created_at: number; tags: string[][] }> {
      return ndkMocks.publishReplaceable.mock.calls.map(([event]) => event);
    }

    beforeEach(() => {
      serviceMocks.contactsService.listContacts.mockResolvedValue([makeContact()]);
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(makeContact());
    });

    it('subscribes by account and kind only, then applies a newer cursor from another device', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
        id: contactPublicKey,
        public_key: contactPublicKey,
        type: 'user',
        name: 'Alice',
        last_message: 'Hi',
        last_message_at: '2026-01-02T00:00:00.000Z',
        unread_count: 2,
        meta: {},
      });
      serviceMocks.chatDataService.listMessages.mockResolvedValue([
        { id: 1, author_public_key: contactPublicKey, created_at: '2026-01-02T00:00:00.000Z' },
      ]);

      await runtime.subscribeContactCursorUpdates(['wss://seed.example']);
      await flushPromises();

      expect(subscriptions).toHaveLength(1);
      // Resumed sessions catch up from the stored boundary, not just from "now".
      expect(subscriptions[0].filters).toEqual({
        kinds: [PRIVATE_PREFERENCES_KIND],
        authors: [account],
        since: 1_700_000_000,
      });
      expect(JSON.stringify(subscriptions[0].filters)).not.toContain(contactPublicKey);
      expect(JSON.stringify(subscriptions[0].filters)).not.toContain('dtag');

      subscriptions[0].onEvent(makeCursorEvent('2026-01-03T00:00:00.000Z'));

      // Only the affected chat is re-read; the inbox and loaded threads are not reloaded.
      await vi.waitFor(() =>
        expect(deps.chatStore.refreshChat).toHaveBeenCalledExactlyOnceWith(contactPublicKey),
      );
      expect(deps.chatStore.reload).not.toHaveBeenCalled();
      expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
        metaBase: {},
        meta: {
          last_seen_incoming_activity_at: '2026-01-03T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'event-2026-01-03T00:00:00.000Z',
        },
      });
      expect(serviceMocks.chatDataService.updateChatUnreadCount).toHaveBeenCalledWith(
        contactPublicKey,
        0,
      );
      expect(messageStoreMock.reloadLoadedMessages).not.toHaveBeenCalled();
    });

    it('ignores preferences, group secrets, foreign authors and unknown d-tags', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      const at = '2026-01-03T00:00:00.000Z';
      subscriptions[0].onEvent(makeCursorEvent(at, { tags: [['d', '1']] }));
      subscriptions[0].onEvent(
        makeCursorEvent(at, { tags: [['d', 'b'.repeat(64)], ['t', 'group']] }),
      );
      subscriptions[0].onEvent(makeCursorEvent(at, { pubkey: 'e'.repeat(64) }));
      subscriptions[0].onEvent(makeCursorEvent(at, { tags: [['d', 'unknown']] }));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deps.decryptContactCursorContent).not.toHaveBeenCalled();
      expect(serviceMocks.contactsService.updateContact).not.toHaveBeenCalled();
      expect(deps.chatStore.reload).not.toHaveBeenCalled();
    });

    async function settleLiveEvents(): Promise<void> {
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }

    it('handles the echo of its own publish without decrypting or rescanning the chat', async () => {
      // Publishing and resolving derive the same d-tag, as in the app.
      const { deps, runtime, subscriptions } = createLiveRuntime({
        deriveContactCursorDTag: vi.fn(async (publicKey: string) => `sha256:secret${publicKey}`),
      });
      ndkMocks.publishReplaceable.mockImplementationOnce(async (event) => {
        event.id = 'own-event';
      });
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-05T00:00:00.000Z',
        eventId: 'own',
      });
      const [own] = publishedCursors();

      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', {
          id: 'own-event',
          created_at: own.created_at,
          content: own.content,
          tags: own.tags,
        }),
      );
      await settleLiveEvents();

      expect(deps.decryptContactCursorContent).not.toHaveBeenCalled();
      expect(serviceMocks.chatDataService.findLatestMessageByAuthor).not.toHaveBeenCalled();
      expect(serviceMocks.chatDataService.reactionMessageBatches).not.toHaveBeenCalled();
      expect(serviceMocks.contactsService.updateContact).not.toHaveBeenCalled();
      expect(deps.chatStore.refreshChat).not.toHaveBeenCalled();
      expect(deps.chatStore.reload).not.toHaveBeenCalled();
      expect(publishedCursors()).toHaveLength(1);
    });

    it('skips decryption and chat scans for replays and cursors it already applied', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
        public_key: contactPublicKey,
        unread_count: 1,
        meta: {},
      });
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      const event = makeCursorEvent('2026-01-03T00:00:00.000Z', { id: 'other-device' });
      subscriptions[0].onEvent(event);
      await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1));
      const scans = serviceMocks.chatDataService.findLatestMessageByAuthor.mock.calls.length;
      expect(scans).toBe(1);

      // Every relay drops, then the recovered subscription replays the same stored event.
      subscriptions[0].onClose();
      await runtime.recoverContactCursorSubscription();
      await flushPromises();
      subscriptions[1].onEvent(event);
      // The same cursor under another event id, e.g. already restored at startup.
      subscriptions[1].onEvent(
        makeCursorEvent('2026-01-03T00:00:00.000Z', { id: 'same-cursor-other-event' }),
      );
      await settleLiveEvents();

      expect(deps.decryptContactCursorContent).toHaveBeenCalledTimes(2);
      expect(serviceMocks.chatDataService.findLatestMessageByAuthor).toHaveBeenCalledTimes(scans);
      expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(1);
      expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1);
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
    });

    it('retries a cursor whose apply failed when relays replay it', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      serviceMocks.contactsService.updateContact.mockRejectedValueOnce(new Error('disk full'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      const event = makeCursorEvent('2026-01-03T00:00:00.000Z', { id: 'other-device' });

      subscriptions[0].onEvent(event);
      await settleLiveEvents();
      expect(deps.chatStore.refreshChat).not.toHaveBeenCalled();

      subscriptions[0].onClose();
      await runtime.recoverContactCursorSubscription();
      await flushPromises();
      subscriptions[1].onEvent(event);
      await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1));
      expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(2);
    });

    it('updates only the reactions it marked seen, not every loaded thread', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      const ownMessage = {
        id: 5,
        author_public_key: account,
        created_at: '2026-01-01T00:00:00.000Z',
        meta: {
          reactions: [
            {
              emoji: '👍',
              name: 'Alice',
              reactorPublicKey: contactPublicKey,
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      };
      serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
        public_key: contactPublicKey,
        unread_count: 0,
        meta: {},
      });
      serviceMocks.chatDataService.listMessages.mockResolvedValue([ownMessage]);
      const updatedRow = { ...ownMessage, meta: { reactions: [] } };
      serviceMocks.chatDataService.updateMessageMeta.mockResolvedValue(updatedRow);
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      subscriptions[0].onEvent(makeCursorEvent('2026-01-03T00:00:00.000Z'));

      await vi.waitFor(() =>
        expect(messageStoreMock.upsertPersistedMessage).toHaveBeenCalledExactlyOnceWith(updatedRow),
      );
      expect(serviceMocks.chatDataService.updateMessageMeta).toHaveBeenCalledWith(
        5,
        expect.objectContaining({
          reactions: [expect.objectContaining({ viewedByAuthorAt: '2026-01-03T00:00:00.000Z' })],
        }),
      );
      expect(messageStoreMock.reloadLoadedMessages).not.toHaveBeenCalled();
      expect(deps.chatStore.reload).not.toHaveBeenCalled();
    });

    it('hashes each contact once while resolving unknown d-tags', async () => {
      const otherContact = { ...makeContact(), id: 8, public_key: 'c'.repeat(64) };
      serviceMocks.contactsService.listContacts.mockResolvedValue([makeContact(), otherContact]);
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      // Other apps also store kind 30078 events under this account.
      for (const dTag of ['other-app-1', 'other-app-2', 'other-app-3']) {
        subscriptions[0].onEvent(
          makeCursorEvent('2026-01-03T00:00:00.000Z', { tags: [['d', dTag]] }),
        );
      }
      await settleLiveEvents();
      expect(deps.deriveContactCursorDTag).toHaveBeenCalledTimes(2);
      expect(deps.decryptContactCursorContent).not.toHaveBeenCalled();

      // A contact added later is still resolved.
      const newContact = { ...makeContact(), id: 9, public_key: 'd'.repeat(64) };
      serviceMocks.contactsService.listContacts.mockResolvedValue([
        makeContact(),
        otherContact,
        newContact,
      ]);
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(newContact);
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-03T00:00:00.000Z', { tags: [['d', `dtag-${'d'.repeat(64)}`]] }),
      );
      await vi.waitFor(() =>
        expect(deps.chatStore.refreshChat).toHaveBeenCalledExactlyOnceWith('d'.repeat(64)),
      );
      expect(deps.deriveContactCursorDTag).toHaveBeenCalledTimes(3);
    });

    it('keeps the full replay window when a subscription closes before catching up', async () => {
      const { runtime, subscriptions } = createLiveRuntime({}, { sendEose: false });
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      subscriptions[0].onClose();
      await runtime.recoverContactCursorSubscription();
      await flushPromises();

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[1].filters).toEqual(subscriptions[0].filters);
    });

    describe('resume point', () => {
      // The stored boundary the harness returns; a full replay starts here.
      const boundary = 1_700_000_000;
      const relayA = 'wss://relay.example/';
      const relayB = 'wss://added.example/';

      function sinceOf(subscription: { filters: unknown } | undefined): number {
        return (subscription?.filters as { since: number }).since;
      }

      function expectResumed(subscription: { filters: unknown } | undefined): void {
        const now = Math.floor(Date.now() / 1000);
        expect(sinceOf(subscription)).toBeGreaterThanOrEqual(
          now - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS - 5,
        );
        expect(sinceOf(subscription)).toBeLessThanOrEqual(
          now - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS,
        );
      }

      async function connect(
        deps: ReturnType<typeof createLiveRuntime>['deps'],
        runtime: ReturnType<typeof createLiveRuntime>['runtime'],
        relays: string[],
      ): Promise<void> {
        deps.resolveLoggedInReadRelayUrls.mockResolvedValue(relays);
        await runtime.subscribeContactCursorUpdates(relays);
        await flushPromises();
      }

      async function dropAllRelaysAndRecover(
        runtime: ReturnType<typeof createLiveRuntime>['runtime'],
        subscriptions: ReturnType<typeof createLiveRuntime>['subscriptions'],
      ): Promise<void> {
        subscriptions.at(-1)?.onClose();
        await runtime.recoverContactCursorSubscription();
        await flushPromises();
      }

      it('resumes a reconnect with unchanged relays from the last full sync', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA, relayB]);
        expect(sinceOf(subscriptions[0])).toBe(boundary);

        await dropAllRelaysAndRecover(runtime, subscriptions);
        expect(subscriptions).toHaveLength(2);
        expectResumed(subscriptions[1]);
      });

      it('replays the full history to a relay added after a reconnect', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA]);
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expectResumed(subscriptions[1]);

        await connect(deps, runtime, [relayA, relayB]);
        expect(subscriptions).toHaveLength(3);
        expect(sinceOf(subscriptions[2])).toBe(boundary);
      });

      it('restarts from the boundary when a relay is added while connected', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA]);
        await dropAllRelaysAndRecover(runtime, subscriptions);

        // The added relay never replayed its history here, even though relayA did.
        await connect(deps, runtime, [relayA, relayB]);
        expect(subscriptions[1].stop).toHaveBeenCalled();
        expect(sinceOf(subscriptions[2])).toBe(boundary);
      });

      it('keeps the resume point when a synced relay is removed while connected', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA, relayB]);

        await connect(deps, runtime, [relayA]);
        expect(subscriptions).toHaveLength(2);
        expectResumed(subscriptions[1]);
      });

      it('does not resume when only the connected relays finished their replay', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime({}, { sendEose: 'connected' });
        await connect(deps, runtime, [relayA, relayB]);

        // relayB was offline, so the subscription reported EOSE without its history.
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expect(sinceOf(subscriptions[1])).toBe(boundary);
      });

      it('recovers from the boundary after a relay change whose subscription failed to start', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA]);
        await dropAllRelaysAndRecover(runtime, subscriptions);

        // The change stops the synced subscription, then its replacement fails to start.
        deps.ensureRelayConnections.mockRejectedValueOnce(new Error('offline'));
        await connect(deps, runtime, [relayA, relayB]).catch(() => {});
        expect(subscriptions).toHaveLength(2);
        expect(subscriptions[1].stop).toHaveBeenCalled();

        await runtime.recoverContactCursorSubscription();
        await flushPromises();
        expect(subscriptions).toHaveLength(3);
        expect(sinceOf(subscriptions[2])).toBe(boundary);
      });

      it('resumes again only once the new relay set has fully synced', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime({}, { sendEose: false });
        await connect(deps, runtime, [relayA]);
        subscriptions[0].completeSync();
        await connect(deps, runtime, [relayA, relayB]);
        expect(sinceOf(subscriptions[1])).toBe(boundary);

        // The set closes before relayB finishes: the next try is still a full replay.
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expect(sinceOf(subscriptions[2])).toBe(boundary);

        subscriptions[2].completeSync();
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expectResumed(subscriptions[3]);

        // Back to relayA alone, then relayB again: relayB synced in this set, so both resume.
        await connect(deps, runtime, [relayA]);
        expectResumed(subscriptions[4]);
        subscriptions[4].completeSync();
        await connect(deps, runtime, [relayA, relayB]);
        expect(sinceOf(subscriptions[5])).toBe(boundary);
      });

      it('does not restart a healthy subscription when its relays are unchanged', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA]);
        // A later full sync moves the resume point; the open subscription keeps its filter.
        subscriptions[0].completeSync();
        await connect(deps, runtime, [relayA]);
        await runtime.recoverContactCursorSubscription();
        await flushPromises();

        expect(subscriptions).toHaveLength(1);
        expect(subscriptions[0].stop).not.toHaveBeenCalled();
      });

      it('replays from the boundary after a cursor fails to apply', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await connect(deps, runtime, [relayA]);
        serviceMocks.contactsService.updateContact.mockRejectedValueOnce(new Error('disk full'));
        subscriptions[0].onEvent(makeCursorEvent('2026-01-03T00:00:00.000Z', { id: 'event-1' }));
        await settleLiveEvents();

        // A relay reconnecting in place completes the set again; the event is still pending.
        subscriptions[0].completeSync();
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expect(sinceOf(subscriptions[1])).toBe(boundary);

        // The boundary replay applies cleanly, so the next reconnect resumes again.
        await dropAllRelaysAndRecover(runtime, subscriptions);
        expectResumed(subscriptions[2]);
      });

      it('does not move the read state back when a resumed replay delivers older events', async () => {
        const { deps, runtime, subscriptions } = createLiveRuntime();
        await connect(deps, runtime, [relayA]);
        subscriptions[0].onEvent(
          makeCursorEvent('2026-01-05T00:00:00.000Z', { id: 'newer', created_at: 1_800_000_100 }),
        );
        await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1));
        expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(1);

        await dropAllRelaysAndRecover(runtime, subscriptions);
        subscriptions[1].onEvent(
          makeCursorEvent('2026-01-04T00:00:00.000Z', { id: 'older', created_at: 1_800_000_050 }),
        );
        await settleLiveEvents();

        expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledTimes(1);
        expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1);
        expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
        await runtime.publishContactCursor(contactPublicKey, {
          at: '2026-01-04T00:00:00.000Z',
          eventId: 'stale',
        });
        expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
      });
    });

    it('never publishes a cursor at or behind the newest known cursor', async () => {
      const { runtime } = createLiveRuntime();
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
        makeContact({
          last_seen_incoming_activity_at: '2026-01-03T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'known',
        }),
      );

      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-02T00:00:00.000Z',
        eventId: 'older',
      });
      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-03T00:00:00.000Z',
        eventId: 'known',
      });
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();

      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'newer',
      });
      expect(publishedCursors().map((event) => event.content)).toEqual([
        'cursor:2026-01-04T00:00:00.000Z',
      ]);
    });

    it('stops an older device from publishing after a newer cursor arrives live', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      subscriptions[0].onEvent(makeCursorEvent('2026-01-05T00:00:00.000Z'));
      await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalled());

      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'stale-device',
      });
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
    });

    it('serializes publishes so cursor order and created_at order agree', async () => {
      const { runtime } = createLiveRuntime();
      const older = { at: '2026-01-02T00:00:00.000Z', eventId: 'older' };
      const newer = { at: '2026-01-03T00:00:00.000Z', eventId: 'newer' };

      await Promise.all([
        runtime.publishContactCursor(contactPublicKey, newer),
        runtime.publishContactCursor(contactPublicKey, older),
      ]);
      expect(publishedCursors().map((event) => event.content)).toEqual([
        'cursor:2026-01-03T00:00:00.000Z',
      ]);

      const third = { at: '2026-01-04T00:00:00.000Z', eventId: 'third' };
      const fourth = { at: '2026-01-05T00:00:00.000Z', eventId: 'fourth' };
      await Promise.all([
        runtime.publishContactCursor(contactPublicKey, third),
        runtime.publishContactCursor(contactPublicKey, fourth),
      ]);
      const events = publishedCursors();
      expect(events.map((event) => event.content)).toEqual([
        'cursor:2026-01-03T00:00:00.000Z',
        'cursor:2026-01-04T00:00:00.000Z',
        'cursor:2026-01-05T00:00:00.000Z',
      ]);
      expect(events[2].created_at).toBeGreaterThan(events[1].created_at);
    });

    it('republishes its newer cursor when another device buries it on relays', async () => {
      const { runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      await runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-05T00:00:00.000Z',
        eventId: 'own',
      });
      const [ownEvent] = publishedCursors();

      // The echo of this device's own event changes nothing.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', {
          created_at: ownEvent.created_at,
          content: JSON.stringify({
            version: '0.1',
            last_seen_incoming_activity_at: '2026-01-05T00:00:00.000Z',
            last_seen_incoming_activity_event_id: 'own',
          }),
        }),
      );
      // A delayed event older than this device's publish is history, not a conflict.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-01T00:00:00.000Z', { created_at: ownEvent.created_at - 30 }),
      );
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(publishedCursors()).toHaveLength(1);

      // A skewed clock elsewhere stamps an older cursor later than ours.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-04T00:00:00.000Z', { created_at: ownEvent.created_at + 120 }),
      );
      await vi.waitFor(() => expect(publishedCursors()).toHaveLength(2));
      const republished = publishedCursors()[1];
      expect(republished.content).toBe('cursor:2026-01-05T00:00:00.000Z');
      expect(republished.created_at).toBeGreaterThan(ownEvent.created_at + 120);
    });

    it('drops subscriptions, pending applies and in-flight publishes on account reset', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      expect(subscriptions).toHaveLength(1);

      let releaseRelays!: () => void;
      deps.ensureRelayConnections.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseRelays = resolve;
          }),
      );
      const publishing = runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'previous-account',
      });
      await vi.waitFor(() => expect(deps.ensureRelayConnections).toHaveBeenCalledTimes(2));

      runtime.resetContactCursorSyncState();
      deps.getLoggedInPublicKeyHex.mockReturnValue('e'.repeat(64));
      releaseRelays();
      await publishing;
      subscriptions[0].onEvent(makeCursorEvent('2026-01-05T00:00:00.000Z'));
      await flushPromises();

      expect(subscriptions[0].stop).toHaveBeenCalled();
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
      expect(deps.decryptContactCursorContent).not.toHaveBeenCalled();
    });

    it('recovers the subscription after every relay disconnects, across repeated cycles', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates(['wss://seed.example']);
      await flushPromises();
      expect(subscriptions).toHaveLength(1);

      // A healthy subscription is left alone, so healing passes stay quiet.
      await runtime.recoverContactCursorSubscription();
      expect(subscriptions).toHaveLength(1);

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        subscriptions.at(-1)?.onClose();
        // Several relays reconnecting together, plus a healing pass, recover once.
        await Promise.all([
          runtime.recoverContactCursorSubscription(),
          runtime.recoverContactCursorSubscription(),
          runtime.recoverContactCursorSubscription(),
        ]);
        await flushPromises();
        expect(subscriptions).toHaveLength(1 + cycle);
        // A caught-up subscription resumes from its close, minus the clock-skew lookback,
        // instead of replaying everything since startup again.
        const resumedSince = (subscriptions.at(-1)?.filters as { since: number }).since;
        expect(resumedSince).toBeGreaterThanOrEqual(
          Math.floor(Date.now() / 1000) - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS - 1,
        );
        expect(resumedSince).toBeLessThanOrEqual(
          Math.floor(Date.now() / 1000) - CONTACT_CURSOR_LIVE_LOOKBACK_SECONDS,
        );
      }
      expect(deps.resolveLoggedInReadRelayUrls).toHaveBeenLastCalledWith(['wss://seed.example']);

      subscriptions.at(-1)?.onEvent(makeCursorEvent('2026-01-06T00:00:00.000Z'));
      await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalledTimes(1));
      expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
        metaBase: {},
        meta: {
          last_seen_incoming_activity_at: '2026-01-06T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'event-2026-01-06T00:00:00.000Z',
        },
      });
    });

    it('does not recover the previous account subscription after logout or a switch', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      // Logout while a recovery is resolving relays.
      subscriptions[0].onClose();
      let releaseRelays!: (urls: string[]) => void;
      deps.resolveLoggedInReadRelayUrls.mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            releaseRelays = resolve;
          }),
      );
      const recovering = runtime.recoverContactCursorSubscription();
      await vi.waitFor(() => expect(releaseRelays).toBeTypeOf('function'));
      runtime.resetContactCursorSyncState();
      deps.getLoggedInPublicKeyHex.mockReturnValue('e'.repeat(64));
      releaseRelays(['wss://relay.example/']);
      await recovering;

      // The next account's relay reconnects do not revive the old subscription either.
      await runtime.recoverContactCursorSubscription();
      await flushPromises();
      expect(subscriptions).toHaveLength(1);
    });

    it('waits for the live replay before publishing, so a stale device cannot overwrite', async () => {
      const { runtime, subscriptions } = createLiveRuntime({}, { sendEose: false });
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      const publishing = runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'stale-device',
      });
      await flushPromises();
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();

      // The replay carries a newer cursor from another device, then the relay sends EOSE.
      subscriptions[0].onEvent(makeCursorEvent('2026-01-05T00:00:00.000Z'));
      subscriptions[0].onEose();
      await publishing;

      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
    });

    it('publishes after a bounded wait when relays never send EOSE', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { runtime } = createLiveRuntime({}, { sendEose: false });
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      const publishing = runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'own',
      });
      await vi.advanceTimersByTimeAsync(CONTACT_CURSOR_SYNC_TIMEOUT_MS - 1);
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await publishing;
      expect(publishedCursors().map((event) => event.content)).toEqual([
        'cursor:2026-01-04T00:00:00.000Z',
      ]);
    });

    it('heals relays serving an older cursor than one restored on this device', async () => {
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
        makeContact({
          last_seen_incoming_activity_at: '2026-01-05T00:00:00.000Z',
          last_seen_incoming_activity_event_id: 'restored',
        }),
      );
      const { runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      // A delayed event is history: relays already serve something newer than it.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', {
          created_at: 1_800_000_100,
          content: cursorContent('2026-01-05T00:00:00.000Z', 'restored'),
        }),
      );
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-03T00:00:00.000Z', { created_at: 1_800_000_050 }),
      );
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();

      // A stale device then replaces it on relays with an older cursor.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-04T00:00:00.000Z', { created_at: 1_800_000_200 }),
      );
      await vi.waitFor(() => expect(publishedCursors()).toHaveLength(1));
      expect(publishedCursors()[0].content).toBe('cursor:2026-01-05T00:00:00.000Z');
      expect(publishedCursors()[0].created_at).toBeGreaterThan(1_800_000_200);
    });

    it('treats equal timestamps as possibly buried and heals once', async () => {
      const { runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();

      // Relays keep the lower id on a created_at tie, which may be the older cursor.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', { created_at: 1_800_000_000 }),
      );
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-04T00:00:00.000Z', { created_at: 1_800_000_000 }),
      );
      await vi.waitFor(() => expect(publishedCursors()).toHaveLength(1));
      const [healed] = publishedCursors();
      expect(healed.content).toBe('cursor:2026-01-05T00:00:00.000Z');

      // The echo of the heal is now newest and matches, so nothing else is sent.
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', { created_at: healed.created_at }),
      );
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(publishedCursors()).toHaveLength(1);
    });

    it('skips a queued heal once another device has already healed the relays', async () => {
      const { deps, runtime, subscriptions } = createLiveRuntime();
      await runtime.subscribeContactCursorUpdates();
      await flushPromises();
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', { created_at: 1_800_000_000 }),
      );
      await vi.waitFor(() => expect(deps.chatStore.refreshChat).toHaveBeenCalled());

      // Hold queued publishes behind a startup restore that is still running.
      let finishRestore!: () => void;
      deps.restoreState.restoreContactCursorStatePromise = new Promise<void>((resolve) => {
        finishRestore = resolve;
      }) as never;
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-04T00:00:00.000Z', { created_at: 1_800_000_100 }),
      );
      subscriptions[0].onEvent(
        makeCursorEvent('2026-01-05T00:00:00.000Z', { created_at: 1_800_000_101 }),
      );
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      finishRestore();
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();
    });

    it('converges two devices on the newest cursor without a republish loop', async () => {
      // An in-memory relay with replaceable semantics that echoes to every device.
      let stored: { content: string; created_at: number; id: string } | null = null;
      const devices: Array<{
        online: boolean;
        inbox: ClientEvent[];
        deliver: (event: ClientEvent) => void;
      }> = [];
      let sequence = 0;
      ndkMocks.publishReplaceable.mockImplementation(async (event) => {
        // Later publishes get lower ids, so a same-second tie favours the later event.
        event.id = String(1000 - (sequence += 1));
        if (
          !stored ||
          event.created_at > stored.created_at ||
          (event.created_at === stored.created_at && event.id < stored.id)
        ) {
          stored = event;
        }
        for (const device of devices) device.inbox.push(event);
      });
      const shared = {
        deriveContactCursorDTag: vi.fn(async (publicKey: string) => `sha256:secret${publicKey}`),
        encryptContactCursorContent: vi.fn(async (cursor) =>
          cursorContent(cursor.at, cursor.eventId),
        ),
      };
      async function connectDevice() {
        const device = createLiveRuntime(shared);
        await device.runtime.subscribeContactCursorUpdates();
        await flushPromises();
        const entry = {
          online: true,
          inbox: [] as ClientEvent[],
          deliver: (event: ClientEvent) => device.subscriptions.at(-1)?.onEvent(event),
        };
        devices.push(entry);
        return { ...device, entry };
      }
      async function settle(): Promise<void> {
        for (let round = 0; round < 20; round += 1) {
          for (const device of devices) {
            if (!device.online) continue;
            for (const event of device.inbox.splice(0)) device.deliver(event);
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          await flushPromises();
        }
      }

      const laptop = await connectDevice();
      const phone = await connectDevice();
      // The phone is offline, so it has not seen the laptop read further.
      phone.entry.online = false;
      await laptop.runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-05T00:00:00.000Z',
        eventId: 'laptop',
      });
      await phone.runtime.publishContactCursor(contactPublicKey, {
        at: '2026-01-04T00:00:00.000Z',
        eventId: 'phone',
      });
      expect(JSON.parse(stored!.content).last_seen_incoming_activity_at).toBe(
        '2026-01-04T00:00:00.000Z',
      );

      phone.entry.online = true;
      await settle();
      expect(JSON.parse(stored!.content).last_seen_incoming_activity_at).toBe(
        '2026-01-05T00:00:00.000Z',
      );
      const publishCount = ndkMocks.publishReplaceable.mock.calls.length;
      expect(publishCount).toBeLessThanOrEqual(4);

      // Relays replaying their stored event after a reconnect start nothing new.
      for (const device of devices) device.inbox.push(stored as unknown as ClientEvent);
      await settle();
      expect(ndkMocks.publishReplaceable.mock.calls.length).toBe(publishCount);
    });
  });

  describe('automatic read publishing', () => {
    const contactPublicKey = 'a'.repeat(64);

    function createScheduledRuntime() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deps = createDeps({
        encryptContactCursorContent: vi.fn(async (cursor) => `cursor:${cursor.at}`),
      });
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(null);
      return { deps, runtime: createPrivateStateRuntime(deps) };
    }

    function cursorAt(second: number) {
      return {
        at: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
        eventId: `message-${second}`,
      };
    }

    it('coalesces rapid messages in a focused chat into one jittered publish', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const { deps, runtime } = createScheduledRuntime();
      const jitterMs = Math.floor(0.5 * CONTACT_CURSOR_PUBLISH_JITTER_MS);

      for (let second = 1; second <= 20; second += 1) {
        runtime.scheduleContactCursorPublish(contactPublicKey, cursorAt(second), {
          deferred: true,
        });
      }
      expect(deps.pendingContactCursorPublishTimers.size).toBe(1);

      await vi.advanceTimersByTimeAsync(CONTACT_CURSOR_PUBLISH_DELAY_MS + jitterMs - 1);
      expect(ndkMocks.publishReplaceable).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1));
      expect(publishedContents()).toEqual(['cursor:2026-01-01T00:00:20.000Z']);
      expect(deps.pendingContactCursorPublishTimers.size).toBe(0);
    });

    it('keeps the jitter within its bound', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);
      const { runtime } = createScheduledRuntime();

      runtime.scheduleContactCursorPublish(contactPublicKey, cursorAt(1), { deferred: true });
      await vi.advanceTimersByTimeAsync(
        CONTACT_CURSOR_PUBLISH_DELAY_MS + CONTACT_CURSOR_PUBLISH_JITTER_MS,
      );

      await vi.waitFor(() => expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1));
    });

    it('lets a manual read publish at once while an automatic read waits', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { deps, runtime } = createScheduledRuntime();

      runtime.scheduleContactCursorPublish(contactPublicKey, cursorAt(2), { deferred: true });
      runtime.scheduleContactCursorPublish(contactPublicKey, cursorAt(1));
      await vi.waitFor(() => expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1));
      // The manual read carries the newer automatic cursor rather than going backwards.
      expect(publishedContents()).toEqual(['cursor:2026-01-01T00:00:02.000Z']);
      expect(deps.pendingContactCursorPublishTimers.size).toBe(1);

      // Further automatic reads join the manual read's coalescing window.
      runtime.scheduleContactCursorPublish(contactPublicKey, cursorAt(3), { deferred: true });
      await vi.advanceTimersByTimeAsync(CONTACT_CURSOR_PUBLISH_DELAY_MS);
      await vi.waitFor(() => expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(2));
      expect(publishedContents()).toEqual([
        'cursor:2026-01-01T00:00:02.000Z',
        'cursor:2026-01-01T00:00:03.000Z',
      ]);
    });

    function publishedContents(): string[] {
      return ndkMocks.publishReplaceable.mock.calls.map(([event]) => event.content);
    }
  });
});
