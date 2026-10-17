import { createEncryptedMediaService } from '#src/services/encryptedMediaService.ts';
import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import { encryptMediaBytes, sha256Hex } from '#src/utils/mediaCrypto.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MIB = 1024 * 1024;
// Plaintext limit plus the 16-byte AES-GCM tag.
const MAX_IMAGE_BLOB_BYTES = 20 * MIB + 16;
const MAX_AUDIO_BLOB_BYTES = 10 * MIB + 16;
const PLAINTEXT = new Uint8Array(new TextEncoder().encode('decrypted-image-bytes'));

async function createEncryptedFixture(mimeType = 'image/png') {
  const encrypted = await encryptMediaBytes(PLAINTEXT);
  const sha256 = await sha256Hex(encrypted.ciphertext);
  const attachment: MessageAttachmentMetadata = {
    type: 'media',
    url: `https://blossom.example.com/${sha256}`,
    mimeType,
    size: encrypted.ciphertext.byteLength,
    sha256,
    encryption: { algorithm: 'aes-gcm', key: encrypted.key, nonce: encrypted.nonce },
  };
  return { attachment, ciphertext: encrypted.ciphertext };
}

function createHarness(body: Uint8Array<ArrayBuffer> | (() => Response)) {
  let objectUrlCounter = 0;
  const fetch = vi.fn(async () =>
    typeof body === 'function' ? body() : new Response(new Uint8Array(body), { status: 200 })
  );
  const createObjectURL = vi.fn((_blob: Blob) => {
    objectUrlCounter += 1;
    return `blob:anagram/${objectUrlCounter}`;
  });
  const revokeObjectURL = vi.fn();
  const service = createEncryptedMediaService({
    fetch: fetch as unknown as typeof globalThis.fetch,
    createObjectURL,
    revokeObjectURL,
  });
  return { service, fetch, createObjectURL, revokeObjectURL };
}

