import { nip19 } from 'nostr-tools';
import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import {
  buildAttachmentMessageMeta,
  buildAttachmentMessageText,
  buildImageAttachmentPreviewText,
  buildMessageReplyPreviewContent,
  buildNip92ImetaTag,
  extractMediaAttachmentsFromTags,
  readImageAttachmentsFromMeta,
} from '#src/utils/messageAttachments.ts';
import { describe, expect, it } from 'vitest';

describe('message attachment helpers', () => {
  const attachment: MessageAttachmentMetadata = {
    type: 'media',
    url: ' https://nostr.build/i/example.png ',
    mimeType: ' image/png ',
    size: 1234,
    sha256: ' ABCDEF ',
    name: ' example.png ',
    service: ' nostr.build ',
    uploadedAt: ' 2026-06-08T10:00:00.000Z ',
  };

  it('builds message content and metadata from a media attachment', () => {
    expect(buildAttachmentMessageText(attachment)).toBe('https://nostr.build/i/example.png');
    expect(buildAttachmentMessageMeta(attachment)).toEqual({
      attachments: [
        {
          type: 'media',
          url: 'https://nostr.build/i/example.png',
          mimeType: 'image/png',
          size: 1234,
          sha256: 'abcdef',
          name: 'example.png',
          service: 'nostr.build',
          uploadedAt: '2026-06-08T10:00:00.000Z',
        },
      ],
    });
  });

  it('builds and parses NIP-92 imeta tags for media attachments', () => {
    expect(buildNip92ImetaTag(attachment)).toEqual([
      'imeta',
      'url https://nostr.build/i/example.png',
      'm image/png',
      'size 1234',
      'x abcdef',
    ]);

    expect(
      extractMediaAttachmentsFromTags([
        ['p', 'recipient'],
        ['imeta', 'url https://nostr.build/i/example.png', 'm image/png', 'size 1234', 'x ABCDEF'],
        ['imeta', 'url https://nostr.build/i/example.png', 'm image/png', 'size 1234'],
        ['imeta', 'url https://nostr.build/i/broken.png', 'm image/png'],
      ]),
    ).toEqual([
      {
        type: 'media',
        url: 'https://nostr.build/i/example.png',
        mimeType: 'image/png',
        size: 1234,
        sha256: 'abcdef',
      },
    ]);
  });

  it('reads only image attachments from message metadata', () => {
    expect(
      readImageAttachmentsFromMeta({
        attachments: [
          attachment,
          {
            type: 'media',
            url: 'https://nostr.build/v/example.mp4',
            mimeType: 'video/mp4',
            size: 456,
          },
          {
            type: 'media',
            url: '',
            mimeType: 'image/png',
            size: 123,
          },
        ],
      }),
    ).toEqual([
      {
        type: 'media',
        url: 'https://nostr.build/i/example.png',
        mimeType: 'image/png',
        size: 1234,
        sha256: 'abcdef',
        name: 'example.png',
        service: 'nostr.build',
        uploadedAt: '2026-06-08T10:00:00.000Z',
      },
    ]);
  });

  it('builds image attachment preview text without leaking image URLs', () => {
    const imageMeta = buildAttachmentMessageMeta(attachment);

    expect(buildImageAttachmentPreviewText('https://nostr.build/i/example.png', imageMeta)).toBe(
      'Picture',
    );
    expect(
      buildImageAttachmentPreviewText('Caption https://nostr.build/i/example.png', imageMeta),
    ).toBe('Caption');
    expect(
      buildImageAttachmentPreviewText('https://nostr.build/v/example.mp4', {
        attachments: [
          {
            type: 'media',
            url: 'https://nostr.build/v/example.mp4',
            mimeType: 'video/mp4',
            size: 456,
          },
        ],
      }),
    ).toBe('https://nostr.build/v/example.mp4');
  });

  it('builds image reply content with a thumbnail and a readable label', () => {
    const imageMeta = buildAttachmentMessageMeta(attachment);

    expect(buildMessageReplyPreviewContent('https://nostr.build/i/example.png', imageMeta)).toEqual(
      {
        text: 'Picture',
        imageUrl: 'https://nostr.build/i/example.png',
      },
    );
    expect(
      buildMessageReplyPreviewContent('Caption https://nostr.build/i/example.png', imageMeta),
    ).toEqual({
      text: 'Caption',
      imageUrl: 'https://nostr.build/i/example.png',
    });
  });
});

it('summarizes full invite links before limiting quote length', () => {
  const address = nip19.naddrEncode({
    kind: 34550,
    pubkey: 'a'.repeat(64),
    identifier: 'room',
    relays: ['wss://relay.example.org/' + 'x'.repeat(180)],
  });
  const link = `https://anagram.chat/join/chat.html#/public/${address}`;
  expect(link.length).toBeGreaterThan(300);
  expect(buildMessageReplyPreviewContent(link, undefined).text).toBe('Join chat');
  expect(buildMessageReplyPreviewContent(`Come join us: ${link}`, undefined).text).toBe(
    'Come join us: Join chat',
  );
  const call = Buffer.from(
    JSON.stringify({
      id: '12345678-1234-4123-8123-123456789abc',
      host: 'a'.repeat(64),
      secret: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      relays: ['wss://relay.example.org/'],
    }),
  ).toString('base64url');
  expect(
    buildMessageReplyPreviewContent(`https://anagram.chat/join/call.html#/call/${call}`, undefined)
      .text,
  ).toBe('Join call');
});
it('summarizes media including opaque Blossom URLs and preserves captions', () => {
  const url = 'https://media.example.org/' + 'a'.repeat(64);
  for (const [mimeType, label] of [
    ['image/png', 'Picture'],
    ['video/mp4', 'Video'],
    ['audio/ogg', 'Audio'],
    ['application/pdf', 'File'],
  ]) {
    const meta = { attachments: [{ type: 'media', url, mimeType, size: 0 }] };
    expect(buildMessageReplyPreviewContent(url, meta).text).toBe(label);
    expect(buildMessageReplyPreviewContent(`A caption ${url}`, meta).text).toBe('A caption');
  }
  expect(
    buildMessageReplyPreviewContent('https://example.org/movie.webm?download=1', undefined).text,
  ).toBe('Video');
  expect(buildMessageReplyPreviewContent('https://example.org/picture.png.', undefined).text).toBe(
    'Picture',
  );
});
it('keeps ordinary links as text and bounds existing long quote text', () => {
  expect(buildMessageReplyPreviewContent('Read https://example.org/docs', undefined).text).toBe(
    'Read https://example.org/docs',
  );
  const text = buildMessageReplyPreviewContent(
    'https://example.org/' + 'x'.repeat(1000),
    undefined,
  ).text;
  expect(text).toHaveLength(300);
  expect(text.endsWith('…')).toBe(true);
  expect(
    buildMessageReplyPreviewContent('https://example.org/public/naddr1invalid', undefined).text,
  ).toBe('https://example.org/public/naddr1invalid');
});
