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

const ENCRYPTED_MEDIA_TYPES: Record<string, { kind: EncryptedMediaKind; maxBytes: number }> = {
  // Raster formats that are safe to hand to <img> from a decrypted blob. SVG and anything
  // document-like is deliberately excluded.
  'image/jpeg': { kind: 'image', maxBytes: 20 * MIB },
  'image/png': { kind: 'image', maxBytes: 20 * MIB },
  'image/gif': { kind: 'image', maxBytes: 20 * MIB },
  'image/webp': { kind: 'image', maxBytes: 20 * MIB },
  'image/avif': { kind: 'image', maxBytes: 20 * MIB },
  'video/mp4': { kind: 'video', maxBytes: 20 * MIB },
  'video/webm': { kind: 'video', maxBytes: 20 * MIB },
  'audio/mpeg': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/mp4': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/aac': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/ogg': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/webm': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/wav': { kind: 'audio', maxBytes: 10 * MIB },
  'audio/flac': { kind: 'audio', maxBytes: 10 * MIB },
};

const MIME_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg' };

export function normalizeMimeType(value: unknown): string {
  return typeof value === 'string' ? (value.trim().split(';')[0]?.trim().toLowerCase() ?? '') : '';
}

export function resolveEncryptedMediaKind(value: unknown): EncryptedMediaKindInfo | null {
  const normalized = normalizeMimeType(value);
  const canonicalMime = MIME_ALIASES[normalized] ?? normalized;
  const entry = Object.hasOwn(ENCRYPTED_MEDIA_TYPES, canonicalMime)
    ? ENCRYPTED_MEDIA_TYPES[canonicalMime]
    : undefined;
  return entry ? { ...entry, canonicalMime } : null;
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
