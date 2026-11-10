// Single source of truth for which media can be sent end-to-end encrypted (NIP-17 kind 15), and
// how large it may be. Whole-file AES-GCM keeps roughly 3x the file size in memory while
// encrypting, uploading or decrypting, so these limits are deliberately conservative.

export type EncryptedMediaKind = 'image' | 'video' | 'audio';

export interface EncryptedMediaKindInfo {
  kind: EncryptedMediaKind;
  maxBytes: number;
  canonicalMime: string;
}

const MIB = 1024 * 1024;
// AES-GCM appends a 128-bit authentication tag to the plaintext.
const ENCRYPTED_MEDIA_TAG_BYTES = 16;

// The same limit as plaintext Blossom media. Whole-file AES-GCM holds about three copies of the
// file in memory while encrypting or decrypting, which stays modest at this size.
const ENCRYPTED_MEDIA_MAX_BYTES = 20 * MIB;

const ENCRYPTED_MEDIA_TYPES: Record<string, EncryptedMediaKind> = {
  // Raster formats that are safe to hand to <img> from a decrypted blob. SVG and anything
  // document-like is deliberately excluded. HEIC is left out because most browsers cannot show it.
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  // iPhone videos. Chromium and WebKit play H.264 QuickTime files from a decrypted blob.
  'video/quicktime': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  'audio/wav': 'audio',
  'audio/flac': 'audio',
};

// Names browsers report for the same formats, e.g. audio/x-m4a for iPhone voice memos in Chrome.
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
};

export function normalizeMimeType(value: unknown): string {
  return typeof value === 'string' ? (value.trim().split(';')[0]?.trim().toLowerCase() ?? '') : '';
}

export function resolveEncryptedMediaKind(value: unknown): EncryptedMediaKindInfo | null {
  const normalized = normalizeMimeType(value);
  const canonicalMime = MIME_ALIASES[normalized] ?? normalized;
  const kind = Object.hasOwn(ENCRYPTED_MEDIA_TYPES, canonicalMime)
    ? ENCRYPTED_MEDIA_TYPES[canonicalMime]
    : undefined;
  return kind ? { kind, maxBytes: ENCRYPTED_MEDIA_MAX_BYTES, canonicalMime } : null;
}

// Largest ciphertext a receiver will accept for a given plaintext limit.
export function getMaxEncryptedBlobBytes(info: EncryptedMediaKindInfo): number {
  return info.maxBytes + ENCRYPTED_MEDIA_TAG_BYTES;
}

// Approximate size shown on a media placeholder before it is downloaded.
export function formatMediaByteSize(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  if (bytes < MIB) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / MIB).toFixed(1)} MB`;
}
