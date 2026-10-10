import { __chatDataServiceTestUtils } from '#src/services/chatDataService.ts';
import { describe, expect, it } from 'vitest';

const { isDeletedMessageMeta, messageRecordMatchesSearchQuery, normalizeMessageSearchText } =
  __chatDataServiceTestUtils;

describe('chatDataService search helpers', () => {
  it('normalizes message search text case-insensitively and collapses whitespace', () => {
    expect(normalizeMessageSearchText('  Hello   WORLD  ')).toBe('hello world');
    expect(normalizeMessageSearchText('\nOne\tTwo  Three\n')).toBe('one two three');
    expect(normalizeMessageSearchText(null)).toBe('');
  });

  it('detects deleted message metadata', () => {
    expect(isDeletedMessageMeta({ deleted: { deletedAt: '2026-01-01T00:00:00.000Z' } })).toBe(true);
    expect(isDeletedMessageMeta({ deleted: null })).toBe(false);
    expect(isDeletedMessageMeta({})).toBe(false);
  });

  it('matches non-deleted message text using normalized query text', () => {
    expect(
      messageRecordMatchesSearchQuery(
        {
          id: 1,
          chat_public_key: 'chat',
          author_public_key: 'alice',
          message: '  Hello   Nostr Search  ',
          created_at: '2026-01-01T00:00:00.000Z',
          meta: {},
        } as never,
        'nostr search'
      )
    ).toBe(true);

    expect(
      messageRecordMatchesSearchQuery(
        {
          id: 2,
          chat_public_key: 'chat',
          author_public_key: 'alice',
          message: 'Hidden forever',
          created_at: '2026-01-01T00:00:00.000Z',
          meta: {
            deleted: {
              deletedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        } as never,
        'hidden'
      )
    ).toBe(false);

    expect(
      messageRecordMatchesSearchQuery(
        {
          id: 3,
          chat_public_key: 'chat',
          author_public_key: 'alice',
          message: 'Something else',
          created_at: '2026-01-01T00:00:00.000Z',
          meta: {},
        } as never,
        'nostr'
      )
    ).toBe(false);
  });
});
