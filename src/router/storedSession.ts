import {
  AUTH_METHOD_STORAGE_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from 'src/stores/nostr/constants';

interface StoredSessionCheckerDeps {
  clearAndroidSessionMetadata: () => void;
  clearElectronSessionMetadata: () => void;
  getLocalStorage: () => Storage | null;
  hasUsableAndroidSession: () => Promise<boolean>;
  hasUsableElectronSession: () => Promise<boolean>;
}

interface PendingSessionCheck {
  promise: Promise<boolean>;
  signature: string;
}

function readStoredSessionSignature(localStorage: Storage): string | null {
  const publicKey = localStorage.getItem(PUBLIC_KEY_STORAGE_KEY)?.trim() ?? '';
  if (!publicKey) {
    return null;
  }

  return [
    publicKey,
    localStorage.getItem(AUTH_METHOD_STORAGE_KEY)?.trim() ?? '',
    localStorage.getItem(PRIVATE_KEY_STORAGE_KEY)?.trim() ?? '',
  ].join('\u0000');
}

export function createStoredSessionChecker({
  clearAndroidSessionMetadata,
  clearElectronSessionMetadata,
  getLocalStorage,
  hasUsableAndroidSession,
  hasUsableElectronSession,
}: StoredSessionCheckerDeps): () => boolean | Promise<boolean> {
  let validatedSignature: string | null = null;
  let pendingCheck: PendingSessionCheck | null = null;

  return function hasStoredSession(): boolean | Promise<boolean> {
    const localStorage = getLocalStorage();
    if (!localStorage) {
      validatedSignature = null;
      pendingCheck = null;
      return false;
    }

    const signature = readStoredSessionSignature(localStorage);
    if (!signature) {
      validatedSignature = null;
      pendingCheck = null;
      return false;
    }

    if (validatedSignature === signature) {
      return true;
    }

    if (pendingCheck?.signature === signature) {
      return pendingCheck.promise;
    }

    let currentCheck: PendingSessionCheck;
    const promise = (async (): Promise<boolean> => {
      const hasAndroidSession = await hasUsableAndroidSession();
      if (readStoredSessionSignature(localStorage) !== signature) {
        return hasStoredSession();
      }
      if (!hasAndroidSession) {
        clearAndroidSessionMetadata();
        return false;
      }

      const hasElectronSession = await hasUsableElectronSession();
      if (readStoredSessionSignature(localStorage) !== signature) {
        return hasStoredSession();
      }
      if (!hasElectronSession) {
        clearElectronSessionMetadata();
        return false;
      }

      validatedSignature = signature;
      return true;
    })().finally(() => {
      if (pendingCheck === currentCheck) {
        pendingCheck = null;
      }
    });

    currentCheck = { promise, signature };
    pendingCheck = currentCheck;
    return promise;
  };
}
