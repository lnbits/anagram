import NostrClient, { ClientEvent } from '#src/lib/nostr/client.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactRecord, CreateContactInput, UpdateContactInput } from '#src/types/contact.ts';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
  markChatAsRead: vi.fn(async () => {}),
  updateChatMeta: vi.fn(async () => {}),
}));

const contactsServiceMock = vi.hoisted(() => ({
  createContact: vi.fn(async (_input: CreateContactInput): Promise<ContactRecord | null> => null),
  init: vi.fn(async () => {}),
  listContacts: vi.fn(async (): Promise<ContactRecord[]> => []),
  updateContact: vi.fn(
    async (_id: number, _input: UpdateContactInput): Promise<ContactRecord | null> => null,
  ),
}));

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: contactsServiceMock,
}));

import { MUTE_LIST_KIND } from '#src/stores/nostr/constants.ts';
import { createMuteListRuntime } from '#src/stores/nostr/muteListRuntime.ts';

const LOGGED_IN_PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);

function createContact(publicKey: string, meta: Record<string, unknown> = {}): ContactRecord {
  return {
    id: Number.parseInt(publicKey[0] ?? '1', 16),
    public_key: publicKey,
    type: 'user',
    name: publicKey.slice(0, 16),
    given_name: null,
    meta,
    relays: [],
    sendMessagesToAppRelays: false,
  };
}

function createChat(publicKey: string, meta: Record<string, unknown> = {}) {
  return {
    id: publicKey,
    public_key: publicKey,
    type: 'user',
    name: publicKey.slice(0, 16),
    last_message: '',
    last_message_at: null,
    unread_count: 0,
    meta,
  };
}

function createRuntime(overrides: Partial<Parameters<typeof createMuteListRuntime>[0]> = {}) {
  const ndk = new NostrClient();
  Object.defineProperty(ndk, 'subscribe', {
    configurable: true,
    value: undefined,
  });
  const deps = {
    beginStartupStep: vi.fn(),
    buildMuteListTags: vi.fn((mutedPubkeys: string[], blockedPubkeys: string[]) => [
      ...mutedPubkeys.map((pubkey) => ['p', pubkey]),
      ...blockedPubkeys.map((pubkey) => ['bp', pubkey]),
    ]),
    bumpContactListVersion: vi.fn(),
    chatStore: { reload: vi.fn(async () => {}) },
    completeStartupStep: vi.fn(),
    decryptMuteListContent: vi.fn(async () => ({ blockedPubkeys: [], mutedPubkeys: [] })),
    encryptMuteListTags: vi.fn(async () => 'encrypted-mute-list'),
    ensureRelayConnections: vi.fn(async () => {}),
    failStartupStep: vi.fn(),
    getLoggedInPublicKeyHex: vi.fn(() => LOGGED_IN_PUBKEY),
    getLoggedInSignerUser: vi.fn(async () => ({ pubkey: LOGGED_IN_PUBKEY }) as never),
    ndk,
    resolveLoggedInPublishRelayUrls: vi.fn(async () => ['wss://relay.example/']),
    resolveLoggedInReadRelayUrls: vi.fn(async () => ['wss://relay.example/']),
    updateStartupInternalTask: vi.fn(),
    updateStoredEventSinceFromCreatedAt: vi.fn(),
    ...overrides,
  };

  return {
    deps,
    ndk,
    runtime: createMuteListRuntime(deps),
  };
}

