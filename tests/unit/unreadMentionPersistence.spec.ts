import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetStores } from '#src/lib/state/store.svelte.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { useMessageStore } from '#src/stores/messageStore.svelte.ts';
import { hasUnreadChatMention } from '#src/utils/unreadMentions.ts';

const chatStore = vi.hoisted(() => ({
  selectedChatId: null as string | null,
  visibleChatId: null as string | null,
  setUnreadMentionAt: vi.fn(),
}));

vi.mock('#src/stores/chatStore.svelte.ts', () => ({
  useChatStore: () => chatStore,
}));

const GROUP = 'c'.repeat(64);
const OWN = 'b'.repeat(64);
const MEMBER = 'a'.repeat(64);
const READ_AT = '2026-10-01T00:00:00.000Z';
const FIRST = '2026-10-01T00:00:10.000Z';
const SECOND = '2026-10-01T00:00:20.000Z';

beforeEach(async () => {
  vi.stubGlobal('window', {
    indexedDB: new IDBFactory(),
    localStorage: { getItem: (key: string) => (key === 'npub' ? OWN : null) },
  });
  await chatDataService.createChat({
    public_key: GROUP,
    name: 'Group',
    type: 'group',
    meta: { last_seen_received_activity_at: READ_AT },
  });
});

afterEach(async () => {
  await chatDataService.clearAllData();
  resetStores();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function incoming(at: string, eventId: string, mentionsMe: boolean) {
  return {
    chat_public_key: GROUP,
    author_public_key: MEMBER,
    message: mentionsMe ? 'hi @me' : 'hello',
    created_at: at,
    event_id: eventId,
    meta: mentionsMe ? { mentions_me: true } : {},
    chat_activity: { incomingAt: at, unreadCount: 1, ...(mentionsMe ? { mentionAt: at } : {}) },
  };
}

it('persists the latest unread mention with the message and ignores already-read history', async () => {
  await chatDataService.createMessage(incoming('2026-09-30T00:00:00.000Z', 'd'.repeat(64), true));
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta).not.toHaveProperty(
    'unread_mention_at',
  );

  await chatDataService.createMessage(incoming(SECOND, 'e'.repeat(64), true));
  await chatDataService.createMessage(incoming(FIRST, 'f'.repeat(64), true));
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta.unread_mention_at).toBe(SECOND);
});

const at = (second: number) => new Date(Date.parse(READ_AT) + second * 1000).toISOString();
const mentionAt = async () =>
  (await chatDataService.getChatByPublicKey(GROUP))?.meta.unread_mention_at;

async function seed(count: number, mentions: number[]) {
  const rows = [];
  for (let second = 1; second <= count; second += 1)
    rows.push(
      (await chatDataService.createMessage(
        incoming(at(second), second.toString(16).padStart(64, '0'), mentions.includes(second)),
      ))!,
    );
  return rows;
}

function deleted(row: Awaited<ReturnType<typeof seed>>[number]) {
  return { ...row, meta: { ...row.meta, deleted: { deletedAt: row.created_at } } };
}

it('walks back from a removed latest mention to the previous one, across rapid deletions', async () => {
  const rows = await seed(6, [2, 4, 6]);
  const store = useMessageStore();
  const before = vi.spyOn(chatDataService, 'listMessagesBefore');
  const after = vi.spyOn(chatDataService, 'listMessagesAfter');
  expect(await mentionAt()).toBe(at(6));

  // Removing a mention that is not the latest cannot move the indicator: no scan.
  await chatDataService.updateMessageMeta(rows[3]!.id, deleted(rows[3]!).meta);
  await store.syncUnreadMentionForMessage(rows[3]!, deleted(rows[3]!));
  expect(before).not.toHaveBeenCalled();
  expect(await mentionAt()).toBe(at(6));

  for (const [index, expected] of [
    [5, at(2)],
    [1, ''],
  ] as const) {
    await chatDataService.updateMessageMeta(rows[index]!.id, deleted(rows[index]!).meta);
    await store.syncUnreadMentionForMessage(rows[index]!, deleted(rows[index]!));
    expect(await mentionAt()).toBe(expected);
    expect(chatStore.setUnreadMentionAt).toHaveBeenLastCalledWith(GROUP, expected);
  }
  expect(before).toHaveBeenCalledTimes(2);
  expect(after).not.toHaveBeenCalled();
});

