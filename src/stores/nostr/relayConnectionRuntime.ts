import NDK, {
  NDKNip07Signer,
  NDKNip46Signer,
  NDKPrivateKeySigner,
  type NDKRelay,
  type NDKRelayInformation,
  NDKRelayStatus,
  type NDKSigner,
  normalizeRelayUrl,
} from '@nostr-dev-kit/ndk';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { waitForFirstReadyOrTimeout } from 'src/stores/nostr/relayTimeoutUtils';
import type {
  AuthMethod,
  DeveloperRelaySnapshot,
  RelayConnectionState,
} from 'src/stores/nostr/types';

interface RelayConnectionRuntimeDeps {
  authenticatedRelayUrls: Set<string>;
  buildRelaySnapshot: (relay: NDKRelay | null | undefined) => DeveloperRelaySnapshot;
  bumpRelayStatusVersion: () => void;
  configuredRelayUrls: Set<string>;
  getCachedSigner: () => NDKSigner | null;
  getCachedSignerSessionKey: () => string | null;
  getConnectPromise: () => Promise<void> | null;
  getHasActivatedPool: () => boolean;
  getHasRelayStatusListeners: () => boolean;
  getLoggedInPublicKeyHex: () => string | null;
  getNip46SignerPayload: () => string | null;
  loadPrivateKeyHex: () => Promise<string | null>;
  getStoredAuthMethod: () => AuthMethod | null;
  hasNip07Extension: () => boolean;
  initialConnectTimeoutMs: number;
  isPrivateMessagesSubscriptionRelayTracked: (relayUrl: string) => boolean;
  relayFirstHealthyWaitMs: number;
  logDeveloperTrace: (
    level: 'info' | 'warn' | 'error',
    area: string,
    phase: string,
    details: Record<string, unknown>
  ) => void;
  logRelayLifecycle: (eventName: string, relay: NDKRelay) => void;
  markPrivateMessagesWatchdogRelayDisconnected: (relayUrl: string) => void;
  ndk: NDK;
  queuePrivateMessagesWatchdog: (delayMs?: number) => void;
  relayAuthFailureListenerUrls: Set<string>;
  relayConnectFailureCooldownMs: number;
  relayConnectFailureCooldownUntilByUrl: Map<string, number>;
  relayConnectPromises: Map<string, Promise<void>>;
  queueOutboundMessageReplay: () => void;
  setCachedSigner: (signer: NDKSigner | null) => void;
  setCachedSignerSessionKey: (sessionKey: string | null) => void;
  setConnectPromise: (promise: Promise<void> | null) => void;
  setHasActivatedPool: (value: boolean) => void;
  setHasRelayStatusListeners: (value: boolean) => void;
}

const RELAY_SOCKET_CONNECTING = 0;
const RELAY_SOCKET_OPEN = 1;

type RelaySocketLike = {
  close: () => void;
  readyState: number;
};

type RelayConnectivityState = {
  _status?: NDKRelayStatus;
  connectTimeout?: ReturnType<typeof globalThis.setTimeout> | null;
  ws?: RelaySocketLike;
};

type GuardedRelay = NDKRelay & {
  __nostrChatConnectPromise?: Promise<void> | null;
  __nostrChatSingleSocketGuardInstalled?: boolean;
};

function closeGuardedRelaySocket(relay: NDKRelay, connectivity: RelayConnectivityState): void {
  if (connectivity.connectTimeout) {
    clearTimeout(connectivity.connectTimeout);
    connectivity.connectTimeout = null;
  }

  if (connectivity.ws) {
    try {
      connectivity.ws.close();
    } catch {
      // Ignore stale socket close failures and continue with a fresh connect.
    }

    connectivity.ws = undefined;
  }

  if (relay.status < NDKRelayStatus.CONNECTED) {
    connectivity._status = NDKRelayStatus.DISCONNECTED;
  }
}

