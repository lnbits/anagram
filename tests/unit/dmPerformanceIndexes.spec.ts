import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { chatDataService } from '#src/services/chatDataService.ts';

afterEach(async () => {
  await chatDataService.clearAllData();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('adds indexes without changing v3 rows and seeks over large outgoing histories', async () => {
  const factory = new IDBFactory();
  vi.stubGlobal('window', { indexedDB: factory });
  const chat = 'a'.repeat(64),
    own = 'b'.repeat(64),
    peer = 'c'.repeat(64),
    target = 'd'.repeat(64);
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('chat-data-indexeddb-v2', 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chats', { keyPath: 'public_key' });
      const store = request.result.createObjectStore('messages', {
        keyPath: 'id',
        autoIncrement: true,
      });
      store.createIndex('reaction_event_ids', 'reaction_event_ids', { multiEntry: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const rows = Array.from({ length: 2000 }, (_, n) => ({
    id: n + 1,
    chat_public_key: chat,
    author_public_key: own,
    message: `Existing ${n}`,
    created_at: '2026-02-01T00:00:00.000Z',
    event_id: n.toString(16).padStart(64, '0'),
    meta: n === 1 ? { reply: { eventId: target, text: 'Waiting' } } : {},
  }));
  rows[0] = { ...rows[0], author_public_key: peer, created_at: '2026-01-01T00:00:00.000Z' };
  rows[2] = { ...rows[2], author_public_key: chat, created_at: rows[0].created_at };
  rows[3] = { ...rows[3], author_public_key: chat, meta: { kind: 1014 } as never };
  rows[4] = {
    ...rows[4],
    chat_public_key: peer,
    meta: { reply: { eventId: target, text: 'Other chat' } },
  };
  await new Promise<void>((resolve, reject) => {
    const tx = old.transaction(['chats', 'messages'], 'readwrite');
    tx.objectStore('chats').put({
      public_key: chat,
      type: 'group',
      name: 'Existing',
      meta: {},
      unread_count: 2,
    });
    rows.forEach((row) => tx.objectStore('messages').put(row));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  old.close();
  await chatDataService.init();
  const db = await chatDataService.getDatabase();
  expect(db.version).toBe(5);
  const restored = await new Promise((resolve) => {
    const request = db.transaction('messages').objectStore('messages').getAll();
    request.onsuccess = () => resolve(request.result);
  });
  expect(restored).toEqual(rows); // The migration must not rewrite content or metadata.
  const steps = vi.spyOn(IDBCursor.prototype, 'continue');
  expect((await chatDataService.findLatestIncomingMessage(chat, own))?.id).toBe(3);
  expect(steps.mock.calls.length).toBeLessThan(10);
  steps.mockClear();
  expect(
    (await chatDataService.findFirstIncomingMessageAfter(chat, '2025-01-01T00:00:00.000Z', own))
      ?.id,
  ).toBe(1);
  expect(steps.mock.calls.length).toBeLessThan(10);
  steps.mockClear();
  // Only outgoing rows and a control message follow this boundary.
  expect(
    await chatDataService.findFirstIncomingMessageAfter(chat, rows[0].created_at, own),
  ).toBeNull();
  expect(steps.mock.calls.length).toBeLessThan(10);
  expect(await chatDataService.findLatestIncomingMessage('empty', own)).toBeNull();
  expect(await chatDataService.findLatestIncomingMessage(chat, null)).toBeNull();
  expect(
    (await chatDataService.listMessagesReplyingTo(chat, [target, target])).map((row) => row.id),
  ).toEqual([2]);
  expect(await chatDataService.listMessagesReplyingTo(chat, ['f'.repeat(64)])).toEqual([]);
  await chatDataService.updateMessageMeta(2, { reply: { eventId: peer, text: 'Changed target' } });
  expect(await chatDataService.listMessagesReplyingTo(chat, [target])).toEqual([]);
  expect((await chatDataService.listMessagesReplyingTo(chat, [peer]))[0].id).toBe(2);
  await chatDataService.deleteMessageByEventId(rows[1].event_id);
  expect(await chatDataService.listMessagesReplyingTo(chat, [peer])).toEqual([]);
});

it('atomically inserts duplicate deliveries once and leaves missing-chat or aborted writes empty', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const chat = 'a'.repeat(64),
    author = 'b'.repeat(64),
    event = 'c'.repeat(64);
  await chatDataService.createChat({ public_key: chat, name: 'Atomic fixture' });
  const input = {
    chat_public_key: chat,
    author_public_key: author,
    message: 'Durable',
    event_id: event,
  };
  const rows = await Promise.all(
    Array.from({ length: 20 }, () => chatDataService.createMessage(input)),
  );
  expect(new Set(rows.map((row) => row?.id)).size).toBe(1);
  expect(rows.every((row) => row?.message === 'Durable')).toBe(true);
  expect(await chatDataService.listMessages(chat)).toHaveLength(1);
  expect(await chatDataService.createMessage({ ...input, chat_public_key: 'missing' })).toBeNull();
  const originalAdd = IDBObjectStore.prototype.add;
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (...args) {
    const request = originalAdd.apply(this, args);
    this.transaction.abort();
    return request;
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await chatDataService.createMessage({ ...input, event_id: 'd'.repeat(64) })).toBeNull();
  add.mockRestore();
  error.mockRestore();
  expect(await chatDataService.getMessageByEventId('d'.repeat(64))).toBeNull();
  expect(await chatDataService.listMessages(chat)).toHaveLength(1);
  expect((await chatDataService.getMessageByEventIdOrEditReference(event))?.id).toBe(rows[0]?.id);
});

it('pages only reaction rows including legacy reactions and respects exact read boundaries', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const chat = 'a'.repeat(64),
    own = 'b'.repeat(64),
    peer = 'c'.repeat(64);
  await chatDataService.createChat({ public_key: chat, name: 'Reactions' });
  const created = [];
  for (let n = 0; n < 8; n++)
    created.push(
      await chatDataService.createMessage({
        chat_public_key: chat,
        author_public_key: n < 4 ? own : peer,
        message: `Row ${n}`,
        created_at: `2026-01-0${n + 1}T00:00:00.000Z`,
        meta: n % 2 ? { reactions: [{ reactorPublicKey: peer, content: '+' }] } : {},
      }),
    );
  const rows = [];
  for await (const batch of chatDataService.reactionMessageBatches(chat, 2)) {
    expect(batch.length).toBeLessThanOrEqual(2);
    rows.push(...batch);
  }
  expect(rows.map((row) => row.id)).toEqual([
    created[1]!.id,
    created[3]!.id,
    created[5]!.id,
    created[7]!.id,
  ]);
  expect((await chatDataService.findLatestMessageByAuthor(chat, own))?.id).toBe(created[3]!.id);
  expect(
    (await chatDataService.listMessagesInSecond(chat, '2026-01-04T00:00:00.999Z')).map(
      (row) => row.id,
    ),
  ).toEqual([created[3]!.id]);
  expect(await chatDataService.listMessagesInSecond(chat, 'invalid')).toEqual([]);
  const unseen = [];
  for await (const batch of chatDataService.messageBatches(chat, 2, created[3]!.created_at))
    unseen.push(...batch);
  expect(unseen.map((row) => row.id)).toEqual(created.slice(4).map((row) => row!.id));
  await chatDataService.updateMessageMeta(created[3]!.id, { reactions: [] });
  const afterRemoval = [];
  for await (const batch of chatDataService.reactionMessageBatches(chat))
    afterRemoval.push(...batch);
  expect(afterRemoval).toHaveLength(3);
});

it('commits message and chat summary together without regressing newer previews or a read cursor', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const chat = 'a'.repeat(64),
    own = 'b'.repeat(64);
  const time = '2026-10-01T00:00:00.000Z';
  await chatDataService.createChat({
    public_key: chat,
    name: 'Atomic',
    last_message_at: '2026-01-01T00:00:00.000Z',
    meta: { muted: true },
  });
  const input = {
    chat_public_key: chat,
    author_public_key: own,
    message: 'Newest',
    event_id: 'c'.repeat(64),
    created_at: time,
    chat_activity: { incomingAt: time, unreadCount: 1, preview: { text: 'Newest', at: time } },
  };
  await chatDataService.createMessage(input);
  expect(await chatDataService.getChatByPublicKey(chat)).toMatchObject({
    last_message: 'Newest',
    unread_count: 1,
    meta: { muted: true, last_incoming_message_at: time },
  });
  await chatDataService.createMessage({
    ...input,
    chat_activity: { ...input.chat_activity, unreadCount: 2 },
  });
  expect((await chatDataService.getChatByPublicKey(chat))?.unread_count).toBe(1);
  await chatDataService.updateChatMeta(chat, {
    muted: true,
    last_seen_received_activity_at: time,
    last_incoming_message_at: time,
  });
  await chatDataService.markChatAsRead(chat);
  await chatDataService.createMessage({
    ...input,
    event_id: 'd'.repeat(64),
    message: 'Earlier',
    created_at: '2026-09-01T00:00:00.000Z',
    chat_activity: {
      incomingAt: '2026-09-01T00:00:00.000Z',
      unreadCount: 2,
      preview: { text: 'Earlier', at: '2026-09-01T00:00:00.000Z' },
    },
  });
  expect(await chatDataService.getChatByPublicKey(chat)).toMatchObject({
    last_message: 'Newest',
    unread_count: 0,
    meta: { last_incoming_message_at: time },
  });
  const addOriginal = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(function (...args) {
    const r = addOriginal.apply(this, args);
    this.transaction.abort();
    return r;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(
    await chatDataService.createMessage({
      ...input,
      event_id: 'e'.repeat(64),
      chat_activity: { ...input.chat_activity, preview: { text: 'Must roll back', at: time } },
    }),
  ).toBeNull();
  expect((await chatDataService.getChatByPublicKey(chat))?.last_message).toBe('Newest');
});

it('commits the preview author with the message, without replacing it with older history', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = 'a'.repeat(64),
    author = 'b'.repeat(64),
    other = 'c'.repeat(64);
  const latest = '2026-10-06T10:00:00.000Z';
  await chatDataService.createChat({
    public_key: group,
    name: 'Group',
    type: 'group',
    last_message: '',
    last_message_at: '2020-01-01T00:00:00.000Z',
    unread_count: 0,
    meta: {},
  });
  await chatDataService.createMessage({
    chat_public_key: group,
    author_public_key: author,
    message: 'Newest',
    created_at: latest,
    event_id: 'd'.repeat(64),
    meta: {},
    chat_activity: { incomingAt: latest, unreadCount: 1, preview: { text: 'Newest', at: latest } },
  });
  await chatDataService.createMessage({
    chat_public_key: group,
    author_public_key: other,
    message: 'Older',
    created_at: '2025-01-01T00:00:00.000Z',
    event_id: 'e'.repeat(64),
    meta: {},
    chat_activity: {
      incomingAt: '2025-01-01T00:00:00.000Z',
      unreadCount: 1,
      preview: { text: 'Older', at: '2025-01-01T00:00:00.000Z' },
    },
  });
  const chat = await chatDataService.getChatByPublicKey(group);
  expect(chat?.last_message).toBe('Newest');
  expect(chat?.meta.last_message_author_public_key).toBe(author);
});
