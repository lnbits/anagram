import { clearPublicProfiles, getPublicProfile } from '#src/lib/state/publicProfiles.ts';
import NostrClient, { ClientEvent, NostrKind, NostrRelayList } from '#src/lib/nostr/client.ts';
import type { ContactRecord } from '#src/types/contact.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  restorePublicProfiles: vi.fn(async () => {}),
  savePublicProfile: vi.fn(async () => {}),
  listContacts: vi.fn(),
  getContactByPublicKey: vi.fn(),
  updateContact: vi.fn(),
  createContact: vi.fn(),
}));
vi.mock('#src/services/contactsService.ts', () => ({ contactsService: services }));

import { createContactSubscriptionsRuntime } from '#src/stores/nostr/contactSubscriptionsRuntime.ts';
import {
  contactMetadataEqualValue,
  contactRelayListsEqualValue,
  relayEntriesFromRelayListValue,
} from '#src/stores/nostr/valueUtils.ts';

const self = 'a'.repeat(64),
  user = 'b'.repeat(64),
  group = 'c'.repeat(64),
  member = 'd'.repeat(64);
describe('contact snapshot hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPublicProfiles();
  });
  it('batches old profiles and relay kinds by known scope without per-contact queries, preserving cursor state', async () => {
    let contacts: ContactRecord[] = [user, group].map((public_key, id) => ({
      id,
      public_key,
      type: public_key === group ? 'group' : 'user',
      name: 'old',
      given_name: null,
      meta: {
        last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
        muted: true,
        ...(public_key === group
          ? { group_members: [{ public_key: member, name: 'Unknown member' }] }
          : {}),
      },
      relays: [
        {
          url: public_key === group ? 'wss://group.test/' : 'wss://personal.test/',
          read: true,
          write: true,
        },
      ],
      sendMessagesToAppRelays: false,
    }));
    services.createContact.mockImplementation(async (input) => {
      const contact = {
        ...input,
        id: 99,
        type: 'user',
        given_name: null,
        relays: [],
        sendMessagesToAppRelays: false,
      };
      contacts.push(contact);
      return contact;
    });
    services.listContacts.mockImplementation(async () => contacts);
    services.getContactByPublicKey.mockImplementation(
      async (key) => contacts.find((entry) => entry.public_key === key) ?? null,
    );
    services.updateContact.mockImplementation(async (id, patch) => {
      contacts = contacts.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      return contacts.find((entry) => entry.id === id);
    });
    const ndk = new NostrClient();
    const fetch = vi.spyOn(ndk, 'fetchEvent');
    const stop = vi.fn();
    const subscribe = vi.fn((_name, _request, filters, options) => {
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(user))) {
        const profile = new ClientEvent(ndk, {
          id: '1'.repeat(64),
          pubkey: user,
          kind: 0,
          created_at: 1,
          content: '{"name":"Restored"}',
          tags: [],
        });
        const relays = new NostrRelayList(ndk);
        relays.pubkey = user;
        relays.created_at = 2;
        relays.id = '2'.repeat(64);
        relays.bothRelayUrls = ['wss://personal.test/'];
        const dm = new ClientEvent(ndk, {
          id: '3'.repeat(64),
          pubkey: user,
          kind: NostrKind.DirectMessageReceiveRelayList,
          created_at: 3,
          content: '',
          tags: [['relay', 'wss://inbox.test/']],
        });
        options.onEvent(profile);
        // The signed snapshot is visible before the first queued database write.
        if (_name === 'contact-profile' && services.updateContact.mock.calls.length === 0)
          expect(getPublicProfile(user)?.name).toBe('Restored');
        options.onEvent(dm);
        options.onEvent(relays);
      }
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(member))) {
        options.onEvent(
          new ClientEvent(ndk, {
            id: '4'.repeat(64),
            pubkey: member,
            kind: 0,
            created_at: 1,
            content: '{"name":"Hydrated member"}',
            tags: [],
          }),
        );
      }
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(self))) {
        options.onEvent(
          new ClientEvent(ndk, {
            pubkey: self,
            id: '5'.repeat(64),
            kind: 0,
            created_at: 5,
            content: '{"name":"Logged-in profile"}',
            tags: [],
          }),
        );
      }
      options.onEose();
      return { stop: _name === 'profile-lookup' ? vi.fn() : stop };
    });
    const runtime = createContactSubscriptionsRuntime({
      buildSubscriptionEventDetails: () => ({}),
      buildTrackedContactSubscriptionTargetDetails: async () => ({}),
      extractRelayUrlsFromEvent: () => [],
      formatSubscriptionLogValue: (value) => value ?? null,
      getFilterSince: () => 99,
      logSubscription: vi.fn(),
      relaySignature: (urls) => urls.join('|'),
      shouldApplyContactRelayListEvent: () => true,
      ndk,
      getLoggedInPublicKeyHex: () => self,
      listTrackedContactPubkeys: async () => [user, group],
      resolveTrackedContactReadRelayUrls: async () => ['wss://fallback.test/'],
      ensureRelayConnections: async () => {},
      getLoggedInSignerUser: async () => ndk.getUser({ pubkey: self }),
      subscribeWithReqLogging: subscribe as never,
      buildSubscriptionRelayDetails: (relayUrls) => ({ relayUrls }),
      isPubkeyBlocked: () => false,
      shouldApplyContactProfileEvent: () => true,
      buildContactProfileEventState: (event) => ({
        createdAt: event.created_at ?? 0,
        eventId: event.id,
      }),
      buildContactRelayListEventState: (event) => ({
        createdAt: event.created_at ?? 0,
        eventId: event.id,
      }),
      applyContactProfileEventStateToMeta: (meta, state) => ({
        ...meta,
        profile_event_created_at: state.createdAt,
      }),
      applyContactRelayListEventStateToMeta: (meta, state) => ({
        ...meta,
        relay_list_event_created_at: state.createdAt,
      }),
      buildUpdatedContactMeta: (meta, profile) => ({ ...meta, ...profile }),
      parseContactProfileEvent: (event) => JSON.parse(event.content),
      contactMetadataEqual: contactMetadataEqualValue,
      contactRelayListsEqual: contactRelayListsEqualValue,
      relayEntriesFromRelayList: relayEntriesFromRelayListValue,
      shouldPreserveExistingGroupRelays: () => false,
      markContactProfileEventApplied: vi.fn(),
      markContactRelayListEventApplied: vi.fn(),
      pruneTrackedContactProfileEventState: vi.fn(),
      pruneTrackedContactRelayListEventState: vi.fn(),
      updateStoredEventSinceFromCreatedAt: vi.fn(),
      bumpContactListVersion: vi.fn(),
      chatStore: { syncContactProfile: async () => {} },
      encodeNprofile: () => null,
      encodeNpub: () => null,
    } as Parameters<typeof createContactSubscriptionsRuntime>[0]);
    await Promise.all([
      runtime.subscribeContactProfileUpdates(),
      runtime.subscribeContactRelayListUpdates(),
    ]);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
    const groupCall = subscribe.mock.calls.find((call) =>
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(group)),
    );
    expect(groupCall?.[2][0].authors).toEqual([group]);
    expect(groupCall?.[3].relaySet.relayUrls).toEqual([
      'wss://fallback.test/',
      'wss://group.test/',
    ]);
    const restored = contacts.find((entry) => entry.public_key === user);
    if (!restored) throw new Error('Restored contact missing');
    expect(restored.name).toBe('Restored');
    expect(restored.meta).toMatchObject({
      muted: true,
      relay_list_event_created_at: 2,
      dm_receive_relay_event_created_at: 3,
      last_seen_incoming_activity_at: '2026-01-01T00:00:00.000Z',
    });
    expect(restored.relays?.map((relay) => relay.url).sort()).toEqual([
      'wss://inbox.test/',
      'wss://personal.test/',
    ]);
    expect(
      contacts.find((contact) => contact.public_key === group)?.meta.group_members?.[0]?.name,
    ).toBe('Hydrated member');
    const memberCall = subscribe.mock.calls.find((call) =>
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(member)),
    );
    expect(memberCall?.[3].relaySet.relayUrls).toEqual(['wss://fallback.test/']);
    expect(memberCall?.[2]).toContainEqual({ kinds: [0], authors: [member] });
    expect(
      contacts.find((contact) => contact.public_key === self)?.meta.profile_event_created_at,
    ).toBe(5);
    const userCall = subscribe.mock.calls.find((call) =>
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(user)),
    );
    for (const [createdAt, name] of [
      [0, 'Stale profile'],
      [4, 'Updated profile'],
    ] as const) {
      userCall?.[3].onEvent(
        new ClientEvent(ndk, {
          pubkey: user,
          id: String(createdAt).repeat(64),
          kind: 0,
          created_at: createdAt,
          content: JSON.stringify({ name }),
          tags: [],
        }),
      );
    }
    await vi.waitFor(() =>
      expect(contacts.find((contact) => contact.public_key === user)?.name).toBe('Updated profile'),
    );
    expect(services.updateContact.mock.calls.some((call) => call[1].name === 'Stale profile')).toBe(
      false,
    );
    // A failed relay-list write must be retryable when another relay repeats it.
    const inboxUpdate = new ClientEvent(ndk, {
      pubkey: user,
      kind: 10050,
      id: '9'.repeat(64),
      created_at: 9,
      content: '',
      tags: [['relay', 'wss://recovered-inbox.test/']],
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    services.updateContact.mockRejectedValueOnce(new Error('transient IndexedDB failure'));
    userCall?.[3].onEvent(inboxUpdate);
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    userCall?.[3].onEvent(inboxUpdate);
    await vi.waitFor(() =>
      expect(
        contacts.find((entry) => entry.public_key === user)?.meta.dm_receive_relay_entries,
      ).toEqual([{ url: 'wss://recovered-inbox.test/', read: true, write: false }]),
    );
    consoleError.mockRestore();
    expect(stop).not.toHaveBeenCalled();
    // A second restored group includes an already subscribed member. No fresh
    // kind-0 event arrives, but its roster still needs the cached name/picture.
    const secondGroup = 'e'.repeat(64);
    contacts.push({
      ...contacts.find((contact) => contact.public_key === group)!,
      id: 200,
      public_key: secondGroup,
      meta: { group_members: [{ public_key: member, name: 'Unknown member' }] },
    });
    subscribe.mockImplementation((_name, _request, _filters, options) => {
      options.onEose();
      return { stop: _name === 'profile-lookup' ? vi.fn() : stop };
    });
    await runtime.subscribeContactProfileUpdates();
    expect(
      contacts.find((contact) => contact.public_key === secondGroup)?.meta.group_members?.[0]?.name,
    ).toBe('Hydrated member');
    contacts = contacts.filter((contact) => contact.public_key !== user);
    await runtime.subscribeContactProfileUpdates();
    expect(contacts.find((contact) => contact.public_key === user)?.name).toBe('Updated profile');
    // A visible historic author need not be in the current roster or contacts.
    const historicAuthor = 'f'.repeat(64);
    runtime.setVisibleProfileTargets([historicAuthor], group);
    await vi.waitFor(() =>
      expect(
        subscribe.mock.calls.some((call) =>
          call[2].some(
            (filter: { authors: string[]; kinds: number[] }) =>
              filter.authors.includes(historicAuthor) && filter.kinds.includes(0),
          ),
        ),
      ).toBe(true),
    );
    expect(contacts.some((contact) => contact.public_key === historicAuthor)).toBe(false);
    // Mentions hydrate through the same queue without becoming contacts. Releasing
    // one of two mounted labels must retain the remaining label's profile target.
    const mentioned = '1'.repeat(64);
    const releaseFirst = runtime.retainVisibleProfileTarget(mentioned);
    const releaseSecond = runtime.retainVisibleProfileTarget(mentioned);
    releaseFirst();
    runtime.setVisibleProfileTargets([historicAuthor], group);
    await vi.waitFor(() =>
      expect(
        subscribe.mock.calls.some((call) =>
          call[2].some(
            (filter: { authors: string[]; kinds: number[] }) =>
              filter.authors.includes(mentioned) && filter.kinds.includes(0),
          ),
        ),
      ).toBe(true),
    );
    expect(contacts.some((contact) => contact.public_key === mentioned)).toBe(false);
    runtime.resetContactSubscriptionsRuntimeState();
    // A late unmount from the old account must not schedule requests in the new one.
    const calls = services.restorePublicProfiles.mock.calls.length;
    releaseSecond();
    expect(services.restorePublicProfiles.mock.calls.length).toBe(calls);
  });
});
