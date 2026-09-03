import { type NDKEvent, NDKKind, nip19 } from '@nostr-dev-kit/ndk';
import { createPrivateMessagesIngestRuntime } from 'src/stores/nostr/privateMessagesIngestRuntime';
import type { MessageRelayStatus } from 'src/types/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ndkMocks = vi.hoisted(() => ({
  giftUnwrap: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    applyMessageEdit: vi.fn(),
    createChat: vi.fn(),
    createMessage: vi.fn(),
    getChatByPublicKey: vi.fn(),
    getMessageById: vi.fn(),
    getMessageByEventId: vi.fn(),
    getMessageByEventIdOrEditReference: vi.fn(),
    init: vi.fn(),
    listMessages: vi.fn(),
    updateChatPreview: vi.fn(),
    updateChatUnreadCount: vi.fn(),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn(),
  },
  nostrEventDataService: {
    init: vi.fn(),
    upsertEvent: vi.fn(),
  },
}));

vi.mock('@nostr-dev-kit/ndk', async () => {
  const actual = await vi.importActual<typeof import('@nostr-dev-kit/ndk')>('@nostr-dev-kit/ndk');

  return {
    ...actual,
    giftUnwrap: ndkMocks.giftUnwrap,
  };
});

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

vi.mock('src/services/nostrEventDataService', () => ({
  nostrEventDataService: serviceMocks.nostrEventDataService,
}));