describe('mute list runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatDataServiceMock.init.mockResolvedValue(undefined);
    chatDataServiceMock.listChats.mockResolvedValue([]);
    chatDataServiceMock.markChatAsRead.mockResolvedValue(undefined);
    chatDataServiceMock.updateChatMeta.mockResolvedValue(undefined);
    let contacts: ContactRecord[] = [];
    contactsServiceMock.createContact.mockImplementation(async (input) => {
      const contact = createContact(input.public_key, input.meta);
      contacts.push(contact);
      return contact;
    });
    contactsServiceMock.init.mockResolvedValue(undefined);
    contactsServiceMock.listContacts.mockImplementation(async () => contacts);
    contactsServiceMock.updateContact.mockImplementation(async (id, input) => {
      contacts = contacts.map((contact) =>
        contact.id === id ? { ...contact, meta: input.meta ?? contact.meta } : contact,
      );
      return contacts.find((contact) => contact.id === id) ?? null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores encrypted NIP-51 pubkey mutes into contact and chat metadata', async () => {
    const { deps, ndk, runtime } = createRuntime({
      decryptMuteListContent: vi.fn(async () => ({
        mutedPubkeys: [LOGGED_IN_PUBKEY, PUBKEY_B, PUBKEY_B, 'not-a-pubkey'],
        blockedPubkeys: [PUBKEY_D, PUBKEY_D],
      })),
    });
    const muteListEvent = new ClientEvent(ndk, {
      kind: MUTE_LIST_KIND,
      pubkey: LOGGED_IN_PUBKEY,
      created_at: 1_700_000_000,
      content: 'encrypted-content',
      tags: [],
    });
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(muteListEvent);
    contactsServiceMock.listContacts.mockResolvedValue([
      createContact(PUBKEY_B),
      createContact(PUBKEY_C, { muted: true, name: 'Carol' }),
    ]);
    chatDataServiceMock.listChats.mockResolvedValue([
      createChat(PUBKEY_B, { inbox_state: 'accepted' }),
      createChat(PUBKEY_C, { muted: true, inbox_state: 'accepted' }),
      createChat(PUBKEY_D, { inbox_state: 'accepted' }),
    ]);
    contactsServiceMock.createContact.mockImplementation(async (input) =>
      createContact(input.public_key, input.meta),
    );

    await runtime.restoreMuteList();

    expect(ndk.fetchEvent).toHaveBeenCalledWith(
      {
        kinds: [MUTE_LIST_KIND],
        authors: [LOGGED_IN_PUBKEY],
      },
      expect.anything(),
      expect.anything(),
    );
    expect(deps.decryptMuteListContent).toHaveBeenCalledWith('encrypted-content');
    expect(deps.updateStartupInternalTask).toHaveBeenCalledWith(
      'contact-cursor-state',
      'mute-list',
      { eventCount: 2 },
    );
    expect(contactsServiceMock.updateContact).toHaveBeenCalledWith(
      Number.parseInt(PUBKEY_B[0] ?? '0', 16),
      { metaBase: {}, meta: { muted: true } },
    );
    expect(contactsServiceMock.updateContact).toHaveBeenCalledWith(
      Number.parseInt(PUBKEY_C[0] ?? '0', 16),
      { metaBase: { name: 'Carol', muted: true }, meta: { name: 'Carol' } },
    );
    expect(contactsServiceMock.createContact).toHaveBeenCalledWith({
      public_key: PUBKEY_D,
      type: 'user',
      name: PUBKEY_D.slice(0, 16),
      meta: expect.objectContaining({
        blocked: true,
        blocked_at: expect.any(String),
      }),
    });
    expect(chatDataServiceMock.updateChatMeta).toHaveBeenCalledWith(PUBKEY_B, {
      inbox_state: 'accepted',
      muted: true,
    });
    expect(chatDataServiceMock.updateChatMeta).toHaveBeenCalledWith(PUBKEY_C, {
      inbox_state: 'accepted',
    });
    expect(chatDataServiceMock.updateChatMeta).toHaveBeenCalledWith(
      PUBKEY_D,
      expect.objectContaining({
        inbox_state: 'blocked',
        blocked_at: expect.any(String),
      }),
    );
    expect(chatDataServiceMock.markChatAsRead).not.toHaveBeenCalled();
    expect(deps.bumpContactListVersion).toHaveBeenCalledTimes(1);
    expect(deps.chatStore.reload).toHaveBeenCalledTimes(1);
    expect(deps.completeStartupStep).toHaveBeenCalledWith('mute-list');
  });

  it('publishes only encrypted private p tags for mute and unmute actions', async () => {
    const publishedEvents: ClientEvent[] = [];
    const { deps, ndk, runtime } = createRuntime();
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(null);
    vi.spyOn(ClientEvent.prototype, 'publishReplaceable').mockImplementation(function publish() {
      publishedEvents.push(this);
      return Promise.resolve(undefined as never);
    });

    await runtime.setPubkeyMuted(PUBKEY_B, true);
    await runtime.setPubkeyBlocked(PUBKEY_C, true);
    await runtime.setPubkeyMuted(PUBKEY_C, true);
    await runtime.setPubkeyMuted(PUBKEY_B, false);

    expect(deps.buildMuteListTags).toHaveBeenNthCalledWith(1, [PUBKEY_B], []);
    expect(deps.buildMuteListTags).toHaveBeenNthCalledWith(2, [PUBKEY_B], [PUBKEY_C]);
    expect(deps.buildMuteListTags).toHaveBeenNthCalledWith(3, [], [PUBKEY_C]);
    expect(deps.encryptMuteListTags).toHaveBeenNthCalledWith(1, [['p', PUBKEY_B]]);
    expect(deps.encryptMuteListTags).toHaveBeenNthCalledWith(2, [
      ['p', PUBKEY_B],
      ['bp', PUBKEY_C],
    ]);
    expect(publishedEvents).toHaveLength(3);
    expect(publishedEvents[0]).toMatchObject({
      kind: MUTE_LIST_KIND,
      pubkey: LOGGED_IN_PUBKEY,
      content: 'encrypted-mute-list',
      tags: [],
    });
    expect(runtime.isPubkeyMuted(PUBKEY_B)).toBe(false);
    expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(false);
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(true);
  });

  it('does not undo a local block when a startup retry returns an older snapshot', async () => {
    const { ndk, runtime } = createRuntime();
    const snapshot = new ClientEvent(ndk, {
      kind: MUTE_LIST_KIND,
      pubkey: LOGGED_IN_PUBKEY,
      created_at: 1_700_000_000,
      content: 'older-empty-list',
      tags: [],
    });
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(snapshot);
    vi.spyOn(ClientEvent.prototype, 'publishReplaceable').mockResolvedValue(undefined as never);
    await runtime.restoreMuteList();
    await runtime.setPubkeyBlocked(PUBKEY_C, true);
    await runtime.restoreMuteList();
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(true);
  });

  it.each([true, false])(
    'saves muted=%s locally when relay reads fail and syncs it after restart',
    async (muted) => {
      const { deps, ndk, runtime } = createRuntime({
        decryptMuteListContent: vi.fn(async () => ({
          mutedPubkeys: [PUBKEY_B, ...(!muted ? [PUBKEY_C] : [])],
          blockedPubkeys: [PUBKEY_D],
        })),
      });
      await contactsServiceMock.createContact({
        public_key: PUBKEY_C,
        name: 'Carol',
        meta: muted ? {} : { muted: true },
      });
      const fetch = vi.spyOn(ndk, 'fetchEvent').mockRejectedValue(new Error('Relay unavailable'));
      const publish = vi
        .spyOn(ClientEvent.prototype, 'publishReplaceable')
        .mockResolvedValue(undefined as never);

      await expect(runtime.setPubkeyMuted(PUBKEY_C, muted)).rejects.toThrow();
      expect(
        (await contactsServiceMock.listContacts()).find(
          (contact) => contact.public_key === PUBKEY_C,
        )?.meta.muted === true,
      ).toBe(muted);
      expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(muted);
      expect(publish).not.toHaveBeenCalled();

      runtime.resetMuteListRuntimeState();
      fetch.mockResolvedValue(
        new ClientEvent(ndk, {
          kind: MUTE_LIST_KIND,
          pubkey: LOGGED_IN_PUBKEY,
          created_at: 1_700_000_000,
          content: 'remote-list',
          tags: [],
        }),
      );
      await runtime.restoreMuteList();
      expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(muted);
      expect(runtime.isPubkeyMuted(PUBKEY_B)).toBe(true);
      expect(runtime.isPubkeyBlocked(PUBKEY_D)).toBe(true);
      expect(deps.buildMuteListTags).toHaveBeenLastCalledWith(
        [PUBKEY_B, ...(muted ? [PUBKEY_C] : [])],
        [PUBKEY_D],
      );
    },
  );

  it('retries a failed mute publication when the requested local state is unchanged', async () => {
    const { ndk, runtime } = createRuntime();
    await contactsServiceMock.createContact({ public_key: PUBKEY_C, name: 'Carol' });
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(null);
    const publish = vi
      .spyOn(ClientEvent.prototype, 'publishReplaceable')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(undefined as never);
    await expect(runtime.setPubkeyMuted(PUBKEY_C, true)).rejects.toThrow('Offline');
    await runtime.setPubkeyMuted(PUBKEY_C, true);
    expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('saves a block locally when the initial relay read fails, then merges it on retry', async () => {
    const { deps, ndk, runtime } = createRuntime({
      decryptMuteListContent: vi.fn(async () => ({ mutedPubkeys: [PUBKEY_B], blockedPubkeys: [] })),
    });
    let contacts = [createContact(PUBKEY_C), createContact(PUBKEY_D, { blocked: true })];
    contactsServiceMock.listContacts.mockImplementation(async () => contacts as never);
    contactsServiceMock.updateContact.mockImplementation(async (id, input) => {
      contacts = contacts.map((contact) =>
        contact.id === id ? { ...contact, meta: input.meta ?? contact.meta } : contact,
      );
      return contacts.find((contact) => contact.id === id) as never;
    });
    const fetch = vi.spyOn(ndk, 'fetchEvent').mockRejectedValue(new Error('Relay unavailable'));
    const publish = vi
      .spyOn(ClientEvent.prototype, 'publishReplaceable')
      .mockResolvedValue(undefined as never);

    await expect(runtime.setPubkeyBlocked(PUBKEY_C, true)).rejects.toThrow();
    expect(contacts.find((contact) => contact.public_key === PUBKEY_C)?.meta.blocked).toBe(true);
    expect(contacts.find((contact) => contact.public_key === PUBKEY_D)?.meta.blocked).toBe(true);
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(true);
    expect(deps.bumpContactListVersion).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(contacts.find((contact) => contact.public_key === PUBKEY_C)?.meta.pending_block).toBe(
      true,
    );

    runtime.resetMuteListRuntimeState();
    fetch.mockResolvedValue(
      new ClientEvent(ndk, {
        kind: MUTE_LIST_KIND,
        pubkey: LOGGED_IN_PUBKEY,
        created_at: 1_700_000_000,
        content: 'remote-list',
        tags: [],
      }),
    );
    await runtime.restoreMuteList();
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(true);
    expect(runtime.isPubkeyMuted(PUBKEY_B)).toBe(true);
    expect(deps.buildMuteListTags).toHaveBeenLastCalledWith([PUBKEY_B], [PUBKEY_C]);
    expect(
      contacts.find((contact) => contact.public_key === PUBKEY_C)?.meta.pending_block,
    ).toBeUndefined();
  });

  it('keeps an offline unblock through restart and removes it from the restored remote list', async () => {
    const { deps, ndk, runtime } = createRuntime({
      decryptMuteListContent: vi.fn(async () => ({ mutedPubkeys: [], blockedPubkeys: [PUBKEY_C] })),
    });
    await contactsServiceMock.createContact({
      public_key: PUBKEY_C,
      name: 'Carol',
      meta: { blocked: true },
    });
    const fetch = vi.spyOn(ndk, 'fetchEvent').mockRejectedValue(new Error('Relay unavailable'));
    const publish = vi
      .spyOn(ClientEvent.prototype, 'publishReplaceable')
      .mockResolvedValue(undefined as never);
    await expect(runtime.setPubkeyBlocked(PUBKEY_C, false)).rejects.toThrow();
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(false);
    expect((await contactsServiceMock.listContacts())[0]?.meta).toEqual({ pending_block: false });
    expect(publish).not.toHaveBeenCalled();

    runtime.resetMuteListRuntimeState();
    fetch.mockResolvedValue(
      new ClientEvent(ndk, {
        kind: MUTE_LIST_KIND,
        pubkey: LOGGED_IN_PUBKEY,
        created_at: 1_700_000_000,
        content: 'old-block',
        tags: [],
      }),
    );
    await runtime.restoreMuteList();
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(false);
    expect(deps.buildMuteListTags).toHaveBeenLastCalledWith([], []);
    expect((await contactsServiceMock.listContacts())[0]?.meta.pending_block).toBeUndefined();
  });

  it('does not apply queued blocks or mutes to a new session', async () => {
    const { deps, ndk, runtime } = createRuntime();
    const fetch = vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(null);
    const block = runtime.setPubkeyBlocked(PUBKEY_C, true);
    const mute = runtime.setPubkeyMuted(PUBKEY_B, true);
    runtime.resetMuteListRuntimeState();
    deps.getLoggedInPublicKeyHex.mockReturnValue(PUBKEY_D);
    await Promise.all([block, mute]);
    expect(contactsServiceMock.updateContact).not.toHaveBeenCalled();
    expect(contactsServiceMock.createContact).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['block', 'mute'] as const)(
    'applies %s locally before an in-flight startup read finishes',
    async (action) => {
      const { ndk, runtime } = createRuntime();
      await contactsServiceMock.createContact({ public_key: PUBKEY_C, name: 'Carol' });
      let finishRead!: (event: null) => void;
      const fetch = vi
        .spyOn(ndk, 'fetchEvent')
        .mockResolvedValue(null)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
        );
      vi.spyOn(ClientEvent.prototype, 'publishReplaceable').mockResolvedValue(undefined as never);
      const startup = runtime.restoreMuteList();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      const change =
        action === 'block'
          ? runtime.setPubkeyBlocked(PUBKEY_C, true)
          : runtime.setPubkeyMuted(PUBKEY_C, true);
      const metaKey = action === 'block' ? 'blocked' : 'muted';
      const pendingKey = action === 'block' ? 'pending_block' : 'pending_mute';
      const enabled = () =>
        action === 'block' ? runtime.isPubkeyBlocked(PUBKEY_C) : runtime.isPubkeyMuted(PUBKEY_C);
      try {
        await vi.waitFor(() => expect(enabled()).toBe(true));
        expect((await contactsServiceMock.listContacts())[0]?.meta[metaKey]).toBe(true);
      } finally {
        finishRead(null);
        await Promise.all([startup, change]);
      }
      expect(enabled()).toBe(true);
      expect((await contactsServiceMock.listContacts())[0]?.meta[pendingKey]).toBeUndefined();
    },
  );

  it('keeps blocking authoritative when mute is attempted during a failed sync', async () => {
    const { deps, ndk, runtime } = createRuntime();
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(null);
    const publish = vi
      .spyOn(ClientEvent.prototype, 'publishReplaceable')
      .mockResolvedValue(undefined as never);
    await runtime.setPubkeyMuted(PUBKEY_C, true);
    publish.mockRejectedValueOnce(new Error('Offline'));
    await expect(runtime.setPubkeyBlocked(PUBKEY_C, true)).rejects.toThrow('Offline');
    await runtime.setPubkeyMuted(PUBKEY_C, true);
    expect(runtime.isPubkeyBlocked(PUBKEY_C)).toBe(true);
    expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    await runtime.setPubkeyBlocked(PUBKEY_C, false);
    expect(runtime.isPubkeyMuted(PUBKEY_C)).toBe(false);
    expect(deps.buildMuteListTags).toHaveBeenLastCalledWith([], []);
  });

  it('orders rapid block changes after the restored event and retries failed publication', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { ndk, runtime } = createRuntime();
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(
      new ClientEvent(ndk, {
        kind: MUTE_LIST_KIND,
        pubkey: LOGGED_IN_PUBKEY,
        created_at: 1_800_000_000,
        content: 'empty-list',
        tags: [],
      }),
    );
    const published: number[] = [];
    const publish = vi
      .spyOn(ClientEvent.prototype, 'publishReplaceable')
      .mockImplementation(function () {
        published.push(this.created_at!);
        return Promise.resolve(undefined as never);
      });
    await runtime.setPubkeyBlocked(PUBKEY_B, true);
    await runtime.setPubkeyBlocked(PUBKEY_C, true);
    expect(published).toEqual([1_800_000_001, 1_800_000_002]);
    publish.mockRejectedValueOnce(new Error('Offline'));
    await expect(runtime.setPubkeyBlocked(PUBKEY_D, true)).rejects.toThrow('Offline');
    expect(runtime.isPubkeyBlocked(PUBKEY_D)).toBe(true);
    await runtime.setPubkeyBlocked(PUBKEY_D, true);
    expect(publish).toHaveBeenCalledTimes(4);
  });
});
