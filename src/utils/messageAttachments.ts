import { buildMessageTextParts } from '#src/utils/messageTextParts.ts';
import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
import { parseRoomLink } from '#src/utils/callRoom.ts';
import type { MessageAttachmentEncryption, MessageAttachmentMetadata } from '#src/types/chat.ts';
import { normalizeMimeType, resolveEncryptedMediaKind } from '#src/utils/encryptedMedia.ts';
import {
  isValidMediaKeyHex,
  isValidMediaNonceHex,
  MEDIA_ENCRYPTION_ALGORITHM,
  normalizeSha256Hex,
} from '#src/utils/mediaCrypto.ts';

const IMETA_TAG_NAME = 'imeta';
export const IMAGE_ATTACHMENT_PREVIEW_TEXT = 'Picture';
const VIDEO_ATTACHMENT_PREVIEW_TEXT = 'Video';
const AUDIO_ATTACHMENT_PREVIEW_TEXT = 'Audio';
const FILE_ATTACHMENT_PREVIEW_TEXT = 'File';

// NIP-17 rumor kinds rendered as chat messages.
const CHAT_MESSAGE_KIND = 14;
export const FILE_MESSAGE_KIND = 15;

const FILE_TYPE_TAG = 'file-type';
const ENCRYPTION_ALGORITHM_TAG = 'encryption-algorithm';
const DECRYPTION_KEY_TAG = 'decryption-key';
const DECRYPTION_NONCE_TAG = 'decryption-nonce';
const HASH_TAG = 'x';
const ORIGINAL_HASH_TAG = 'ox';
const SIZE_TAG = 'size';

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

export function resolveSafeInlineImageMimeType(value: unknown): string | null {
  const info = resolveEncryptedMediaKind(value);
  return info?.kind === 'image' ? info.canonicalMime : null;
}

export function normalizeEncryptedMediaUrl(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return null;
    }

    // Keep the original spelling so it still matches the rumor content.
    return text;
  } catch {
    return null;
  }
}

function normalizeAttachmentEncryption(value: unknown): MessageAttachmentEncryption | null {
  if (!isRecord(value)) {
    return null;
  }

  const algorithm = normalizeText(value.algorithm).toLowerCase();
  const key = normalizeText(value.key).toLowerCase();
  const nonce = normalizeText(value.nonce).toLowerCase();
  if (
    algorithm !== MEDIA_ENCRYPTION_ALGORITHM ||
    !isValidMediaKeyHex(key) ||
    !isValidMediaNonceHex(nonce)
  ) {
    return null;
  }

  const originalSha256 = normalizeSha256Hex(value.originalSha256);
  return {
    algorithm: MEDIA_ENCRYPTION_ALGORITHM,
    key,
    nonce,
    ...(originalSha256 ? { originalSha256 } : {}),
  };
}

