import {
  prepareEncryptedMedia,
  sha256HexFromBlob,
  uploadBlossomMedia,
  uploadPreparedEncryptedMedia,
  validateBlossomMediaFile,
  validateEncryptedMediaFile,
  verifyPrivateMediaServer,
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

  it('allows only allowlisted image types to be sent encrypted', () => {
    expect(validateEncryptedMediaFile(imageFile('image/jpeg', 'a.jpg'))).toBeNull();
    expect(validateEncryptedMediaFile(imageFile('image/webp', 'a.webp'))).toBeNull();
    expect(validateEncryptedMediaFile(imageFile('image/svg+xml', 'a.svg'))).toBe(
      'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
    );
    expect(validateEncryptedMediaFile(imageFile('image/heic', 'a.heic'))).toBe(
      'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
    );
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

    it.each([429, 503])('does not retry HTTP %s automatically', async (status) => {
      const fetchMock = vi.fn(async () => new Response('busy', { status }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow('busy');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uploads the ciphertext once and explains an opaque network failure', async () => {
      // A rejection without CORS headers reaches the browser as a bare TypeError.
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(imageFile(), UPLOAD_OPTIONS)).rejects.toThrow(
        'Could not upload to media.example.com. The server may be unavailable or may not accept encrypted file uploads.'
      );
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

  describe('private media server verification', () => {
    // A Blossom server that stores blobs by hash and optionally mutates or refuses deletion.
    function createStoringServer(options: { mutate?: boolean; allowDelete?: boolean } = {}) {
      const blobs = new Map<string, Uint8Array>();
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const body = readRequestBody(init);
          const sha256 = await sha256Hex(body);
          blobs.set(
            sha256,
            options.mutate ? new Uint8Array([...body.subarray(1), 0]) : new Uint8Array(body)
          );
          return descriptorResponse(sha256, body.byteLength);
        }
        const sha256 = url.split('/').pop() ?? '';
        if (init?.method === 'DELETE') {
          if (!options.allowDelete) {
            return new Response('', { status: 405 });
          }
          blobs.delete(sha256);
          return new Response('', { status: 200 });
        }
        const blob = blobs.get(sha256);
        return blob
          ? new Response(blob as Uint8Array<ArrayBuffer>)
          : new Response('', { status: 404 });
      });
      return { blobs, fetchMock };
    }

    it('uploads, downloads, compares hashes and deletes the random probe', async () => {
      const { blobs, fetchMock } = createStoringServer({ allowDelete: true });
      const signUploadAuthHeader = vi.fn(
        async (_input: { serverUrl: string; sha256: string; action?: string }) =>
          'Nostr signed-auth'
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        verifyPrivateMediaServer({ ...UPLOAD_OPTIONS, signUploadAuthHeader })
      ).resolves.toEqual({ cleanedUp: true });

      const [putUrl, putInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(putUrl).toBe('https://media.example.com/upload');
      expect(new Headers(putInit.headers).get('Content-Type')).toBe('application/octet-stream');
      expect(readRequestBody(putInit).byteLength).toBe(32);
      expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
        'PUT',
        'GET',
        'DELETE',
      ]);
      expect(signUploadAuthHeader.mock.calls.map(([input]) => input.action)).toEqual([
        undefined,
        'delete',
      ]);
      expect(blobs.size).toBe(0);
    });

    it('still passes when the server refuses deletion and reports that', async () => {
      const { fetchMock } = createStoringServer({ allowDelete: false });
      vi.stubGlobal('fetch', fetchMock);

      await expect(verifyPrivateMediaServer(UPLOAD_OPTIONS)).resolves.toEqual({
        cleanedUp: false,
      });
    });

    it('fails when the server returns different bytes than were uploaded', async () => {
      const { fetchMock } = createStoringServer({ mutate: true, allowDelete: true });
      vi.stubGlobal('fetch', fetchMock);

      await expect(verifyPrivateMediaServer(UPLOAD_OPTIONS)).rejects.toThrow(
        'media.example.com altered the test blob'
      );
    });

    it('fails when the upload is rejected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 415, headers: { 'X-Reason': 'nope' } }))
      );

      await expect(verifyPrivateMediaServer(UPLOAD_OPTIONS)).rejects.toThrow('nope');
    });

    it('fails when the blob cannot be downloaded', async () => {
      const { fetchMock } = createStoringServer({ allowDelete: true });
      const withoutDownload = vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === 'PUT' ? fetchMock(url, init) : new Response('', { status: 404 })
      );
      vi.stubGlobal('fetch', withoutDownload);

      await expect(verifyPrivateMediaServer(UPLOAD_OPTIONS)).rejects.toThrow(
        'could not return the test blob (HTTP 404)'
      );
    });
  });

  describe('private video and audio', () => {
    const MIB = 1024 * 1024;
    const MEDIA_TEXT = 'PRIVATE-MEDIA-BYTES-'.repeat(8);
    const mediaFile = (type: string, name: string) => new File([MEDIA_TEXT], name, { type });

    it.each([
      ['image/png', 'photo.png'],
      ['video/mp4', 'clip.mp4'],
      ['video/webm', 'clip.webm'],
      ['audio/mpeg', 'song.mp3'],
      ['audio/ogg', 'voice.ogg'],
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

    it.each([
      ['video/mp4', 'clip.mp4'],
      ['audio/mpeg', 'song.mp3'],
    ])('never sends %s plaintext, key or nonce to the server', async (type, name) => {
      const fetchMock = createBlossomFetchMock();
      const signUploadAuthHeader = vi.fn(async () => 'Nostr signed-auth');
      vi.stubGlobal('fetch', fetchMock);

      const { attachment } = await uploadEncryptedMedia(mediaFile(type, name), {
        ...UPLOAD_OPTIONS,
        signUploadAuthHeader,
      });
      const [url, init] = fetchMock.mock.calls[0];
      const outgoing = [
        url,
        JSON.stringify(init?.headers),
        JSON.stringify(signUploadAuthHeader.mock.calls),
        hex(readRequestBody(init)),
      ].join('\n');

      expect(outgoing).not.toContain(hex(new TextEncoder().encode(MEDIA_TEXT)));
      expect(outgoing).not.toContain(attachment.encryption?.key ?? 'missing');
      expect(outgoing).not.toContain(attachment.encryption?.nonce ?? 'missing');
    });

    it.each([
      ['video/mp4', 'clip.mp4'],
      ['audio/flac', 'song.flac'],
    ])('does not fall back to plaintext when the %s upload fails', async (type, name) => {
      const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(uploadEncryptedMedia(mediaFile(type, name), UPLOAD_OPTIONS)).rejects.toThrow(
        'down'
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream');
      expect(new TextDecoder().decode(readRequestBody(init))).not.toContain('PRIVATE-MEDIA-BYTES');
    });

    it('keeps the ciphertext and original hashes derived from the plaintext', async () => {
      const prepared = await prepareEncryptedMedia(mediaFile('audio/mpeg', 'song.mp3'));
      const plaintext = new Uint8Array(new TextEncoder().encode(MEDIA_TEXT));

      expect(prepared.sha256).toBe(await sha256Hex(prepared.ciphertext));
      expect(prepared.encryption.originalSha256).toBe(await sha256Hex(plaintext));
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

      it('accepts the supported video and audio types', () => {
        for (const type of [
          'video/mp4',
          'video/webm',
          'audio/mpeg',
          'audio/mp4',
          'audio/aac',
          'audio/ogg',
          'audio/webm',
          'audio/wav',
          'audio/flac',
        ]) {
          expect(validateEncryptedMediaFile(sized(type, 10))).toBeNull();
        }
      });

      it('rejects unsupported video and audio instead of sending them in plaintext', () => {
        expect(validateEncryptedMediaFile(sized('video/quicktime', 10))).toBe(
          'Only MP4 and WebM videos can be sent encrypted.'
        );
        expect(validateEncryptedMediaFile(sized('audio/x-ms-wma', 10))).toBe(
          'Only MP3, MP4/AAC, Ogg, WebM, WAV, and FLAC audio can be sent encrypted.'
        );
        expect(validateEncryptedMediaFile(sized('image/svg+xml', 10))).toBe(
          'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.'
        );
      });

      it('applies per-kind send limits', () => {
        expect(validateEncryptedMediaFile(sized('image/png', 20 * MIB))).toBeNull();
        expect(validateEncryptedMediaFile(sized('video/mp4', 20 * MIB))).toBeNull();
        expect(validateEncryptedMediaFile(sized('audio/mpeg', 10 * MIB))).toBeNull();
        expect(validateEncryptedMediaFile(sized('audio/mpeg', 10 * MIB + 1))).toBe(
          'Encrypted audio uploads are limited to 10 MiB.'
        );
        expect(validateEncryptedMediaFile(sized('video/mp4', 20 * MIB + 1))).toBe(
          'Media uploads are limited to 20 MiB.'
        );
      });

      it('refuses to prepare unsupported or oversized media', async () => {
        await expect(prepareEncryptedMedia(sized('video/quicktime', 10))).rejects.toThrow(
          'Only MP4 and WebM videos can be sent encrypted.'
        );
        await expect(prepareEncryptedMedia(sized('audio/mpeg', 10 * MIB + 1))).rejects.toThrow(
          'limited to 10 MiB'
        );
      });
    });
  });
});
