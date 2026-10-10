import { SecureStorage } from '#src/lib/platform/legacyNative.ts';
import { Capacitor } from '#src/lib/platform/legacyNative.ts';
import { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  AUTH_METHOD_STORAGE_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from '#src/stores/nostr/constants.ts';

const ANDROID_SECURE_PRIVATE_KEY_STORAGE_KEY = 'nostr-chat:nsec';
const ANDROID_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY = 'nostr-chat:android-memory-only-nsec-pubkey';

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

export function isAndroidSecurePrivateKeyStorageAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function readAndroidSecurePrivateKeyHex(): Promise<string | null> {
  if (!isAndroidSecurePrivateKeyStorageAvailable()) {
    return null;
  }

  const value = await SecureStorage.getItem(ANDROID_SECURE_PRIVATE_KEY_STORAGE_KEY);
  return inputSanitizerService.normalizeHexKey(value ?? '');
}

export async function writeAndroidSecurePrivateKeyHex(privateKeyHex: string): Promise<void> {
  if (!isAndroidSecurePrivateKeyStorageAvailable()) {
    return;
  }

  await SecureStorage.setItem(ANDROID_SECURE_PRIVATE_KEY_STORAGE_KEY, privateKeyHex);
}

export async function removeAndroidSecurePrivateKeyHex(): Promise<void> {
  if (!isAndroidSecurePrivateKeyStorageAvailable()) {
    return;
  }

  await SecureStorage.removeItem(ANDROID_SECURE_PRIVATE_KEY_STORAGE_KEY);
}

export function markAndroidPrivateKeyMemoryOnlySession(pubkeyHex: string): void {
  if (!isAndroidSecurePrivateKeyStorageAvailable()) {
    return;
  }

  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
  const sessionStorage = getSessionStorage();
  if (!normalizedPubkey || !sessionStorage) {
    return;
  }

  sessionStorage.setItem(ANDROID_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY, normalizedPubkey);
}

export function clearAndroidPrivateKeyMemoryOnlySession(): void {
  getSessionStorage()?.removeItem(ANDROID_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY);
}

function hasAndroidPrivateKeyMemoryOnlySession(pubkeyHex: string): boolean {
  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkeyHex);
  const storedPubkey = inputSanitizerService.normalizeHexKey(
    getSessionStorage()?.getItem(ANDROID_MEMORY_ONLY_PRIVATE_KEY_SESSION_KEY) ?? ''
  );

  return Boolean(normalizedPubkey && storedPubkey && normalizedPubkey === storedPubkey);
}

export function clearAndroidPrivateKeySessionMetadata(): void {
  const localStorage = getLocalStorage();
  localStorage?.removeItem(AUTH_METHOD_STORAGE_KEY);
  localStorage?.removeItem(PRIVATE_KEY_STORAGE_KEY);
  localStorage?.removeItem(PUBLIC_KEY_STORAGE_KEY);
  clearAndroidPrivateKeyMemoryOnlySession();
}

function derivePublicKeyFromPrivateKeyHex(privateKeyHex: string): string | null {
  try {
    return inputSanitizerService.normalizeHexKey(new NostrPrivateKeySigner(privateKeyHex).pubkey);
  } catch {
    return null;
  }
}

export async function hasUsableAndroidPrivateKeySession(): Promise<boolean> {
  if (!isAndroidSecurePrivateKeyStorageAvailable()) {
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

  if (hasAndroidPrivateKeyMemoryOnlySession(storedPubkey)) {
    return true;
  }

  try {
    const securePrivateKey = await readAndroidSecurePrivateKeyHex();
    return Boolean(
      securePrivateKey && derivePublicKeyFromPrivateKeyHex(securePrivateKey) === storedPubkey
    );
  } catch (error) {
    console.warn('Failed to check Android secure private-key storage.', error);
    return false;
  }
}
