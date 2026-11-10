import { get, writable } from 'svelte/store';
import {
  BlossomUploadError,
  validateEncryptedMediaFile,
  type BlossomUploadErrorKind,
  type BlossomUploadResult,
  type PreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import { requireBlossomServerUrl } from '#src/utils/blossomServer.ts';
import type { MessageAttachmentMetadata, MessageReplyPreview } from '#src/types/chat.ts';

// confirm: waiting for Upload. unsupported: the file cannot be encrypted. confirm-plaintext: the
// user chose to send without encryption and must confirm the privacy impact.
export type PrivateMediaUploadPhase =
  'confirm' | 'unsupported' | 'uploading' | 'sending' | 'failed' | 'confirm-plaintext';

export interface PrivateMediaComposerUploadState {
  file: File | null;
  phase: PrivateMediaUploadPhase;
  // False once the user has chosen to send this file without media encryption.
  encrypted: boolean;
  error: string;
  errorKind: BlossomUploadErrorKind | '';
  server: string;
}

const idle = (): PrivateMediaComposerUploadState => ({
  file: null,
  phase: 'confirm',
  encrypted: true,
  error: '',
  errorKind: '',
  server: '',
});

export class PrivateMediaUploadCancelledError extends Error {
  constructor() {
    super('The upload was cancelled.');
    this.name = 'PrivateMediaUploadCancelledError';
  }
}

type SignUploadAuthHeader = (input: { serverUrl: string; sha256: string }) => Promise<string>;
interface UploadOptions {
  serverUrl: string;
  signal: AbortSignal;
  signUploadAuthHeader: SignUploadAuthHeader;
}

// Private media upload for the composer. Media is encrypted by default and sent as NIP-17 kind 15;
// the file is encrypted once, so Retry and a changed server re-send the same ciphertext, key and
// nonce. Plaintext is only uploaded after the user chooses "Send without encryption" for this file
// (and confirms, unless they asked not to be asked again); it is then sent as kind 14 + imeta.
// The upload is bound to the account and chat it was chosen in: changing either, cancelling or
// closing the composer aborts it, drops the prepared key, and discards a late result.
export function createPrivateMediaComposerUpload(deps: {
  account: () => string;
  chatId: () => string;
  getServerUrl: () => string;
  getPlaintextServerUrl: () => string;
  prepare: (file: File) => Promise<PreparedEncryptedMedia>;
  upload: (
    prepared: PreparedEncryptedMedia,
    options: UploadOptions,
  ) => Promise<BlossomUploadResult>;
  uploadPlaintext: (file: File, options: UploadOptions) => Promise<BlossomUploadResult>;
  signUploadAuthHeader: SignUploadAuthHeader;
  ensureAuthentication: () => Promise<void>;
  isPlaintextConfirmationSkipped: () => boolean;
  // Saves "Don't ask again"; reports its own errors.
  skipPlaintextConfirmation: () => Promise<void>;
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
  // The single encryption of the chosen file, kept for retries until the upload ends.
  let prepared: PreparedEncryptedMedia | null = null;
  let serverUrl = '';

  const bound = () => Boolean(account) && account === deps.account() && chatId === deps.chatId();
  // A run stays live until it is replaced, cancelled, or its account or chat changes.
  const live = (current: number, signal: AbortSignal) =>
    current === run && !signal.aborted && bound();

  function cancel() {
    run += 1;
    controller?.abort();
    controller = undefined;
    prepared = null;
    serverUrl = '';
    account = '';
    chatId = '';
    replyTo = null;
    state.set(idle());
  }

  function checkContext() {
    if (account && !bound()) cancel();
  }

  // Returns false when a file is already waiting, uploading or offering recovery.
  function choose(file: File, reply: MessageReplyPreview | null): boolean {
    if (get(state).file) return false;
    const currentAccount = deps.account(),
      currentChatId = deps.chatId();
    if (!currentAccount || !currentChatId) return false;
    cancel();
    account = currentAccount;
    chatId = currentChatId;
    replyTo = reply;
    serverUrl = deps.getServerUrl();
    const unsupported = validateEncryptedMediaFile(file);
    state.set({
      ...idle(),
      file,
      server: serverUrl,
      ...(unsupported ? { phase: 'unsupported' as const, error: unsupported } : {}),
    });
    return true;
  }

  async function execute(encrypted: boolean) {
    checkContext();
    const { file } = get(state);
    if (!file) return;
    const current = ++run;
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    const { signal } = currentController;
    const target = { account, chatId, replyTo };
    const server = encrypted ? serverUrl : deps.getPlaintextServerUrl();
    state.update((value) => ({
      ...value,
      phase: 'uploading',
      encrypted,
      server,
      error: '',
      errorKind: '',
    }));
    // A stale run never touches the state; one whose context changed is cancelled outright.
    const stale = () => {
      if (live(current, signal)) return false;
      if (current === run) cancel();
      return true;
    };
    const options: UploadOptions = {
      serverUrl: server,
      signal,
      // Signed by the account the file was chosen in, or not at all.
      signUploadAuthHeader: async (input) => {
        if (!live(current, signal)) throw new PrivateMediaUploadCancelledError();
        return deps.signUploadAuthHeader(input);
      },
    };
    let result: BlossomUploadResult;
    try {
      // The signer is checked before every attempt, including retries.
      await deps.ensureAuthentication().catch((error: unknown) => {
        throw new BlossomUploadError('auth', errorMessage(error));
      });
      if (stale()) return;
      if (encrypted) {
        const payload = prepared ?? (await deps.prepare(file));
        if (stale()) return;
        prepared = payload;
        result = await deps.upload(payload, options);
      } else {
        // Choosing plaintext drops the encrypted payload and its key.
        prepared = null;
        result = await deps.uploadPlaintext(file, options);
      }
    } catch (error) {
      if (stale()) return;
      controller = undefined;
      state.update((value) => ({
        ...value,
        phase: 'failed',
        error: errorMessage(error),
        errorKind: error instanceof BlossomUploadError ? error.kind : '',
      }));
      return;
    }
    // Cancelled, or the account or chat changed, while the upload was finishing: nothing is sent.
    if (stale()) return;
    state.update((value) => ({ ...value, phase: 'sending' }));
    try {
      const created = await deps.send(target.chatId, result.attachment, target.replyTo);
      // Saving a changed server publishes a signed preference, so it only happens after the
      // message was sent, and only for the account that sent it.
      if (
        created &&
        encrypted &&
        server !== deps.getServerUrl() &&
        deps.account() === target.account
      ) {
        await deps.persistServer(server).catch(deps.onPersistError);
      }
      if (current === run) deps.onSent(target.replyTo);
    } catch (error) {
      // Nothing is uploaded again: a recorded message is retried from the thread.
      deps.onSendError(error);
    } finally {
      if (current === run) cancel();
    }
  }

  function commit() {
    const { file, phase } = get(state);
    if (!file || phase !== 'confirm') return Promise.resolve();
    serverUrl = deps.getServerUrl();
    return execute(true);
  }

  // Retries the same encrypted payload, or the same plaintext file once that was chosen.
  function retry() {
    const { phase, encrypted } = get(state);
    if (phase !== 'failed') return Promise.resolve();
    return execute(encrypted);
  }

  // Retries the same ciphertext, key and nonce on the entered server. The saved server only
  // changes after the kind 15 message has actually been sent. Throws on an invalid URL.
  function retryWithServer(nextServerUrl: string) {
    const { phase, encrypted } = get(state);
    if (phase !== 'failed' || !encrypted) return Promise.resolve();
    serverUrl = requireBlossomServerUrl(nextServerUrl);
    return execute(true);
  }

  // The user chose "Send without encryption" for this file. Confirmation is skipped only when
  // they asked not to be asked again; plaintext is never chosen without this action.
  function chooseUnencrypted() {
    const { phase, encrypted } = get(state);
    if (phase !== 'unsupported' && (phase !== 'failed' || !encrypted)) return Promise.resolve();
    if (deps.isPlaintextConfirmationSkipped()) return execute(false);
    state.update((value) => ({ ...value, phase: 'confirm-plaintext' }));
    return Promise.resolve();
  }

  function confirmUnencrypted(dontAskAgain: boolean) {
    if (get(state).phase !== 'confirm-plaintext') return Promise.resolve();
    if (dontAskAgain) void deps.skipPlaintextConfirmation();
    return execute(false);
  }

  return {
    state,
    choose,
    commit,
    retry,
    retryWithServer,
    chooseUnencrypted,
    confirmUnencrypted,
    cancel,
    checkContext,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}
