import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { contactsService } from '#src/services/contactsService.ts';
import { clearPublicProfiles, getPublicProfile } from '#src/lib/state/publicProfiles.ts';
afterEach(async () => {
  await contactsService.clearAllData();
  vi.unstubAllGlobals();
});
it('restores historical authors without creating contacts, and preserves newer snapshots across competing writes', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const publicKey = 'b'.repeat(64);
  await Promise.all([
    contactsService.savePublicProfile(publicKey, {
      name: 'New',
      picture: 'https://images.test/new',
      createdAt: 20,
      eventId: 'a',
    }),
    contactsService.savePublicProfile(publicKey, {
      name: 'Old',
      picture: '',
      createdAt: 10,
      eventId: 'b',
    }),
  ]);
  clearPublicProfiles();
  await contactsService.restorePublicProfiles([publicKey]);
  expect(getPublicProfile(publicKey)).toMatchObject({
    name: 'New',
    picture: 'https://images.test/new',
  });
  expect(await contactsService.listContacts()).toEqual([]);
  await contactsService.clearAllData();
  expect(getPublicProfile(publicKey)).toBeUndefined();
});

it('preserves ownership restored after a profile snapshot was read, while applying real field removals', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = await contactsService.createContact({
    public_key: 'c'.repeat(64),
    type: 'group',
    name: 'Group',
    meta: { name: 'Group', about: 'Old description' },
  });
  const profileSnapshot = group!.meta;
  await contactsService.updateContact(group!.id, {
    metaBase: group!.meta,
    meta: {
      ...group!.meta,
      owner_public_key: 'a'.repeat(64),
      group_private_key_encrypted: 'encrypted-master-fixture',
      group_members: [{ public_key: 'b'.repeat(64), name: 'Member' }],
    },
  });
  const updated = await contactsService.updateContact(group!.id, {
    metaBase: profileSnapshot,
    meta: { name: 'Refreshed profile' },
  });
  expect(updated!.meta).toMatchObject({
    name: 'Refreshed profile',
    owner_public_key: 'a'.repeat(64),
    group_private_key_encrypted: 'encrypted-master-fixture',
    group_members: [{ public_key: 'b'.repeat(64), name: 'Member' }],
  });
  expect(updated!.meta.about).toBeUndefined();
});

it('does not roll back private fields copied unchanged from a stale snapshot', async () => {
  vi.stubGlobal('window', { indexedDB: new IDBFactory() });
  const group = await contactsService.createContact({
    public_key: 'd'.repeat(64),
    type: 'group',
    name: 'Group',
    meta: { group_private_key_encrypted: 'older-backup', muted: false },
  });
  await contactsService.updateContact(group!.id, {
    meta: { group_private_key_encrypted: 'newer-backup', muted: true },
  });
  const updated = await contactsService.updateContact(group!.id, {
    metaBase: group!.meta,
    meta: { ...group!.meta, dm_receive_relay_event_created_at: 20 },
  });
  expect(updated!.meta).toMatchObject({
    group_private_key_encrypted: 'newer-backup',
    muted: true,
    dm_receive_relay_event_created_at: 20,
  });
});
