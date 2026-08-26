import type { MessageAttachmentMetadata } from 'src/types/chat';
import {
  buildAttachmentMessageMeta,
  buildAttachmentMessageText,
  buildImageAttachmentPreviewText,
  buildMessageReplyPreviewContent,
  buildNip92ImetaTag,
  extractMediaAttachmentsFromTags,
  readImageAttachmentsFromMeta,
} from 'src/utils/messageAttachments';
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
      ])
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
      })
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
      'Picture'
    );
    expect(
      buildImageAttachmentPreviewText('Caption https://nostr.build/i/example.png', imageMeta)
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
      })
    ).toBe('https://nostr.build/v/example.mp4');
  });

  it('builds image reply content with a thumbnail and a readable label', () => {
    const imageMeta = buildAttachmentMessageMeta(attachment);

    expect(buildMessageReplyPreviewContent('https://nostr.build/i/example.png', imageMeta)).toEqual(
      {
        text: 'Picture',
        imageUrl: 'https://nostr.build/i/example.png',
      }
    );
    expect(
      buildMessageReplyPreviewContent('Caption https://nostr.build/i/example.png', imageMeta)
    ).toEqual({
      text: 'Caption',
      imageUrl: 'https://nostr.build/i/example.png',
    });
  });
});
