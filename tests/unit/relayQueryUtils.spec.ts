import { NDKRelaySet } from '@nostr-dev-kit/ndk';
import {
  createReadyRelaySet,
  fetchEventsWithRelayTimeout,
  fetchEventWithRelayTimeout,
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

  it('skips fetchEvent when no relays are ready', async () => {
    const ndk = {
      fetchEvent: vi.fn(() => new Promise(() => {})),
    };

    const startedAt = Date.now();
    const result = await fetchEventWithRelayTimeout(
      ndk as never,
      { kinds: [0] },
      undefined,
      null,
      40
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBeNull();
    expect(ndk.fetchEvent).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(50);
  });

  it('returns fetchEvent results without waiting on a hanging query', async () => {
    const ndk = {
      fetchEvent: vi.fn(() => new Promise(() => {})),
    };

    const startedAt = Date.now();
    const result = await fetchEventWithRelayTimeout(
      ndk as never,
      { kinds: [0] },
      undefined,
      { size: 1 } as never,
      40
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(250);
  });

  it('returns fetchEvents results without waiting on a hanging query', async () => {
    const ndk = {
      fetchEvents: vi.fn(() => new Promise(() => {})),
    };

    const startedAt = Date.now();
    const result = await fetchEventsWithRelayTimeout(
      ndk as never,
      { kinds: [0] },
      undefined,
      { size: 1 } as never,
      40
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.size).toBe(0);
    expect(elapsedMs).toBeLessThan(250);
  });
});
