import { afterEach, expect, it, vi } from 'vitest';
import { contactsService } from '#src/services/contactsService.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { createPrivateGroupPins } from '#src/stores/nostr/privateGroupPins.ts';
import { buildUpdatedContactMetaValue } from '#src/stores/nostr/valueUtils.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

const group = 'b'.repeat(64),
  owner = 'a'.repeat(64),
  id = 'c'.repeat(64);
afterEach(() => vi.restoreAllMocks());
function setup() {
  let account: string | null = owner;
  const contact = {
    id: 1,
    public_key: group,
    type: 'group' as const,
    name: 'Group',
    given_name: null,
    sendMessagesToAppRelays: false,
    meta: {
      name: 'Group',
      group: true,
      owner_public_key: owner,
      group_private_key_encrypted: 'SECRET-BACKUP',
      group_members: [{ public_key: 'd'.repeat(64), name: 'Member' }],
      pinned: id,
      pinned_created_at: 100,
    },
  };
  const row = {
    id: 1,
    event_id: id,
    chat_public_key: group,
    author_public_key: owner,
    message: 'Private note',
    created_at: new Date(100000).toISOString(),
    meta: {},
  };
  vi.spyOn(contactsService, 'getContactByPublicKey').mockImplementation(async () => contact);
  vi.spyOn(chatDataService, 'getMessageByEventIdOrEditReference').mockImplementation(
    async () => row,
  );
  const publish = vi.fn(async () => {}),
    refresh = vi.fn(async () => {});
  const pins = createPrivateGroupPins({ account: () => account, publish, refresh });
  return {
    pins,
    contact,
    row,
    publish,
    refresh,
    account: (next: string | null) => (account = next),
  };
}
it('publishes only the profile and a message reference, never group secrets, roster or private text', async () => {
  const { pins, publish, refresh } = setup();
  await pins.set(group, id);
  expect(publish).toHaveBeenCalledWith(group, {
    name: 'Group',
    group: true,
    pinned: id,
    pinned_created_at: 100,
  });
  expect(refresh).toHaveBeenCalledWith(group);
  await pins.set(group, null);
  expect(publish).toHaveBeenLastCalledWith(group, {
    name: 'Group',
    group: true,
    pinned: '',
    pinned_created_at: 0,
  });
});
it('rejects non-owners, foreign messages and deleted messages', async () => {
  const f = setup();
  f.account('e'.repeat(64));
  await expect(f.pins.set(group, id)).rejects.toThrow('Only a group owner');
  f.account(owner);
  f.row.chat_public_key = 'f'.repeat(64);
  await expect(f.pins.set(group, id)).rejects.toThrow('this group');
  expect((await f.pins.read(group))?.available).toBe(false);
  f.row.chat_public_key = group;
  f.row.meta = { deleted: {} };
  await expect(f.pins.set(group, id)).rejects.toThrow('this group');
  expect((await f.pins.read(group))?.text).toBe('Message deleted');
  expect((await f.pins.read(group))?.deleted).toBe(true);
  expect(f.publish).not.toHaveBeenCalled();
});
it('does not publish if the account changes while reading the target', async () => {
  const f = setup();
  vi.spyOn(chatDataService, 'getMessageByEventIdOrEditReference').mockImplementation(async () => {
    f.account(null);
    return f.row;
  });
  await expect(f.pins.set(group, id)).rejects.toThrow('Account changed');
  expect(f.publish).not.toHaveBeenCalled();
});
it('keeps failed publication from triggering a local pin refresh', async () => {
  const f = setup();
  f.publish.mockRejectedValueOnce(new Error('Relay rejected'));
  await expect(f.pins.set(group, id)).rejects.toThrow('Relay rejected');
  expect(f.refresh).not.toHaveBeenCalled();
});
it('stores valid pin hints and removes them when an authoritative profile clears the pin', () => {
  const previous = { pinned: id, pinned_created_at: 100, owner_public_key: owner };
  expect(inputSanitizerService.normalizeContactMetadata(previous)).toEqual(previous);
  expect(
    inputSanitizerService.normalizeContactMetadata({ pinned: 'invalid', pinned_created_at: 100 }),
  ).toEqual({});
  expect(buildUpdatedContactMetaValue(previous, null, null, null)).toEqual(previous);
  expect(buildUpdatedContactMetaValue(previous, { group: true }, null, null)).toEqual({
    owner_public_key: owner,
    group: true,
  });
});
