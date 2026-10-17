import {
  prepareEncryptedMedia,
  uploadPreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import { createPrivateMediaUploadSession } from '#src/services/privateMediaUploadSession.ts';
import { sha256Hex } from '#src/utils/mediaCrypto.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_A = 'https://a.example.com';
const SERVER_B = 'https://b.example.com';
const PLAINTEXT = 'PRIVATE-VIDEO-BYTES-'.repeat(8);

function bodyHex(init: RequestInit | undefined): string {
  return Buffer.from(init?.body as Uint8Array).toString('hex');
}

// A fake Blossom server per origin; the ones listed in `failing` answer 503.
function createHarness(failing: Set<string> = new Set()) {
  let persisted = SERVER_A;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (failing.has(new URL(url).origin)) {
      return new Response('down', { status: 503 });
    }
    const body = init?.body as Uint8Array<ArrayBuffer>;
    return new Response(
      JSON.stringify({
        url: `${new URL(url).origin}/${await sha256Hex(body)}`,
        sha256: await sha256Hex(body),
        size: body.byteLength,
        type: 'application/octet-stream',
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const prepare = vi.fn(prepareEncryptedMedia);
  const upload = vi.fn((...args: Parameters<typeof uploadPreparedEncryptedMedia>) =>
    uploadPreparedEncryptedMedia(...args)
  );
  const session = createPrivateMediaUploadSession<File>({
    prepare,
    upload: (prepared, serverUrl) =>
      upload(prepared, {
        serverUrl,
        signUploadAuthHeader: async () => 'Nostr signed-auth',
      }),
    getPersistedServerUrl: () => persisted,
  });
  return {
    session,
    fetchMock,
    prepare,
    setPersisted: (url: string) => (persisted = url),
  };
}

const file = () => new File([PLAINTEXT], 'clip.mp4', { type: 'video/mp4' });

describe('private media upload session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads to the saved private-media server and needs no preference change', async () => {
    const { session, fetchMock } = createHarness();

    const { result, serverToPersist } = await session.start(file());

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${SERVER_A}/upload`]);
    expect(serverToPersist).toBeNull();
    expect(result.attachment.mimeType).toBe('video/mp4');
    expect(session.hasPreparedUpload()).toBe(false);
  });

  it('retries the same server with byte-identical ciphertext, key and nonce', async () => {
    const { session, fetchMock, prepare } = createHarness(new Set([SERVER_A]));

    await expect(session.start(file())).rejects.toThrow('down');
    expect(session.hasPreparedUpload()).toBe(true);
    await expect(session.retry()).rejects.toThrow('down');

    expect(prepare).toHaveBeenCalledTimes(1);
    const bodies = fetchMock.mock.calls.map(([, init]) => bodyHex(init));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(fetchMock.mock.calls.every(([url]) => url === `${SERVER_A}/upload`)).toBe(true);
    // The uploaded bytes are ciphertext, never the plaintext.
    expect(Buffer.from(bodies[0], 'hex').toString()).not.toContain('PRIVATE-VIDEO-BYTES');
  });

  it('sends the retry to the newly entered server B, with the same encrypted payload', async () => {
    const { session, fetchMock, prepare } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');

    const { result } = await session.retryWithServer(' HTTPS://B.example.com/ ');

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${SERVER_A}/upload`,
      `${SERVER_B}/upload`,
    ]);
    expect(bodyHex(fetchMock.mock.calls[1][1])).toBe(bodyHex(fetchMock.mock.calls[0][1]));
    expect(session.getActiveServerUrl()).toBe(SERVER_B);
    expect(result.attachment.service).toBe('b.example.com');
  });

  it('keeps the same key, nonce and hashes when the server changes', async () => {
    const { session, prepare } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');
    const { result } = await session.retryWithServer(SERVER_B);

    const prepared = await prepare.mock.results[0].value;
    expect(result.attachment.encryption).toEqual(prepared.encryption);
    expect(result.attachment.sha256).toBe(prepared.sha256);
    expect(result.attachment.mimeType).toBe('video/mp4');
  });

  it('does not touch the saved server when the changed-server retry fails', async () => {
    const { session } = createHarness(new Set([SERVER_A, SERVER_B]));
    await expect(session.start(file())).rejects.toThrow('down');

    await expect(session.retryWithServer(SERVER_B)).rejects.toThrow('down');

    expect(session.getActiveServerUrl()).toBe(SERVER_B);
    expect(session.hasPreparedUpload()).toBe(true);
  });

  it('reports B as the server to save after a successful changed-server retry', async () => {
    const { session } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');

    const { serverToPersist } = await session.retryWithServer(SERVER_B);

    expect(serverToPersist).toBe(SERVER_B);
  });

  it('uses the saved server for the next upload once it has been persisted', async () => {
    const { session, fetchMock, setPersisted } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');
    const { serverToPersist } = await session.retryWithServer(SERVER_B);
    setPersisted(serverToPersist ?? '');
    fetchMock.mockClear();

    await session.start(file());

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${SERVER_B}/upload`]);
  });

  it('rejects invalid or insecure servers without uploading or losing the payload', async () => {
    const { session, fetchMock } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');
    fetchMock.mockClear();

    for (const bad of ['http://b.example.com', 'not a url', '', 'https://b.example.com/x']) {
      await expect(session.retryWithServer(bad)).rejects.toThrow('valid HTTPS Blossom server');
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.getActiveServerUrl()).toBe(SERVER_A);
    expect(session.hasPreparedUpload()).toBe(true);
  });

  it('drops the prepared payload on reset so nothing can be retried or sent', async () => {
    const { session, fetchMock } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');
    fetchMock.mockClear();

    session.reset();

    expect(session.hasPreparedUpload()).toBe(false);
    expect(session.getActiveServerUrl()).toBe('');
    await expect(session.retry()).rejects.toThrow('no encrypted upload to retry');
    await expect(session.retryWithServer(SERVER_B)).rejects.toThrow('no encrypted upload to retry');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts clean after a reset and re-encrypts only for a brand new send', async () => {
    const { session, prepare } = createHarness(new Set([SERVER_A]));
    await expect(session.start(file())).rejects.toThrow('down');
    session.reset();

    await expect(session.start(file())).rejects.toThrow('down');

    expect(prepare).toHaveBeenCalledTimes(2);
    const [first, second] = await Promise.all(prepare.mock.results.map((r) => r.value));
    expect(second.encryption.key).not.toBe(first.encryption.key);
  });

  it('never uploads plaintext: a failed encrypted upload only ever sends ciphertext', async () => {
    const { session, fetchMock } = createHarness(new Set([SERVER_A, SERVER_B]));
    await expect(session.start(file())).rejects.toThrow('down');
    await expect(session.retryWithServer(SERVER_B)).rejects.toThrow('down');

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/octet-stream');
      expect(Buffer.from(bodyHex(init), 'hex').toString()).not.toContain('PRIVATE-VIDEO-BYTES');
    }
  });

  it('does not start an upload for media that cannot be encrypted', async () => {
    const { session, fetchMock } = createHarness();

    await expect(
      session.start(new File(['x'], 'clip.mov', { type: 'video/quicktime' }))
    ).rejects.toThrow('Only MP4 and WebM videos can be sent encrypted.');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.hasPreparedUpload()).toBe(false);
  });

  it('discards an encryption that finishes after a cancel instead of uploading it', async () => {
    const { session, fetchMock, prepare } = createHarness();
    let finishPrepare!: () => void;
    const gate = new Promise<void>((resolve) => (finishPrepare = resolve));
    prepare.mockImplementationOnce(async (input: File) => {
      await gate;
      return prepareEncryptedMedia(input);
    });

    const started = session.start(file());
    session.reset();
    finishPrepare();

    await expect(started).rejects.toThrow('The encrypted upload was cancelled.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.hasPreparedUpload()).toBe(false);
  });
});
