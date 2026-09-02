import { nip19 } from '@nostr-dev-kit/ndk';
import { __messageStoreTestUtils, MissingContactRelaysError } from 'src/stores/messageStore';
import { describe, expect, it } from 'vitest';

const {
  applyMessageUpsert,
  areReactionListsEqual,
  buildChatMetaWithUnseenReactionCount,
  buildDefaultChatMessagePaginationState,
  buildDeletedMessageMeta,
  buildForwardedMessagePayload,
  buildInitialMessageWindowFromUnreadAnchor,
  buildMessageCursorFromMessage,
  buildMessageCursorFromSearchResult,
  compareMessageCursors,
  countUnreadMessageRowsAfterBoundary,
  countOwnUnseenReactions,
  isOptimisticMessageId,
  mapMessageRowToMessage,
  mergeLoadedMessagesWithLocalOutbound,
  mergeMessagesById,
  readUnseenReactionCountFromMeta,
  resolveChatDeliveryTarget,
  resolveChatRecipientPublicKey,
  resolveLatestOwnMessageAt,
  resolveReplyTargetEventId,
  resolveSendRelayUrls,
  takeLeadingRowsWithAuthor,
  takeTrailingRowsWithAuthor,
} = __messageStoreTestUtils;

describe('messageStore logic', () => {
  it('adds and clears unseen reaction counts in chat metadata', () => {
    expect(buildChatMetaWithUnseenReactionCount({ name: 'chat' }, 3)).toEqual({
      name: 'chat',
      unseen_reaction_count: 3,
    });

    expect(
      buildChatMetaWithUnseenReactionCount({ unseen_reaction_count: 2, name: 'chat' }, 0)
    ).toEqual({
      name: 'chat',
    });

    expect(readUnseenReactionCountFromMeta({ unseen_reaction_count: '4' })).toBe(4);
    expect(readUnseenReactionCountFromMeta({ unseen_reaction_count: 'bad' })).toBe(0);
  });

  it('compares message cursors by timestamp first and id second', () => {
    expect(
      compareMessageCursors(
        { id: 1, created_at: '2026-01-01T00:00:00.000Z' },
        { id: 2, created_at: '2026-01-02T00:00:00.000Z' }
      )
    ).toBeLessThan(0);

    expect(
      compareMessageCursors(
        { id: 1, created_at: '2026-01-02T00:00:00.000Z' },
        { id: 2, created_at: '2026-01-02T00:00:00.000Z' }
      )
    ).toBeLessThan(0);
  });

  it('deduplicates merged messages by id and keeps chronological order', () => {
    const merged = mergeMessagesById(
      [
        {
          id: '2',
          chatId: 'chat',
          text: 'older',
          sender: 'them',
          sentAt: '2026-01-02T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
        {
          id: '3',
          chatId: 'chat',
          text: 'newest',
          sender: 'me',
          sentAt: '2026-01-03T00:00:00.000Z',
          authorPublicKey: 'a',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
      ],
      [
        {
          id: '1',
          chatId: 'chat',
          text: 'oldest',
          sender: 'them',
          sentAt: '2026-01-01T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
        {
          id: '2',
          chatId: 'chat',
          text: 'older-edited',
          sender: 'them',
          sentAt: '2026-01-02T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {
            edited: true,
          },
        },
      ]
    );

    expect(merged.map((message) => message.id)).toEqual(['1', '2', '3']);
    expect(merged.find((message) => message.id === '2')?.meta).toEqual({ edited: true });
  });

  it('identifies optimistic local message ids', () => {
    expect(isOptimisticMessageId('optimistic-1')).toBe(true);
    expect(isOptimisticMessageId('12')).toBe(false);
    expect(isOptimisticMessageId(null)).toBe(false);
  });

  it('keeps unpublished outbound messages when a later load would otherwise replace them', () => {
    const loaded = [
      {
        id: '1',
        chatId: 'chat',
        text: 'history',
        sender: 'them' as const,
        sentAt: '2026-01-01T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: 'e'.repeat(64),
        nostrEvent: null,
        meta: {},
      },
    ];
    const existing = [
      loaded[0],
      {
        id: 'optimistic-99',
        chatId: 'chat',
        text: 'just sent',
        sender: 'me' as const,
        sentAt: '2026-01-02T00:00:00.000Z',
        authorPublicKey: 'a',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        id: '8',
        chatId: 'chat',
        text: 'persisted unpublished',
        sender: 'me' as const,
        sentAt: '2026-01-03T00:00:00.000Z',
        authorPublicKey: 'a',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
    ];

    expect(
      mergeLoadedMessagesWithLocalOutbound(loaded, existing).map((message) => message.id)
    ).toEqual(['1', 'optimistic-99', '8']);
  });

  it('builds forwarded payloads without original reply or event provenance metadata', () => {
    expect(
      buildForwardedMessagePayload({
        text: '  hello https://cdn.example/pic.png  ',
        meta: {
          reply: {
            messageId: '1',
            text: 'original thread',
            sender: 'them',
            authorName: 'Alice',
            authorPublicKey: 'a'.repeat(64),
            sentAt: '2026-01-01T00:00:00.000Z',
            eventId: 'e'.repeat(64),
          },
          source: 'nostr',
          wrapper_event_id: 'w'.repeat(64),
          attachments: [
            {
              type: 'media',
              url: 'https://cdn.example/pic.png',
              mimeType: 'image/png',
              size: 4096,
              sha256: 'ABCDEF',
            },
            {
              type: 'media',
              url: 'https://cdn.example/pic.png',
              mimeType: 'image/png',
              size: 4096,
            },
          ],
        },
      })
    ).toEqual({
      text: 'hello https://cdn.example/pic.png',
      meta: {
        attachments: [
          {
            type: 'media',
            url: 'https://cdn.example/pic.png',
            mimeType: 'image/png',
            size: 4096,
            sha256: 'abcdef',
          },
        ],
      },
      additionalTags: [
        ['imeta', 'url https://cdn.example/pic.png', 'm image/png', 'size 4096', 'x abcdef'],
      ],
    });
  });

  it('does not build forwarded payloads for empty message content', () => {
    expect(
      buildForwardedMessagePayload({
        text: '   ',
        meta: {},
      })
    ).toBeNull();
  });

  it('keeps contiguous author runs at both pagination boundaries', () => {
    const rows = [
      { author_public_key: 'alice' },
      { author_public_key: 'alice' },
      { author_public_key: 'bob' },
      { author_public_key: 'bob' },
    ];

    expect(takeLeadingRowsWithAuthor(rows as never, 'alice')).toHaveLength(2);
    expect(takeTrailingRowsWithAuthor(rows as never, 'bob')).toHaveLength(2);
    expect(takeLeadingRowsWithAuthor(rows as never, 'bob')).toHaveLength(0);
  });

  it('resolves delivery targets for user chats, group chats, and deleted metadata', () => {
    expect(
      resolveChatRecipientPublicKey({
        public_key: 'user-chat',
        type: 'user',
        meta: {},
      } as never)
    ).toBe('user-chat');

    expect(
      resolveChatRecipientPublicKey({
        public_key: 'group-chat',
        type: 'group',
        meta: {
          current_epoch_public_key: 'ABCD',
        },
      } as never)
    ).toBe('abcd');

    expect(
      resolveChatRecipientPublicKey({
        public_key: 'group-chat',
        type: 'group',
        meta: {},
      } as never)
    ).toBe('');

    expect(buildDeletedMessageMeta('author', 5, '2026-01-02T00:00:00.000Z', 'ABC123')).toEqual({
      deletedAt: '2026-01-02T00:00:00.000Z',
      deletedByPublicKey: 'author',
      deletedEventKind: 5,
      deleteEventId: 'abc123',
    });

    expect(buildDeletedMessageMeta('author', 5, '2026-01-02T00:00:00.000Z', '   ')).toEqual({
      deletedAt: '2026-01-02T00:00:00.000Z',
      deletedByPublicKey: 'author',
      deletedEventKind: 5,
    });

    expect(
      buildMessageCursorFromMessage({
        id: '12',
        sentAt: '2026-01-02T00:00:00.000Z',
      })
    ).toEqual({
      id: 12,
      created_at: '2026-01-02T00:00:00.000Z',
    });

    expect(
      buildMessageCursorFromSearchResult({
        id: 7,
        created_at: '2026-01-03T00:00:00.000Z',
      } as never)
    ).toEqual({
      id: 7,
      created_at: '2026-01-03T00:00:00.000Z',
    });
  });

  it('resolves send relays from explicit inputs and throws the right missing-relay errors', () => {
    expect(
      resolveSendRelayUrls({
        chatPublicKey: 'chat-pubkey',
        relayUrls: [' ws://relay.example ', 'ws://relay.example/'],
        recipientRelayUrls: ['wss://ignored.example'],
      })
    ).toEqual(['ws://relay.example', 'ws://relay.example/']);

    expect(() =>
      resolveSendRelayUrls({
        chatPublicKey: 'chat-pubkey',
        relayUrls: ['   '],
      })
    ).toThrow('Cannot send encrypted event without application relays.');

    expect(() =>
      resolveSendRelayUrls({
        chatPublicKey: 'chat-pubkey',
        recipientRelayUrls: [],
      })
    ).toThrow(MissingContactRelaysError);
  });

  it('builds chat delivery targets for user and group chats and rejects groups without a current epoch', () => {
    expect(
      resolveChatDeliveryTarget(
        {
          public_key: 'user-chat',
          type: 'user',
          meta: {},
        } as never,
        {
          recipientRelayUrls: ['wss://contact.example'],
        }
      )
    ).toMatchObject({
      recipientPublicKey: 'user-chat',
      relayUrls: ['wss://contact.example'],
      publishSelfCopy: true,
    });

    expect(
      resolveChatDeliveryTarget(
        {
          public_key: 'group-chat',
          type: 'group',
          meta: {
            current_epoch_public_key: 'ABCD',
          },
        } as never,
        {
          recipientRelayUrls: ['wss://group.example'],
        }
      )
    ).toMatchObject({
      recipientPublicKey: 'abcd',
      relayUrls: ['wss://group.example'],
      publishSelfCopy: false,
    });

    expect(() =>
      resolveChatDeliveryTarget(
        {
          public_key: 'group-chat',
          type: 'group',
          meta: {},
        } as never,
        {
          recipientRelayUrls: ['wss://group.example'],
        }
      )
    ).toThrow('Group chat is missing the current epoch public key.');

    expect(
      resolveChatDeliveryTarget(null, {
        recipientRelayUrls: ['wss://group.example'],
      })
    ).toBeNull();
  });

  it('does not publish a backup self-copy when the selected chat is the logged-in user', () => {
    const originalWindow = globalThis.window;

    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (key: string) => (key === 'npub' ? 'self-chat' : null),
        },
      },
      configurable: true,
    });

    try {
      expect(
        resolveChatDeliveryTarget(
          {
            public_key: 'self-chat',
            type: 'user',
            meta: {},
          } as never,
          {
            recipientRelayUrls: ['wss://self.example'],
          }
        )
      ).toMatchObject({
        recipientPublicKey: 'self-chat',
        relayUrls: ['wss://self.example'],
        publishSelfCopy: false,
      });
    } finally {
      if (typeof originalWindow === 'undefined') {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: originalWindow,
          configurable: true,
        });
      }
    }
  });

  it('prefers direct reply event ids and otherwise falls back to persisted message event ids', () => {
    expect(
      resolveReplyTargetEventId(
        {
          messageId: '12',
          eventId: ' ABC123 ',
        } as never,
        'def456'
      )
    ).toBe('abc123');

    expect(
      resolveReplyTargetEventId(
        {
          messageId: '12',
          eventId: '   ',
        } as never,
        ' DEF456 '
      )
    ).toBe('def456');

    expect(
      resolveReplyTargetEventId(
        {
          messageId: '0',
          eventId: null,
        } as never,
        ' DEF456 '
      )
    ).toBeNull();
  });

  it('counts unseen reactions only on messages authored by the logged-in user', () => {
    expect(
      countOwnUnseenReactions(
        [
          {
            author_public_key: 'me',
            meta: {
              reactions: [
                {
                  emoji: '👍',
                  name: 'thumbs up',
                  reactorPublicKey: 'other-user',
                },
                {
                  emoji: '🔥',
                  name: 'fire',
                  reactorPublicKey: 'me',
                },
              ],
            },
          },
          {
            author_public_key: 'them',
            meta: {
              reactions: [
                {
                  emoji: '👍',
                  name: 'thumbs up',
                  reactorPublicKey: 'another-user',
                },
              ],
            },
          },
        ] as never,
        'me'
      )
    ).toBe(1);
  });

  it('resolves the latest own message timestamp for read-boundary sync', () => {
    expect(
      resolveLatestOwnMessageAt(
        [
          {
            author_public_key: 'them',
            created_at: '2026-01-04T00:00:00.000Z',
          },
          {
            author_public_key: 'ME',
            created_at: '2026-01-02T00:00:00.000Z',
          },
          {
            author_public_key: 'me',
            created_at: '2026-01-03T00:00:00.000Z',
          },
        ] as never,
        'me'
      )
    ).toBe('2026-01-03T00:00:00.000Z');

    expect(resolveLatestOwnMessageAt([] as never, null)).toBe('');
  });

  it('excludes group epoch notices from unread message row counts', () => {
    expect(
      countUnreadMessageRowsAfterBoundary(
        [
          {
            author_public_key: 'them',
            created_at: '2026-01-02T00:00:00.000Z',
            meta: {},
          },
          {
            author_public_key: 'group',
            created_at: '2026-01-03T00:00:00.000Z',
            meta: {
              kind: 1014,
              group_epoch_notice: {
                epochNumber: 1,
              },
            },
          },
          {
            author_public_key: 'me',
            created_at: '2026-01-04T00:00:00.000Z',
            meta: {},
          },
        ] as never,
        'me',
        '2026-01-01T00:00:00.000Z'
      )
    ).toBe(1);
  });

  it('derives mention metadata when restored rows are mapped', () => {
    const originalWindow = globalThis.window;
    const loggedInPublicKey = 'd'.repeat(64);
    const mentionedNpub = `nostr:${nip19.npubEncode(loggedInPublicKey)}`;

    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: (key: string) => (key === 'npub' ? loggedInPublicKey : null),
        },
      },
      configurable: true,
    });

    try {
      const message = mapMessageRowToMessage(
        {
          id: 7,
          chat_public_key: 'chat',
          author_public_key: 'e'.repeat(64),
          message: `hi ${mentionedNpub}`,
          created_at: '2026-01-02T00:00:00.000Z',
          event_id: 'event',
          meta: {
            source: 'nostr',
          },
        } as never,
        'chat'
      );

      expect(message.meta).toEqual({
        source: 'nostr',
        mentions: [
          {
            publicKey: loggedInPublicKey,
          },
        ],
        mentions_me: true,
      });
    } finally {
      if (typeof originalWindow === 'undefined') {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          value: originalWindow,
          configurable: true,
        });
      }
    }
  });

  it('treats missing logged-in identity as a startup-safe zero for unseen reactions', () => {
    expect(
      countOwnUnseenReactions(
        [
          {
            author_public_key: 'me',
            meta: {
              reactions: [
                {
                  emoji: '👍',
                  name: 'thumbs up',
                  reactorPublicKey: 'other-user',
                },
              ],
            },
          },
        ] as never,
        null
      )
    ).toBe(0);
  });

  it('treats viewed reactions as seen and recognizes no-op reaction lists', () => {
    expect(
      countOwnUnseenReactions(
        [
          {
            author_public_key: 'me',
            meta: {
              reactions: [
                {
                  emoji: '👍',
                  name: 'thumbs up',
                  reactorPublicKey: 'other-user',
                  viewedByAuthorAt: '2026-01-03T00:00:00.000Z',
                },
              ],
            },
          },
        ] as never,
        'me'
      )
    ).toBe(0);

    expect(
      areReactionListsEqual(
        [
          {
            emoji: '👍',
            name: 'thumbs up',
            reactorPublicKey: 'alice',
            eventId: 'abc',
          },
        ] as never,
        [
          {
            emoji: '👍',
            name: 'thumbs up',
            reactorPublicKey: 'alice',
            eventId: 'abc',
          },
        ] as never
      )
    ).toBe(true);

    expect(
      areReactionListsEqual(
        [
          {
            emoji: '👍',
            name: 'thumbs up',
            reactorPublicKey: 'alice',
            eventId: 'abc',
          },
        ] as never,
        [
          {
            emoji: '🔥',
            name: 'fire',
            reactorPublicKey: 'alice',
            eventId: 'abc',
          },
        ] as never
      )
    ).toBe(false);
  });

  it('builds the initial unread message window around the first unread anchor', () => {
    expect(
      buildInitialMessageWindowFromUnreadAnchor(
        [
          { id: 1, message: 'older-1' },
          { id: 2, message: 'older-2' },
        ] as never,
        { id: 3, message: 'first-unread' } as never,
        [
          { id: 4, message: 'newer-1' },
          { id: 5, message: 'newer-2' },
        ] as never,
        true,
        false
      )
    ).toMatchObject({
      hasOlder: true,
      hasNewer: false,
      rows: [
        { id: 1, message: 'older-1' },
        { id: 2, message: 'older-2' },
        { id: 3, message: 'first-unread' },
        { id: 4, message: 'newer-1' },
        { id: 5, message: 'newer-2' },
      ],
    });
  });

  it('ignores out-of-window inserts when pagination says older history is still hidden', () => {
    const existingMessages = [
      {
        id: '2',
        chatId: 'chat',
        text: 'middle',
        sender: 'them',
        sentAt: '2026-01-02T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        id: '3',
        chatId: 'chat',
        text: 'newer',
        sender: 'them',
        sentAt: '2026-01-03T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
    ];

    const result = applyMessageUpsert(
      existingMessages as never,
      {
        oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        newestCursor: { id: 3, created_at: '2026-01-03T00:00:00.000Z' },
        hasOlder: true,
        hasNewer: false,
        isLoadingOlder: false,
        isLoadingNewer: false,
      },
      {
        id: '1',
        chatId: 'chat',
        text: 'older',
        sender: 'them',
        sentAt: '2026-01-01T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        allowOutsideLoadedWindow: false,
      }
    );

    expect(result.ignored).toBe(true);
    expect(result.messages).toEqual(existingMessages);
  });

  it('updates pagination when an in-range or explicitly allowed message is upserted', () => {
    const result = applyMessageUpsert(
      [
        {
          id: '2',
          chatId: 'chat',
          text: 'middle',
          sender: 'them',
          sentAt: '2026-01-02T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
      ] as never,
      {
        oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        newestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        hasOlder: false,
        hasNewer: false,
        isLoadingOlder: false,
        isLoadingNewer: false,
      },
      {
        id: '3',
        chatId: 'chat',
        text: 'newer',
        sender: 'them',
        sentAt: '2026-01-03T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        allowOutsideLoadedWindow: false,
      }
    );

    expect(result.ignored).toBe(false);
    expect(result.messages.map((message) => message.id)).toEqual(['2', '3']);
    expect(result.paginationState.newestCursor).toEqual({
      id: 3,
      created_at: '2026-01-03T00:00:00.000Z',
    });
  });

  it('ignores newer inserts when the loaded window still hides newer history', () => {
    const existingMessages = [
      {
        id: '2',
        chatId: 'chat',
        text: 'middle',
        sender: 'them',
        sentAt: '2026-01-02T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        id: '3',
        chatId: 'chat',
        text: 'newer',
        sender: 'them',
        sentAt: '2026-01-03T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
    ];

    const result = applyMessageUpsert(
      existingMessages as never,
      {
        ...buildDefaultChatMessagePaginationState(),
        oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        newestCursor: { id: 3, created_at: '2026-01-03T00:00:00.000Z' },
        hasNewer: true,
      },
      {
        id: '4',
        chatId: 'chat',
        text: 'latest',
        sender: 'them',
        sentAt: '2026-01-04T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        allowOutsideLoadedWindow: false,
      }
    );

    expect(result.ignored).toBe(true);
    expect(result.messages).toEqual(existingMessages);
  });

  it('allows outside-window inserts when restore or live-sync explicitly requests them', () => {
    const result = applyMessageUpsert(
      [
        {
          id: '2',
          chatId: 'chat',
          text: 'middle',
          sender: 'them',
          sentAt: '2026-01-02T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
      ] as never,
      {
        ...buildDefaultChatMessagePaginationState(),
        oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        newestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        hasOlder: true,
      },
      {
        id: '1',
        chatId: 'chat',
        text: 'older',
        sender: 'them',
        sentAt: '2026-01-01T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {},
      },
      {
        allowOutsideLoadedWindow: true,
      }
    );

    expect(result.ignored).toBe(false);
    expect(result.messages.map((message) => message.id)).toEqual(['1', '2']);
    expect(result.paginationState.oldestCursor).toEqual({
      id: 2,
      created_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('replaces an existing loaded message without disturbing pagination cursors', () => {
    const result = applyMessageUpsert(
      [
        {
          id: '2',
          chatId: 'chat',
          text: 'middle',
          sender: 'them',
          sentAt: '2026-01-02T00:00:00.000Z',
          authorPublicKey: 'b',
          eventId: null,
          nostrEvent: null,
          meta: {},
        },
      ] as never,
      {
        oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        newestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
        hasOlder: false,
        hasNewer: false,
        isLoadingOlder: false,
        isLoadingNewer: false,
      },
      {
        id: '2',
        chatId: 'chat',
        text: 'middle edited',
        sender: 'them',
        sentAt: '2026-01-02T00:00:00.000Z',
        authorPublicKey: 'b',
        eventId: null,
        nostrEvent: null,
        meta: {
          edited: true,
        },
      },
      {
        allowOutsideLoadedWindow: false,
      }
    );

    expect(result.ignored).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: '2',
      text: 'middle edited',
      meta: {
        edited: true,
      },
    });
    expect(result.paginationState).toMatchObject({
      oldestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
      newestCursor: { id: 2, created_at: '2026-01-02T00:00:00.000Z' },
    });
  });
});
