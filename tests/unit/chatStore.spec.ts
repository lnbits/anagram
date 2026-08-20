import { nip19 } from '@nostr-dev-kit/ndk';
import { __chatStoreTestUtils } from 'src/stores/chatStore';
import { describe, expect, it } from 'vitest';

const {
  buildChatSearchText,
  buildAcceptedChatMeta,
  buildBlockedChatMeta,
  buildChatActivitySnapshotByPublicKey,
  buildLastMessageAuthorSnapshotByPublicKey,
  buildUpdatedChatPreview,
  chatMatchesSearch,
  countUnreadMessagesAfter,
  findLatestIncomingMessageAt,
  findLatestIncomingMessageActivity,
  mapChatRowToChat,
  resolveChatCategory,
  resolveDefaultSelectedChatId,
  resolveEffectiveLastSeenReceivedActivityAt,
  resolveMarkAsReadBoundaryAt,
  resolveRequestClearBoundaryAt,
  syncChatActivityMeta,
} = __chatStoreTestUtils;

describe('chatStore logic', () => {
  it('tracks the latest message author per chat with stable timestamp tie-breaking', () => {
    const snapshots = buildLastMessageAuthorSnapshotByPublicKey([
      {
        id: 1,
        chat_public_key: 'GROUP-A',
        author_public_key: 'ALICE',
        message: 'first',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: null,
        meta: {},
      },
      {
        id: 3,
        chat_public_key: 'group-a',
        author_public_key: 'BOB',
        message: 'latest',
        created_at: '2026-01-02T00:00:00.000Z',
        event_id: null,
        meta: {},
      },
      {
        id: 2,
        chat_public_key: 'group-a',
        author_public_key: 'CHARLIE',
        message: 'same timestamp, older row',
        created_at: '2026-01-02T00:00:00.000Z',
        event_id: null,
        meta: {},
      },
    ]);

    expect(snapshots.get('group-a')).toEqual({
      authorPublicKey: 'bob',
      at: '2026-01-02T00:00:00.000Z',
      rowId: 3,
    });
  });

  it('classifies blocked chats ahead of accepted and request states', () => {
    expect(
      resolveChatCategory({
        inbox_state: 'blocked',
        accepted_at: '2026-01-01T00:00:00.000Z',
        last_incoming_message_at: '2026-01-02T00:00:00.000Z',
      })
    ).toBe('blocked');

    expect(
      resolveChatCategory({
        accepted_at: '2026-01-01T00:00:00.000Z',
      })
    ).toBe('chat');

    expect(
      resolveChatCategory({
        last_incoming_message_at: '2026-01-02T00:00:00.000Z',
      })
    ).toBe('request');
  });

  it('hides cleared request chats until a newer incoming message arrives', () => {
    expect(
      resolveChatCategory({
        last_incoming_message_at: '2026-01-02T00:00:00.000Z',
        request_cleared_at: '2026-01-02T00:00:00.000Z',
      })
    ).toBe('hidden');

    expect(
      resolveChatCategory({
        last_incoming_message_at: '2026-01-03T00:00:00.000Z',
        request_cleared_at: '2026-01-02T00:00:00.000Z',
      })
    ).toBe('request');
  });

  it('uses the latest deleted request message as the clear boundary', () => {
    expect(
      resolveRequestClearBoundaryAt(
        {
          last_incoming_message_at: '2026-01-02T00:00:00.000Z',
        },
        [
          {
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            created_at: '2026-01-03T00:00:00.000Z',
          },
        ],
        '2026-01-02T12:00:00.000Z'
      )
    ).toBe('2026-01-03T00:00:00.000Z');
  });

  it('counts only incoming timestamps newer than the seen boundary', () => {
    const timestamps = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ];

    expect(countUnreadMessagesAfter(timestamps, '2026-01-02T00:00:00.000Z')).toBe(1);
    expect(countUnreadMessagesAfter(timestamps, '')).toBe(3);
    expect(countUnreadMessagesAfter(undefined, '2026-01-02T00:00:00.000Z')).toBe(0);
  });

  it('uses the newest chat, contact, or own-message boundary during restore', () => {
    expect(
      resolveEffectiveLastSeenReceivedActivityAt(
        '2026-01-02T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    ).toBe('2026-01-03T00:00:00.000Z');

    expect(
      resolveEffectiveLastSeenReceivedActivityAt(
        '2026-01-04T00:00:00.000Z',
        '2026-01-03T00:00:00.000Z',
        '2026-01-05T00:00:00.000Z'
      )
    ).toBe('2026-01-05T00:00:00.000Z');
  });

  it('resolves the durable mark-as-read boundary from the newest incoming message', () => {
    const rows = [
      {
        id: 1,
        author_public_key: 'me',
        created_at: '2026-01-01T00:00:00.000Z',
        event_id: 'own-event',
      },
      {
        id: 2,
        author_public_key: 'them',
        created_at: '2026-01-02T00:00:00.000Z',
        event_id: 'older-event',
      },
      {
        id: 3,
        author_public_key: 'them',
        created_at: '2026-01-03T00:00:00.000Z',
        event_id: 'latest-event',
        meta: {},
      },
      {
        id: 4,
        author_public_key: 'group',
        created_at: '2026-01-04T00:00:00.000Z',
        event_id: 'epoch-event',
        meta: {
          kind: 1014,
          group_epoch_notice: {
            epochNumber: 1,
          },
        },
      },
    ] as never;
    const latestIncomingActivity = findLatestIncomingMessageActivity(rows, 'me');
    const latestIncomingMessageAt = findLatestIncomingMessageAt(rows, 'me');

    expect(latestIncomingActivity).toEqual({
      at: '2026-01-03T00:00:00.000Z',
      eventId: 'latest-event',
    });
    expect(latestIncomingMessageAt).toBe('2026-01-03T00:00:00.000Z');
    expect(
      resolveMarkAsReadBoundaryAt(
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        latestIncomingMessageAt
      )
    ).toBe('2026-01-03T00:00:00.000Z');
    expect(
      resolveMarkAsReadBoundaryAt(
        '2026-01-03T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        latestIncomingMessageAt
      )
    ).toBe('');
    expect(
      resolveMarkAsReadBoundaryAt('2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '')
    ).toBe('2026-01-04T00:00:00.000Z');
  });

  it('promotes a request chat to accepted when an outgoing message appears', () => {
    const nextMeta = syncChatActivityMeta(
      {
        last_incoming_message_at: '2026-01-01T00:00:00.000Z',
        request_cleared_at: '2026-01-02T00:00:00.000Z',
      },
      {
        lastIncomingMessageAt: '2026-01-02T00:00:00.000Z',
        lastOutgoingMessageAt: '2026-01-03T00:00:00.000Z',
      }
    );

    expect(nextMeta).toMatchObject({
      inbox_state: 'accepted',
      accepted_at: '2026-01-03T00:00:00.000Z',
      last_incoming_message_at: '2026-01-02T00:00:00.000Z',
      last_outgoing_message_at: '2026-01-03T00:00:00.000Z',
    });
    expect(nextMeta).not.toHaveProperty('request_cleared_at');
  });

  it('does not unblock a blocked chat just because a later outgoing snapshot exists', () => {
    const originalMeta = {
      inbox_state: 'blocked',
      blocked_at: '2026-01-01T00:00:00.000Z',
      last_incoming_message_at: '2026-01-01T00:00:00.000Z',
    };

    const nextMeta = syncChatActivityMeta(originalMeta, {
      lastIncomingMessageAt: '',
      lastOutgoingMessageAt: '2026-01-03T00:00:00.000Z',
    });

    expect(nextMeta).toEqual(originalMeta);
    expect(nextMeta).not.toHaveProperty('last_outgoing_message_at');
  });

  it('builds the latest incoming and outgoing activity snapshot per chat', () => {
    const snapshots = buildChatActivitySnapshotByPublicKey(
      [
        {
          chat_public_key: 'chat-a',
          author_public_key: 'me',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          chat_public_key: 'chat-a',
          author_public_key: 'them',
          created_at: '2026-01-02T00:00:00.000Z',
        },
        {
          chat_public_key: 'chat-a',
          author_public_key: 'them',
          created_at: '2026-01-03T00:00:00.000Z',
          meta: {},
        },
        {
          chat_public_key: 'chat-a',
          author_public_key: 'group',
          created_at: '2026-01-05T00:00:00.000Z',
          meta: {
            kind: 1014,
            group_epoch_notice: {
              epochNumber: 1,
            },
          },
        },
        {
          chat_public_key: 'chat-b',
          author_public_key: 'me',
          created_at: '2026-01-04T00:00:00.000Z',
        },
      ] as never,
      'me'
    );

    expect(snapshots.get('chat-a')).toEqual({
      lastIncomingMessageAt: '2026-01-03T00:00:00.000Z',
      lastOutgoingMessageAt: '2026-01-01T00:00:00.000Z',
    });
    expect(snapshots.get('chat-b')).toEqual({
      lastIncomingMessageAt: '',
      lastOutgoingMessageAt: '2026-01-04T00:00:00.000Z',
    });
  });

  it('builds accepted chat metadata from reply state without keeping blocked markers', () => {
    expect(
      buildAcceptedChatMeta(
        {
          inbox_state: 'blocked',
          blocked_at: '2026-01-01T00:00:00.000Z',
          last_outgoing_message_at: '2026-01-01T00:00:00.000Z',
        },
        '2026-01-03T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      )
    ).toEqual({
      inbox_state: 'accepted',
      accepted_at: '2026-01-03T00:00:00.000Z',
      last_seen_received_activity_at: '2026-01-02T00:00:00.000Z',
      last_outgoing_message_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('builds blocked chat metadata and preview updates with the right unread behavior', () => {
    expect(
      buildBlockedChatMeta(
        {
          inbox_state: 'accepted',
          accepted_at: '2026-01-01T00:00:00.000Z',
        },
        '2026-01-04T00:00:00.000Z'
      )
    ).toEqual({
      inbox_state: 'blocked',
      accepted_at: '2026-01-01T00:00:00.000Z',
      blocked_at: '2026-01-04T00:00:00.000Z',
    });

    expect(
      buildUpdatedChatPreview(
        {
          id: 'chat-a',
          publicKey: 'chat-a',
          epochPublicKey: null,
          type: 'user',
          name: 'Alice',
          avatar: 'A',
          lastMessage: 'old',
          lastMessageAt: '2026-01-01T00:00:00.000Z',
          unreadCount: 3,
          meta: {},
        },
        'new',
        '2026-01-05T00:00:00.000Z',
        true
      ).unreadCount
    ).toBe(0);

    expect(
      buildUpdatedChatPreview(
        {
          id: 'chat-a',
          publicKey: 'chat-a',
          epochPublicKey: null,
          type: 'user',
          name: 'Alice',
          avatar: 'A',
          lastMessage: 'old',
          lastMessageAt: '2026-01-01T00:00:00.000Z',
          unreadCount: 3,
          meta: {},
        },
        'new',
        '2026-01-05T00:00:00.000Z',
        false
      ).unreadCount
    ).toBe(3);
  });

  it('uses Picture for image-only chat previews and keeps captions', () => {
    const chat = {
      id: 'chat-a',
      publicKey: 'chat-a',
      epochPublicKey: null,
      type: 'user',
      name: 'Alice',
      avatar: 'A',
      lastMessage: 'old',
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      unreadCount: 0,
      meta: {},
    };
    const messageMeta = {
      attachments: [
        {
          type: 'media',
          url: 'https://nostr.build/i/example.png',
          mimeType: 'image/png',
          size: 1234,
        },
      ],
    };

    expect(
      buildUpdatedChatPreview(
        chat as never,
        'https://nostr.build/i/example.png',
        '2026-01-05T00:00:00.000Z',
        false,
        messageMeta
      ).lastMessage
    ).toBe('Picture');
    expect(
      buildUpdatedChatPreview(
        chat as never,
        'Vacation https://nostr.build/i/example.png',
        '2026-01-05T00:00:00.000Z',
        false,
        messageMeta
      ).lastMessage
    ).toBe('Vacation');
  });

  it('picks the first accepted chat as the default selection during chat loading', () => {
    expect(
      resolveDefaultSelectedChatId([
        {
          id: 'request-chat',
          publicKey: 'request-chat',
          epochPublicKey: null,
          type: 'user',
          name: 'Request',
          avatar: 'RQ',
          lastMessage: 'request',
          lastMessageAt: '2026-01-03T00:00:00.000Z',
          unreadCount: 1,
          meta: {
            last_incoming_message_at: '2026-01-03T00:00:00.000Z',
          },
        },
        {
          id: 'accepted-chat',
          publicKey: 'accepted-chat',
          epochPublicKey: null,
          type: 'user',
          name: 'Accepted',
          avatar: 'AC',
          lastMessage: 'accepted',
          lastMessageAt: '2026-01-02T00:00:00.000Z',
          unreadCount: 0,
          meta: {
            inbox_state: 'accepted',
            accepted_at: '2026-01-02T00:00:00.000Z',
          },
        },
        {
          id: 'blocked-chat',
          publicKey: 'blocked-chat',
          epochPublicKey: null,
          type: 'user',
          name: 'Blocked',
          avatar: 'BL',
          lastMessage: 'blocked',
          lastMessageAt: '2026-01-01T00:00:00.000Z',
          unreadCount: 0,
          meta: {
            inbox_state: 'blocked',
          },
        },
      ] as never)
    ).toBe('accepted-chat');

    expect(
      resolveDefaultSelectedChatId([
        {
          id: 'only-request',
          publicKey: 'only-request',
          epochPublicKey: null,
          type: 'user',
          name: 'Only Request',
          avatar: 'OR',
          lastMessage: 'request',
          lastMessageAt: '2026-01-03T00:00:00.000Z',
          unreadCount: 1,
          meta: {
            last_incoming_message_at: '2026-01-03T00:00:00.000Z',
          },
        },
      ] as never)
    ).toBeNull();
  });

  it('builds chat search text and matches queries from names, keys, and previews', () => {
    const chat = {
      id: 'chat-a',
      publicKey: 'abcdef1234567890',
      epochPublicKey: null,
      type: 'user',
      name: 'Alice Contact',
      avatar: 'AC',
      lastMessage: 'Latest preview text',
      lastMessageAt: '2026-01-05T00:00:00.000Z',
      unreadCount: 0,
      meta: {
        given_name: 'Ali',
        contact_name: 'Alice Cooper',
      },
    };

    expect(buildChatSearchText(chat as never)).toContain('alice contact');
    expect(buildChatSearchText(chat as never)).toContain('abcdef1234567890');
    expect(chatMatchesSearch(chat as never, 'cooper')).toBe(true);
    expect(chatMatchesSearch(chat as never, 'latest preview')).toBe(true);
    expect(chatMatchesSearch(chat as never, 'missing')).toBe(false);
  });

  it('maps chat rows using refreshed contact context during chat loading', () => {
    expect(
      mapChatRowToChat(
        {
          public_key: 'group-chat',
          type: 'group',
          name: 'Fallback Group',
          last_message: 'hello',
          last_message_at: '2026-01-05T00:00:00.000Z',
          unread_count: 2,
          meta: {
            current_epoch_public_key: 'epoch-key',
          },
        } as never,
        {
          picture: 'https://example.com/group.png',
          givenName: 'Alpha Team',
          contactName: 'Alpha Group',
          groupMembers: [],
          lastSeenIncomingActivityAt: '2026-01-04T00:00:00.000Z',
        }
      )
    ).toMatchObject({
      id: 'group-chat',
      publicKey: 'group-chat',
      epochPublicKey: 'epoch-key',
      type: 'group',
      name: 'Alpha Group',
      avatar: 'AT',
      lastMessage: 'hello',
      lastMessageAt: '2026-01-05T00:00:00.000Z',
      unreadCount: 2,
      meta: {
        picture: 'https://example.com/group.png',
        given_name: 'Alpha Team',
        contact_name: 'Alpha Group',
        last_seen_received_activity_at: '2026-01-04T00:00:00.000Z',
        avatar: 'AT',
        current_epoch_public_key: 'epoch-key',
      },
    });
  });

  it('formats NIP-27 mentions in mapped group chat previews', () => {
    const bobPubkey = 'b'.repeat(64);
    const nprofile = nip19.nprofileEncode({
      pubkey: bobPubkey,
      relays: ['wss://group.example'],
    });

    expect(
      mapChatRowToChat(
        {
          public_key: 'group-chat',
          type: 'group',
          name: 'Fallback Group',
          last_message: `nostr:${nprofile} hello`,
          last_message_at: '2026-01-05T00:00:00.000Z',
          unread_count: 1,
          meta: {},
        } as never,
        {
          picture: '',
          givenName: 'Alpha Team',
          contactName: 'Alpha Group',
          groupMembers: [
            {
              public_key: bobPubkey,
              name: 'Bob Member',
              given_name: 'Bobby',
            },
          ],
          lastSeenIncomingActivityAt: '',
        }
      ).lastMessage
    ).toBe('@Bobby hello');
  });
});
