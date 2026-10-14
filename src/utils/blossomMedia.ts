import { normalizeBlossomServerUrl } from '#src/utils/blossomServer.ts';

// NIP-B7 / BUD-03: Blossom addresses a file by its SHA-256, and a server serves it at
// "<server>/<hash>" optionally followed by the file extension.
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HASH_SEGMENT_PATTERN = /^([a-f0-9]{64})(\.[A-Za-z0-9]{1,8})$/u;

// Whole-file verification costs one download in memory, so the same ceiling the client
// applies to its own uploads bounds what can be recovered.
export const BLOSSOM_MEDIA_RECOVERY_MAX_BYTES = 20 * 1024 * 1024;

export function normalizeBlossomSha256(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : null;
}

// Filenames are hex, so the segment is compared in one case: a URL that spells its hash in
// capitals still points at the same file.
function lastPathSegment(url: unknown): string {
  if (typeof url !== 'string') {
    return '';
  }

  try {
    return (new URL(url.trim()).pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase();
  } catch {
    return '';
  }
}

// A media URL that ends in a 64-character hex string is treated as addressable by hash,
// which is what lets a dead link be looked up on the author's other servers.
export function blossomMediaSha256FromUrl(url: unknown): string | null {
  const segment = lastPathSegment(url);
  const match = HASH_SEGMENT_PATTERN.exec(segment);
  if (match) {
    return match[1];
  }

  return normalizeBlossomSha256(segment);
}

// The extension is carried over from the stored URL; a hash with no extension stays bare.
export function blossomMediaExtensionFromUrl(url: unknown): string {
  const match = HASH_SEGMENT_PATTERN.exec(lastPathSegment(url));
  return match?.[2] ?? '';
}

export function buildBlossomServingUrl(
  serverUrl: string,
  sha256: string,
  extension = '',
): string | null {
  const server = normalizeBlossomServerUrl(serverUrl);
  const hash = normalizeBlossomSha256(sha256);
  if (!server || !hash) {
    return null;
  }

  return `${server}/${hash}${extension}`;
}
