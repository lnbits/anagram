import { __nostrStoreTestUtils } from 'src/stores/nostr/testUtils';
import { describe, expect, it } from 'vitest';

const {
  buildAcceptedGroupInviteChatPlan,
  beginStartupStepSnapshot,
  buildAvatarFallback,
  buildIdentifierFallbacks,
  buildUpdatedContactMeta,
  buildGroupInviteRequestPlan,
  completeStartupStepSnapshot,
  contactMetadataEqual,
  contactRelayListsEqual,
  createInitialStartupStepSnapshots,
  failStartupStepSnapshot,
  findConflictingKnownGroupEpochNumber,
  findHigherKnownGroupEpochConflict,
  isContactListedInPrivateContactList,
  normalizeChatGroupEpochKeys,
  normalizeRelayStatusUrls,
  normalizeWritableRelayUrls,
  relayEntriesFromRelayList,
  resetStartupStepSnapshots,
  resolveGroupDisplayName,
  resolveGroupPublishRelayUrls,
  resolveCurrentGroupChatEpochEntry,
  resolveGroupChatEpochEntries,
  resolveIncomingChatInboxState,
  resolvePrivateMessagesLiveReconnectSince,
  shouldPreserveExistingGroupRelays,
} = __nostrStoreTestUtils;

const EPOCH_KEY_A = 'a'.repeat(64);
const EPOCH_KEY_B = 'b'.repeat(64);
const EPOCH_KEY_C = 'c'.repeat(64);

