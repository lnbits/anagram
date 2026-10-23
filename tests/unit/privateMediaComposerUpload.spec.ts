import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createPrivateMediaComposerUpload } from '#src/lib/state/privateMediaComposerUpload.ts';
import {
  BlossomUploadError,
  type BlossomUploadResult,
  type PreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import type { MessageReplyPreview } from '#src/types/chat.ts';

const SAVED_SERVER = 'https://blossom.ditto.pub';
const OTHER_SERVER = 'https://other.example';
const PLAINTEXT_SERVER = 'https://blossom.nostr.build';
const attachment = {
  url: `${SAVED_SERVER}/${'ab'.repeat(32)}`,
  mimeType: 'image/png',
  size: 4,
};
const plaintextAttachment = {
  type: 'media' as const,
  url: `${PLAINTEXT_SERVER}/${'cd'.repeat(32)}.png`,
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
  const ctx = { account: 'alice', chatId: 'chat-1', skipConfirmation: false };
  const uploads: Array<{
    encrypted: boolean;
    serverUrl: string;
    signal: AbortSignal;
    signed: Promise<string>;
    done: ReturnType<typeof deferred<BlossomUploadResult>>;
  }> = [];
  let prepareGate: ReturnType<typeof deferred<void>> | null = null;
  type Options = {
    serverUrl: string;
    signal: AbortSignal;
    signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
  };
  // Like the real uploads, the auth header is signed before the blob is sent.
  const startUpload = (encrypted: boolean, options: Options) => {
    const done = deferred<BlossomUploadResult>();
    const signed = options.signUploadAuthHeader({
      serverUrl: options.serverUrl,
      sha256: prepared.sha256,
    });
    uploads.push({ encrypted, serverUrl: options.serverUrl, signal: options.signal, signed, done });
    signed.catch(() => undefined);
    return signed.then(() => done.promise);
  };
  const deps = {
    account: () => ctx.account,
    chatId: () => ctx.chatId,
    getServerUrl: () => SAVED_SERVER,
    getPlaintextServerUrl: () => PLAINTEXT_SERVER,
    prepare: vi.fn(async () => {
      if (prepareGate) await prepareGate.promise;
      return prepared;
    }),
    upload: vi.fn((_prepared: PreparedEncryptedMedia, options: Options) =>
      startUpload(true, options),
    ),
    uploadPlaintext: vi.fn((_file: File, options: Options) => startUpload(false, options)),
    signUploadAuthHeader: vi.fn(async () => `signed-by-${ctx.account}`),
    ensureAuthentication: vi.fn(async () => undefined),
    isPlaintextConfirmationSkipped: vi.fn(() => ctx.skipConfirmation),
    skipPlaintextConfirmation: vi.fn(async () => {
      ctx.skipConfirmation = true;
    }),
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
      const upload = uploads[index ?? uploads.length - 1];
      upload.done.resolve({
        attachment: upload.encrypted ? attachment : plaintextAttachment,
      } as BlossomUploadResult);
    },
    failUpload: async (
      error: Error = new BlossomUploadError(
        'unsupported-type',
        'blossom.ditto.pub does not accept encrypted files.',
      ),
    ) => {
      await flush();
      uploads[uploads.length - 1].done.reject(error);
    },
  };
}

