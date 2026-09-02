import { NDKRelaySet } from '@nostr-dev-kit/ndk';
import {
  createReadyRelaySet,
  fetchEventsWithRelayTimeout,
  fetchEventWithRelayTimeout,
  RelayQueryTimeoutError,
  RelayQueryUnavailableError,
} from 'src/stores/nostr/relayQueryUtils';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('relayQueryUtils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a relay set from currently connected relays only', () => {
    const fromRelayUrls = vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({} as never);
    const ndk = {
      pool: {
        relays: new Map([
          ['wss://fast.example/', { connected: true }],
          ['wss://slow.example/', { connected: false }],
        ]),
        getRelay: vi.fn(),
      },
    };

    createReadyRelaySet(ndk as never, ['wss://fast.example/', 'wss://slow.example/']);

    expect(fromRelayUrls).toHaveBeenCalledWith(['wss://fast.example/'], ndk, false);
  });

  it('does not query disconnected relays when the pool is already known', () => {
    const fromRelayUrls = vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({} as never);
    const ndk = {
      pool: {
        relays: new Map([['wss://slow.example/', { connected: false }]]),
        getRelay: vi.fn(),
      },
    };

    expect(createReadyRelaySet(ndk as never, ['wss://slow.example/'])).toBeNull();
    expect(fromRelayUrls).not.toHaveBeenCalled();
  });

  it('rejects without starting a query when no relays are ready', async () => {
    const ndk = {
      subscribe: vi.fn(),
    };

    await expect(
      fetchEventWithRelayTimeout(ndk as never, { kinds: [0] }, undefined, null, 40)
    ).rejects.toBeInstanceOf(RelayQueryUnavailableError);
    expect(ndk.subscribe).not.toHaveBeenCalled();
  });

  it('stops a hanging fetchEvent subscription and reports a timeout', async () => {
    const stop = vi.fn();
    const ndk = {
      subscribe: vi.fn(() => ({ stop })),
    };

    const startedAt = Date.now();
    await expect(
      fetchEventWithRelayTimeout(ndk as never, { kinds: [0] }, undefined, { size: 1 } as never, 40)
    ).rejects.toBeInstanceOf(RelayQueryTimeoutError);
    const elapsedMs = Date.now() - startedAt;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('returns the newest fetchEvent result after EOSE', async () => {
    const stop = vi.fn();
    const olderEvent = {
      created_at: 10,
      deduplicationKey: () => 'kind:author',
    };
    const newerEvent = {
      created_at: 20,
      deduplicationKey: () => 'kind:author',
    };
    const ndk = {
      subscribe: vi.fn((_filters, options) => {
        const subscription = { stop };
        queueMicrotask(() => {
          options.onEvent?.(olderEvent);
          options.onEvent?.(newerEvent);
          options.onEose?.(subscription);
        });
        return subscription;
      }),
    };

    await expect(
      fetchEventWithRelayTimeout(ndk as never, { kinds: [0] }, undefined, { size: 1 } as never, 200)
    ).resolves.toBe(newerEvent);
    expect(stop).not.toHaveBeenCalled();
  });

  it('returns an authoritative empty fetchEvents result after EOSE', async () => {
    const ndk = {
      subscribe: vi.fn((_filters, options) => {
        const subscription = { stop: vi.fn() };
        queueMicrotask(() => {
          options.onEose?.(subscription);
        });
        return subscription;
      }),
    };

    const result = await fetchEventsWithRelayTimeout(
      ndk as never,
      { kinds: [0] },
      undefined,
      { size: 1 } as never,
      200
    );

    expect(result.size).toBe(0);
  });

  it('does not return partial fetchEvents results when EOSE never arrives', async () => {
    const stop = vi.fn();
    const ndk = {
      subscribe: vi.fn((_filters, options) => {
        options.onEvent?.({
          created_at: 10,
          deduplicationKey: () => 'kind:author',
        });
        return { stop };
      }),
    };

    const startedAt = Date.now();
    await expect(
      fetchEventsWithRelayTimeout(ndk as never, { kinds: [0] }, undefined, { size: 1 } as never, 40)
    ).rejects.toBeInstanceOf(RelayQueryTimeoutError);
    const elapsedMs = Date.now() - startedAt;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(250);
  });
});
