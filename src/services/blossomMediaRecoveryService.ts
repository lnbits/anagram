import { sha256HexFromBlob } from '#src/services/blossomUploadService.ts';
import {
  BLOSSOM_MEDIA_RECOVERY_MAX_BYTES,
  blossomMediaExtensionFromUrl,
  blossomMediaSha256FromUrl,
  buildBlossomServingUrl,
  normalizeBlossomSha256,
} from '#src/utils/blossomMedia.ts';

export interface BlossomMediaRecoveryTarget {
  authorPublicKey: string;
  sha256?: string;
  size?: number;
  url: string;
}

interface BlossomMediaRecoveryDeps {
  fetchResource?: typeof fetch;
  maxBytes?: number;
  // The author's published Blossom server list (kind 10063), in their own order.
  readAuthorBlossomServerUrls: (publicKey: string) => Promise<string[]>;
  requestTimeoutMs?: number;
}

interface CachedBlob {
  blob: Blob;
  bytes: number;
}

// Verified media is held so scrolling the same message twice does not download it twice.
// Callers own the object URL they create from the blob, so evicting from here never
// invalidates something already on screen.
const MAX_CACHED_BLOBS = 12;
const MAX_CACHED_BYTES = 48 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function createBlossomMediaRecoveryService({
  fetchResource,
  maxBytes = BLOSSOM_MEDIA_RECOVERY_MAX_BYTES,
  readAuthorBlossomServerUrls,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: BlossomMediaRecoveryDeps) {
  const recovered = new Map<string, CachedBlob>();
  const unrecoverable = new Set<string>();
  const inFlight = new Map<string, Promise<Blob | null>>();
  const request = (url: string, init: RequestInit): Promise<Response> =>
    fetchResource ? fetchResource(url, init) : globalThis.fetch(url, init);

  function remember(url: string, blob: Blob): void {
    recovered.set(url, { blob, bytes: blob.size });
    let totalBytes = 0;
    for (const entry of recovered.values()) totalBytes += entry.bytes;
    while (recovered.size > MAX_CACHED_BLOBS || totalBytes > MAX_CACHED_BYTES) {
      const oldestKey = recovered.keys().next().value;
      if (oldestKey === undefined || oldestKey === url) break;
      const evicted = recovered.get(oldestKey);
      recovered.delete(oldestKey);
      totalBytes -= evicted?.bytes ?? 0;
    }
  }

  async function downloadVerified(candidateUrl: string, sha256: string): Promise<Blob | null> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await request(candidateUrl, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }

      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        return null;
      }

      const blob = await response.blob();
      if (blob.size <= 0 || blob.size > maxBytes) {
        return null;
      }

      // The bytes handed to the caller are the bytes that were checked against the hash.
      return (await sha256HexFromBlob(blob)) === sha256 ? blob : null;
    } catch {
      return null;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  async function runRecovery(target: BlossomMediaRecoveryTarget): Promise<Blob | null> {
    const sha256 = normalizeBlossomSha256(target.sha256) ?? blossomMediaSha256FromUrl(target.url);
    if (!sha256) {
      return null;
    }

    if (typeof target.size === 'number' && target.size > maxBytes) {
      return null;
    }

    const extension = blossomMediaExtensionFromUrl(target.url);
    const originalHost = hostOf(target.url);
    const serverUrls = await readAuthorBlossomServerUrls(target.authorPublicKey);
    for (const serverUrl of serverUrls) {
      const candidateUrl = buildBlossomServingUrl(serverUrl, sha256, extension);
      // The server the link already points at has just failed.
      if (!candidateUrl || hostOf(candidateUrl) === originalHost) {
        continue;
      }

      const blob = await downloadVerified(candidateUrl, sha256);
      if (blob) {
        remember(target.url, blob);
        return blob;
      }
    }

    unrecoverable.add(target.url);
    return null;
  }

  // One attempt per URL per session, shared between every component showing that URL.
  async function recoverMedia(target: BlossomMediaRecoveryTarget): Promise<Blob | null> {
    const cached = recovered.get(target.url);
    if (cached) {
      return cached.blob;
    }

    if (unrecoverable.has(target.url)) {
      return null;
    }

    const pending = inFlight.get(target.url);
    if (pending) {
      return pending;
    }

    const attempt = runRecovery(target)
      .catch(() => null)
      .finally(() => {
        inFlight.delete(target.url);
      });
    inFlight.set(target.url, attempt);
    return attempt;
  }

  function reset(): void {
    recovered.clear();
    unrecoverable.clear();
    inFlight.clear();
  }

  return { recoverMedia, reset };
}