export function ensureSingleSocketRelayConnectGuard(relay: NDKRelay | null | undefined): void {
  const guardedRelay = relay as GuardedRelay | null | undefined;
  if (!guardedRelay || guardedRelay.__nostrChatSingleSocketGuardInstalled) {
    return;
  }

  const originalConnect = relay.connect.bind(relay);
  guardedRelay.__nostrChatSingleSocketGuardInstalled = true;
  guardedRelay.__nostrChatConnectPromise = null;
  guardedRelay.connect = ((timeoutMs?: number, reconnect = true) => {
    const connectivity = relay.connectivity as unknown as RelayConnectivityState;
    const existingPromise = guardedRelay.__nostrChatConnectPromise ?? null;
    const readyState = connectivity.ws?.readyState;

    if (
      existingPromise &&
      (readyState === RELAY_SOCKET_CONNECTING || readyState === RELAY_SOCKET_OPEN)
    ) {
      return existingPromise;
    }

    if (readyState !== undefined && readyState !== RELAY_SOCKET_OPEN) {
      closeGuardedRelaySocket(relay, connectivity);
    }

    const connectPromise = Promise.resolve(originalConnect(timeoutMs, reconnect)).finally(() => {
      if (guardedRelay.__nostrChatConnectPromise === connectPromise) {
        guardedRelay.__nostrChatConnectPromise = null;
      }
    });

    guardedRelay.__nostrChatConnectPromise = connectPromise;
    return connectPromise;
  }) as typeof relay.connect;
}

