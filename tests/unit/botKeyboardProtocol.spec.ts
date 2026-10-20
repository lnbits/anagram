import { describe, expect, it } from 'vitest';
import {
  keyboardTag,
  keyboardFromTags,
  keyboardSections,
  parseKeyboard,
  controlTag,
  parseControl,
  safeButtonUrl,
  safeMagnetUrl,
  MAX_KEYBOARD_BYTES,
  MAX_BUTTON_URL_BYTES,
  MAX_COPY_TEXT_BYTES,
  type BotControl,
} from '#src/stores/nostr/botKeyboardProtocol.ts';
const keyboard = {
  inline_keyboard: [
    [
      { text: 'Yes', callback_data: 'yes' },
      { text: 'Website', url: 'https://example.org' },
    ],
  ],
};
describe('inline keyboard wire format', () => {
  it('accepts magnet intents with a valid BitTorrent topic but rejects other external schemes', () => {
    const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
    for (const url of [
      magnet,
      magnet + '&dn=A%20movie&tr=udp%3A%2F%2Ftracker.example%3A80',
      'magnet:?xt=urn:btih:' + 'A'.repeat(32),
    ]) {
      expect(safeMagnetUrl(url)).toBe(true);
      const markup = { inline_keyboard: [[{ text: 'open', url }]] };
      expect(keyboardFromTags([keyboardTag(markup)])).toEqual(markup);
    }
    for (const url of [
      'magnet:',
      'magnet:?xt=urn:btih:bad',
      'magnet://host/?xt=urn:btih:' + 'a'.repeat(40),
      'magnet://?xt=urn:btih:' + 'a'.repeat(40),
      magnet + '#fragment',
      magnet + '&xt=urn:btih:' + 'b'.repeat(40),
      magnet + '&dn=%0Aunsafe',
      magnet + '\n',
      'intent://torrent/#Intent;scheme=magnet;end',
      'file:///tmp/movie',
      'javascript:alert(1)',
      'data:text/html,test',
    ]) {
      expect(safeMagnetUrl(url)).toBe(false);
      expect(safeButtonUrl(url)).toBe(false);
      expect(parseKeyboard({ inline_keyboard: [[{ text: 'open', url }]] })).toBeNull();
    }
  });
  it('places rows after text sections without losing headings or trailing text', () => {
    const markup = {
      inline_keyboard: [keyboard.inline_keyboard[0], keyboard.inline_keyboard[0]],
      row_after: [1, 2],
    };
    expect(keyboardFromTags([keyboardTag(markup)])).toEqual(markup);
    expect(keyboardSections(markup, '**Heading**\n\nFirst\nDetails\n\nSecond\n\nFooter')).toEqual([
      { text: '**Heading**\n\nFirst\nDetails', row: markup.inline_keyboard[0] },
      { text: 'Second', row: markup.inline_keyboard[1] },
      { text: 'Footer', row: [] },
    ]);
    expect(keyboardSections(markup, 'Too short')).toBeNull();
    expect(keyboardSections(keyboard, 'Normal keyboard')).toBeNull();
    expect(keyboardSections({ ...keyboard, row_after: [1] }, 'One\r\n \r\nTwo')?.[0].text).toBe(
      'One\n\nTwo',
    );
  });
  it('bounds positioned keyboards to 16 rows, 32 buttons and ordered paragraph positions', () => {
    const rows = Array(16).fill(keyboard.inline_keyboard[0]);
    const row_after = Array.from({ length: 16 }, (_, i) => i);
    expect(parseKeyboard({ inline_keyboard: rows, row_after })).not.toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: [...rows, rows[0]], row_after: [...row_after, 16] }),
    ).toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: rows.map((row) => [...row, row[0]]), row_after }),
    ).toBeNull();
    for (const positions of [null, '0', [], [0, 1], [-1], [256], [0.5], ['0']])
      expect(parseKeyboard({ ...keyboard, row_after: positions })).toBeNull();
    for (const positions of [
      [1, 1],
      [2, 0],
    ])
      expect(
        parseKeyboard({ inline_keyboard: [rows[0], rows[0]], row_after: positions }),
      ).toBeNull();
  });
  it('round trips all three sizes and bounded copy_text without treating them as callbacks', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const markup = {
        inline_keyboard: [
          [{ text: 'magnet', size, copy_text: { text: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) } }],
        ],
      };
      expect(keyboardFromTags([keyboardTag(markup)])).toEqual(markup);
    }
    expect(
      parseKeyboard({
        inline_keyboard: [[{ text: 'Copy', copy_text: { text: '👍'.repeat(256) } }]],
      }),
    ).not.toBeNull();
    for (const button of [
      { text: 'x', size: 'tiny', callback_data: 'x' },
      { text: 'x', size: null, callback_data: 'x' },
      { text: 'x', copy_text: { text: '' } },
      { text: 'x', copy_text: { text: 'a'.repeat(MAX_COPY_TEXT_BYTES + 1) } },
      { text: 'x', copy_text: { text: '👍'.repeat(MAX_COPY_TEXT_BYTES / 4 + 1) } },
      { text: 'x', copy_text: { text: 'copy', extra: true } },
      { text: 'x', copy_text: 'copy' },
      { text: 'x', copy_text: { text: 'copy' }, callback_data: 'x' },
      { text: 'x', copy_text: { text: 'copy' }, url: 'https://example.org' },
    ])
      expect(parseKeyboard({ inline_keyboard: [[button]] })).toBeNull();
  });
  it('bounds longer URLs, copy text and the entire keyboard independently', () => {
    const url = 'https://example.org/?'.padEnd(MAX_BUTTON_URL_BYTES, 'a');
    const copy = '👍'.repeat(MAX_COPY_TEXT_BYTES / 4);
    const markup = {
      inline_keyboard: [
        [
          { text: 'Open', url },
          { text: 'Copy', copy_text: { text: copy } },
        ],
      ],
    };
    expect(keyboardFromTags([keyboardTag(markup)])).toEqual(markup);
    expect(safeButtonUrl(url + 'a')).toBe(false);
    const magnet = ('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=').padEnd(
      MAX_BUTTON_URL_BYTES,
      'a',
    );
    expect(safeMagnetUrl(magnet)).toBe(true);
    expect(safeMagnetUrl(magnet + 'a')).toBe(false);
    const tooLarge = {
      inline_keyboard: Array.from({ length: 8 }, () =>
        Array.from({ length: 4 }, () => ({ text: 'Open', url })),
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBeGreaterThan(MAX_KEYBOARD_BYTES);
    expect(parseKeyboard(tooLarge)).toBeNull();
    expect(
      keyboardFromTags([['anagram-inline-keyboard', '1', JSON.stringify(tooLarge)]]),
    ).toBeNull();
  });
  it('round trips Telegram button rows in metadata, preserving Unicode callback bytes', () => {
    expect(keyboardFromTags([keyboardTag(keyboard)])).toEqual(keyboard);
    expect(
      parseKeyboard({ inline_keyboard: [[{ text: '👍', callback_data: '👍'.repeat(16) }]] }),
    ).not.toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: [[{ text: '👍', callback_data: '👍'.repeat(17) }]] }),
    ).toBeNull();
    expect(keyboardFromTags([keyboardTag(keyboard), keyboardTag(keyboard)])).toBeNull();
    expect(keyboardFromTags([['anagram-inline-keyboard', '2', '{}']])).toBeNull();
  });
  it('rejects oversized, ambiguous and executable button definitions', () => {
    for (const button of [
      { text: 'x', callback_data: 'x', url: 'https://example.org' },
      { text: 'x', callback_data: '' },
      { text: 'x', callback_data: 'x', web_app: {} },
      { text: 'x', url: 'javascript:alert(1)' },
      { text: 'x', url: 'file:///etc/passwd' },
      { text: 'x', url: 'https://user:password@example.org/' },
      { text: 'x', url: 'https://example.org/\n' },
      { text: 'x'.repeat(129), callback_data: 'x' },
    ])
      expect(parseKeyboard({ inline_keyboard: [[button]] })).toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: Array(9).fill(keyboard.inline_keyboard[0]) }),
    ).toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: [[...Array(5).fill(keyboard.inline_keyboard[0][0])]] }),
    ).toBeNull();
    expect(safeButtonUrl('https://example.org')).toBe(true);
    expect(parseKeyboard({ inline_keyboard: [] })).toEqual({ inline_keyboard: [] });
  });
  it('binds versioned controls to typed conversations and requires private membership proof', () => {
    const bot = 'b'.repeat(64);
    const request: BotControl = {
      op: 'request',
      id: 'a'.repeat(32),
      expires: 1000,
      data: 'yes',
      target: { type: 'dm', bot, chat: bot, root: 'c'.repeat(64), version: 'd'.repeat(64) },
    };
    expect(parseControl([controlTag(request)])).toEqual(request);
    expect(() =>
      controlTag({ ...request, target: { ...request.target, chat: 'e'.repeat(64) } }),
    ).toThrow();
    expect(() =>
      controlTag({ ...request, target: { ...request.target, type: 'private' } }),
    ).toThrow();
    const privateRequest = {
      ...request,
      target: { ...request.target, type: 'private' as const },
      membership: { epoch: 1, invited_at: 100, invitation_proof: 'f'.repeat(128) },
    };
    expect(parseControl([controlTag(privateRequest)])).toEqual(privateRequest);
    expect(parseControl([controlTag(request), controlTag(request)])).toBeNull();
  });
});
