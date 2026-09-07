import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBKEY_HEX = 'a'.repeat(64);

const moduleMocks = vi.hoisted(() => {
  const nostrStore = {
    encodeNpub: vi.fn((value: string) => `npub-${value}`),
    getDeveloperDiagnosticsSnapshot: vi.fn().mockResolvedValue({
      privateMessagesSubscription: {
        since: 1,
        liveCoverageAt: 2,
      },
    }),
    getLoggedInPublicKeyHex: vi.fn(() => 'a'.repeat(64)),
    logout: vi.fn().mockResolvedValue(undefined),
    privateMessagesSubscriptionLastEoseAt: null as string | null,
    publishMyRelayList: vi.fn().mockResolvedValue(undefined),
    restoreGroupEpochHistory: vi.fn().mockResolvedValue(undefined),
    restorePrivateMessagesForRecipient: vi.fn().mockResolvedValue(undefined),
    restoreStartupState: vi.fn().mockResolvedValue(undefined),
    rotateGroupEpochAndSendTickets: vi.fn().mockResolvedValue(undefined),
    savePrivateKey: vi.fn(() => ({ isValid: true })),
    setDeveloperDiagnosticsEnabled: vi.fn(),
    refreshPrivateMessagesLiveSubscriptionForReconnect: vi.fn().mockResolvedValue(undefined),
    subscribePrivateMessagesForLoggedInUser: vi.fn().mockResolvedValue(undefined),
    updateLoggedInUserRelayList: vi.fn().mockResolvedValue(undefined),
    waitForPrivateMessagesIngestQueue: vi.fn().mockResolvedValue(undefined),
  };
  const relayStore = {
    init: vi.fn(),
    relays: ['ws://relay.one'],
    replaceRelayEntries: vi.fn(),
  };
  const nip65RelayStore = {
    init: vi.fn(),
    replaceRelayEntries: vi.fn(),
  };
  const chatStore = {
    acceptChat: vi.fn().mockResolvedValue(undefined),
    chats: [] as Array<{
      id: string;
      publicKey: string;
      type: 'user' | 'group';
      epochPublicKey: string | null;
    }>,
    init: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    updateChatPreview: vi.fn().mockResolvedValue(undefined),
  };
  const messageStore = {
    init: vi.fn().mockResolvedValue(undefined),
    loadMessages: vi.fn().mockResolvedValue(undefined),
    removeChatMessages: vi.fn(),
    reloadLoadedMessages: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
  };
  const chatDataService = {
    deleteMessageByEventId: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  };
  const contactsService = {
    getContactByPublicKey: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    updateContact: vi.fn(),
  };
  const nostrEventDataService = {
    deleteEventsByIds: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
  };

  return {
    chatDataService,
    chatStore,
    contactsService,
    messageStore,
    nip65RelayStore,
    nostrEventDataService,
    nostrStore,
    relayStore,
    saveBrowserNotificationsPreference: vi.fn(),
  };
});

vi.mock('src/services/inputSanitizerService', () => ({
  inputSanitizerService: {
    normalizeHexKey: vi.fn((value: string) => {
      const normalized = String(value ?? '')
        .trim()
        .toLowerCase();
      return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
    }),
    normalizeRelayEntriesFromUrls: vi.fn((relayUrls: string[]) =>
      relayUrls
        .map((url) => String(url ?? '').trim())
        .filter((url) => url.length > 0)
        .map((url) => ({
          url,
        }))
    ),
  },
}));

vi.mock('src/utils/browserNotificationPreference', () => ({
  saveBrowserNotificationsPreference: moduleMocks.saveBrowserNotificationsPreference,
}));

vi.mock('src/stores/nostrStore', () => ({
  useNostrStore: () => moduleMocks.nostrStore,
}));

vi.mock('src/stores/relayStore', () => ({
  useRelayStore: () => moduleMocks.relayStore,
}));

vi.mock('src/stores/nip65RelayStore', () => ({
  useNip65RelayStore: () => moduleMocks.nip65RelayStore,
}));

vi.mock('src/stores/chatStore', () => ({
  useChatStore: () => moduleMocks.chatStore,
}));

vi.mock('src/stores/messageStore', () => ({
  useMessageStore: () => moduleMocks.messageStore,
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: moduleMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: moduleMocks.contactsService,
}));

