import { nip19 } from '@nostr-dev-kit/ndk';
import { buildMessageTextParts } from 'src/utils/messageTextParts';
import { describe, expect, it } from 'vitest';

describe('message text parts', () => {
  it('turns HTTP(S) and www URLs into links while preserving surrounding punctuation', () => {
    const parts = buildMessageTextParts(
      'Read https://example.com/docs?q=chat, then (www.example.org/help).'
    );

    expect(parts.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: 'text', text: 'Read ' },
      { type: 'url', text: 'https://example.com/docs?q=chat' },
      { type: 'text', text: ', then (' },
      { type: 'url', text: 'www.example.org/help' },
      { type: 'text', text: ').' },
    ]);
    expect(parts.filter((part) => part.type === 'url')).toEqual([
      expect.objectContaining({ href: 'https://example.com/docs?q=chat' }),
      expect.objectContaining({ href: 'https://www.example.org/help' }),
    ]);
  });

  it('keeps balanced closing delimiters inside a URL', () => {
    const [link] = buildMessageTextParts('https://example.com/wiki/Links_(web)');

    expect(link).toMatchObject({
      type: 'url',
      text: 'https://example.com/wiki/Links_(web)',
      href: 'https://example.com/wiki/Links_(web)',
    });
  });

  it('does not link unsupported schemes or HTML-like content', () => {
    expect(buildMessageTextParts('javascript:alert(1) nostr:unsafe <b>text</b>')).toEqual([
      {
        type: 'text',
        key: 'text-0',
        text: 'javascript:alert(1) nostr:unsafe <b>text</b>',
      },
    ]);
  });

  it('preserves clickable Nostr mentions alongside web links', () => {
    const publicKey = 'c'.repeat(64);
    const npub = nip19.npubEncode(publicKey);
    const parts = buildMessageTextParts(`Hi nostr:${npub}, see https://example.com`, [
      {
        publicKey,
        displayName: 'Carol',
        handle: 'Carol',
      },
    ]);

    expect(parts.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'mention', text: '@Carol' },
      { type: 'text', text: ', see ' },
      { type: 'url', text: 'https://example.com' },
    ]);
  });
});
