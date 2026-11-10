import {
  prepareEncryptedMedia,
  BlossomUploadError,
  sha256HexFromBlob,
  uploadBlossomMedia,
  uploadPreparedEncryptedMedia,
  validateBlossomMediaFile,
  validateEncryptedMediaFile,
} from '#src/services/blossomUploadService.ts';
import { decryptMediaBytes, sha256Hex } from '#src/utils/mediaCrypto.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const IMAGE_TEXT = 'PRIVATE-IMAGE-BYTES-'.repeat(8);
const UPLOAD_OPTIONS = {
  serverUrl: 'https://media.example.com',
  signUploadAuthHeader: async () => 'Nostr signed-auth',
};

function imageFile(type = 'image/png', name = 'photo.png'): File {
  return new File([IMAGE_TEXT], name, { type });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function readRequestBody(init: RequestInit | undefined): Uint8Array<ArrayBuffer> {
  const body = init?.body;
  if (!(body instanceof Uint8Array)) {
    throw new Error('Expected a byte array upload body.');
  }
  return new Uint8Array(body);
}

function descriptorResponse(sha256: string, size: number): Response {
  return new Response(
    JSON.stringify({
      url: `https://blossom.example.com/${sha256}`,
      sha256,
      size,
      type: 'application/octet-stream',
      uploaded: 1780912800,
    }),
    { status: 201 }
  );
}

// Encrypts once and uploads, as the composer does for a first attempt.
async function uploadEncryptedMedia(
  file: File,
  options: typeof UPLOAD_OPTIONS & { signal?: AbortSignal }
) {
  return uploadPreparedEncryptedMedia(await prepareEncryptedMedia(file), options);
}

// Answers like a Blossom server: hashes the received body and echoes it in the descriptor.
function createBlossomFetchMock() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = readRequestBody(init);
    return descriptorResponse(await sha256Hex(body), body.byteLength);
  });
}