describe('nostrStore logic', () => {
  it('creates pending startup-step snapshots in stable order for restore flows', () => {
    const steps = createInitialStartupStepSnapshots();

    expect(steps).toHaveLength(16);
    expect(steps[0]).toMatchObject({
      id: 'my-relays-restore',
      order: 1,
      status: 'pending',
    });
    expect(steps[steps.length - 1]).toMatchObject({
      id: 'message-history-restore',
      order: 16,
      status: 'pending',
    });
    expect(steps[11]).toMatchObject({
      id: 'private-messages-subscribe',
      label: 'startup.listenForNewMessages',
      order: 12,
    });
    expect(
      steps.every(
        (step) =>
          step.startedAt === null && step.completedAt === null && step.internalTasks.length === 0
      )
    ).toBe(true);
  });

  it('transitions startup steps through begin, complete, fail, and reset without stale state leakage', () => {
    const staleStep = {
      ...createInitialStartupStepSnapshots()[0],
      status: 'error' as const,
      startedAt: 10,
      completedAt: 25,
      durationMs: 15,
      errorMessage: 'previous failure',
    };

    expect(beginStartupStepSnapshot(staleStep, 40)).toMatchObject({
      status: 'in_progress',
      startedAt: 40,
      completedAt: null,
      durationMs: null,
      errorMessage: null,
    });

    const activeStep = {
      ...staleStep,
      status: 'in_progress' as const,
    };
    expect(beginStartupStepSnapshot(activeStep, 99)).toBe(activeStep);

    expect(completeStartupStepSnapshot(createInitialStartupStepSnapshots()[1], 75)).toMatchObject({
      status: 'success',
      startedAt: 75,
      completedAt: 75,
      durationMs: 0,
      errorMessage: null,
    });

    expect(
      failStartupStepSnapshot(
        {
          ...createInitialStartupStepSnapshots()[2],
          status: 'in_progress',
          startedAt: 30,
          completedAt: null,
          durationMs: null,
        },
        new Error('restore failed'),
        55
      )
    ).toMatchObject({
      status: 'error',
      startedAt: 30,
      completedAt: 55,
      durationMs: 25,
      errorMessage: 'restore failed',
    });

    expect(resetStartupStepSnapshots().every((step) => step.status === 'pending')).toBe(true);
  });

  it('anchors private-message live reconnects to the last known live coverage time first', () => {
    expect(
      resolvePrivateMessagesLiveReconnectSince({
        liveCoverageAt: 1_700_200_000,
        lastEventTime: 1_600_000_000,
        startupFloorSince: 1_500_000_000,
        lookbackSeconds: 2 * 24 * 60 * 60,
      })
    ).toBe(1_700_200_000 - 2 * 24 * 60 * 60);
  });

  it('falls back to last private-message event time for live reconnects without coverage', () => {
    expect(
      resolvePrivateMessagesLiveReconnectSince({
        liveCoverageAt: null,
        lastEventTime: 1_700_100_000,
        startupFloorSince: 1_500_000_000,
        lookbackSeconds: 2 * 24 * 60 * 60,
      })
    ).toBe(1_700_100_000 - 2 * 24 * 60 * 60);
  });

  it('falls back to the startup floor for live reconnects without coverage or events', () => {
    expect(
      resolvePrivateMessagesLiveReconnectSince({
        liveCoverageAt: null,
        lastEventTime: null,
        startupFloorSince: 1_500_000_000,
        lookbackSeconds: 2 * 24 * 60 * 60,
      })
    ).toBe(1_500_000_000);
  });

  it('normalizes group epoch entries, filters invalid rows, and sorts descending', () => {
    expect(
      normalizeChatGroupEpochKeys([
        {
          epoch_number: 1,
          epoch_public_key: EPOCH_KEY_A.toUpperCase(),
          epoch_private_key_encrypted: 'enc-1',
        },
        {
          epoch_number: 0,
          epoch_public_key: EPOCH_KEY_B,
          epoch_private_key_encrypted: 'enc-0',
        },
        {
          epoch_number: 1,
          epoch_public_key: EPOCH_KEY_C,
          epoch_private_key_encrypted: 'enc-1b',
          invitation_created_at: '2026-01-03T00:00:00.000Z',
        },
        {
          epoch_number: -1,
          epoch_public_key: EPOCH_KEY_A,
          epoch_private_key_encrypted: 'bad',
        },
      ])
    ).toEqual([
      {
        epoch_number: 1,
        epoch_public_key: EPOCH_KEY_C,
        epoch_private_key_encrypted: 'enc-1b',
        invitation_created_at: '2026-01-03T00:00:00.000Z',
      },
      {
        epoch_number: 0,
        epoch_public_key: EPOCH_KEY_B,
        epoch_private_key_encrypted: 'enc-0',
      },
    ]);
  });

  it('resolves epoch history and prefers the explicitly current epoch key', () => {
    const groupChat = {
      type: 'group',
      meta: {
        group_epoch_keys: [
          {
            epoch_number: 2,
            epoch_public_key: EPOCH_KEY_C,
            epoch_private_key_encrypted: 'enc-2',
          },
          {
            epoch_number: 1,
            epoch_public_key: EPOCH_KEY_B,
            epoch_private_key_encrypted: 'enc-1',
          },
        ],
        current_epoch_public_key: EPOCH_KEY_B,
      },
    };

    expect(
      resolveGroupChatEpochEntries(groupChat as never).map((entry) => entry.epoch_number)
    ).toEqual([2, 1]);
    expect(resolveCurrentGroupChatEpochEntry(groupChat as never)).toMatchObject({
      epoch_number: 1,
      epoch_public_key: EPOCH_KEY_B,
    });
  });

  it('normalizes startup relay urls and writable relay entries for relay restore/edit flows', () => {
    expect(
      normalizeRelayStatusUrls([' ws://relay.example ', 'ws://relay.example/', '', 'not-a-relay'])
    ).toEqual(['ws://relay.example/', 'http://not-a-relay/']);

    expect(
      normalizeWritableRelayUrls([
        { url: 'wss://write.example', read: true, write: true },
        { url: 'wss://read-only.example', read: true, write: false },
        { url: 'invalid relay', read: true, write: true },
      ] as never)
    ).toEqual(['wss://write.example/']);
  });

  it('detects when a contact came from the private contact list', () => {
    expect(
      isContactListedInPrivateContactList({
        meta: {
          private_contact_list_member: true,
        },
      } as never)
    ).toBe(true);

    expect(
      isContactListedInPrivateContactList({
        meta: {
          private_contact_list_member: false,
        },
      } as never)
    ).toBe(false);

    expect(isContactListedInPrivateContactList(null)).toBe(false);
  });

  it('synthesizes a fallback current epoch entry when the current key is missing from history', () => {
    const epochEntries = resolveGroupChatEpochEntries({
      type: 'group',
      meta: {
        group_epoch_keys: [
          {
            epoch_number: 1,
            epoch_public_key: EPOCH_KEY_B,
            epoch_private_key_encrypted: 'enc-1',
          },
        ],
        current_epoch_public_key: EPOCH_KEY_C,
        current_epoch_private_key_encrypted: 'enc-current',
      },
    } as never);

    expect(epochEntries[0]).toMatchObject({
      epoch_number: 1,
      epoch_public_key: EPOCH_KEY_C,
      epoch_private_key_encrypted: 'enc-current',
    });
  });

  it('detects a higher known epoch conflict and reports the older applicable higher epoch', () => {
    const conflict = findHigherKnownGroupEpochConflict(
      {
        type: 'group',
        meta: {
          group_epoch_keys: [
            {
              epoch_number: 2,
              epoch_public_key: EPOCH_KEY_C,
              epoch_private_key_encrypted: 'enc-2',
              invitation_created_at: '2026-01-04T00:00:00.000Z',
            },
            {
              epoch_number: 1,
              epoch_public_key: EPOCH_KEY_B,
              epoch_private_key_encrypted: 'enc-1',
              invitation_created_at: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      } as never,
      0,
      '2026-01-03T00:00:00.000Z'
    );

    expect(conflict).toMatchObject({
      higherEpochEntry: {
        epoch_number: 2,
        epoch_public_key: EPOCH_KEY_C,
      },
      olderHigherEpochEntry: {
        epoch_number: 1,
        epoch_public_key: EPOCH_KEY_B,
      },
    });
  });

  it('picks the first timestamped higher epoch when an incoming invite has no created-at value', () => {
    const conflict = findHigherKnownGroupEpochConflict(
      {
        type: 'group',
        meta: {
          group_epoch_keys: [
            {
              epoch_number: 3,
              epoch_public_key: EPOCH_KEY_C,
              epoch_private_key_encrypted: 'enc-3',
            },
            {
              epoch_number: 2,
              epoch_public_key: EPOCH_KEY_B,
              epoch_private_key_encrypted: 'enc-2',
              invitation_created_at: '2026-01-03T00:00:00.000Z',
            },
            {
              epoch_number: 1,
              epoch_public_key: EPOCH_KEY_A,
              epoch_private_key_encrypted: 'enc-1',
              invitation_created_at: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      } as never,
      0,
      null
    );

    expect(conflict).toMatchObject({
      higherEpochEntry: {
        epoch_number: 3,
        epoch_public_key: EPOCH_KEY_C,
      },
      olderHigherEpochEntry: {
        epoch_number: 2,
        epoch_public_key: EPOCH_KEY_B,
      },
    });
  });

  it('detects conflicting epoch public keys for the same epoch number', () => {
    expect(
      findConflictingKnownGroupEpochNumber(
        {
          type: 'group',
          meta: {
            group_epoch_keys: [
              {
                epoch_number: 3,
                epoch_public_key: EPOCH_KEY_A,
                epoch_private_key_encrypted: 'enc-3',
              },
            ],
          },
        } as never,
        3,
        EPOCH_KEY_B
      )
    ).toMatchObject({
      epoch_number: 3,
      epoch_public_key: EPOCH_KEY_A,
    });
  });

  it('does not flag conflicts when the same epoch number arrives with the same key', () => {
    expect(
      findConflictingKnownGroupEpochNumber(
        {
          type: 'group',
          meta: {
            group_epoch_keys: [
              {
                epoch_number: 3,
                epoch_public_key: EPOCH_KEY_A,
                epoch_private_key_encrypted: 'enc-3',
              },
            ],
          },
        } as never,
        3,
        EPOCH_KEY_A
      )
    ).toBeNull();
  });

  it('builds contact metadata from refreshed profile fields while preserving existing values', () => {
    expect(
      buildUpdatedContactMeta(
        {
          picture: 'https://example.com/old.png',
          lud16: 'alice@old.example',
        } as never,
        {
          name: 'Alice',
          about: 'Updated bio',
          picture: 'https://example.com/new.png',
          display_name: 'Alice Cooper',
          bot: true,
        } as never,
        'npub1alice',
        'nprofile1alice'
      )
    ).toEqual({
      name: 'Alice',
      about: 'Updated bio',
      picture: 'https://example.com/new.png',
      display_name: 'Alice Cooper',
      lud16: 'alice@old.example',
      bot: true,
      npub: 'npub1alice',
      nprofile: 'nprofile1alice',
    });
  });

  it('builds unique contact identifiers and compares normalized contact state', () => {
    expect(
      buildIdentifierFallbacks('f'.repeat(64), {
        nip05: 'alice@example.com',
        npub: 'npub1alice',
        nprofile: 'nprofile1alice',
      } as never)
    ).toEqual(['alice@example.com', 'npub1alice', 'f'.repeat(64), 'nprofile1alice']);

    expect(
      contactRelayListsEqual(
        [
          { url: 'wss://relay.example', read: true, write: false },
          { url: 'wss://relay.example/', read: false, write: true },
        ] as never,
        [{ url: 'wss://relay.example/', read: true, write: true }] as never
      )
    ).toBe(true);

    expect(
      contactMetadataEqual(
        {
          name: ' Alice ',
          owner_public_key: 'A'.repeat(64),
        } as never,
        {
          name: 'Alice',
          owner_public_key: 'a'.repeat(64),
        } as never
      )
    ).toBe(true);
  });

  it('preserves existing group relays when a refresh yields no new relays', () => {
    expect(
      shouldPreserveExistingGroupRelays(
        {
          type: 'group',
          public_key: 'group',
          relays: [{ url: 'wss://relay.example/', read: true, write: true }],
        } as never,
        []
      )
    ).toBe(true);

    expect(
      shouldPreserveExistingGroupRelays(
        {
          type: 'user',
          public_key: 'user',
          relays: [{ url: 'wss://relay.example/', read: true, write: true }],
        } as never,
        []
      )
    ).toBe(false);
  });

  it('keeps blocked first-contact chats blocked forever unless the chat is explicitly accepted', () => {
    expect(
      resolveIncomingChatInboxState({
        chat: {
          meta: {
            inbox_state: 'blocked',
          },
        } as never,
        isAcceptedContact: false,
      })
    ).toBe('blocked');

    expect(
      resolveIncomingChatInboxState({
        chat: {
          meta: {
            accepted_at: '2026-01-02T00:00:00.000Z',
          },
        } as never,
        isAcceptedContact: false,
      })
    ).toBe('accepted');

    expect(
      resolveIncomingChatInboxState({
        chat: {
          meta: {},
        } as never,
        isAcceptedContact: false,
      })
    ).toBe('request');
  });

  it('treats any prior outgoing activity as an accepted inbox-state signal', () => {
    expect(
      resolveIncomingChatInboxState({
        chat: {
          meta: {
            inbox_state: 'blocked',
            last_outgoing_message_at: '2026-01-03T00:00:00.000Z',
          },
        } as never,
        isAcceptedContact: false,
      })
    ).toBe('accepted');
  });

  it('treats accepted contacts as accepted even before inbox metadata is written', () => {
    expect(
      resolveIncomingChatInboxState({
        chat: {
          meta: {},
        } as never,
        isAcceptedContact: true,
      })
    ).toBe('accepted');
  });

  it('builds group invite request updates only for request-state chats', () => {
    expect(
      buildGroupInviteRequestPlan({
        groupPublicKey: EPOCH_KEY_A,
        createdAt: '2026-01-05T00:00:00.000Z',
        existingChat: null,
        preview: {
          name: 'Ignored name',
          meta: {
            display_name: 'Group Preview',
            picture: 'https://example.com/group.png',
          },
        } as never,
      })
    ).toMatchObject({
      shouldCreate: true,
      nextName: 'Group Preview',
      nextUnreadCount: 1,
      nextMeta: {
        contact_name: 'Group Preview',
        picture: 'https://example.com/group.png',
        request_type: 'group_invite',
        request_message: 'This is an invitation to a group.',
        last_incoming_message_at: '2026-01-05T00:00:00.000Z',
      },
    });

    expect(
      buildGroupInviteRequestPlan({
        groupPublicKey: EPOCH_KEY_A,
        createdAt: '2026-01-05T00:00:00.000Z',
        existingChat: {
          name: 'Existing',
          unread_count: 2,
          meta: {
            inbox_state: 'blocked',
          },
        } as never,
        preview: null,
      })
    ).toBeNull();
  });

  it('updates existing request-state invite chats without dropping prior metadata', () => {
    expect(
      buildGroupInviteRequestPlan({
        groupPublicKey: EPOCH_KEY_A,
        createdAt: '2026-01-06T00:00:00.000Z',
        existingChat: {
          name: 'Existing Group',
          unread_count: 2,
          meta: {
            custom_flag: true,
            last_incoming_message_at: '2026-01-04T00:00:00.000Z',
          },
        } as never,
        preview: {
          name: 'Preview Name',
          meta: {
            display_name: 'Preview Display',
            picture: 'https://example.com/preview.png',
          },
        } as never,
      })
    ).toMatchObject({
      shouldCreate: false,
      nextName: 'Preview Display',
      nextUnreadCount: 3,
      nextMeta: {
        custom_flag: true,
        contact_name: 'Preview Display',
        picture: 'https://example.com/preview.png',
        request_type: 'group_invite',
        request_message: 'This is an invitation to a group.',
        last_incoming_message_at: '2026-01-06T00:00:00.000Z',
      },
    });
  });

  it('builds accepted group invite chat updates that clear request metadata and preserve acceptance state', () => {
    expect(
      buildAcceptedGroupInviteChatPlan({
        groupPublicKey: EPOCH_KEY_A,
        fallbackName: 'Accepted Group',
        existingChat: {
          name: 'Pending Group',
          meta: {
            custom_flag: true,
            request_type: 'group_invite',
            request_message: 'This is an invitation to a group.',
            inbox_state: 'accepted',
            accepted_at: '2026-01-07T00:00:00.000Z',
            last_incoming_message_at: '2026-01-06T00:00:00.000Z',
          },
        } as never,
        acceptedAt: '2026-01-08T00:00:00.000Z',
      })
    ).toEqual({
      nextName: 'Accepted Group',
      nextMeta: {
        custom_flag: true,
        inbox_state: 'accepted',
        accepted_at: '2026-01-07T00:00:00.000Z',
        last_incoming_message_at: '2026-01-06T00:00:00.000Z',
        contact_name: 'Accepted Group',
      },
    });
  });

  it('uses the provided accepted timestamp when accepting a group invite for the first time', () => {
    expect(
      buildAcceptedGroupInviteChatPlan({
        groupPublicKey: EPOCH_KEY_A,
        fallbackName: 'Fresh Group',
        existingChat: {
          name: 'Pending Group',
          meta: {
            request_type: 'group_invite',
            request_message: 'This is an invitation to a group.',
          },
        } as never,
        acceptedAt: '2026-01-09T00:00:00.000Z',
      })
    ).toEqual({
      nextName: 'Fresh Group',
      nextMeta: {
        inbox_state: 'accepted',
        accepted_at: '2026-01-09T00:00:00.000Z',
        contact_name: 'Fresh Group',
      },
    });
  });

  it('reapplying accepted group invite updates is idempotent', () => {
    const firstPlan = buildAcceptedGroupInviteChatPlan({
      groupPublicKey: EPOCH_KEY_A,
      fallbackName: 'Stable Group',
      existingChat: {
        name: 'Pending Group',
        meta: {
          custom_flag: true,
          inbox_state: 'accepted',
          accepted_at: '2026-01-10T00:00:00.000Z',
          contact_name: 'Stable Group',
        },
      } as never,
      acceptedAt: '2026-01-11T00:00:00.000Z',
    });

    expect(firstPlan).not.toBeNull();
    expect(
      buildAcceptedGroupInviteChatPlan({
        groupPublicKey: EPOCH_KEY_A,
        fallbackName: 'Stable Group',
        existingChat: {
          name: firstPlan?.nextName ?? '',
          meta: firstPlan?.nextMeta ?? {},
        } as never,
        acceptedAt: '2026-01-12T00:00:00.000Z',
      })
    ).toEqual(firstPlan);
  });

  it('preserves existing group metadata when accepting an already stored group chat', () => {
    expect(
      buildAcceptedGroupInviteChatPlan({
        groupPublicKey: EPOCH_KEY_A,
        fallbackName: 'Upgraded Group',
        existingChat: {
          name: 'Stored Group',
          meta: {
            avatar: 'UG',
            picture: 'https://example.com/group.png',
            current_epoch_public_key: EPOCH_KEY_B,
            group_epoch_keys: [
              {
                epoch_number: 1,
                epoch_public_key: EPOCH_KEY_B,
                epoch_private_key_encrypted: 'enc-1',
              },
            ],
            accepted_at: '2026-01-13T00:00:00.000Z',
            request_type: 'group_invite',
            request_message: 'This is an invitation to a group.',
          },
        } as never,
        acceptedAt: '2026-01-14T00:00:00.000Z',
      })
    ).toEqual({
      nextName: 'Upgraded Group',
      nextMeta: {
        avatar: 'UG',
        picture: 'https://example.com/group.png',
        current_epoch_public_key: EPOCH_KEY_B,
        group_epoch_keys: [
          {
            epoch_number: 1,
            epoch_public_key: EPOCH_KEY_B,
            epoch_private_key_encrypted: 'enc-1',
          },
        ],
        accepted_at: '2026-01-13T00:00:00.000Z',
        inbox_state: 'accepted',
        contact_name: 'Upgraded Group',
      },
    });
  });

  it('resolves group publish relays from explicit seeds and writable group relays only', () => {
    expect(
      resolveGroupPublishRelayUrls(
        [
          { url: 'wss://group-write.example', read: true, write: true },
          { url: 'wss://group-read-only.example', read: true, write: false },
        ],
        ['wss://seed.example', 'wss://group-write.example/']
      )
    ).toEqual(['wss://seed.example/', 'wss://group-write.example/']);
  });

  it('builds relay-list entries and group previews for contact refresh and invite flows', () => {
    expect(
      relayEntriesFromRelayList({
        readRelayUrls: new Set(['wss://read.example']),
        writeRelayUrls: new Set(['wss://write.example']),
        bothRelayUrls: new Set(['wss://both.example']),
      } as never)
    ).toEqual([
      { url: 'wss://read.example/', read: true, write: false },
      { url: 'wss://write.example/', read: false, write: true },
      { url: 'wss://both.example/', read: true, write: true },
    ]);

    expect(buildAvatarFallback('Alice Cooper')).toBe('AC');
    expect(buildAvatarFallback('group')).toBe('GR');
    expect(resolveGroupDisplayName(EPOCH_KEY_A)).toBe(`Group ${EPOCH_KEY_A.slice(0, 8)}`);
  });
});
