import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { chatDataService } from '#src/services/chatDataService.ts';

afterEach(async () => {
  await chatDataService.clearAllData();
  vi.unstubAllGlobals();
});

it('profile and older-ticket writes cannot erase recovered epochs or roll back the writable key', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = 'a'.repeat(64);
  const entry = (epoch: number) => ({
    epoch_number: epoch,
    epoch_public_key: epoch.toString(16).padStart(64, '0'),
    epoch_private_key_encrypted: `encrypted-${epoch}`,
    invitation_created_at: '2026-01-02T00:00:00.000Z',
  });
  await chatDataService.createChat({ public_key: group, type: 'group', name: 'Group' });
  const beforeTicket = (await chatDataService.getChatByPublicKey(group))!.meta;
  await chatDataService.updateChat(group, { meta: { group_epoch_keys: [entry(21)] } });
  // Profile hydration started before the ticket, finishes afterwards.
  await chatDataService.updateChat(group, {
    name: 'Restored name',
    meta: { ...beforeTicket, picture: 'https://example.test/picture' },
  });
  // Two restores took the same snapshot, and complete in reverse epoch order.
  await Promise.all(
    [20, 19].map((epoch) =>
      chatDataService.updateChatMeta(group, {
        group_epoch_keys: [entry(epoch)],
        current_epoch_public_key: entry(epoch).epoch_public_key,
      }),
    ),
  );
  const restored = (await chatDataService.getChatByPublicKey(group))!;
  expect(restored.meta.group_epoch_keys).toEqual([entry(21), entry(20), entry(19)]);
  expect(restored.meta.current_epoch_public_key).toBe(entry(21).epoch_public_key);
  expect(restored.meta.current_epoch_private_key_encrypted).toBe(
    entry(21).epoch_private_key_encrypted,
  );
  // Older copies of a reissued ticket cannot move its timestamp backwards.
  await chatDataService.updateChatMeta(group, {
    ...restored.meta,
    group_epoch_keys: [{ ...entry(21), invitation_created_at: '2026-01-01T00:00:00.000Z' }],
  });
  expect((await chatDataService.getChatByPublicKey(group))!.meta.group_epoch_keys).toEqual([
    entry(21),
    entry(20),
    entry(19),
  ]);
});

it('keeps epoch tickets when owner/profile restoration creates the same group concurrently', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = 'f'.repeat(64);
  const ticket = {
    epoch_number: 4,
    epoch_public_key: 'd'.repeat(64),
    epoch_private_key_encrypted: 'encrypted epoch',
  };
  await Promise.all([
    chatDataService.createChat({
      public_key: group,
      type: 'group',
      name: 'Owner backup',
      meta: { inbox_state: 'accepted' },
    }),
    chatDataService.createChat({
      public_key: group,
      type: 'group',
      name: 'Epoch ticket',
      meta: { group_epoch_keys: [ticket] },
    }),
  ]);
  const restored = (await chatDataService.getChatByPublicKey(group))!;
  expect(restored.meta.group_epoch_keys).toEqual([ticket]);
  expect(restored.meta.current_epoch_public_key).toBe(ticket.epoch_public_key);
  expect(restored.name).toBe('Owner backup');
  expect(restored.meta.inbox_state).toBe('accepted');
});

it('retains fork keys for history, blocks the disputed epoch, and clears the conflict only with a higher epoch', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = '1'.repeat(64);
  const key = (epoch_number: number, epoch_public_key: string) => ({
    epoch_number,
    epoch_public_key,
    epoch_private_key_encrypted: `encrypted-${epoch_public_key}`,
  });
  const a = key(1, 'a'.repeat(64)),
    b = key(1, 'b'.repeat(64)),
    merged = key(2, 'c'.repeat(64));
  await chatDataService.createChat({
    public_key: group,
    type: 'group',
    name: 'Fork',
    meta: { group_epoch_keys: [a] },
  });
  await chatDataService.updateChatMeta(group, { group_epoch_keys: [b] });
  let chat = (await chatDataService.getChatByPublicKey(group))!;
  expect(chat.meta.group_epoch_keys).toEqual([a, b]);
  expect(chat.meta.group_conflicting_epoch).toBe(1);
  await chatDataService.updateChatMeta(group, { group_epoch_keys: [merged] });
  await chatDataService.updateChatMeta(group, {
    group_conflicting_epoch: 1,
    group_epoch_keys: [a],
  });
  chat = (await chatDataService.getChatByPublicKey(group))!;
  expect(chat.meta.group_epoch_keys).toEqual([merged, a, b]);
  expect(chat.meta.group_conflicting_epoch).toBe(-1);
  expect(chat.meta.current_epoch_public_key).toBe(merged.epoch_public_key);
});

it('deleted groups resist replayed backups, stale profile writes and late messages until explicitly reopened', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const group = 'd'.repeat(64);
  const ticket = {
    epoch_number: 0,
    epoch_public_key: 'e'.repeat(64),
    epoch_private_key_encrypted: 'encrypted epoch',
  };
  await chatDataService.createChat({
    public_key: group,
    type: 'group',
    name: 'Deleted group',
    meta: { inbox_state: 'accepted', group_epoch_keys: [ticket] },
  });
  const stale = (await chatDataService.getChatByPublicKey(group))!;
  const message = {
    chat_public_key: group,
    author_public_key: 'a'.repeat(64),
    message: 'Earlier history',
    created_at: '2026-10-07T12:00:00.000Z',
    event_id: 'b'.repeat(64),
  };
  expect(await chatDataService.createMessage(message)).not.toBeNull();
  expect(await chatDataService.deleteChat(group)).toBe(true);
  expect(await chatDataService.listMessages(group)).toEqual([]);
  await Promise.all([
    chatDataService.createChat({ ...stale, meta: { ...stale.meta, group_epoch_keys: [ticket] } }),
    chatDataService.updateChat(group, { meta: stale.meta }),
    chatDataService.updateChatMeta(group, { inbox_state: 'accepted', group_epoch_keys: [ticket] }),
    chatDataService.updateChatPreview(group, 'Replay', message.created_at, 10),
  ]);
  const deleted = (await chatDataService.getChatByPublicKey(group))!;
  expect(deleted.meta.deleted_locally).toBe(true);
  expect(deleted.meta.group_epoch_keys).toEqual([ticket]);
  expect(deleted.last_message).toBe('');
  expect(deleted.unread_count).toBe(0);
  expect(await chatDataService.createMessage(message)).toBeNull();
  expect(await chatDataService.listMessages(group)).toEqual([]);

  await chatDataService.reopenDeletedGroupChat(group);
  // A stale snapshot from before the explicit reopen cannot hide it again.
  await chatDataService.updateChatMeta(group, deleted.meta);
  expect((await chatDataService.getChatByPublicKey(group))!.meta.deleted_locally).toBeUndefined();
  expect(await chatDataService.createMessage(message)).not.toBeNull();
});

it('keeps ordinary direct-chat deletion unchanged', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const key = 'c'.repeat(64);
  await chatDataService.createChat({ public_key: key, name: 'Direct chat' });
  expect(await chatDataService.deleteChat(key)).toBe(true);
  expect(await chatDataService.getChatByPublicKey(key)).toBeNull();
});
