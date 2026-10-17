import { get, writable } from 'svelte/store';
import type {
  BlossomUploadResult,
  PreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import {
  createPrivateMediaUploadSession,
  type PrivateMediaUploadOutcome,
} from '#src/services/privateMediaUploadSession.ts';
import { sendMediaThenPersistServer } from '#src/utils/sendMediaThenPersistServer.ts';
import type { MessageAttachmentMetadata, MessageReplyPreview } from '#src/types/chat.ts';

export type PrivateMediaUploadPhase = 'notice' | 'uploading' | 'sending' | 'failed';

export interface PrivateMediaComposerUploadState {
  file: File | null;
  phase: PrivateMediaUploadPhase;
  error: string;
  canRetry: boolean;
  server: string;
}

const idle = (): PrivateMediaComposerUploadState => ({
  file: null,
  phase: 'notice',
  error: '',
  canRetry: false,
  server: '',
});

export type PrivateMediaSource = 'picker' | 'paste' | 'drop';

// The encryption notice and the upload confirmation are separate. Dismissing the notice only lets
// a file the user explicitly picked go straight to upload; pasted or dropped media always waits
// for Upload, so nothing is sent by accident.
export function skipsPrivateMediaConfirmation(
  source: PrivateMediaSource,
  noticeDismissed: boolean,
): boolean {
  return source === 'picker' && noticeDismissed;
}

export class PrivateMediaUploadCancelledError extends Error {
  constructor() {
    super('The encrypted upload was cancelled.');
    this.name = 'PrivateMediaUploadCancelledError';
  }
}

// The encrypted counterpart of createComposerUpload for private chats. The upload is bound to the
// account and chat it was chosen in: changing either, cancelling or closing the composer aborts
// it, drops the prepared key, and discards a late result, so nothing is signed, sent or saved
// with a different account, signer or conversation than the one the file was chosen for.
export function createPrivateMediaComposerUpload(deps: {
  account: () => string;
  chatId: () => string;
  getServerUrl: () => string;
  prepare: (file: File) => Promise<PreparedEncryptedMedia>;
  upload: (
    prepared: PreparedEncryptedMedia,
    options: {
      serverUrl: string;
      signal: AbortSignal;
      signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
    },
  ) => Promise<BlossomUploadResult>;
  signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
  ensureAuthentication: () => Promise<void>;
  send: (
    chatId: string,
    attachment: MessageAttachmentMetadata,
    replyTo: MessageReplyPreview | null,
  ) => Promise<unknown>;
  persistServer: (serverUrl: string) => Promise<unknown>;
  onPersistError: (error: unknown) => void;
  onSent: (replyTo: MessageReplyPreview | null) => void;
  onSendError: (error: unknown) => void;
}) {
  const state = writable<PrivateMediaComposerUploadState>(idle());
  let account = '';
  let chatId = '';
  let replyTo: MessageReplyPreview | null = null;
  let run = 0;
  let controller: AbortController | undefined;

  const bound = () => Boolean(account) && account === deps.account() && chatId === deps.chatId();
  // A run stays live until it is replaced, cancelled, or its account or chat changes.
  const live = (current: number, signal: AbortSignal) =>
    current === run && !signal.aborted && bound();

  function assertLive(current: number, signal: AbortSignal) {
    if (!live(current, signal)) throw new PrivateMediaUploadCancelledError();
  }

  const session = createPrivateMediaUploadSession<File>({
    prepare: deps.prepare,
    upload: (prepared, serverUrl) => {
      const current = run;
      const signal = controller?.signal;
      if (!signal) throw new PrivateMediaUploadCancelledError();
      assertLive(current, signal);
      return deps.upload(prepared, {
        serverUrl,
        signal,
        // Signed by the account the file was chosen in, or not at all.
        signUploadAuthHeader: async (input) => {
          assertLive(current, signal);
          return deps.signUploadAuthHeader(input);
        },
      });
    },
    getPersistedServerUrl: deps.getServerUrl,
  });

  function cancel() {
    run += 1;
    controller?.abort();
    controller = undefined;
    session.reset();
    account = '';
    chatId = '';
    replyTo = null;
    state.set(idle());
  }

  function checkContext() {
    if (account && !bound()) cancel();
  }

  // Returns false when a file is already waiting, uploading or offering Retry.
  function choose(file: File, reply: MessageReplyPreview | null): boolean {
    if (get(state).file) return false;
    const currentAccount = deps.account(),
      currentChatId = deps.chatId();
    if (!currentAccount || !currentChatId) return false;
    cancel();
    account = currentAccount;
    chatId = currentChatId;
    replyTo = reply;
    state.set({ ...idle(), file, server: deps.getServerUrl() });
    return true;
  }

  async function execute(start: () => Promise<PrivateMediaUploadOutcome>) {
    checkContext();
    if (!get(state).file) return;
    const current = ++run;
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    const { signal } = currentController;
    const target = { account, chatId, replyTo };
    state.update((value) => ({ ...value, phase: 'uploading', error: '' }));
    // A stale run never touches the state; one whose context changed is cancelled outright.
    const stale = () => {
      if (live(current, signal)) return false;
      if (current === run) cancel();
      return true;
    };
    let outcome: PrivateMediaUploadOutcome;
    try {
      // The signer is checked before every attempt, including retries.
      await deps.ensureAuthentication();
      if (stale()) return;
      outcome = await start();
    } catch (error) {
      if (stale()) return;
      controller = undefined;
      state.update((value) => ({
        ...value,
        phase: 'failed',
        canRetry: session.hasPreparedUpload(),
        error:
          error instanceof Error && error.message.trim() ? error.message.trim() : String(error),
      }));
      return;
    }
    // Cancelled, or the account or chat changed, while the upload was finishing: nothing is sent.
    if (stale()) return;
    state.update((value) => ({ ...value, phase: 'sending' }));
    try {
      await sendMediaThenPersistServer({
        send: async () => {
          if (stale()) return null;
          return deps.send(target.chatId, outcome.result.attachment, target.replyTo);
        },
        serverToPersist: outcome.serverToPersist,
        // The message is already sent; the server preference only belongs to the same account.
        persistServer: async (serverUrl) => {
          if (deps.account() !== target.account) return;
          await deps.persistServer(serverUrl);
        },
        onPersistError: deps.onPersistError,
      });
      if (current === run) deps.onSent(target.replyTo);
    } catch (error) {
      deps.onSendError(error);
    } finally {
      if (current === run) {
        controller = undefined;
        session.reset();
        account = '';
        chatId = '';
        replyTo = null;
        state.set(idle());
      }
    }
  }

  function commit() {
    const { file, phase } = get(state);
    if (!file || phase !== 'notice') return Promise.resolve();
    return execute(() => {
      state.update((value) => ({ ...value, server: session.refreshActiveServerUrl() }));
      return session.start(file);
    });
  }

  function retry() {
    const { canRetry, phase } = get(state);
    if (!canRetry || phase !== 'failed') return Promise.resolve();
    return execute(() => session.retry());
  }

  // Retries the same ciphertext, key and nonce on the entered server. The saved server only
  // changes after the kind 15 message has actually been sent.
  function retryWithServer(serverUrl: string) {
    const { canRetry, phase } = get(state);
    if (!serverUrl || !canRetry || phase !== 'failed') return Promise.resolve();
    state.update((value) => ({ ...value, server: serverUrl }));
    return execute(() => session.retryWithServer(serverUrl));
  }

  return { state, choose, commit, retry, retryWithServer, cancel, checkContext };
}
