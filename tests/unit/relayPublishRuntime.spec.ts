import { NDKRelaySet } from '@nostr-dev-kit/ndk';
import { RELAY_PUBLISH_TIMEOUT_MS } from 'src/stores/nostr/constants';
import { createRelayPublishRuntime } from 'src/stores/nostr/relayPublishRuntime';
import { afterEach, describe, expect, it, vi } from 'vitest';

function createRuntime() {
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

  it('returns as soon as the first healthy relay acknowledges publish', async () => {
    const { runtime } = createRuntime();
    const fastRelay = {
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const slowRelay = {
      url: 'wss://slow.example/',
      publish: vi.fn(() => new Promise<boolean>(() => {})),
    };
    vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([fastRelay, slowRelay]),
    } as never);

    const startedAt = Date.now();
    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://fast.example/', 'wss://slow.example/'],
      'recipient'
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
    expect(result.error).toBeNull();
    expect(result.relayStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relay_url: 'wss://fast.example/',
          status: 'published',
        }),
        expect.objectContaining({
          relay_url: 'wss://slow.example/',
          status: 'failed',
        }),
      ])
    );
  });

  it('accepts a delayed relay acknowledgement before the publish deadline', async () => {
    const { runtime } = createRuntime();
    const delayedRelay = {
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
});