export function normalizeMessageAttachment(input: unknown): MessageAttachmentMetadata | null {
  if (!isRecord(input)) {
    return null;
  }

  const url = normalizeText(input.url);
  const mimeType = normalizeText(input.mimeType);
  const size = normalizePositiveInteger(input.size);
  const sha256 = normalizeText(input.sha256).toLowerCase();
  const name = normalizeText(input.name);
  const uploadedAt = normalizeText(input.uploadedAt);
  const service = normalizeText(input.service);

  let encryption: MessageAttachmentEncryption | null = null;
  if (input.encryption !== undefined) {
    // An attachment that claims encryption but cannot be decrypted must never fall back to
    // being treated as a plaintext URL.
    encryption = normalizeAttachmentEncryption(input.encryption);
    if (!encryption || !normalizeSha256Hex(sha256) || !normalizeEncryptedMediaUrl(url)) {
      return null;
    }
  }

  // size is required for legacy imeta media but optional for NIP-17 kind 15 files.
  if (!url || !mimeType || (!size && !encryption)) {
    return null;
  }

  return {
    type: 'media',
    url,
    mimeType,
    ...(size ? { size } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(name ? { name } : {}),
    ...(uploadedAt ? { uploadedAt } : {}),
    ...(service ? { service } : {}),
    ...(encryption ? { encryption } : {}),
  };
}

export function isEncryptedAttachment(
  attachment: MessageAttachmentMetadata,
): attachment is MessageAttachmentMetadata & { encryption: MessageAttachmentEncryption } {
  return Boolean(attachment.encryption);
}

export function isChatMessageRumorKind(kind: unknown): kind is 14 | 15 {
  return kind === CHAT_MESSAGE_KIND || kind === FILE_MESSAGE_KIND;
}

export function resolveChatMessageRumorKind(kind: unknown): 14 | 15 {
  return Number(kind) === FILE_MESSAGE_KIND ? FILE_MESSAGE_KIND : CHAT_MESSAGE_KIND;
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
  if (!normalized?.size || normalized.encryption) {
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

// NIP-17 kind 15 file-message tags. The URL is the rumor content.
export function buildNip17FileMessageTags(attachment: MessageAttachmentMetadata): string[][] {
  const normalized = normalizeMessageAttachment(attachment);
  if (!normalized?.encryption || !normalized.sha256) {
    return [];
  }

  const { encryption } = normalized;
  return [
    [FILE_TYPE_TAG, normalizeMimeType(normalized.mimeType)],
    [ENCRYPTION_ALGORITHM_TAG, encryption.algorithm],
    [DECRYPTION_KEY_TAG, encryption.key],
    [DECRYPTION_NONCE_TAG, encryption.nonce],
    [HASH_TAG, normalized.sha256],
    ...(encryption.originalSha256 ? [[ORIGINAL_HASH_TAG, encryption.originalSha256]] : []),
    ...(normalized.size ? [[SIZE_TAG, String(normalized.size)]] : []),
  ];
}

function readSingleTagValue(tags: string[][], name: string): string {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name) {
      return normalizeText(tag[1]);
    }
  }

  return '';
}

export function parseNip17FileMessageAttachment(
  content: unknown,
  tags: string[][],
): MessageAttachmentMetadata | null {
  const url = normalizeEncryptedMediaUrl(content);
  const mimeType = normalizeMimeType(readSingleTagValue(tags, FILE_TYPE_TAG));
  const algorithm = readSingleTagValue(tags, ENCRYPTION_ALGORITHM_TAG).toLowerCase();
  const key = readSingleTagValue(tags, DECRYPTION_KEY_TAG).toLowerCase();
  const nonce = readSingleTagValue(tags, DECRYPTION_NONCE_TAG).toLowerCase();
  const sha256 = normalizeSha256Hex(readSingleTagValue(tags, HASH_TAG));
  if (
    !url ||
    !mimeType ||
    algorithm !== MEDIA_ENCRYPTION_ALGORITHM ||
    !isValidMediaKeyHex(key) ||
    !isValidMediaNonceHex(nonce) ||
    !sha256
  ) {
    return null;
  }

  const originalSha256 = normalizeSha256Hex(readSingleTagValue(tags, ORIGINAL_HASH_TAG));
  const size = normalizePositiveInteger(readSingleTagValue(tags, SIZE_TAG));
  return {
    type: 'media',
    url,
    mimeType,
    ...(size ? { size } : {}),
    sha256,
    encryption: {
      algorithm: MEDIA_ENCRYPTION_ALGORITHM,
      key,
      nonce,
      ...(originalSha256 ? { originalSha256 } : {}),
    },
  };
}

const SECRET_FILE_MESSAGE_TAGS = new Set([DECRYPTION_KEY_TAG, DECRYPTION_NONCE_TAG]);
const REDACTED_TAG_VALUE = '[redacted]';

// For diagnostics only: hides the kind 15 key and nonce while keeping the tag shape.
export function redactFileMessageSecretTags(tags: unknown[]): unknown[] {
  return tags.map((tag) =>
    Array.isArray(tag) && SECRET_FILE_MESSAGE_TAGS.has(tag[0])
      ? [tag[0], ...tag.slice(1).map(() => REDACTED_TAG_VALUE)]
      : tag,
  );
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
  if (attachment.type !== 'media') {
    return false;
  }

  // Encrypted blobs are rendered from decrypted bytes, so only allowlisted rasters qualify.
  return attachment.encryption
    ? resolveSafeInlineImageMimeType(attachment.mimeType) !== null
    : /^image\//iu.test(attachment.mimeType);
}

// Encrypted attachments rendered with <video> or <audio> after an explicit user action.
export function isPlayableEncryptedAttachment(attachment: MessageAttachmentMetadata): boolean {
  if (attachment.type !== 'media' || !attachment.encryption) {
    return false;
  }

  const kind = resolveEncryptedMediaKind(attachment.mimeType)?.kind;
  return kind === 'video' || kind === 'audio';
}

function readMediaAttachmentsFromMeta(
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
    .filter((attachment): attachment is MessageAttachmentMetadata => attachment !== null);
}

export function readPlayableEncryptedAttachmentsFromMeta(
  meta: { attachments?: unknown } | null | undefined,
): MessageAttachmentMetadata[] {
  return readMediaAttachmentsFromMeta(meta).filter((attachment) =>
    isPlayableEncryptedAttachment(attachment),
  );
}

export function readImageAttachmentsFromMeta(
  meta:
    | {
        attachments?: unknown;
      }
    | null
    | undefined,
): MessageAttachmentMetadata[] {
  return readMediaAttachmentsFromMeta(meta).filter((attachment) => isImageAttachment(attachment));
}

// URLs that should not be shown as message text: rendered images and every encrypted blob
// (an encrypted blob URL is meaningless without the key).
export function readHiddenAttachmentUrls(
  meta: { attachments?: unknown } | null | undefined,
): string[] {
  return Array.from(
    new Set(
      readMediaAttachmentsFromMeta(meta)
        .filter((attachment) => isImageAttachment(attachment) || isEncryptedAttachment(attachment))
        .map((attachment) => attachment.url.trim())
        .filter(Boolean),
    ),
  );
}

export function buildImageAttachmentPreviewText(
  text: string,
  meta: { attachments?: unknown } | null | undefined,
): string {
  const normalizedText = normalizeText(text);
  const hiddenUrls = readHiddenAttachmentUrls(meta);
  if (hiddenUrls.length === 0) {
    return normalizedText;
  }

  let previewText = normalizedText;
  for (const url of hiddenUrls) {
    previewText = previewText.split(url).join(' ');
  }

  const fallbackText =
    readImageAttachmentsFromMeta(meta).length > 0
      ? IMAGE_ATTACHMENT_PREVIEW_TEXT
      : resolveEncryptedPreviewFallback(meta);
  return previewText.replace(/\s+/gu, ' ').trim() || fallbackText;
}

function resolveEncryptedPreviewFallback(
  meta: { attachments?: unknown } | null | undefined,
): string {
  const attachment = readPlayableEncryptedAttachmentsFromMeta(meta)[0];
  const kind = attachment ? resolveEncryptedMediaKind(attachment.mimeType)?.kind : null;
  if (kind === 'video') {
    return VIDEO_ATTACHMENT_PREVIEW_TEXT;
  }
  return kind === 'audio' ? AUDIO_ATTACHMENT_PREVIEW_TEXT : FILE_ATTACHMENT_PREVIEW_TEXT;
}

export function buildMessageReplyPreviewContent(
  text: string,
  meta: { attachments?: unknown; deleted?: unknown } | null | undefined,
): MessageReplyPreviewContent {
  if (meta?.deleted) return { text: 'Message deleted' };
  const attachments = new Map<string, string>();
  // Encrypted blob URLs point at ciphertext: labelled from the allowlist, never used as an image.
  const encryptedUrls = new Set<string>();
  if (Array.isArray(meta?.attachments))
    for (const attachment of meta.attachments) {
      if (!isRecord(attachment)) continue;
      if (attachment.encryption !== undefined) {
        const normalized = normalizeMessageAttachment(attachment);
        if (!normalized?.encryption) continue;
        try {
          const href = new URL(normalized.url).href;
          const kind = resolveEncryptedMediaKind(normalized.mimeType)?.kind;
          encryptedUrls.add(href);
          attachments.set(
            href,
            isImageAttachment(normalized)
              ? 'Picture'
              : kind === 'video'
                ? 'Video'
                : kind === 'audio'
                  ? 'Audio'
                  : 'File',
          );
        } catch {
          /* normalizeMessageAttachment only keeps valid HTTPS URLs. */
        }
        continue;
      }
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
  let imageUrl =
    [...attachments].find(([url, label]) => label === 'Picture' && !encryptedUrls.has(url))?.[0] ??
    '';
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
      if (label === 'Picture' && !imageUrl && !encryptedUrls.has(part.href)) imageUrl = part.href;
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