describe('encryptedMediaService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads, verifies, and decrypts into a blob with the allowlisted MIME type', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture('image/jpg');
    const { service, fetch } = createHarness(ciphertext);

    const blob = await service.fetchDecryptedMediaBlob(attachment);

    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PLAINTEXT);
    expect(fetch).toHaveBeenCalledWith(attachment.url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('rejects a blob whose hash does not match x without decrypting it', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    const decryptSpy = vi.spyOn(globalThis.crypto.subtle, 'decrypt');
    const { service, createObjectURL } = createHarness(tampered);

    await expect(service.fetchDecryptedMediaBlob(attachment)).rejects.toThrow(
      'Encrypted media hash does not match the message.'
    );
    await expect(service.acquireDecryptedObjectUrl(attachment)).rejects.toThrow(
      'Encrypted media hash does not match the message.'
    );
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('fails safely when the hash matches but GCM authentication fails', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const tampered = new Uint8Array(ciphertext);
    tampered[1] ^= 0xff;
    const forgedAttachment = { ...attachment, sha256: await sha256Hex(tampered) };
    const { service, createObjectURL } = createHarness(tampered);

    await expect(service.acquireDecryptedObjectUrl(forgedAttachment)).rejects.toThrow(
      'Encrypted media could not be decrypted.'
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'video/quicktime',
  ])('never turns %s into a renderable object URL', async (mimeType) => {
    const { attachment, ciphertext } = await createEncryptedFixture(mimeType);
    const { service, fetch, createObjectURL } = createHarness(ciphertext);

    await expect(service.acquireDecryptedObjectUrl(attachment)).rejects.toThrow(
      'This encrypted attachment type cannot be displayed.'
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('refuses non-HTTPS blob URLs', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const { service, fetch } = createHarness(ciphertext);

    await expect(
      service.fetchDecryptedMediaBlob({ ...attachment, url: 'http://blossom.example.com/x' })
    ).rejects.toThrow('Encrypted media URL must use HTTPS.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses plaintext attachments', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const { service } = createHarness(ciphertext);
    const { encryption: _encryption, ...plain } = attachment;

    await expect(service.fetchDecryptedMediaBlob(plain)).rejects.toThrow(
      'Attachment is not encrypted.'
    );
  });

  it('reports HTTP failures and oversized downloads', async () => {
    const { attachment } = await createEncryptedFixture();
    const missing = createHarness(() => new Response('', { status: 404 }));
    const oversized = createHarness(
      () =>
        new Response('', {
          status: 200,
          headers: { 'Content-Length': String(MAX_IMAGE_BLOB_BYTES + 1) },
        })
    );

    await expect(missing.service.fetchDecryptedMediaBlob(attachment)).rejects.toThrow(
      'Encrypted media download failed with HTTP 404.'
    );
    await expect(oversized.service.fetchDecryptedMediaBlob(attachment)).rejects.toThrow(
      'Encrypted media is too large to download.'
    );
  });

  it('shares one object URL per attachment and revokes it after the last release', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const { service, fetch, createObjectURL, revokeObjectURL } = createHarness(ciphertext);

    const [first, second] = await Promise.all([
      service.acquireDecryptedObjectUrl(attachment),
      service.acquireDecryptedObjectUrl({ ...attachment }),
    ]);

    expect(first).toBe('blob:anagram/1');
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    service.releaseDecryptedObjectUrl(attachment);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    service.releaseDecryptedObjectUrl(attachment);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:anagram/1');

    await expect(service.acquireDecryptedObjectUrl(attachment)).resolves.toBe('blob:anagram/2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('revokes an object URL that finishes loading after its view was released', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    const { service, createObjectURL, revokeObjectURL } = createHarness(ciphertext);

    const pending = service.acquireDecryptedObjectUrl(attachment);
    service.releaseDecryptedObjectUrl(attachment);

    await expect(pending).rejects.toThrow('released before it finished loading');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:anagram/1');
  });

  it('does not cache failed loads so a later view can retry', async () => {
    const { attachment, ciphertext } = await createEncryptedFixture();
    let calls = 0;
    const { service } = createHarness(() => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response(new Uint8Array(ciphertext), { status: 200 });
    });

    await expect(service.acquireDecryptedObjectUrl(attachment)).rejects.toThrow('HTTP 503');
    await expect(service.acquireDecryptedObjectUrl(attachment)).resolves.toBe('blob:anagram/1');
  });

  describe('video and audio', () => {
    it.each([
      ['video/mp4'],
      ['video/webm'],
      ['audio/mpeg'],
      ['audio/mp4'],
      ['audio/aac'],
      ['audio/ogg'],
      ['audio/webm'],
      ['audio/wav'],
      ['audio/flac'],
    ])('decrypts %s and preserves its MIME type', async (mimeType) => {
      const { attachment, ciphertext } = await createEncryptedFixture(mimeType);
      const { service } = createHarness(ciphertext);

      const blob = await service.fetchDecryptedMediaBlob(attachment);

      expect(blob.type).toBe(mimeType);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PLAINTEXT);
    });

    it.each([
      ['video/quicktime'],
      ['video/x-matroska'],
      ['audio/x-ms-wma'],
      ['image/svg+xml'],
      ['text/html'],
    ])('refuses %s before downloading anything', async (mimeType) => {
      const { attachment, ciphertext } = await createEncryptedFixture(mimeType);
      const { service, fetch, createObjectURL } = createHarness(ciphertext);

      await expect(service.acquireDecryptedObjectUrl(attachment)).rejects.toThrow(
        'This encrypted attachment type cannot be displayed.'
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });

  describe('receive size limits', () => {
    function streamOf(chunkBytes: number, headers: Record<string, string> = {}) {
      const state = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulled += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, response: () => new Response(body, { status: 200, headers }) };
    }

    it('rejects from the declared size metadata without any request', async () => {
      const { attachment } = await createEncryptedFixture('video/mp4');
      const { service, fetch } = createHarness(new Uint8Array());

      await expect(
        service.fetchDecryptedMediaBlob({ ...attachment, size: MAX_IMAGE_BLOB_BYTES + 1 })
      ).rejects.toThrow('Encrypted media is too large to download.');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('applies the lower audio limit to size metadata, Content-Length and streamed bytes', async () => {
      const { attachment } = await createEncryptedFixture('audio/mpeg');
      const bySize = createHarness(new Uint8Array());
      const byHeader = createHarness(
        () =>
          new Response('', {
            status: 200,
            headers: { 'Content-Length': String(MAX_AUDIO_BLOB_BYTES + 1) },
          })
      );
      const stream = streamOf(MIB);
      const byStream = createHarness(stream.response);

      await expect(
        bySize.service.fetchDecryptedMediaBlob({ ...attachment, size: MAX_AUDIO_BLOB_BYTES + 1 })
      ).rejects.toThrow('too large');
      expect(bySize.fetch).not.toHaveBeenCalled();
      await expect(byHeader.service.fetchDecryptedMediaBlob(attachment)).rejects.toThrow(
        'too large'
      );
      await expect(
        byStream.service.fetchDecryptedMediaBlob({ ...attachment, size: undefined })
      ).rejects.toThrow('too large');
      expect(stream.state.cancelled).toBe(true);
    });

    it('stops reading an unbounded body when Content-Length is absent', async () => {
      const { attachment } = await createEncryptedFixture('video/webm');
      const stream = streamOf(MIB);
      const { service, createObjectURL } = createHarness(stream.response);

      await expect(
        service.fetchDecryptedMediaBlob({ ...attachment, size: undefined })
      ).rejects.toThrow('Encrypted media is too large to download.');

      expect(stream.state.cancelled).toBe(true);
      // The 20 MiB video limit (plus tag) bounds how much is ever pulled from the network.
      expect(stream.state.pulled).toBeLessThanOrEqual(23 * MIB);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('stops reading when Content-Length understates the real body', async () => {
      const { attachment } = await createEncryptedFixture('video/mp4');
      const stream = streamOf(MIB, { 'Content-Length': '1024' });
      const { service } = createHarness(stream.response);

      await expect(
        service.fetchDecryptedMediaBlob({ ...attachment, size: undefined })
      ).rejects.toThrow('Encrypted media is too large to download.');
      expect(stream.state.cancelled).toBe(true);
    });

    it('still accepts a ciphertext of exactly the maximum size', async () => {
      const { attachment } = await createEncryptedFixture('audio/mpeg');
      const { service } = createHarness(new Uint8Array(MAX_AUDIO_BLOB_BYTES));

      // Within the limit, so the failure is the hash check, not the size check.
      await expect(
        service.fetchDecryptedMediaBlob({ ...attachment, size: undefined })
      ).rejects.toThrow('Encrypted media hash does not match the message.');
    });
  });
});
