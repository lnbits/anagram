import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import { afterEach, expect, it, vi } from 'vitest';
import NostrClient from '#src/lib/nostr/client.ts';
import { RelayTrafficPolicy } from '#src/stores/nostr/relayTrafficPolicy.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockConnections(clients: NostrClient[], connect: (relay: AbstractRelay) => Promise<void>) {
  for (const client of clients) {
    const authenticate = client.transport.automaticallyAuth!;
    const mocked = new WeakSet<object>();
    client.transport.automaticallyAuth = (url) => {
      const relay = client.transport.getExistingRelay(url)!;
      if (!mocked.has(relay)) {
        mocked.add(relay);
        relay.connect = () => connect(relay);
      }
      return authenticate(url);
    };
  }
}

it('serializes group handshakes and spaces starts while allowing different relays independently', async () => {
  vi.useFakeTimers();
  const parent = new NostrClient();
  const groups = Array.from(
    { length: 3 },
    () =>
      new NostrClient({
        relayTrafficPolicy: (url) => parent.relayTrafficPolicy(url),
      }),
  );
  const url = 'wss://groups.example/';
  let release!: () => void;
  const starts: Array<{ url: string; at: number }> = [];
  const wireConnect = vi.fn(async (relay: AbstractRelay) => {
    starts.push({ url: relay.url, at: Date.now() });
    if (starts.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    Object.defineProperty(relay, 'connected', { configurable: true, get: () => true });
  });
  mockConnections([parent, ...groups], wireConnect);
  // A direct ensureRelay covers fetch/publish entry points; the others use the subscription path.
  const first = groups[0].transport.ensureRelay(url);
  const second = groups[1].pool.getRelay(url, false).connect();
  const third = groups[2].pool.getRelay(url, false).connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(wireConnect).toHaveBeenCalledTimes(1);
  const other = parent.transport.ensureRelay('wss://unrelated.example/');
  await other;
  expect(wireConnect).toHaveBeenCalledTimes(2);
  release();
  await first;
  await vi.advanceTimersByTimeAsync(249);
  expect(starts.filter((s) => s.url === url)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(starts.filter((s) => s.url === url)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(250);
  await third;
  const times = starts.filter((s) => s.url === url).map((s) => s.at);
  expect(times[1] - times[0]).toBe(250);
  expect(times[2] - times[1]).toBe(250);
});

it('rechecks logout and relay bans before queued sockets can open', async () => {
  vi.useFakeTimers();
  const policy = new RelayTrafficPolicy();
  const first = new NostrClient({ relayTrafficPolicy: () => policy });
  const second = new NostrClient({ relayTrafficPolicy: () => policy });
  const third = new NostrClient({ relayTrafficPolicy: () => policy });
  const wireConnect = vi.fn(async (_relay: AbstractRelay) => {});
  mockConnections([first, second, third], wireConnect);
  await first.transport.ensureRelay('wss://relay.example/');
  const cancelled = expect(second.transport.ensureRelay('wss://relay.example/')).rejects.toThrow(
    'URL policy',
  );
  const banned = expect(third.transport.ensureRelay('wss://relay.example/')).rejects.toThrow(
    'banned',
  );
  await vi.advanceTimersByTimeAsync(0);
  second.relayConnectionFilter = () => false;
  policy.ban();
  await vi.advanceTimersByTimeAsync(250);
  await Promise.all([cancelled, banned]);
  expect(wireConnect).toHaveBeenCalledOnce();
});

it('does not make duplicate handshakes for concurrent reads in the same epoch', async () => {
  const client = new NostrClient();
  const wireConnect = vi.fn(async (_relay: AbstractRelay) => {});
  mockConnections([client], wireConnect);
  await Promise.all(
    Array.from({ length: 20 }, () => client.transport.ensureRelay('wss://relay.example/')),
  );
  expect(wireConnect).toHaveBeenCalledOnce();
});
