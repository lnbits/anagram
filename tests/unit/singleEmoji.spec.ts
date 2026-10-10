import { describe, expect, it } from 'vitest';
import { isSingleEmoji } from '#src/utils/singleEmoji.ts';

describe('standalone emoji messages', () => {
  it.each([
    '😀',
    ' 👍🏽 ',
    '👩🏽‍💻',
    '👨‍👩‍👧‍👦',
    '❤️',
    '🇬🇧',
    '1️⃣',
    '#️⃣',
    '🏳️‍🌈',
    '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
  ])('recognizes %s as one emoji', (text) => {
    expect(isSingleEmoji(text)).toBe(true);
  });
  it.each(['', ' ', '1', '#', '*', 'hello 😀', '😀 hello', '😀😀', '😀 👍', '😀\n👍', 'a', '👍🏽!'])(
    'leaves %s at normal size',
    (text) => {
      expect(isSingleEmoji(text)).toBe(false);
    },
  );
});
