import { BACKGROUND_GROUP_CONTACT_REFRESH_COOLDOWN_MS } from 'src/stores/nostr/constants';
import { createContactProfileRuntime } from 'src/stores/nostr/contactProfileRuntime';
import type { ContactRecord } from 'src/types/contact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_PUBKEY = 'a'.repeat(64);
const GROUP_PUBKEY = 'b'.repeat(64);
const serviceMocks = vi.hoisted(() => ({
  contactsService: {
    createContact: vi.fn(),
    getContactByPublicKey: vi.fn(),
    init: vi.fn(),
    updateContact: vi.fn(),
  },
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: serviceMocks.contactsService,
}));

function makeContact(publicKey: string, overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    id: 1,
    public_key: publicKey,
    type: 'user',
    name: `Contact ${publicKey.slice(0, 8)}`,
    given_name: null,
    meta: {},
    relays: [],
    sendMessagesToAppRelays: false,
    ...overrides,
  };
}

function makeUser(publicKey: string) {
  return {
    pubkey: publicKey,
    npub: `npub1${publicKey.slice(0, 8)}`,
    nprofile: `nprofile1${publicKey.slice(0, 8)}`,
    relayUrls: [],
  };
}

function createDeps() {
  const ndkUserByPubkey = new Map<string, ReturnType<typeof makeUser>>();

  const deps = {
    applyContactProfileEventStateToMeta: vi.fn((meta, eventState) => ({
      ...(meta ?? {}),
      ...(eventState ? { profile_event_created_at: eventState.createdAt } : {}),
    })),
    applyContactRelayListEventStateToMeta: vi.fn((meta, eventState) => ({
      ...(meta ?? {}),
      ...(eventState ? { relay_list_event_created_at: eventState.createdAt } : {}),
    })),
    backgroundGroupContactRefreshStartedAt: new Map<string, number>(),
    buildIdentifierFallbacks: vi.fn((pubkeyHex: string) => [pubkeyHex]),
    buildUpdatedContactMeta: vi.fn((existingMeta) => ({
      ...(existingMeta ?? {}),
    })),
    bumpContactListVersion: vi.fn(),
    chatStore: {
      syncContactProfile: vi.fn().mockResolvedValue(undefined),
    },
    contactMetadataEqual: vi.fn(
      (first, second) => JSON.stringify(first) === JSON.stringify(second)
    ),
    contactRelayListsEqual: vi.fn(
      (first, second) => JSON.stringify(first) === JSON.stringify(second)
    ),
    ensureContactListedInPrivateContactList: vi.fn().mockResolvedValue({
      contact: null,
      didChange: false,
    }),
    fetchContactProfile: vi.fn().mockResolvedValue({
      eventState: null,
      profile: null,
    }),
    fetchContactRelayList: vi.fn().mockResolvedValue(null),
    getAppRelayUrls: vi.fn(() => []),
    getLoggedInPublicKeyHex: vi.fn(() => null),
    groupContactRefreshPromises: new Map<string, Promise<ContactRecord | null>>(),
    isContactListedInPrivateContactList: vi.fn(() => false),
    isPubkeyBlocked: vi.fn(() => false),
    markContactProfileEventApplied: vi.fn(),
    markContactRelayListEventApplied: vi.fn(),
    ndk: {
      fetchUser: vi.fn(async (identifier: string) => ndkUserByPubkey.get(identifier)),
    } as never,
    publishPrivateContactList: vi.fn().mockResolvedValue(undefined),
    readContactRelayListEventSince: vi.fn((meta) =>
      typeof meta?.relay_list_event_created_at === 'number'
        ? meta.relay_list_event_created_at
        : null
    ),
    refreshContactRelayList: vi.fn().mockResolvedValue([]),
    resolveGroupDisplayName: vi.fn(
      (groupPublicKey: string) => `Group ${groupPublicKey.slice(0, 8)}`
    ),
    shouldPreserveExistingGroupRelays: vi.fn(() => false),
  };

  return {
    deps,
    setUser(publicKey: string) {
      const user = makeUser(publicKey);
      ndkUserByPubkey.set(publicKey, user);
      return user;
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('contactProfileRuntime group refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));
    serviceMocks.contactsService.init.mockResolvedValue(undefined);
    serviceMocks.contactsService.createContact.mockResolvedValue(null);
    serviceMocks.contactsService.updateContact.mockImplementation(async (id: number, input) =>
      makeContact(input.public_key ?? USER_PUBKEY, {
        id,
        type: input.type ?? 'user',
        name: input.name ?? `Contact ${(input.public_key ?? USER_PUBKEY).slice(0, 8)}`,
        given_name: input.given_name ?? null,
        meta: input.meta ?? {},
        relays: input.relays ?? [],
        sendMessagesToAppRelays: input.sendMessagesToAppRelays ?? false,
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the in-flight group refresh promise', async () => {
    const { deps, setUser } = createDeps();
    setUser(GROUP_PUBKEY);
    const profileDeferred = createDeferred<{
      eventState: null;
      profile: null;
    }>();
    deps.fetchContactProfile.mockReturnValueOnce(profileDeferred.promise);
    const existingGroup = makeContact(GROUP_PUBKEY, {
      id: 2,
      type: 'group',
      name: 'Study Group',
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingGroup);

    const runtime = createContactProfileRuntime(deps);

    const firstRefresh = runtime.refreshGroupContactByPublicKey(GROUP_PUBKEY, 'Study Group');
    const pendingRefresh = deps.groupContactRefreshPromises.get(GROUP_PUBKEY);
    const secondRefresh = runtime.refreshGroupContactByPublicKey(GROUP_PUBKEY, 'Study Group');

    expect(pendingRefresh).toBeDefined();
    expect(deps.groupContactRefreshPromises.get(GROUP_PUBKEY)).toBe(pendingRefresh);
    expect(deps.groupContactRefreshPromises.size).toBe(1);

    profileDeferred.resolve({
      eventState: null,
      profile: null,
    });
    await firstRefresh;
    await secondRefresh;

    expect(deps.fetchContactProfile).toHaveBeenCalledTimes(1);
    expect(deps.fetchContactRelayList).toHaveBeenCalledTimes(1);
    expect(deps.refreshContactRelayList).not.toHaveBeenCalled();
    expect(deps.groupContactRefreshPromises.size).toBe(0);
  });

  it('refreshes relay lists automatically when refreshing an existing group profile', async () => {
    const { deps, setUser } = createDeps();
    setUser(GROUP_PUBKEY);
    const existingGroup = makeContact(GROUP_PUBKEY, {
      id: 2,
      type: 'group',
      name: 'Study Group',
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingGroup);
    deps.fetchContactRelayList.mockResolvedValue({
      createdAt: 42,
      eventId: 'relay-event',
      relayEntries: [{ url: 'wss://relay.example/', read: true, write: true }],
    });

    const runtime = createContactProfileRuntime(deps);

    await runtime.refreshContactByPublicKey(GROUP_PUBKEY, 'Study Group');

    expect(deps.fetchContactRelayList).toHaveBeenCalledWith(GROUP_PUBKEY, undefined);
    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      })
    );
    expect(deps.markContactRelayListEventApplied).toHaveBeenCalledWith(GROUP_PUBKEY, {
      createdAt: 42,
      eventId: 'relay-event',
    });
  });

  it('refreshes relay lists for user contacts that have no stored relay-list event timestamp', async () => {
    const { deps, setUser } = createDeps();
    setUser(USER_PUBKEY);
    const existingUser = makeContact(USER_PUBKEY, {
      id: 3,
      type: 'user',
      name: 'Alice',
      meta: {},
      relays: [{ url: 'wss://relay.seed/', read: true, write: true }],
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingUser);

    const runtime = createContactProfileRuntime(deps);

    await runtime.refreshContactByPublicKey(USER_PUBKEY, 'Alice');

    expect(deps.fetchContactRelayList).toHaveBeenCalledWith(USER_PUBKEY, undefined);
  });

  it('persists fetched profile and relay event timestamps in contact metadata', async () => {
    const { deps, setUser } = createDeps();
    setUser(USER_PUBKEY);
    const existingUser = makeContact(USER_PUBKEY, {
      id: 4,
      type: 'user',
      name: 'Alice',
      meta: {},
      relays: [{ url: 'wss://relay.seed/', read: true, write: true }],
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingUser);
    deps.fetchContactProfile.mockResolvedValue({
      eventState: {
        createdAt: 11,
        eventId: 'profile-event',
      },
      profile: {
        name: 'Alice',
      },
    });
    deps.fetchContactRelayList.mockResolvedValue({
      createdAt: 22,
      eventId: 'relay-event',
      relayEntries: [{ url: 'wss://relay.example/', read: true, write: true }],
    });

    const runtime = createContactProfileRuntime(deps);

    await runtime.refreshContactByPublicKey(USER_PUBKEY, 'Alice', {
      refreshRelayList: true,
    });

    expect(serviceMocks.contactsService.updateContact).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        meta: expect.objectContaining({
          profile_event_created_at: 11,
          relay_list_event_created_at: 22,
        }),
        relays: [{ url: 'wss://relay.example/', read: true, write: true }],
      })
    );
  });

  it('fetches an onboarding profile from the explicit relay set', async () => {
    const { deps } = createDeps();
    deps.fetchContactProfile.mockResolvedValue({
      eventState: {
        createdAt: 55,
        eventId: 'profile-event',
      },
      profile: {
        name: 'Alice',
      },
    });
    deps.buildUpdatedContactMeta.mockReturnValue({
      name: 'alice',
      display_name: 'Alice',
      about: 'Profile from relay',
      picture: 'https://example.com/alice.png',
      nip05: 'alice@example.com',
    });

    const runtime = createContactProfileRuntime(deps);

    const result = await runtime.fetchUserProfileFromRelays(USER_PUBKEY, [' wss://relay.example ']);

    expect(deps.fetchContactProfile).toHaveBeenCalledWith(USER_PUBKEY, {
      ignoreStoredSince: true,
      onlyExplicitRelayEntries: true,
      relayEntries: [{ url: 'wss://relay.example', read: true, write: true }],
    });
    expect(result).toEqual({
      publicKey: USER_PUBKEY,
      name: 'Alice',
      displayName: 'Alice',
      about: 'Profile from relay',
      picture: 'https://example.com/alice.png',
      nip05: 'alice@example.com',
      relayUrls: ['wss://relay.example/'],
      eventCreatedAt: 55,
      eventId: 'profile-event',
    });
  });

  it('returns null when onboarding relays do not have a profile event', async () => {
    const { deps } = createDeps();
    deps.fetchContactProfile.mockResolvedValue({
      eventState: null,
      profile: null,
    });

    const runtime = createContactProfileRuntime(deps);

    await expect(
      runtime.fetchUserProfileFromRelays(USER_PUBKEY, ['wss://relay.example'])
    ).resolves.toBeNull();
  });

  it('fetches group relay metadata once and forwards seed relay urls', async () => {
    const { deps, setUser } = createDeps();
    setUser(GROUP_PUBKEY);
    const existingGroup = makeContact(GROUP_PUBKEY, {
      id: 2,
      type: 'group',
      name: 'Study Group',
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingGroup);

    const runtime = createContactProfileRuntime(deps);

    await runtime.refreshGroupContactByPublicKey(GROUP_PUBKEY, 'Study Group', [
      'wss://relay.seed/',
    ]);

    expect(deps.fetchContactRelayList).toHaveBeenCalledWith(GROUP_PUBKEY, ['wss://relay.seed/']);
    expect(deps.fetchContactRelayList).toHaveBeenCalledTimes(1);
    expect(deps.refreshContactRelayList).not.toHaveBeenCalled();
  });

  it('throttles background group refreshes with the runtime cooldown', async () => {
    const { deps, setUser } = createDeps();
    setUser(GROUP_PUBKEY);
    const existingGroup = makeContact(GROUP_PUBKEY, {
      id: 2,
      type: 'group',
      name: 'Study Group',
      meta: {
        group: true,
      },
      relays: [{ url: 'wss://relay.example', read: true, write: true }],
    });
    serviceMocks.contactsService.getContactByPublicKey.mockResolvedValue(existingGroup);

    const runtime = createContactProfileRuntime(deps);

    runtime.queueBackgroundGroupContactRefresh(GROUP_PUBKEY, 'Study Group');
    const firstRefresh = deps.groupContactRefreshPromises.get(GROUP_PUBKEY);
    expect(firstRefresh).toBeDefined();
    await firstRefresh;
    runtime.queueBackgroundGroupContactRefresh(GROUP_PUBKEY, 'Study Group');
    await flushPromises();

    expect(deps.fetchContactProfile).toHaveBeenCalledTimes(1);
    expect(deps.fetchContactRelayList).toHaveBeenCalledTimes(1);
    expect(deps.refreshContactRelayList).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BACKGROUND_GROUP_CONTACT_REFRESH_COOLDOWN_MS + 1);
    runtime.queueBackgroundGroupContactRefresh(GROUP_PUBKEY, 'Study Group');
    const secondRefresh = deps.groupContactRefreshPromises.get(GROUP_PUBKEY);
    expect(secondRefresh).toBeDefined();
    await secondRefresh;

    expect(deps.fetchContactProfile).toHaveBeenCalledTimes(2);
    expect(deps.fetchContactRelayList).toHaveBeenCalledTimes(2);
    expect(deps.refreshContactRelayList).not.toHaveBeenCalled();
  });
});
