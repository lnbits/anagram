import NDK, { NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listAllMessages: vi.fn(async () => []),
  listChats: vi.fn(async () => []),
}));

const contactsServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listContacts: vi.fn(async () => []),
  getContactByPublicKey: vi.fn(async () => null),
  deleteContact: vi.fn(async () => {}),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: contactsServiceMock,
}));

import { PRIVATE_CONTACT_LIST_D_TAG } from 'src/stores/nostr/constants';
import { createPrivateContactListRuntime } from 'src/stores/nostr/privateContactListRuntime';

const LOGGED_IN_PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);
const PUBKEY_E = 'e'.repeat(64);

function createContact(publicKey: string, overrides: Record<string, unknown> = {}) {
  return {
    id: Number.parseInt(publicKey[0] ?? '1', 16),
    public_key: publicKey,
    type: 'user',
    name: publicKey.slice(0, 16),
    given_name: null,
    meta: {},
    relays: [],
    sendMessagesToAppRelays: false,
    ...overrides,
  };
}

describe('private contact list runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatDataServiceMock.init.mockResolvedValue(undefined);
    chatDataServiceMock.listAllMessages.mockResolvedValue([]);
    chatDataServiceMock.listChats.mockResolvedValue([]);
    contactsServiceMock.init.mockResolvedValue(undefined);
    contactsServiceMock.listContacts.mockResolvedValue([]);
    contactsServiceMock.getContactByPublicKey.mockResolvedValue(null);
    contactsServiceMock.deleteContact.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'startup',
    'subscription',
  ] as const)('restores old private contact-list entries through %s without a message-history cutoff', async (source) => {
    const ndk = new NDK();
    Object.defineProperty(ndk, 'subscribe', {
      configurable: true,
      value: undefined,
    });
    const listEvent = new NDKEvent(ndk, {
      kind: NDKKind.FollowSet,
      pubkey: LOGGED_IN_PUBKEY,
      created_at: 1_700_000_000,
      content: 'encrypted-private-contact-list',
      tags: [['d', PRIVATE_CONTACT_LIST_D_TAG]],
    });
    vi.spyOn(ndk, 'fetchEvent').mockImplementation(async (filters) => {
      const filter = Array.isArray(filters) ? filters[0] : filters;
      return typeof filter === 'object' && (filter.since ?? 0) > (listEvent.created_at ?? 0)
        ? null
        : listEvent;
    });
    const subscribeWithReqLogging = vi.fn<
      Parameters<typeof createPrivateContactListRuntime>[0]['subscribeWithReqLogging']
    >((_label, _requestLabel, filters, options) => {
      const filter = Array.isArray(filters) ? filters[0] : filters;
      if ((filter?.since ?? 0) <= (listEvent.created_at ?? 0)) {
        options.onEvent?.(listEvent);
      }
      options.onEose?.();
      return { stop: vi.fn() } as never;
    });
    const publishReplaceable = vi
      .spyOn(NDKEvent.prototype, 'publishReplaceable')
      .mockResolvedValue(undefined as never);

    chatDataServiceMock.listChats.mockResolvedValue([
      {
        id: PUBKEY_D,
        public_key: PUBKEY_D,
        type: 'group',
        name: 'Outgoing group',
        last_message: '',
        last_message_at: null,
        unread_count: 0,
        meta: {},
      },
    ]);
    chatDataServiceMock.listAllMessages.mockResolvedValue([
      {
        id: 1,
        chat_public_key: PUBKEY_D,
        author_public_key: LOGGED_IN_PUBKEY,
        message: 'sent to group',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'event-d',
        meta: {},
      },
    ]);

    const updateStartupStep = vi.fn();
    const completeStartupStep = vi.fn();
    const ensureContactListedInPrivateContactList = vi.fn(async () => ({
      contact: null,
      didChange: true,
    }));

    const queueTrackedContactSubscriptionsRefresh = vi.fn();
    const isRestoringStartupState = ref(true);
    const runtime = createPrivateContactListRuntime({
      beginStartupStep: vi.fn(),
      bumpContactListVersion: vi.fn(),
      buildPrivateContactListTags: vi.fn(() => []),
      buildSubscriptionEventDetails: vi.fn(() => ({})),
      buildSubscriptionRelayDetails: vi.fn(() => ({})),
      chatStore: { init: vi.fn(async () => {}) },
      completeStartupStep,
      createStartupBatchTracker: vi.fn(() => ({
        beginItem: vi.fn(),
        finishItem: vi.fn(),
        seal: vi.fn(),
      })),
      decryptPrivateContactListContent: vi.fn(async () => [LOGGED_IN_PUBKEY, PUBKEY_B, PUBKEY_C]),
      encryptPrivateContactListTags: vi.fn(async () => ''),
      ensureContactListedInPrivateContactList,
      ensureRelayConnections: vi.fn(async () => {}),
      extractRelayUrlsFromEvent: vi.fn(() => []),
      failStartupStep: vi.fn(),
      formatSubscriptionLogValue: vi.fn((value) => value ?? null),
      getLoggedInPublicKeyHex: vi.fn(() => LOGGED_IN_PUBKEY),
      getLoggedInSignerUser: vi.fn(async () => ({ pubkey: LOGGED_IN_PUBKEY }) as never),
      getStartupStepSnapshot: vi.fn(() => ({ status: 'in_progress' })),
      isRestoringStartupState,
      logSubscription: vi.fn(),
      markPrivateContactListEventApplied: vi.fn(),
      ndk,
      queueTrackedContactSubscriptionsRefresh,
      reconcileAcceptedChatFromPrivateContactList: vi.fn(async () => {}),
      refreshContactByPublicKey: vi.fn(async () => {}),
      relaySignature: vi.fn((relays) => relays.join(',')),
      resolvePrivateContactListPublishRelayUrls: vi.fn(async () => ['wss://relay.example/']),
      resolvePrivateContactListReadRelayUrls: vi.fn(async () => ['wss://relay.example/']),
      shouldApplyPrivateContactListEvent: vi.fn(() => true),
      subscribeWithReqLogging,
      updateStoredEventSinceFromCreatedAt: vi.fn(),
      updateStartupStep,
    });

    const expectedFilter = {
      kinds: [NDKKind.FollowSet],
      authors: [LOGGED_IN_PUBKEY],
      '#d': [PRIVATE_CONTACT_LIST_D_TAG],
    };
    if (source === 'startup') await runtime.restorePrivateContactList();
    else await runtime.subscribePrivateContactListUpdates();
    expect(subscribeWithReqLogging).toHaveBeenCalledWith(
      'private-contact-list',
      'private-contact-list',
      expectedFilter,
      expect.anything(),
      expect.anything()
    );
    expect(ndk.fetchEvent).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(ensureContactListedInPrivateContactList).toHaveBeenCalledTimes(2)
    );

    expect(chatDataServiceMock.listChats).not.toHaveBeenCalled();
    expect(chatDataServiceMock.listAllMessages).not.toHaveBeenCalled();
    expect(updateStartupStep).toHaveBeenLastCalledWith('private-contact-list-restore', {
      eventCount: 2,
    });
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledTimes(2);
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledWith(PUBKEY_B, {
      fallbackName: PUBKEY_B.slice(0, 16),
    });
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledWith(PUBKEY_C, {
      fallbackName: PUBKEY_C.slice(0, 16),
    });
    expect(ensureContactListedInPrivateContactList).not.toHaveBeenCalledWith(
      PUBKEY_D,
      expect.anything()
    );
    expect(publishReplaceable).not.toHaveBeenCalled();
    isRestoringStartupState.value = false;
    ensureContactListedInPrivateContactList.mockResolvedValue({ contact: null, didChange: false });
    subscribeWithReqLogging.mock.calls[0]?.[3].onEvent?.(listEvent);
    await vi.waitFor(() =>
      expect(ensureContactListedInPrivateContactList).toHaveBeenCalledTimes(4)
    );
    await runtime.subscribePrivateContactListUpdates([], true);
    expect(queueTrackedContactSubscriptionsRefresh).not.toHaveBeenCalled();
    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(subscribeWithReqLogging.mock.results[0]?.value.stop).not.toHaveBeenCalled();
    expect(publishReplaceable).not.toHaveBeenCalled();
  });

  it('adds outgoing message targets during Contacts refresh and publishes them', async () => {
    const ndk = new NDK();
    Object.defineProperty(ndk, 'subscribe', {
      configurable: true,
      value: undefined,
    });
    const listEvent = new NDKEvent(ndk, {
      kind: NDKKind.FollowSet,
      pubkey: LOGGED_IN_PUBKEY,
      created_at: 1_700_000_000,
      content: 'encrypted-private-contact-list',
      tags: [['d', PRIVATE_CONTACT_LIST_D_TAG]],
    });
    vi.spyOn(ndk, 'fetchEvent').mockResolvedValue(listEvent);
    const publishReplaceable = vi
      .spyOn(NDKEvent.prototype, 'publishReplaceable')
      .mockResolvedValue(undefined as never);

    chatDataServiceMock.listChats.mockResolvedValue([
      {
        id: PUBKEY_C,
        public_key: PUBKEY_C,
        type: 'group',
        name: 'Group chat',
        last_message: '',
        last_message_at: null,
        unread_count: 0,
        meta: {},
      },
      {
        id: PUBKEY_D,
        public_key: PUBKEY_D,
        type: 'user',
        name: 'Muted chat',
        last_message: '',
        last_message_at: null,
        unread_count: 0,
        meta: { muted: true },
      },
      {
        id: PUBKEY_E,
        public_key: PUBKEY_E,
        type: 'user',
        name: 'Blocked chat',
        last_message: '',
        last_message_at: null,
        unread_count: 0,
        meta: { inbox_state: 'blocked' },
      },
    ]);
    chatDataServiceMock.listAllMessages.mockResolvedValue([
      {
        id: 1,
        chat_public_key: PUBKEY_C,
        author_public_key: LOGGED_IN_PUBKEY,
        message: 'sent to group',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'event-c',
        meta: {},
      },
      {
        id: 2,
        chat_public_key: PUBKEY_D,
        author_public_key: LOGGED_IN_PUBKEY,
        message: 'sent to muted',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'event-d',
        meta: {},
      },
      {
        id: 3,
        chat_public_key: PUBKEY_E,
        author_public_key: LOGGED_IN_PUBKEY,
        message: 'sent to blocked',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'event-e',
        meta: {},
      },
    ]);

    contactsServiceMock.listContacts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createContact(PUBKEY_B), createContact(PUBKEY_C, { type: 'group' })]);

    const beginStartupStep = vi.fn();
    const buildPrivateContactListTags = vi.fn((pubkeys: string[]) =>
      pubkeys.map((pubkey) => ['p', pubkey])
    );
    const updateStartupStep = vi.fn();
    const ensureContactListedInPrivateContactList = vi.fn(async () => ({
      contact: null,
      didChange: true,
    }));

    const runtime = createPrivateContactListRuntime({
      beginStartupStep,
      bumpContactListVersion: vi.fn(),
      buildPrivateContactListTags,
      buildSubscriptionEventDetails: vi.fn(() => ({})),
      buildSubscriptionRelayDetails: vi.fn(() => ({})),
      chatStore: { init: vi.fn(async () => {}) },
      completeStartupStep: vi.fn(),
      createStartupBatchTracker: vi.fn(() => ({
        beginItem: vi.fn(),
        finishItem: vi.fn(),
        seal: vi.fn(),
      })),
      decryptPrivateContactListContent: vi.fn(async () => [LOGGED_IN_PUBKEY, PUBKEY_B]),
      encryptPrivateContactListTags: vi.fn(async () => ''),
      ensureContactListedInPrivateContactList,
      ensureRelayConnections: vi.fn(async () => {}),
      extractRelayUrlsFromEvent: vi.fn(() => []),
      failStartupStep: vi.fn(),
      formatSubscriptionLogValue: vi.fn((value) => value ?? null),
      getLoggedInPublicKeyHex: vi.fn(() => LOGGED_IN_PUBKEY),
      getLoggedInSignerUser: vi.fn(async () => ({ pubkey: LOGGED_IN_PUBKEY }) as never),
      getStartupStepSnapshot: vi.fn(() => ({ status: 'completed' })),
      isRestoringStartupState: ref(false),
      logSubscription: vi.fn(),
      markPrivateContactListEventApplied: vi.fn(),
      ndk,
      queueTrackedContactSubscriptionsRefresh: vi.fn(),
      reconcileAcceptedChatFromPrivateContactList: vi.fn(async () => {}),
      refreshContactByPublicKey: vi.fn(async () => {}),
      relaySignature: vi.fn((relays) => relays.join(',')),
      resolvePrivateContactListPublishRelayUrls: vi.fn(async () => ['wss://relay.example/']),
      resolvePrivateContactListReadRelayUrls: vi.fn(async () => ['wss://relay.example/']),
      shouldApplyPrivateContactListEvent: vi.fn(() => true),
      subscribeWithReqLogging: vi.fn(() => ({ stop: vi.fn() }) as never),
      updateStoredEventSinceFromCreatedAt: vi.fn(),
      updateStartupStep,
    });

    await runtime.refreshPrivateContactListWithOutgoingMessages();

    expect(ndk.fetchEvent).toHaveBeenCalledWith(
      expect.not.objectContaining({
        since: expect.anything(),
      }),
      expect.anything(),
      expect.anything()
    );
    expect(beginStartupStep).not.toHaveBeenCalled();
    expect(updateStartupStep).not.toHaveBeenCalled();
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledWith(PUBKEY_B, {
      fallbackName: PUBKEY_B.slice(0, 16),
    });
    expect(ensureContactListedInPrivateContactList).toHaveBeenCalledWith(PUBKEY_C, {
      fallbackName: 'Group chat',
      type: 'group',
    });
    expect(ensureContactListedInPrivateContactList).not.toHaveBeenCalledWith(
      PUBKEY_D,
      expect.anything()
    );
    expect(ensureContactListedInPrivateContactList).not.toHaveBeenCalledWith(
      PUBKEY_E,
      expect.anything()
    );
    expect(buildPrivateContactListTags).toHaveBeenCalledWith([PUBKEY_B, PUBKEY_C]);
    expect(publishReplaceable).toHaveBeenCalledTimes(1);
  });
});
