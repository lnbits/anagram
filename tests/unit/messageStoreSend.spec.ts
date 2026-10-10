import { UNKNOWN_REPLY_MESSAGE_TEXT } from '#src/stores/nostr/constants.ts';
import { createPinia, setActivePinia } from '#src/lib/state/store.ts';
import { MissingContactRelaysError, useMessageStore } from '#src/stores/messageStore.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT_ID = 'c'.repeat(64);
const AUTHOR_PUBLIC_KEY = 'a'.repeat(64);
const EPOCH_PUBLIC_KEY = 'b'.repeat(64);

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    createMessage: vi.fn(),
    getChatByPublicKey: vi.fn(),
    getMessageById: vi.fn(),
    getMessageByEventIdOrEditReference: vi.fn().mockResolvedValue(null),
    listLatestMessages: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  },
  nostrEventDataService: {
    getEventById: vi.fn().mockResolvedValue(null),
    getEventsByIds: vi.fn().mockResolvedValue(new Map()),
    init: vi.fn().mockResolvedValue(undefined),
  },
  chatStore: {
    selectedChatId: null as string | null,
    setUnseenReactionCount: vi.fn(),
    updateChatPreview: vi.fn().mockResolvedValue(undefined),
    visibleChatId: null as string | null,
  },
  nostrStore: {
    getLoggedInPublicKeyHex: vi.fn(() => 'a'.repeat(64)),
    repairMissingMessageDependency: vi.fn().mockResolvedValue(false),
    refreshContactByPublicKey: vi.fn().mockResolvedValue(undefined),
    ensureRespondedPubkeyIsContact: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue({ id: 'gift-wrap' }),
  },
  relayStore: {
    init: vi.fn(),
    relays: ['wss://app.example'],
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

vi.mock('#src/stores/chatStore.ts', () => ({
  useChatStore: () => serviceMocks.chatStore,
}));

vi.mock('#src/stores/nostrStore.ts', () => ({
  useNostrStore: () => serviceMocks.nostrStore,
}));

vi.mock('#src/stores/relayStore.ts', () => ({
  useRelayStore: () => serviceMocks.relayStore,
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function makeChatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAT_ID,
    public_key: CHAT_ID,
    type: 'user',
    name: 'Bob',
    last_message: '',
    last_message_at: null,
    unread_count: 0,
    meta: {},
    ...overrides,
  };
}

function makeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    chat_public_key: CHAT_ID,
    author_public_key: AUTHOR_PUBLIC_KEY,
    message: 'hello',
    created_at: '2026-01-02T00:00:00.000Z',
    event_id: null,
    meta: {},
    ...overrides,
  };
}

