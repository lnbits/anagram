import { NDKEvent, NDKKind, NDKRelayList, NDKRelaySet } from '@nostr-dev-kit/ndk';
import { createContactRelayRuntime } from 'src/stores/nostr/contactRelayRuntime';
import type { ContactRecord, ContactRelay } from 'src/types/contact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_PUBKEY = 'a'.repeat(64);
const PROFILE_EVENT_ID = 'b'.repeat(64);
const RELAY_EVENT_ID = 'c'.repeat(64);
const DM_RELAY_EVENT_ID = 'd'.repeat(64);
const DEFAULT_RELAY_URL = 'wss://relay.example/';

const serviceMocks = vi.hoisted(() => ({
  chatDataService: {
    init: vi.fn(),
    listChats: vi.fn(),
  },
  contactsService: {
    getContactByPublicKey: vi.fn(),
    init: vi.fn(),
    listContacts: vi.fn(),
    updateContact: vi.fn(),
  },
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: serviceMocks.chatDataService,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

function makeRelay(url = DEFAULT_RELAY_URL): ContactRelay {
  return {
    url,
    read: true,
    write: true,
  };
}

function makeContact(publicKey: string, overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    id: 1,
    public_key: publicKey,
    type: 'user',
    name: `Contact ${publicKey.slice(0, 8)}`,
    given_name: null,
    meta: {},
    relays: [makeRelay()],
    sendMessagesToAppRelays: false,
    ...overrides,
  };
}

function createDeps() {
  const ndk = {
    fetchEvent: vi.fn(),
  };

  return {
    deps: {
      applyContactRelayListEventStateToMeta: vi.fn((meta, eventState) => ({
        ...(meta ?? {}),
        ...(eventState ? { relay_list_event_created_at: eventState.createdAt } : {}),
      })),
      bumpContactListVersion: vi.fn(),
      contactMetadataEqual: vi.fn(
        (first, second) => JSON.stringify(first) === JSON.stringify(second)
      ),
      contactRelayListsEqual: vi.fn(
        (first, second) => JSON.stringify(first) === JSON.stringify(second)
      ),
      ensureRelayConnections: vi.fn().mockResolvedValue(undefined),
      getLoggedInPublicKeyHex: vi.fn(() => null),
      getLoggedInSignerUser: vi.fn().mockResolvedValue({}),
      isPubkeyBlocked: vi.fn(() => false),
      markContactRelayListEventApplied: vi.fn(),
      ndk: ndk as never,
      normalizeRelayStatusUrls: vi.fn((relayUrls: string[]) => Array.from(new Set(relayUrls))),
      normalizeWritableRelayUrlsValue: vi.fn(
        (relays: ContactRelay[] | undefined) => relays?.map((relay) => relay.url) ?? []
      ),
      readContactProfileEventSince: vi.fn((meta) =>
        typeof meta?.profile_event_created_at === 'number' ? meta.profile_event_created_at : null
      ),
      readContactRelayListEventSince: vi.fn((meta) =>
        typeof meta?.relay_list_event_created_at === 'number'
          ? meta.relay_list_event_created_at
          : null
      ),
      relayEntriesFromRelayList: vi.fn(() => [makeRelay()]),
      relayStore: {
        init: vi.fn(),
        relays: [DEFAULT_RELAY_URL],
      },
      resolveGroupPublishRelayUrlsValue: vi.fn(() => []),
      shouldPreserveExistingGroupRelays: vi.fn(() => false),
      updateStoredEventSinceFromCreatedAt: vi.fn(),
    },
    ndk,
  };
}

describe('contactRelayRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.chatDataService.init.mockResolvedValue(undefined);
    serviceMocks.chatDataService.listChats.mockResolvedValue([]);
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.contactsService.listContacts.mockResolvedValue([]);
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(null);
    serviceMocks.contactsService.updateContact.mockResolvedValue(null);
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits since when no relay-list event timestamp is stored for the contact', async () => {
    const { deps, ndk } = createDeps();
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        meta: {},
      })
    );
    vi.spyOn(NDKRelayList, 'from').mockReturnValue({
      bothRelayUrls: new Set([DEFAULT_RELAY_URL]),
      created_at: 42,
      id: RELAY_EVENT_ID,
      readRelayUrls: new Set<string>(),
      writeRelayUrls: new Set<string>(),
    } as never);
    ndk.fetchEvent.mockResolvedValue(
      new NDKEvent({} as never, {
        created_at: 42,
        id: RELAY_EVENT_ID,
        kind: NDKKind.RelayList,
        pubkey: USER_PUBKEY,
      })
    );

    const runtime = createContactRelayRuntime(deps);

    await runtime.fetchContactRelayList(USER_PUBKEY);

    expect(ndk.fetchEvent).toHaveBeenCalledTimes(2);
    expect(ndk.fetchEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        authors: [USER_PUBKEY],
        kinds: [NDKKind.RelayList],
      })
    );
    expect(ndk.fetchEvent.mock.calls[0][0]).not.toHaveProperty('since');
    expect(ndk.fetchEvent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        authors: [USER_PUBKEY],
        kinds: [NDKKind.DirectMessageReceiveRelayList],
      })
    );
    expect(ndk.fetchEvent.mock.calls[1][0]).not.toHaveProperty('since');
  });

  it('merges direct message receive relays into fetched contact relay entries as read relays', async () => {
    const { deps, ndk } = createDeps();
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        relays: [],
      })
    );
    vi.spyOn(NDKRelayList, 'from').mockReturnValue({
      bothRelayUrls: new Set<string>(),
      created_at: 42,
      id: RELAY_EVENT_ID,
      readRelayUrls: new Set<string>(),
      writeRelayUrls: new Set<string>(),
    } as never);
    deps.relayEntriesFromRelayList.mockReturnValue([
      {
        url: 'wss://write.example/',
        read: false,
        write: true,
      },
      {
        url: 'wss://both.example/',
        read: true,
        write: true,
      },
    ]);
    ndk.fetchEvent.mockImplementation(async (filter) => {
      const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : undefined;
      if (kind === NDKKind.RelayList) {
        return new NDKEvent({} as never, {
          created_at: 42,
          id: RELAY_EVENT_ID,
          kind: NDKKind.RelayList,
          pubkey: USER_PUBKEY,
        });
      }

      if (kind === NDKKind.DirectMessageReceiveRelayList) {
        return new NDKEvent({} as never, {
          created_at: 43,
          id: DM_RELAY_EVENT_ID,
          kind: NDKKind.DirectMessageReceiveRelayList,
          pubkey: USER_PUBKEY,
          tags: [
            ['relay', 'wss://write.example'],
            ['relay', 'wss://dm.example'],
          ],
        });
      }

      return null;
    });

    const runtime = createContactRelayRuntime(deps);

    await expect(runtime.fetchContactRelayList(USER_PUBKEY)).resolves.toEqual({
      createdAt: 42,
      eventId: RELAY_EVENT_ID,
      relayEntries: [
        {
          url: 'wss://write.example/',
          read: true,
          write: true,
        },
        {
          url: 'wss://both.example/',
          read: true,
          write: true,
        },
        {
          url: 'wss://dm.example/',
          read: true,
          write: false,
        },
      ],
    });
  });

  it('adds direct message receive relays to existing contact relays when no NIP-65 event is found', async () => {
    const { deps, ndk } = createDeps();
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        relays: [
          {
            url: 'wss://write.example/',
            read: false,
            write: true,
          },
        ],
      })
    );
    ndk.fetchEvent.mockImplementation(async (filter) => {
      const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : undefined;
      if (kind === NDKKind.DirectMessageReceiveRelayList) {
        return new NDKEvent({} as never, {
          created_at: 43,
          id: DM_RELAY_EVENT_ID,
          kind: NDKKind.DirectMessageReceiveRelayList,
          pubkey: USER_PUBKEY,
          tags: [['relay', 'wss://dm.example']],
        });
      }

      return null;
    });

    const runtime = createContactRelayRuntime(deps);

    await expect(runtime.fetchContactRelayList(USER_PUBKEY)).resolves.toEqual({
      createdAt: 0,
      eventId: '',
      relayEntries: [
        {
          url: 'wss://write.example/',
          read: false,
          write: true,
        },
        {
          url: 'wss://dm.example/',
          read: true,
          write: false,
        },
      ],
    });
  });

  it('uses the stored profile event created_at as since when refreshing a contact profile', async () => {
    const { deps, ndk } = createDeps();
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        meta: {
          profile_event_created_at: 321,
        },
      })
    );
    ndk.fetchEvent.mockResolvedValue(
      new NDKEvent({} as never, {
        content: JSON.stringify({
          name: 'Alice',
        }),
        created_at: 400,
        id: PROFILE_EVENT_ID,
        kind: NDKKind.Metadata,
        pubkey: USER_PUBKEY,
      })
    );

    const runtime = createContactRelayRuntime(deps);

    await runtime.fetchContactProfile(USER_PUBKEY);

    expect(ndk.fetchEvent).toHaveBeenCalledTimes(1);
    expect(ndk.fetchEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        authors: [USER_PUBKEY],
        kinds: [NDKKind.Metadata],
        since: 321,
      })
    );
  });

  it('can ignore the stored profile event timestamp for a full relay lookup', async () => {
    const { deps, ndk } = createDeps();
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        meta: {
          profile_event_created_at: 321,
        },
      })
    );
    ndk.fetchEvent.mockResolvedValue(
      new NDKEvent({} as never, {
        content: JSON.stringify({
          name: 'Alice',
        }),
        created_at: 400,
        id: PROFILE_EVENT_ID,
        kind: NDKKind.Metadata,
        pubkey: USER_PUBKEY,
      })
    );

    const runtime = createContactRelayRuntime(deps);

    await runtime.fetchContactProfile(USER_PUBKEY, {
      ignoreStoredSince: true,
    });

    expect(ndk.fetchEvent).toHaveBeenCalledTimes(1);
    expect(ndk.fetchEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        authors: [USER_PUBKEY],
        kinds: [NDKKind.Metadata],
      })
    );
    expect(ndk.fetchEvent.mock.calls[0][0]).not.toHaveProperty('since');
  });

  it('can restrict a profile lookup to explicit relay entries', async () => {
    const { deps, ndk } = createDeps();
    const explicitRelay = makeRelay('wss://explicit.example/');
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(
      makeContact(USER_PUBKEY, {
        relays: [makeRelay('wss://stored.example/')],
      })
    );
    ndk.fetchEvent.mockResolvedValue(
      new NDKEvent({} as never, {
        content: JSON.stringify({
          name: 'Alice',
        }),
        created_at: 400,
        id: PROFILE_EVENT_ID,
        kind: NDKKind.Metadata,
        pubkey: USER_PUBKEY,
      })
    );

    const runtime = createContactRelayRuntime(deps);

    await runtime.fetchContactProfile(USER_PUBKEY, {
      onlyExplicitRelayEntries: true,
      relayEntries: [explicitRelay],
    });

    expect(deps.ensureRelayConnections).toHaveBeenCalledWith(['wss://explicit.example/']);
    expect(NDKRelaySet.fromRelayUrls).toHaveBeenCalledWith(
      ['wss://explicit.example/'],
      deps.ndk,
      false
    );
  });

  it('persists relay-list event timestamps even when the relay entries stay the same', async () => {
    const { deps, ndk } = createDeps();
    const existingContact = makeContact(USER_PUBKEY, {
      id: 4,
      meta: {},
      relays: [makeRelay()],
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingContact);
    serviceMocks.contactsService.updateContact.mockImplementation(async (id: number, input) =>
      makeContact(USER_PUBKEY, {
        id,
        meta: input.meta ?? existingContact.meta,
        relays: input.relays ?? existingContact.relays,
      })
    );
    vi.spyOn(NDKRelayList, 'from').mockReturnValue({
      bothRelayUrls: new Set([DEFAULT_RELAY_URL]),
      created_at: 500,
      id: RELAY_EVENT_ID,
      readRelayUrls: new Set<string>(),
      writeRelayUrls: new Set<string>(),
    } as never);
    deps.relayEntriesFromRelayList.mockReturnValue(existingContact.relays);
    ndk.fetchEvent.mockResolvedValue(
      new NDKEvent({} as never, {
        created_at: 500,
        id: RELAY_EVENT_ID,
        kind: NDKKind.RelayList,
        pubkey: USER_PUBKEY,
      })
    );

    const runtime = createContactRelayRuntime(deps);

    await runtime.refreshContactRelayList(USER_PUBKEY);

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        meta: expect.objectContaining({
          relay_list_event_created_at: 500,
        }),
        relays: existingContact.relays,
      })
    );
    expect(deps.bumpContactListVersion).not.toHaveBeenCalled();
    expect(deps.markContactRelayListEventApplied).toHaveBeenCalledWith(USER_PUBKEY, {
      createdAt: 500,
      eventId: RELAY_EVENT_ID,
    });
  });

  it('builds private mute list tags with encrypted p and bp entries', () => {
    const { deps } = createDeps();
    const runtime = createContactRelayRuntime(deps);
    const mutedPubkey = 'd'.repeat(64);
    const blockedPubkey = 'e'.repeat(64);

    expect(
      runtime.buildMuteListTags(
        [mutedPubkey, blockedPubkey, mutedPubkey],
        [blockedPubkey, blockedPubkey]
      )
    ).toEqual([
      ['p', mutedPubkey],
      ['bp', blockedPubkey],
    ]);
  });
});

// These fixtures mock network IO. Model query readiness explicitly; readiness
// filtering and unavailable pools are covered by relayQueryUtils/relaySnapshot.
vi.mock('src/stores/nostr/relayQueryUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/stores/nostr/relayQueryUtils')>();
  const { NDKRelaySet } = await import('@nostr-dev-kit/ndk');
  return {
    ...actual,
    createReadyRelaySet: (ndk: import('@nostr-dev-kit/ndk').default, urls: string[]) =>
      NDKRelaySet.fromRelayUrls(urls, ndk, false),
  };
});
