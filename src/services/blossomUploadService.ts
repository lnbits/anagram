import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import {
  type BlossomAuthAction,
  buildBlossomUploadUrl,
  getBlossomServerHost,
  requireBlossomServerUrl,
} from '#src/utils/blossomServer.ts';
import { type EncryptedMediaKind, resolveEncryptedMediaKind } from '#src/utils/encryptedMedia.ts';
import { encryptMediaBytes, MEDIA_ENCRYPTION_ALGORITHM, sha256Hex } from '#src/utils/mediaCrypto.ts';
import { normalizeEncryptedMediaUrl } from '#src/utils/messageAttachments.ts';

export const BLOSSOM_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const ENCRYPTED_BLOB_CONTENT_TYPE = 'application/octet-stream';

export interface BlossomUploadResult {
  attachment: MessageAttachmentMetadata;
  descriptor: BlossomBlobDescriptor;
}

interface BlossomBlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded?: number;
}

interface UploadBlossomMediaOptions {
  serverUrl: string;
  signal?: AbortSignal;
  signUploadAuthHeader: (input: {
    serverUrl: string;
    sha256: string;
    action?: BlossomAuthAction;
  }) => Promise<string>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Math.floor(numeric);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBlobDescriptor(value: unknown): BlossomBlobDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = normalizeString(value.url);
  const sha256 = normalizeString(value.sha256).toLowerCase();
  const type = normalizeString(value.type);
  const size = normalizePositiveInteger(value.size);
  const uploaded = normalizePositiveInteger(value.uploaded);
  if (!url || !sha256 || !type || !size) {
    return null;
  }

  return {
    url,
    sha256,
    size,
    type,
    ...(uploaded ? { uploaded } : {}),
  };
}

export function isCommonBlossomMediaFile(file: File): boolean {
  return /^(image|video|audio)\//u.test(file.type);
}

export function validateBlossomMediaFile(file: File): string | null {
  if (!isCommonBlossomMediaFile(file)) {
    return 'Only image, video, and audio files are supported.';
  }

  if (file.size <= 0) {
    return 'The selected file is empty.';
  }

  if (file.size > BLOSSOM_MEDIA_MAX_BYTES) {
    return 'Media uploads are limited to 20 MiB.';
  }

  return null;
}

const UNSUPPORTED_ENCRYPTED_MEDIA_MESSAGES: Record<EncryptedMediaKind, string> = {
  image: 'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.',
  video: 'Only MP4 and WebM videos can be sent encrypted.',
  audio: 'Only MP3, MP4/AAC, Ogg, WebM, WAV, and FLAC audio can be sent encrypted.',
};

// Validates image, video and audio for private (encrypted) sending: type allowlist and the
// per-kind size limit from the central resolver.
export function validateEncryptedMediaFile(file: File): string | null {
  const baseError = validateBlossomMediaFile(file);
  if (baseError) {
    return baseError;
  }

  const info = resolveEncryptedMediaKind(file.type);
  if (!info) {
    const category = file.type.split('/')[0].toLowerCase() as EncryptedMediaKind;
    return UNSUPPORTED_ENCRYPTED_MEDIA_MESSAGES[category];
  }

  if (file.size > info.maxBytes) {
    return `Encrypted ${info.kind} uploads are limited to ${info.maxBytes / (1024 * 1024)} MiB.`;
  }

  return null;
}

export async function sha256HexFromBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readUploadError(response: Response, serverHost: string): Promise<string> {
  const reason = response.headers.get('X-Reason')?.trim();
  if (reason) {
    return reason;
  }

  const body = (await response.text().catch(() => '')).trim();
  if (body) {
    return body;
  }

  return `${serverHost} upload failed with HTTP ${response.status}.`;
}

interface PutBlossomBlobInput {
  body: Blob | Uint8Array<ArrayBuffer>;
  contentType: string;
  sha256: string;
  serverUrl: string;
  serverHost: string;
  options: UploadBlossomMediaOptions;
  unreachableMessage?: string;
}

