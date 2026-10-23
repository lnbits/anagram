import { describe, expect, it } from 'vitest';
import {
  hasUnreadChatMention,
  isIncomingMentionRow,
  laterMentionAt,
  readChatSeenBoundaryAt,
} from '#src/utils/unreadMentions.ts';

const OWN = 'b'.repeat(64);
const MEMBER = 'a'.repeat(64);
const READ_AT = '2026-01-01T00:00:10.000Z';
const BEFORE = '2026-01-01T00:00:05.000Z';
const AFTER = '2026-01-01T00:00:20.000Z';

function row(overrides: { author?: string; meta?: Record<string, unknown> } = {}) {
  return {
    author_public_key: overrides.author ?? MEMBER,
    meta: overrides.meta ?? { mentions_me: true },
  };
}

describe('unread mentions', () => {
  it('uses the latest read, contact-cursor or outgoing timestamp as the seen boundary', () => {
    expect(
      readChatSeenBoundaryAt({
        last_seen_received_activity_at: BEFORE,
        last_seen_incoming_activity_at: READ_AT,
        last_outgoing_message_at: '',
      }),
    ).toBe(READ_AT);
    expect(readChatSeenBoundaryAt({ last_outgoing_message_at: AFTER })).toBe(AFTER);
    expect(readChatSeenBoundaryAt(null)).toBe('');
  });

  it('shows the group indicator only while the mention is unread', () => {
    const meta = { last_seen_received_activity_at: READ_AT, unread_mention_at: AFTER };
    expect(hasUnreadChatMention({ type: 'group', unreadCount: 2, meta })).toBe(true);
    // Marking read advances the boundary past the mention and zeroes the count.
    expect(
      hasUnreadChatMention({
        type: 'group',
        unreadCount: 2,
        meta: { ...meta, last_seen_received_activity_at: AFTER },
      }),
    ).toBe(false);
    expect(hasUnreadChatMention({ type: 'group', unreadCount: 0, meta })).toBe(false);
    // Replying after the mention reads it, as it does for unread counts.
    expect(
      hasUnreadChatMention({
        type: 'group',
        unreadCount: 1,
        meta: { ...meta, last_outgoing_message_at: AFTER },
      }),
    ).toBe(false);
    expect(hasUnreadChatMention({ type: 'user', unreadCount: 2, meta })).toBe(false);
    expect(
      hasUnreadChatMention({ type: 'group', unreadCount: 2, meta: { unread_mention_at: 'bad' } }),
    ).toBe(false);
    // A cleared indicator is stored as an empty patch value.
    expect(
      hasUnreadChatMention({ type: 'group', unreadCount: 2, meta: { unread_mention_at: '' } }),
    ).toBe(false);
  });

  it('only treats live incoming mentioning rows as mentions', () => {
    expect(isIncomingMentionRow(row(), OWN)).toBe(true);
    expect(isIncomingMentionRow(row({ author: OWN }), OWN)).toBe(false);
    expect(isIncomingMentionRow(row({ meta: {} }), OWN)).toBe(false);
    expect(isIncomingMentionRow(row({ meta: { mentions_me: false } }), OWN)).toBe(false);
    expect(
      isIncomingMentionRow(
        row({ meta: { mentions_me: true, deleted: { deletedAt: AFTER } } }),
        OWN,
      ),
    ).toBe(false);
    expect(
      isIncomingMentionRow(row({ meta: { mentions_me: true, kind: 1014 } }), OWN),
    ).toBe(false);
    expect(isIncomingMentionRow(row(), null)).toBe(false);
  });

  it('keeps the later of two mention timestamps', () => {
    expect(laterMentionAt(BEFORE, AFTER)).toBe(AFTER);
    expect(laterMentionAt(AFTER, BEFORE)).toBe(AFTER);
    expect(laterMentionAt(undefined, AFTER)).toBe(AFTER);
  });
});
