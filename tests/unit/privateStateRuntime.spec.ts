import { type NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { createPrivateStateRuntime } from 'src/stores/nostr/privateStateRuntime';
import type { MessageRelayStatus } from 'src/types/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const ndkMocks = vi.hoisted(() => {
  const groupPubkey = 'a'.repeat(64);
  const publishReplaceable = vi.fn().mockResolvedValue(undefined);
  const relaySetFromRelayUrls = vi.fn((relayUrls: string[]) => ({
    relayUrls,
  }));
  const signerEncrypt = vi.fn(
    async (_user: unknown, content: string, _algorithm?: string) => `encrypted:${content}`
  );
  const signerDecrypt = vi.fn(async (_user: unknown, content: string, _algorithm?: string) =>
    content.startsWith('encrypted:') ? content.slice('encrypted:'.length) : content
  );

  const signEvent = vi.fn().mockResolvedValue(undefined);

  class MockNDKEvent {
    id?: string;
    kind?: number;
    created_at?: number;
    pubkey?: string;
    content = '';
    tags: string[][] = [];

    constructor(_ndk: unknown, event: Partial<NDKEvent>) {
      Object.assign(this, event);
    }

    getMatchingTags(tagName: string): string[][] {
      return this.tags.filter((tag) => tag[0] === tagName);
    }

    async sign(_signer: unknown): Promise<void> {
      await signEvent(this, _signer);
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
  syncChatsReadStateFromSeenBoundary: vi.fn(async () => ({
    chatCount: 0,
    boundaryAdvancedCount: 0,
    unreadCountAdjustedCount: 0,
    reactionMessageCount: 0,
    reactionsMarkedCount: 0,
  })),
}));

vi.mock('@nostr-dev-kit/ndk', async () => {
  const actual = await vi.importActual<typeof import('@nostr-dev-kit/ndk')>('@nostr-dev-kit/ndk');

  return {
    ...actual,
    NDKEvent: ndkMocks.MockNDKEvent,
    NDKPrivateKeySigner: ndkMocks.MockNDKPrivateKeySigner,
    NDKRelaySet: ndkMocks.MockNDKRelaySet,
  };
});

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

vi.mock('src/stores/messageStore', () => ({
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
      (first, second) => JSON.stringify(first) === JSON.stringify(second)
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
    isRestoringStartupState: ref(false),
    ndk,
    normalizeEventId: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
    ),
    normalizeTimestamp: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null
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
      value ? Date.parse(value) || 0 : 0
    ),
    toIsoTimestampFromUnix: vi.fn((value: number | undefined) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : ''
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
        }
      )
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
        }
      )
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

    await flushPromises();

    expect(ndkMocks.publishReplaceable).toHaveBeenCalledTimes(1);
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
      false
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
      name: 'Launch Group',
      about: 'Roadmap',
      relayUrls: ['wss://relay.example'],
    });

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
      ([event]) => event.kind === 30000
    );
    const ownerListPublishCall = groupListPublishCalls.find(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'members'
    );
    const sharedRosterPublishCall = groupListPublishCalls.find(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'roster'
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
      `encrypted:${JSON.stringify([['p', 'f'.repeat(64)]])}`
    );
    expect(deps.persistIncomingGroupEpochTicket).toHaveBeenCalledWith(
      ndkMocks.groupPubkey,
      0,
      'epoch-private-key',
      expect.objectContaining({
        accepted: true,
        fallbackName: 'Launch Group',
      })
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
      ['wss://relay.example']
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
      ['wss://relay.example']
    );
    await runtime.publishGroupMembershipRosterFollowSet(
      ndkMocks.groupPubkey,
      ['d'.repeat(64)],
      ['wss://relay.example']
    );
    await runtime.publishGroupMembershipFollowSet(
      ndkMocks.groupPubkey,
      ['c'.repeat(64)],
      ['wss://relay.example']
    );
    await runtime.publishGroupMembershipFollowSet(
      ndkMocks.groupPubkey,
      ['d'.repeat(64)],
      ['wss://relay.example']
    );

    const publishEventMock = deps.publishEventWithRelayStatuses as ReturnType<typeof vi.fn>;
    const rosterCalls = publishEventMock.mock.calls.filter(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'roster'
    );
    const memberCalls = publishEventMock.mock.calls.filter(
      ([event]) => event.getMatchingTags('d')[0]?.[1] === 'members'
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
      }
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
      })
    );
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
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
      }
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
      kind: NDKKind.FollowSet,
      id: 'ROSTER-EVENT',
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    } as unknown as NDKEvent;

    await expect(
      runtime.applyGroupMembershipRosterEvent(rosterEvent, {
        seedRelayUrls: ['wss://seed.example'],
      })
    ).resolves.toBe(false);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Skipping group roster event until group context is ready or readable',
      expect.objectContaining({
        eventId: 'roster-event',
        groupPublicKey: ndkMocks.groupPubkey,
        error: expect.objectContaining({
          message: 'Group contact not found.',
        }),
      })
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
      kind: NDKKind.FollowSet,
      id: 'roster-persist-race',
      pubkey: ndkMocks.groupPubkey,
      content: 'encrypted-roster',
      tags: [['d', 'roster']],
      getMatchingTags: (tagName: string) => (tagName === 'd' ? [['d', 'roster']] : []),
    } as unknown as NDKEvent;

    serviceMocks.contactsService.getContactByPublicKey.mockImplementation(
      async (pubkey: string) => {
        if (pubkey === ndkMocks.groupPubkey) {
          return groupContact;
        }

        return null;
      }
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
      })
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
      })
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
      pubkey === ndkMocks.groupPubkey ? groupContact : null
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
      pubkey === ndkMocks.groupPubkey ? groupContact : null
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
      })
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
        }
      )
    ).resolves.toBe(true);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
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
      })
    );
    expect(serviceMocks.chatDataService.updateChatMeta).toHaveBeenCalledWith(contactPublicKey, {
      last_seen_received_activity_at: cursorAt,
      unseen_reaction_count: 1,
    });
    expect(serviceMocks.chatDataService.updateChatUnreadCount).toHaveBeenCalledWith(
      contactPublicKey,
      1
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
        }
      )
    ).resolves.toBe(true);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
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
      0
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
});
