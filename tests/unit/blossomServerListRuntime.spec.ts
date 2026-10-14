import NostrClient, { ClientEvent, NostrKind } from '#src/lib/nostr/client.ts';
import { createBlossomServerListRuntime } from '#src/stores/nostr/blossomServerListRuntime.ts';
import { describe, expect, it, vi } from 'vitest';

const LOGGED_IN_PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);
const RELAY_URL = 'wss://relay.example.com';
const PUBLISHED_SERVERS = ['https://blossom.example.com', 'https://cdn.example.com'];

interface HarnessOptions {
  owner?: string | null;
  relayUrls?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  const ndk = new NostrClient();
  let owner = options.owner === undefined ? LOGGED_IN_PUBKEY : options.owner;
  const relayUrls = options.relayUrls ?? [RELAY_URL];
  const logSubscription = vi.fn();
  const onBlossomServerListApplied = vi.fn();
  const ensureRelayConnections = vi.fn(async () => {});
  const getLoggedInSignerUser = vi.fn(async () => ({ pubkey: owner ?? LOGGED_IN_PUBKEY }));
  const requestedSubscriptions: Array<{
    filters: unknown;
    stop: () => void;
    options: {
      onEvent?: (event: ClientEvent) => void;
      onEose?: () => void;
    };
  }> = [];
  const subscribeWithReqLogging = vi.fn(
    (
      _label: string,
      _requestLabel: string,
      filters: unknown,
      subscriptionOptions: {
        onEvent?: (event: ClientEvent) => void;
        onEose?: () => void;
        onClose?: () => void;
      },
    ) => {
      const stop = vi.fn();
      requestedSubscriptions.push({ filters, stop, options: subscriptionOptions });
      return { stop } as never;
    },
  );
  const runtime = createBlossomServerListRuntime({
    buildSubscriptionRelayDetails: (urls) => ({ relayUrls: urls }),
    ensureRelayConnections,
    getLoggedInPublicKeyHex: () => owner,
    getLoggedInSignerUser,
    logSubscription,
    ndk,
    onBlossomServerListApplied,
    resolveLoggedInReadRelayUrls: async () => relayUrls,
    subscribeWithReqLogging,
  });

  return {
    ensureRelayConnections,
    logSubscription,
    ndk,
    onBlossomServerListApplied,
    requestedSubscriptions,
    runtime,
    setOwner: (value: string | null) => {
      owner = value;
    },
    subscribeWithReqLogging,
  };
}

function createServerListEvent(
  ndk: NostrClient,
  {
    pubkey = LOGGED_IN_PUBKEY,
    createdAt = 1_700_000_000,
    id = 'event-a',
    kind = NostrKind.BlossomServerList,
    servers = PUBLISHED_SERVERS,
  }: {
    pubkey?: string;
    createdAt?: number;
    id?: string;
    kind?: number;
    servers?: string[];
  } = {},
) {
  return new ClientEvent(ndk, {
    id,
    kind,
    pubkey,
    created_at: createdAt,
    content: '',
    tags: servers.map((server) => ['server', server]),
  });
}

