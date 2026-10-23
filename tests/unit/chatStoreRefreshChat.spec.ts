import { resetStores } from '#src/lib/state/store.svelte.ts';
import { useChatStore } from '#src/stores/chatStore.svelte.ts';
import type { Chat } from '#src/types/chat.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  chatDataService: {
    init: vi.fn(async () => {}),
    getChatByPublicKey: vi.fn(),
    listChats: vi.fn(async () => []),
  },
  contactsService: {
    init: vi.fn(async () => {}),
    getContactByPublicKey: vi.fn(async () => null),
    listContacts: vi.fn(async () => []),
  },
}));

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: services.chatDataService,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: services.contactsService,
}));

const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);

function makeChat(publicKey: string, overrides: Partial<Chat> = {}): Chat {
  return {
    id: publicKey,
    publicKey,
    epochPublicKey: null,
    type: 'user',
    name: publicKey === alice ? 'Alice' : 'Bob',
    avatar: 'A',
    lastMessage: 'Hi',
    lastMessageAuthorPublicKey: publicKey,
    lastMessageAt: '2026-01-02T00:00:00.000Z',
    unreadCount: 2,
    meta: {},
    ...overrides,
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    public_key: alice,
    type: 'user',
    name: 'Alice',
    last_message: 'Hi',
    last_message_at: '2026-01-02T00:00:00.000Z',
    unread_count: 0,
    meta: { last_seen_received_activity_at: '2026-01-02T00:00:00.000Z' },
    ...overrides,
  };
}

// The store loads its chats once when created; tests start after that initial load.
async function loadedChatStore() {
  const chats = useChatStore();
  await vi.waitFor(() => expect(chats.isLoaded).toBe(true));
  vi.clearAllMocks();
  return chats;
}

describe('chatStore.refreshChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>([['npub', 'f'.repeat(64)]]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    resetStores();
    vi.unstubAllGlobals();
  });

  it('re-reads only the given chat and leaves other chats untouched', async () => {
    const chats = await loadedChatStore();
    const other = makeChat(bob, { lastMessageAt: '2026-01-01T00:00:00.000Z' });
    chats.chats = [makeChat(alice), other];
    services.chatDataService.getChatByPublicKey.mockResolvedValue(makeRow());

    await chats.refreshChat(alice);

    expect(chats.chats.find((chat) => chat.id === alice)?.unreadCount).toBe(0);
    expect(chats.chats.find((chat) => chat.id === alice)?.meta).toMatchObject({
      last_seen_received_activity_at: '2026-01-02T00:00:00.000Z',
    });
    expect(chats.chats.find((chat) => chat.id === bob)).toStrictEqual(other);
    expect(services.chatDataService.getChatByPublicKey).toHaveBeenCalledExactlyOnceWith(alice);
    expect(services.chatDataService.listChats).not.toHaveBeenCalled();
    expect(services.contactsService.listContacts).not.toHaveBeenCalled();
  });

  it('keeps a message that lands while the chat is being read', async () => {
    const chats = await loadedChatStore();
    chats.chats = [makeChat(alice)];
    let releaseRow!: (row: ReturnType<typeof makeRow>) => void;
    services.chatDataService.getChatByPublicKey.mockReturnValue(
      new Promise((resolve) => {
        releaseRow = resolve;
      }),
    );

    const refreshing = chats.refreshChat(alice);
    chats.chats = [
      makeChat(alice, {
        lastMessage: 'Newer',
        lastMessageAt: '2026-01-03T00:00:00.000Z',
        unreadCount: 1,
      }),
    ];
    await vi.waitFor(() => expect(releaseRow).toBeTypeOf('function'));
    releaseRow(makeRow());
    await refreshing;

    expect(chats.chats[0]).toMatchObject({
      lastMessage: 'Newer',
      lastMessageAt: '2026-01-03T00:00:00.000Z',
      unreadCount: 1,
      meta: { last_seen_received_activity_at: '2026-01-02T00:00:00.000Z' },
    });
  });

  it('ignores chats that are not in the list and account switches', async () => {
    const chats = await loadedChatStore();
    chats.chats = [makeChat(alice)];
    await chats.refreshChat(bob);
    expect(services.chatDataService.getChatByPublicKey).not.toHaveBeenCalled();

    services.chatDataService.getChatByPublicKey.mockImplementation(async () => {
      window.localStorage.setItem('npub', 'e'.repeat(64));
      return makeRow();
    });
    await chats.refreshChat(alice);
    expect(chats.chats[0].unreadCount).toBe(2);
  });
});
