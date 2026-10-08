import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import {
  buildAttachmentMessageMeta,
  buildAttachmentMessageText,
  buildImageAttachmentPreviewText,
  buildMessageReplyPreviewContent,
  buildNip17FileMessageTags,
  buildNip92ImetaTag,
  extractMediaAttachmentsFromTags,
  isChatMessageRumorKind,
  isImageAttachment,
  isPlayableEncryptedAttachment,
  normalizeMessageAttachment,
  parseNip17FileMessageAttachment,
  readHiddenAttachmentUrls,
  readImageAttachmentsFromMeta,
  readPlayableEncryptedAttachmentsFromMeta,
  redactFileMessageSecretTags,
  resolveChatMessageRumorKind,
  resolveSafeInlineImageMimeType,
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

  describe('NIP-17 kind 15 file messages', () => {
    const key = 'a1'.repeat(32);
    const nonce = 'b2'.repeat(12);
    const ciphertextHash = 'c3'.repeat(32);
    const plaintextHash = 'd4'.repeat(32);
    const blobUrl = `https://blossom.example.com/${ciphertextHash}`;
    const encryptedAttachment: MessageAttachmentMetadata = {
      type: 'media',
      url: blobUrl,
      mimeType: 'image/jpeg',
      size: 2048,
      sha256: ciphertextHash,
      name: 'holiday.jpg',
      service: 'blossom.example.com',
      encryption: {
        algorithm: 'aes-gcm',
        key,
        nonce,
        originalSha256: plaintextHash,
      },
    };
    const fileTags = [
      ['file-type', 'image/jpeg'],
      ['encryption-algorithm', 'aes-gcm'],
      ['decryption-key', key],
      ['decryption-nonce', nonce],
      ['x', ciphertextHash],
      ['ox', plaintextHash],
      ['size', '2048'],
    ];

    it('builds kind 15 tags and never builds an imeta tag for encrypted media', () => {
      expect(buildNip17FileMessageTags(encryptedAttachment)).toEqual(fileTags);
      expect(buildNip92ImetaTag(encryptedAttachment)).toEqual([]);
      expect(buildAttachmentMessageText(encryptedAttachment)).toBe(blobUrl);
    });

    it('does not put the local file name or server name into kind 15 tags', () => {
      const serialized = JSON.stringify(buildNip17FileMessageTags(encryptedAttachment));

      expect(serialized).not.toContain('holiday.jpg');
      expect(serialized).not.toContain('blossom.example.com');
    });

    it('does not build kind 15 tags for legacy attachments', () => {
      expect(buildNip17FileMessageTags(attachment)).toEqual([]);
    });

    it('parses kind 15 tags into an encrypted attachment', () => {
      expect(parseNip17FileMessageAttachment(` ${blobUrl} `, [['p', 'peer'], ...fileTags])).toEqual(
        {
          type: 'media',
          url: blobUrl,
          mimeType: 'image/jpeg',
          size: 2048,
          sha256: ciphertextHash,
          encryption: {
            algorithm: 'aes-gcm',
            key,
            nonce,
            originalSha256: plaintextHash,
          },
        }
      );
    });

    it('round-trips built tags through the parser', () => {
      const parsed = parseNip17FileMessageAttachment(
        blobUrl,
        buildNip17FileMessageTags(encryptedAttachment)
      );

      expect(parsed?.encryption).toEqual(encryptedAttachment.encryption);
      expect(parsed?.sha256).toBe(ciphertextHash);
    });

    it("accepts optional tags being absent and other clients' 16-byte nonces", () => {
      const parsed = parseNip17FileMessageAttachment(blobUrl, [
        ['file-type', 'IMAGE/PNG'],
        ['encryption-algorithm', 'AES-GCM'],
        ['decryption-key', key.toUpperCase()],
        ['decryption-nonce', 'ef'.repeat(16)],
        ['x', ciphertextHash.toUpperCase()],
      ]);

      expect(parsed).toEqual({
        type: 'media',
        url: blobUrl,
        mimeType: 'image/png',
        sha256: ciphertextHash,
        encryption: { algorithm: 'aes-gcm', key, nonce: 'ef'.repeat(16) },
      });
      // Without a size tag nothing is invented, and the stored attachment stays valid.
      expect(normalizeMessageAttachment(parsed)).toEqual(parsed);
      expect(buildNip17FileMessageTags(parsed as MessageAttachmentMetadata)).not.toContainEqual(
        expect.arrayContaining(['size'])
      );
    });

    it('still requires a size for legacy imeta attachments', () => {
      expect(
        normalizeMessageAttachment({ type: 'media', url: blobUrl, mimeType: 'image/png' })
      ).toBeNull();
    });

    it.each([
      ['file-type', 'file-type'],
      ['encryption-algorithm', 'encryption-algorithm'],
      ['decryption-key', 'decryption-key'],
      ['decryption-nonce', 'decryption-nonce'],
      ['x', 'x'],
    ])('rejects a file message missing the %s tag', (_label, missingTag) => {
      expect(
        parseNip17FileMessageAttachment(
          blobUrl,
          fileTags.filter((tag) => tag[0] !== missingTag)
        )
      ).toBeNull();
    });

    it.each([
      ['an unsupported algorithm', 'encryption-algorithm', 'chacha20'],
      ['a short key', 'decryption-key', 'a1'.repeat(16)],
      ['a non-hex key', 'decryption-key', 'zz'.repeat(32)],
      ['a malformed nonce', 'decryption-nonce', 'b2'.repeat(8)],
      ['a malformed hash', 'x', 'not-a-hash'],
    ])('rejects a file message with %s', (_label, tagName, value) => {
      expect(
        parseNip17FileMessageAttachment(
          blobUrl,
          fileTags.map((tag) => (tag[0] === tagName ? [tagName, value] : tag))
        )
      ).toBeNull();
    });

    it.each([
      ['plain http', 'http://blossom.example.com/blob'],
      ['a data URL', 'data:image/png;base64,AAAA'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['credentials', 'https://user:pass@blossom.example.com/blob'],
      ['empty content', ''],
    ])('rejects a file message whose content is %s', (_label, content) => {
      expect(parseNip17FileMessageAttachment(content, fileTags)).toBeNull();
    });

    it('drops stored encrypted attachments whose decryption data is invalid', () => {
      expect(
        normalizeMessageAttachment({
          ...encryptedAttachment,
          encryption: { ...encryptedAttachment.encryption, key: 'short' },
        })
      ).toBeNull();
      expect(normalizeMessageAttachment({ ...encryptedAttachment, sha256: undefined })).toBeNull();
      expect(
        normalizeMessageAttachment({ ...encryptedAttachment, url: 'http://insecure' })
      ).toBeNull();
      expect(normalizeMessageAttachment(encryptedAttachment)).toEqual(encryptedAttachment);
    });

    it('only treats allowlisted raster types as inline encrypted images', () => {
      const svg = { ...encryptedAttachment, mimeType: 'image/svg+xml' };
      const html = { ...encryptedAttachment, mimeType: 'text/html' };
      const video = { ...encryptedAttachment, mimeType: 'video/quicktime' };
      const meta = { attachments: [encryptedAttachment, svg, html, video] };

      expect(readImageAttachmentsFromMeta(meta)).toEqual([encryptedAttachment]);
      // Unsupported encrypted types are neither inline images nor playable media.
      for (const unsupported of [svg, html, video]) {
        expect(isImageAttachment(unsupported)).toBe(false);
        expect(isPlayableEncryptedAttachment(unsupported)).toBe(false);
      }
      expect(resolveSafeInlineImageMimeType('image/svg+xml')).toBeNull();
      expect(resolveSafeInlineImageMimeType('text/html')).toBeNull();
      expect(resolveSafeInlineImageMimeType('application/xhtml+xml')).toBeNull();
      expect(resolveSafeInlineImageMimeType('image/jpg')).toBe('image/jpeg');
      expect(resolveSafeInlineImageMimeType(' image/PNG; charset=x ')).toBe('image/png');
    });

    it('classifies encrypted video and audio as playable and everything else as unsupported', () => {
      const mp4 = { ...encryptedAttachment, mimeType: 'video/mp4' };
      const webm = { ...encryptedAttachment, mimeType: 'video/webm; codecs=vp9' };
      const mp3 = { ...encryptedAttachment, mimeType: 'audio/mpeg' };
      const mov = { ...encryptedAttachment, mimeType: 'video/quicktime' };
      const mkv = { ...encryptedAttachment, mimeType: 'video/x-matroska' };
      const meta = { attachments: [encryptedAttachment, mp4, webm, mp3, mov, mkv] };

      expect(readPlayableEncryptedAttachmentsFromMeta(meta)).toEqual([mp4, webm, mp3]);
      expect(readImageAttachmentsFromMeta(meta)).toEqual([encryptedAttachment]);
      for (const unsupported of [mov, mkv]) {
        expect(isImageAttachment(unsupported)).toBe(false);
        expect(isPlayableEncryptedAttachment(unsupported)).toBe(false);
      }
    });

    it('never treats a plaintext attachment as playable encrypted media', () => {
      const plain = { type: 'media', url: blobUrl, mimeType: 'video/mp4', size: 10 };

      expect(readPlayableEncryptedAttachmentsFromMeta({ attachments: [plain] })).toEqual([]);
    });

    it('hides encrypted blob URLs from message text and previews', () => {
      const meta = { attachments: [encryptedAttachment] };
      const videoMeta = { attachments: [{ ...encryptedAttachment, mimeType: 'video/mp4' }] };
      const audioMeta = { attachments: [{ ...encryptedAttachment, mimeType: 'audio/mpeg' }] };
      const movMeta = { attachments: [{ ...encryptedAttachment, mimeType: 'video/quicktime' }] };

      expect(readHiddenAttachmentUrls(meta)).toEqual([blobUrl]);
      expect(buildImageAttachmentPreviewText(blobUrl, meta)).toBe('Picture');
      expect(buildImageAttachmentPreviewText(blobUrl, videoMeta)).toBe('Video');
      expect(buildImageAttachmentPreviewText(blobUrl, audioMeta)).toBe('Audio');
      expect(buildImageAttachmentPreviewText(blobUrl, movMeta)).toBe('File');
    });

    it('keeps reply previews of encrypted images text-only, without a blob URL or decryption data', () => {
      expect(
        buildMessageReplyPreviewContent(blobUrl, { attachments: [encryptedAttachment] })
      ).toEqual({ text: 'Picture' });
    });

    it('keeps reply previews of encrypted video and audio text-only, without decryption data', () => {
      for (const mimeType of ['video/mp4', 'audio/mpeg']) {
        const preview = buildMessageReplyPreviewContent(blobUrl, {
          attachments: [{ ...encryptedAttachment, mimeType }],
        });

        expect(preview).toEqual({ text: mimeType.startsWith('video') ? 'Video' : 'Audio' });
      }
    });

    it('round-trips video and audio file-type through kind 15 tags', () => {
      for (const mimeType of ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/flac']) {
        const attachment = { ...encryptedAttachment, mimeType };
        const tags = buildNip17FileMessageTags(attachment);

        expect(parseNip17FileMessageAttachment(blobUrl, tags)).toMatchObject({
          mimeType,
          sha256: attachment.sha256,
          encryption: attachment.encryption,
        });
      }
    });

    it('redacts decryption material for diagnostics', () => {
      expect(redactFileMessageSecretTags([['p', 'peer'], ...fileTags])).toEqual([
        ['p', 'peer'],
        ['file-type', 'image/jpeg'],
        ['encryption-algorithm', 'aes-gcm'],
        ['decryption-key', '[redacted]'],
        ['decryption-nonce', '[redacted]'],
        ['x', ciphertextHash],
        ['ox', plaintextHash],
        ['size', '2048'],
      ]);
    });

    it('recognizes kind 14 and kind 15 as chat message rumors', () => {
      expect(isChatMessageRumorKind(14)).toBe(true);
      expect(isChatMessageRumorKind(15)).toBe(true);
      expect(isChatMessageRumorKind(7)).toBe(false);
      expect(isChatMessageRumorKind('15')).toBe(false);
      expect(resolveChatMessageRumorKind(15)).toBe(15);
      expect(resolveChatMessageRumorKind(14)).toBe(14);
      expect(resolveChatMessageRumorKind(undefined)).toBe(14);
      expect(resolveChatMessageRumorKind(7)).toBe(14);
    });
  });
});
