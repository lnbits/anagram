import NDK, {
  NDKEvent,
  NDKKind,
  NDKRelayList,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  NDKUser,
} from '@nostr-dev-kit/ndk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
}));

const contactsServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listContacts: vi.fn(async () => []),
  getContactByPublicKey: vi.fn(async () => null),
  createContact: vi.fn(async () => null),
  updateContact: vi.fn(async () => null),
}));

const nip65RelayStoreMock = vi.hoisted(() => ({
  init: vi.fn(),
  replaceRelayEntries: vi.fn(),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: contactsServiceMock,
}));

vi.mock('src/stores/nip65RelayStore', () => ({
  useNip65RelayStore: () => nip65RelayStoreMock,
}));

import { createMyRelayListRuntime } from 'src/stores/nostr/myRelayListRuntime';
import { createSubscriptionLoggingRuntime } from 'src/stores/nostr/subscriptionLoggingRuntime';

const PUBKEY_A = 'a'.repeat(64);
const USER_KEY = 'b'.repeat(64);
const GROUP_KEY = 'c'.repeat(64);
const EPOCH_KEY = 'd'.repeat(64);
const OTHER_KEY = 'e'.repeat(64);

function normalizeEventId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function relayEntriesFromRelayList(
  relayList:
    | {
        bothRelayUrls?: string[];
        readRelayUrls?: string[];
        writeRelayUrls?: string[];
      }
    | null
    | undefined
) {
  const entries = new Map<string, { url: string; read: boolean; write: boolean }>();
  const upsert = (url: string, read: boolean, write: boolean) => {
    const existing = entries.get(url);
    if (existing) {
      existing.read = existing.read || read;
      existing.write = existing.write || write;
      return;
    }

    entries.set(url, {
      url,
      read,
      write,
    });
  };

  for (const url of relayList?.bothRelayUrls ?? []) {
    upsert(url, true, true);
  }
  for (const url of relayList?.readRelayUrls ?? []) {
    upsert(url, true, false);
  }
  for (const url of relayList?.writeRelayUrls ?? []) {
    upsert(url, false, true);
  }

  return Array.from(entries.values());
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.dynamicImportSettled();
}

