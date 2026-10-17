import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  createPrivateMediaComposerUpload,
  skipsPrivateMediaConfirmation,
} from '#src/lib/state/privateMediaComposerUpload.ts';
import type {
  BlossomUploadResult,
  PreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import type { MessageReplyPreview } from '#src/types/chat.ts';

const SAVED_SERVER = 'https://blossom.ditto.pub';
const OTHER_SERVER = 'https://other.example';
const attachment = {
  url: `${SAVED_SERVER}/${'ab'.repeat(32)}`,
  mimeType: 'image/png',
  size: 4,
};
const prepared = { sha256: 'ab'.repeat(32) } as unknown as PreparedEncryptedMedia;
const reply = { id: 'm1' } as unknown as MessageReplyPreview;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const ctx = { account: 'alice', chatId: 'chat-1' };
  const uploads: Array<{
    serverUrl: string;
    signal: AbortSignal;
    signed: Promise<string>;
    done: ReturnType<typeof deferred<BlossomUploadResult>>;
  }> = [];
  let prepareGate: ReturnType<typeof deferred<void>> | null = null;
  const deps = {
    account: () => ctx.account,
    chatId: () => ctx.chatId,
    getServerUrl: () => SAVED_SERVER,
    prepare: vi.fn(async () => {
      if (prepareGate) await prepareGate.promise;
      return prepared;
    }),
    upload: vi.fn(
      (
        _prepared: PreparedEncryptedMedia,
        options: {
          serverUrl: string;
          signal: AbortSignal;
          signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
        },
      ) => {
        const done = deferred<BlossomUploadResult>();
        // Like the real upload, the auth header is signed before the blob is sent.
        const signed = options.signUploadAuthHeader({
          serverUrl: options.serverUrl,
          sha256: prepared.sha256,
        });
        uploads.push({ serverUrl: options.serverUrl, signal: options.signal, signed, done });
        signed.catch(() => undefined);
        return signed.then(() => done.promise);
      },
    ),
    signUploadAuthHeader: vi.fn(async () => `signed-by-${ctx.account}`),
    ensureAuthentication: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ id: 'sent' })),
    persistServer: vi.fn(async () => undefined),
    onPersistError: vi.fn(),
    onSent: vi.fn(),
    onSendError: vi.fn(),
  };
  const uploader = createPrivateMediaComposerUpload(deps);
  const file = new File(['test'], 'photo.png', { type: 'image/png' });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    ctx,
    deps,
    uploader,
    file,
    uploads,
    flush,
    gatePrepare: () => (prepareGate = deferred<void>()),
    openPrepare: () => prepareGate?.resolve(),
    finishUpload: async (index?: number) => {
      await flush();
      uploads[index ?? uploads.length - 1].done.resolve({ attachment } as BlossomUploadResult);
    },
    failUpload: async (index?: number) => {
      await flush();
      uploads[index ?? uploads.length - 1].done.reject(
        new Error('Could not upload to other.example.'),
      );
    },
  };
}

function expectNothingSent(f: ReturnType<typeof setup>) {
  expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.deps.persistServer).not.toHaveBeenCalled();
  expect(f.deps.onSendError).not.toHaveBeenCalled();
  expect(f.deps.onSent).not.toHaveBeenCalled();
  expect(get(f.uploader.state)).toMatchObject({ file: null, phase: 'notice', canRetry: false });
}