describe('blossomUploadService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates common media files for the upload flow', () => {
    expect(validateBlossomMediaFile(new File(['image'], 'image.png', { type: 'image/png' }))).toBe(
      null
    );
    expect(validateBlossomMediaFile(new File(['text'], 'note.txt', { type: 'text/plain' }))).toBe(
      'Only image, video, and audio files are supported.'
    );
    expect(validateBlossomMediaFile(new File([], 'empty.png', { type: 'image/png' }))).toBe(
      'The selected file is empty.'
    );
  });

  it('hashes blobs with SHA-256', async () => {
    await expect(sha256HexFromBlob(new Blob(['hello']))).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('uploads media to the configured server with server-scoped authentication', async () => {
    const file = new File(['hello'], 'hello.png', { type: 'image/png' });
    const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          url: 'https://cdn.example.com/hello.png',
          sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          size: 5,
          type: 'image/png',
          uploaded: 1780912800,
        }),
        { status: 201 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadBlossomMedia(file, {
      serverUrl: 'https://media.example.com/',
      signUploadAuthHeader,
    });

    expect(signUploadAuthHeader).toHaveBeenCalledWith({
      serverUrl: 'https://media.example.com',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://media.example.com/upload',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          Authorization: 'Nostr signed-auth',
          'Content-Type': 'image/png',
          'X-SHA-256': '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        },
        body: file,
      })
    );
    expect(result.attachment).toEqual({
      type: 'media',
      url: 'https://cdn.example.com/hello.png',
      mimeType: 'image/png',
      size: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      name: 'hello.png',
      service: 'media.example.com',
      uploadedAt: '2026-06-08T10:00:00.000Z',
    });
  });

  describe('encrypted image upload', () => {
    it('uploads only ciphertext of the original bytes as application/octet-stream', async () => {
      const fetchMock = createBlossomFetchMock();
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      const body = readRequestBody(init);
      const plaintext = new Uint8Array(new TextEncoder().encode(IMAGE_TEXT));
      const ciphertextHash = await sha256Hex(body);

      expect(url).toBe('https://media.example.com/upload');
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toEqual({
        Authorization: 'Nostr signed-auth',
        'Content-Type': 'application/octet-stream',
        'X-SHA-256': ciphertextHash,
      });
      expect(new TextDecoder().decode(body)).not.toContain('PRIVATE-IMAGE-BYTES');

      // x and size describe the ciphertext; ox describes exactly the bytes that were encrypted,
      // which are the original file bytes.
      expect(attachment).toMatchObject({
        type: 'media',
        url: `https://blossom.example.com/${ciphertextHash}`,
        mimeType: 'image/png',
        size: plaintext.byteLength + 16,
        sha256: ciphertextHash,
        name: 'photo.png',
        service: 'media.example.com',
        uploadedAt: '2026-06-08T10:00:00.000Z',
        encryption: { algorithm: 'aes-gcm', originalSha256: await sha256Hex(plaintext) },
      });
      expect(body.byteLength).toBe(plaintext.byteLength + 16);
      await expect(
        decryptMediaBytes(body, attachment.encryption?.key, attachment.encryption?.nonce)
      ).resolves.toEqual(plaintext);
    });

    it('never sends the key or nonce to the server', async () => {
      const fetchMock = createBlossomFetchMock();
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedMedia(imageFile(), {
        ...UPLOAD_OPTIONS,
        signUploadAuthHeader,
      });
      const key = attachment.encryption?.key ?? '';
      const nonce = attachment.encryption?.nonce ?? '';
      const [url, init] = fetchMock.mock.calls[0];
      const outgoing = [
        url,
        JSON.stringify(init?.headers),
        JSON.stringify(signUploadAuthHeader.mock.calls),
        hex(readRequestBody(init)),
      ].join('\n');

      expect(key).toMatch(/^[a-f0-9]{64}$/u);
      expect(nonce).toMatch(/^[a-f0-9]{24}$/u);
      expect(outgoing).not.toContain(hex(new TextEncoder().encode(IMAGE_TEXT)));
      expect(outgoing).not.toContain(key);
      expect(outgoing).not.toContain(nonce);
    });

    it('does not retry a visible rejection and reports the server reason', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response('', {
            status: 415,
            headers: { 'X-Reason': 'Unsupported media type: application/octet-stream' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'Unsupported media type: application/octet-stream'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([429, 503])('does not retry or fall back to plaintext on HTTP %s', async (status) => {
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) => new Response('busy', { status })
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow('busy');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/octet-stream');
      expect(new TextDecoder().decode(readRequestBody(init))).not.toContain('PRIVATE-IMAGE-BYTES');
    });

    it('uploads the ciphertext once and explains an opaque network failure', async () => {
      // A rejection without CORS headers reaches the browser as a bare TypeError.
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toMatchObject({
        kind: 'network',
        message: 'Could not reach media.example.com. Check your connection, or try another server.',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows aborts unchanged', async () => {
      const controller = new AbortController();
      const abortError = new DOMException('Aborted', 'AbortError');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          controller.abort(abortError);
          throw abortError;
        })
      );

      await expect(
        uploadEncryptedMedia(imageFile(), { ...UPLOAD_OPTIONS, signal: controller.signal })
      ).rejects.toBe(abortError);
    });

    it('rejects a server descriptor whose hash does not match the uploaded ciphertext', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => descriptorResponse('f'.repeat(64), 10))
      );

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'media.example.com stored a blob with an unexpected hash.'
      );
    });

    it('rejects a descriptor whose blob URL is not HTTPS as an upload error', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = readRequestBody(init);
        const sha256 = await sha256Hex(body);
        return new Response(
          JSON.stringify({
            url: `http://blossom.example.com/${sha256}`,
            sha256,
            size: body.byteLength,
            type: 'application/octet-stream',
          }),
          { status: 201 }
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'media.example.com returned a blob URL that does not use HTTPS.'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not upload unsupported image types', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        uploadEncryptedMedia(imageFile('image/svg+xml', 'x.svg'), UPLOAD_OPTIONS)
      ).rejects.toThrow('Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('upload failure classification', () => {
    it.each([
      [401, 'auth', 'media.example.com refused the upload authorization.'],
      [403, 'auth', 'media.example.com refused the upload authorization.'],
      [402, 'payment', 'media.example.com requires payment or an account to upload.'],
      [413, 'too-large', 'media.example.com rejected the file because it is too large.'],
      [415, 'unsupported-type', 'media.example.com does not accept encrypted files.'],
      [500, 'server', 'media.example.com could not store the file (HTTP 500).'],
      [404, 'server', 'media.example.com could not store the file (HTTP 404).'],
    ])('reports HTTP %s as %s', async (status, kind, message) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status }))
      );

      const error = await uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS).catch((e) => e);
      expect(error).toBeInstanceOf(BlossomUploadError);
      expect(error).toMatchObject({ kind, message });
    });

    it('names the file type, not encryption, when plaintext media is refused', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 415 }))
      );

      await expect(uploadBlossomMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toMatchObject({
        kind: 'unsupported-type',
        message: 'media.example.com does not accept this file type.',
      });
    });

    it('appends a short plain-text server reason', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Quota   exceeded\n for today', { status: 402 }))
      );

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'media.example.com requires payment or an account to upload. The server said: Quota exceeded for today'
      );
    });

    it('never shows an HTML error page and shortens long reasons', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 })
          )
          .mockResolvedValueOnce(new Response('x'.repeat(500), { status: 400 }))
      );

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        /^media\.example\.com could not store the file \(HTTP 502\)\.$/u
      );
      const error = await uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS).catch((e) => e);
      expect(error.message.length).toBeLessThan(260);
      expect(error.message.endsWith('…')).toBe(true);
    });

    it('reports a signer failure as an authentication failure without uploading', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        uploadEncryptedMedia(imageFile(), {
          ...UPLOAD_OPTIONS,
          signUploadAuthHeader: async () => {
            throw new Error('Signer locked');
          },
        })
      ).rejects.toMatchObject({ kind: 'auth' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('separates an invalid response from an integrity failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response('not json', { status: 201 }))
          .mockResolvedValueOnce(descriptorResponse('f'.repeat(64), 10))
      );

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toMatchObject({
        kind: 'invalid-response',
      });
      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toMatchObject({
        kind: 'integrity',
      });
    });
  });

  describe('private video and audio', () => {
    const MIB = 1024 * 1024;
    const MEDIA_TEXT = 'PRIVATE-MEDIA-BYTES-'.repeat(8);
    const mediaFile = (type: string, name: string) => new File([MEDIA_TEXT], name, { type });

    it.each([
      ['video/mp4', 'clip.mp4'],
      ['audio/mpeg', 'song.mp3'],
    ])('encrypts %s, uploads only ciphertext and preserves the MIME type', async (type, name) => {
      const fetchMock = createBlossomFetchMock();
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedMedia(mediaFile(type, name), UPLOAD_OPTIONS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      const body = readRequestBody(init);
      expect(url).toBe('https://media.example.com/upload');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/octet-stream');
      expect(new TextDecoder().decode(body)).not.toContain('PRIVATE-MEDIA-BYTES');
      expect(attachment.mimeType).toBe(type);
      expect(attachment.name).toBe(name);
      await expect(
        decryptMediaBytes(body, attachment.encryption?.key, attachment.encryption?.nonce)
      ).resolves.toEqual(new Uint8Array(new TextEncoder().encode(MEDIA_TEXT)));
    });

    it('does not put key material in error messages', async () => {
      const prepared = await prepareEncryptedMedia(mediaFile('video/mp4', 'clip.mp4'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        })
      );

      const error = await uploadPreparedEncryptedMedia(prepared, UPLOAD_OPTIONS).catch(
        (caught: Error) => caught
      );

      expect(String(error)).not.toContain(prepared.encryption.key);
      expect(String(error)).not.toContain(prepared.encryption.nonce);
      expect(String(error)).not.toContain('PRIVATE-MEDIA-BYTES');
    });

    describe('validation', () => {
      const sized = (type: string, bytes: number) =>
        new File([new Uint8Array(bytes)], 'f', { type });

      it('rejects unsupported video and audio instead of sending them in plaintext', () => {
        expect(validateEncryptedMediaFile(sized('video/x-matroska', 10))).toBe(
          'Only MP4, MOV, and WebM videos can be sent encrypted.'
        );
        expect(validateEncryptedMediaFile(sized('audio/x-ms-wma', 10))).toBe(
          'Only MP3, MP4/AAC, Ogg, WebM, WAV, and FLAC audio can be sent encrypted.'
        );
        expect(validateEncryptedMediaFile(sized('image/svg+xml', 10))).toBe(
          'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
        );
      });

      it('applies the 20 MiB media limit to every kind', () => {
        expect(validateEncryptedMediaFile(sized('image/png', 20 * MIB))).toBeNull();
        expect(validateEncryptedMediaFile(sized('video/mp4', 20 * MIB))).toBeNull();
        expect(validateEncryptedMediaFile(sized('audio/mpeg', 20 * MIB))).toBeNull();
        for (const type of ['audio/mpeg', 'video/mp4']) {
          expect(validateEncryptedMediaFile(sized(type, 20 * MIB + 1))).toBe(
            'Media uploads are limited to 20 MiB.'
          );
        }
      });

      it('refuses to prepare unsupported or oversized media', async () => {
        await expect(prepareEncryptedMedia(sized('video/x-matroska', 10))).rejects.toThrow(
          'Only MP4, MOV, and WebM videos can be sent encrypted.'
        );
        await expect(prepareEncryptedMedia(sized('audio/mpeg', 20 * MIB + 1))).rejects.toThrow(
          'limited to 20 MiB'
        );
      });
    });
  });
});
