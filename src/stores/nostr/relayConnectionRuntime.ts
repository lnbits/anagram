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
  RelayConnectRetryState,
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
  relayConnectRetryBaseDelayMs: number;
  relayConnectRetryJitterRatio: number;
  relayConnectRetryMaxDelayMs: number;
  relayConnectRetryStateByUrl: Map<string, RelayConnectRetryState>;
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
  resetReconnectionState?: () => void;
  ws?: RelaySocketLike;
};

type GuardedRelay = NDKRelay & {
  __nostrChatCanConnect?: () => boolean;
  __nostrChatConnectPromise?: Promise<void> | null;
  __nostrChatOnConnectSuppressed?: () => void;
  __nostrChatPublishGuardInstalled?: boolean;
  __nostrChatSingleSocketGuardInstalled?: boolean;
};

export interface SingleSocketRelayConnectGuardOptions {
  canConnect?: () => boolean;
  onConnectSuppressed?: () => void;
}

function normalizeRelayClientUrl(value: string): string | null {
  try {
    return normalizeRelayUrl(value);
  } catch {
    return null;
  }
}

export function isUsableRelayClientUrl(value: string): boolean {
  const normalizedRelayUrl = normalizeRelayClientUrl(value);
  if (!normalizedRelayUrl) {
    return false;
  }

  try {
    const relayUrl = new URL(normalizedRelayUrl);
    return (
      (relayUrl.protocol === 'ws:' || relayUrl.protocol === 'wss:') &&
      relayUrl.hostname !== '0.0.0.0' &&
      relayUrl.hostname !== '[::]' &&
      relayUrl.hostname !== '::'
    );
  } catch {
    return false;
  }
}

export function calculateRelayConnectRetryDelayMs(options: {
  baseDelayMs: number;
  failureCount: number;
  jitterRatio: number;
  maxDelayMs: number;
  randomValue?: number;
}): number {
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs));
  const failureCount = Math.max(1, Math.floor(options.failureCount));
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio));
  const randomValue = Math.min(1, Math.max(0, options.randomValue ?? Math.random()));
  const exponentialDelayMs = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.min(30, failureCount - 1)
  );
  const jitterRangeMs = exponentialDelayMs * jitterRatio;
  const minimumDelayMs = Math.max(0, exponentialDelayMs - jitterRangeMs);
  const maximumDelayMs = Math.min(maxDelayMs, exponentialDelayMs + jitterRangeMs);

  return Math.round(minimumDelayMs + (maximumDelayMs - minimumDelayMs) * randomValue);
}

function cancelRelayAutoReconnect(relay: NDKRelay): void {
  const connectivity = relay.connectivity as unknown as RelayConnectivityState;
  connectivity.resetReconnectionState?.();
}

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