function makeRelayStatus(overrides: Partial<MessageRelayStatus> = {}): MessageRelayStatus {
  return {
    relay_url: 'wss://relay.example',
    direction: 'inbound',
    scope: 'subscription',
    status: 'received',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWrappedEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
  return {
    id: 'wrapped-event',
    kind: NDKKind.GiftWrap,
    created_at: 1700000000,
    pubkey: 'relay-author',
    content: '',
    tags: [],
    getMatchingTags: vi.fn(() => []),
    ...overrides,
  } as unknown as NDKEvent;
}

function makeRumorEvent(options: {
  senderPubkey?: string;
  recipientPubkey: string;
  eventId?: string;
  kind?: number;
  content?: string;
  createdAt?: number;
  tags?: string[][];
}): NDKEvent {
  const tags = options.tags ?? [['p', options.recipientPubkey]];
  return {
    id: options.eventId ?? 'rumor-event',
    kind: options.kind ?? NDKKind.PrivateDirectMessage,
    created_at: options.createdAt ?? 1700000000,
    pubkey: options.senderPubkey ?? 'a'.repeat(64),
    content: options.content ?? 'Hello there',
    tags,
    getMatchingTags: vi.fn((tagName: string) => tags.filter((tag) => tag[0] === tagName)),
  } as unknown as NDKEvent;
}

function createDeps() {
  const chatStore = {
    visibleChatId: null as string | null,
    acceptChat: vi.fn().mockResolvedValue(undefined),
    applyIncomingMessage: vi.fn(),
    recordIncomingActivity: vi.fn().mockResolvedValue(undefined),
    setUnreadCount: vi.fn().mockResolvedValue(undefined),
  };

  return {
    appendRelayStatusesToMessageEvent: vi.fn().mockResolvedValue(undefined),
    applyPendingIncomingDeletionsForMessage: vi.fn(async (messageRow) => messageRow),
    applyPendingIncomingReactionsForMessage: vi.fn(async (messageRow) => messageRow),
    buildInboundRelayStatuses: vi.fn(() => [makeRelayStatus()]),
    buildInboundTraceDetails: vi.fn(() => ({})),
    buildLoggedNostrEvent: vi.fn(() => ({ logged: true })),
    buildReplyPreviewFromTargetEvent: vi.fn().mockResolvedValue(null),
    buildSubscriptionEventDetails: vi.fn(() => ({})),
    chatStore,
    deriveChatName: vi.fn((contact, publicKey) => contact?.name ?? `Chat ${publicKey.slice(0, 8)}`),
    derivePublicKeyFromPrivateKey: vi.fn(() => 'epoch-public-key'),
    extractRelayUrlsFromEvent: vi.fn(() => ['wss://relay.example']),
    findConflictingKnownGroupEpochNumber: vi.fn(() => null),
    findGroupChatEpochContextByRecipientPubkey: vi.fn().mockResolvedValue(null),
    findHigherKnownGroupEpochConflict: vi.fn(() => null),
    formatSubscriptionLogValue: vi.fn((value) => value ?? null),
    getPrivateMessagesRestoreThrottleMs: vi.fn(() => 25),
    isContactListedInPrivateContactList: vi.fn(
      (contact) => contact?.meta?.private_contact_list_member === true
    ),
    isPubkeyBlocked: vi.fn((_pubkeyHex: string) => false),
    lastSeenReceivedActivityAtMetaKey: 'last_seen_received_activity_at',
    logConflictingIncomingEpochNumber: vi.fn(),
    logDeveloperTrace: vi.fn(),
    logInboundEvent: vi.fn(),
    logInvalidIncomingEpochNumber: vi.fn(),
    logSubscription: vi.fn(),
    normalizeEventId: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
    ),
    normalizeThrottleMs: vi.fn((value: number | undefined) => value ?? 0),
    normalizeTimestamp: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null
    ),
    persistIncomingGroupEpochTicket: vi.fn().mockResolvedValue(undefined),
    processIncomingDeletionRumorEvent: vi.fn().mockResolvedValue(undefined),
    processIncomingReactionRumorEvent: vi.fn().mockResolvedValue(undefined),
    queueBackgroundGroupContactRefresh: vi.fn(),
    queuePrivateMessagesUiRefresh: vi.fn(),
    readReplyTargetEventId: vi.fn(() => null),
    refreshReplyPreviewsForTargetMessage: vi.fn().mockResolvedValue(0),
    resolveCurrentGroupChatEpochEntry: vi.fn(() => null),
    resolveGroupDisplayName: vi.fn(
      (groupPublicKey: string) => `Group ${groupPublicKey.slice(0, 8)}`
    ),
    resolveIncomingChatInboxStateValue: vi.fn(
      ({ isAcceptedContact }): 'accepted' | 'blocked' | 'request' =>
        isAcceptedContact ? 'accepted' : 'request'
    ),
    resolveIncomingPrivateMessageRecipientContext: vi.fn().mockResolvedValue({
      recipientPubkey: 'b'.repeat(64),
      unwrapSigner: {} as never,
      groupChatPublicKey: null,
    }),
    shouldNotifyForAcceptedChatOnly: vi.fn().mockResolvedValue(false),
    showIncomingMessageBrowserNotification: vi.fn(),
    toComparableTimestamp: vi.fn((value: string | null | undefined) =>
      value ? Date.parse(value) || 0 : 0
    ),
    toIsoTimestampFromUnix: vi.fn((value: number | undefined) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : ''
    ),
    toStoredNostrEvent: vi.fn(async (event: NDKEvent) => ({
      id: event.id,
      kind: event.kind,
      created_at: event.created_at,
      pubkey: event.pubkey,
      content: event.content,
      tags: event.tags,
      sig: '',
    })),
    unwrapGiftWrapSealEvent: vi.fn().mockResolvedValue(null),
    upsertIncomingGroupInviteRequestChat: vi.fn().mockResolvedValue(undefined),
    verifyIncomingGroupEpochTicket: vi.fn().mockResolvedValue({
      epochNumber: null,
      epochPrivateKey: null,
      isValid: false,
      signedEvent: null,
    }),
  };
}

