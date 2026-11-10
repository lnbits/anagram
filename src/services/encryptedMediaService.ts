import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import { getMaxEncryptedBlobBytes, resolveEncryptedMediaKind } from '#src/utils/encryptedMedia.ts';
import { verifyAndDecryptMediaBytes } from '#src/utils/mediaCrypto.ts';
import { isEncryptedAttachment, normalizeEncryptedMediaUrl } from '#src/utils/messageAttachments.ts';

const TOO_LARGE_MESSAGE = 'Encrypted media is too large to download.';

interface ObjectUrlEntry {
  refs: number;
  promise: Promise<string>;
  objectUrl: string | null;
  released: boolean;
}

interface EncryptedMediaServiceDeps {
  fetch: typeof globalThis.fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function buildCacheKey(attachment: MessageAttachmentMetadata): string {
  const encryption = attachment.encryption;
  return `${attachment.sha256 ?? ''}:${encryption?.key ?? ''}:${encryption?.nonce ?? ''}`;
}

// Reads the body while counting bytes, so a server that omits or understates Content-Length
// cannot make the client buffer more than maxBytes.
async function readLimitedBody(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(TOO_LARGE_MESSAGE);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(TOO_LARGE_MESSAGE);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(TOO_LARGE_MESSAGE);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createEncryptedMediaService(deps: EncryptedMediaServiceDeps) {
  const objectUrlEntries = new Map<string, ObjectUrlEntry>();

  // Downloads the ciphertext, checks it against the message's x hash, then decrypts. Nothing is
  // returned unless both checks pass, so raw downloaded bytes are never exposed.
  async function fetchDecryptedMediaBlob(attachment: MessageAttachmentMetadata): Promise<Blob> {
    if (!isEncryptedAttachment(attachment)) {
      throw new Error('Attachment is not encrypted.');
    }

    const mediaKind = resolveEncryptedMediaKind(attachment.mimeType);
    if (!mediaKind) {
      throw new Error('This encrypted attachment type cannot be displayed.');
    }

    // The ciphertext is the plaintext limit plus the AES-GCM tag. A declared size is checked
    // before any request; the streamed byte count below is the authoritative limit.
    const maxCiphertextBytes = getMaxEncryptedBlobBytes(mediaKind);
    if (attachment.size && attachment.size > maxCiphertextBytes) {
      throw new Error(TOO_LARGE_MESSAGE);
    }

    const url = normalizeEncryptedMediaUrl(attachment.url);
    if (!url) {
      throw new Error('Encrypted media URL must use HTTPS.');
    }

    const response = await deps.fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      throw new Error(`Encrypted media download failed with HTTP ${response.status}.`);
    }

    const ciphertext = await readLimitedBody(response, maxCiphertextBytes);
    const plaintext = await verifyAndDecryptMediaBytes(ciphertext, {
      sha256: attachment.sha256,
      key: attachment.encryption.key,
      nonce: attachment.encryption.nonce,
    });

    return new Blob([plaintext], { type: mediaKind.canonicalMime });
  }

  // Reference-counted object URLs shared by every view of the same attachment.
  function acquireDecryptedObjectUrl(attachment: MessageAttachmentMetadata): Promise<string> {
    const cacheKey = buildCacheKey(attachment);
    const existing = objectUrlEntries.get(cacheKey);
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }

    const entry: ObjectUrlEntry = {
      refs: 1,
      objectUrl: null,
      released: false,
      promise: Promise.resolve(''),
    };
    entry.promise = fetchDecryptedMediaBlob(attachment).then(
      (blob) => {
        const objectUrl = deps.createObjectURL(blob);
        if (entry.released) {
          deps.revokeObjectURL(objectUrl);
          throw new Error('Encrypted media was released before it finished loading.');
        }
        entry.objectUrl = objectUrl;
        return objectUrl;
      },
      (error: unknown) => {
        // Failed loads are not cached so a later view can retry.
        if (objectUrlEntries.get(cacheKey) === entry) {
          objectUrlEntries.delete(cacheKey);
        }
        throw error;
      }
    );
    objectUrlEntries.set(cacheKey, entry);
    return entry.promise;
  }

  function releaseDecryptedObjectUrl(attachment: MessageAttachmentMetadata): void {
    const cacheKey = buildCacheKey(attachment);
    const entry = objectUrlEntries.get(cacheKey);
    if (!entry) {
      return;
    }

    entry.refs -= 1;
    if (entry.refs > 0) {
      return;
    }

    entry.released = true;
    objectUrlEntries.delete(cacheKey);
    if (entry.objectUrl) {
      deps.revokeObjectURL(entry.objectUrl);
      entry.objectUrl = null;
    }
  }

  return {
    acquireDecryptedObjectUrl,
    fetchDecryptedMediaBlob,
    releaseDecryptedObjectUrl,
  };
}

export const encryptedMediaService = createEncryptedMediaService({
  fetch: (input, init) => globalThis.fetch(input, init),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});