describe('private media composer upload lifecycle', () => {
  it('sends the encrypted attachment to the chat and reply it was chosen for', async () => {
    const f = setup();
    expect(f.uploader.choose(f.file, reply)).toBe(true);
    expect(get(f.uploader.state)).toMatchObject({ file: f.file, server: SAVED_SERVER });
    const pending = f.uploader.commit();
    expect(get(f.uploader.state).phase).toBe('uploading');
    await f.finishUpload();
    await pending;
    expect(f.deps.signUploadAuthHeader).toHaveBeenCalledOnce();
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('chat-1', attachment, reply);
    expect(f.deps.persistServer).not.toHaveBeenCalled();
    expect(f.deps.onSent).toHaveBeenCalledExactlyOnceWith(reply);
    expect(get(f.uploader.state)).toMatchObject({ file: null, phase: 'notice' });
  });

  it('does not accept a file without an account or an open chat', () => {
    const f = setup();
    f.ctx.chatId = '';
    expect(f.uploader.choose(f.file, null)).toBe(false);
    f.ctx.chatId = 'chat-1';
    f.ctx.account = '';
    expect(f.uploader.choose(f.file, null)).toBe(false);
    expect(get(f.uploader.state).file).toBeNull();
  });

  it('never sends with the new account after an account switch during upload', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.ctx.account = 'bob';
    await f.finishUpload();
    await pending;
    expectNothingSent(f);
  });

  it('never signs the upload with the new account after a switch during encryption', async () => {
    const f = setup();
    f.gatePrepare();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.ctx.account = 'bob';
    f.openPrepare();
    await pending;
    expect(f.deps.signUploadAuthHeader).not.toHaveBeenCalled();
    expectNothingSent(f);
  });

  it('aborts and drops the upload on logout', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.ctx.account = '';
    f.uploader.checkContext();
    expect(f.uploads[0].signal.aborted).toBe(true);
    await f.finishUpload();
    await pending;
    expectNothingSent(f);
  });

  it('aborts the upload when the conversation changes', async () => {
    const f = setup();
    f.uploader.choose(f.file, reply);
    const pending = f.uploader.commit();
    await f.flush();
    f.ctx.chatId = 'chat-2';
    f.uploader.checkContext();
    expect(f.uploads[0].signal.aborted).toBe(true);
    await f.finishUpload();
    await pending;
    expectNothingSent(f);
  });

  it('does not send to another conversation even without a context check', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.ctx.chatId = 'chat-2';
    await f.finishUpload();
    await pending;
    expectNothingSent(f);
  });

  it.each([
    ['the chat view is closed', (f: ReturnType<typeof setup>) => f.uploader.cancel()],
    [
      'no chat is open any more',
      (f: ReturnType<typeof setup>) => {
        f.ctx.chatId = '';
        f.uploader.checkContext();
      },
    ],
  ])('aborts and drops the upload when %s', async (_reason, close) => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    close(f);
    expect(f.uploads[0].signal.aborted).toBe(true);
    await f.finishUpload();
    await pending;
    expectNothingSent(f);
  });

  it('cancels during upload and discards the prepared key', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.uploader.cancel();
    expect(f.uploads[0].signal.aborted).toBe(true);
    f.uploads[0].done.reject(new DOMException('aborted', 'AbortError'));
    await pending;
    expectNothingSent(f);
    expect(get(f.uploader.state).error).toBe('');
    await f.uploader.retry();
    expect(f.deps.upload).toHaveBeenCalledOnce();
  });

  it('cancels during encryption without uploading', async () => {
    const f = setup();
    f.gatePrepare();
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.flush();
    f.uploader.cancel();
    f.openPrepare();
    await pending;
    expect(f.deps.upload).not.toHaveBeenCalled();
    expectNothingSent(f);
  });

  it('does not deliver a cancelled upload after a new file is chosen', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.flush();
    f.uploader.cancel();
    const second = new File(['next'], 'next.png', { type: 'image/png' });
    expect(f.uploader.choose(second, null)).toBe(true);
    await f.finishUpload(0);
    await first;
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(get(f.uploader.state)).toMatchObject({ file: second, phase: 'notice' });
  });

  it('keeps Retry and Change server, and saves the server only after sending', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    expect(get(f.uploader.state)).toMatchObject({
      phase: 'failed',
      canRetry: true,
      error: 'Could not upload to other.example.',
    });
    const retried = f.uploader.retryWithServer(OTHER_SERVER);
    expect(get(f.uploader.state).server).toBe(OTHER_SERVER);
    await f.finishUpload();
    await retried;
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.uploads.map((upload) => upload.serverUrl)).toEqual([SAVED_SERVER, OTHER_SERVER]);
    expect(f.deps.send).toHaveBeenCalledOnce();
    expect(f.deps.persistServer).toHaveBeenCalledExactlyOnceWith(OTHER_SERVER);
    expect(f.deps.send.mock.invocationCallOrder[0]).toBeLessThan(
      f.deps.persistServer.mock.invocationCallOrder[0],
    );
  });

  it('cancels a failed upload that is offering Retry when the account changes', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    f.ctx.account = 'bob';
    await f.uploader.retry();
    expect(f.deps.upload).toHaveBeenCalledOnce();
    expectNothingSent(f);
  });

  it("does not save the server to another account's preferences after sending", async () => {
    const f = setup();
    const sending = deferred<{ id: string }>();
    f.deps.send.mockImplementationOnce(() => sending.promise);
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    const retried = f.uploader.retryWithServer(OTHER_SERVER);
    await f.finishUpload();
    await f.flush();
    expect(f.deps.send).toHaveBeenCalledOnce();
    f.ctx.account = 'bob';
    sending.resolve({ id: 'sent' });
    await retried;
    expect(f.deps.persistServer).not.toHaveBeenCalled();
  });

  it('reports a send failure and closes the upload', async () => {
    const f = setup();
    const error = new Error('relay rejected');
    f.deps.send.mockRejectedValueOnce(error);
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.finishUpload();
    await pending;
    expect(f.deps.onSendError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.deps.persistServer).not.toHaveBeenCalled();
    expect(get(f.uploader.state).file).toBeNull();
  });
});

