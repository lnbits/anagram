import { contactsService } from '#src/services/contactsService.ts';
import { NostrPrivateKeySigner, NostrRelaySet, NostrRelayStatus } from '#src/lib/nostr/client.ts';
import { RELAY_PUBLISH_TIMEOUT_MS } from '#src/stores/nostr/constants.ts';
import { createRelayPublishRuntime } from '#src/stores/nostr/relayPublishRuntime.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

function createRuntime(
  options: {
    blockReasonByRelayUrl?: Map<string, string>;
    overrides?: Partial<Parameters<typeof createRelayPublishRuntime>[0]>;
  } = {},
) {
  const ndk = {};
  const runtime = createRelayPublishRuntime({
    prepareOutgoingPrivateMessage: vi.fn(async () => {}),
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
    ...options.overrides,
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

  it('orders rapid group profile updates after the restored profile timestamp', async () => {
    const signer = NostrPrivateKeySigner.generate();
    const restored = Math.floor(Date.now() / 1000) + 10;
    vi.spyOn(contactsService, 'init').mockResolvedValue();
    vi.spyOn(contactsService, 'getContactByPublicKey').mockResolvedValue({
      id: 1,
      public_key: signer.pubkey,
      type: 'group',
      name: 'Group',
      given_name: null,
      meta: {
        owner_public_key: 'a'.repeat(64),
        group_private_key_encrypted: 'encrypted',
        profile_event_created_at: restored,
        pinned: 'c'.repeat(64),
        pinned_created_at: 100,
      },
      relays: [{ url: 'wss://group.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    });
    const published: number[] = [];
    const profiles: Record<string, unknown>[] = [];
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([
        {
          status: NostrRelayStatus.CONNECTED,
          url: 'wss://group.example/',
          publish: async (event: { created_at: number; content: string }) => {
            profiles.push(JSON.parse(event.content));
            published.push(event.created_at);
            return true;
          },
        },
      ]),
    } as never);
    const { runtime } = createRuntime({
      overrides: {
        decryptGroupIdentitySecretContent: async () => ({
          version: 1,
          group_pubkey: signer.pubkey,
          group_privkey: signer.privateKey,
        }),
        resolveGroupPublishRelayUrls: () => ['wss://group.example/'],
      },
    });
    await runtime.publishGroupMetadata(signer.pubkey, { name: 'First' });
    await runtime.publishGroupMetadata(signer.pubkey, { name: 'Second' });
    expect(published).toEqual([restored + 1, restored + 2]);
    expect(profiles[1]).toMatchObject({ pinned: 'c'.repeat(64), pinned_created_at: 100 });
    await runtime.publishGroupMetadata(signer.pubkey, {
      name: 'Third',
      pinned: '',
      pinned_created_at: 0,
    });
    expect(profiles[2].pinned).toBe('');
  });

  it('lets call controls proceed after one ack while still publishing to every relay', async () => {
    const { runtime } = createRuntime();
    let rejectSlow!: (error: Error) => void;
    const fast = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const slow = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://slow.example/',
      publish: vi.fn(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            rejectSlow = reject;
          }),
      ),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([fast, slow]),
    } as never);
    const result = await runtime.publishEventWithRelayStatuses(
      { sig: 'signature' } as never,
      [fast.url, slow.url],
      'recipient',
      true,
    );
    expect(fast.publish).toHaveBeenCalledOnce();
    expect(slow.publish).toHaveBeenCalledOnce();
    expect(result.error).toBeNull();
    expect(result.relayStatuses).toEqual([
      expect.objectContaining({ relay_url: fast.url, status: 'published' }),
      expect.objectContaining({ relay_url: slow.url, status: 'pending' }),
    ]);
    rejectSlow(new Error('Late failure'));
    await Promise.resolve();
    expect(result.error).toBeNull();
  });

  it('still requires an acknowledgement for call controls when all relays reject', async () => {
    const { runtime } = createRuntime();
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([
        {
          status: NostrRelayStatus.CONNECTED,
          url: 'wss://no.example/',
          publish: async () => {
            throw new Error('rejected');
          },
        },
      ]),
    } as never);
    const result = await runtime.publishEventWithRelayStatuses(
      { sig: 'signature' } as never,
      ['wss://no.example/'],
      'recipient',
      true,
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.relayStatuses[0].status).toBe('failed');
  });

  it('waits for every connected relay to settle before finalizing publish statuses', async () => {
    const { runtime } = createRuntime();
    let acknowledgeSlowRelay: (success: boolean) => void = () => {
      throw new Error('Slow relay publish was not initialized.');
    };
    const fastRelay = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const slowRelay = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://slow.example/',
      publish: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            acknowledgeSlowRelay = resolve;
          }),
      ),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
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
        'recipient',
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
      ]),
    );
  });

  it('records another relay failure after the first relay acknowledges publish', async () => {
    const { runtime } = createRuntime();
    const fastRelay = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://fast.example/',
      publish: vi.fn(async () => true),
    };
    const rejectingRelay = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://rejecting.example/',
      publish: vi.fn(async () => {
        await Promise.resolve();
        throw new Error('Relay rejected the event.');
      }),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([fastRelay, rejectingRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://fast.example/', 'wss://rejecting.example/'],
      'recipient',
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
      ]),
    );
  });

  it('accepts a delayed relay acknowledgement before the publish deadline', async () => {
    const { runtime } = createRuntime();
    const delayedRelay = {
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://delayed.example/',
      publish: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            globalThis.setTimeout(() => resolve(true), 40);
          }),
      ),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([delayedRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      ['wss://delayed.example/'],
      'recipient',
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
      status: NostrRelayStatus.CONNECTED,
      url: 'wss://slow.example/',
      publish: vi.fn(() => new Promise<boolean>(() => {})),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
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
      'self',
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
      status: NostrRelayStatus.DISCONNECTED,
      url: 'wss://disconnected.example/',
      publish: vi.fn(async () => true),
    };
    vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
      relays: new Set([disconnectedRelay]),
    } as never);

    const result = await runtime.publishEventWithRelayStatuses(
      {
        ndk: {},
        sig: 'signature',
        sign: vi.fn(),
      } as never,
      [disconnectedRelay.url],
      'recipient',
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
      status: NostrRelayStatus.DISCONNECTED,
      url: relayUrl,
      publish: vi.fn(async () => true),
    };
    const relaySetSpy = vi.spyOn(NostrRelaySet, 'fromRelayUrls').mockReturnValue({
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
      'recipient',
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