// A single PUT: the response is authoritative and failures are never retried automatically,
// so a rejected upload is not sent again.
async function putBlossomBlob(input: PutBlossomBlobInput): Promise<BlossomBlobDescriptor> {
  const { body, contentType, sha256, serverUrl, serverHost, options } = input;
  const authorization = await options.signUploadAuthHeader({ serverUrl, sha256 });
  let response: Response;
  try {
    response = await fetch(buildBlossomUploadUrl(serverUrl), {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': contentType,
        'X-SHA-256': sha256,
      },
      body,
      signal: options.signal,
    });
  } catch (error) {
    // Browsers report a rejection without CORS headers as an opaque network error.
    if (input.unreachableMessage && !options.signal?.aborted) {
      throw new Error(input.unreachableMessage);
    }
    throw error;
  }

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await readUploadError(response, serverHost));
  }

  const descriptor = normalizeBlobDescriptor(await response.json().catch(() => null));
  if (!descriptor) {
    throw new Error(`${serverHost} returned an invalid upload response.`);
  }

  return descriptor;
}

export async function uploadBlossomMedia(
  file: File,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const validationError = validateBlossomMediaFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const sha256 = await sha256HexFromBlob(file);
  const authorization = await options.signUploadAuthHeader({ serverUrl, sha256 });
  const response = await fetch(buildBlossomUploadUrl(serverUrl), {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': file.type,
      'X-SHA-256': sha256,
    },
    body: file,
    signal: options.signal,
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await readUploadError(response, serverHost));
  }

  const descriptor = normalizeBlobDescriptor(await response.json().catch(() => null));
  if (!descriptor) {
    throw new Error(`${serverHost} returned an invalid upload response.`);
  }

  const uploadedAt = descriptor.uploaded ? new Date(descriptor.uploaded * 1000).toISOString() : '';

  return {
    descriptor,
    attachment: {
      type: 'media',
      url: descriptor.url,
      mimeType: descriptor.type,
      size: descriptor.size,
      sha256: descriptor.sha256,
      name: file.name,
      service: serverHost,
      ...(uploadedAt ? { uploadedAt } : {}),
    },
  };
}

// Everything an encrypted upload needs, produced by a single encryption pass. A retry reuses
// this object so the key, nonce and ciphertext never change between attempts.
export interface PreparedEncryptedMedia {
  ciphertext: Uint8Array<ArrayBuffer>;
  sha256: string;
  mimeType: string;
  name: string;
  encryption: NonNullable<MessageAttachmentMetadata['encryption']>;
}

// Encrypts the original media bytes once. The key and nonce stay on the client until they are
// placed in the gift-wrapped kind 15 rumor.
export async function prepareEncryptedMedia(file: File): Promise<PreparedEncryptedMedia> {
  const validationError = validateEncryptedMediaFile(file);
  const mimeType = resolveEncryptedMediaKind(file.type)?.canonicalMime;
  if (validationError || !mimeType) {
    throw new Error(validationError ?? 'Unsupported media type.');
  }

  const plaintext = new Uint8Array(await file.arrayBuffer());
  const originalSha256 = await sha256Hex(plaintext);
  const { ciphertext, key, nonce } = await encryptMediaBytes(plaintext);

  return {
    ciphertext,
    sha256: await sha256Hex(ciphertext),
    mimeType,
    name: file.name.trim(),
    encryption: {
      algorithm: MEDIA_ENCRYPTION_ALGORITHM,
      key,
      nonce,
      originalSha256,
    },
  };
}

