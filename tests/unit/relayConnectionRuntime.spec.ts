import { NDKRelayStatus } from '@nostr-dev-kit/ndk';
import {
  calculateRelayConnectRetryDelayMs,
  createRelayConnectionRuntime,
  ensureSingleSocketRelayConnectGuard,
  isUsableRelayClientUrl,
} from 'src/stores/nostr/relayConnectionRuntime';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeSocket = {
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

type FakeRelay = {
  readonly status: NDKRelayStatus;
  url: string;
  connected: boolean;
  connectivity: {
    _status: NDKRelayStatus;
    connectTimeout: ReturnType<typeof globalThis.setTimeout> | null;
    resetReconnectionState: ReturnType<typeof vi.fn>;
    ws: FakeSocket | undefined;
  };
  connect: (timeoutMs?: number, reconnect?: boolean) => Promise<void>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  publish: (event: unknown, timeoutMs?: number) => Promise<boolean>;
};

function createFakeRelay(url = 'wss://relay.example/') {
  const connectivity = {
    _status: NDKRelayStatus.DISCONNECTED,
    connectTimeout: null as ReturnType<typeof globalThis.setTimeout> | null,
    resetReconnectionState: vi.fn(),
    ws: undefined as FakeSocket | undefined,
  };
  const rawConnect = vi.fn<(timeoutMs?: number, reconnect?: boolean) => Promise<void>>(
    async () => {}
  );
  const rawPublish = vi.fn(async () => true);
  const relay = {
    url,
    connected: false,
    connectivity,
    connect: ((timeoutMs?: number, reconnect = true) => rawConnect(timeoutMs, reconnect)) as (
      timeoutMs?: number,
      reconnect?: boolean
    ) => Promise<void>,
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    publish: rawPublish,
  } as unknown as FakeRelay;

  Object.defineProperty(relay, 'status', {
    configurable: true,
    get: () => connectivity._status,
  });

  return {
    connectivity,
    rawConnect,
    rawPublish,
    relay,
  };
}

function createRuntimeHarness(
  options: {
    hasActivatedPool?: boolean;
    isPrivateMessagesSubscriptionRelayTracked?: boolean;
    loggedInPublicKeyHex?: string | null;
  } = {}
) {
  const { connectivity, rawConnect, relay } = createFakeRelay();
  let hasActivatedPool = options.hasActivatedPool ?? true;
  let hasRelayStatusListeners = false;
  let connectPromise: Promise<void> | null = null;
  const configuredRelayUrls = new Set<string>();
  const relayConnectPromises = new Map<string, Promise<void>>();
  const relayConnectRetryStateByUrl = new Map<
    string,
    { failureCount: number; nextAttemptAt: number }
  >();
  const relayAuthFailureListenerUrls = new Set<string>();
  const queueOutboundMessageReplay = vi.fn();
  const queuePrivateMessagesWatchdog = vi.fn();
  const pool = {
    getRelay: vi.fn(() => relay),
    on: vi.fn(),
    relays: new Map([[relay.url, relay]]),
  };
  const ndk = {
    addExplicitRelay: vi.fn(() => relay),
    connect: vi.fn(async () => {}),
    pool,
    relayAuthDefaultPolicy: undefined,
    relayConnectionFilter: undefined,
  };

  const runtime = createRelayConnectionRuntime({
    authenticatedRelayUrls: new Set<string>(),
    buildRelaySnapshot: () => ({
      attempts: null,
      connected: false,
      connectedAt: null,
      lastDurationMs: null,
      nextReconnectAt: null,
      present: true,
      status: relay.status,
      statusName: 'DISCONNECTED',
      success: null,
      url: relay.url,
      validationRatio: null,
    }),
    bumpRelayStatusVersion: vi.fn(),
    configuredRelayUrls,
    getCachedSigner: () => null,
    getCachedSignerSessionKey: () => null,
    getConnectPromise: () => connectPromise,
    getHasActivatedPool: () => hasActivatedPool,
    getHasRelayStatusListeners: () => hasRelayStatusListeners,
    getLoggedInPublicKeyHex: () => options.loggedInPublicKeyHex ?? null,
    getNip46SignerPayload: () => null,
    loadPrivateKeyHex: async () => null,
    getStoredAuthMethod: () => null,
    hasNip07Extension: () => false,
    initialConnectTimeoutMs: 3000,
    relayFirstHealthyWaitMs: 80,
    isPrivateMessagesSubscriptionRelayTracked: () =>
      options.isPrivateMessagesSubscriptionRelayTracked ?? false,
    logDeveloperTrace: vi.fn(),
    logRelayLifecycle: vi.fn(),
    markPrivateMessagesWatchdogRelayDisconnected: vi.fn(),
    ndk: ndk as never,
    queueOutboundMessageReplay,
    queuePrivateMessagesWatchdog,
    relayAuthFailureListenerUrls,
    relayConnectRetryBaseDelayMs: 10000,
    relayConnectRetryJitterRatio: 0,
    relayConnectRetryMaxDelayMs: 300000,
    relayConnectRetryStateByUrl,
    relayConnectPromises,
    setCachedSigner: vi.fn(),
    setCachedSignerSessionKey: vi.fn(),
    setConnectPromise: (value) => {
      connectPromise = value;
    },
    setHasActivatedPool: (value) => {
      hasActivatedPool = value;
    },
    setHasRelayStatusListeners: (value) => {
      hasRelayStatusListeners = value;
    },
  });

  return {
    connectivity,
    configuredRelayUrls,
    ndk,
    pool,
    queuePrivateMessagesWatchdog,
    queueOutboundMessageReplay,
    rawConnect,
    relay,
    relayConnectPromises,
    relayConnectRetryStateByUrl,
    runtime,
  };
}

describe('relayConnectionRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the same in-flight connect promise while the socket is still connecting', async () => {
    const { connectivity, rawConnect, relay } = createFakeRelay();
    const pendingSocket = {
      close: vi.fn(),
      readyState: 0,
    };
    let resolveConnect: (() => void) | null = null;
    rawConnect.mockImplementation(() => {
      connectivity._status = NDKRelayStatus.CONNECTING;
      connectivity.ws = pendingSocket;

      return new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
    });

    ensureSingleSocketRelayConnectGuard(relay as never);

    const firstConnectPromise = relay.connect(1500, false);
    const secondConnectPromise = relay.connect(1500, false);

    expect(secondConnectPromise).toBe(firstConnectPromise);
    expect(rawConnect).toHaveBeenCalledTimes(1);
    expect(pendingSocket.close).not.toHaveBeenCalled();

    resolveConnect?.();
    await firstConnectPromise;
  });

  it('closes stale closed sockets before opening a fresh connection attempt', async () => {
    const { connectivity, rawConnect, relay } = createFakeRelay();
    const staleSocket = {
      close: vi.fn(),
      readyState: 3,
    };
    connectivity.ws = staleSocket;
    connectivity.connectTimeout = globalThis.setTimeout(() => {}, 1000);
    rawConnect.mockResolvedValue(undefined);

    ensureSingleSocketRelayConnectGuard(relay as never);

    await relay.connect(2500, false);

    expect(staleSocket.close).toHaveBeenCalledTimes(1);
    expect(connectivity.connectTimeout).toBeNull();
    expect(rawConnect).toHaveBeenCalledWith(2500, false);
  });

  it('uses guarded non-auto-retrying connects when ensuring relay connections', async () => {
    const { ndk, rawConnect, runtime } = createRuntimeHarness();
    rawConnect.mockResolvedValue(undefined);

    await runtime.ensureRelayConnections(['wss://relay.example']);

    expect(ndk.addExplicitRelay).toHaveBeenCalledWith('wss://relay.example/', undefined, false);
    expect(rawConnect).toHaveBeenCalledWith(3000, false);
  });

  it('forces NDK-initiated connect calls to use the app-owned no-auto-retry policy', async () => {
    const { rawConnect, relay } = createFakeRelay();

    ensureSingleSocketRelayConnectGuard(relay as never);
    await relay.connect(2500, true);

    expect(rawConnect).toHaveBeenCalledWith(2500, false);
  });

  it('prevents NDK publish calls from initiating disconnected relay connections', async () => {
    const { connectivity, rawPublish, relay } = createFakeRelay();
    ensureSingleSocketRelayConnectGuard(relay as never);

    await expect(relay.publish({}, 2500)).rejects.toThrow('is not connected');
    expect(rawPublish).not.toHaveBeenCalled();

    connectivity._status = NDKRelayStatus.CONNECTED;
    await expect(relay.publish({}, 2500)).resolves.toBe(true);
    expect(rawPublish).toHaveBeenCalledWith({}, 2500);
  });

  it('records WebSocket disconnects and suppresses attempts until backoff expires', async () => {
    const { connectivity, pool, rawConnect, relay, relayConnectRetryStateByUrl, runtime } =
      createRuntimeHarness();

    await runtime.ensureRelayConnections(['wss://relay.example']);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const relayDisconnectHandler = pool.on.mock.calls.find(
      ([eventName]) => eventName === 'relay:disconnect'
    )?.[1] as ((nextRelay: FakeRelay) => void) | undefined;

    expect(relayDisconnectHandler).toBeTypeOf('function');
    connectivity._status = NDKRelayStatus.DISCONNECTED;
    relayDisconnectHandler?.(relay);

    expect(connectivity.resetReconnectionState).toHaveBeenCalled();
    expect(relayConnectRetryStateByUrl.get('wss://relay.example/')).toEqual({
      failureCount: 1,
      nextAttemptAt: 11000,
    });

    await relay.connect(3000, true);
    expect(rawConnect).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(11000);
    await relay.connect(3000, true);
    expect(rawConnect).toHaveBeenCalledTimes(2);
    expect(rawConnect).toHaveBeenLastCalledWith(3000, false);
  });

  it('clears relay retry backoff after a successful connection', async () => {
    const { pool, relay, relayConnectRetryStateByUrl, runtime } = createRuntimeHarness();
    relayConnectRetryStateByUrl.set(relay.url, {
      failureCount: 3,
      nextAttemptAt: Date.now() + 40000,
    });
    await runtime.ensureRelayConnections([]);
    const relayConnectHandler = pool.on.mock.calls.find(
      ([eventName]) => eventName === 'relay:connect'
    )?.[1] as ((nextRelay: FakeRelay) => void) | undefined;

    relay.connected = true;
    relayConnectHandler?.(relay);

    expect(relayConnectRetryStateByUrl.has(relay.url)).toBe(false);
  });

  it('rejects unspecified-address relay URLs as client destinations', async () => {
    const { ndk, rawConnect, runtime } = createRuntimeHarness();

    await runtime.ensureRelayConnections(['ws://0.0.0.0:7002']);

    expect(ndk.addExplicitRelay).not.toHaveBeenCalled();
    expect(rawConnect).not.toHaveBeenCalled();
    expect(ndk.relayConnectionFilter?.('ws://0.0.0.0:7002')).toBe(false);
    expect(ndk.relayConnectionFilter?.('ws://127.0.0.1:7002')).toBe(true);
  });

  it('reports pending relay connection checks while a relay is connecting or authenticating', () => {
    const { connectivity, relayConnectPromises, runtime } = createRuntimeHarness();

    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(false);

    relayConnectPromises.set('wss://relay.example/', Promise.resolve());
    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(true);

    relayConnectPromises.clear();
    connectivity._status = NDKRelayStatus.CONNECTING;
    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(true);

    connectivity._status = NDKRelayStatus.RECONNECTING;
    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(true);

    connectivity._status = NDKRelayStatus.AUTHENTICATING;
    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(true);

    connectivity._status = NDKRelayStatus.CONNECTED;
    expect(runtime.isRelayConnectionPending('wss://relay.example')).toBe(false);
  });

  it('queues only the watchdog when a tracked private-message relay connects', async () => {
    const { pool, queuePrivateMessagesWatchdog, queueOutboundMessageReplay, relay, runtime } =
      createRuntimeHarness({
        isPrivateMessagesSubscriptionRelayTracked: true,
        loggedInPublicKeyHex: 'f'.repeat(64),
      });

    await runtime.ensureRelayConnections(['wss://relay.example']);
    const relayConnectHandler = pool.on.mock.calls.find(
      ([eventName]) => eventName === 'relay:connect'
    )?.[1] as ((nextRelay: FakeRelay) => void) | undefined;

    expect(relayConnectHandler).toBeTypeOf('function');
    relayConnectHandler?.(relay);

    expect(queueOutboundMessageReplay).toHaveBeenCalledTimes(1);
    expect(queuePrivateMessagesWatchdog).toHaveBeenCalledWith(0);
  });

  it('becomes usable as soon as the first requested relay connects', async () => {
    const { rawConnect, relay, runtime } = createRuntimeHarness({
      hasActivatedPool: false,
    });
    rawConnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          globalThis.setTimeout(() => {
            relay.connected = true;
            resolve();
          }, 20);
        })
    );

    const startedAt = Date.now();
    await runtime.ensureRelayConnections(['wss://relay.example', 'wss://slow.example']);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(200);
    expect(relay.connected).toBe(true);
  });

  it('does not wait for a hanging relay when another requested relay is already healthy', async () => {
    const { ndk, rawConnect, relay, runtime } = createRuntimeHarness();
    relay.connected = true;
    rawConnect.mockImplementation(() => new Promise(() => {}));
    ndk.connect = vi.fn(() => new Promise(() => {}));

    const startedAt = Date.now();
    await runtime.ensureRelayConnections(['wss://relay.example', 'wss://slow.example']);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
  });

  it('abandons slow relays within the first-healthy wait instead of blocking on pool connect', async () => {
    const { ndk, rawConnect, runtime } = createRuntimeHarness({
      hasActivatedPool: false,
    });
    rawConnect.mockImplementation(() => new Promise(() => {}));
    ndk.connect = vi.fn(() => new Promise(() => {}));

    const startedAt = Date.now();
    await runtime.ensureRelayConnections(['wss://relay.example', 'wss://slow.example']);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(80);
    expect(elapsedMs).toBeLessThan(500);
    expect(ndk.connect).toHaveBeenCalled();
  });
});

