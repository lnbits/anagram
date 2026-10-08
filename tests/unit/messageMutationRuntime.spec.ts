import NostrClient, { type ClientEvent, NostrKind } from '#src/lib/nostr/client.ts';
import { createMessageMutationRuntime } from '#src/stores/nostr/messageMutationRuntime.ts';
import type { MessageRelayStatus } from '#src/types/chat.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    applyMessageEdit: vi.fn(),
    getMessageByEventId: vi.fn(),
    getMessageByEventIdOrEditReference: vi.fn(),
    getChatByPublicKey: vi.fn(),
    findMessageByReactionEventId: vi.fn(),
    init: vi.fn(),
    listMessagesInSecond: vi.fn(),
    listMessagesReplyingTo: vi.fn(),
    updateMessageMeta: vi.fn(),
    updateChatPreview: vi.fn(),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn(),
  },
  nostrEventDataService: {
    deleteEventsByIds: vi.fn(),
    getEventById: vi.fn(),
    init: vi.fn(),
    upsertEvent: vi.fn(),
  },
}));

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: serviceMocks.contactsService,
}));

vi.mock('#src/services/nostrEventDataService.ts', () => ({
  nostrEventDataService: serviceMocks.nostrEventDataService,
}));

const CHAT_PUBLIC_KEY = 'a'.repeat(64);
const LOGGED_IN_PUBLIC_KEY = 'b'.repeat(64);
const TARGET_EVENT_ID = 'c'.repeat(64);
const REACTION_EVENT_ID = 'd'.repeat(64);

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

function makeReactionEvent(): ClientEvent {
  return {
    id: REACTION_EVENT_ID,
    kind: NostrKind.Reaction,
    created_at: 1700003600,
    pubkey: LOGGED_IN_PUBLIC_KEY,
    content: '👍',
    tags: [],
    getMatchingTags: vi.fn(() => []),
  } as unknown as ClientEvent;
}

function createDeps() {
  return {
    buildInboundTraceDetails: vi.fn(() => ({})),
    deriveChatName: vi.fn((contact, publicKey) => contact?.name ?? `Chat ${publicKey.slice(0, 8)}`),
    formatSubscriptionLogValue: vi.fn((value) => value ?? null),
    getLoggedInPublicKeyHex: vi.fn(() => LOGGED_IN_PUBLIC_KEY),
    logInboundEvent: vi.fn(),
    ndk: new NostrClient(),
    normalizeEventId: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
    ),
    normalizeThrottleMs: vi.fn((value: number | undefined) => value ?? 0),
    queuePendingIncomingDeletion: vi.fn(),
    queuePendingIncomingReaction: vi.fn(),
    queuePrivateMessagesUiRefresh: vi.fn(),
    readDeletionTargetEntries: vi.fn(() => []),
    readReactionTargetAuthorPubkey: vi.fn(() => LOGGED_IN_PUBLIC_KEY),
    readReactionTargetEventId: vi.fn(() => TARGET_EVENT_ID),
    refreshMessageInLiveState: vi.fn(async () => {}),
    removePendingIncomingReaction: vi.fn(),
    repairMissingMessageDependency: vi.fn(async () => false),
    resolveMissingMessageDependencyRepair: vi.fn(),
    toIsoTimestampFromUnix: vi.fn((value: number | undefined) =>
      typeof value === 'number' ? new Date(value * 1000).toISOString() : '',
    ),
    consumePendingIncomingDeletions: vi.fn(() => []),
    consumePendingIncomingReactions: vi.fn(() => []),
  };
}

