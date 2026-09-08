import NDK, { NDKEvent, NDKKind, NDKRelayList } from '@nostr-dev-kit/ndk';
import type { ContactRecord } from 'src/types/contact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listContacts: vi.fn(),
  getContactByPublicKey: vi.fn(),
  updateContact: vi.fn(),
  createContact: vi.fn(),
}));
vi.mock('src/services/contactsService', () => ({ contactsService: services }));

import { createContactSubscriptionsRuntime } from 'src/stores/nostr/contactSubscriptionsRuntime';
import {
  contactMetadataEqualValue,
  contactRelayListsEqualValue,
  relayEntriesFromRelayListValue,
} from 'src/stores/nostr/valueUtils';

const self = 'a'.repeat(64),
  user = 'b'.repeat(64),
  group = 'c'.repeat(64),
  member = 'd'.repeat(64);
describe('contact snapshot hydration', () => {
  beforeEach(() => vi.clearAllMocks());
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
      async (key) => contacts.find((entry) => entry.public_key === key) ?? null
    );
    services.updateContact.mockImplementation(async (id, patch) => {
      contacts = contacts.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      return contacts.find((entry) => entry.id === id);
    });
    const ndk = new NDK();
    const fetch = vi.spyOn(ndk, 'fetchEvent');
    const stop = vi.fn();
    const subscribe = vi.fn((_name, _request, filters, options) => {
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(user))) {
        const profile = new NDKEvent(ndk, {
          id: '1'.repeat(64),
          pubkey: user,
          kind: 0,
          created_at: 1,
          content: '{"name":"Restored"}',
          tags: [],
        });
        const relays = new NDKRelayList(ndk);
        relays.pubkey = user;
        relays.created_at = 2;
        relays.id = '2'.repeat(64);
        relays.bothRelayUrls = ['wss://personal.test/'];
        const dm = new NDKEvent(ndk, {
          id: '3'.repeat(64),
          pubkey: user,
          kind: NDKKind.DirectMessageReceiveRelayList,
          created_at: 3,
          content: '',
          tags: [['relay', 'wss://inbox.test/']],
        });
        options.onEvent(profile);
        options.onEvent(dm);
        options.onEvent(relays);
      }
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(member))) {
        options.onEvent(
          new NDKEvent(ndk, {
            id: '4'.repeat(64),
            pubkey: member,
            kind: 0,
            created_at: 1,
            content: '{"name":"Hydrated member"}',
            tags: [],
          })
        );
      }
      if (filters.some((filter: { authors: string[] }) => filter.authors.includes(self))) {
        options.onEvent(
          new NDKEvent(ndk, {
            pubkey: self,
            id: '5'.repeat(64),
            kind: 0,
            created_at: 5,
            content: '{"name":"Logged-in profile"}',
            tags: [],
          })
        );
      }
      options.onEose();
      return { stop };
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
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(group))
    );
    expect(groupCall?.[2][0].authors).toEqual([group]);
    expect(groupCall?.[3].relaySet.relayUrls).toEqual(['wss://group.test/']);
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
      contacts.find((contact) => contact.public_key === group)?.meta.group_members?.[0]?.name
    ).toBe('Hydrated member');
    const memberCall = subscribe.mock.calls.find((call) =>
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(member))
    );
    expect(memberCall?.[3].relaySet.relayUrls).toEqual(['wss://fallback.test/']);
    expect(memberCall?.[2]).toContainEqual({ kinds: [0], authors: [member] });
    expect(
      contacts.find((contact) => contact.public_key === self)?.meta.profile_event_created_at
    ).toBe(5);
    const userCall = subscribe.mock.calls.find((call) =>
      call[2].some((filter: { authors: string[] }) => filter.authors.includes(user))
    );
    for (const [createdAt, name] of [
      [0, 'Stale profile'],
      [4, 'Updated profile'],
    ] as const) {
      userCall?.[3].onEvent(
        new NDKEvent(ndk, {
          pubkey: user,
          id: String(createdAt).repeat(64),
          kind: 0,
          created_at: createdAt,
          content: JSON.stringify({ name }),
          tags: [],
        })
      );
    }
    await vi.waitFor(() =>
      expect(contacts.find((contact) => contact.public_key === user)?.name).toBe('Updated profile')
    );
    expect(services.updateContact.mock.calls.some((call) => call[1].name === 'Stale profile')).toBe(
      false
    );
    expect(stop).not.toHaveBeenCalled();
    runtime.resetContactSubscriptionsRuntimeState();
  });
});