it('raises the indicator for an edit that adds a mention without scanning', async () => {
  const rows = await seed(3, []);
  const before = vi.spyOn(chatDataService, 'listMessagesBefore');
  const store = useMessageStore();
  await store.syncUnreadMentionForMessage(rows[1]!, { ...rows[1]!, meta: { mentions_me: true } });
  expect(await mentionAt()).toBe(at(2));
  // An edit that keeps the mention, or adds one to an older message, changes nothing.
  await store.syncUnreadMentionForMessage(
    { ...rows[1]!, meta: { mentions_me: true } },
    { ...rows[1]!, meta: { mentions_me: true } },
  );
  await store.syncUnreadMentionForMessage(rows[0]!, { ...rows[0]!, meta: { mentions_me: true } });
  expect(await mentionAt()).toBe(at(2));
  expect(before).not.toHaveBeenCalled();
});

it('bounds the backward search on a large history without a read cursor', async () => {
  await chatDataService.updateChatMeta(GROUP, { last_seen_received_activity_at: '' }, true);
  const rows = await seed(620, [1, 619, 620]);
  const before = vi.spyOn(chatDataService, 'listMessagesBefore');
  const after = vi.spyOn(chatDataService, 'listMessagesAfter');
  const batches = vi.spyOn(chatDataService, 'messageBatches');
  const store = useMessageStore();

  // A nearby earlier mention is found on the first page.
  await chatDataService.updateMessageMeta(rows[619]!.id, deleted(rows[619]!).meta);
  await store.syncUnreadMentionForMessage(rows[619]!, deleted(rows[619]!));
  expect(await mentionAt()).toBe(at(619));
  expect(before).toHaveBeenCalledTimes(1);

  // The remaining mention is beyond the scan limit: the search stops instead of reading history.
  await chatDataService.updateMessageMeta(rows[618]!.id, deleted(rows[618]!).meta);
  before.mockClear();
  await store.syncUnreadMentionForMessage(rows[618]!, deleted(rows[618]!));
  expect(await mentionAt()).toBe('');
  expect(before).toHaveBeenCalledTimes(10);
  const scanned = (
    await Promise.all(before.mock.results.map((result) => result.value))
  ).reduce((total, batch) => total + batch.rows.length, 0);
  expect(scanned).toBe(500);
  expect(after).not.toHaveBeenCalled();
  expect(batches).not.toHaveBeenCalled();
});

it('never overwrites a read cursor written by markAsRead during a mention search', async () => {
  const rows = await seed(4, [1, 4]);
  const store = useMessageStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = chatDataService.listMessagesBefore.bind(chatDataService);
  const searching = new Promise<void>((started) => {
    vi.spyOn(chatDataService, 'listMessagesBefore').mockImplementation(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
  });

  await chatDataService.updateMessageMeta(rows[3]!.id, deleted(rows[3]!).meta);
  const pending = store.syncUnreadMentionForMessage(rows[3]!, deleted(rows[3]!));
  await searching;
  // markAsRead persists the full chat meta with the newer cursor and clears the count.
  const chat = (await chatDataService.getChatByPublicKey(GROUP))!;
  await chatDataService.updateChatMeta(GROUP, {
    ...chat.meta,
    last_seen_received_activity_at: at(4),
  });
  await chatDataService.updateChatUnreadCount(GROUP, 0);
  release();
  await pending;

  const stored = (await chatDataService.getChatByPublicKey(GROUP))!;
  expect(stored.meta.last_seen_received_activity_at).toBe(at(4));
  expect(stored.meta.last_incoming_message_at).toBe(chat.meta.last_incoming_message_at);
  expect(
    hasUnreadChatMention({ type: stored.type, unreadCount: stored.unread_count, meta: stored.meta }),
  ).toBe(false);
  // Even if a new message arrives, the older calculation's mention stays read.
  await chatDataService.createMessage(incoming(at(5), 'f'.repeat(64), false));
  const next = (await chatDataService.getChatByPublicKey(GROUP))!;
  expect(
    hasUnreadChatMention({ type: next.type, unreadCount: next.unread_count, meta: next.meta }),
  ).toBe(false);
});