// Uploads only ciphertext to the private-media Blossom server. There is deliberately no
// plaintext fallback: failures are thrown to the caller, which may retry this same payload.
export async function uploadPreparedEncryptedMedia(
  prepared: PreparedEncryptedMedia,
  options: UploadBlossomMediaOptions
): Promise<BlossomUploadResult> {
  const { ciphertext, sha256, mimeType, name, encryption } = prepared;
  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const descriptor = await putBlossomBlob({
    body: ciphertext,
    contentType: ENCRYPTED_BLOB_CONTENT_TYPE,
    sha256,
    serverUrl,
    serverHost,
    options,
    unreachableMessage: `Could not upload to ${serverHost}. The server may be unavailable or may not accept encrypted file uploads.`,
  });

  if (descriptor.sha256 !== sha256) {
    throw new Error(`${serverHost} stored a blob with an unexpected hash.`);
  }

  // Same HTTPS rule the kind 15 message and its receivers enforce. Checked here so a bad URL is
  // an upload error the user can retry or route to another server, not a silently dropped send.
  const blobUrl = normalizeEncryptedMediaUrl(descriptor.url);
  if (!blobUrl) {
    throw new Error(`${serverHost} returned a blob URL that does not use HTTPS.`);
  }

  const uploadedAt = descriptor.uploaded ? new Date(descriptor.uploaded * 1000).toISOString() : '';

  return {
    descriptor,
    attachment: {
      type: 'media',
      url: blobUrl,
      mimeType,
      size: ciphertext.byteLength,
      sha256,
      ...(name ? { name } : {}),
      service: serverHost,
      ...(uploadedAt ? { uploadedAt } : {}),
      encryption,
    },
  };
}

export interface PrivateMediaServerCheckResult {
  // False when the server accepted the probe blob but would not delete it.
  cleanedUp: boolean;
}

const PROBE_BYTE_LENGTH = 32;

// Verifies that a server preserves uploaded ciphertext byte-for-byte: uploads random bytes the
// same way encrypted images are uploaded, downloads them, and compares hashes. The probe holds
// no user data. Deletion is best effort because not every server supports it.
export async function verifyPrivateMediaServer(
  options: UploadBlossomMediaOptions
): Promise<PrivateMediaServerCheckResult> {
  const serverUrl = requireBlossomServerUrl(options.serverUrl);
  const serverHost = getBlossomServerHost(serverUrl);
  const probe = globalThis.crypto.getRandomValues(new Uint8Array(PROBE_BYTE_LENGTH));
  const sha256 = await sha256Hex(probe);
  const descriptor = await putBlossomBlob({
    body: probe,
    contentType: ENCRYPTED_BLOB_CONTENT_TYPE,
    sha256,
    serverUrl,
    serverHost,
    options,
    unreachableMessage: `Could not reach ${serverHost}. The server may be unavailable or may not allow uploads from this app.`,
  });

  if (descriptor.sha256 !== sha256 || descriptor.size !== PROBE_BYTE_LENGTH) {
    throw new Error(`${serverHost} did not store the test blob unchanged.`);
  }

  if (!/^https:\/\//iu.test(descriptor.url)) {
    throw new Error(`${serverHost} returned an invalid blob URL.`);
  }

  let downloaded: Uint8Array<ArrayBuffer>;
  try {
    const response = await fetch(descriptor.url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`${serverHost} could not return the test blob (HTTP ${response.status}).`);
    }
    downloaded = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(serverHost)) {
      throw error;
    }
    throw new Error(`${serverHost} could not return the test blob.`);
  }

  if ((await sha256Hex(downloaded)) !== sha256) {
    throw new Error(`${serverHost} altered the test blob. It cannot be used for private media.`);
  }

  return { cleanedUp: await deleteBlossomBlob(serverUrl, sha256, options) };
}

async function deleteBlossomBlob(
  serverUrl: string,
  sha256: string,
  options: UploadBlossomMediaOptions
): Promise<boolean> {
  try {
    const authorization = await options.signUploadAuthHeader({
      serverUrl,
      sha256,
      action: 'delete',
    });
    const response = await fetch(`${serverUrl}/${sha256}`, {
      method: 'DELETE',
      headers: { Authorization: authorization },
      signal: options.signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}
