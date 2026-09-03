import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
  markChatAsRead: vi.fn(async () => {}),
  updateChatMeta: vi.fn(async () => {}),
}));

const contactsServiceMock = vi.hoisted(() => ({
  createContact: vi.fn(
    async (_input: { public_key: string; meta?: Record<string, unknown> }) => null
  ),
  init: vi.fn(async () => {}),
  listContacts: vi.fn(async () => []),
  updateContact: vi.fn(async () => null),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: contactsServiceMock,
}));

import { MUTE_LIST_KIND } from 'src/stores/nostr/constants';
import { createMuteListRuntime } from 'src/stores/nostr/muteListRuntime';

const LOGGED_IN_PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);

function createContact(publicKey: string, meta: Record<string, unknown> = {}) {
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
  const ndk = new NDK();
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
    contactsServiceMock.createContact.mockResolvedValue(null);
    contactsServiceMock.init.mockResolvedValue(undefined);
    contactsServiceMock.listContacts.mockResolvedValue([]);
    contactsServiceMock.updateContact.mockResolvedValue(null);
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
    const muteListEvent = new NDKEvent(ndk, {
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
      createContact(input.public_key, input.meta)
    );

    await runtime.restoreMuteList();

    expect(ndk.fetchEvent).toHaveBeenCalledWith(
      {
        kinds: [MUTE_LIST_KIND],
        authors: [LOGGED_IN_PUBKEY],
      },
      expect.anything(),
      expect.anything()
    );
    expect(deps.decryptMuteListContent).toHaveBeenCalledWith('encrypted-content');
    expect(deps.updateStartupInternalTask).toHaveBeenCalledWith(
      'contact-cursor-state',
      'mute-list',
      { eventCount: 2 }
    );
    expect(contactsServiceMock.updateContact).toHaveBeenCalledWith(
      Number.parseInt(PUBKEY_B[0] ?? '0', 16),
      { meta: { muted: true } }
    );
    expect(contactsServiceMock.updateContact).toHaveBeenCalledWith(
      Number.parseInt(PUBKEY_C[0] ?? '0', 16),
      { meta: { name: 'Carol' } }
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
      })
    );
    expect(chatDataServiceMock.markChatAsRead).not.toHaveBeenCalled();
    expect(deps.bumpContactListVersion).toHaveBeenCalledTimes(1);
    expect(deps.chatStore.reload).toHaveBeenCalledTimes(1);
    expect(deps.completeStartupStep).toHaveBeenCalledWith('mute-list');
  });

  it('publishes only encrypted private p tags for mute and unmute actions', async () => {
    const publishedEvents: NDKEvent[] = [];
    const { deps, ndk, runtime } = createRuntime();
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(null);
    vi.spyOn(NDKEvent.prototype, 'publishReplaceable').mockImplementation(function publish() {
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
});
