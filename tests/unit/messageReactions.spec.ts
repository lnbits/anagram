import {
  buildMetaWithReactions,
  markReactionsViewedByAuthor,
  normalizeMessageReactions,
} from '#src/utils/messageReactions.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('messageReactions helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes reaction arrays by filtering invalid entries and normalizing identifiers', () => {
    expect(
      normalizeMessageReactions([
        {
          emoji: ' 👍 ',
          name: ' Thumbs Up ',
          reactorPublicKey: 'ALICE',
          createdAt: ' 2026-01-01T00:00:00.000Z ',
          eventId: ' ABC123 ',
          viewedByAuthorAt: ' 2026-01-02T00:00:00.000Z ',
        },
        {
          emoji: '',
          name: 'ignored',
          reactorPublicKey: 'bob',
        },
        {
          emoji: '🔥',
          name: ' Fire ',
          reactorPublicKey: 'BOB',
        },
        {
          emoji: '🙂',
          name: 'Smile',
          reactorPublicKey: 'carol',
          eventId: '   ',
        },
      ])
    ).toEqual([
      {
        emoji: '👍',
        name: 'Thumbs Up',
        reactorPublicKey: 'alice',
        createdAt: '2026-01-01T00:00:00.000Z',
        eventId: 'abc123',
        viewedByAuthorAt: '2026-01-02T00:00:00.000Z',
      },
      {
        emoji: '🔥',
        name: 'Fire',
        reactorPublicKey: 'bob',
      },
    ]);
  });

  it('marks only unseen reactions from other users as viewed and removes empty reaction metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));

    const markedReactions = markReactionsViewedByAuthor(
      [
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
        {
          emoji: '🙂',
          name: 'smile',
          reactorPublicKey: 'other-user',
          viewedByAuthorAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      ' ME ',
      '   '
    );

    expect(markedReactions).toEqual([
      {
        emoji: '👍',
        name: 'thumbs up',
        reactorPublicKey: 'other-user',
        viewedByAuthorAt: '2026-02-03T04:05:06.000Z',
      },
      {
        emoji: '🔥',
        name: 'fire',
        reactorPublicKey: 'me',
      },
      {
        emoji: '🙂',
        name: 'smile',
        reactorPublicKey: 'other-user',
        viewedByAuthorAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(buildMetaWithReactions({ foo: 'bar', reactions: 'stale' }, [])).toEqual({
      foo: 'bar',
    });

    const nextMeta = buildMetaWithReactions({ foo: 'bar' }, markedReactions);
    expect(nextMeta).toEqual({
      foo: 'bar',
      reactions: markedReactions,
    });
    expect(nextMeta.reactions).not.toBe(markedReactions);
  });
});
