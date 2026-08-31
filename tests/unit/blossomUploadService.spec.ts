import {
  sha256HexFromBlob,
  uploadBlossomMedia,
  validateBlossomMediaFile,
} from 'src/services/blossomUploadService';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('blossomUploadService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
