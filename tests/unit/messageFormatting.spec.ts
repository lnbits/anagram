import { describe, expect, it } from 'vitest';
import {
  formatMessage,
  messageFormatUrls,
  collapseFormattedMessage,
  withoutFormattedMediaUrls,
  type FormattedMessagePart,
} from '#src/utils/messageFormatting.ts';
import { nip19 } from '#src/lib/nostr/client.ts';

const all = (parts: FormattedMessagePart[]): FormattedMessagePart[] =>
  parts.flatMap((part) => (part.type === 'format' ? [part, ...all(part.children)] : [part]));
const visibleText = (parts: FormattedMessagePart[]): string =>
  parts.map((part) => (part.type === 'format' ? visibleText(part.children) : part.text)).join('');

describe('Telegram-style message formatting', () => {
  it('supports each requested marker, including both italic spellings', () => {
    const parts = formatMessage(
      '**bold** *italic* _also italic_ __underlined__ ~struck~ ||hidden||',
    );
    expect(parts.filter((p) => p.type === 'format').map((p) => p.format)).toEqual([
      'bold',
      'italic',
      'italic',
      'underline',
      'strike',
      'spoiler',
    ]);
    expect(visibleText(parts)).toBe('bold italic also italic underlined struck hidden');
  });
  it('supports nested styles, including adjacent closing delimiters', () => {
    const parts = formatMessage('**bold *and italic***');
    expect(parts[0]).toMatchObject({ type: 'format', format: 'bold' });
    expect(
      all(parts)
        .filter((p) => p.type === 'format')
        .map((p) => p.format),
    ).toEqual(['bold', 'italic']);
    expect(visibleText(parts)).toBe('bold and italic');
  });
  it('preserves escapes, unmatched delimiters, filenames, URLs and whitespace', () => {
    expect(visibleText(formatMessage('a_b_c snake__case 2 * 3 \\*literal\\* **unfinished'))).toBe(
      'a_b_c snake__case 2 * 3 *literal* **unfinished',
    );
    const parts = formatMessage('https://example.org/a_b_c?q=a*b **https://example.org/b**');
    expect(
      all(parts)
        .filter((p) => p.type === 'url')
        .map((p) => p.href),
    ).toEqual(['https://example.org/a_b_c?q=a*b', 'https://example.org/b']);
    expect(visibleText(formatMessage('line one\n\n  line two'))).toBe('line one\n\n  line two');
  });
  it('keeps code literal and strips only an optional fenced language header', () => {
    const parts = formatMessage(
      '`**literal** <img> https://example.org/inline`\n```js\nconst x = "<script>";\n  x();\n```',
    );
    expect(parts.filter((p) => p.type === 'code')).toEqual([
      expect.objectContaining({
        block: false,
        text: '**literal** <img> https://example.org/inline',
      }),
      expect.objectContaining({ block: true, text: 'const x = "<script>";\n  x();' }),
    ]);
    expect([...messageFormatUrls(parts).visible]).toEqual([]);
  });
  it('accepts labelled HTTP links and balanced URL parentheses, rejecting unsafe destinations', () => {
    expect(formatMessage('[Docs](https://example.org/Links_(web))')[0]).toMatchObject({
      type: 'url',
      text: 'Docs',
      href: 'https://example.org/Links_(web)',
    });
    for (const destination of [
      'javascript:alert(1)',
      'data:text/html,evil',
      'file:///tmp/a',
      'https://user:password@example.org',
      'https://example.org/\u0000evil',
    ]) {
      expect(all(formatMessage(`[bad](${destination})`)).some((p) => p.type === 'url')).toBe(false);
    }
    expect(visibleText(formatMessage('<img src=x onerror=alert(1)>'))).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
  it('preserves mentions and collects previews only from outside code and spoilers', () => {
    const publicKey = 'c'.repeat(64);
    const parts = formatMessage(
      `**nostr:${nip19.npubEncode(publicKey)}** ||[Hidden](https://example.org/secret)|| [Shown](https://example.org/public)`,
      [{ publicKey, displayName: 'Carol', handle: 'Carol' }],
    );
    expect(all(parts).find((p) => p.type === 'mention')).toMatchObject({
      publicKey,
      text: '@Carol',
    });
    expect([...messageFormatUrls(parts).visible]).toEqual(['https://example.org/public']);
    expect([...messageFormatUrls(parts).hidden]).toEqual(['https://example.org/secret']);
  });
  it('collapses long spoilers without dropping their concealment wrapper', () => {
    const parts = collapseFormattedMessage(formatMessage(`||${'private '.repeat(2000)}||`));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'format', format: 'spoiler' });
    expect(visibleText(parts).length).toBeLessThanOrEqual(4097);
  });
  it('renders bullet lines while preserving escaped markers and literal code', () => {
    const parts = formatMessage('Items\n* one\n- **two**\n\\* literal\n`* code`\n```\n- code\n```');
    expect(visibleText(parts)).toBe('Items\n• one\n• two\n* literal\n* code\n- code');
  });
  it('hides duplicate media links without stripping code, spoilers or named links', () => {
    const url = 'https://example.org/photo.png';
    const parts = formatMessage(`**${url}** [Photo](${url}) \`${url}\` ||${url}||`);
    const caption = withoutFormattedMediaUrls(parts, [{ url, mimeType: 'image/png' }]);
    expect(caption.some((part) => part.type === 'format' && part.format === 'bold')).toBe(false);
    expect(caption.find((part) => part.type === 'url')).toMatchObject({ text: 'Photo', href: url });
    expect(caption.find((part) => part.type === 'code')).toMatchObject({ text: url });
    expect(caption.find((part) => part.type === 'format')).toMatchObject({ format: 'spoiler' });
    expect(visibleText(caption)).toBe(` Photo ${url} ${url}`);
  });
  it('bounds nesting/components and handles hostile unmatched delimiters', () => {
    const parts = formatMessage('[no link '.repeat(10000) + '**x** '.repeat(10000));
    expect(all(parts).length).toBeLessThan(2100);
    expect(visibleText(parts)).toContain('[no link');
  });
});
