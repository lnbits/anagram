import { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import {
  createAndroidNotificationRelayCandidates,
  createDefaultAndroidNotificationRelaySelection,
} from '#src/services/androidNotificationRelaySelectionService.ts';
import {
  __androidRelayNotificationServiceTestUtils,
  createAndroidNotificationConversationSignature,
  createAndroidNotificationWatchPlan,
  ingestPendingAndroidRelayNotificationEvents,
  initializeAndroidRelayNotificationsAfterLogin,
  getAndroidRelayNotificationState,
  isAndroidDirectNotificationContactEligible,
  isAndroidDirectNotificationConversationEnabled,
  isAndroidDirectNotificationConversationPolicyEligible,
  readAndroidRelayConversationDetailsPreference,
  refreshAndroidRelayNotificationListener,
  requestAndroidRelayNotificationsAfterLogin,
  disableAndroidRelayNotifications,
  startAndroidRelayNotificationListeners,
} from '#src/services/androidRelayNotificationService.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  chats: [] as unknown[],
  contacts: [] as unknown[],
  privateKey: `${'0'.repeat(63)}1`,
  appRelayEntries: [] as Array<{ url: string; read: boolean; write: boolean }>,
  userRelayEntries: [{ url: 'wss://relay.example', read: true, write: true }] as Array<{
    url: string;
    read: boolean;
    write: boolean;
  }>,
  watchedPubkeys: [] as string[],
  pendingEvents: [] as unknown[],
  ingestAndroidRelayNotificationEvent: vi.fn(async () => true),
  plugin: {
    getCallNotificationState: vi.fn(async () => ({ closed: [] })),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    configure: vi.fn(
      async (options: {
        conversations: Array<{
          chatPubkey: string;
          notificationsEnabled: boolean;
          policyEligible: boolean;
        }>;
        recipientKeys: Array<{ privateKey: string; recipientPubkey: string }>;
        relays: string[];
        showConversationDetails: boolean;
      }) => ({
        enabled: true,
        startOnBoot: true,
        showConversationDetails: options.showConversationDetails,
        permission: 'granted',
      }),
    ),
    getState: vi.fn(async () => ({
      enabled: true,
      startOnBoot: true,
      showConversationDetails: false,
      permission: 'granted',
    })),
    getPendingEvents: vi.fn(async () => ({ events: [...moduleMocks.pendingEvents] })),
    acknowledgePendingEvents: vi.fn(async (options: { eventIds: string[] }) => {
      for (let index = moduleMocks.pendingEvents.length - 1; index >= 0; index -= 1) {
        const value = moduleMocks.pendingEvents[index];
        if (
          value &&
          typeof value === 'object' &&
          'id' in value &&
          options.eventIds.includes(String(value.id))
        ) {
          moduleMocks.pendingEvents.splice(index, 1);
        }
      }
    }),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
    stop: vi.fn(async () => ({
      enabled: false,
      startOnBoot: true,
      showConversationDetails: false,
      permission: 'granted',
    })),
  },
}));

vi.mock('#src/lib/platform/androidNotifications.ts', () => ({
  isAndroidNative: () => true,
  androidNotificationPlugin: () => moduleMocks.plugin,
}));
vi.mock('#src/lib/platform/secureKeys.ts', () => ({
  readNativeKey: vi.fn(async () => null),
}));

vi.mock('#src/services/chatDataService.ts', () => ({
  chatDataService: {
    init: vi.fn(async () => {}),
    listChats: vi.fn(async () => moduleMocks.chats),
  },
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: {
    init: vi.fn(async () => {}),
    listContacts: vi.fn(async () => moduleMocks.contacts),
  },
}));

vi.mock('#src/stores/nostrStore.ts', () => ({
  useNostrStore: () => ({
    getLoggedInPublicKeyHex: () => new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey,
    getPrivateKeyHex: () => moduleMocks.privateKey,
    getRelayConnectionState: () => 'connected',
    ingestAndroidRelayNotificationEvent: moduleMocks.ingestAndroidRelayNotificationEvent,
    listPrivateMessageRecipientPubkeys: async () => moduleMocks.watchedPubkeys,
  }),
}));

vi.mock('#src/stores/nip65RelayStore.ts', () => ({
  useNip65RelayStore: () => ({
    init: vi.fn(),
    relayEntries: moduleMocks.userRelayEntries,
  }),
}));

