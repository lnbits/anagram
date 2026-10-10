import { expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ contacts: vi.fn(), chats: vi.fn() }));
vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: { init: async () => {}, listContacts: data.contacts },
}));
vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: { init: async () => {}, listChats: data.chats },
}));
import { resolvePrivateMessageRelayScopes } from '#src/stores/nostr/privateMessageRouting.ts';
import { resolveGroupReadRelayUrlsValue } from '#src/stores/nostr/valueUtils.ts';

it('reads group rosters on receive-only relays as well as their public outbox', () => {
  expect(
    resolveGroupReadRelayUrlsValue(
      [
        { url: 'wss://receive.test', read: true, write: false },
        { url: 'wss://outbox.test', read: false, write: true },
        { url: 'wss://disabled.test', read: false, write: false },
      ],
      ['wss://seed.test'],
    ),
  ).toEqual(['wss://receive.test/', 'wss://outbox.test/', 'wss://seed.test/']);
});

it('keeps all configured fallback relays for every recovered epoch, even after finding a group inbox', async () => {
  const group = 'a'.repeat(64),
    epoch = 'b'.repeat(64);
  data.chats.mockResolvedValue([
    {
      public_key: group,
      type: 'group',
      meta: {
        group_epoch_keys: [
          { epoch_number: 21, epoch_public_key: epoch, epoch_private_key_encrypted: 'encrypted' },
        ],
      },
    },
  ]);
  const fallback = ['wss://one.test/', 'wss://two.test/', 'wss://three.test/'];
  data.contacts.mockResolvedValue([]);
  expect((await resolvePrivateMessageRelayScopes([epoch], fallback))[0].relayUrls).toEqual(
    fallback,
  );
  data.contacts.mockResolvedValue([
    {
      public_key: group,
      relays: [{ url: 'wss://receive.test/', read: true, write: false }],
      meta: { general_relay_entries: [{ url: 'wss://outbox.test/', read: false, write: true }] },
    },
  ]);
  expect((await resolvePrivateMessageRelayScopes([epoch], fallback))[0].relayUrls).toEqual([
    'wss://receive.test/',
    'wss://outbox.test/',
    ...fallback,
  ]);
});

it('does not send personal inbox queries to a group-only relay', async () => {
  const owner = 'c'.repeat(64),
    group = 'a'.repeat(64),
    epoch = 'b'.repeat(64);
  data.chats.mockResolvedValue([
    {
      public_key: group,
      type: 'group',
      meta: {
        group_epoch_keys: [
          { epoch_number: 0, epoch_public_key: epoch, epoch_private_key_encrypted: 'encrypted' },
        ],
      },
    },
  ]);
  data.contacts.mockResolvedValue([
    {
      public_key: group,
      relays: [{ url: 'wss://group.test/', read: true, write: true }],
      meta: {},
    },
  ]);
  const routes = await resolvePrivateMessageRelayScopes([owner, epoch], ['wss://own.test/']);
  expect(routes.find((route) => route.publicKey === owner)?.relayUrls).toEqual(['wss://own.test/']);
  expect(routes.find((route) => route.publicKey === epoch)?.relayUrls).toEqual([
    'wss://group.test/',
    'wss://own.test/',
  ]);
});
