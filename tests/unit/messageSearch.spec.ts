import {
  isDeletedMessageMeta,
  messageRecordMatchesSearchQuery,
  normalizeMessageSearchText,
  type SearchableMessageRecord,
  searchMessageRecords,
  sortSearchableMessagesByCreated,
} from '#src/utils/messageSearch.ts';
import { describe, expect, it } from 'vitest';

function buildRecord(
  overrides: Partial<SearchableMessageRecord> & Pick<SearchableMessageRecord, 'id'>
): SearchableMessageRecord {
  return {
    id: overrides.id,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    message: overrides.message ?? '',
    meta: overrides.meta ?? {},
  };
}

describe('messageSearch utilities', () => {
  it('normalizes search text by trimming, collapsing whitespace, and lowercasing', () => {
    expect(normalizeMessageSearchText('  Hello   WORLD  ')).toBe('hello world');
    expect(normalizeMessageSearchText('\nOne\tTwo  Three\n')).toBe('one two three');
    expect(normalizeMessageSearchText(42)).toBe('');
  });

  it('sorts messages chronologically using ids as the tiebreaker', () => {
    expect(
      sortSearchableMessagesByCreated(
        buildRecord({ id: 2, created_at: '2026-01-02T00:00:00.000Z' }),
        buildRecord({ id: 1, created_at: '2026-01-01T00:00:00.000Z' })
      )
    ).toBeGreaterThan(0);

    expect(
      sortSearchableMessagesByCreated(
        buildRecord({ id: 2, created_at: '2026-01-02T00:00:00.000Z' }),
        buildRecord({ id: 1, created_at: '2026-01-02T00:00:00.000Z' })
      )
    ).toBeGreaterThan(0);
  });

  it('treats deleted metadata objects as removed messages', () => {
    expect(isDeletedMessageMeta({ deleted: { deletedAt: '2026-01-01T00:00:00.000Z' } })).toBe(true);
    expect(isDeletedMessageMeta({ deleted: null })).toBe(false);
    expect(isDeletedMessageMeta({})).toBe(false);
  });

  it('matches query text case-insensitively and excludes deleted records', () => {
    expect(
      messageRecordMatchesSearchQuery(
        buildRecord({
          id: 1,
          message: '  Hello   Nostr Search  ',
        }),
        'nostr search'
      )
    ).toBe(true);

    expect(
      messageRecordMatchesSearchQuery(
        buildRecord({
          id: 2,
          message: 'Hidden forever',
          meta: {
            deleted: {
              deletedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        }),
        'hidden'
      )
    ).toBe(false);
  });

  it('uses the provided meta normalizer when filtering search results', () => {
    const record = buildRecord({
      id: 1,
      message: 'Search target',
      meta: {
        deleted: 'yes',
      },
    });

    expect(
      messageRecordMatchesSearchQuery(record, 'search', () => ({
        deleted: {
          deletedAt: '2026-01-01T00:00:00.000Z',
        },
      }))
    ).toBe(false);
  });

  it('filters matching records and returns them newest-first', () => {
    const results = searchMessageRecords(
      [
        buildRecord({
          id: 1,
          created_at: '2026-01-01T00:00:00.000Z',
          message: 'first thread-search-hit',
        }),
        buildRecord({
          id: 2,
          created_at: '2026-01-03T00:00:00.000Z',
          message: 'deleted thread-search-hit',
          meta: {
            deleted: {
              deletedAt: '2026-01-04T00:00:00.000Z',
            },
          },
        }),
        buildRecord({
          id: 3,
          created_at: '2026-01-02T00:00:00.000Z',
          message: 'second thread-search-hit',
        }),
        buildRecord({
          id: 4,
          created_at: '2026-01-04T00:00:00.000Z',
          message: 'irrelevant',
        }),
      ],
      'thread-search-hit'
    );

    expect(results.map((record) => record.id)).toEqual([3, 1]);
  });

  it('returns no results when the query normalizes to an empty string', () => {
    expect(searchMessageRecords([buildRecord({ id: 1, message: 'hello' })], '   ')).toEqual([]);
  });
});
