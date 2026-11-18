import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Filter, VerifiedEvent } from 'nostr-tools';
import NostrClient from '#src/lib/nostr/client.ts';
import { createRatchetIntegration } from '#src/stores/nostr/ratchetIntegration.ts';
import type { createRatchetRuntime } from '#src/stores/nostr/ratchetRuntime.ts';

const { createRuntime } = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock('#src/stores/nostr/ratchetRuntime.ts', () => ({ createRatchetRuntime: createRuntime }));
vi.mock('#src/services/chatDataService.ts', () => ({ chatDataService: {} }));
vi.mock('#src/services/nostrEventDataService.ts', () => ({ nostrEventDataService: {} }));

type Transport = Parameters<typeof createRatchetRuntime>[0];
type Handlers = {
  onclose: (reason: string) => void;
  oneose: () => void;
  onevent: (event: VerifiedEvent) => void;
};

beforeEach(() => {
  vi.useFakeTimers();
  createRuntime.mockReset();
  vi.stubGlobal('localStorage', { getItem: () => '1' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const client = new NostrClient();
  let owner = 'a'.repeat(64);
  const urls = ['wss://one.example/', 'wss://two.example/'];
  const wires: { url: string; filters: Filter[]; handlers: Handlers; active: boolean }[] = [];
  for (const url of urls) vi.spyOn(client.pool.getRelay(url, false), 'connect').mockResolvedValue();
  vi.spyOn(client.transport, 'getExistingRelay').mockImplementation(
    (url) =>
      ({
        connected: true,
        subscribe: (filters: Filter[], handlers: Handlers) => {
          const wire = { url, filters, handlers, active: true };
          wires.push(wire);
          return {
            close: () => {
              wire.active = false;
            },
          };
        },
      }) as never,
  );
  let transport!: Transport;
  createRuntime.mockImplementation(async (value: Transport) => {
    transport = value;
    return { send: vi.fn(), close: vi.fn(async () => {}) };
  });
  const relays = vi.fn(async () => urls);
  const integration = createRatchetIntegration({
    client,
    owner: () => owner,
    signer: vi.fn(),
    relays,
    receive: vi.fn(),
  });
  await integration.resume();
  const filter = { kinds: [1059], '#p': ['b'.repeat(64)], limit: 200 };
  const receive = vi.fn();
  const stop = transport.subscribe(filter, receive);
  await vi.advanceTimersByTimeAsync(0);
  function disconnectAll() {
    for (const wire of wires.filter((entry) => entry.active)) {
      wire.active = false;
      wire.handlers.onclose('connection closed');
    }
  }
  return {
    client,
    urls,
    wires,
    filter,
    receive,
    stop,
    integration,
    relays,
    disconnectAll,
    changeAccount: () => {
      owner = 'c'.repeat(64);
    },
  };
}

it('reopens a closed logical NDR subscription and receives after all relays reconnect', async () => {
  const fixture = await setup();
  const { wires, urls, filter, receive, client } = fixture;
  try {
    expect(wires).toHaveLength(2);
    fixture.disconnectAll();
    for (const url of urls) client.pool.emit('relay:connect', client.pool.getRelay(url, false));
    await vi.advanceTimersByTimeAsync(999);
    expect(wires).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(wires).toHaveLength(4);
    expect(wires.filter((wire) => wire.active)).toHaveLength(2);
    expect(wires[2].filters).toEqual([filter]);
    wires[2].handlers.onevent({
      id: 'd'.repeat(64),
      pubkey: 'e'.repeat(64),
      kind: 1059,
      tags: [],
      content: 'recovered ciphertext',
      created_at: 1,
      sig: 'f'.repeat(128),
    });
    expect(receive).toHaveBeenCalledOnce();
    for (const url of urls) client.pool.emit('relay:connect', client.pool.getRelay(url, false));
    await vi.advanceTimersByTimeAsync(30000);
    expect(wires).toHaveLength(4);
  } finally {
    fixture.stop();
    await fixture.integration.close();
  }
});

it('backs off repeated all-relay failures to 30 seconds and resets after real EOSE', async () => {
  const fixture = await setup();
  try {
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const previous = fixture.wires.length;
      fixture.disconnectAll();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fixture.wires).toHaveLength(previous);
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.wires).toHaveLength(previous + 2);
      expect(fixture.wires.filter((wire) => wire.active)).toHaveLength(2);
    }
    for (const wire of fixture.wires.filter((entry) => entry.active)) wire.handlers.oneose();
    const previous = fixture.wires.length;
    fixture.disconnectAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.wires).toHaveLength(previous + 2);
  } finally {
    fixture.stop();
    await fixture.integration.close();
  }
});

it('leaves partial relay recovery to the client without duplicating the healthy request', async () => {
  const fixture = await setup();
  try {
    const dropped = fixture.wires[0];
    dropped.active = false;
    dropped.handlers.onclose('connection closed');
    await vi.advanceTimersByTimeAsync(30000);
    expect(fixture.wires).toHaveLength(2);
    fixture.client.pool.emit('relay:connect', fixture.client.pool.getRelay(dropped.url, false));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.wires).toHaveLength(3);
    expect(fixture.wires.filter((wire) => wire.active)).toHaveLength(2);
  } finally {
    fixture.stop();
    await fixture.integration.close();
  }
});

it('retains bounded retry after a relay lookup fails', async () => {
  const fixture = await setup();
  try {
    fixture.relays.mockRejectedValueOnce(new Error('Relay settings unavailable'));
    fixture.disconnectAll();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fixture.wires).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.wires).toHaveLength(4);
  } finally {
    fixture.stop();
    await fixture.integration.close();
  }
});

it.each(['cancel', 'account switch'] as const)(
  'cancels a scheduled retry on %s',
  async (action) => {
    const fixture = await setup();
    fixture.disconnectAll();
    if (action === 'cancel') fixture.stop();
    else {
      fixture.changeAccount();
      await fixture.integration.close();
    }
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.wires).toHaveLength(2);
    expect(fixture.wires.some((wire) => wire.active)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    fixture.stop();
    await fixture.integration.close();
  },
);

it.each(['cancel', 'account switch'] as const)(
  'ignores a delayed relay lookup after %s',
  async (action) => {
    const fixture = await setup();
    let resolve!: (urls: string[]) => void;
    fixture.relays.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fixture.disconnectAll();
    await vi.advanceTimersByTimeAsync(1000);
    if (action === 'cancel') fixture.stop();
    else fixture.changeAccount();
    resolve(fixture.urls);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.wires).toHaveLength(2);
    expect(fixture.receive).not.toHaveBeenCalled();
    fixture.stop();
    await fixture.integration.close();
  },
);

it('stops active subscriptions immediately on account shutdown without restarting', async () => {
  const fixture = await setup();
  fixture.changeAccount();
  await fixture.integration.close();
  expect(fixture.wires.some((wire) => wire.active)).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.wires).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  fixture.stop();
});