describe('messageMutationRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(null);
    serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockImplementation((eventId) =>
      serviceMocks.chatDataService.getMessageByEventId(eventId),
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(null);
    serviceMocks.chatDataService.applyMessageEdit.mockResolvedValue(null);
    serviceMocks.chatDataService.findMessageByReactionEventId.mockResolvedValue(null);
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.listMessagesInSecond.mockResolvedValue([]);
    serviceMocks.chatDataService.listMessagesReplyingTo.mockResolvedValue([]);
    serviceMocks.chatDataService.updateMessageMeta.mockResolvedValue(null);
    serviceMocks.chatDataService.updateChatPreview.mockResolvedValue(null);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      name: 'Contact',
    });
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.deleteEventsByIds.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.getEventById.mockResolvedValue(null);
    serviceMocks.nostrEventDataService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.upsertEvent.mockResolvedValue(undefined);
  });

  it('queues missing reaction targets and starts targeted repair', async () => {
    const deps = createDeps();
    const runtime = createMessageMutationRuntime(deps);

    await runtime.processIncomingReactionRumorEvent(
      makeReactionEvent(),
      CHAT_PUBLIC_KEY,
      LOGGED_IN_PUBLIC_KEY,
      {
        uiThrottleMs: 0,
        direction: 'in',
        rumorNostrEvent: {
          id: REACTION_EVENT_ID,
          kind: NostrKind.Reaction,
          pubkey: LOGGED_IN_PUBLIC_KEY,
          created_at: 1700003600,
          content: '👍',
          tags: [],
          sig: '',
        },
        relayStatuses: [makeRelayStatus()],
      },
    );

    expect(deps.queuePendingIncomingReaction).toHaveBeenCalledWith(
      TARGET_EVENT_ID,
      expect.objectContaining({
        chatPublicKey: CHAT_PUBLIC_KEY,
      }),
    );
    expect(deps.repairMissingMessageDependency).toHaveBeenCalledWith(
      CHAT_PUBLIC_KEY,
      TARGET_EVENT_ID,
      expect.objectContaining({
        reason: 'reaction-target-missing',
        immediate: true,
        referenceCreatedAt: 1700003600,
        seedRelayUrls: ['wss://relay.example'],
      }),
    );
  });

  it('returns an unknown reply preview while it repairs the missing target', async () => {
    const deps = createDeps();
    const runtime = createMessageMutationRuntime(deps);

    const replyPreview = await runtime.buildReplyPreviewFromTargetEvent(
      TARGET_EVENT_ID,
      CHAT_PUBLIC_KEY,
      LOGGED_IN_PUBLIC_KEY,
      null,
      {
        referenceCreatedAt: 1700007200,
        seedRelayUrls: ['wss://relay.example'],
      },
    );

    expect(replyPreview).toEqual({
      messageId: TARGET_EVENT_ID,
      text: 'Unkown message.',
      sender: 'them',
      authorName: 'Unknown',
      authorPublicKey: '',
      sentAt: '',
      eventId: TARGET_EVENT_ID,
    });
    expect(deps.repairMissingMessageDependency).toHaveBeenCalledWith(
      CHAT_PUBLIC_KEY,
      TARGET_EVENT_ID,
      expect.objectContaining({
        reason: 'reply-target-missing',
        immediate: true,
        referenceCreatedAt: 1700007200,
        seedRelayUrls: ['wss://relay.example'],
      }),
    );
  });

  it('builds an image thumbnail into a reply preview', async () => {
    const deps = createDeps();
    const runtime = createMessageMutationRuntime(deps);
    const imageUrl = 'https://nostr.build/i/reply.png';
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue({
      id: 44,
      chat_public_key: CHAT_PUBLIC_KEY,
      author_public_key: LOGGED_IN_PUBLIC_KEY,
      message: imageUrl,
      created_at: '2026-01-01T00:00:00.000Z',
      event_id: TARGET_EVENT_ID,
      meta: {
        attachments: [
          {
            type: 'media',
            url: imageUrl,
            mimeType: 'image/png',
            size: 1234,
          },
        ],
      },
    });

    await expect(
      runtime.buildReplyPreviewFromTargetEvent(
        TARGET_EVENT_ID,
        CHAT_PUBLIC_KEY,
        LOGGED_IN_PUBLIC_KEY,
        null,
      ),
    ).resolves.toMatchObject({
      text: 'Picture',
      imageUrl,
      sender: 'me',
      authorName: 'You',
    });
  });

  it('refreshes stale reply previews when the target message arrives', async () => {
    const deps = createDeps();
    const runtime = createMessageMutationRuntime(deps);
    serviceMocks.chatDataService.listMessagesReplyingTo.mockResolvedValue([
      {
        id: 12,
        chat_public_key: CHAT_PUBLIC_KEY,
        author_public_key: 'e'.repeat(64),
        message: 'Replying...',
        created_at: '2026-01-02T00:00:00.000Z',
        event_id: 'f'.repeat(64),
        meta: {
          reply: {
            messageId: TARGET_EVENT_ID,
            text: 'Unkown message.',
            sender: 'them',
            authorName: 'Unknown',
            authorPublicKey: '',
            sentAt: '',
            eventId: TARGET_EVENT_ID,
          },
        },
      },
    ]);
    serviceMocks.chatDataService.updateMessageMeta.mockImplementation(async (messageId, meta) => ({
      id: messageId,
      chat_public_key: CHAT_PUBLIC_KEY,
      author_public_key: 'e'.repeat(64),
      message: 'Replying...',
      created_at: '2026-01-02T00:00:00.000Z',
      event_id: 'f'.repeat(64),
      meta,
    }));

    const targetMessage = {
      id: 44,
      chat_public_key: CHAT_PUBLIC_KEY,
      author_public_key: LOGGED_IN_PUBLIC_KEY,
      message: 'Original message',
      created_at: '2026-01-01T00:00:00.000Z',
      event_id: TARGET_EVENT_ID,
      meta: {},
    };

    await expect(
      runtime.refreshReplyPreviewsForTargetMessage(targetMessage as never),
    ).resolves.toBe(1);

    expect(deps.resolveMissingMessageDependencyRepair).toHaveBeenCalledWith(TARGET_EVENT_ID);
    expect(serviceMocks.chatDataService.updateMessageMeta).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        reply: expect.objectContaining({
          messageId: '44',
          text: 'Original message',
          sender: 'me',
          authorName: 'You',
          eventId: TARGET_EVENT_ID,
        }),
      }),
    );
    expect(deps.refreshMessageInLiveState).toHaveBeenCalledWith(12);
  });

  it('collapses a same-timestamp replacement when the predecessor deletion arrives last', async () => {
    const deps = createDeps();
    deps.readDeletionTargetEntries.mockReturnValue([
      { eventId: TARGET_EVENT_ID, kind: NostrKind.PrivateDirectMessage },
    ]);
    const runtime = createMessageMutationRuntime(deps);
    const replacementEventId = 'e'.repeat(64);
    const originalMessage = {
      id: 20,
      chat_public_key: CHAT_PUBLIC_KEY,
      author_public_key: LOGGED_IN_PUBLIC_KEY,
      message: 'Before edit',
      created_at: '2026-01-01T00:00:00.000Z',
      event_id: TARGET_EVENT_ID,
      meta: {},
    };
    const replacementMessage = {
      ...originalMessage,
      id: 21,
      message: 'After edit',
      event_id: replacementEventId,
      meta: {
        edited: {
          editedAt: '2026-01-01T00:01:00.000Z',
          previousEventIds: [TARGET_EVENT_ID],
        },
      },
    };
    const collapsedMessage = {
      ...originalMessage,
      message: replacementMessage.message,
      event_id: replacementEventId,
      meta: replacementMessage.meta,
    };
    serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(originalMessage);
    serviceMocks.chatDataService.listMessagesInSecond.mockResolvedValue([
      originalMessage,
      replacementMessage,
    ]);
    serviceMocks.chatDataService.applyMessageEdit.mockResolvedValue(collapsedMessage);

    await runtime.processIncomingDeletionRumorEvent(
      {
        id: 'f'.repeat(64),
        kind: NostrKind.EventDeletion,
        created_at: 1767225660,
        pubkey: LOGGED_IN_PUBLIC_KEY,
        content: '',
        tags: [],
      } as unknown as ClientEvent,
      CHAT_PUBLIC_KEY,
      LOGGED_IN_PUBLIC_KEY,
    );

    expect(serviceMocks.chatDataService.applyMessageEdit).toHaveBeenCalledWith(
      originalMessage.id,
      expect.objectContaining({
        message: 'After edit',
        event_id: replacementEventId,
        previous_event_id: TARGET_EVENT_ID,
      }),
    );
    expect(serviceMocks.chatDataService.updateMessageMeta).not.toHaveBeenCalled();
    expect(deps.refreshMessageInLiveState).toHaveBeenCalledWith(originalMessage.id);
  });

  describe('kind 15 file messages', () => {
    const encryptedAttachment = {
      type: 'media',
      url: `https://blossom.example.com/${'c3'.repeat(32)}`,
      mimeType: 'image/png',
      size: 2048,
      sha256: 'c3'.repeat(32),
      encryption: { algorithm: 'aes-gcm', key: 'a1'.repeat(32), nonce: 'b2'.repeat(12) },
    };
    const fileMessage = {
      id: 30,
      chat_public_key: CHAT_PUBLIC_KEY,
      author_public_key: CHAT_PUBLIC_KEY,
      message: encryptedAttachment.url,
      created_at: '2026-01-01T00:00:00.000Z',
      event_id: TARGET_EVENT_ID,
      meta: { kind: 15, attachments: [encryptedAttachment] },
    };

    it('builds text-only reply previews without the blob URL or decryption data', async () => {
      const runtime = createMessageMutationRuntime(createDeps());
      serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(fileMessage);

      const preview = await runtime.buildReplyPreviewFromTargetEvent(
        TARGET_EVENT_ID,
        CHAT_PUBLIC_KEY,
        LOGGED_IN_PUBLIC_KEY,
        null,
      );

      expect(preview).toMatchObject({ text: 'Picture' });
      expect(preview).not.toHaveProperty('imageUrl');
      expect(JSON.stringify(preview)).not.toContain('a1'.repeat(32));
    });

    it('applies a deletion that targets kind 15', async () => {
      const deps = createDeps();
      deps.readDeletionTargetEntries.mockReturnValue([{ eventId: TARGET_EVENT_ID, kind: 15 }]);
      const runtime = createMessageMutationRuntime(deps);
      serviceMocks.chatDataService.getMessageByEventId.mockResolvedValue(fileMessage);
      serviceMocks.chatDataService.updateMessageMeta.mockImplementation(async (id, meta) => ({
        ...fileMessage,
        id,
        meta,
      }));

      await runtime.processIncomingDeletionRumorEvent(
        {
          id: 'f'.repeat(64),
          kind: NostrKind.EventDeletion,
          created_at: 1767225660,
          pubkey: CHAT_PUBLIC_KEY,
          content: '',
          tags: [],
        } as unknown as ClientEvent,
        CHAT_PUBLIC_KEY,
        CHAT_PUBLIC_KEY,
      );

      expect(serviceMocks.chatDataService.updateMessageMeta).toHaveBeenCalledWith(
        fileMessage.id,
        expect.objectContaining({
          deleted: expect.objectContaining({ deletedEventKind: 15 }),
        }),
      );
      expect(deps.queuePendingIncomingDeletion).not.toHaveBeenCalled();
    });

    it('applies a queued kind 15 deletion when the file message arrives later', async () => {
      const deps = createDeps();
      deps.consumePendingIncomingDeletions.mockImplementation(((eventId: string) =>
        eventId === TARGET_EVENT_ID
          ? [
              {
                deletionAuthorPublicKey: CHAT_PUBLIC_KEY,
                deleteEventId: 'f'.repeat(64),
                deletedAt: '2026-01-01T00:05:00.000Z',
                targetKind: 15,
              },
            ]
          : []) as never);
      const runtime = createMessageMutationRuntime(deps);
      serviceMocks.chatDataService.updateMessageMeta.mockImplementation(async (id, meta) => ({
        ...fileMessage,
        id,
        meta,
      }));

      const updated = await runtime.applyPendingIncomingDeletionsForMessage(fileMessage as never);

      expect(updated.meta).toMatchObject({ deleted: { deletedEventKind: 15 } });
    });
  });
});
