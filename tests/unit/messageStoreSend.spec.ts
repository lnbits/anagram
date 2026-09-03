import { createPinia, setActivePinia } from 'pinia';
import { MissingContactRelaysError, useMessageStore } from 'src/stores/messageStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT_ID = 'c'.repeat(64);
const AUTHOR_PUBLIC_KEY = 'a'.repeat(64);
const EPOCH_PUBLIC_KEY = 'b'.repeat(64);

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    createMessage: vi.fn(),
    getChatByPublicKey: vi.fn(),
    getMessageById: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  },
  nostrEventDataService: {
    getEventById: vi.fn().mockResolvedValue(null),
    init: vi.fn().mockResolvedValue(undefined),
  },
  chatStore: {
    selectedChatId: null as string | null,
    setUnseenReactionCount: vi.fn(),
    updateChatPreview: vi.fn().mockResolvedValue(undefined),
    visibleChatId: null as string | null,
  },
  nostrStore: {
    ensureRespondedPubkeyIsContact: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue({ id: 'gift-wrap' }),
  },
  relayStore: {
    init: vi.fn(),
    relays: ['wss://app.example'],
  },
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

vi.mock('src/services/nostrEventDataService', () => ({
  nostrEventDataService: serviceMocks.nostrEventDataService,
}));

vi.mock('src/stores/chatStore', () => ({
  useChatStore: () => serviceMocks.chatStore,
}));

vi.mock('src/stores/nostrStore', () => ({
  useNostrStore: () => serviceMocks.nostrStore,
}));

vi.mock('src/stores/relayStore', () => ({
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
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
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
      }
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

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
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
      })
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

  it('keeps the visible message when contact relays are missing', async () => {
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      public_key: CHAT_ID,
      relays: [],
      sendMessagesToAppRelays: false,
    });
    const store = useMessageStore();

    const sendError = await store.sendMessage(CHAT_ID, 'still here').then(
      () => null,
      (error: unknown) => error
    );

    expect(sendError).toBeInstanceOf(MissingContactRelaysError);
    expect(sendError).toMatchObject({
      localMessageId: 11,
    });

    expect(store.getMessages(CHAT_ID).map((message) => message.text)).toEqual(['still here']);
    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
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
      })
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
      'Failed to persist outbound message.'
    );

    expect(store.getMessages(CHAT_ID).map((message) => message.text)).toEqual(['not persisted']);
    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('rejects a continuation row that belongs to another chat', async () => {
    serviceMocks.chatDataService.getMessageById.mockResolvedValue(
      makeMessageRow({ chat_public_key: 'd'.repeat(64) })
    );
    const store = useMessageStore();

    await expect(
      store.sendMessage(CHAT_ID, 'wrong chat', null, {
        continueFromMessageId: 11,
        relayUrls: ['wss://fallback.example'],
      })
    ).rejects.toThrow('Cannot continue an outbound message from a different chat.');

    expect(serviceMocks.nostrStore.sendDirectMessage).not.toHaveBeenCalled();
  });
});