describe('Blossom server list runtime', () => {
  it('subscribes to the logged-in account list and exposes the published servers', async () => {
    const { ndk, requestedSubscriptions, runtime, subscribeWithReqLogging } = createHarness();

    await runtime.subscribeMyBlossomServerListUpdates();

    expect(subscribeWithReqLogging).toHaveBeenCalledTimes(1);
    expect(requestedSubscriptions[0]?.filters).toEqual([
      { kinds: [NostrKind.BlossomServerList], authors: [LOGGED_IN_PUBKEY], limit: 1 },
    ]);
    expect(runtime.getBlossomServerUrls()).toEqual([]);

    requestedSubscriptions[0]?.options.onEvent?.(createServerListEvent(ndk));
    await vi.waitFor(() => {
      expect(runtime.getBlossomServerUrls()).toEqual(PUBLISHED_SERVERS);
    });
  });

  it('keeps the newest published list when an older one arrives late', async () => {
    const { ndk, runtime } = createHarness();

    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, {
        createdAt: 1_700_000_100,
        id: 'event-newer',
        servers: ['https://newer.example.com'],
      }),
    );
    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, {
        createdAt: 1_700_000_000,
        id: 'event-older',
        servers: ['https://older.example.com'],
      }),
    );

    expect(runtime.getBlossomServerUrls()).toEqual(['https://newer.example.com']);
  });

  it('keeps a replacement published in the same second as the list it replaces', async () => {
    const { ndk, runtime } = createHarness();

    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, { createdAt: 1_700_000_100, id: 'event-a' }),
    );
    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, {
        createdAt: 1_700_000_100,
        id: 'event-b',
        servers: ['https://same-second.example.com'],
      }),
    );

    expect(runtime.getBlossomServerUrls()).toEqual(['https://same-second.example.com']);
  });

  it('notifies listeners only when the applied list changes', async () => {
    const { ndk, onBlossomServerListApplied, runtime } = createHarness();

    await runtime.applyBlossomServerListEvent(createServerListEvent(ndk));
    expect(onBlossomServerListApplied).toHaveBeenCalledWith(PUBLISHED_SERVERS);

    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, { createdAt: 1_700_000_100, id: 'event-b' }),
    );
    expect(onBlossomServerListApplied).toHaveBeenCalledTimes(1);

    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, {
        createdAt: 1_700_000_200,
        id: 'event-c',
        servers: ['https://only.example.com'],
      }),
    );
    expect(onBlossomServerListApplied).toHaveBeenCalledTimes(2);
    expect(onBlossomServerListApplied).toHaveBeenLastCalledWith(['https://only.example.com']);
  });

  it('ignores another author and another kind', async () => {
    const { ndk, runtime } = createHarness();

    await runtime.applyBlossomServerListEvent(createServerListEvent(ndk, { pubkey: OTHER_PUBKEY }));
    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, { kind: NostrKind.RelayList }),
    );

    expect(runtime.getBlossomServerUrls()).toEqual([]);
  });

  it('drops the cached list when the account changes', async () => {
    const { ndk, runtime, setOwner } = createHarness();

    await runtime.applyBlossomServerListEvent(createServerListEvent(ndk));
    expect(runtime.getBlossomServerUrls()).toEqual(PUBLISHED_SERVERS);

    setOwner(OTHER_PUBKEY);
    expect(runtime.getBlossomServerUrls()).toEqual([]);
  });

  it('reports an empty list when the published list has no usable server', async () => {
    const { ndk, runtime } = createHarness();

    await runtime.applyBlossomServerListEvent(
      createServerListEvent(ndk, { servers: ['http://insecure.example.com'] }),
    );

    expect(runtime.getBlossomServerUrls()).toEqual([]);
  });

  it('does not subscribe without a logged-in account', async () => {
    const { requestedSubscriptions, runtime, subscribeWithReqLogging } = createHarness({
      owner: null,
    });

    await runtime.subscribeMyBlossomServerListUpdates();

    expect(subscribeWithReqLogging).not.toHaveBeenCalled();
    expect(requestedSubscriptions).toEqual([]);
    expect(runtime.getBlossomServerUrls()).toEqual([]);
  });

  it('stops the subscription and forgets the list on reset', async () => {
    const { ndk, requestedSubscriptions, runtime } = createHarness();

    await runtime.subscribeMyBlossomServerListUpdates();
    await runtime.applyBlossomServerListEvent(createServerListEvent(ndk));
    expect(runtime.getBlossomServerUrls()).toEqual(PUBLISHED_SERVERS);

    runtime.resetBlossomServerListRuntimeState('clear-private-key');

    expect(requestedSubscriptions[0]?.stop).toHaveBeenCalled();
    expect(runtime.getBlossomServerUrls()).toEqual([]);
  });
});