describe('relay retry helpers', () => {
  it('uses capped exponential backoff with bounded jitter', () => {
    expect(
      calculateRelayConnectRetryDelayMs({
        baseDelayMs: 10000,
        failureCount: 1,
        jitterRatio: 0.2,
        maxDelayMs: 300000,
        randomValue: 0,
      })
    ).toBe(8000);
    expect(
      calculateRelayConnectRetryDelayMs({
        baseDelayMs: 10000,
        failureCount: 3,
        jitterRatio: 0.2,
        maxDelayMs: 300000,
        randomValue: 1,
      })
    ).toBe(48000);
    expect(
      calculateRelayConnectRetryDelayMs({
        baseDelayMs: 10000,
        failureCount: 10,
        jitterRatio: 0.2,
        maxDelayMs: 300000,
        randomValue: 1,
      })
    ).toBe(300000);
  });

  it('accepts loopback relays but rejects unspecified client addresses', () => {
    expect(isUsableRelayClientUrl('ws://127.0.0.1:7002')).toBe(true);
    expect(isUsableRelayClientUrl('ws://localhost:7002')).toBe(true);
    expect(isUsableRelayClientUrl('ws://0.0.0.0:7002')).toBe(false);
    expect(isUsableRelayClientUrl('ws://[::]:7002')).toBe(false);
  });
});
