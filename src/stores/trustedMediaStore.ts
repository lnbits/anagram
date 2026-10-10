import { defineStore } from '#src/lib/state/store.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { ref } from '#src/lib/state/reactivity.ts';

const TRUSTED_IMAGE_SENDERS_STORAGE_KEY = 'nostr-chat:trusted-image-senders';

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function normalizeTrustedImageSenderPublicKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return inputSanitizerService.normalizeHexKey(value);
}

export function normalizeTrustedImageSenderPublicKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => normalizeTrustedImageSenderPublicKey(entry))
        .filter((entry): entry is string => Boolean(entry))
    )
  );
}

export function isTrustedImageSenderValue(
  senderPublicKey: unknown,
  trustedSenderPublicKeys: unknown,
  loggedInPublicKey?: unknown
): boolean {
  const normalizedSenderPublicKey = normalizeTrustedImageSenderPublicKey(senderPublicKey);
  if (!normalizedSenderPublicKey) {
    return false;
  }

  const normalizedLoggedInPublicKey = normalizeTrustedImageSenderPublicKey(loggedInPublicKey);
  if (normalizedLoggedInPublicKey && normalizedSenderPublicKey === normalizedLoggedInPublicKey) {
    return true;
  }

  return normalizeTrustedImageSenderPublicKeys(trustedSenderPublicKeys).includes(
    normalizedSenderPublicKey
  );
}

function readTrustedImageSenders(): string[] {
  if (!canUseLocalStorage()) {
    return [];
  }

  try {
    return normalizeTrustedImageSenderPublicKeys(
      JSON.parse(window.localStorage.getItem(TRUSTED_IMAGE_SENDERS_STORAGE_KEY) ?? '[]')
    );
  } catch {
    return [];
  }
}

function persistTrustedImageSenders(publicKeys: string[]): void {
  if (!canUseLocalStorage()) {
    return;
  }

  window.localStorage.setItem(
    TRUSTED_IMAGE_SENDERS_STORAGE_KEY,
    JSON.stringify(normalizeTrustedImageSenderPublicKeys(publicKeys))
  );
}

export const useTrustedMediaStore = defineStore('trustedMediaStore', () => {
  const trustedImageSenderPublicKeys = ref<string[]>(readTrustedImageSenders());

  function isImageSenderTrusted(senderPublicKey: string, loggedInPublicKey?: string): boolean {
    return isTrustedImageSenderValue(
      senderPublicKey,
      trustedImageSenderPublicKeys.value,
      loggedInPublicKey
    );
  }

  function trustImageSender(senderPublicKey: string): boolean {
    const normalizedPublicKey = normalizeTrustedImageSenderPublicKey(senderPublicKey);
    if (!normalizedPublicKey) {
      return false;
    }

    if (trustedImageSenderPublicKeys.value.includes(normalizedPublicKey)) {
      return false;
    }

    trustedImageSenderPublicKeys.value = [
      ...trustedImageSenderPublicKeys.value,
      normalizedPublicKey,
    ];
    persistTrustedImageSenders(trustedImageSenderPublicKeys.value);
    return true;
  }

  return {
    trustedImageSenderPublicKeys,
    isImageSenderTrusted,
    trustImageSender,
  };
});