export function ensureSingleSocketRelayConnectGuard(
  relay: NDKRelay | null | undefined,
  options: SingleSocketRelayConnectGuardOptions = {}
): void {
  const guardedRelay = relay as GuardedRelay | null | undefined;
  if (!guardedRelay) {
    return;
  }

  guardedRelay.__nostrChatCanConnect = options.canConnect;
  guardedRelay.__nostrChatOnConnectSuppressed = options.onConnectSuppressed;
  cancelRelayAutoReconnect(relay);
  if (!guardedRelay.__nostrChatPublishGuardInstalled) {
    const originalPublish = relay.publish.bind(relay);
    guardedRelay.__nostrChatPublishGuardInstalled = true;
    guardedRelay.publish = ((event, timeoutMs) => {
      if (relay.status < NDKRelayStatus.CONNECTED) {
        return Promise.reject(new Error(`Relay ${relay.url} is not connected.`));
      }

      return originalPublish(event, timeoutMs);
    }) as typeof relay.publish;
  }
  if (guardedRelay.__nostrChatSingleSocketGuardInstalled) {
    return;
  }

  const originalConnect = relay.connect.bind(relay);
  guardedRelay.__nostrChatSingleSocketGuardInstalled = true;
  guardedRelay.__nostrChatConnectPromise = null;
  guardedRelay.connect = ((timeoutMs?: number) => {
    const connectivity = relay.connectivity as unknown as RelayConnectivityState;
    const existingPromise = guardedRelay.__nostrChatConnectPromise ?? null;
    const readyState = connectivity.ws?.readyState;

    if (readyState === RELAY_SOCKET_CONNECTING || readyState === RELAY_SOCKET_OPEN) {
      return existingPromise ?? Promise.resolve();
    }

    if (guardedRelay.__nostrChatCanConnect?.() === false) {
      guardedRelay.__nostrChatOnConnectSuppressed?.();
      return Promise.resolve();
    }

    if (readyState !== undefined && readyState !== RELAY_SOCKET_OPEN) {
      closeGuardedRelaySocket(relay, connectivity);
    }

    cancelRelayAutoReconnect(relay);
    const connectPromise = Promise.resolve(originalConnect(timeoutMs, false)).finally(() => {
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
  relayConnectRetryBaseDelayMs,
  relayConnectRetryJitterRatio,
  relayConnectRetryMaxDelayMs,
  relayConnectRetryStateByUrl,
  relayConnectPromises,
  queueOutboundMessageReplay,
  setCachedSigner,
  setCachedSignerSessionKey,
  setConnectPromise,
  setHasActivatedPool,
  setHasRelayStatusListeners,
}: RelayConnectionRuntimeDeps) {
  const previousRelayConnectionFilter = ndk.relayConnectionFilter;
  ndk.relayConnectionFilter = (relayUrl) => {
    return (
      isUsableRelayClientUrl(relayUrl) &&
      (previousRelayConnectionFilter ? previousRelayConnectionFilter(relayUrl) : true)
    );
  };

  function getRelayConnectionAttemptBlockReason(relayUrl: string): string | null {
    const normalizedRelayUrl = normalizeRelayClientUrl(relayUrl);
    if (!normalizedRelayUrl || !isUsableRelayClientUrl(normalizedRelayUrl)) {
      return 'Relay URL is not usable as a client destination.';
    }

    const relay = ndk.pool.relays.get(normalizedRelayUrl);
    if (relay?.connected) {
      return null;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'Relay connection is unavailable while the device is offline.';
    }

    const retryState = relayConnectRetryStateByUrl.get(normalizedRelayUrl);
    if (!retryState || retryState.nextAttemptAt <= Date.now()) {
      return null;
    }

    return `Relay connection retry is cooling down for ${Math.max(
      1,
      retryState.nextAttemptAt - Date.now()
    )}ms.`;
  }

  function clearRelayConnectRetryState(relayUrl: string): void {
    const normalizedRelayUrl = normalizeRelayClientUrl(relayUrl);
    if (normalizedRelayUrl) {
      relayConnectRetryStateByUrl.delete(normalizedRelayUrl);
    }
  }

  function recordRelayConnectFailure(relay: NDKRelay, error?: unknown): void {
    const normalizedRelayUrl = normalizeRelayClientUrl(relay.url);
    if (!normalizedRelayUrl) {
      return;
    }

    cancelRelayAutoReconnect(relay);
    const previousFailureCount =
      relayConnectRetryStateByUrl.get(normalizedRelayUrl)?.failureCount ?? 0;
    const failureCount = Math.min(31, previousFailureCount + 1);
    const retryDelayMs = calculateRelayConnectRetryDelayMs({
      baseDelayMs: relayConnectRetryBaseDelayMs,
      failureCount,
      jitterRatio: relayConnectRetryJitterRatio,
      maxDelayMs: relayConnectRetryMaxDelayMs,
    });
    const nextAttemptAt = Date.now() + retryDelayMs;
    relayConnectRetryStateByUrl.set(normalizedRelayUrl, {
      failureCount,
      nextAttemptAt,
    });
    logDeveloperTrace('warn', 'relay-connect', 'retry-backoff', {
      ...buildRelaySnapshot(relay),
      error,
      failureCount,
      nextAttemptAt: new Date(nextAttemptAt).toISOString(),
      retryDelayMs,
    });
  }

  function guardRelayConnection(relay: NDKRelay | null | undefined): void {
    if (!relay) {
      return;
    }

    ensureSingleSocketRelayConnectGuard(relay, {
      canConnect: () => getRelayConnectionAttemptBlockReason(relay.url) === null,
      onConnectSuppressed: () => {
        logDeveloperTrace('info', 'relay-connect', 'connect-suppressed', {
          ...buildRelaySnapshot(relay),
          reason: getRelayConnectionAttemptBlockReason(relay.url),
        });
      },
    });
  }

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

    for (const relay of ndk.pool.relays.values()) {
      guardRelayConnection(relay);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => {
        for (const relay of ndk.pool.relays.values()) {
          cancelRelayAutoReconnect(relay);
        }
      });
    }

    ndk.pool.on('relay:connecting', (relay) => {
      guardRelayConnection(relay);
      authenticatedRelayUrls.delete(relay.url);
      bumpRelayStatusVersion();
      logRelayLifecycle('connecting', relay);
    });
    ndk.pool.on('relay:connect', (relay) => {
      clearRelayConnectRetryState(relay.url);
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
      recordRelayConnectFailure(relay);
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
    guardRelayConnection(relay);
    ensureRelayAuthFailureListener(relay);
    if (!relay || relay.connected || relay.status !== NDKRelayStatus.DISCONNECTED) {
      return null;
    }

    const pendingConnectPromise = relayConnectPromises.get(normalizedRelayUrl);
    if (pendingConnectPromise) {
      return pendingConnectPromise;
    }

    const blockReason = getRelayConnectionAttemptBlockReason(normalizedRelayUrl);
    if (blockReason) {
      logDeveloperTrace('info', 'relay-connect', 'connect-skipped', {
        reason: blockReason,
        ...buildRelaySnapshot(relay),
      });
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
        recordRelayConnectFailure(relay, error);
        console.warn(
          mode === 'reconnect' ? 'Failed to reconnect relay' : 'Failed to connect relay',
          normalizedRelayUrl,
          {
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
      const normalizedRelayUrl = normalizeRelayClientUrl(relayUrl);
      if (!normalizedRelayUrl || !isUsableRelayClientUrl(normalizedRelayUrl)) {
        logDeveloperTrace('warn', 'relay-connect', 'invalid-client-relay-url', {
          relayUrl,
        });
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
    const normalizedRelayUrl = normalizeRelayClientUrl(relayUrl);
    if (!normalizedRelayUrl) {
      return 'issue';
    }
    const relay = ndk.pool.relays.get(normalizedRelayUrl);
    if (!relay) {
      return 'issue';
    }

    return relay.connected ? 'connected' : 'issue';
  }

  function isRelayConnectionPending(relayUrl: string): boolean {
    const normalizedRelayUrl = normalizeRelayClientUrl(relayUrl);
    if (!normalizedRelayUrl) {
      return false;
    }
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
    getRelayConnectionAttemptBlockReason,
    getOrCreateSigner,
    getRelayConnectionState,
    isRelayConnectionPending,
  };
}
