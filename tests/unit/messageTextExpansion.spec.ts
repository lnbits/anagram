import {
  COLLAPSED_MESSAGE_CHARACTER_LIMIT,
  shouldCollapseMessageText,
  truncateCollapsedMessageText,
} from '#src/utils/messageTextExpansion.ts';
import { describe, expect, it } from 'vitest';

describe('message text expansion', () => {
  it('does not collapse messages at the character limit', () => {
    expect(shouldCollapseMessageText('a'.repeat(COLLAPSED_MESSAGE_CHARACTER_LIMIT))).toBe(false);
  });

  it('collapses messages after the character limit', () => {
    expect(shouldCollapseMessageText('a'.repeat(COLLAPSED_MESSAGE_CHARACTER_LIMIT + 1))).toBe(true);
  });

  it('truncates collapsed text to the character limit', () => {
    const text = `${'a'.repeat(COLLAPSED_MESSAGE_CHARACTER_LIMIT)}tail`;

    expect(truncateCollapsedMessageText(text)).toBe(
      `${'a'.repeat(COLLAPSED_MESSAGE_CHARACTER_LIMIT)}...`
    );
  });
});
