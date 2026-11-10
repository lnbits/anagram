import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import {
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
  signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
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
  video: 'Only MP4, MOV, and WebM videos can be sent encrypted.',
  audio: 'Only MP3, MP4/AAC, Ogg, WebM, WAV, and FLAC audio can be sent encrypted.',
};

// Validates image, video and audio for private (encrypted) sending: the general media checks and
// the type allowlist from the central resolver.
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

  return null;
}

export async function sha256HexFromBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type BlossomUploadErrorKind =
  | 'network'
  | 'auth'
  | 'payment'
  | 'too-large'
  | 'unsupported-type'
  | 'server'
  | 'invalid-response'
  | 'integrity';

// An upload failure with its cause, so callers can offer the right recovery instead of assuming
// that every failure is caused by encryption.
export class BlossomUploadError extends Error {
  constructor(
    readonly kind: BlossomUploadErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'BlossomUploadError';
  }
}

const MAX_SERVER_REASON_LENGTH = 160;

// Servers explain rejections in X-Reason or the body. Only short plain text is shown; HTML pages
// and long bodies are dropped. X-Reason is often not exposed to the browser cross-origin.
async function readServerReason(response: Response): Promise<string> {
  const text = response.headers.get('X-Reason') || (await response.text().catch(() => '')) || '';
  const reason = text.replace(/\s+/gu, ' ').trim();
  if (!reason || /<[a-z!/]/iu.test(reason)) {
    return '';
  }

  return reason.length > MAX_SERVER_REASON_LENGTH
    ? `${reason.slice(0, MAX_SERVER_REASON_LENGTH - 1)}…`
    : reason;
}

async function classifyUploadResponse(
  response: Response,
  serverHost: string,
  contentType: string
): Promise<BlossomUploadError> {
  const { status } = response;
  const [kind, message]: [BlossomUploadErrorKind, string] =
    status === 401 || status === 403
      ? ['auth', `${serverHost} refused the upload authorization.`]
      : status === 402
        ? ['payment', `${serverHost} requires payment or an account to upload.`]
        : status === 413
          ? ['too-large', `${serverHost} rejected the file because it is too large.`]
          : status === 415
            ? [
                'unsupported-type',
                contentType === ENCRYPTED_BLOB_CONTENT_TYPE
                  ? `${serverHost} does not accept encrypted files.`
                  : `${serverHost} does not accept this file type.`,
              ]
            : ['server', `${serverHost} could not store the file (HTTP ${status}).`];
  const reason = await readServerReason(response);
  return new BlossomUploadError(kind, reason ? `${message} The server said: ${reason}` : message);
}

interface PutBlossomBlobInput {
  body: Blob | Uint8Array<ArrayBuffer>;
  contentType: string;
  sha256: string;
  serverUrl: string;
  options: UploadBlossomMediaOptions;
}

// A single PUT: the response is authoritative and failures are never retried automatically,
// so a rejected upload is not sent again.
async function putBlossomBlob(input: PutBlossomBlobInput): Promise<BlossomBlobDescriptor> {
  const { body, contentType, sha256, serverUrl, options } = input;
  const serverHost = getBlossomServerHost(serverUrl);
  let authorization: string;
  try {
    authorization = await options.signUploadAuthHeader({ serverUrl, sha256 });
  } catch {
    throw new BlossomUploadError('auth', 'The upload authorization could not be signed.');
  }

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
    if (options.signal?.aborted) {
      throw error;
    }
    // Browsers also report a rejection without CORS headers as an opaque network error.
    throw new BlossomUploadError(
      'network',
      `Could not reach ${serverHost}. Check your connection, or try another server.`
    );
  }

  if (response.status !== 200 && response.status !== 201) {
    throw await classifyUploadResponse(response, serverHost, contentType);
  }

  const descriptor = normalizeBlobDescriptor(await response.json().catch(() => null));
  if (!descriptor) {
    throw new BlossomUploadError(
      'invalid-response',
      `${serverHost} returned an invalid upload response.`
    );
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
  const descriptor = await putBlossomBlob({
    body: file,
    contentType: file.type,
    sha256,
    serverUrl,
    options,
  });

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
    options,
  });

  if (descriptor.sha256 !== sha256) {
    throw new BlossomUploadError(
      'integrity',
      `${serverHost} stored a blob with an unexpected hash.`
    );
  }

  // Same HTTPS rule the kind 15 message and its receivers enforce. Checked here so a bad URL is
  // an upload error the user can retry or route to another server, not a silently dropped send.
  const blobUrl = normalizeEncryptedMediaUrl(descriptor.url);
  if (!blobUrl) {
    throw new BlossomUploadError(
      'invalid-response',
      `${serverHost} returned a blob URL that does not use HTTPS.`
    );
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
