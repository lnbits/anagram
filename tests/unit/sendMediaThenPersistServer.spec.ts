import {
  prepareEncryptedMedia,
  uploadPreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import { createPrivateMediaUploadSession } from '#src/services/privateMediaUploadSession.ts';
import { sha256Hex } from '#src/utils/mediaCrypto.ts';
import { sendMediaThenPersistServer } from '#src/utils/sendMediaThenPersistServer.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SERVER_A = 'https://a.example.com';
const SERVER_B = 'https://b.example.com';

// Real encrypted upload session + the real send-then-persist helper, with an event log so the
// exact order of upload, send and preference persistence can be asserted.
function createFlow(options: { send: () => Promise<unknown>; persist?: () => Promise<unknown> }) {
  const events: string[] = [];
  let persisted = SERVER_A;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    events.push(`upload:${new URL(url).origin}`);
    if (new URL(url).origin === SERVER_A) {
      return new Response('down', { status: 503 });
    }
    const body = init?.body as Uint8Array<ArrayBuffer>;
    return new Response(
      JSON.stringify({
        url: `${SERVER_B}/${await sha256Hex(body)}`,
        sha256: await sha256Hex(body),
        size: body.byteLength,
        type: 'application/octet-stream',
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const prepare = vi.fn(prepareEncryptedMedia);
  const session = createPrivateMediaUploadSession<File>({
    prepare,
    upload: (prepared, serverUrl) =>
      uploadPreparedEncryptedMedia(prepared, {
        serverUrl,
        signUploadAuthHeader: async () => 'Nostr signed-auth',
      }),
    getPersistedServerUrl: () => persisted,
  });
  const send = vi.fn(async () => {
    events.push('send:start');
    const created = await options.send();
    events.push('send:done');
    return created;
  });
  const persist = vi.fn(async (serverUrl: string) => {
    events.push(`persist:${serverUrl}`);
    await options.persist?.();
    persisted = serverUrl;
  });
  const onPersistError = vi.fn();

  async function run() {
    const file = new File(['PRIVATE-BYTES-'.repeat(8)], 'clip.mp4', {
      type: 'video/mp4',
    });
    await expect(session.start(file)).rejects.toThrow('down');
    const { serverToPersist } = await session.retryWithServer(SERVER_B);
    return sendMediaThenPersistServer({
      send,
      serverToPersist,
      persistServer: persist,
      onPersistError,
    });
  }

  return {
    run,
    events,
    send,
    persist,
    onPersistError,
    prepare,
    fetchMock,
    getPersisted: () => persisted,
  };
}

describe('send media then persist changed private-media server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has not persisted B while the send is still in flight, and persists it once the send resolves', async () => {
    let finishSend: (value: unknown) => void = () => undefined;
    const flow = createFlow({
      send: () => new Promise((resolve) => (finishSend = resolve)),
    });

    const running = flow.run();
    await vi.waitFor(() => expect(flow.send).toHaveBeenCalled());
    await Promise.resolve();

    expect(flow.persist).not.toHaveBeenCalled();
    expect(flow.getPersisted()).toBe(SERVER_A);

    finishSend({ id: 1 });
    await running;

    expect(flow.persist).toHaveBeenCalledWith(SERVER_B);
    expect(flow.getPersisted()).toBe(SERVER_B);
    expect(flow.events).toEqual([
      `upload:${SERVER_A}`,
      `upload:${SERVER_B}`,
      'send:start',
      'send:done',
      `persist:${SERVER_B}`,
    ]);
  });

  it('does not persist B, or start any preference signing, when the send rejects', async () => {
    const flow = createFlow({
      send: () => Promise.reject(new Error('relay rejected')),
    });

    await expect(flow.run()).rejects.toThrow('relay rejected');

    expect(flow.persist).not.toHaveBeenCalled();
    expect(flow.onPersistError).not.toHaveBeenCalled();
    expect(flow.getPersisted()).toBe(SERVER_A);
  });

  it('does not persist when the send resolves without a created message', async () => {
    const flow = createFlow({ send: async () => null });

    await flow.run();

    expect(flow.persist).not.toHaveBeenCalled();
  });

  it('keeps the sent message and re-sends/re-uploads nothing when persisting fails', async () => {
    const flow = createFlow({
      send: async () => ({ id: 7 }),
      persist: () => Promise.reject(new Error('signature declined')),
    });

    const created = await flow.run();

    expect(created).toEqual({ id: 7 });
    expect(flow.onPersistError).toHaveBeenCalledTimes(1);
    expect(flow.send).toHaveBeenCalledTimes(1);
    expect(flow.persist).toHaveBeenCalledTimes(1);
    expect(flow.prepare).toHaveBeenCalledTimes(1);
    expect(flow.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${SERVER_A}/upload`,
      `${SERVER_B}/upload`,
    ]);
    expect(flow.getPersisted()).toBe(SERVER_A);
  });

  it('persists nothing when the upload used the saved server', async () => {
    const persistServer = vi.fn();
    await sendMediaThenPersistServer({
      send: async () => ({ id: 1 }),
      serverToPersist: null,
      persistServer,
      onPersistError: vi.fn(),
    });

    expect(persistServer).not.toHaveBeenCalled();
  });
});
