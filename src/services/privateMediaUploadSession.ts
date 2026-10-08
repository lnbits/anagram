import type {
  BlossomUploadResult,
  PreparedEncryptedMedia,
} from '#src/services/blossomUploadService.ts';
import { requireBlossomServerUrl } from '#src/utils/blossomServer.ts';

interface PrivateMediaUploadSessionDeps<TFile> {
  prepare: (file: TFile) => Promise<PreparedEncryptedMedia>;
  upload: (prepared: PreparedEncryptedMedia, serverUrl: string) => Promise<BlossomUploadResult>;
  getPersistedServerUrl: () => string;
}

export interface PrivateMediaUploadOutcome {
  result: BlossomUploadResult;
  // Set when the upload succeeded on a server that is not the saved default.
  serverToPersist: string | null;
}

// One encrypted upload with retries. The file is encrypted exactly once; retrying, or retrying
// against a different server, re-sends that same ciphertext with the same key and nonce. The
// saved server preference is never touched here; the caller saves `serverToPersist` only after the
// message has been sent. There is no plaintext path here.
export function createPrivateMediaUploadSession<TFile>(deps: PrivateMediaUploadSessionDeps<TFile>) {
  let prepared: PreparedEncryptedMedia | null = null;
  let activeServerUrl = '';
  // Bumped by reset(), so an encryption that finishes after a cancel is discarded, not uploaded.
  let generation = 0;

  async function attempt(): Promise<PrivateMediaUploadOutcome> {
    if (!prepared) {
      throw new Error('There is no encrypted upload to retry.');
    }

    const result = await deps.upload(prepared, activeServerUrl);
    const serverToPersist =
      activeServerUrl !== deps.getPersistedServerUrl() ? activeServerUrl : null;
    // Done: the attachment now carries what the kind 15 message needs.
    prepared = null;
    return { result, serverToPersist };
  }

  async function start(file: TFile): Promise<PrivateMediaUploadOutcome> {
    generation += 1;
    const current = generation;
    prepared = null;
    activeServerUrl = deps.getPersistedServerUrl();
    const nextPrepared = await deps.prepare(file);
    if (current !== generation) {
      throw new Error('The encrypted upload was cancelled.');
    }
    prepared = nextPrepared;
    return attempt();
  }

  async function retry(): Promise<PrivateMediaUploadOutcome> {
    return attempt();
  }

  // Throws on an invalid URL before changing anything.
  async function retryWithServer(serverUrl: string): Promise<PrivateMediaUploadOutcome> {
    activeServerUrl = requireBlossomServerUrl(serverUrl);
    return attempt();
  }

  // Drops the prepared ciphertext, key and nonce.
  function reset(): void {
    generation += 1;
    prepared = null;
    activeServerUrl = '';
  }

  return {
    start,
    retry,
    retryWithServer,
    reset,
    getActiveServerUrl: () => activeServerUrl,
    // Syncs the displayed server with the saved default before an upload starts.
    refreshActiveServerUrl: () => {
      activeServerUrl = deps.getPersistedServerUrl();
      return activeServerUrl;
    },
    hasPreparedUpload: () => prepared !== null,
  };
}
