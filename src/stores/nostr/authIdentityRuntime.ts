import type NostrClient from '#src/lib/nostr/client.ts';
import { NostrPrivateKeySigner, type NostrSigner, type NostrUser, nip19 } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { AUTH_METHOD_STORAGE_KEY, PUBLIC_KEY_STORAGE_KEY } from '#src/stores/nostr/constants.ts';
import { hasStorage } from '#src/stores/nostr/shared.ts';
import type { AuthMethod } from '#src/stores/nostr/types.ts';

interface AuthIdentityRuntimeDeps {
  getOrCreateSigner: () => Promise<NostrSigner>;
  getPrivateKeyHex: () => string | null;
  ndk: NostrClient;
}

export function createAuthIdentityRuntime({
  getOrCreateSigner,
  getPrivateKeyHex,
  ndk,
}: AuthIdentityRuntimeDeps) {
  function getStoredAuthMethod(): AuthMethod | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(AUTH_METHOD_STORAGE_KEY)?.trim().toLowerCase();
    if (stored === 'nsec' || stored === 'nip07' || stored === 'nip46') {
      return stored;
    }

    return getPrivateKeyHex() ? 'nsec' : null;
  }

  function getLoggedInPublicKeyHex(): string | null {
    if (!hasStorage()) {
      return null;
    }

    const stored = window.localStorage.getItem(PUBLIC_KEY_STORAGE_KEY)?.trim();
    if (!stored) {
      return null;
    }

    const fromHex = inputSanitizerService.normalizeHexKey(stored);
    if (fromHex) {
      return fromHex;
    }

    return inputSanitizerService.validateNpub(stored).normalizedPubkey;
  }

  function hasNip07Extension(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.nostr?.getPublicKey === 'function' &&
      typeof window.nostr?.signEvent === 'function'
    );
  }

  function encodeNpub(pubkeyHex: string): string | null {
    try {
      return nip19.npubEncode(pubkeyHex);
    } catch {
      return null;
    }
  }

  function encodeNprofile(pubkeyHex: string): string | null {
    try {
      return nip19.nprofileEncode({
        pubkey: pubkeyHex,
      });
    } catch {
      return null;
    }
  }

  function derivePublicKeyFromPrivateKey(privateKey: string): string | null {
    const normalizedPrivateKey = inputSanitizerService.normalizeHexKey(privateKey);
    if (!normalizedPrivateKey) {
      return null;
    }

    try {
      return inputSanitizerService.normalizeHexKey(
        new NostrPrivateKeySigner(normalizedPrivateKey).pubkey
      );
    } catch {
      return null;
    }
  }

  async function getLoggedInSignerUser(): Promise<NostrUser> {
    const signer = await getOrCreateSigner();
    const user = await signer.user();
    user.ndk = ndk;
    return user;
  }

  return {
    derivePublicKeyFromPrivateKey,
    encodeNprofile,
    encodeNpub,
    getLoggedInPublicKeyHex,
    getLoggedInSignerUser,
    getStoredAuthMethod,
    hasNip07Extension,
  };
}
