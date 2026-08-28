import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import {
  createAndroidNotificationConversationSignature,
  createAndroidNotificationWatchPlan,
  isAndroidDirectNotificationContactEligible,
  isAndroidDirectNotificationConversationEnabled,
  isAndroidDirectNotificationConversationPolicyEligible,
  readAndroidRelayConversationDetailsPreference,
  requestAndroidRelayNotificationsAfterLogin,
} from 'src/services/androidRelayNotificationService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const moduleMocks = vi.hoisted(() => ({
  chats: [] as unknown[],
  contacts: [] as unknown[],
  privateKey: `${'0'.repeat(63)}1`,
  relayUrls: ['wss://relay.example'],
  watchedPubkeys: [] as string[],
  plugin: {
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    configure: vi.fn(
      async (options: {
        conversations: Array<{
          chatPubkey: string;
          notificationsEnabled: boolean;
          policyEligible: boolean;
        }>;
        recipientKeys: Array<{ privateKey: string; recipientPubkey: string }>;
        showConversationDetails: boolean;
      }) => ({
        enabled: true,
        startOnBoot: true,
        showConversationDetails: options.showConversationDetails,
        permission: 'granted',
      })
    ),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
  },
  registerPlugin: () => moduleMocks.plugin,
}));

vi.mock('src/services/androidSecurePrivateKeyStorage', () => ({
  readAndroidSecurePrivateKeyHex: vi.fn(async () => null),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: {
    init: vi.fn(async () => {}),
    listChats: vi.fn(async () => moduleMocks.chats),
  },
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: {
    init: vi.fn(async () => {}),
    listContacts: vi.fn(async () => moduleMocks.contacts),
  },
}));

vi.mock('src/stores/nostrStore', () => ({
  useNostrStore: () => ({
    getLoggedInPublicKeyHex: () => new NDKPrivateKeySigner(moduleMocks.privateKey).pubkey,
    getPrivateKeyHex: () => moduleMocks.privateKey,
    listPrivateMessageReadRelayUrls: async () => moduleMocks.relayUrls,
    listPrivateMessageRecipientPubkeys: async () => moduleMocks.watchedPubkeys,
  }),
}));

const OWNER_PUBKEY = '11'.repeat(32);
const GROUP_EPOCH_PUBKEY = '22'.repeat(32);
const localStorageValues = new Map<string, string>();

describe('androidRelayNotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moduleMocks.chats.length = 0;
    moduleMocks.contacts.length = 0;
    moduleMocks.watchedPubkeys.length = 0;
    localStorageValues.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn((key: string) => localStorageValues.get(key) ?? null),
        setItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      relays: ['ws://localhost:8080/nostr/', 'wss://group-relay.example/', 'wss://relay.example/'],
      recipientPubkeys: [OWNER_PUBKEY, GROUP_EPOCH_PUBKEY],
    });
    expect(Object.keys(watchPlan)).toEqual(['ownerPubkey', 'relays', 'recipientPubkeys']);
  });

  it('enables per-conversation details by default', () => {
    expect(readAndroidRelayConversationDetailsPreference()).toBe(true);
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
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationContactEligible({
        type: 'group',
        meta: { private_contact_list_member: true },
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationContactEligible({
        type: 'user',
        meta: { private_contact_list_member: true },
      })
    ).toBe(true);
  });

  it('matches the app accepted-chat policy for Android direct-message senders', () => {
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: {},
        contact: null,
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: {},
        contact: {
          type: 'user',
          meta: { private_contact_list_member: true },
        },
      })
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { inbox_state: 'accepted' },
        contact: null,
      })
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { accepted_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      })
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationPolicyEligible({
        chatMeta: { last_outgoing_message_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      })
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
      })
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'accepted' },
        contact: null,
      })
    ).toBe(true);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'accepted', muted: true },
        contact: null,
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { muted: true },
        contact,
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: { inbox_state: 'blocked', last_outgoing_message_at: '2026-08-28T12:00:00.000Z' },
        contact: null,
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: {},
        contact: {
          ...contact,
          meta: { ...contact.meta, muted: true },
        },
      })
    ).toBe(false);
    expect(
      isAndroidDirectNotificationConversationEnabled({
        chatMeta: {},
        contact: {
          ...contact,
          meta: { ...contact.meta, blocked: true },
        },
      })
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
      }
    );

    await expect(requestAndroidRelayNotificationsAfterLogin()).resolves.toBe('granted');
    const configuration = moduleMocks.plugin.configure.mock.calls[0]?.[0];

    expect(configuration?.showConversationDetails).toBe(false);
    expect(configuration?.recipientKeys).toEqual([
      {
        recipientPubkey: new NDKPrivateKeySigner(moduleMocks.privateKey).pubkey,
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

  it('rejects a watch plan without a valid owner public key', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: 'invalid',
        relayUrls: ['wss://relay.example'],
        watchedPubkeys: [],
      })
    ).toThrow('logged-in public key');
  });

  it('rejects a watch plan without a readable websocket relay', () => {
    expect(() =>
      createAndroidNotificationWatchPlan({
        ownerPubkey: OWNER_PUBKEY,
        relayUrls: ['https://not-a-relay.example'],
        watchedPubkeys: [],
      })
    ).toThrow('readable relay');
  });
});
