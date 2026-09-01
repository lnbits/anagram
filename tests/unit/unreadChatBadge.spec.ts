import { formatUnreadChatBadgeLabel, formatUnreadDocumentTitle } from 'src/utils/unreadChatBadge';
import { describe, expect, it } from 'vitest';

describe('unread chat badge formatting', () => {
  it('formats bounded badge labels', () => {
    expect(formatUnreadChatBadgeLabel(0)).toBe('0');
    expect(formatUnreadChatBadgeLabel(12)).toBe('12');
    expect(formatUnreadChatBadgeLabel(100)).toBe('99+');
  });

  it('adds and clears the unread count in the document title', () => {
    expect(formatUnreadDocumentTitle('Anagram', 3)).toBe('(3) Anagram');
    expect(formatUnreadDocumentTitle('Anagram', 120)).toBe('(99+) Anagram');
    expect(formatUnreadDocumentTitle('Anagram', 0)).toBe('Anagram');
  });
});