export function createRelayConnectionRuntime({
  authenticatedRelayUrls,
  buildRelaySnapshot,
  bumpRelayStatusVersion,
  configuredRelayUrls,
  getCachedSigner,
  getCachedSignerSessionKey,
  getConnectPromise,
  getHasActivatedPool,
  getHasRelayStatusListeners,
  getLoggedInPublicKeyHex,
  getNip46SignerPayload,
  loadPrivateKeyHex,
  getStoredAuthMethod,
  hasNip07Extension,
  initialConnectTimeoutMs,
  isPrivateMessagesSubscriptionRelayTracked,
  relayFirstHealthyWaitMs,
  logDeveloperTrace,
  logRelayLifecycle,
  markPrivateMessagesWatchdogRelayDisconnected,
  ndk,
  queuePrivateMessagesWatchdog,
  relayAuthFailureListenerUrls,
  relayConnectFailureCooldownMs,
  relayConnectFailureCooldownUntilByUrl,
  relayConnectPromises,
  queueOutboundMessageReplay,
  setCachedSigner,
  setCachedSignerSessionKey,
  setConnectPromise,
  setHasActivatedPool,
  setHasRelayStatusListeners,
}: RelayConnectionRuntimeDeps) {
  function setRelayConnectivityStatus(relay: NDKRelay, status: NDKRelayStatus): void {
    const connectivity = relay.connectivity as unknown as {
      _status?: NDKRelayStatus;
    };
    connectivity._status = status;
  }

  async function getOrCreateSigner(): Promise<NDKSigner> {
    const authMethod = getStoredAuthMethod();
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!authMethod || !loggedInPubkeyHex) {
      throw new Error('Missing signer session. Login is required.');
    }

    const sessionKey = `${authMethod}:${loggedInPubkeyHex}`;
    let cachedSigner = getCachedSigner();
    if (!cachedSigner || getCachedSignerSessionKey() !== sessionKey) {
      if (authMethod === 'nip07') {
        if (!hasNip07Extension()) {
          throw new Error('No NIP-07 extension detected. Install or enable one to continue.');
        }

        cachedSigner = new NDKNip07Signer(undefined, ndk);
      } else if (authMethod === 'nip46') {
        const payload = getNip46SignerPayload();
        if (!payload) {
          throw new Error('Missing NIP-46 remote signer session. Login is required.');
        }

        cachedSigner = await NDKNip46Signer.fromPayload(payload, ndk);
      } else {
        const privateKeyHex = await loadPrivateKeyHex();
        if (!privateKeyHex) {
          throw new Error('Missing private key for local signer. Login is required.');
        }

        cachedSigner = new NDKPrivateKeySigner(privateKeyHex, ndk);
      }

      setCachedSigner(cachedSigner);
      setCachedSignerSessionKey(sessionKey);
    }

    ndk.signer = cachedSigner;
    const user = await cachedSigner.blockUntilReady();
    user.ndk = ndk;
    const signerPubkey = inputSanitizerService.normalizeHexKey(user.pubkey ?? cachedSigner.pubkey);
    if (!signerPubkey) {
      throw new Error('Signer did not provide a valid public key.');
    }

    if (signerPubkey !== loggedInPubkeyHex) {
      throw new Error(
        authMethod === 'nip07'
          ? 'The connected NIP-07 extension account does not match the current login.'
          : authMethod === 'nip46'
            ? 'The connected NIP-46 remote signer account does not match the current login.'
            : 'The stored signer does not match the current login.'
      );
    }

    return cachedSigner;
  }

  ndk.relayAuthDefaultPolicy = async (relay, challenge) => {
    if (authenticatedRelayUrls.has(relay.url)) {
      setRelayConnectivityStatus(relay, NDKRelayStatus.AUTHENTICATED);
      logDeveloperTrace('info', 'relay', 'auth-skip-already-authenticated', {
        ...buildRelaySnapshot(relay),
        challengeLength: challenge.length,
      });
      relay.emit('authed');
      return false;
    }

    try {
      await getOrCreateSigner();
      return true;
    } catch (error) {
      logDeveloperTrace('warn', 'relay', 'auth-skip-missing-signer', {
        ...buildRelaySnapshot(relay),
        challengeLength: challenge.length,
        error,
      });
      relay.disconnect();
      return false;
    }
  };

  function ensureRelayStatusListeners(): void {
    if (getHasRelayStatusListeners()) {
      return;
    }

    ndk.pool.on('relay:connecting', (relay) => {
      authenticatedRelayUrls.delete(relay.url);
      bumpRelayStatusVersion();
      logRelayLifecycle('connecting', relay);
    });
    ndk.pool.on('relay:connect', (relay) => {
      authenticatedRelayUrls.delete(relay.url);
      bumpRelayStatusVersion();
      logRelayLifecycle('connect', relay);
      if (getLoggedInPublicKeyHex()) {
        queueOutboundMessageReplay();
      }
      if (isPrivateMessagesSubscriptionRelayTracked(relay.url)) {
        queuePrivateMessagesWatchdog(0);
      }
    });
    ndk.pool.on('relay:ready', (relay) => {
      bumpRelayStatusVersion();
      logRelayLifecycle('ready', relay);
    });
    ndk.pool.on('relay:disconnect', (relay) => {
      authenticatedRelayUrls.delete(relay.url);
      bumpRelayStatusVersion();
      logRelayLifecycle('disconnect', relay);
      if (isPrivateMessagesSubscriptionRelayTracked(relay.url)) {
        markPrivateMessagesWatchdogRelayDisconnected(relay.url);
        queuePrivateMessagesWatchdog(0);
      }
    });
    ndk.pool.on('relay:auth', (relay, challenge) => {
      bumpRelayStatusVersion();
      logDeveloperTrace('info', 'relay', 'auth-requested', {
        ...buildRelaySnapshot(relay),
        challengeLength: challenge.length,
      });
    });
    ndk.pool.on('relay:authed', (relay) => {
      authenticatedRelayUrls.add(relay.url);
      bumpRelayStatusVersion();
      logDeveloperTrace('info', 'relay', 'authed', {
        ...buildRelaySnapshot(relay),
      });
    });
    ndk.pool.on('flapping', (relay) => {
      bumpRelayStatusVersion();
      logRelayLifecycle('flapping', relay);
    });
    setHasRelayStatusListeners(true);
  }

  function ensureRelayAuthFailureListener(relay: NDKRelay | null | undefined): void {
    if (!relay || relayAuthFailureListenerUrls.has(relay.url)) {
      return;
    }

    relay.on('auth:failed', (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error ?? '');
      if (errorMessage.toLowerCase().includes('already authenticated')) {
        authenticatedRelayUrls.add(relay.url);
        setRelayConnectivityStatus(relay, NDKRelayStatus.AUTHENTICATED);
        bumpRelayStatusVersion();
        logDeveloperTrace('info', 'relay', 'auth-failed-already-authenticated', {
          ...buildRelaySnapshot(relay),
          error: errorMessage,
        });
        relay.emit('authed');
        return;
      }

      authenticatedRelayUrls.delete(relay.url);
      bumpRelayStatusVersion();
      logDeveloperTrace('warn', 'relay', 'auth-failed', {
        ...buildRelaySnapshot(relay),
        error,
      });
    });
    relayAuthFailureListenerUrls.add(relay.url);
  }

  function connectRelayForEnsureRelayConnections(
    relay: NDKRelay | null | undefined,
    normalizedRelayUrl: string,
    mode: 'connect' | 'reconnect'
  ): Promise<void> | null {
    ensureSingleSocketRelayConnectGuard(relay);
    ensureRelayAuthFailureListener(relay);
    if (!relay || relay.connected || relay.status !== NDKRelayStatus.DISCONNECTED) {
      return null;
    }

    const pendingConnectPromise = relayConnectPromises.get(normalizedRelayUrl);
    if (pendingConnectPromise) {
      return pendingConnectPromise;
    }

    const cooldownUntil = relayConnectFailureCooldownUntilByUrl.get(normalizedRelayUrl) ?? 0;
    if (cooldownUntil > Date.now()) {
      return null;
    }

    logDeveloperTrace(
      'info',
      'relay-connect',
      mode === 'reconnect' ? 'reconnecting configured relay' : 'connecting new explicit relay',
      {
        reason: 'ensureRelayConnections',
        ...buildRelaySnapshot(relay),
      }
    );

    const connectPromise = relay
      .connect(initialConnectTimeoutMs, false)
      .catch((error) => {
        relayConnectFailureCooldownUntilByUrl.set(
          normalizedRelayUrl,
          Date.now() + relayConnectFailureCooldownMs
        );
        console.warn(
          mode === 'reconnect' ? 'Failed to reconnect relay' : 'Failed to connect relay',
          normalizedRelayUrl,
          {
            cooldownMs: relayConnectFailureCooldownMs,
            error,
            relay: buildRelaySnapshot(relay),
          }
        );
      })
      .finally(() => {
        relayConnectPromises.delete(normalizedRelayUrl);
      });

    relayConnectPromises.set(normalizedRelayUrl, connectPromise);
    return connectPromise;
  }

  function isRelayConnected(relayUrl: string): boolean {
    const relay = ndk.pool.relays.get(relayUrl) ?? ndk.pool.getRelay(relayUrl, false);
    return Boolean(relay?.connected);
  }

  async function waitForFirstHealthyRelay(relayUrls: string[]): Promise<void> {
    if (relayUrls.length === 0) {
      return;
    }

    await waitForFirstReadyOrTimeout({
      isReady: () => relayUrls.some((relayUrl) => isRelayConnected(relayUrl)),
      timeoutMs: relayFirstHealthyWaitMs,
    });
  }

  async function ensureRelayConnections(relayUrls: string[]): Promise<void> {
    ensureRelayStatusListeners();

    const requestedRelayUrls: string[] = [];

    for (const relayUrl of relayUrls) {
      const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
      if (!normalizedRelayUrl) {
        continue;
      }

      requestedRelayUrls.push(normalizedRelayUrl);

      if (configuredRelayUrls.has(normalizedRelayUrl)) {
        const existingRelay = ndk.pool.getRelay(normalizedRelayUrl, false);
        connectRelayForEnsureRelayConnections(existingRelay, normalizedRelayUrl, 'reconnect');
        continue;
      }

      ndk.addExplicitRelay(normalizedRelayUrl, undefined, false);
      configuredRelayUrls.add(normalizedRelayUrl);
      const addedRelay = ndk.pool.getRelay(normalizedRelayUrl, false);
      connectRelayForEnsureRelayConnections(addedRelay, normalizedRelayUrl, 'connect');
      bumpRelayStatusVersion();
    }

    if (!getHasActivatedPool() && !getConnectPromise()) {
      setConnectPromise(
        ndk
          .connect(relayFirstHealthyWaitMs)
          .then(() => {
            setHasActivatedPool(true);
          })
          .finally(() => {
            setConnectPromise(null);
          })
      );
    }

    await waitForFirstHealthyRelay(requestedRelayUrls);
    setHasActivatedPool(true);
    bumpRelayStatusVersion();
  }

  function getRelayConnectionState(relayUrl: string): RelayConnectionState {
    const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
    const relay = ndk.pool.relays.get(normalizedRelayUrl);
    if (!relay) {
      return 'issue';
    }

    return relay.connected ? 'connected' : 'issue';
  }

  function isRelayConnectionPending(relayUrl: string): boolean {
    const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
    if (relayConnectPromises.has(normalizedRelayUrl)) {
      return true;
    }

    const relay = ndk.pool.relays.get(normalizedRelayUrl);
    return (
      relay?.status === NDKRelayStatus.RECONNECTING ||
      relay?.status === NDKRelayStatus.CONNECTING ||
      relay?.status === NDKRelayStatus.AUTH_REQUESTED ||
      relay?.status === NDKRelayStatus.AUTHENTICATING
    );
  }

  async function fetchRelayNip11Info(
    relayUrl: string,
    force = false
  ): Promise<NDKRelayInformation> {
    const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
    const relay = ndk.pool.getRelay(normalizedRelayUrl, false);
    return relay.fetchInfo(force);
  }

  return {
    ensureRelayConnections,
    fetchRelayNip11Info,
    getOrCreateSigner,
    getRelayConnectionState,
    isRelayConnectionPending,
  };
}