describe('relay and subscription runtimes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatDataServiceMock.listChats.mockResolvedValue([]);
    contactsServiceMock.listContacts.mockResolvedValue([]);
    contactsServiceMock.getContactByPublicKey.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds subscription diagnostics and classifies tracked contact targets', async () => {
    const ndk = {
      subscribe: vi.fn((filters, options) => ({
        filters: Array.isArray(filters) ? filters : [filters],
        stop: vi.fn(),
        subId: options.subId,
      })),
    } as never;
    const logDeveloperTrace = vi.fn();
    const runtime = createSubscriptionLoggingRuntime({
      ndk,
      logDeveloperTrace,
      normalizeEventId,
      resolveGroupChatEpochEntries: (chat) =>
        (chat as { public_key?: string }).public_key === GROUP_KEY
          ? [
              {
                epoch_number: 2,
                epoch_public_key: EPOCH_KEY,
                epoch_private_key_encrypted: 'enc-2',
              },
            ]
          : [],
    });

    contactsServiceMock.listContacts.mockResolvedValue([
      {
        public_key: GROUP_KEY,
        type: 'group',
      },
      {
        public_key: USER_KEY,
        type: 'user',
      },
    ] as never);
    chatDataServiceMock.listChats.mockResolvedValue([
      {
        public_key: GROUP_KEY,
        type: 'group',
        meta: {},
      },
    ] as never);

    expect(runtime.relaySignature(['wss://two', 'wss://one'])).toBe('wss://one|wss://two');
    expect(runtime.formatSubscriptionLogValue(PUBKEY_A)).toMatch(/^[a-f0-9]{8}\.\.\.[a-f0-9]{8}$/);
    expect(
      runtime.buildLoggedNostrEvent({
        id: ' ABC ',
        kind: 4,
        created_at: 123,
        pubkey: PUBKEY_A.toUpperCase(),
        content: 'hello',
        tags: [
          ['p', USER_KEY],
          ['e', 'event'],
        ],
      } as never)
    ).toEqual({
      id: 'abc',
      kind: 4,
      created_at: 123,
      pubkey: PUBKEY_A,
      content: 'hello',
      tags: [
        ['p', USER_KEY],
        ['e', 'event'],
      ],
    });
    expect(
      await runtime.buildTrackedContactSubscriptionTargetDetails([GROUP_KEY, USER_KEY])
    ).toEqual({
      userTargetCount: 1,
      groupTargetCount: 1,
      userTargetPubkeys: [runtime.formatSubscriptionLogValue(USER_KEY) ?? USER_KEY],
      groupTargetPubkeys: [runtime.formatSubscriptionLogValue(GROUP_KEY) ?? GROUP_KEY],
    });
    expect(
      await runtime.buildPrivateMessageSubscriptionTargetDetails(
        [PUBKEY_A, EPOCH_KEY, OTHER_KEY],
        PUBKEY_A
      )
    ).toEqual({
      userRecipientCount: 1,
      groupChatCount: 1,
      epochRecipientCount: 1,
      unclassifiedRecipientCount: 1,
      userRecipientPubkeys: [runtime.formatSubscriptionLogValue(PUBKEY_A) ?? PUBKEY_A],
      groupChatPubkeys: [runtime.formatSubscriptionLogValue(GROUP_KEY) ?? GROUP_KEY],
      epochRecipients: [
        {
          groupChatPubkey: runtime.formatSubscriptionLogValue(GROUP_KEY) ?? GROUP_KEY,
          epochRecipientPubkey: runtime.formatSubscriptionLogValue(EPOCH_KEY) ?? EPOCH_KEY,
          epochNumber: 2,
        },
      ],
      unclassifiedRecipientPubkeys: [runtime.formatSubscriptionLogValue(OTHER_KEY) ?? OTHER_KEY],
    });

    const subscription = runtime.subscribeWithReqLogging(
      'my-relay-list',
      'Relay Refresh',
      {
        kinds: [NDKKind.RelayList],
        since: 123,
      },
      {
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        relayUrls: ['wss://relay.one', 'wss://relay.two'],
      } as never,
      {
        source: 'test',
      }
    );
    expect(subscription.subId).toMatch(/^Relay-Refresh-1$/i);
    expect(logDeveloperTrace).toHaveBeenCalledTimes(1);
    expect(logDeveloperTrace).toHaveBeenCalledWith(
      'info',
      'subscription:my-relay-list',
      'req',
      expect.objectContaining({
        reqFrame: [
          'REQ',
          subscription.subId,
          {
            kinds: [NDKKind.RelayList],
            since: 123,
          },
        ],
        reqStatement: [
          'REQ',
          subscription.subId,
          JSON.stringify({
            kinds: [NDKKind.RelayList],
            since: 123,
          }),
        ],
        relayCount: 2,
        relayUrls: ['wss://relay.one', 'wss://relay.two'],
        source: 'test',
      })
    );
    expect(runtime.buildFilterSinceDetails(12)).toEqual({
      since: 12,
      sinceIso: '1970-01-01T00:00:12.000Z',
    });
    expect(runtime.buildFilterUntilDetails(undefined)).toEqual({
      until: null,
      untilIso: null,
    });
  });

  it('publishes, restores, and subscribes to the logged-in relay list', async () => {
    const ndk = new NDK();
    Object.defineProperty(ndk, 'subscribe', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(ndk, 'fetchEvent', {
      configurable: true,
      value: vi.fn(async () => {
        const relayList = new NDKRelayList(ndk);
        relayList.pubkey = PUBKEY_A;
        relayList.created_at = 2222;
        relayList.bothRelayUrls = ['wss://relay.one/'];
        return relayList;
      }),
      writable: true,
    });

    const relaySetSpy = vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({} as never);
    let publishReplaceableCount = 0;
    const publishReplaceableSpy = vi
      .spyOn(NDKEvent.prototype, 'publishReplaceable')
      .mockImplementation(async function publishReplaceable(this: NDKEvent) {
        publishReplaceableCount += 1;
        this.created_at = 1110 + publishReplaceableCount;
        return new Set();
      } as never);

    const beginStartupStep = vi.fn();
    const bumpContactListVersion = vi.fn();
    const completeStartupStep = vi.fn();
    const failStartupStep = vi.fn();
    const ensureRelayConnections = vi.fn(async () => {});
    const getLoggedInSignerUser = vi.fn(async () => new NDKUser({ pubkey: PUBKEY_A }));
    const logSubscription = vi.fn();
    const queueTrackedContactSubscriptionsRefresh = vi.fn();
    const subscribePrivateMessagesForLoggedInUser = vi.fn(async () => {});
    const updateStoredEventSinceFromCreatedAt = vi.fn();
    const subscriptionStop = vi.fn();
    let capturedOnEvent: ((event: NDKEvent) => void) | undefined;

    const runtime = createMyRelayListRuntime({
      beginStartupStep,
      bumpContactListVersion,
      buildSubscriptionEventDetails: (event) => ({
        eventId: event.id ?? null,
      }),
      buildSubscriptionRelayDetails: (relayUrls) => ({
        relayUrls,
        relayCount: relayUrls.length,
      }),
      completeStartupStep,
      ensureRelayConnections,
      extractRelayUrlsFromEvent: () => ['wss://relay.one/'],
      failStartupStep,
      formatSubscriptionLogValue: (value) =>
        value && value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : (value ?? null),
      getFilterSince: () => 900,
      getLoggedInPublicKeyHex: () => PUBKEY_A,
      getLoggedInSignerUser,
      getRelaySnapshots: () => [],
      getStoredAuthMethod: () => 'nip07',
      logSubscription,
      ndk,
      queueTrackedContactSubscriptionsRefresh,
      relayEntriesFromRelayList,
      relaySignature: (relays) => [...relays].sort().join('|'),
      resolveLoggedInPublishRelayUrls: async () => ['wss://relay.one/'],
      resolveLoggedInReadRelayUrls: async () => ['wss://relay.one/'],
      subscribePrivateMessagesForLoggedInUser,
      subscribeWithReqLogging: vi.fn((_name, _label, _filters, options) => {
        capturedOnEvent = options.onEvent;
        return {
          stop: subscriptionStop,
        } as never;
      }),
      updateStoredEventSinceFromCreatedAt,
    });

    contactsServiceMock.getContactByPublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 1,
        public_key: PUBKEY_A,
        relays: [],
      } as never)
      .mockResolvedValueOnce({
        id: 1,
        public_key: PUBKEY_A,
        relays: [],
      } as never);
    contactsServiceMock.createContact.mockResolvedValue({
      id: 1,
      public_key: PUBKEY_A,
    } as never);
    contactsServiceMock.updateContact.mockResolvedValue({
      id: 1,
      public_key: PUBKEY_A,
    } as never);

    await runtime.publishMyRelayList(
      [
        {
          url: 'wss://relay.one',
          read: true,
          write: true,
        },
        {
          url: 'wss://relay.two',
          read: false,
          write: true,
        },
        {
          url: 'wss://relay.three',
          read: true,
          write: false,
        },
      ],
      ['wss://seed.example']
    );
    expect(ensureRelayConnections).toHaveBeenCalledWith(['wss://relay.one/']);
    expect(publishReplaceableSpy).toHaveBeenCalledTimes(2);
    expect((publishReplaceableSpy.mock.contexts[0] as NDKEvent).kind).toBe(NDKKind.RelayList);
    const directMessageRelayListEvent = publishReplaceableSpy.mock.contexts[1] as NDKEvent;
    expect(directMessageRelayListEvent.kind).toBe(NDKKind.DirectMessageReceiveRelayList);
    expect(directMessageRelayListEvent.content).toBe('');
    expect(directMessageRelayListEvent.tags).toEqual([
      ['relay', 'wss://relay.one/'],
      ['relay', 'wss://relay.three/'],
    ]);
    expect(updateStoredEventSinceFromCreatedAt).toHaveBeenCalledWith(1111);
    expect(updateStoredEventSinceFromCreatedAt).toHaveBeenCalledWith(1112);

    await runtime.updateLoggedInUserRelayList([
      {
        url: 'wss://relay.one',
        read: true,
        write: true,
      },
    ]);
    await runtime.updateLoggedInUserRelayList([
      {
        url: 'wss://relay.one',
        read: true,
        write: false,
      },
    ]);
    expect(contactsServiceMock.createContact).toHaveBeenCalledTimes(1);
    expect(contactsServiceMock.updateContact).toHaveBeenCalledTimes(1);
    expect(bumpContactListVersion).toHaveBeenCalledTimes(2);
    expect(subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledWith(true);
    expect(queueTrackedContactSubscriptionsRefresh).toHaveBeenCalled();

    expect(await runtime.fetchMyRelayListEntries(['wss://relay.one/'])).toEqual([
      {
        url: 'wss://relay.one/',
        read: true,
        write: true,
      },
    ]);
    expect(await runtime.fetchMyRelayList(['wss://relay.one/'])).toEqual(['wss://relay.one/']);

    subscribePrivateMessagesForLoggedInUser.mockClear();
    queueTrackedContactSubscriptionsRefresh.mockClear();
    await runtime.restoreMyRelayList(['wss://relay.one/']);
    expect(beginStartupStep).toHaveBeenCalledWith('my-relay-list');
    expect(completeStartupStep).toHaveBeenCalledWith('my-relay-list');
    expect(nip65RelayStoreMock.replaceRelayEntries).toHaveBeenCalled();
    expect(subscribePrivateMessagesForLoggedInUser).not.toHaveBeenCalled();
    expect(queueTrackedContactSubscriptionsRefresh).not.toHaveBeenCalled();

    await runtime.subscribeMyRelayListUpdates(['wss://relay.one/']);
    await runtime.subscribeMyRelayListUpdates(['wss://relay.one/']);
    expect(logSubscription).toHaveBeenCalledWith(
      'my-relay-list',
      'skip',
      expect.objectContaining({
        reason: 'already-active',
      })
    );

    const liveRelayEvent = new NDKRelayList(ndk);
    liveRelayEvent.pubkey = PUBKEY_A;
    liveRelayEvent.created_at = 3333;
    liveRelayEvent.bothRelayUrls = ['wss://relay.two/'];
    capturedOnEvent?.(liveRelayEvent as never);
    await flushPromises();

    expect(updateStoredEventSinceFromCreatedAt).toHaveBeenCalledWith(3333);
    expect(nip65RelayStoreMock.replaceRelayEntries).toHaveBeenCalledWith([
      {
        url: 'wss://relay.two/',
        read: true,
        write: true,
      },
    ]);

    runtime.resetMyRelayListRuntimeState('logout');
    expect(subscriptionStop).toHaveBeenCalledTimes(1);
    expect(relaySetSpy).toHaveBeenCalledWith(['wss://relay.one/'], ndk, false);
  });
});