describe('privateMessagesIngestRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageById.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockImplementation((eventId) =>
      serviceMocks.chatDataService.getMessageByEventId(eventId)
    );
    serviceMocks.chatDataService.listMessages.mockResolvedValue([]);
    serviceMocks.chatDataService.applyMessageEdit.mockResolvedValue(null);
    serviceMocks.chatDataService.updateChatPreview.mockResolvedValue(undefined);
    serviceMocks.chatDataService.updateChatUnreadCount.mockResolvedValue(undefined);
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(null);
    serviceMocks.nostrEventDataService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.upsertEvent.mockResolvedValue(undefined);
    ndkMocks.giftUnwrap.mockReset();
  });

  it('requests a retry when the gift-wrap recipient context is not ready', async () => {
    const deps = createDeps();
    deps.resolveIncomingPrivateMessageRecipientContext.mockResolvedValue(null);
    const runtime = createPrivateMessagesIngestRuntime(deps);

    await expect(
      runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64))
    ).resolves.toBe(false);
  });

  it('requests a retry when gift-wrap decryption fails', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    ndkMocks.giftUnwrap.mockRejectedValue(new Error('Signer is not ready'));

    await expect(
      runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64))
    ).resolves.toBe(false);
  });

  it('creates request chats for first-contact direct messages and queues UI refreshes', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      content: '  Hello there  ',
    });

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.createChat.mockResolvedValue({
      id: 'a'.repeat(64),
      public_key: 'a'.repeat(64),
      type: 'user',
      name: 'Chat aaaaaaaa',
      last_message: '',
      last_message_at: createdAt,
      unread_count: 0,
      meta: {},
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 41,
      chat_public_key: 'a'.repeat(64),
      author_public_key: 'a'.repeat(64),
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        public_key: 'a'.repeat(64),
        name: 'Chat aaaaaaaa',
        meta: {},
      })
    );
    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_public_key: 'a'.repeat(64),
        message: 'Hello there',
        event_id: 'rumor-event',
      })
    );
    expect(deps.chatStore.recordIncomingActivity).toHaveBeenCalledWith('a'.repeat(64), createdAt);
    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      'a'.repeat(64),
      'Hello there',
      createdAt,
      1
    );
    expect(deps.queuePrivateMessagesUiRefresh).toHaveBeenCalledWith({
      throttleMs: 25,
      reloadChats: true,
      reloadMessages: true,
    });
  });

  it('drops inbound events from blocked pubkeys before persistence', async () => {
    const deps = createDeps();
    deps.isPubkeyBlocked.mockImplementation((pubkeyHex: string) => pubkeyHex === 'a'.repeat(64));
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      content: 'Blocked message',
    });

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.logInboundEvent).toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: 'blocked-pubkey',
      })
    );
    expect(deps.toStoredNostrEvent).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.init).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.nostrEventDataService.upsertEvent).not.toHaveBeenCalled();
  });

  it('updates the preview when an incoming message shares the current preview second', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const existingPreviewAt = '2023-11-14T22:13:20.842Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: chatPublicKey,
      content: '  Same-second inbound  ',
    });

    deps.resolveIncomingChatInboxStateValue.mockReturnValue('accepted');
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Local reply',
      last_message_at: existingPreviewAt,
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:13:19.000Z',
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 43,
      chat_public_key: chatPublicKey,
      author_public_key: chatPublicKey,
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      chatPublicKey,
      'Same-second inbound',
      existingPreviewAt,
      1
    );
    expect(serviceMocks.chatDataService.updateChatUnreadCount).not.toHaveBeenCalled();
    expect(deps.queuePrivateMessagesUiRefresh).toHaveBeenCalledWith({
      throttleMs: 25,
      reloadChats: true,
      reloadMessages: true,
    });
  });

  it('uses the local chat name for incoming foreground notification presentation', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: chatPublicKey,
      content: '  Named hello  ',
    });

    deps.resolveIncomingChatInboxStateValue.mockReturnValue('accepted');
    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice Local',
      last_message: 'Older preview',
      last_message_at: '2023-11-14T22:00:00.000Z',
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 44,
      chat_public_key: chatPublicKey,
      author_public_key: chatPublicKey,
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.showIncomingMessageBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        chatPubkey: chatPublicKey,
        title: 'Alice Local',
        messageText: 'Named hello',
      })
    );
  });

  it('uses Picture for incoming NIP-92 image-only previews and notifications', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const loggedInPubkey = 'b'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const imageUrl = 'https://nostr.build/i/hello.png';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: loggedInPubkey,
      senderPubkey: chatPublicKey,
      content: `  ${imageUrl}  `,
      tags: [
        ['p', loggedInPubkey],
        ['imeta', `url ${imageUrl}`, 'm image/png', 'size 1234', 'x ABCDEF'],
      ],
    });

    deps.resolveIncomingChatInboxStateValue.mockReturnValue('accepted');
    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Older preview',
      last_message_at: '2023-11-14T22:00:00.000Z',
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 46,
      chat_public_key: chatPublicKey,
      author_public_key: chatPublicKey,
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), loggedInPubkey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: imageUrl,
        meta: expect.objectContaining({
          attachments: [
            {
              type: 'media',
              url: imageUrl,
              mimeType: 'image/png',
              size: 1234,
              sha256: 'abcdef',
            },
          ],
        }),
      })
    );
    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      chatPublicKey,
      'Picture',
      createdAt,
      1
    );
    expect(deps.showIncomingMessageBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        chatPubkey: chatPublicKey,
        messageText: 'Picture',
      })
    );
  });

  it('uses the generic group fallback when only the generated group name is available', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const groupPublicKey = 'c'.repeat(64);
    const epochPublicKey = 'd'.repeat(64);
    const senderPublicKey = 'a'.repeat(64);
    const mentionedMemberPublicKey = 'e'.repeat(64);
    const mentionedMemberNprofile = nip19.nprofileEncode({
      pubkey: mentionedMemberPublicKey,
      relays: ['wss://group.example'],
    });
    const rawMentionMessage = `nostr:${mentionedMemberNprofile} Group hello`;
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: epochPublicKey,
      senderPubkey: senderPublicKey,
      content: `  ${rawMentionMessage}  `,
    });
    const groupChat = {
      id: groupPublicKey,
      public_key: groupPublicKey,
      type: 'group' as const,
      name: 'Group cccccccc',
      last_message: 'Older preview',
      last_message_at: '2023-11-14T22:00:00.000Z',
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
      },
    };

    deps.resolveIncomingPrivateMessageRecipientContext.mockResolvedValue({
      recipientPubkey: epochPublicKey,
      unwrapSigner: {} as never,
      groupChatPublicKey: groupPublicKey,
    });
    deps.findGroupChatEpochContextByRecipientPubkey.mockResolvedValue({
      chat: groupChat,
      epochEntry: {
        epoch_number: 0,
        epoch_public_key: epochPublicKey,
      },
    });
    deps.resolveIncomingChatInboxStateValue.mockReturnValue('accepted');
    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 9,
      public_key: groupPublicKey,
      type: 'group',
      name: 'Group cccccccc',
      given_name: null,
      meta: {
        group_members: [
          {
            public_key: mentionedMemberPublicKey,
            name: 'Bob Member',
            given_name: 'Bobby',
            nprofile: mentionedMemberNprofile,
          },
        ],
      },
      relays: [],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 45,
      chat_public_key: groupPublicKey,
      author_public_key: senderPublicKey,
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: rawMentionMessage,
      })
    );
    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      groupPublicKey,
      '@Bobby Group hello',
      createdAt,
      1
    );
    expect(deps.showIncomingMessageBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        chatPubkey: groupPublicKey,
        title: 'Group',
        messageText: '@Bobby Group hello',
      })
    );
  });

  it('persists restored messages before the contact cursor without unread or notification state', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const loggedInPubkey = 'b'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const seenAt = '2023-11-14T22:20:00.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: loggedInPubkey,
      senderPubkey: chatPublicKey,
      eventId: 'restored-old-event',
      content: '  Restored old hello  ',
    });

    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 9,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      given_name: null,
      meta: {
        private_contact_list_member: true,
        last_seen_incoming_activity_at: seenAt,
        last_seen_incoming_activity_event_id: 'seen-event',
      },
      relays: [],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Latest message',
      last_message_at: '2023-11-14T22:30:00.000Z',
      unread_count: 3,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
        last_seen_received_activity_at: '2023-11-14T22:00:00.000Z',
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 46,
      chat_public_key: chatPublicKey,
      author_public_key: chatPublicKey,
      created_at: createdAt,
      event_id: 'restored-old-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), loggedInPubkey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatPreview).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatUnreadCount).not.toHaveBeenCalled();
    expect(deps.shouldNotifyForAcceptedChatOnly).not.toHaveBeenCalled();
    expect(deps.showIncomingMessageBrowserNotification).not.toHaveBeenCalled();
    expect(deps.queuePrivateMessagesUiRefresh).toHaveBeenCalledWith({
      throttleMs: 25,
      reloadChats: true,
      reloadMessages: true,
    });
  });

  it('persists restored messages before the latest own message without unread or notification state', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const loggedInPubkey = 'b'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const ownMessageAt = '2023-11-14T22:20:00.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: loggedInPubkey,
      senderPubkey: chatPublicKey,
      eventId: 'restored-before-own-event',
      content: '  Restored old hello  ',
    });

    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 9,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      given_name: null,
      meta: {
        private_contact_list_member: true,
      },
      relays: [],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Latest message',
      last_message_at: '2023-11-14T22:30:00.000Z',
      unread_count: 3,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
        last_outgoing_message_at: ownMessageAt,
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 47,
      chat_public_key: chatPublicKey,
      author_public_key: chatPublicKey,
      created_at: createdAt,
      event_id: 'restored-before-own-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), loggedInPubkey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatPreview).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatUnreadCount).not.toHaveBeenCalled();
    expect(deps.shouldNotifyForAcceptedChatOnly).not.toHaveBeenCalled();
    expect(deps.showIncomingMessageBrowserNotification).not.toHaveBeenCalled();
  });

  it('drops group messages sent to an older epoch after a higher epoch was issued', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const groupPublicKey = 'c'.repeat(64);
    const oldEpochPublicKey = 'd'.repeat(64);
    const newEpochPublicKey = 'e'.repeat(64);
    const senderPublicKey = 'a'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const higherEpochEntry = {
      epoch_number: 1,
      epoch_public_key: newEpochPublicKey,
      invitation_created_at: '2023-11-14T22:13:19.000Z',
    };
    const groupChat = {
      id: groupPublicKey,
      public_key: groupPublicKey,
      type: 'group' as const,
      name: 'Rotated Group',
      last_message: 'Older preview',
      last_message_at: '2023-11-14T22:00:00.000Z',
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: '2023-11-14T22:00:00.000Z',
      },
    };
    const rumorEvent = makeRumorEvent({
      recipientPubkey: oldEpochPublicKey,
      senderPubkey: senderPublicKey,
      content: '  Stale epoch message  ',
    });

    deps.resolveIncomingPrivateMessageRecipientContext.mockResolvedValue({
      recipientPubkey: oldEpochPublicKey,
      unwrapSigner: {} as never,
      groupChatPublicKey: groupPublicKey,
    });
    deps.findGroupChatEpochContextByRecipientPubkey.mockResolvedValue({
      chat: groupChat,
      epochEntry: {
        epoch_number: 0,
        epoch_public_key: oldEpochPublicKey,
      },
    });
    deps.findHigherKnownGroupEpochConflict.mockReturnValue({
      higherEpochEntry,
      olderHigherEpochEntry: higherEpochEntry,
    });
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(groupChat);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.findHigherKnownGroupEpochConflict).toHaveBeenCalledWith(groupChat, 0, createdAt);
    expect(deps.logInvalidIncomingEpochNumber).toHaveBeenCalledWith(
      groupPublicKey,
      0,
      oldEpochPublicKey,
      createdAt,
      expect.objectContaining({
        higherEpochEntry,
        olderHigherEpochEntry: higherEpochEntry,
      })
    );
    expect(deps.logInboundEvent).toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: 'invalid-epoch-number',
        epochNumber: 0,
      })
    );
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(deps.chatStore.recordIncomingActivity).not.toHaveBeenCalled();
  });

  it('promotes existing chats to accepted when messages arrive from accepted contacts', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
    });
    const existingChat = {
      id: 'a'.repeat(64),
      public_key: 'a'.repeat(64),
      type: 'user',
      name: 'Alice',
      last_message: '',
      last_message_at: '',
      unread_count: 0,
      meta: {},
    };

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 1,
      public_key: 'a'.repeat(64),
      type: 'user',
      name: 'Alice',
      given_name: null,
      meta: {
        private_contact_list_member: true,
      },
      relays: [],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.chatDataService.getChatByPublicKey
      .mockResolvedValueOnce(existingChat)
      .mockResolvedValueOnce({
        ...existingChat,
        meta: {
          inbox_state: 'accepted',
          accepted_at: createdAt,
        },
      });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 42,
      chat_public_key: 'a'.repeat(64),
      author_public_key: 'a'.repeat(64),
      created_at: createdAt,
      event_id: 'rumor-event',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.chatStore.acceptChat).toHaveBeenCalledWith('a'.repeat(64), {
      acceptedAt: createdAt,
    });
    expect(serviceMocks.chatDataService.createChat).not.toHaveBeenCalled();
  });

  it('treats duplicate inbound events as relay-status updates instead of creating new messages', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      eventId: 'duplicate-event',
    });
    const existingMessage = {
      id: 99,
      chat_public_key: 'a'.repeat(64),
      author_public_key: 'a'.repeat(64),
      created_at: '2023-11-14T22:13:20.000Z',
      event_id: 'duplicate-event',
      meta: {},
    };

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getMessageById.mockResolvedValue(existingMessage);
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(existingMessage);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.appendRelayStatusesToMessageEvent).toHaveBeenCalledWith(
      99,
      [makeRelayStatus()],
      expect.objectContaining({
        direction: 'in',
        eventId: 'duplicate-event',
        uiThrottleMs: 25,
      })
    );
    expect(deps.applyPendingIncomingReactionsForMessage).toHaveBeenCalledWith(existingMessage, {
      uiThrottleMs: 25,
    });
    expect(deps.applyPendingIncomingDeletionsForMessage).toHaveBeenCalled();
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
  });

  it('applies an explicit edit replacement to the existing message without creating a duplicate', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const senderPublicKey = 'a'.repeat(64);
    const recipientPublicKey = 'b'.repeat(64);
    const originalEventId = 'c'.repeat(64);
    const replacementEventId = 'd'.repeat(64);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: recipientPublicKey,
      senderPubkey: senderPublicKey,
      eventId: replacementEventId,
      content: 'After edit',
      tags: [
        ['p', recipientPublicKey],
        ['e', originalEventId, '', 'edit'],
      ],
    });
    const chat = {
      id: senderPublicKey,
      public_key: senderPublicKey,
      type: 'user',
      name: 'Alice',
      last_message: 'Before edit',
      last_message_at: createdAt,
      unread_count: 0,
      meta: {},
    };
    const originalMessage = {
      id: 99,
      chat_public_key: senderPublicKey,
      author_public_key: senderPublicKey,
      message: 'Before edit',
      created_at: createdAt,
      event_id: originalEventId,
      meta: {},
    };
    const editedMessage = {
      ...originalMessage,
      message: 'After edit',
      event_id: replacementEventId,
      meta: {
        edited: {
          editedAt: '2023-11-14T22:14:20.000Z',
          previousEventIds: [originalEventId],
        },
      },
    };

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(chat);
    serviceMocks.chatDataService.getMessageByEventId.mockImplementation(async (eventId) =>
      eventId === originalEventId ? originalMessage : null
    );
    serviceMocks.chatDataService.applyMessageEdit.mockResolvedValue(editedMessage);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), recipientPublicKey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.applyMessageEdit).toHaveBeenCalledWith(
      originalMessage.id,
      expect.objectContaining({
        message: 'After edit',
        event_id: replacementEventId,
        previous_event_id: originalEventId,
      })
    );
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      senderPublicKey,
      'After edit',
      createdAt,
      0
    );
  });

  it('routes inbound reaction rumors through the reaction processor', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      eventId: 'reaction-event',
      kind: NDKKind.Reaction,
    });

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.processIncomingReactionRumorEvent).toHaveBeenCalledWith(
      rumorEvent,
      'a'.repeat(64),
      'a'.repeat(64),
      expect.objectContaining({
        uiThrottleMs: 25,
        direction: 'in',
        relayStatuses: [makeRelayStatus()],
        rumorNostrEvent: expect.objectContaining({
          id: 'reaction-event',
          kind: NDKKind.Reaction,
        }),
      })
    );
    expect(serviceMocks.chatDataService.createChat).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
  });

  it('routes inbound deletion rumors through the deletion processor', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      eventId: 'deletion-event',
      kind: NDKKind.EventDeletion,
    });

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.processIncomingDeletionRumorEvent).toHaveBeenCalledWith(
      rumorEvent,
      'a'.repeat(64),
      'a'.repeat(64),
      expect.objectContaining({
        uiThrottleMs: 25,
        seedRelayUrls: ['wss://relay.example'],
      })
    );
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'conflicting epoch public keys',
      configure(deps: ReturnType<typeof createDeps>) {
        deps.findConflictingKnownGroupEpochNumber.mockReturnValue({
          epoch_number: 2,
          epoch_public_key: 'c'.repeat(64),
          epoch_private_key_encrypted: 'enc-conflict',
        });
      },
      expectedReason: 'conflicting-epoch-public-key',
    },
  ])('drops invalid group epoch tickets for $name', async ({ configure, expectedReason }) => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      eventId: 'epoch-ticket',
      kind: 1014,
    });

    configure(deps);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    deps.verifyIncomingGroupEpochTicket.mockResolvedValue({
      epochNumber: 2,
      epochPrivateKey: 'epoch-private-key',
      isValid: true,
      signedEvent: {
        id: 'signed-epoch-ticket',
      },
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: 'a'.repeat(64),
      public_key: 'a'.repeat(64),
      type: 'group',
      name: 'Launch Group',
      last_message: '',
      last_message_at: '',
      unread_count: 0,
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.persistIncomingGroupEpochTicket).not.toHaveBeenCalled();
    expect(deps.upsertIncomingGroupInviteRequestChat).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(deps.logInboundEvent).toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: expectedReason,
      })
    );
  });

  it('persists historical group epoch tickets even when a newer epoch is already known', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      eventId: 'epoch-ticket-history',
      kind: 1014,
      createdAt: 1700000000,
    });

    deps.findHigherKnownGroupEpochConflict.mockReturnValue({
      higherEpochEntry: {
        epoch_number: 3,
        epoch_public_key: 'd'.repeat(64),
        invitation_created_at: '2023-11-15T00:00:00.000Z',
      },
      olderHigherEpochEntry: null,
    });
    deps.resolveIncomingChatInboxStateValue.mockReturnValue('accepted');
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    deps.verifyIncomingGroupEpochTicket.mockResolvedValue({
      epochNumber: 2,
      epochPrivateKey: 'epoch-private-key',
      isValid: true,
      signedEvent: {
        id: 'signed-epoch-ticket',
      },
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: 'a'.repeat(64),
      public_key: 'a'.repeat(64),
      type: 'group',
      name: 'Launch Group',
      last_message: '',
      last_message_at: '',
      unread_count: 0,
      meta: {
        inbox_state: 'accepted',
        accepted_at: createdAt,
      },
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 91,
      chat_public_key: 'a'.repeat(64),
      author_public_key: 'a'.repeat(64),
      created_at: createdAt,
      event_id: 'signed-epoch-ticket',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.persistIncomingGroupEpochTicket).toHaveBeenCalledWith(
      'a'.repeat(64),
      2,
      'epoch-private-key',
      expect.objectContaining({
        accepted: true,
        invitationCreatedAt: createdAt,
      })
    );
    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_public_key: 'a'.repeat(64),
        message: 'Epoch 2',
        event_id: 'signed-epoch-ticket',
      })
    );
    expect(deps.logInboundEvent).not.toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: 'invalid-epoch-number',
      })
    );
  });

  it('drops locally blocked incoming messages without persistence or browser notification', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: 'b'.repeat(64),
      senderPubkey: 'a'.repeat(64),
      content: '  Blocked hello  ',
    });

    deps.resolveIncomingChatInboxStateValue.mockReturnValue('blocked');
    deps.shouldNotifyForAcceptedChatOnly.mockResolvedValue(true);
    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: 'a'.repeat(64),
      public_key: 'a'.repeat(64),
      type: 'user',
      name: 'Blocked Chat',
      last_message: 'Older preview',
      last_message_at: '2023-11-14T22:00:00.000Z',
      unread_count: 5,
      meta: {
        inbox_state: 'blocked',
      },
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), 'b'.repeat(64), {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(deps.logInboundEvent).toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: 'blocked-pubkey',
      })
    );
    expect(serviceMocks.chatDataService.createChat).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatPreview).not.toHaveBeenCalled();
    expect(serviceMocks.nostrEventDataService.upsertEvent).not.toHaveBeenCalled();
    expect(deps.toStoredNostrEvent).not.toHaveBeenCalled();
    expect(deps.showIncomingMessageBrowserNotification).not.toHaveBeenCalled();
    expect(deps.queuePrivateMessagesUiRefresh).not.toHaveBeenCalled();
  });

  it('drops replayed request messages at or before the cleared request boundary', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const chatPublicKey = 'a'.repeat(64);
    const loggedInPubkey = 'b'.repeat(64);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: loggedInPubkey,
      senderPubkey: chatPublicKey,
      content: '  Old request  ',
      createdAt: 1700000000,
    });

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue({
      id: chatPublicKey,
      public_key: chatPublicKey,
      type: 'user',
      name: 'Cleared Request',
      last_message: '',
      last_message_at: '2023-11-14T22:13:20.000Z',
      unread_count: 0,
      meta: {
        last_incoming_message_at: '2023-11-14T22:13:20.000Z',
        request_cleared_at: '2023-11-14T22:13:20.000Z',
      },
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), loggedInPubkey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.chatDataService.updateChatPreview).not.toHaveBeenCalled();
    expect(deps.chatStore.recordIncomingActivity).not.toHaveBeenCalled();
    expect(deps.logInboundEvent).toHaveBeenCalledWith(
      'drop',
      expect.objectContaining({
        reason: 'cleared-request-message',
      })
    );
  });

  it('treats self-sent gift-wrapped messages as outbound activity for the other participant', async () => {
    const deps = createDeps();
    const runtime = createPrivateMessagesIngestRuntime(deps);
    const createdAt = '2023-11-14T22:13:20.000Z';
    const loggedInPubkey = 'a'.repeat(64);
    const otherParticipantPubkey = 'c'.repeat(64);
    const rumorEvent = makeRumorEvent({
      recipientPubkey: loggedInPubkey,
      senderPubkey: loggedInPubkey,
      eventId: 'self-message',
      content: '  Saved note  ',
    });

    rumorEvent.tags = [
      ['p', loggedInPubkey],
      ['p', otherParticipantPubkey],
    ];
    (rumorEvent.getMatchingTags as ReturnType<typeof vi.fn>).mockImplementation(
      (tagName: string) => (tagName === 'p' ? rumorEvent.tags : [])
    );

    ndkMocks.giftUnwrap.mockResolvedValue(rumorEvent);
    serviceMocks.chatDataService.createChat.mockResolvedValue({
      id: otherParticipantPubkey,
      public_key: otherParticipantPubkey,
      type: 'user',
      name: `Chat ${otherParticipantPubkey.slice(0, 8)}`,
      last_message: '',
      last_message_at: createdAt,
      unread_count: 0,
      meta: {},
    });
    serviceMocks.chatDataService.createMessage.mockResolvedValue({
      id: 77,
      chat_public_key: otherParticipantPubkey,
      author_public_key: loggedInPubkey,
      created_at: createdAt,
      event_id: 'self-message',
      meta: {},
    });

    runtime.queuePrivateMessageIngestion(makeWrappedEvent(), loggedInPubkey, {
      uiThrottleMs: 25,
    });
    await runtime.getPrivateMessagesIngestQueue();

    expect(serviceMocks.chatDataService.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        public_key: otherParticipantPubkey,
      })
    );
    expect(serviceMocks.nostrEventDataService.upsertEvent).toHaveBeenCalledWith({
      event: expect.objectContaining({
        id: 'self-message',
      }),
      direction: 'out',
      relay_statuses: [makeRelayStatus()],
    });
    expect(serviceMocks.chatDataService.updateChatPreview).toHaveBeenCalledWith(
      otherParticipantPubkey,
      'Saved note',
      createdAt,
      0
    );
    expect(deps.showIncomingMessageBrowserNotification).not.toHaveBeenCalled();
  });
});
