import type { Chat } from 'src/types/chat';
import { resolveChatPreviewAuthorLabel } from 'src/utils/chatPreview';
import { describe, expect, it } from 'vitest';

const BOB_PUBLIC_KEY = 'b'.repeat(64);

function buildChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'group-chat',
    publicKey: 'group-chat',
    epochPublicKey: null,
    type: 'group',
    name: 'Group chat',
    avatar: 'GC',
    lastMessage: 'Hello',
    lastMessageAuthorPublicKey: BOB_PUBLIC_KEY,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    unreadCount: 0,
    meta: {
      group_members: [
        {
          public_key: BOB_PUBLIC_KEY,
          name: 'Bob Member',
          given_name: 'Bobby',
        },
      ],
    },
    ...overrides,
  };
}

describe('chat preview author labels', () => {
  it('uses a group member name for incoming group messages', () => {
    expect(resolveChatPreviewAuthorLabel(buildChat(), 'alice', 'You')).toBe('Bobby');
  });

  it('uses You for the current user in group and direct chats', () => {
    expect(
      resolveChatPreviewAuthorLabel(
        buildChat({ lastMessageAuthorPublicKey: 'alice' }),
        'alice',
        'You'
      )
    ).toBe('You');
    expect(
      resolveChatPreviewAuthorLabel(
        buildChat({ type: 'user', lastMessageAuthorPublicKey: 'alice' }),
        'alice',
        'You'
      )
    ).toBe('You');
  });

  it('does not repeat the contact name for incoming direct messages', () => {
    expect(resolveChatPreviewAuthorLabel(buildChat({ type: 'user' }), 'alice', 'You')).toBe('');
  });
});
