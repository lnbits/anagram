import NostrClient, { ClientEvent, NostrKind, normalizeRelayUrl } from '#src/lib/nostr/client.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contactsServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getContactByPublicKey: vi.fn(async () => null),
}));

vi.mock('#src/services/contactsService.ts', () => ({
  contactsService: contactsServiceMock,
}));

import { createBlobMediaRecoveryRuntime } from '#src/stores/nostr/blobMediaRecoveryRuntime.ts';

const AUTHOR = 'a'.repeat(64);
const LOGGED_IN = 'f'.repeat(64);
const CONTACT_RELAY = 'wss://contact-relay.example.com/';
const OUR_RELAY = 'wss://our-relay.example.com/';
const DEAD_SERVER = 'https://dead.example.com';
const GOOD_SERVER = 'https://good.example.com';
const IMAGE_BYTES = new TextEncoder().encode('recoverable image bytes');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface HarnessOptions {
  loggedInPublicKey?: string | null;
  rejectQuery?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const ndk = new NostrClient();
  Object.defineProperty(ndk, 'subscribe', { configurable: true, value: undefined });
  // A query needs a connected relay, exactly as the app has after connecting.
  const connectionStatus = new Map<string, boolean>();
  vi.spyOn(ndk.transport, 'listConnectionStatus').mockReturnValue(connectionStatus);
  const fetchEvent = vi.spyOn(ndk, 'fetchEvent').mockImplementation(async () => {
    if (options.rejectQuery) throw new Error('relay unavailable');
    return null;
  });
  const ensureRelayConnections = vi.fn(async (relayUrls: string[]) => {
    for (const relayUrl of relayUrls) {
      connectionStatus.set(normalizeRelayUrl(relayUrl), true);
    }
  });
  const resolveLoggedInReadRelayUrls = vi.fn(async () => [OUR_RELAY]);
  const runtime = createBlobMediaRecoveryRuntime({
    ensureRelayConnections,
    getLoggedInPublicKeyHex: () =>
      'loggedInPublicKey' in options ? options.loggedInPublicKey : LOGGED_IN,
    ndk,
    resolveLoggedInReadRelayUrls,
  });

  return { ensureRelayConnections, fetchEvent, ndk, runtime };
}

function createServerListEvent(servers: string[], ndk: NostrClient): ClientEvent {
  return new ClientEvent(ndk, {
    id: 'server-list',
    kind: NostrKind.BlossomServerList,
    pubkey: AUTHOR,
    created_at: 1_700_000_000,
    content: '',
    tags: servers.map((server) => ['server', server]),
  });
}

describe('blob media recovery runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contactsServiceMock.init.mockResolvedValue(undefined);
    contactsServiceMock.getContactByPublicKey.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the author published server list from their relays, ours and the metadata indexers', async () => {
    contactsServiceMock.getContactByPublicKey.mockResolvedValue({
      relays: [
        { url: CONTACT_RELAY, read: true, write: true },
        { url: 'wss://their-outbox.example.com', read: false, write: true },
      ],
    });
    const { ensureRelayConnections, fetchEvent, ndk, runtime } = createHarness({
      serverListEvent: null,
    });
    fetchEvent.mockResolvedValue(createServerListEvent([GOOD_SERVER], ndk));

    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([GOOD_SERVER]);

    expect(fetchEvent).toHaveBeenCalledTimes(1);
    const [filters, , relaySet] = fetchEvent.mock.calls[0] as unknown as [
      { kinds: number[]; authors: string[]; limit: number },
      unknown,
      { relayUrls: string[] },
    ];
    expect(filters).toEqual({ kinds: [NostrKind.BlossomServerList], authors: [AUTHOR], limit: 1 });
    expect(relaySet.relayUrls).toEqual([
      CONTACT_RELAY,
      OUR_RELAY,
      'wss://purplepag.es/',
      'wss://indexer.coracle.social/',
      'wss://relay.nos.social/',
    ]);
    expect(ensureRelayConnections).toHaveBeenCalledWith(relaySet.relayUrls);
  });

  it('keeps an author list for ten minutes and asks again after that', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const { fetchEvent, ndk, runtime } = createHarness();
    fetchEvent.mockResolvedValue(createServerListEvent([GOOD_SERVER], ndk));

    await runtime.readAuthorBlossomServerUrls(AUTHOR);
    await runtime.readAuthorBlossomServerUrls(AUTHOR);
    expect(fetchEvent).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_700_000_000_000 + 11 * 60 * 1000);
    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([GOOD_SERVER]);
    expect(fetchEvent).toHaveBeenCalledTimes(2);
  });

  it('shares one query between callers asking at the same time', async () => {
    const { fetchEvent, ndk, runtime } = createHarness();
    fetchEvent.mockResolvedValue(createServerListEvent([GOOD_SERVER], ndk));

    await Promise.all([
      runtime.readAuthorBlossomServerUrls(AUTHOR),
      runtime.readAuthorBlossomServerUrls(AUTHOR),
    ]);

    expect(fetchEvent).toHaveBeenCalledTimes(1);
  });

  it('does not look anyone up while logged out', async () => {
    const { fetchEvent, runtime } = createHarness({ loggedInPublicKey: null });

    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([]);
    expect(fetchEvent).not.toHaveBeenCalled();
  });

  it('treats a failed query as no list and tries again next time', async () => {
    const { fetchEvent, runtime } = createHarness({ rejectQuery: true });

    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([]);
    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([]);

    expect(fetchEvent).toHaveBeenCalledTimes(2);
  });

  it('remembers an author with no published list, so the relays are not asked twice', async () => {
    const { fetchEvent, runtime } = createHarness();
    fetchEvent.mockResolvedValue(null);

    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([]);
    await expect(runtime.readAuthorBlossomServerUrls(AUTHOR)).resolves.toEqual([]);

    expect(fetchEvent).toHaveBeenCalledTimes(1);
  });

  it('recovers a dead media link through the author published servers', async () => {
    const hash = await sha256Hex(IMAGE_BYTES);
    const { fetchEvent, ndk, runtime } = createHarness();
    fetchEvent.mockResolvedValue(createServerListEvent([DEAD_SERVER, GOOD_SERVER], ndk));
    const fetchResource = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === `${GOOD_SERVER}/${hash}.png`
        ? new Response(IMAGE_BYTES, { status: 200 })
        : new Response('', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchResource);

    const blob = await runtime.recoverMedia({
      authorPublicKey: AUTHOR,
      url: `${DEAD_SERVER}/${hash}.png`,
    });

    expect(await blob?.text()).toBe('recoverable image bytes');
    expect(fetchResource).toHaveBeenCalledWith(
      `${GOOD_SERVER}/${hash}.png`,
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    );
    vi.unstubAllGlobals();
  });

  it('forgets authors and recovered media on reset', async () => {
    const hash = await sha256Hex(IMAGE_BYTES);
    const { fetchEvent, ndk, runtime } = createHarness();
    fetchEvent.mockResolvedValue(createServerListEvent([GOOD_SERVER], ndk));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(IMAGE_BYTES, { status: 200 })),
    );
    const target = { authorPublicKey: AUTHOR, url: `${DEAD_SERVER}/${hash}.png` };
    const first = await runtime.recoverMedia(target);
    expect(fetchEvent).toHaveBeenCalledTimes(1);

    runtime.resetBlobMediaRecoveryRuntimeState();

    // Nothing is served from memory after a reset: the list and the media are read again.
    const second = await runtime.recoverMedia(target);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(fetchEvent).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
