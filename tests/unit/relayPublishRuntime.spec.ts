import { NDKRelaySet, NDKRelayStatus } from '@nostr-dev-kit/ndk';
import { RELAY_PUBLISH_TIMEOUT_MS } from 'src/stores/nostr/constants';
import { createRelayPublishRuntime } from 'src/stores/nostr/relayPublishRuntime';
import { afterEach, describe, expect, it, vi } from 'vitest';

function createRuntime(options: { blockReasonByRelayUrl?: Map<string, string> } = {}) {
  const ndk = {};
  const runtime = createRelayPublishRuntime({
    appendRelayStatusesToMessageEvent: vi.fn(async () => {}),
    buildRelaySaveStatus: vi.fn(() => ({
      errorMessage: null,
      failedRelayUrls: [],
      publishedRelayUrls: [],
      relayUrls: [],
    })),
    decryptGroupIdentitySecretContent: vi.fn(async () => null),
    ensureRelayConnections: vi.fn(async () => {}),
    getRelayConnectionAttemptBlockReason: (relayUrl) =>
      options.blockReasonByRelayUrl?.get(relayUrl) ?? null,
    getLoggedInPublicKeyHex: () => 'a'.repeat(64),
    getOrCreateSigner: vi.fn(async () => ({}) as never),
    ndk: ndk as never,
    normalizeEventId: (value) => (typeof value === 'string' ? value : null),
    normalizeRelayStatusUrl: (value) => (value.endsWith('/') ? value : `${value}/`),
    normalizeRelayStatusUrls: (relayUrls) =>
      relayUrls.map((relayUrl) => (relayUrl.endsWith('/') ? relayUrl : `${relayUrl}/`)),
    resolveGroupPublishRelayUrls: vi.fn(() => []),
    resolveLoggedInPublishRelayUrls: vi.fn(async () => []),
    toStoredNostrEvent: vi.fn(async () => null),
    toUnixTimestamp: () => Math.floor(Date.now() / 1000),
    updateStoredEventSinceFromCreatedAt: vi.fn(),
  });

  return {
    ndk,
    runtime,
  };
}

describe('relayPublishRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for every connected relay to settle before finalizing publish statuses', async () => {
    const { runtime } = createRuntime();
    let acknowledgeSlowRelay: (success: boolean) => void = () => {
      throw new Error('Slow relay publish was not initialized.');
    };
    const fastRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const slowRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://slow.example/',
      publish: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            acknowledgeSlowRelay = resolve;
          })
      ),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([fastRelay, slowRelay]),
    } as never);

    let publishSettled = false;
    const resultPromise = runtime
      .publishEventWithRelayStatuses(
        {
          ndk: {},
          sig: 'signature',
          sign: vi.fn(),
        } as never,
        ['wss://fast.example/', 'wss://slow.example/'],
        'recipient'
      )
      .finally(() => {
        publishSettled = true;
      });

    await vi.waitFor(() => {
      expect(fastRelay.publish).toHaveBeenCalledOnce();
      expect(slowRelay.publish).toHaveBeenCalledOnce();
    });
    expect(publishSettled).toBe(false);

    acknowledgeSlowRelay(true);
    const result = await resultPromise;

    expect(result.error).toBeNull();
    expect(result.relayStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relay_url: 'wss://fast.example/',
          status: 'published',
        }),
        expect.objectContaining({
          relay_url: 'wss://slow.example/',
          status: 'published',
        }),
      ])
    );
  });

  it('records another relay failure after the first relay acknowledges publish', async () => {
    const { runtime } = createRuntime();
    const fastRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const rejectingRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://rejecting.example/',
      publish: vi.fn(async () => {
        await Promise.resolve();
        throw new Error('Relay rejected the event.');
      }),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([fastRelay, rejectingRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://fast.example/', 'wss://rejecting.example/'],
      'recipient'
    );

    expect(result.error).toBeNull();
    expect(result.relayStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relay_url: 'wss://fast.example/',
          status: 'published',
        }),
        expect.objectContaining({
          detail: 'Relay rejected the event.',
          relay_url: 'wss://rejecting.example/',
          status: 'failed',
        }),
      ])
    );
  });

  it('accepts a delayed relay acknowledgement before the publish deadline', async () => {
    const { runtime } = createRuntime();
    const delayedRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://delayed.example/',
      publish: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            globalThis.setTimeout(() => resolve(true), 40);
          })
      ),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([delayedRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://delayed.example/'],
      'recipient'
    );

    expect(result.error).toBeNull();
    expect(result.relayStatuses).toEqual([
      expect.objectContaining({
        relay_url: 'wss://delayed.example/',
        status: 'published',
      }),
    ]);
  });

  it('times out hung relays instead of blocking the publish path', async () => {
    const { runtime } = createRuntime();
    const slowRelay = {
      status: NDKRelayStatus.CONNECTED,
      url: 'wss://slow.example/',
      publish: vi.fn(() => new Promise<boolean>(() => {})),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([slowRelay]),
    } as never);

    const startedAt = Date.now();
    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://slow.example/'],
      'self'
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(RELAY_PUBLISH_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(RELAY_PUBLISH_TIMEOUT_MS + 400);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.relayStatuses).toEqual([
      expect.objectContaining({
        relay_url: 'wss://slow.example/',
        status: 'failed',
        detail: `Publish timeout after ${RELAY_PUBLISH_TIMEOUT_MS}ms`,
      }),
    ]);
  });

  it('does not let publishing initiate a connection to a disconnected relay', async () => {
    const { runtime } = createRuntime();
    const disconnectedRelay = {
      status: NDKRelayStatus.DISCONNECTED,
      url: 'wss://disconnected.example/',
      publish: vi.fn(async () => true),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([disconnectedRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      [disconnectedRelay.url],
      'recipient'
    );

    expect(disconnectedRelay.publish).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.relayStatuses).toEqual([
      expect.objectContaining({
        detail: 'Relay is not connected.',
        relay_url: disconnectedRelay.url,
        status: 'failed',
      }),
    ]);
  });

  it('skips publishing to relays whose connection retry is cooling down', async () => {
    const relayUrl = 'wss://cooling-down.example/';
    const blockReason = 'Relay connection retry is cooling down for 9000ms.';
    const { runtime } = createRuntime({
      blockReasonByRelayUrl: new Map([[relayUrl, blockReason]]),
    });
    const cooledRelay = {
      status: NDKRelayStatus.DISCONNECTED,
      url: relayUrl,
      publish: vi.fn(async () => true),
    };
    const relaySetSpy = vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set(),
    } as never);

    const startedAt = Date.now();
    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      [relayUrl],
      'recipient'
    );

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(relaySetSpy).toHaveBeenCalledWith([], expect.anything(), false);
    expect(cooledRelay.publish).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.relayStatuses).toEqual([
      expect.objectContaining({
        detail: blockReason,
        relay_url: relayUrl,
        status: 'failed',
      }),
    ]);
  });
});