describe('private media upload confirmation', () => {
  it.each([
    ['paste', false, false],
    ['paste', true, false],
    ['drop', false, false],
    ['drop', true, false],
    ['picker', false, false],
    ['picker', true, true],
  ] as const)(
    'a %s with the notice dismissed=%s skips confirmation: %s',
    (source, dismissed, skips) => {
      expect(skipsPrivateMediaConfirmation(source, dismissed)).toBe(skips);
    },
  );

  it('uploads and sends nothing until the waiting file is confirmed', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    await f.flush();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(get(f.uploader.state)).toMatchObject({ file: f.file, phase: 'notice' });
  });

  it('cancelling the confirmation uploads and sends nothing', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    f.uploader.cancel();
    await f.uploader.commit();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.upload).not.toHaveBeenCalled();
    expectNothingSent(f);
  });

  it('confirming encrypts, uploads and sends the encrypted attachment', async () => {
    const f = setup();
    f.uploader.choose(f.file, reply);
    const pending = f.uploader.commit();
    await f.finishUpload();
    await pending;
    expect(f.deps.prepare).toHaveBeenCalledExactlyOnceWith(f.file);
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('chat-1', attachment, reply);
  });

  it.each([
    ['account', (f: ReturnType<typeof setup>) => (f.ctx.account = 'bob')],
    ['logout', (f: ReturnType<typeof setup>) => (f.ctx.account = '')],
    ['conversation', (f: ReturnType<typeof setup>) => (f.ctx.chatId = 'chat-2')],
  ])(
    'confirming after a %s change while the confirmation is open sends nothing',
    async (_change, change) => {
      const f = setup();
      f.uploader.choose(f.file, null);
      change(f);
      await f.uploader.commit();
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.deps.ensureAuthentication).not.toHaveBeenCalled();
      expectNothingSent(f);
    },
  );

  it('a context check closes an open confirmation when the conversation changes', () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    f.ctx.chatId = 'chat-2';
    f.uploader.checkContext();
    expect(get(f.uploader.state).file).toBeNull();
  });
});
