import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NostrClient, { ClientEvent } from '#src/lib/nostr/client.ts';
import { createProfileHydrationRuntime } from '#src/stores/nostr/profileHydrationRuntime.ts';
const key = 'a'.repeat(64);
const client = new NostrClient();
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('isolates each author and kind, follows advertised outboxes, and streams metadata before EOSE', async () => {
  const subscribe = vi.fn(() => ({ stop: vi.fn() }));
  const onProfile = vi.fn();
  const onRelayList = vi.fn();
  const runtime = createProfileHydrationRuntime({
    subscribe,
    onProfile,
    onRelayList,
    isBlocked: () => false,
  });
  runtime.request([{ publicKey: key, relayUrls: ['wss://inbox.test'] }], [key]);
  await vi.advanceTimersByTimeAsync(1);
  const [filters, urls, onEvent, onDone] = subscribe.mock.calls[0] as any;
  expect(filters).toEqual(
    [0, 10002, 10050].map((kind) => ({ kinds: [kind], authors: [key], limit: 1 })),
  );
  expect(urls).toEqual(['wss://inbox.test/']);
  onEvent(
    new ClientEvent(client, {
      pubkey: key,
      kind: 10002,
      tags: [['r', 'wss://outbox.test', 'write']],
      content: '',
      created_at: 1,
    }),
  );
  expect(onRelayList).toHaveBeenCalledWith(expect.objectContaining({ kind: 10002, pubkey: key }));
  expect(onProfile).not.toHaveBeenCalled();
  onDone();
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe.mock.calls[1]?.[1]).toContain('wss://outbox.test/');
  const profile = new ClientEvent(client, {
    pubkey: key,
    kind: 0,
    tags: [],
    content: '{"name":"Found"}',
    created_at: 2,
  });
  (subscribe.mock.calls[1] as any)[2](profile);
  expect(onProfile).toHaveBeenCalledWith(profile);
  runtime.reset();
  await vi.advanceTimersByTimeAsync(60000);
  expect(subscribe).toHaveBeenCalledTimes(2);
});
it('batches authors per relay so a silent relay cannot occupy all lookup slots', async () => {
  const subscribe = vi.fn(() => ({ stop: vi.fn() }));
  const onProfile = vi.fn();
  const runtime = createProfileHydrationRuntime({
    subscribe,
    onProfile,
    onRelayList: vi.fn(),
    isBlocked: () => false,
  });
  const keys = Array.from({ length: 10 }, (_, index) => String(index).padStart(64, '0'));
  runtime.request(
    keys.map((publicKey) => ({
      publicKey,
      relayUrls: ['wss://silent.test', 'wss://healthy.test'],
    })),
    [keys[9]],
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect((subscribe.mock.calls[0] as any)[0][0].authors).toEqual([keys[9]]);
  for (let batch = 0; batch < 3; batch++) {
    const call = subscribe.mock.calls.filter((call: any) => call[1][0] === 'wss://healthy.test/')[
      batch
    ] as any;
    expect(call[0].length).toBeLessThanOrEqual(12);
    for (const filter of call[0].filter((filter: any) => filter.kinds[0] === 0))
      call[2](
        new ClientEvent(client, {
          pubkey: filter.authors[0],
          kind: 0,
          content: '{"name":"Found"}',
          tags: [],
          created_at: 1,
        }),
      );
    call[3]();
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(onProfile).toHaveBeenCalledTimes(10);
  // All ten authors hydrated before the silent relay times out.
  expect(
    subscribe.mock.calls.filter((call: any) => call[1][0] === 'wss://silent.test/'),
  ).toHaveLength(1);
  runtime.reset();
});
it('finishes untried authors before retrying missing profiles and ignores late events after reset', async () => {
  const subscribe = vi.fn(() => ({ stop: vi.fn() }));
  const onProfile = vi.fn();
  const runtime = createProfileHydrationRuntime({
    subscribe,
    onProfile,
    onRelayList: vi.fn(),
    isBlocked: () => false,
  });
  const keys = Array.from({ length: 10 }, (_, i) => String(i).padStart(64, '0'));
  runtime.request(
    keys.map((publicKey) => ({ publicKey, relayUrls: ['wss://silent.test'] })),
    [keys[9]],
  );
  await vi.advanceTimersByTimeAsync(20002);
  const firstThree = subscribe.mock.calls.slice(0, 3) as any[];
  expect(
    new Set(firstThree.flatMap((call) => call[0].flatMap((filter: any) => filter.authors))).size,
  ).toBe(10);
  await vi.advanceTimersByTimeAsync(10010);
  expect(subscribe.mock.calls).toHaveLength(4);
  runtime.reset();
  (subscribe.mock.calls[3] as any)[2](
    new ClientEvent(client, {
      pubkey: keys[9],
      kind: 0,
      content: '{"name":"Late"}',
      tags: [],
      created_at: 1,
    }),
  );
  expect(onProfile).not.toHaveBeenCalled();
});
it('keeps discovering the account inbox after finding its profile and follows hints before EOSE', async () => {
  const subscribe = vi.fn(() => ({ stop: vi.fn() }));
  const onRelayList = vi.fn();
  const runtime = createProfileHydrationRuntime({
    subscribe,
    getOwnPublicKey: () => key,
    onProfile: vi.fn(),
    onRelayList,
    isBlocked: () => false,
  });
  runtime.request([{ publicKey: key, relayUrls: ['wss://indexer.test'] }]);
  await vi.advanceTimersByTimeAsync(1);
  const call = subscribe.mock.calls[0] as any;
  expect(call[0].map((filter: any) => filter.kinds[0])).toEqual([0, 10002, 10050, 10013]);
  call[2](
    new ClientEvent(client, {
      pubkey: key,
      kind: 0,
      content: '{"name":"Me"}',
      tags: [],
      created_at: 1,
    }),
  );
  call[2](
    new ClientEvent(client, {
      pubkey: key,
      kind: 10002,
      content: '',
      tags: [['r', 'wss://outbox.test', 'write']],
      created_at: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(subscribe).toHaveBeenCalledTimes(2);
  (subscribe.mock.calls[1] as any)[2](
    new ClientEvent(client, {
      pubkey: key,
      kind: 10050,
      content: '',
      tags: [['relay', 'wss://inbox.test']],
      created_at: 1,
    }),
  );
  expect(onRelayList).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 10050 }));
  runtime.reset();
});

it('retries account relay-list discovery after an interrupted lookup even when the profile was found', async () => {
  const subscribe = vi.fn(() => ({ stop: vi.fn() }));
  const onRelayList = vi.fn();
  const runtime = createProfileHydrationRuntime({
    subscribe,
    getOwnPublicKey: () => key,
    onProfile: vi.fn(),
    onRelayList,
    isBlocked: () => false,
  });
  runtime.request([{ publicKey: key, relayUrls: ['wss://indexer.test'] }]);
  await vi.advanceTimersByTimeAsync(1);
  const call = subscribe.mock.calls[0] as any;
  call[2](
    new ClientEvent(client, {
      pubkey: key,
      kind: 0,
      content: '{"name":"Me"}',
      tags: [],
      created_at: 1,
    }),
  );
  call[3](false);
  await vi.advanceTimersByTimeAsync(5010);
  expect(subscribe).toHaveBeenCalledTimes(2);
  (subscribe.mock.calls[1] as any)[2](
    new ClientEvent(client, {
      pubkey: key,
      kind: 10050,
      content: '',
      tags: [['relay', 'wss://inbox.test']],
      created_at: 1,
    }),
  );
  (subscribe.mock.calls[1] as any)[3]();
  await vi.advanceTimersByTimeAsync(60000);
  expect(onRelayList).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  runtime.reset();
});