vi.mock('src/services/nostrEventDataService', () => ({
  nostrEventDataService: moduleMocks.nostrEventDataService,
}));

describe('e2eBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    moduleMocks.nostrStore.getLoggedInPublicKeyHex.mockReturnValue(PUBKEY_HEX);
    moduleMocks.nostrStore.getDeveloperDiagnosticsSnapshot.mockResolvedValue({
      privateMessagesSubscription: {
        since: 1,
        liveCoverageAt: 2,
      },
    });
    moduleMocks.nostrStore.privateMessagesSubscriptionLastEoseAt = null;
    moduleMocks.nostrStore.savePrivateKey.mockReturnValue({ isValid: true });
    moduleMocks.nostrStore.subscribePrivateMessagesForLoggedInUser.mockImplementation(async () => {
      moduleMocks.nostrStore.privateMessagesSubscriptionLastEoseAt = new Date().toISOString();
    });
    moduleMocks.nostrStore.refreshPrivateMessagesLiveSubscriptionForReconnect.mockImplementation(
      async () => {
        moduleMocks.nostrStore.privateMessagesSubscriptionLastEoseAt = new Date().toISOString();
      }
    );
    moduleMocks.relayStore.relays = ['ws://relay.one'];
    moduleMocks.chatStore.chats = [];
    moduleMocks.chatDataService.deleteMessageByEventId.mockResolvedValue(true);
    moduleMocks.contactsService.getContactByPublicKey.mockResolvedValue({
      id: 7,
      public_key: PUBKEY_HEX,
      relays: [],
    });
    moduleMocks.contactsService.updateContact.mockImplementation(async (_id: number, input) => ({
      id: 7,
      public_key: PUBKEY_HEX,
      relays: input.relays ?? [],
    }));
    moduleMocks.messageStore.sendMessage.mockImplementation(
      async (
        chatId: string,
        text: string,
        _replyTo: null,
        options: { createdAt?: string } = {}
      ) => ({
        id: '1',
        chatId,
        text,
        sender: 'me',
        sentAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
        authorPublicKey: PUBKEY_HEX,
        eventId: 'b'.repeat(64),
        nostrEvent: null,
        meta: {},
      })
    );
    moduleMocks.nostrEventDataService.getEventById.mockResolvedValue(null);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          hash: '',
        },
      },
    });
  });

  it('installs the bridge and bootstraps a session through the mocked stores', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    const session = await bridge.bootstrapSession({
      privateKey: '  private-key  ',
      relayUrls: [' ws://relay.one ', 'ws://relay.two'],
      developerDiagnosticsEnabled: true,
    });

    expect(session).toEqual({
      publicKey: PUBKEY_HEX,
      npub: `npub-${PUBKEY_HEX}`,
      relayUrls: ['ws://relay.one', 'ws://relay.two'],
    });
    expect(moduleMocks.relayStore.init).toHaveBeenCalledTimes(1);
    expect(moduleMocks.relayStore.replaceRelayEntries).toHaveBeenCalledWith([
      { url: 'ws://relay.one' },
      { url: 'ws://relay.two' },
    ]);
    expect(moduleMocks.nip65RelayStore.replaceRelayEntries).toHaveBeenCalled();
    expect(moduleMocks.saveBrowserNotificationsPreference).toHaveBeenCalledWith(false);
    expect(moduleMocks.nostrStore.setDeveloperDiagnosticsEnabled).toHaveBeenCalledWith(true);
    expect(moduleMocks.nostrStore.savePrivateKey).toHaveBeenCalledWith('private-key');
    expect(moduleMocks.nostrStore.updateLoggedInUserRelayList).toHaveBeenCalledWith(
      [{ url: 'ws://relay.one' }, { url: 'ws://relay.two' }],
      { refreshSubscriptions: false }
    );
    expect(moduleMocks.chatStore.reload).toHaveBeenCalledTimes(1);
    expect(moduleMocks.messageStore.reloadLoadedMessages).toHaveBeenCalledTimes(1);
  });

  it('retries transient relay publish failures during bootstrap', async () => {
    vi.useFakeTimers();
    moduleMocks.nostrStore.publishMyRelayList
      .mockRejectedValueOnce(
        new Error('Not enough relays received the event (0 published, 1 required)')
      )
      .mockRejectedValueOnce(
        new Error('Not enough relays received the event (0 published, 1 required)')
      )
      .mockResolvedValue(undefined);

    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    const bootstrapPromise = bridge.bootstrapSession({
      privateKey: 'private-key',
      relayUrls: ['ws://relay.one'],
    });

    await vi.advanceTimersByTimeAsync(900);

    await expect(bootstrapPromise).resolves.toEqual({
      publicKey: PUBKEY_HEX,
      npub: `npub-${PUBKEY_HEX}`,
      relayUrls: ['ws://relay.one'],
    });
    expect(moduleMocks.nostrStore.publishMyRelayList).toHaveBeenCalledTimes(3);
  });

  it('returns the current session snapshot from the mocked stores', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await expect(bridge.getSessionSnapshot()).resolves.toEqual({
      publicKey: PUBKEY_HEX,
      npub: `npub-${PUBKEY_HEX}`,
      relayUrls: ['ws://relay.one'],
    });
  });

  it('refreshes either one chat or every loaded chat depending on the options', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();
    moduleMocks.chatStore.chats = [
      {
        id: 'chat-id',
        publicKey: PUBKEY_HEX,
        type: 'group',
        epochPublicKey: 'b'.repeat(64),
      },
    ];

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await bridge.refreshSession({ chatId: '  Chat-Id  ' });
    expect(moduleMocks.nostrStore.subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledWith();
    expect(moduleMocks.chatStore.reload).toHaveBeenCalledTimes(3);
    expect(moduleMocks.nostrStore.restorePrivateMessagesForRecipient).toHaveBeenCalledWith(
      PUBKEY_HEX,
      { force: true }
    );
    expect(moduleMocks.nostrStore.restoreGroupEpochHistory).toHaveBeenCalledWith(
      PUBKEY_HEX,
      'b'.repeat(64),
      { force: true }
    );
    expect(moduleMocks.messageStore.loadMessages).toHaveBeenCalledWith('chat-id', true);
    expect(moduleMocks.messageStore.reloadLoadedMessages).not.toHaveBeenCalled();

    await bridge.refreshSession();
    expect(moduleMocks.messageStore.reloadLoadedMessages).toHaveBeenCalledTimes(1);
  });

  it('exposes private-message live reconnect diagnostics through the bridge', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await expect(bridge.getDeveloperDiagnosticsSnapshot()).resolves.toEqual({
      privateMessagesSubscription: {
        since: 1,
        liveCoverageAt: 2,
      },
    });

    await expect(
      bridge.refreshPrivateMessagesLiveReconnect({
        forceRecreate: true,
      })
    ).resolves.toEqual({
      privateMessagesSubscription: {
        since: 1,
        liveCoverageAt: 2,
      },
    });
    expect(
      moduleMocks.nostrStore.refreshPrivateMessagesLiveSubscriptionForReconnect
    ).toHaveBeenCalledWith({
      forceRecreate: true,
    });
  });

  it('logs out and redirects to the auth hash', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await bridge.logout();

    expect(moduleMocks.nostrStore.logout).toHaveBeenCalledTimes(1);
    expect(globalThis.window.location.hash).toBe('/auth');
  });

  it('delegates group epoch rotation to the nostr store with normalized inputs', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await bridge.rotateGroupEpoch({
      groupPublicKey: '  GROUP  ',
      memberPublicKeys: [' alice ', '', 'bob'],
      relayUrls: [' ws://relay.one '],
    });

    expect(moduleMocks.nostrStore.rotateGroupEpochAndSendTickets).toHaveBeenCalledWith(
      'GROUP',
      ['alice', 'bob'],
      ['ws://relay.one']
    );
  });

  it('sends seeded bridge messages and forwards explicit createdAt values', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await expect(
      bridge.sendMessages({
        chatId: '  CHAT-ID  ',
        texts: [' first ', ' ', 'second'],
        createdAts: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
      })
    ).resolves.toEqual([
      {
        id: '1',
        chatId: 'chat-id',
        text: 'first',
        sentAt: '2026-01-01T00:00:00.000Z',
        authorPublicKey: PUBKEY_HEX,
        eventId: 'b'.repeat(64),
      },
      {
        id: '1',
        chatId: 'chat-id',
        text: 'second',
        sentAt: '2026-01-02T00:00:00.000Z',
        authorPublicKey: PUBKEY_HEX,
        eventId: 'b'.repeat(64),
      },
    ]);

    expect(moduleMocks.messageStore.sendMessage).toHaveBeenNthCalledWith(
      1,
      'chat-id',
      'first',
      null,
      {
        createdAt: '2026-01-01T00:00:00.000Z',
      }
    );
    expect(moduleMocks.messageStore.sendMessage).toHaveBeenNthCalledWith(
      2,
      'chat-id',
      'second',
      null,
      {
        createdAt: '2026-01-02T00:00:00.000Z',
      }
    );
    expect(moduleMocks.chatStore.updateChatPreview).toHaveBeenCalledTimes(2);
    expect(moduleMocks.chatStore.acceptChat).toHaveBeenCalledTimes(2);
  });

  it('removes a locally stored message row and backing event through the bridge helper', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();
    moduleMocks.nostrEventDataService.getEventById.mockResolvedValue({
      direction: 'in',
      event: {
        id: 'c'.repeat(64),
        pubkey: PUBKEY_HEX,
        content: '',
        created_at: 1,
        tags: [],
      },
      relay_statuses: [],
    });

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await expect(
      bridge.removeStoredMessageByEventId({
        chatId: ` ${'b'.repeat(64)} `,
        eventId: ` ${'c'.repeat(64)} `,
      })
    ).resolves.toBe(true);

    expect(moduleMocks.chatDataService.deleteMessageByEventId).toHaveBeenCalledWith('c'.repeat(64));
    expect(moduleMocks.nostrEventDataService.deleteEventsByIds).toHaveBeenCalledWith([
      'c'.repeat(64),
    ]);
    expect(moduleMocks.messageStore.removeChatMessages).toHaveBeenCalledWith('b'.repeat(64));
    expect(moduleMocks.messageStore.loadMessages).toHaveBeenCalledWith('b'.repeat(64), true);
    expect(moduleMocks.chatStore.reload).toHaveBeenCalledTimes(1);
  });

  it('updates stored contact relays through the bridge helper', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;
    await bridge.updateContactRelays({
      publicKey: ` ${PUBKEY_HEX} `,
      relayUrls: [' ws://relay.one ', 'ws://relay.two'],
    });

    expect(moduleMocks.contactsService.init).toHaveBeenCalledTimes(1);
    expect(moduleMocks.contactsService.getContactByPublicKey).toHaveBeenCalledWith(PUBKEY_HEX);
    expect(moduleMocks.contactsService.updateContact).toHaveBeenCalledWith(7, {
      relays: [{ url: 'ws://relay.one' }, { url: 'ws://relay.two' }],
    });
  });

  it('rejects invalid bootstrap and seeded-message inputs', async () => {
    const { installAppE2EBridge } = await import('src/testing/e2eBridge');
    installAppE2EBridge();

    const bridge = (globalThis.window as typeof window & { __appE2E__: any }).__appE2E__;

    await expect(
      bridge.bootstrapSession({
        privateKey: '   ',
        relayUrls: ['ws://relay.one'],
      })
    ).rejects.toThrow('A private key is required for e2e bootstrap.');

    await expect(
      bridge.bootstrapSession({
        privateKey: 'private-key',
        relayUrls: ['   '],
      })
    ).rejects.toThrow('At least one relay URL is required for e2e bootstrap.');

    moduleMocks.nostrStore.savePrivateKey.mockReturnValueOnce({ isValid: false });
    await expect(
      bridge.bootstrapSession({
        privateKey: 'private-key',
        relayUrls: ['ws://relay.one'],
      })
    ).rejects.toThrow('Invalid private key supplied for e2e bootstrap.');

    moduleMocks.nostrStore.getLoggedInPublicKeyHex.mockReturnValueOnce(null);
    await expect(bridge.getSessionSnapshot()).rejects.toThrow(
      'Failed to read the logged-in public key.'
    );

    await expect(
      bridge.sendMessages({
        chatId: 'chat-id',
        texts: ['first'],
        createdAts: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
      })
    ).rejects.toThrow('Explicit e2e message timestamps must match the number of messages.');

    await expect(
      bridge.updateContactRelays({
        publicKey: 'not-a-pubkey',
        relayUrls: ['ws://relay.one'],
      })
    ).rejects.toThrow('A valid public key is required to update contact relays.');

    await expect(
      bridge.removeStoredMessageByEventId({
        chatId: 'chat-id',
        eventId: 'event-id',
      })
    ).rejects.toThrow('A valid chat id and event id are required to remove a stored message.');
  });
});
