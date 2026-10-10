import { isNativeSecureStorage, readNativeKey, writeNativeKey, removeNativeKey } from '#src/lib/platform/secureKeys.ts';
import { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  AUTH_METHOD_STORAGE_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from '#src/stores/nostr/constants.ts';

const ELECTRON_SECURE_PRIVATE_KEY_STORAGE_KEY = 'nostr-chat:electron-secure-nsec';
const ELECTRON_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY = 'nostr-chat:electron-memory-only-nsec-pubkey';

function getLocalStorage(): Storage | null {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
    ? window.localStorage
    : null;
}

function getSessionStorage(): Storage | null {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'
    ? window.sessionStorage
    : null;
}

function getDesktopRuntime(): Window['desktopRuntime'] | null {
  return typeof window !== 'undefined' && window.desktopRuntime?.isElectron === true
    ? window.desktopRuntime
    : null;
}

export function isElectronSecurePrivateKeyStorageAvailable(): boolean {
  if (isNativeSecureStorage()) return true;
  const desktopRuntime = getDesktopRuntime();
  return Boolean(
    desktopRuntime &&
      typeof desktopRuntime.encryptPrivateKey === 'function' &&
      typeof desktopRuntime.decryptPrivateKey === 'function'
  );
}

export async function readElectronSecurePrivateKeyHex(): Promise<string | null> {
  if (isNativeSecureStorage()) return readNativeKey();
  const desktopRuntime = getDesktopRuntime();
  const localStorage = getLocalStorage();
  if (!isElectronSecurePrivateKeyStorageAvailable() || !desktopRuntime || !localStorage) {
    return null;
  }

  const encryptedValue = localStorage.getItem(ELECTRON_SECURE_PRIVATE_KEY_STORAGE_KEY)?.trim();
  if (!encryptedValue) {
    return null;
  }

  const value = await desktopRuntime.decryptPrivateKey(encryptedValue);
  return inputSanitizerService.normalizeHexKey(value ?? '');
}

export async function writeElectronSecurePrivateKeyHex(privateKeyHex: string): Promise<void> {
  if (isNativeSecureStorage()) return writeNativeKey(privateKeyHex);
  const desktopRuntime = getDesktopRuntime();
  const localStorage = getLocalStorage();
  if (!isElectronSecurePrivateKeyStorageAvailable() || !desktopRuntime || !localStorage) {
    return;
  }

  const encryptedValue = await desktopRuntime.encryptPrivateKey(privateKeyHex);
  localStorage.setItem(ELECTRON_SECURE_PRIVATE_KEY_STORAGE_KEY, encryptedValue);
}

export async function removeElectronSecurePrivateKeyHex(): Promise<void> {
  if (isNativeSecureStorage()) await removeNativeKey();
  getLocalStorage()?.removeItem(ELECTRON_SECURE_PRIVATE_KEY_STORAGE_KEY);
}

export function markElectronPrivateKeyMemoryOnlySession(pubkeyHex: string): void {
  if (!isElectronSecurePrivateKeyStorageAvailable()) {
    return;
  }

  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
  const sessionStorage = getSessionStorage();
  if (!normalizedPubkey || !sessionStorage) {
    return;
  }

  sessionStorage.setItem(ELECTRON_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY, normalizedPubkey);
}

export function clearElectronPrivateKeyMemoryOnlySession(): void {
  getSessionStorage()?.removeItem(ELECTRON_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY);
}

function hasElectronPrivateKeyMemoryOnlySession(pubkeyHex: string): boolean {
  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
  const storedPubkey = inputSanitizerService.normalizeHexKey(
    getSessionStorage()?.getItem(ELECTRON_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY) ?? ''
  );

  return Boolean(normalizedPubkey && storedPubkey && normalizedPubkey === storedPubkey);
}

export function clearElectronPrivateKeySessionMetadata(): void {
  const localStorage = getLocalStorage();
  localStorage?.removeItem(AUTH_METHOD_STORAGE_KEY);
  localStorage?.removeItem(PRIVATE_KEY_STORAGE_KEY);
  localStorage?.removeItem(PUBLIC_KEY_STORAGE_KEY);
  localStorage?.removeItem(ELECTRON_SECURE_PRIVATE_KEY_STORAGE_KEY);
  clearElectronPrivateKeyMemoryOnlySession();
}

function derivePublicKeyFromPrivateKeyHex(privateKeyHex: string): string | null {
  try {
    return inputSanitizerService.normalizeHexKey(new NostrPrivateKeySigner(privateKeyHex).pubkey);
  } catch {
    return null;
  }
}

export async function hasUsableElectronPrivateKeySession(): Promise<boolean> {
  if (!isElectronSecurePrivateKeyStorageAvailable()) {
    return true;
  }

  const localStorage = getLocalStorage();
  if (!localStorage) {
    return false;
  }

  const storedPubkey =
    inputSanitizerService.normalizeHexKey(localStorage.getItem(PUBLIC_KEY_STORAGE_KEY) ?? '') ??
    inputSanitizerService.validateNpub(localStorage.getItem(PUBLIC_KEY_STORAGE_KEY) ?? '')
      .normalizedPubkey;
  if (!storedPubkey) {
    return false;
  }

  const authMethod = localStorage.getItem(AUTH_METHOD_STORAGE_KEY)?.trim().toLowerCase();
  if (authMethod && authMethod !== 'nsec') {
    return true;
  }

  const legacyPrivateKey = inputSanitizerService.normalizeHexKey(
    localStorage.getItem(PRIVATE_KEY_STORAGE_KEY) ?? ''
  );
  if (legacyPrivateKey && derivePublicKeyFromPrivateKeyHex(legacyPrivateKey) === storedPubkey) {
    return true;
  }

  if (hasElectronPrivateKeyMemoryOnlySession(storedPubkey)) {
    return true;
  }

  try {
    const securePrivateKey = await readElectronSecurePrivateKeyHex();
    return Boolean(
      securePrivateKey && derivePublicKeyFromPrivateKeyHex(securePrivateKey) === storedPubkey
    );
  } catch (error) {
    console.warn('Failed to check Electron secure private-key storage.', error);
    return false;
  }
}
