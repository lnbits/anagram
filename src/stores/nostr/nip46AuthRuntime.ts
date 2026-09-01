import type NDK from '@nostr-dev-kit/ndk';
import { NDKNip46Signer, normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import type {
  AuthMethod,
  Nip46LoginResult,
  Nip46NostrConnectLogin,
  Nip46SessionSnapshot,
} from 'src/stores/nostr/types';

export const NIP46_DEFAULT_PERMISSIONS = 'sign_event,nip44_encrypt,nip44_decrypt';
const NIP46_APP_NAME = 'Anagram';

interface Nip46AuthRuntimeDeps {
  clearCurrentAuthSession: () => void;
  ndk: NDK;
  resetEventSinceForFreshLogin: () => void;
  setCachedSigner: (signer: NDKNip46Signer | null) => void;
  setCachedSignerSessionKey: (sessionKey: string | null) => void;
  setStoredAuthSession: (authMethod: AuthMethod, pubkeyHex: string) => void;
  setStoredNip46SignerPayload: (payload: string) => void;
}

interface CreateNip46NostrConnectLoginInput {
  relayUrl: string;
  onAuthUrl?: (url: string) => void;
}

interface LoginWithNip46BunkerInput {
  connectionToken: string;
  onAuthUrl?: (url: string) => void;
}

interface NostrConnectUriInput {
  clientPubkey: string;
  relayUrl: string;
  secret: string;
  name?: string;
  permissions?: string;
  url?: string;
  image?: string;
}

type MutableNip46SignerInternals = {
  nostrConnectSecret?: string;
  nostrConnectUri?: string;
};

function readCrypto(): Crypto | null {
  return typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function generateNip46Secret(): string {
  const crypto = readCrypto();
  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('');
}

function appendOptionalUriParam(params: URLSearchParams, key: string, value?: string): void {
  const normalized = value?.trim();
  if (normalized) {
    params.set(key, normalized);
  }
}

export function normalizeNip46Pubkey(value: string): string | null {
  return (
    inputSanitizerService.normalizeHexKey(value) ??
    inputSanitizerService.validateNpub(value).normalizedPubkey
  );
}

export function buildNip46NostrConnectUri({
  clientPubkey,
  relayUrl,
  secret,
  name = NIP46_APP_NAME,
  permissions = NIP46_DEFAULT_PERMISSIONS,
  url,
  image,
}: NostrConnectUriInput): string {
  const normalizedClientPubkey = normalizeNip46Pubkey(clientPubkey);
  const normalizedRelayUrl = normalizeNip46RelayUrl(relayUrl);
  const normalizedSecret = secret.trim();
  if (!normalizedClientPubkey) {
    throw new Error('A valid NIP-46 client public key is required.');
  }

  if (!normalizedRelayUrl) {
    throw new Error('A valid NIP-46 relay URL is required.');
  }

  if (!normalizedSecret) {
    throw new Error('A NIP-46 connection secret is required.');
  }

  const params = new URLSearchParams();
  appendOptionalUriParam(params, 'name', name);
  appendOptionalUriParam(params, 'perms', permissions);
  appendOptionalUriParam(params, 'url', url);
  appendOptionalUriParam(params, 'image', image);
  params.set('secret', normalizedSecret);
  params.set('relay', normalizedRelayUrl);

  return `nostrconnect://${normalizedClientPubkey}?${params.toString()}`;
}

export function normalizeNip46RelayUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return null;
    }

    if (!url.hostname) {
      return null;
    }

    return normalizeRelayUrl(trimmed);
  } catch {
    return null;
  }
}

export function normalizeNip46BunkerUri(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'bunker:') {
      return null;
    }

    const signerPubkey = normalizeNip46Pubkey(url.hostname || url.pathname.replace(/^\/+/, ''));
    if (!signerPubkey) {
      return null;
    }

    const params = new URLSearchParams(url.search);
    const relayUrls = params
      .getAll('relay')
      .map((relayUrl) => normalizeNip46RelayUrl(relayUrl))
      .filter((relayUrl): relayUrl is string => Boolean(relayUrl));
    if (relayUrls.length === 0) {
      return null;
    }

    const userPubkey = params.get('pubkey');
    if (userPubkey !== null) {
      const normalizedUserPubkey = normalizeNip46Pubkey(userPubkey);
      if (!normalizedUserPubkey) {
        return null;
      }
      params.set('pubkey', normalizedUserPubkey);
    }

    params.delete('relay');
    for (const relayUrl of Array.from(new Set(relayUrls))) {
      params.append('relay', relayUrl);
    }

    return `bunker://${signerPubkey}?${params.toString()}`;
  } catch {
    return null;
  }
}