vi.mock('#src/stores/relayStore.ts', () => ({
  useRelayStore: () => ({
    init: vi.fn(),
    relayEntries: moduleMocks.appRelayEntries,
  }),
}));

const OWNER_PUBKEY = '11'.repeat(32);
const GROUP_EPOCH_PUBKEY = '22'.repeat(32);
const localStorageValues = new Map<string, string>();

describe('androidRelayNotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: true, startOnBoot: true, showConversationDetails: false, permission: 'granted',
    });
    moduleMocks.plugin.requestPermissions.mockResolvedValue({ receive: 'granted' });
    __androidRelayNotificationServiceTestUtils.resetRefreshState();
    moduleMocks.chats.length = 0;
    moduleMocks.contacts.length = 0;
    moduleMocks.watchedPubkeys.length = 0;
    moduleMocks.pendingEvents.length = 0;
    moduleMocks.ingestAndroidRelayNotificationEvent.mockResolvedValue(true);
    moduleMocks.appRelayEntries.length = 0;
    moduleMocks.userRelayEntries.splice(0, moduleMocks.userRelayEntries.length, {
      url: 'wss://relay.example',
      read: true,
      write: true,
    });
    localStorageValues.clear();
    localStorageValues.set(
      'ui-android-relay-notifications-selected-relays',
      JSON.stringify({
        [new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey]: ['wss://relay.example'],
      }),
    );
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn((key: string) => localStorageValues.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => localStorageValues.set(key, value)),
      },
    });
  });

  afterEach(() => {
    __androidRelayNotificationServiceTestUtils.resetRefreshState();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function unconfiguredListener() {
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: false, startOnBoot: true, showConversationDetails: false, permission: 'prompt',
    });
    localStorageValues.delete('ui-android-relay-notifications-selected-relays');
  }

  it('requests permission once after login and configures generic alerts on default relays', async () => {
    unconfiguredListener();
    // Settings/state reads must not turn an unconfigured installation into an opt-out.
    await getAndroidRelayNotificationState();
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledWith(expect.objectContaining({
      showConversationDetails: false,
      relays: ['wss://relay.example/'],
    }));
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('1');
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).toHaveBeenCalledOnce();
  });

  it('respects a declined permission without configuring keys or repeatedly prompting', async () => {
    unconfiguredListener();
    moduleMocks.plugin.requestPermissions.mockResolvedValue({ receive: 'denied' });
    await initializeAndroidRelayNotificationsAfterLogin();
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('0');
  });

  it('retries an interrupted setup after permission was granted without another prompt', async () => {
    unconfiguredListener();
    moduleMocks.plugin.configure.mockRejectedValueOnce(new Error('Temporary native failure'));
    await expect(initializeAndroidRelayNotificationsAfterLogin()).rejects.toThrow('Temporary native failure');
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('1');
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: false, startOnBoot: true, showConversationDetails: false, permission: 'granted',
    });
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledTimes(2);
    expect(moduleMocks.plugin.requestPermissions).toHaveBeenCalledOnce();
  });

  it('does not turn an enabled preference into an opt-out when native setup is stopped', async () => {
    localStorageValues.set('ui-android-relay-notifications', '1');
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: false, startOnBoot: true, showConversationDetails: false, permission: 'granted',
    });
    await getAndroidRelayNotificationState();
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('1');
    await refreshAndroidRelayNotificationListener();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('restarts an enabled but stopped native service even if its configuration has not changed', async () => {
    await refreshAndroidRelayNotificationListener();
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: true, running: false, startOnBoot: true, showConversationDetails: false, permission: 'granted',
    } as Awaited<ReturnType<typeof moduleMocks.plugin.getState>>);
    await refreshAndroidRelayNotificationListener();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledTimes(2);
  });

  it('does not retry configuration when Android permission is denied', async () => {
    localStorageValues.set('ui-android-relay-notifications', '1');
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: false, startOnBoot: true, showConversationDetails: false, permission: 'denied',
    });
    await initializeAndroidRelayNotificationsAfterLogin();
    await refreshAndroidRelayNotificationListener();
    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
    expect(moduleMocks.plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('preserves an explicit notification opt-out', async () => {
    unconfiguredListener();
    localStorageValues.set('ui-android-relay-notifications', '0');
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).not.toHaveBeenCalled();
    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
  });

  it('keeps existing enabled notifications and conversation detail choices', async () => {
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: true, startOnBoot: true, showConversationDetails: true, permission: 'granted',
    });
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).not.toHaveBeenCalled();
    expect(readAndroidRelayConversationDetailsPreference()).toBe(true);
  });

  it('does not replace an explicitly empty relay selection with defaults', async () => {
    unconfiguredListener();
    localStorageValues.set('ui-android-relay-notifications-selected-relays', JSON.stringify({
      [new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey]: [],
    }));
    await initializeAndroidRelayNotificationsAfterLogin();
    expect(moduleMocks.plugin.requestPermissions).not.toHaveBeenCalled();
    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
  });

  it('does not re-enable or retain keys when disabled during an in-flight configuration', async () => {
    let finish!: (value: {
      enabled: boolean;
      startOnBoot: boolean;
      showConversationDetails: boolean;
      permission: string;
    }) => void;
    moduleMocks.plugin.configure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const enabling = requestAndroidRelayNotificationsAfterLogin();
    const cancelled = expect(enabling).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(moduleMocks.plugin.configure).toHaveBeenCalledOnce());
    const disabling = disableAndroidRelayNotifications();
    finish({
      enabled: true,
      startOnBoot: true,
      showConversationDetails: false,
      permission: 'granted',
    });
    await cancelled;
    await disabling;
    expect(moduleMocks.plugin.stop).toHaveBeenCalledOnce();
    await refreshAndroidRelayNotificationListener();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledOnce();
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('0');
  });
  it('removes listeners whose registration completes after the UI unmounts', async () => {
    const remove = vi.fn(async () => {});
    moduleMocks.plugin.addListener
      .mockResolvedValueOnce({ remove })
      .mockResolvedValueOnce({ remove });
    const stop = startAndroidRelayNotificationListeners(vi.fn(), vi.fn());
    stop();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    const stopAgain = startAndroidRelayNotificationListeners(vi.fn(), vi.fn());
    expect(moduleMocks.plugin.addListener).toHaveBeenCalledTimes(4);
    stopAgain();
  });

  it('ignores a notification tap from a different account', async () => {
    const action = vi.fn();
    const stop = startAndroidRelayNotificationListeners(action, vi.fn());
    const registrations = moduleMocks.plugin.addListener.mock.calls as unknown as Array<
      [string, (value: unknown) => void]
    >;
    const callback = registrations.find(([name]) => name === 'notificationActionPerformed')![1];
    callback({ ownerPubkey: 'f'.repeat(64), chatPubkey: 'a'.repeat(64) });
    expect(action).not.toHaveBeenCalled();
    callback({
      ownerPubkey: new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey,
      chatPubkey: 'a'.repeat(64),
    });
    expect(action).toHaveBeenCalledWith('a'.repeat(64));
    stop();
    await Promise.resolve();
  });

  it('builds a normalized watch plan from private-message relays and recipient pubkeys', () => {
    const watchPlan = createAndroidNotificationWatchPlan({
      ownerPubkey: OWNER_PUBKEY.toUpperCase(),
      relayUrls: [
        ' wss://relay.example ',
        'wss://relay.example/',
        'ws://localhost:8080/nostr',
        'wss://group-relay.example',
        'https://not-a-relay.example',
      ],
      watchedPubkeys: [GROUP_EPOCH_PUBKEY.toUpperCase(), GROUP_EPOCH_PUBKEY, 'invalid'],
    });

    expect(watchPlan).toEqual({
      ownerPubkey: OWNER_PUBKEY,
      relays: ['ws://localhost:8080/nostr', 'wss://group-relay.example/', 'wss://relay.example/'],
      recipientPubkeys: [OWNER_PUBKEY, GROUP_EPOCH_PUBKEY],
    });
    expect(Object.keys(watchPlan)).toEqual(['ownerPubkey', 'relays', 'recipientPubkeys']);
  });

  it('deduplicates notification relay candidates while retaining every source', () => {
    expect(
      createAndroidNotificationRelayCandidates({
        userRelayUrls: ['wss://shared.example', 'wss://user.example'],
        appRelayUrls: ['wss://shared.example/', 'wss://app.example'],
        groupRelayUrls: ['wss://shared.example', 'wss://group.example'],
        selectedRelayUrls: ['wss://removed.example'],
      }),
    ).toEqual([
      {
        url: 'wss://shared.example/',
        sources: ['user', 'app', 'group'],
        available: true,
      },
      {
        url: 'wss://user.example/',
        sources: ['user'],
        available: true,
      },
      {
        url: 'wss://app.example/',
        sources: ['app'],
        available: true,
      },
      {
        url: 'wss://group.example/',
        sources: ['group'],
        available: true,
      },
      {
        url: 'wss://removed.example/',
        sources: [],
        available: false,
      },
    ]);
  });

  it('defaults to at most three user relays, then one app relay, without selecting groups', () => {
    const candidates = createAndroidNotificationRelayCandidates({
      userRelayUrls: [
        'wss://user-one.example',
        'wss://user-two.example',
        'wss://user-three.example',
        'wss://user-four.example',
      ],
      appRelayUrls: ['wss://app.example'],
      groupRelayUrls: ['wss://group.example'],
    });
    expect(createDefaultAndroidNotificationRelaySelection(candidates)).toEqual([
      'wss://user-one.example/',
      'wss://user-two.example/',
      'wss://user-three.example/',
    ]);

    expect(
      createDefaultAndroidNotificationRelaySelection(
        createAndroidNotificationRelayCandidates({
          userRelayUrls: [],
          appRelayUrls: ['wss://app.example', 'wss://second-app.example'],
          groupRelayUrls: ['wss://group.example'],
        }),
      ),
    ).toEqual(['wss://app.example/']);
  });

  it('hides per-conversation details by default', () => {
    expect(readAndroidRelayConversationDetailsPreference()).toBe(false);
  });

  it('ingests and acknowledges encrypted events from the native Android inbox', async () => {
    const ownerPubkey = new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey;
    const eventId = 'aa'.repeat(32);
    moduleMocks.pendingEvents.push({
      id: eventId,
      recipientPubkey: ownerPubkey,
      relayUrl: 'wss://relay.example',
      receivedAtMillis: Date.now(),
      event: {
        id: eventId,
        pubkey: 'bb'.repeat(32),
        created_at: 2_000_000,
        kind: 1059,
        tags: [['p', ownerPubkey]],
        content: 'encrypted gift wrap',
        sig: 'cc'.repeat(64),
      },
    });

    await ingestPendingAndroidRelayNotificationEvents();

    expect(moduleMocks.plugin.getPendingEvents).toHaveBeenCalledWith({
      ownerPubkey,
      limit: 50,
    });
    expect(moduleMocks.ingestAndroidRelayNotificationEvent).toHaveBeenCalledWith({
      ownerPubkey,
      relayUrl: 'wss://relay.example/',
      event: {
        id: eventId,
        pubkey: 'bb'.repeat(32),
        created_at: 2_000_000,
        kind: 1059,
        tags: [['p', ownerPubkey]],
        content: 'encrypted gift wrap',
        sig: 'cc'.repeat(64),
      },
    });
    expect(moduleMocks.plugin.acknowledgePendingEvents).toHaveBeenCalledWith({
      ownerPubkey,
      eventIds: [eventId],
    });
  });

  it('retains a native Android event when app ingestion requests a retry', async () => {
    const ownerPubkey = new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey;
    const eventId = 'dd'.repeat(32);
    moduleMocks.ingestAndroidRelayNotificationEvent.mockResolvedValue(false);
    moduleMocks.pendingEvents.push({
      id: eventId,
      recipientPubkey: ownerPubkey,
      relayUrl: 'wss://relay.example/',
      event: {
        id: eventId,
        pubkey: 'ee'.repeat(32),
        created_at: 2_000_001,
        kind: 1059,
        tags: [['p', ownerPubkey]],
        content: 'encrypted gift wrap',
        sig: 'ff'.repeat(64),
      },
    });

    await ingestPendingAndroidRelayNotificationEvents();

    expect(moduleMocks.ingestAndroidRelayNotificationEvent).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.acknowledgePendingEvents).not.toHaveBeenCalled();
  });

  it('queues the full native batch and acknowledges later successes independently', async () => {
    const ownerPubkey = new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey;
    const retryEventId = '12'.repeat(32);
    const successfulEventId = '34'.repeat(32);
    let resolveRetryEvent: ((value: boolean) => void) | null = null;
    const retryEventResult = new Promise<boolean>((resolve) => {
      resolveRetryEvent = resolve;
    });
    moduleMocks.ingestAndroidRelayNotificationEvent
      .mockReturnValueOnce(retryEventResult)
      .mockResolvedValueOnce(true);
    for (const eventId of [retryEventId, successfulEventId]) {
      moduleMocks.pendingEvents.push({
        id: eventId,
        recipientPubkey: ownerPubkey,
        relayUrl: 'wss://relay.example/',
        event: {
          id: eventId,
          pubkey: '56'.repeat(32),
          created_at: 2_000_002,
          kind: 1059,
          tags: [['p', ownerPubkey]],
          content: 'encrypted gift wrap',
          sig: '78'.repeat(64),
        },
      });
    }

    const drainPromise = ingestPendingAndroidRelayNotificationEvents();
    await vi.waitFor(() => {
      expect(moduleMocks.ingestAndroidRelayNotificationEvent).toHaveBeenCalledTimes(2);
      expect(moduleMocks.plugin.acknowledgePendingEvents).toHaveBeenCalledWith({
        ownerPubkey,
        eventIds: [successfulEventId],
      });
    });
    if (!resolveRetryEvent) {
      throw new Error('The retry event ingestion did not start.');
    }
    resolveRetryEvent(false);
    await drainPromise;

    expect(moduleMocks.pendingEvents).toHaveLength(1);
    expect(moduleMocks.pendingEvents[0]).toEqual(
      expect.objectContaining({
        id: retryEventId,
      }),
    );
  });

  it('refreshes native conversation details when a group avatar changes', () => {
    const group = {
      avatar: 'SG',
      epochPublicKey: GROUP_EPOCH_PUBKEY,
      meta: {
        avatar: 'SG',
        picture: 'https://example.com/group-one.png',
      },
      name: 'Study Group',
      publicKey: '33'.repeat(32),
      type: 'group' as const,
    };

    const firstSignature = createAndroidNotificationConversationSignature([group]);
    const secondSignature = createAndroidNotificationConversationSignature([
      {
        ...group,
        avatar: 'NG',
        meta: {
          ...group.meta,
          avatar: 'NG',
          picture: 'https://example.com/group-two.png',
        },
        name: 'New Group Name',
      },
    ]);

    expect(secondSignature).not.toBe(firstSignature);
  });

  it('refreshes native notification policy when accepted-chat metadata changes', () => {
    const directChat = {
      avatar: 'DC',
      epochPublicKey: null,
      meta: {},
      name: 'Direct chat',
      publicKey: '44'.repeat(32),
      type: 'user' as const,
    };

    const firstSignature = createAndroidNotificationConversationSignature([directChat]);
    const secondSignature = createAndroidNotificationConversationSignature([
      {
        ...directChat,
        meta: {
          inbox_state: 'accepted',
          accepted_at: '2026-08-28T12:00:00.000Z',
          last_outgoing_message_at: '2026-08-28T12:01:00.000Z',
        },
      },
    ]);

    expect(secondSignature).not.toBe(firstSignature);
  });

  it('only treats private-list user contacts as eligible direct-message senders', () => {
    expect(isAndroidDirectNotificationContactEligible(null)).toBe(false);
    expect(
      isAndroidDirectNotificationContactEligible({
        type: 'user',
        meta: {},
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationContactEligible({
        type: 'group',
        meta: { private_contact_list_member: true },
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationContactEligible({
        type: 'user',
        meta: { private_contact_list_member: true },
      }),
    ).toBe(true);
  });

  it('matches the app accepted-chat policy for Android direct-message senders', () => {
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: {},
        contact: null,
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: {},
        contact: {
          type: 'user',
          meta: { private_contact_list_member: true },
        },
      }),
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { inbox_state: 'accepted' },
        contact: null,
      }),
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { accepted_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      }),
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { last_outgoing_message_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      }),
    ).toBe(true);
  });

  it('suppresses muted or blocked Android direct-message conversations', () => {
    const contact = {
      type: 'user' as const,
      meta: { private_contact_list_member: true },
    };

    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: {},
        contact,
      }),
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'accepted' },
        contact: null,
      }),
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'accepted', muted: true },
        contact: null,
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { muted: true },
        contact,
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'blocked', last_outgoing_message_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: {},
        contact: {
          ...contact,
          meta: { ...contact.meta, muted: true },
        },
      }),
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: {},
        contact: {
          ...contact,
          meta: { ...contact.meta, blocked: true },
        },
      }),
    ).toBe(false);
  });

  it('keeps sender verification policy and keys when conversation details are hidden', async () => {
    localStorageValues.set('ui-android-relay-notifications-conversation-details', '0');
    const contactPubkey = '33'.repeat(32);
    const unknownPubkey = '44'.repeat(32);
    moduleMocks.contacts.push({
      public_key: contactPubkey,
      type: 'user',
      name: 'Known contact',
      given_name: null,
      meta: {},
    });
    moduleMocks.chats.push(
      {
        public_key: contactPubkey,
        type: 'user',
        name: 'Known contact',
        meta: { inbox_state: 'accepted' },
      },
      {
        public_key: unknownPubkey,
        type: 'user',
        name: 'Unknown request',
        meta: {},
      },
    );

    await expect(requestAndroidRelayNotificationsAfterLogin()).resolves.toBe('granted');
    const configuration = moduleMocks.plugin.configure.mock.calls[0]?.[0];

    expect(configuration?.showConversationDetails).toBe(false);
    expect(configuration?.recipientKeys).toEqual([
      {
        recipientPubkey: new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey,
        privateKey: moduleMocks.privateKey,
      },
    ]);
    expect(configuration?.conversations).toEqual([
      expect.objectContaining({
        chatPubkey: contactPubkey,
        policyEligible: true,
        notificationsEnabled: true,
      }),
      expect.objectContaining({
        chatPubkey: unknownPubkey,
        policyEligible: false,
        notificationsEnabled: false,
      }),
    ]);
  });

  it('configures the foreground listener with only the saved available relay selection', async () => {
    moduleMocks.userRelayEntries.push({
      url: 'wss://unselected-user.example',
      read: true,
      write: true,
    });
    moduleMocks.appRelayEntries.push({
      url: 'wss://selected-app.example',
      read: true,
      write: true,
    });
    localStorageValues.set(
      'ui-android-relay-notifications-selected-relays',
      JSON.stringify({
        [new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey]: ['wss://selected-app.example'],
      }),
    );

    await expect(requestAndroidRelayNotificationsAfterLogin()).resolves.toBe('granted');

    expect(moduleMocks.plugin.configure.mock.calls[0]?.[0]?.relays).toEqual([
      'wss://selected-app.example/',
    ]);
  });

  it('suspends unavailable relay selection and recovers when the selected route returns', async () => {
    localStorageValues.set(
      'ui-android-relay-notifications-selected-relays',
      JSON.stringify({
        [new NostrPrivateKeySigner(moduleMocks.privateKey).pubkey]: ['wss://removed-relay.example'],
      }),
    );

    await expect(refreshAndroidRelayNotificationListener()).resolves.toBeUndefined();

    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
    expect(moduleMocks.plugin.stop).toHaveBeenCalledOnce();
    expect(localStorageValues.get('ui-android-relay-notifications')).toBe('1');
    moduleMocks.plugin.getState.mockResolvedValue({
      enabled: false, startOnBoot: true, showConversationDetails: false, permission: 'granted',
    });
    moduleMocks.appRelayEntries.push({ url: 'wss://removed-relay.example', read: true, write: true });
    await refreshAndroidRelayNotificationListener();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.configure.mock.calls[0][0].relays).toEqual(['wss://removed-relay.example/']);
  });

  it('coalesces a burst of listener refresh requests into one configuration', async () => {
    vi.useFakeTimers();

    const firstRefresh = refreshAndroidRelayNotificationListener();
    const secondRefresh = refreshAndroidRelayNotificationListener();
    const thirdRefresh = refreshAndroidRelayNotificationListener();

    await vi.advanceTimersByTimeAsync(250);
    await Promise.all([firstRefresh, secondRefresh, thirdRefresh]);

    expect(moduleMocks.plugin.getState).toHaveBeenCalledOnce();
    expect(moduleMocks.plugin.configure).toHaveBeenCalledOnce();
  });

  it('skips native reconfiguration when notification inputs are unchanged', async () => {
    vi.useFakeTimers();
    await expect(requestAndroidRelayNotificationsAfterLogin()).resolves.toBe('granted');
    moduleMocks.plugin.configure.mockClear();

    const refresh = refreshAndroidRelayNotificationListener();
    await vi.advanceTimersByTimeAsync(250);
    await refresh;

    expect(moduleMocks.plugin.configure).not.toHaveBeenCalled();
  });

  it('rejects a watch plan without a valid owner public key', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: 'invalid',
        relayUrls: ['wss://relay.example'],
        watchedPubkeys: [],
      }),
    ).toThrow('logged-in public key');
  });

  it('rejects a watch plan without a readable websocket relay', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: OWNER_PUBKEY,
        relayUrls: ['https://not-a-relay.example'],
        watchedPubkeys: [],
      }),
    ).toThrow('readable relay');
  });
});