describe('messageStore send', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    serviceMocks.relayStore.relays = ['wss://app.example'];
    serviceMocks.nostrStore.refreshContactByPublicKey.mockResolvedValue(undefined);
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockResolvedValue(null);
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.init.mockResolvedValue(undefined);
    serviceMocks.nostrEventDataService.getEventById.mockResolvedValue(null);
    serviceMocks.chatStore.selectedChatId = CHAT_ID;
    serviceMocks.chatStore.visibleChatId = CHAT_ID;
    serviceMocks.chatStore.updateChatPreview.mockResolvedValue(undefined);
    serviceMocks.nostrStore.sendDirectMessage.mockResolvedValue({ id: 'gift-wrap' });
    serviceMocks.nostrStore.ensureRespondedPubkeyIsContact.mockResolvedValue(undefined);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      public_key: CHAT_ID,
      relays: [{ url: 'wss://contact.example', write: true }],
      sendMessagesToAppRelays: false,
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(makeChatRow());
    serviceMocks.chatDataService.createMessage.mockImplementation(
      async (input: { message?: string; created_at?: string; meta?: Record<string, unknown> }) => {
        const created = makeMessageRow({
          message: input.message,
          created_at: input.created_at,
          meta: input.meta ?? {},
        });
        serviceMocks.chatDataService.getMessageById.mockResolvedValue(created);
        return created;
      },
    );
    serviceMocks.chatDataService.getMessageById.mockResolvedValue(makeMessageRow());

    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (key: string) => (key === 'npub' ? AUTHOR_PUBLIC_KEY : null),
        },
      },
      configurable: true,
    });
  });

  it('resumes an unresolved reply from the bounded persisted window after restart', async () => {
    const target = 'd'.repeat(64);
    const row = makeMessageRow({
      meta: { reply: { eventId: target, authorPublicKey: '', text: 'Unknown' } },
    });
    serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
      rows: [row],
      has_more: false,
    });
    const store = useMessageStore();
    await store.loadMessages(CHAT_ID);
    await vi.waitFor(() =>
      expect(serviceMocks.nostrStore.repairMissingMessageDependency).toHaveBeenCalledWith(
        CHAT_ID,
        target,
        { reason: 'reply-target-missing', referenceCreatedAt: Date.parse(row.created_at) / 1000 },
      ),
    );
    expect(serviceMocks.chatDataService.listLatestMessages).toHaveBeenCalledWith(CHAT_ID, 50);
  });

  it.each(['deleted', 'another chat'])(
    'sanitizes cached quotes when the parent is %s',
    async (reason) => {
      const target = 'd'.repeat(64);
      const reply = {
        eventId: target,
        messageId: target,
        authorPublicKey: AUTHOR_PUBLIC_KEY,
        text: 'Old confidential text',
        imageUrl: 'https://media.example/old.png',
        sender: 'them',
      };
      serviceMocks.chatDataService.listLatestMessages.mockResolvedValue({
        rows: [makeMessageRow({ meta: { reply } })],
        has_more: false,
      });
      serviceMocks.chatDataService.getMessageByEventIdOrEditReference.mockResolvedValue(
        makeMessageRow({
          event_id: target,
          chat_public_key: reason === 'another chat' ? 'e'.repeat(64) : CHAT_ID,
          meta: reason === 'deleted' ? { deleted: true } : {},
        }),
      );
      const store = useMessageStore();
      await store.loadMessages(CHAT_ID);
      const preview = store.getMessages(CHAT_ID)[0].meta.reply;
      expect(preview?.text).toBe(
        reason === 'deleted' ? 'Message deleted' : UNKNOWN_REPLY_MESSAGE_TEXT,
      );
      expect(preview?.imageUrl).toBeUndefined();
      if (reason === 'another chat') expect(preview?.authorPublicKey).toBeUndefined();
      expect(serviceMocks.chatDataService.getMessageByEventIdOrEditReference).toHaveBeenCalledWith(
        target,
      );
      expect(serviceMocks.chatDataService.listLatestMessages).toHaveBeenCalledWith(CHAT_ID, 50);
    },
  );

  it('publishes a caption and uploaded media together with attachment metadata', async () => {
    const attachment = { url: 'https://media.example/image.png', mimeType: 'image/png', size: 4 };
    const text = `A caption\n${attachment.url}`;
    await useMessageStore().sendMessage(CHAT_ID, text, undefined, { attachments: [attachment] });
    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: text,
        meta: expect.objectContaining({ attachments: [attachment] }),
      }),
    );
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
      CHAT_ID,
      text,
      expect.any(Array),
      expect.objectContaining({
        additionalTags: [
          expect.arrayContaining(['imeta', `url ${attachment.url}`, 'm image/png', 'size 4']),
        ],
      }),
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('persists a call summary and sends its private tag through the normal DM flow', async () => {
    const history = {
      id: '12345678-1234-1234-1234-123456789012',
      mode: 'audio' as const,
      reason: 'declined' as const,
      duration: 0,
      connected: false,
    };
    await useMessageStore().sendCallHistory(CHAT_ID, history);
    expect(serviceMocks.chatDataService.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Audio call · Declined',
        meta: expect.objectContaining({ call_history: history }),
      }),
    );
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'Audio call · Declined',
      expect.any(Array),
      expect.objectContaining({
        publishSelfCopy: true,
        additionalTags: [['anagram-call', '1', history.id, 'audio', 'declined', '0', '0']],
      }),
    );
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(
      makeChatRow({ type: 'group' }),
    );
    expect(await useMessageStore().sendCallHistory(CHAT_ID, history)).toBeNull();
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledOnce();
  });

  it('adds a DM to thread state before persistence or publish start', () => {
    const createMessage = createDeferred<ReturnType<typeof makeMessageRow>>();
    serviceMocks.chatDataService.createMessage.mockReturnValue(createMessage.promise);
    const store = useMessageStore();

    const pending = store.sendMessage(CHAT_ID, 'hello now');
    const visible = store.getMessages(CHAT_ID);

    expect(visible.map((message) => message.text)).toEqual(['hello now']);
    expect(visible[0]?.sender).toBe('me');
    expect(visible[0]?.id.startsWith('optimistic-')).toBe(true);
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();

    createMessage.resolve(makeMessageRow({ message: 'hello now' }));
    return pending;
  });

  it('adds a group message to thread state before persistence or publish start', () => {
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(
      makeChatRow({
        type: 'group',
        meta: {
          current_epoch_public_key: EPOCH_PUBLIC_KEY,
        },
      }),
    );
    const createMessage = createDeferred<ReturnType<typeof makeMessageRow>>();
    serviceMocks.chatDataService.createMessage.mockReturnValue(createMessage.promise);
    const store = useMessageStore();

    const pending = store.sendMessage(CHAT_ID, 'group hello');
    const visible = store.getMessages(CHAT_ID);

    expect(visible.map((message) => message.text)).toEqual(['group hello']);
    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();

    createMessage.resolve(makeMessageRow({ message: 'group hello' }));
    return pending;
  });

  it('keeps the visible message when both contact and app relays are missing', async () => {
    serviceMocks.relayStore.relays = [];
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      public_key: CHAT_ID,
      relays: [],
      sendMessagesToAppRelays: false,
    });
    const store = useMessageStore();

    const sendError = await store.sendMessage(CHAT_ID, 'still here').then(
      () => null,
      (error: unknown) => error,
    );

    expect(sendError).toBeInstanceOf(MissingContactRelaysError);
    expect(sendError).toMatchObject({
      localMessageId: 11,
    });

    expect(store.getMessages(CHAT_ID).map((message) => message.text)).toEqual(['still here']);
    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('discovers recipient inboxes and includes app relays during fresh hydration', async () => {
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValueOnce({
      public_key: CHAT_ID,
      relays: [],
      sendMessagesToAppRelays: false,
    });
    const store = useMessageStore();
    await store.sendMessage(CHAT_ID, 'discover first');
    expect(serviceMocks.nostrStore.refreshContactByPublicKey).toHaveBeenCalledWith(
      CHAT_ID,
      CHAT_ID,
      { refreshRelayList: true, relayListSeedRelayUrls: ['wss://app.example'] },
    );
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'discover first',
      ['wss://contact.example', 'wss://app.example'],
      expect.anything(),
    );
    expect(store.getMessages(CHAT_ID)).toHaveLength(1);
  });

  it.each([false, true])(
    'uses app relays without a recipient inbox even when discovery fails: %s',
    async (fails) => {
      serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
        public_key: CHAT_ID,
        type: 'user',
        relays: [],
        sendMessagesToAppRelays: false,
      });
      if (fails)
        serviceMocks.nostrStore.refreshContactByPublicKey.mockRejectedValue(new Error('offline'));
      await useMessageStore().sendMessage(CHAT_ID, 'app route');
      expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
        CHAT_ID,
        'app route',
        ['wss://app.example'],
        expect.anything(),
      );
    },
  );

  it('keeps private group messages on their group relays', async () => {
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      public_key: CHAT_ID, type: 'group', meta: {},
      relays: [{ url: 'wss://group.example', read: true }],
    });
    serviceMocks.chatDataService.getChatByPublicKey.mockResolvedValue(makeChatRow({
      type: 'group', meta: { current_epoch_public_key: 'c'.repeat(64) },
    }));
    await useMessageStore().sendMessage(CHAT_ID, 'group message');
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
      'c'.repeat(64), 'group message', ['wss://group.example'], expect.anything(),
    );
  });

  it('retries a missing-relay send against the already created local message', async () => {
    const store = useMessageStore();

    await store.sendMessage(CHAT_ID, 'retry me', null, {
      continueFromMessageId: 11,
      relayUrls: ['wss://fallback.example'],
    });

    expect(serviceMocks.chatDataService.createMessage).not.toHaveBeenCalled();
    expect(serviceMocks.nostrStore.sendDirectMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'hello',
      ['wss://fallback.example'],
      expect.objectContaining({
        localMessageId: 11,
      }),
    );
    expect(store.getMessages(CHAT_ID)).toHaveLength(1);
  });

  it('keeps the visible message when publish fails', async () => {
    serviceMocks.nostrStore.sendDirectMessage.mockRejectedValue(new Error('relay timeout'));
    const store = useMessageStore();

    await expect(store.sendMessage(CHAT_ID, 'keep me')).rejects.toThrow('relay timeout');
    expect(store.getMessages(CHAT_ID).map((message) => message.text)).toEqual(['keep me']);
  });

  it('keeps the optimistic bubble but does not publish when persistence fails', async () => {
    serviceMocks.chatDataService.createMessage.mockResolvedValue(null);
    const store = useMessageStore();

    await expect(store.sendMessage(CHAT_ID, 'not persisted')).rejects.toThrow(
      'Failed to persist outbound message.',
    );

    expect(store.getMessages(CHAT_ID).map((message) => message.text)).toEqual(['not persisted']);
    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('rejects a continuation row that belongs to another chat', async () => {
    serviceMocks.chatDataService.getMessageById.mockResolvedValue(
      makeMessageRow({ chat_public_key: 'd'.repeat(64) }),
    );
    const store = useMessageStore();

    await expect(
      store.sendMessage(CHAT_ID, 'wrong chat', null, {
        continueFromMessageId: 11,
        relayUrls: ['wss://fallback.example'],
      }),
    ).rejects.toThrow('Cannot continue an outbound message from a different chat.');

    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
  });
});