function readNip46SignerPayloadValue(payload: string | null): Record<string, unknown> | null {
  const normalizedPayload = payload?.trim();
  if (!normalizedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalizedPayload) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const wrapper = parsed as { type?: unknown; payload?: unknown };
    if (wrapper.type !== 'nip46' || !wrapper.payload || typeof wrapper.payload !== 'object') {
      return null;
    }

    return wrapper.payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getNip46SessionSnapshotFromPayload(payload: string | null): Nip46SessionSnapshot {
  const parsedPayload = readNip46SignerPayloadValue(payload);
  if (!parsedPayload) {
    return {
      signerPubkey: null,
      relayUrls: [],
    };
  }

  const signerPubkey =
    typeof parsedPayload.bunkerPubkey === 'string'
      ? normalizeNip46Pubkey(parsedPayload.bunkerPubkey)
      : null;
  const relayUrls = Array.isArray(parsedPayload.relayUrls)
    ? parsedPayload.relayUrls
        .map((relayUrl) => (typeof relayUrl === 'string' ? normalizeNip46RelayUrl(relayUrl) : null))
        .filter((relayUrl): relayUrl is string => Boolean(relayUrl))
    : [];

  return {
    signerPubkey,
    relayUrls: Array.from(new Set(relayUrls)),
  };
}

export function createNip46AuthRuntime({
  clearCurrentAuthSession,
  ndk,
  resetEventSinceForFreshLogin,
  setCachedSigner,
  setCachedSignerSessionKey,
  setStoredAuthSession,
  setStoredNip46SignerPayload,
}: Nip46AuthRuntimeDeps) {
  function buildLoginResult(signer: NDKNip46Signer, pubkey: string): Nip46LoginResult {
    return {
      pubkey,
      signerPubkey: inputSanitizerService.normalizeHexKey(signer.bunkerPubkey ?? '') ?? null,
      relayUrls: Array.from(
        new Set(
          (signer.relayUrls ?? [])
            .map((relayUrl) => normalizeNip46RelayUrl(relayUrl))
            .filter((relayUrl): relayUrl is string => Boolean(relayUrl))
        )
      ),
    };
  }

  function persistReadySigner(signer: NDKNip46Signer, pubkey: string): Nip46LoginResult {
    clearCurrentAuthSession();
    resetEventSinceForFreshLogin();
    setStoredAuthSession('nip46', pubkey);
    setStoredNip46SignerPayload(signer.toPayload());
    setCachedSigner(signer);
    setCachedSignerSessionKey(`nip46:${pubkey}`);
    ndk.signer = signer;
    return buildLoginResult(signer, pubkey);
  }

  async function resolveReadySigner(
    signer: NDKNip46Signer,
    onAuthUrl?: (url: string) => void,
    options: { shouldCommit?: () => boolean } = {}
  ): Promise<Nip46LoginResult> {
    if (onAuthUrl) {
      signer.on('authUrl', (url: string) => {
        const normalizedUrl = url.trim();
        if (normalizedUrl) {
          onAuthUrl(normalizedUrl);
        }
      });
    }

    const user = await signer.blockUntilReady();
    user.ndk = ndk;
    const pubkey = inputSanitizerService.normalizeHexKey(user.pubkey ?? signer.pubkey);
    if (!pubkey) {
      throw new Error('The remote signer did not return a valid user public key.');
    }

    if (options.shouldCommit && !options.shouldCommit()) {
      throw new Error('NIP-46 login was cancelled.');
    }

    return persistReadySigner(signer, pubkey);
  }

  async function loginWithNip46Bunker({
    connectionToken,
    onAuthUrl,
  }: LoginWithNip46BunkerInput): Promise<Nip46LoginResult> {
    const normalizedToken = normalizeNip46BunkerUri(connectionToken);
    if (!normalizedToken) {
      throw new Error('Enter a valid bunker:// connection string with at least one relay.');
    }

    const signer = NDKNip46Signer.bunker(ndk, normalizedToken);
    return resolveReadySigner(signer, onAuthUrl);
  }

  function createNip46NostrConnectLogin({
    relayUrl,
    onAuthUrl,
  }: CreateNip46NostrConnectLoginInput): Nip46NostrConnectLogin {
    const normalizedRelayUrl = normalizeNip46RelayUrl(relayUrl);
    if (!normalizedRelayUrl) {
      throw new Error('Enter a valid ws:// or wss:// relay URL.');
    }

    const signer = NDKNip46Signer.nostrconnect(ndk, normalizedRelayUrl, undefined, {
      name: NIP46_APP_NAME,
      perms: NIP46_DEFAULT_PERMISSIONS,
    });
    const secureSecret = generateNip46Secret();
    const mutableSigner = signer as unknown as MutableNip46SignerInternals;
    mutableSigner.nostrConnectSecret = secureSecret;
    mutableSigner.nostrConnectUri = buildNip46NostrConnectUri({
      clientPubkey: signer.localSigner.pubkey,
      relayUrl: normalizedRelayUrl,
      secret: secureSecret,
    });

    let cancelled = false;
    let rejectCancelled: ((error: Error) => void) | null = null;
    const cancelledPromise = new Promise<Nip46LoginResult>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const loginPromise = Promise.race([
      resolveReadySigner(signer, onAuthUrl, { shouldCommit: () => !cancelled }).then((result) => {
        if (cancelled) {
          throw new Error('NIP-46 login was cancelled.');
        }
        return result;
      }),
      cancelledPromise,
    ]);

    return {
      clientPubkey: signer.localSigner.pubkey,
      login: loginPromise,
      relayUrl: normalizedRelayUrl,
      uri: mutableSigner.nostrConnectUri,
      cancel: () => {
        if (cancelled) {
          return;
        }

        cancelled = true;
        signer.stop();
        rejectCancelled?.(new Error('NIP-46 login was cancelled.'));
      },
    };
  }

  return {
    createNip46NostrConnectLogin,
    loginWithNip46Bunker,
  };
}
