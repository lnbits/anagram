import { buildMessageTextParts } from '#src/utils/messageTextParts.ts';
import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
import { parseRoomLink } from '#src/utils/callRoom.ts';
import type { MessageAttachmentMetadata } from '#src/types/chat.ts';

const IMETA_TAG_NAME = 'imeta';
export const IMAGE_ATTACHMENT_PREVIEW_TEXT = 'Picture';

export interface MessageReplyPreviewContent {
  text: string;
  imageUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.floor(numeric);
}

function readImetaField(entry: string, key: string): string {
  const prefix = `${key} `;
  return entry.startsWith(prefix) ? entry.slice(prefix.length).trim() : '';
}

export function normalizeMessageAttachment(input: unknown): MessageAttachmentMetadata | null {
  if (!isRecord(input)) {
    return null;
  }

  const url = normalizeText(input.url);
  const mimeType = normalizeText(input.mimeType);
  const size = normalizePositiveInteger(input.size);
  if (!url || !mimeType || !size) {
    return null;
  }

  const sha256 = normalizeText(input.sha256).toLowerCase();
  const name = normalizeText(input.name);
  const uploadedAt = normalizeText(input.uploadedAt);
  const service = normalizeText(input.service);

  return {
    type: 'media',
    url,
    mimeType,
    size,
    ...(sha256 ? { sha256 } : {}),
    ...(name ? { name } : {}),
    ...(uploadedAt ? { uploadedAt } : {}),
    ...(service ? { service } : {}),
  };
}

export function buildAttachmentMessageText(attachment: MessageAttachmentMetadata): string {
  return normalizeText(attachment.url);
}

export function buildAttachmentMessageMeta(
  attachment: MessageAttachmentMetadata,
): { attachments: MessageAttachmentMetadata[] } | Record<string, never> {
  const normalized = normalizeMessageAttachment(attachment);
  return normalized ? { attachments: [normalized] } : {};
}

export function buildNip92ImetaTag(attachment: MessageAttachmentMetadata): string[] {
  const normalized = normalizeMessageAttachment(attachment);
  if (!normalized) {
    return [];
  }

  const tag = [
    IMETA_TAG_NAME,
    `url ${normalized.url}`,
    `m ${normalized.mimeType}`,
    `size ${normalized.size}`,
  ];

  if (normalized.sha256) {
    tag.push(`x ${normalized.sha256}`);
  }

  return tag;
}

export function extractMediaAttachmentsFromTags(tags: string[][]): MessageAttachmentMetadata[] {
  const attachments: MessageAttachmentMetadata[] = [];
  const seenUrls = new Set<string>();

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== IMETA_TAG_NAME) {
      continue;
    }

    let url = '';
    let mimeType = '';
    let sha256 = '';
    let size: number | null = null;

    for (const entry of tag.slice(1)) {
      const value = normalizeText(entry);
      if (!value) {
        continue;
      }

      url ||= readImetaField(value, 'url');
      mimeType ||= readImetaField(value, 'm');
      sha256 ||= readImetaField(value, 'x').toLowerCase();
      const sizeValue = readImetaField(value, 'size');
      if (!size && sizeValue) {
        size = normalizePositiveInteger(sizeValue);
      }
    }

    if (!url || !mimeType || !size || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    attachments.push({
      type: 'media',
      url,
      mimeType,
      size,
      ...(sha256 ? { sha256 } : {}),
    });
  }

  return attachments;
}

export function isImageAttachment(attachment: MessageAttachmentMetadata): boolean {
  return attachment.type === 'media' && /^image\//iu.test(attachment.mimeType);
}

export function readImageAttachmentsFromMeta(
  meta:
    | {
        attachments?: unknown;
      }
    | null
    | undefined,
): MessageAttachmentMetadata[] {
  if (!meta || !Array.isArray(meta.attachments)) {
    return [];
  }

  return meta.attachments
    .map((attachment) => normalizeMessageAttachment(attachment))
    .filter((attachment): attachment is MessageAttachmentMetadata =>
      attachment ? isImageAttachment(attachment) : false,
    );
}

export function buildImageAttachmentPreviewText(
  text: string,
  meta: { attachments?: unknown } | null | undefined,
): string {
  const normalizedText = normalizeText(text);
  const imageAttachments = readImageAttachmentsFromMeta(meta);
  if (imageAttachments.length === 0) {
    return normalizedText;
  }

  const attachmentUrls = new Set(
    imageAttachments.map((attachment) => attachment.url.trim()).filter(Boolean),
  );
  let previewText = normalizedText;
  for (const url of attachmentUrls) {
    previewText = previewText.split(url).join(' ');
  }

  return previewText.replace(/\s+/gu, ' ').trim() || IMAGE_ATTACHMENT_PREVIEW_TEXT;
}

export function buildMessageReplyPreviewContent(
  text: string,
  meta: { attachments?: unknown; deleted?: unknown } | null | undefined,
): MessageReplyPreviewContent {
  if (meta?.deleted) return { text: 'Message deleted' };
  const attachments = new Map<string, string>();
  if (Array.isArray(meta?.attachments))
    for (const attachment of meta.attachments) {
      if (!isRecord(attachment)) continue;
      try {
        const url = new URL(normalizeText(attachment.url));
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const mime = normalizeText(attachment.mimeType).toLowerCase();
        attachments.set(
          url.href,
          mime.startsWith('image/')
            ? 'Picture'
            : mime.startsWith('video/')
              ? 'Video'
              : mime.startsWith('audio/')
                ? 'Audio'
                : 'File',
        );
      } catch {
        /* Invalid attachment URLs remain plain text. */
      }
    }
  const mediaLabels = new Set<string>();
  let imageUrl = [...attachments].find(([, label]) => label === 'Picture')?.[0] ?? '';
  const summary = buildMessageTextParts(normalizeText(text))
    .map((part) => {
      if (part.type !== 'url') return part.text;
      if (publicGroupLinkTarget(part.href)) return 'Join chat';
      if (parseRoomLink(part.href)) return 'Join call';
      const path = new URL(part.href).pathname;
      const label =
        attachments.get(part.href) ||
        (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)
          ? 'Picture'
          : /\.(mp4|webm|mov|ogv|m4v)$/i.test(path)
            ? 'Video'
            : /\.(mp3|ogg|wav|m4a|flac)$/i.test(path)
              ? 'Audio'
              : '');
      if (!label) return part.text;
      mediaLabels.add(label);
      if (label === 'Picture' && !imageUrl) imageUrl = part.href;
      return ' ';
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  // Classify full links before truncating: invite tokens can exceed the preview limit.
  const preview =
    (!mediaLabels.size || !/^[\p{P}\s]*$/u.test(summary) ? summary : '') ||
    [...mediaLabels].join(' · ') ||
    normalizeText(text);
  return {
    text: preview.length > 300 ? `${preview.slice(0, 299)}…` : preview,
    ...(imageUrl ? { imageUrl } : {}),
  };
}
