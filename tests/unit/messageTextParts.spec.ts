import { nip19 } from '#src/lib/nostr/client.ts';
import { buildMessageTextParts, withoutPreviewMediaUrls } from '#src/utils/messageTextParts.ts';
import { describe, expect, it } from 'vitest';

describe('message text parts', () => {
  it('turns HTTP(S) and www URLs into links while preserving surrounding punctuation', () => {
    const parts = buildMessageTextParts(
      'Read https://example.com/docs?q=chat, then (www.example.org/help).',
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

describe('preview media captions', () => {
  const image = { url: 'https://media.example/image.png', mimeType: 'image/png' };
  const video = { url: 'https://media.example/movie.mp4?token=123', mimeType: 'video/mp4' };
  it('removes duplicate preview URLs but preserves captions, mentions and unrelated links', () => {
    const caption = 'Hello nostr:npub1example — see https://example.org/article';
    expect(withoutPreviewMediaUrls(`${caption}\n${image.url}\n${video.url}`, [image, video])).toBe(
      caption,
    );
  });
  it('leaves no empty text for a media-only message', () => {
    expect(withoutPreviewMediaUrls(`  ${image.url}\n`, [image])).toBe('');
  });
  it('does not remove links without a renderable matching preview', () => {
    const audio = { url: 'https://media.example/audio.mp3', mimeType: 'audio/mpeg' };
    const insecure = { ...image, url: 'http://media.example/image.png' };
    const raw = `${image.url}\n${audio.url}\n${insecure.url}\n${video.url}&other=1`;
    expect(withoutPreviewMediaUrls(raw, [video, audio, insecure])).toBe(raw);
    expect(withoutPreviewMediaUrls(raw, [])).toBe(raw);
  });
  it('preserves punctuation and the original caption spelling', () => {
    expect(withoutPreviewMediaUrls(`Thanks!
${image.url}`, [image])).toBe('Thanks!');
  });
});