function expectNothingSent(f: ReturnType<typeof setup>) {
  expect(f.deps.send).not.toHaveBeenCalled();
  expect(f.deps.persistServer).not.toHaveBeenCalled();
  expect(f.deps.onSendError).not.toHaveBeenCalled();
  expect(f.deps.onSent).not.toHaveBeenCalled();
  expect(get(f.uploader.state)).toMatchObject({ file: null, phase: 'confirm' });
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
    expect(f.deps.prepare).toHaveBeenCalledExactlyOnceWith(f.file);
    expect(f.deps.signUploadAuthHeader).toHaveBeenCalledOnce();
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('chat-1', attachment, reply);
    expect(f.deps.persistServer).not.toHaveBeenCalled();
    expect(f.deps.onSent).toHaveBeenCalledExactlyOnceWith(reply);
    expect(get(f.uploader.state)).toMatchObject({ file: null, phase: 'confirm' });
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
    expect(get(f.uploader.state)).toMatchObject({ file: second, phase: 'confirm' });
  });

  it('keeps Retry and Change server, and saves the server only after sending', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    expect(get(f.uploader.state)).toMatchObject({
      phase: 'failed',
      errorKind: 'unsupported-type',
      error: 'blossom.ditto.pub does not accept encrypted files.',
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
  it('uploads and sends nothing until the waiting file is confirmed', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    await f.flush();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(get(f.uploader.state)).toMatchObject({ file: f.file, phase: 'confirm' });
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

describe('private media upload retries', () => {
  it('retries the same ciphertext, key and nonce without encrypting again', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload(new BlossomUploadError('network', 'Could not reach blossom.ditto.pub.'));
    await first;
    expect(get(f.uploader.state).errorKind).toBe('network');
    const retried = f.uploader.retry();
    await f.finishUpload();
    await retried;
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.upload.mock.calls.map(([payload]) => payload)).toEqual([prepared, prepared]);
    expect(f.uploads.map((upload) => upload.serverUrl)).toEqual([SAVED_SERVER, SAVED_SERVER]);
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
    expect(f.deps.persistServer).not.toHaveBeenCalled();
  });

  it('can retry after the signer failed before anything was encrypted', async () => {
    const f = setup();
    f.deps.ensureAuthentication.mockRejectedValueOnce(new Error('Signer locked'));
    f.uploader.choose(f.file, null);
    await f.uploader.commit();
    expect(get(f.uploader.state)).toMatchObject({ phase: 'failed', errorKind: 'auth' });
    expect(f.deps.prepare).not.toHaveBeenCalled();
    const retried = f.uploader.retry();
    await f.finishUpload();
    await retried;
    expect(f.deps.send).toHaveBeenCalledOnce();
  });

  it('rejects an invalid server without uploading or losing the failed upload', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    expect(() => f.uploader.retryWithServer('http://insecure.example')).toThrow();
    expect(f.deps.upload).toHaveBeenCalledOnce();
    expect(get(f.uploader.state).phase).toBe('failed');
  });

  it('does not save a changed server whose retry also failed', async () => {
    const f = setup();
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    const retried = f.uploader.retryWithServer(OTHER_SERVER);
    await f.failUpload();
    await retried;
    expect(f.deps.persistServer).not.toHaveBeenCalled();
    expect(get(f.uploader.state)).toMatchObject({ phase: 'failed', server: OTHER_SERVER });
  });

  it('keeps the sent message and uploads nothing again when saving the server fails', async () => {
    const f = setup();
    const error = new Error('relay unavailable');
    f.deps.persistServer.mockRejectedValueOnce(error);
    f.uploader.choose(f.file, null);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
    const retried = f.uploader.retryWithServer(OTHER_SERVER);
    await f.finishUpload();
    await retried;
    expect(f.deps.send).toHaveBeenCalledOnce();
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
    expect(f.deps.onPersistError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.deps.onSent).toHaveBeenCalledOnce();
  });

  it('does not upload again when publishing the message fails', async () => {
    const f = setup();
    f.deps.send.mockRejectedValueOnce(new Error('relay rejected'));
    f.uploader.choose(f.file, null);
    const pending = f.uploader.commit();
    await f.finishUpload();
    await pending;
    await f.uploader.retry();
    expect(f.deps.upload).toHaveBeenCalledOnce();
    expect(f.deps.prepare).toHaveBeenCalledOnce();
  });
});

describe('sending private media without encryption', () => {
  const heic = () => new File(['heic'], 'photo.heic', { type: 'image/heic' });

  async function failEncrypted(f: ReturnType<typeof setup>) {
    f.uploader.choose(f.file, reply);
    const first = f.uploader.commit();
    await f.failUpload();
    await first;
  }

  it('offers media that cannot be encrypted without uploading anything', async () => {
    const f = setup();
    expect(f.uploader.choose(heic(), null)).toBe(true);
    await f.flush();
    expect(get(f.uploader.state)).toMatchObject({
      phase: 'unsupported',
      error: 'Only JPEG, PNG, GIF, WebP, and AVIF images can be sent encrypted.',
    });
    await f.uploader.commit();
    await f.uploader.retry();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.upload).not.toHaveBeenCalled();
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
  });

  it('asks for confirmation before uploading plaintext, then sends kind 14 media', async () => {
    const f = setup();
    const file = heic();
    f.uploader.choose(file, reply);
    await f.uploader.chooseUnencrypted();
    expect(get(f.uploader.state).phase).toBe('confirm-plaintext');
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
    const pending = f.uploader.confirmUnencrypted(false);
    expect(get(f.uploader.state)).toMatchObject({
      phase: 'uploading',
      encrypted: false,
      server: PLAINTEXT_SERVER,
    });
    await f.finishUpload();
    await pending;
    expect(f.deps.uploadPlaintext).toHaveBeenCalledExactlyOnceWith(file, expect.anything());
    expect(f.uploads[0].serverUrl).toBe(PLAINTEXT_SERVER);
    expect(f.deps.send).toHaveBeenCalledExactlyOnceWith('chat-1', plaintextAttachment, reply);
    expect(f.deps.skipPlaintextConfirmation).not.toHaveBeenCalled();
    expect(f.deps.persistServer).not.toHaveBeenCalled();
  });

  it('offers plaintext after a failed encrypted upload and drops the encrypted payload', async () => {
    const f = setup();
    await failEncrypted(f);
    await f.uploader.chooseUnencrypted();
    const pending = f.uploader.confirmUnencrypted(false);
    await f.finishUpload();
    await pending;
    expect(f.deps.upload).toHaveBeenCalledOnce();
    expect(f.deps.uploadPlaintext).toHaveBeenCalledOnce();
    const [, sentAttachment] = f.deps.send.mock.calls[0] as unknown as [string, object];
    expect(sentAttachment).not.toHaveProperty('encryption');
  });

  it.each(['failed', 'confirm-plaintext'])(
    'uploads nothing later, however long, after cancelling in the %s phase',
    async (phase) => {
      const f = setup();
      await failEncrypted(f);
      if (phase === 'confirm-plaintext') await f.uploader.chooseUnencrypted();
      expect(get(f.uploader.state).phase).toBe(phase);
      vi.useFakeTimers();
      try {
        f.uploader.cancel();
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
      expect(f.deps.upload).toHaveBeenCalledOnce();
      expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
      expectNothingSent(f);
    },
  );

  it('cancelling the plaintext confirmation uploads and sends nothing', async () => {
    const f = setup();
    await failEncrypted(f);
    await f.uploader.chooseUnencrypted();
    f.uploader.cancel();
    await f.uploader.confirmUnencrypted(true);
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
    expect(f.deps.skipPlaintextConfirmation).not.toHaveBeenCalled();
    expectNothingSent(f);
  });

  it('is never offered before the encrypted upload was tried', async () => {
    const f = setup();
    f.ctx.skipConfirmation = true;
    f.uploader.choose(f.file, null);
    await f.uploader.chooseUnencrypted();
    await f.uploader.confirmUnencrypted(false);
    expect(get(f.uploader.state).phase).toBe('confirm');
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
  });

  it('saves "don\'t ask again" only when it is ticked on the confirmation', async () => {
    const f = setup();
    await failEncrypted(f);
    await f.uploader.chooseUnencrypted();
    const pending = f.uploader.confirmUnencrypted(true);
    await f.finishUpload();
    await pending;
    expect(f.deps.skipPlaintextConfirmation).toHaveBeenCalledOnce();
  });

  it('with "don\'t ask again", Send without encryption skips only the confirmation', async () => {
    const f = setup();
    f.ctx.skipConfirmation = true;
    f.uploader.choose(heic(), null);
    expect(get(f.uploader.state).phase).toBe('unsupported');
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
    const pending = f.uploader.chooseUnencrypted();
    expect(get(f.uploader.state)).toMatchObject({ phase: 'uploading', encrypted: false });
    await f.finishUpload();
    await pending;
    expect(f.deps.uploadPlaintext).toHaveBeenCalledOnce();
  });

  it('with "don\'t ask again", private media is still encrypted and never downgraded', async () => {
    const f = setup();
    f.ctx.skipConfirmation = true;
    await failEncrypted(f);
    expect(get(f.uploader.state)).toMatchObject({ phase: 'failed', encrypted: true });
    const retried = f.uploader.retry();
    await f.failUpload();
    await retried;
    expect(f.deps.upload).toHaveBeenCalledTimes(2);
    expect(f.deps.uploadPlaintext).not.toHaveBeenCalled();
    expect(f.deps.send).not.toHaveBeenCalled();
  });

  it('retries a failed plaintext upload as plaintext, without a changed server', async () => {
    const f = setup();
    f.ctx.skipConfirmation = true;
    f.uploader.choose(heic(), null);
    const first = f.uploader.chooseUnencrypted();
    await f.failUpload(new BlossomUploadError('server', 'blossom.nostr.build could not store'));
    await first;
    expect(get(f.uploader.state)).toMatchObject({ phase: 'failed', encrypted: false });
    await f.uploader.retryWithServer(OTHER_SERVER);
    await f.uploader.chooseUnencrypted();
    expect(f.deps.uploadPlaintext).toHaveBeenCalledOnce();
    const retried = f.uploader.retry();
    await f.finishUpload();
    await retried;
    expect(f.deps.uploadPlaintext).toHaveBeenCalledTimes(2);
    expect(f.uploads.map((upload) => upload.serverUrl)).toEqual([
      PLAINTEXT_SERVER,
      PLAINTEXT_SERVER,
    ]);
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
});
