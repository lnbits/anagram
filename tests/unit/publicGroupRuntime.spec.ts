import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilters,
  type Event,
} from 'nostr-tools';
import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  type NostrFilter,
  type NostrSubscriptionOptions,
  type NostrSubscription,
} from '#src/lib/nostr/client.ts';
import { STARTER_PUBLIC_GROUP } from '#src/constants/starterPublicGroup.ts';
import { PublicGroupData } from '#src/services/publicGroupData.ts';
import { createPublicGroupRuntime } from '#src/stores/nostr/publicGroupRuntime.ts';
import { parsePublicRoom, roomTags, encodeRoomLink } from '#src/stores/nostr/publicGroups.ts';
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(
  events: Event[],
  key = generateSecretKey(),
  eose: boolean | ((url: string, filters: NostrFilter[]) => boolean) = true,
  starterRoom?: Event,
) {
  let account: string | null = getPublicKey(key);
  const listeners = new Set<{
    filters: NostrFilter[];
    options: NostrSubscriptionOptions;
    stop: () => void;
  }>();
  const subscriptions: NostrFilter[][] = [];
  const failures = new Set<string>();
  const published: Array<{ url: string; event: Event }> = [];
  const client = {
    subscribe(filters: NostrFilter[], options: NostrSubscriptionOptions) {
      subscriptions.push(filters);
      const sub = {
        filters,
        options,
        stop: () => {
          listeners.delete(sub);
          options.onClose?.();
        },
      };
      listeners.add(sub);
      queueMicrotask(() => {
        if (!listeners.has(sub)) return;
        const seen = new Set<string>();
        for (const filter of filters) {
          const matches = events
            .filter((e) => matchFilters([filter], e))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit ?? events.length);
          for (const e of matches)
            if (!seen.has(e.id)) {
              seen.add(e.id);
              options.onEvent?.(new ClientEvent(undefined, e), {
                url: options.relayUrls?.[0],
              } as never);
            }
        }
        if (typeof eose === 'function' ? eose(options.relayUrls?.[0] ?? '', filters) : eose)
          options.onEose?.();
      });
      return sub as unknown as NostrSubscription;
    },
    pool: {
      getRelay: (url: string) => ({
        url,
        connect: async () => {},
        publish: async (event: ClientEvent) => {
          published.push({ url, event: event.rawEvent() as Event });
          if (failures.has(url)) throw new Error('Relay rejected this event');
          if (url.includes('stalled')) return new Promise(() => {});
          events.push(event.rawEvent() as Event);
        },
      }),
    },
  } as unknown as NostrClient;
  const runtime = createPublicGroupRuntime({
    starterRoom,
    client,
    account: () => account,
    signer: async () => new NostrPrivateKeySigner(key),
    relays: async () => ['wss://relay.example.org/'],
    containsSecret: () => false,
  });
  stops.push(runtime.stop);
  return {
    runtime,
    events,
    listeners,
    subscriptions,
    failures,
    published,
    setAccount: (value: string | null) => (account = value),
  };
}
function room(key: Uint8Array, slug: string, extra: string[][] = [], created_at = 10) {
  return finalizeEvent(
    {
      kind: 34550,
      created_at,
      content: '',
      tags: [
        ...roomTags({
          slug,
          name: slug,
          about: '',
          picture: '',
          relays: ['wss://relay.example.org/'],
          trusted: [],
          blocked: [],
        }),
        ...extra,
      ],
    },
    key,
  );
}
it('requires signed two-sided handover, switches policy, and pins accepted transfers', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey(),
    evil = generateSecretKey();
  const source = `34550:${getPublicKey(old)}:old`,
    target = `34550:${getPublicKey(next)}:new`;
  const from = room(old, 'old', [['successor', target, 'wss://relay.example.org/']]);
  const destination = room(next, 'new', [
    ['predecessor', source],
    ['blocked', getPublicKey(evil)],
  ]);
  const { runtime, events } = setup([from, destination]);
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room?.owner).toBe(getPublicKey(next));
  expect(get(runtime.state).room?.blocked).toEqual([getPublicKey(evil)]);
  expect(get(runtime.state).ancestors).toHaveLength(1);
  events.splice(0, 1, room(old, 'old', [['successor', `34550:${getPublicKey(evil)}:evil`]], 11));
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room?.owner).toBe(getPublicKey(next));
});
it('rejects a target with no acknowledgement and does not join it', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey();
  const from = room(old, 'old', [['successor', `34550:${getPublicKey(next)}:new`]]);
  const { runtime } = setup([from, room(next, 'new')]);
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/not accepted/);
  expect(get(runtime.state).rooms).toEqual([]);
});
it('rejects cycles', async () => {
  const a = generateSecretKey(),
    b = generateSecretKey();
  const aa = `34550:${getPublicKey(a)}:a`,
    bb = `34550:${getPublicKey(b)}:b`;
  const first = room(a, 'a', [
    ['successor', bb],
    ['predecessor', bb],
  ]);
  const { runtime } = setup([
    first,
    room(b, 'b', [
      ['successor', aa],
      ['predecessor', aa],
    ]),
  ]);
  await runtime.open(encodeRoomLink(parsePublicRoom(first)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/chain/);
});
it('does not turn a relay timeout into a verified empty policy', async () => {
  vi.useFakeTimers();
  const event = room(generateSecretKey(), 'timeout');
  const { runtime } = setup([event], undefined, false);
  const loading = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(10001);
  await loading;
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).stale).toBe(true);
});
it('denies management by a non-owner and isolates state after account replacement', async () => {
  const event = room(generateSecretKey(), 'owned');
  const { runtime, setAccount } = setup([event]);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await expect(runtime.update({ trusted: ['a'.repeat(64)] }, event.id)).rejects.toThrow(
    /Only the current owner/,
  );
  setAccount(getPublicKey(generateSecretKey()));
  await runtime.init();
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
});

it('never falls back to a previously joined target after an invalid handover', async () => {
  const a = generateSecretKey(),
    b = generateSecretKey();
  const target = room(b, 'existing');
  const from = room(a, 'source', [['successor', parsePublicRoom(target).address]]);
  const { runtime } = setup([target, from]);
  await runtime.open(encodeRoomLink(parsePublicRoom(target)));
  expect(get(runtime.state).room?.name).toBe('existing');
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect(get(runtime.state).room).toBeNull();
  expect(get(runtime.state).error).toMatch(/not accepted/);
});

it('ignores late subscription events after leaving and rejoins only when explicitly opened', async () => {
  const key = generateSecretKey();
  const event = room(key, 'leave');
  const { runtime, listeners } = setup([event]);
  const link = encodeRoomLink(parsePublicRoom(event));
  await runtime.open(link);
  const live = [...listeners].find((entry) =>
    entry.filters.some((filter) => filter.kinds?.includes(9)),
  )!;
  expect(live).toBeDefined();
  await runtime.leave(parsePublicRoom(event).address);
  live.options.onEvent?.(new ClientEvent(undefined, room(key, 'leave', [], 11)));
  await Promise.resolve();
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
  expect(listeners.size).toBe(0);
  await runtime.open(link);
  expect(get(runtime.state).rooms).toHaveLength(1);
});

it('cancels an in-flight room lookup when the account changes', async () => {
  const event = room(generateSecretKey(), 'switch');
  const { runtime, listeners, setAccount } = setup([event], undefined, false);
  const opening = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(listeners.size).toBe(1));
  setAccount(getPublicKey(generateSecretKey()));
  await runtime.init();
  await opening;
  expect(get(runtime.state).rooms).toEqual([]);
  expect(get(runtime.state).room).toBeNull();
  expect(listeners.size).toBe(0);
});

it('opens and posts through a completed replica without waiting for a stalled relay', async () => {
  const key = generateSecretKey();
  const event = room(key, 'replicas', [['relay', 'wss://stalled.example.org/']]);
  const { runtime, listeners } = setup([event], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  expect(get(runtime.state).stale).toBe(false);
  expect(get(runtime.state).error).toBe('');
  expect(listeners.size).toBe(1); // Only the live listener survives discovery.
  await runtime.send('A healthy relay is sufficient for public chat');
  expect(get(runtime.state).messages.at(-1)?.content).toBe(
    'A healthy relay is sufficient for public chat',
  );
});

it('shows cached messages immediately, hydrates during refresh and keeps posting locked without real EOSE', async () => {
  const key = generateSecretKey();
  const event = room(key, 'cached');
  let complete = true;
  const { runtime, events, listeners } = setup([event], key, () => complete);
  const link = encodeRoomLink(parsePublicRoom(event));
  await runtime.open(link);
  await runtime.send('Already saved');
  runtime.stopView();
  complete = false;
  const later = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      tags: [['a', parsePublicRoom(event).address]],
      content: 'Arrived during refresh',
    },
    key,
  );
  events.push(later);
  const opening = runtime.open(link);
  await vi.waitFor(() => expect(get(runtime.state).room?.name).toBe('cached'));
  expect(get(runtime.state).refreshing).toBe(true);
  await vi.waitFor(() =>
    expect(get(runtime.state).messages.some((e) => e.content === 'Already saved')).toBe(true),
  );
  await vi.waitFor(() =>
    expect(get(runtime.state).messages.some((e) => e.id === later.id)).toBe(true),
  );
  await expect(runtime.send('Not yet')).rejects.toThrow(/unavailable/);
  const lookup = [...listeners].find((l) => !l.filters.some((f) => f.kinds?.includes(9)))!;
  lookup.options.onEose?.();
  await opening;
  expect(get(runtime.state).stale).toBe(false); // Replacing a live listener is not a disconnect.
  expect(get(runtime.state).error).toBe('');
  await runtime.send('Now verified');
});

it.each(['save', 'hydrate'] as const)(
  'keeps live trust updates while an older room refresh finishes %s',
  async (phase) => {
    const key = generateSecretKey();
    const trusted = getPublicKey(generateSecretKey());
    const initial = room(key, 'live-policy-race', [], 10);
    const latest = room(key, 'live-policy-race', [['trusted', trusted]], 20);
    const { runtime, listeners } = setup([initial], key);
    const link = encodeRoomLink(parsePublicRoom(initial));
    await runtime.open(link);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    if (phase === 'save') {
      const save = PublicGroupData.prototype.save;
      vi.spyOn(PublicGroupData.prototype, 'save').mockImplementation(async function (value) {
        if (!waiting && value.room.event.id === initial.id) {
          waiting = true;
          await paused;
        }
        return save.call(this, value);
      });
    } else {
      const page = PublicGroupData.prototype.page;
      let reads = 0;
      vi.spyOn(PublicGroupData.prototype, 'page').mockImplementation(async function (...args) {
        if (++reads === 2) {
          waiting = true;
          await paused;
        }
        return page.apply(this, args);
      });
    }
    const opening = runtime.open(link);
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      const live = [...listeners].find((l) => l.filters.some((f) => f.kinds?.includes(9)))!;
      live.options.onEvent?.(new ClientEvent(undefined, latest));
      await vi.waitFor(() =>
        expect(
          get(runtime.state).rooms.find((r) => r.address === parsePublicRoom(initial).address)?.room
            .event.id,
        ).toBe(latest.id),
      );
    } finally {
      release();
    }
    await opening;
    expect(get(runtime.state).room?.trusted).toEqual([trusted]);
    expect(
      get(runtime.state).rooms.find((r) => r.address === parsePublicRoom(initial).address)?.room
        .event.id,
    ).toBe(latest.id);
    // A stale relay reply must not undo the live update on the next open either.
    await runtime.open(link);
    expect(get(runtime.state).room?.trusted).toEqual([trusted]);
  },
);

it('owner edits succeed through a healthy relay without waiting for stalled replicas', async () => {
  const key = generateSecretKey();
  const event = room(key, 'available-write', [['relay', 'wss://stalled.example.org/']]);
  const { runtime, published } = setup([event], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await runtime.update({ name: 'Updated through healthy relay' }, event.id);
  expect(get(runtime.state).room?.name).toBe('Updated through healthy relay');
  expect(published.map((entry) => entry.url)).toEqual([
    'wss://relay.example.org/',
    'wss://stalled.example.org/',
  ]);
});

it('keeps newer cached moderation usable when a replica replays an old room', async () => {
  const key = generateSecretKey();
  const blocked = getPublicKey(generateSecretKey());
  const current = room(key, 'policy', [['blocked', blocked]], 20);
  const { runtime, events } = setup([current], key);
  const link = encodeRoomLink(parsePublicRoom(current));
  await runtime.open(link);
  events.splice(0, events.length, room(key, 'policy', [], 10));
  await runtime.open(link);
  expect(get(runtime.state).room?.blocked).toEqual([blocked]);
  expect(get(runtime.state).stale).toBe(false);
  expect(get(runtime.state).error).toBe('');
  await runtime.send('Still using the current signed policy');
});

it('pages history through a healthy replica without a stalled replica blocking a full page', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'history-replicas', [['relay', 'wss://stalled.example.org/']]);
  const address = parsePublicRoom(definition).address;
  const events = Array.from({ length: 150 }, (_, n) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 100 + n,
        content: `Message ${n}`,
        tags: [['a', address]],
      },
      key,
    ),
  );
  const { runtime } = setup([definition, ...events], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  await runtime.older();
  expect(get(runtime.state).messages[0].content).toBe('Message 50');
  expect(get(runtime.state).messages).toHaveLength(100);
  expect(get(runtime.state).more).toBe(true);
  expect(get(runtime.state).error).toBe('');
});

it('bounds pending query events across all replicas, even before EOSE', async () => {
  const key = generateSecretKey();
  const event = room(key, 'bounded', [['relay', 'wss://second.example.org/']]);
  const { runtime, listeners } = setup([], key, false);
  const opening = runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await vi.waitFor(() => expect(listeners.size).toBe(2));
  const replicas = [...listeners];
  for (let n = 0; n < 33; n++)
    replicas[n % 2].options.onEvent?.(new ClientEvent(undefined, room(key, 'bounded', [], n + 10)));
  await opening;
  expect(get(runtime.state).error).toMatch(/Too many/);
  expect(listeners.size).toBe(0);
});

it('keeps one live subscription on cached reentry and batches burst hydration without losing notes', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'batched');
  const address = parsePublicRoom(definition);
  const { runtime, listeners, subscriptions } = setup([definition], key);
  await runtime.open(encodeRoomLink(address));
  runtime.stopView();
  subscriptions.length = 0;
  const sidebarUpdates = vi.fn();
  const stopSidebar = runtime.sidebar.subscribe(sidebarUpdates);
  const put = vi.spyOn(PublicGroupData.prototype, 'putMany');
  const list = vi.spyOn(PublicGroupData.prototype, 'list');
  try {
    await runtime.open(encodeRoomLink(address));
    const live = [...listeners].filter((l) => l.filters.some((f) => f.kinds?.includes(9)));
    expect(live).toHaveLength(1);
    expect(
      subscriptions.filter((filters) => filters.some((f) => f.kinds?.includes(9))),
    ).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    sidebarUpdates.mockClear();
    const events = Array.from({ length: 128 }, (_, i) =>
      finalizeEvent(
        { kind: 9, created_at: 100 + i, tags: [['a', address.address]], content: `burst ${i}` },
        key,
      ),
    );
    for (const event of events) live[0].options.onEvent?.(new ClientEvent(undefined, event));
    await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(128));
    expect(put).toHaveBeenCalledTimes(2);
    expect(sidebarUpdates).not.toHaveBeenCalled();
    const db = new PublicGroupData(getPublicKey(key));
    expect(await db.page(address.address, undefined, 200)).toHaveLength(128);
    await db.close();
    runtime.stopView();
    live[0].options.onEvent?.(
      new ClientEvent(
        undefined,
        finalizeEvent(
          { kind: 9, created_at: 999, tags: [['a', address.address]], content: 'late' },
          key,
        ),
      ),
    );
    expect(get(runtime.state).messages).toHaveLength(128);
    expect(listeners.size).toBe(0);
  } finally {
    stopSidebar();
    put.mockRestore();
    list.mockRestore();
  }
});

it('persists ACKs, failures and replica receipts and retries the original signed public message', async () => {
  const key = generateSecretKey();
  const bad = 'wss://second.example.org/';
  const definition = room(key, 'relay-stats', [['relay', bad]]);
  const address = parsePublicRoom(definition);
  const { runtime, listeners, failures, events, setAccount } = setup([definition], key);
  await runtime.open(encodeRoomLink(address));
  failures.add(bad);
  await runtime.send('delivery test');
  await vi.waitFor(() =>
    expect(
      get(runtime.state).messages[0]?.relay_statuses?.filter((s) => s.direction === 'outbound'),
    ).toHaveLength(2),
  );
  await vi.waitFor(() =>
    expect(
      get(runtime.state).messages[0].relay_statuses?.find((s) => s.relay_url === bad)?.status,
    ).toBe('failed'),
  );
  const sent = get(runtime.state).messages[0];
  expect(sent.relay_statuses?.find((s) => s.relay_url === bad)?.status).toBe('failed');
  expect(sent.relay_statuses?.find((s) => s.relay_url !== bad)?.status).toBe('published');
  const live = [...listeners].find((l) => l.filters.some((f) => f.kinds?.includes(9)))!;
  for (const url of address.relays)
    live.options.onEvent?.(new ClientEvent(undefined, sent), { url } as never);
  await vi.waitFor(() => expect(get(runtime.state).messages[0].relay_statuses).toHaveLength(4));
  failures.clear();
  await runtime.retryMessage(sent.id!, bad);
  expect(events.filter((e) => e.id === sent.id)).toHaveLength(2);
  expect(events.filter((e) => e.id === sent.id).every((e) => e.sig === sent.sig)).toBe(true);
  expect(get(runtime.state).messages).toHaveLength(1);
  expect(
    get(runtime.state).messages[0].relay_statuses?.filter((s) => s.status === 'published'),
  ).toHaveLength(2);
  runtime.stopView();
  await runtime.open(encodeRoomLink(address));
  await vi.waitFor(() => expect(get(runtime.state).messages[0]?.relay_statuses).toHaveLength(4));
  await expect(runtime.retryMessage(sent.id!, 'wss://unrelated.example.org/')).rejects.toThrow(
    'Relay is not used',
  );
  setAccount(getPublicKey(generateSecretKey()));
  await expect(runtime.retryMessage(sent.id!, bad)).rejects.toThrow('Account changed');
});

it('redacts links before signing normal-user posts', async () => {
  const owner = generateSecretKey(),
    member = generateSecretKey();
  const definition = room(owner, 'no-links');
  const { runtime, events } = setup([definition], member);
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await runtime.send('Look https://example.org/post and www.example.org');
  expect(events.find((e) => e.kind === 9)?.content).toBe('Look [link removed] and [link removed]');
});

it.each(['stopView', 'stop'] as const)(
  'does not reopen after %s while account storage is initializing',
  async (stop) => {
    const definition = room(generateSecretKey(), 'cancel-initial-open');
    const { runtime, listeners } = setup([definition]);
    const opening = runtime.open(encodeRoomLink(parsePublicRoom(definition)));
    runtime[stop]();
    await opening;
    expect(listeners.size).toBe(0);
    expect(get(runtime.state).room).toBeNull();
  },
);

it('keeps the verified successor and saved messages visible when reopening an old link offline', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey();
  const source = `34550:${getPublicKey(old)}:offline-source`;
  const target = `34550:${getPublicKey(next)}:offline-target`;
  const from = room(old, 'offline-source', [['successor', target]]);
  const destination = room(next, 'offline-target', [['predecessor', source]]);
  let online = true;
  const { runtime, events, listeners } = setup([from, destination], next, () => online);
  const link = encodeRoomLink(parsePublicRoom(from));
  await runtime.open(link);
  await runtime.send('Saved in the successor');
  runtime.stop();
  events.length = 0;
  online = false;
  const reopening = runtime.open(link);
  const lookups = () =>
    [...listeners].filter((entry) =>
      entry.filters.every((filter) => filter.kinds?.includes(34550)),
    );
  await vi.waitFor(() => expect(lookups()).toHaveLength(1));
  lookups().forEach((entry) => entry.options.onClose?.());
  await reopening;
  expect(get(runtime.state).room?.address).toBe(target);
  expect(get(runtime.state).ancestors.map((r) => r.address)).toEqual([source]);
  expect(get(runtime.state).messages.map((e) => e.content)).toContain('Saved in the successor');
  expect(get(runtime.state).stale).toBe(true);
  await expect(runtime.send('Offline')).rejects.toThrow(/unavailable/);
});

it('re-enables older paging when live traffic overflows a previously empty room', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'live-window');
  const address = parsePublicRoom(definition);
  const { runtime, listeners } = setup([definition], key);
  await runtime.open(encodeRoomLink(address));
  await vi.waitFor(() => expect(get(runtime.state).more).toBe(false));
  const live = [...listeners].find((l) => l.filters.some((f) => f.kinds?.includes(9)))!;
  for (let i = 0; i < 201; i++) {
    live.options.onEvent?.(
      new ClientEvent(
        undefined,
        finalizeEvent(
          {
            kind: 9,
            created_at: 100 + i,
            tags: [['a', address.address]],
            content: `Live ${i}`,
          },
          key,
        ),
      ),
    );
  }
  // The queue persists and hydrates batches of 64. A full display window alone
  // does not prove the 201st event (which enables older paging) has been handled.
  await vi.waitFor(() => expect(get(runtime.state).messages.at(-1)?.content).toBe('Live 200'), {
    timeout: 5_000,
  });
  expect(get(runtime.state).messages).toHaveLength(200);
  expect(get(runtime.state).more).toBe(true);
  await runtime.older();
  expect(get(runtime.state).messages[0].content).toBe('Live 0');
}, 10_000);

it('cancels publication if a block arrives while the signer is approving the message', async () => {
  const owner = generateSecretKey(),
    member = generateSecretKey();
  const definition = room(owner, 'pending-signature');
  const { runtime, listeners, events } = setup([definition], member);
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  let release!: () => void;
  const approval = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = NostrPrivateKeySigner.prototype.sign;
  const signing = vi
    .spyOn(NostrPrivateKeySigner.prototype, 'sign')
    .mockImplementation(async function (event) {
      await approval;
      return original.call(this, event);
    });
  const sending = runtime.send('Awaiting approval');
  // Attach rejection handling before releasing the delayed signer.
  const outcome = sending.then(
    () => '',
    (error) => String(error),
  );
  await vi.waitFor(() => expect(signing).toHaveBeenCalled());
  const live = [...listeners].find((l) => l.filters.some((f) => f.kinds?.includes(9)))!;
  live.options.onEvent?.(
    new ClientEvent(
      undefined,
      room(owner, 'pending-signature', [['blocked', getPublicKey(member)]], 11),
    ),
  );
  await vi.waitFor(() => expect(get(runtime.state).room?.blocked).toContain(getPublicKey(member)));
  release();
  expect(await outcome).toMatch(/policy changed/i);
  expect(events.some((e) => e.kind === 9)).toBe(false);
});

it('removes an explicitly deselected unavailable relay before retrying moderation', async () => {
  const key = generateSecretKey();
  const trusted = getPublicKey(generateSecretKey());
  const blocked = getPublicKey(generateSecretKey());
  const event = room(key, 'repair-relays', [
    ['relay', 'wss://stalled.example.org/'],
    ['trusted', trusted],
    ['blocked', blocked],
  ]);
  const { runtime } = setup([event], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await runtime.update({ relays: ['wss://relay.example.org/'] }, event.id);
  const repaired = get(runtime.state).room!;
  expect(repaired.relays).toEqual(['wss://relay.example.org/']);
  expect(repaired.trusted).toEqual([trusted]);
  expect(repaired.blocked).toEqual([blocked]);
  const newcomer = getPublicKey(generateSecretKey());
  await runtime.update({ trusted: [trusted, newcomer] }, repaired.event.id!);
  expect(get(runtime.state).room!.trusted).toEqual([trusted, newcomer]);
});

it('publishes relay changes to retained, new and removed relays with the same signature', async () => {
  const key = generateSecretKey();
  const event = room(key, 'move-relays', [['relay', 'wss://old.example.org/']]);
  const { runtime, published } = setup([event], key);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  await runtime.update(
    { relays: ['wss://relay.example.org/', 'wss://new.example.org/'] },
    event.id,
  );
  const updated = get(runtime.state).room!;
  const copies = published.filter((entry) => entry.event.id === updated.event.id);
  expect(copies.map((entry) => entry.url).sort()).toEqual([
    'wss://new.example.org/',
    'wss://old.example.org/',
    'wss://relay.example.org/',
  ]);
  expect(copies.every((entry) => entry.event.sig === updated.event.sig)).toBe(true);
  runtime.stop();
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  expect(get(runtime.state).room!.relays).toEqual(updated.relays);
});

it('rejects unsafe relay edits and stale forms without publishing', async () => {
  const key = generateSecretKey();
  const event = room(key, 'relay-validation');
  const { runtime, events, published } = setup([event], key);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  for (const relays of [
    [],
    ['https://relay.example.org'],
    ['ws://127.0.0.1:7777/'],
    Array(9).fill('wss://relay.example.org/'),
  ])
    await expect(runtime.update({ relays }, event.id)).rejects.toThrow();
  await expect(
    runtime.update({ relays: ['wss://relay.example.org/'], blocked: [] }, event.id),
  ).rejects.toThrow('separately');
  events.splice(
    0,
    events.length,
    room(key, 'relay-validation', [['blocked', getPublicKey(generateSecretKey())]], 20),
  );
  await expect(runtime.update({ relays: ['wss://relay.example.org/'] }, event.id)).rejects.toThrow(
    'group changed',
  );
  expect(published).toHaveLength(0);
});

it('accepts a complete relay replacement when only the app relay acknowledges it', async () => {
  const key = generateSecretKey();
  const event = room(key, 'rejected-relay');
  const { runtime, failures } = setup([event], key);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  failures.add('wss://new.example.org/');
  await runtime.update({ relays: ['wss://new.example.org/'] }, event.id);
  expect(get(runtime.state).room!.relays).toEqual(['wss://new.example.org/']);
  expect(get(runtime.state).room!.event.id).not.toBe(event.id);
});

it('uses app relays for creation, moderation, messages and reload with eight unavailable preferred relays', async () => {
  const preferred = Array.from({ length: 8 }, (_, i) => `wss://failed${i}.example.org/`);
  const { runtime, failures, published } = setup([], undefined, (url) => !preferred.includes(url));
  preferred.forEach((url) => failures.add(url));
  const link = await runtime.create({
    name: 'App fallback',
    about: '',
    picture: '',
    relays: preferred,
  });
  expect(published).toHaveLength(9);
  await runtime.open(link);
  const member = getPublicKey(generateSecretKey());
  await runtime.update({ trusted: [member] }, get(runtime.state).room!.event.id!);
  await runtime.send('Through the app relay');
  runtime.stop();
  await runtime.open(link);
  expect(get(runtime.state).room!.relays).toEqual(preferred);
  expect(get(runtime.state).room!.trusted).toEqual([member]);
  await vi.waitFor(() =>
    expect(get(runtime.state).messages[0]?.content).toBe('Through the app relay'),
  );
  expect(get(runtime.state).stale).toBe(false);
});

it('reports failure when no preferred or app relay acknowledges an owner update', async () => {
  const key = generateSecretKey();
  const event = room(key, 'all-rejected', [['relay', 'wss://second.example.org/']]);
  const { runtime, failures } = setup([event], key);
  await runtime.open(encodeRoomLink(parsePublicRoom(event)));
  parsePublicRoom(event).relays.forEach((url) => failures.add(url));
  await expect(runtime.update({ name: 'Not saved' }, event.id)).rejects.toThrow(
    'No public group or app relay accepted',
  );
  expect(get(runtime.state).room!.event.id).toBe(event.id);
});

it('creates a group with explicitly selected relays', async () => {
  const { runtime, published } = setup([]);
  const link = await runtime.create({
    name: 'Chosen relays',
    about: '',
    picture: '',
    relays: ['wss://chosen.example.org/'],
  });
  expect(published.map((entry) => entry.url)).toEqual([
    'wss://chosen.example.org/',
    'wss://relay.example.org/',
  ]);
  expect(parsePublicRoom(published[0].event).relays).toEqual(['wss://chosen.example.org/']);
  expect(link).toContain('naddr');
});

it('searches cached public history and jumps with bounded hydration, preserving policy and pagination', async () => {
  const key = generateSecretKey(),
    blocked = generateSecretKey(),
    stranger = generateSecretKey();
  const metadata = room(key, 'search', [['blocked', getPublicKey(blocked)]]);
  const group = parsePublicRoom(metadata);
  const db = new PublicGroupData(getPublicKey(key));
  const events = Array.from({ length: 180 }, (_, i) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: i + 20,
        tags: [['a', group.address]],
        content: i === 10 || i === 40 ? `Search needle ${i}` : `filler ${i}`,
      },
      key,
    ),
  );
  await db.putMany(group.address, events);
  await db.putMany(group.address, [
    finalizeEvent(
      { kind: 9, created_at: 201, tags: [['a', group.address]], content: 'search needle blocked' },
      blocked,
    ),
    finalizeEvent(
      {
        kind: 9,
        created_at: 202,
        tags: [['a', group.address]],
        content: 'search needle https://secret.example/hidden',
      },
      stranger,
    ),
    { ...events[0], id: '0'.repeat(64), content: 'search needle forged' },
  ]);
  const { runtime, subscriptions } = setup([metadata], key);
  await runtime.open(encodeRoomLink(group));
  expect(get(runtime.state).messages.some((event) => event.id === events[40].id)).toBe(false);
  const results = await runtime.searchMessages('SEARCH  needle');
  expect(results.map((result) => result.text)).toEqual([
    'search needle [link removed]',
    'Search needle 40',
    'Search needle 10',
  ]);
  expect(await runtime.searchMessages('secret.example')).toEqual([]);
  const pageSpy = vi.spyOn(PublicGroupData.prototype, 'page');
  const networkQueries = subscriptions.length;
  expect((await runtime.jumpToMessage(events[40].id))?.id).toBe(events[40].id);
  expect(pageSpy.mock.calls.map((args) => args[2])).toEqual([25, 26]);
  expect(subscriptions).toHaveLength(networkQueries);
  expect(get(runtime.state).messages).toHaveLength(51);
  expect(get(runtime.state).messages[25].id).toBe(events[40].id);
  expect(get(runtime.state).hasNewer).toBe(true);
  await runtime.newer();
  expect(get(runtime.state).messages.at(-1)?.id).toBe(events[115].id);
  await runtime.jumpToMessage(events[179].id);
  expect(get(runtime.state).hasNewer).toBe(false);
  await db.close();
});

it('discards cancelled and superseded public search jumps, including account changes', async () => {
  const key = generateSecretKey(),
    metadata = room(key, 'search-races');
  const group = parsePublicRoom(metadata);
  const db = new PublicGroupData(getPublicKey(key));
  const events = [20, 21].map((created_at) =>
    finalizeEvent(
      {
        kind: 9,
        created_at,
        tags: [['a', group.address]],
        content: `needle ${created_at}`,
      },
      key,
    ),
  );
  await db.putMany(group.address, events);
  const { runtime, setAccount } = setup([metadata], key);
  await runtime.open(encodeRoomLink(group));
  const lookup = PublicGroupData.prototype.message;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(PublicGroupData.prototype, 'message').mockImplementationOnce(async function (room, id) {
    await pending;
    return lookup.call(this, room, id);
  });
  const first = runtime.jumpToMessage(events[0].id);
  expect((await runtime.jumpToMessage(events[1].id))?.id).toBe(events[1].id);
  const window = get(runtime.state).messages;
  release();
  expect(await first).toBeNull();
  expect(get(runtime.state).messages).toBe(window);
  const abort = new AbortController();
  const cancelled = runtime.jumpToMessage(events[0].id, abort.signal);
  abort.abort();
  expect(await cancelled).toBeNull();
  expect(get(runtime.state).loading).toBe(false);
  const search = runtime.searchMessages('needle');
  const jump = runtime.jumpToMessage(events[0].id);
  setAccount(getPublicKey(generateSecretKey()));
  expect(await search).toEqual([]);
  expect(await jump).toBeNull();
  expect(get(runtime.state).messages).toBe(window);
  await db.close();
});

it('searches the selected ownership history under the current owner policy', async () => {
  const old = generateSecretKey(),
    next = generateSecretKey(),
    blocked = generateSecretKey();
  const source = `34550:${getPublicKey(old)}:search-old`,
    target = `34550:${getPublicKey(next)}:search-new`;
  const from = room(old, 'search-old', [['successor', target]]);
  const to = room(next, 'search-new', [
    ['predecessor', source],
    ['blocked', getPublicKey(blocked)],
  ]);
  const db = new PublicGroupData(getPublicKey(next));
  const event = (address: string, key: Uint8Array, content: string) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        tags: [['a', address]],
        content,
      },
      key,
    );
  const prior = event(source, old, 'needle old');
  await db.putMany(source, [prior, event(source, blocked, 'needle blocked')]);
  await db.put(target, event(target, next, 'needle current'));
  const { runtime } = setup([from, to], next);
  await runtime.open(encodeRoomLink(parsePublicRoom(from)));
  expect((await runtime.searchMessages('needle')).map((r) => r.text)).toEqual(['needle current']);
  await runtime.history(source);
  expect((await runtime.searchMessages('needle')).map((r) => r.text)).toEqual(['needle old']);
  expect((await runtime.jumpToMessage(prior.id))?.id).toBe(prior.id);
  expect(get(runtime.state).history).toBe(source);
  await db.close();
});

it('publishes public replies, edits, reactions and deletions and restores their state after reopening', async () => {
  const key = generateSecretKey(),
    metadata = room(key, 'message-actions');
  const group = parsePublicRoom(metadata);
  const { runtime, published } = setup([metadata], key);
  await runtime.open(encodeRoomLink(group));
  await runtime.send('Original message');
  const root = get(runtime.state).messages[0];
  await runtime.send('A reply', undefined, root.id);
  expect(published.at(-1)!.event.tags).toContainEqual([
    'q',
    root.id,
    group.relays[0],
    getPublicKey(key),
  ]);
  await runtime.editMessage(root.id!, 'Edited message');
  const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
  const display = () =>
    get(runtime.state).messages.map((event) => publicMessageState(event, group, getPublicKey(key)));
  expect(display().find((message) => message.id === root.id)?.text).toBe('Edited message');
  expect(get(runtime.state).messages).toHaveLength(2);
  expect(await runtime.searchMessages('Original message')).toHaveLength(0);
  expect(await runtime.searchMessages('Edited message')).toHaveLength(1);
  await runtime.react(root.id!, '❤️');
  expect(display().find((message) => message.id === root.id)?.meta.reactions).toHaveLength(1);
  await runtime.react(root.id!, '❤️', true);
  expect(display().find((message) => message.id === root.id)?.meta.reactions).toHaveLength(0);
  await runtime.react(root.id!, '👍');
  await runtime.open(encodeRoomLink(group));
  expect(display().find((message) => message.id === root.id)?.meta.reactions).toHaveLength(1);
  await runtime.deleteMessage(root.id!);
  expect(published.at(-1)!.event.kind).toBe(5);
  expect(published.at(-1)!.event.tags.some((tag) => tag[0] === 'a')).toBe(false);
  expect(display().find((message) => message.id === root.id)?.meta.deleted).toBeTruthy();
  await runtime.open(encodeRoomLink(group));
  expect(display().find((message) => message.id === root.id)?.meta.deleted).toBeTruthy();
  expect(await runtime.searchMessages('Edited message')).toHaveLength(0);
});

it('rejects edits and deletions of another author and leaves failed deletions unapplied', async () => {
  const key = generateSecretKey(),
    other = generateSecretKey(),
    metadata = room(key, 'actions-auth');
  const group = parsePublicRoom(metadata);
  const db = new PublicGroupData(getPublicKey(key));
  const foreign = finalizeEvent(
    { kind: 9, created_at: 12, content: 'Other author', tags: [['a', group.address]] },
    other,
  );
  await db.put(group.address, foreign);
  const { runtime, published, failures } = setup([metadata], key);
  await runtime.open(encodeRoomLink(group));
  await expect(runtime.editMessage(foreign.id, 'fake')).rejects.toThrow('Only the author');
  await expect(runtime.deleteMessage(foreign.id)).rejects.toThrow('Only the author');
  expect(published).toHaveLength(0);
  await runtime.send('Own post');
  const own = get(runtime.state).messages.find((event) => event.pubkey === getPublicKey(key))!;
  failures.add('wss://relay.example.org/');
  await expect(runtime.deleteMessage(own.id!)).rejects.toThrow('No public group');
  const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
  expect(
    publicMessageState(
      get(runtime.state).messages.find((event) => event.id === own.id)!,
      group,
    ).meta.deleted,
  ).toBeUndefined();
  await db.close();
});

it('forwards into another public group without replacing the open thread', async () => {
  const key = generateSecretKey(),
    first = room(key, 'forward-source'),
    second = room(key, 'forward-target');
  const source = parsePublicRoom(first),
    target = parsePublicRoom(second);
  const { runtime, published } = setup([first, second], key);
  await runtime.open(encodeRoomLink(target));
  await runtime.open(encodeRoomLink(source));
  await runtime.forwardMessage(target.address, { text: 'Forwarded public text', meta: {} });
  expect(published.at(-1)?.event.tags).toContainEqual(['a', target.address]);
  expect(get(runtime.state).room?.address).toBe(source.address);
  expect(get(runtime.state).messages).toHaveLength(0);
  await runtime.open(encodeRoomLink(target));
  expect(
    get(runtime.state).messages.some((event) => event.content === 'Forwarded public text'),
  ).toBe(true);
});

it('receives standard reactions and deletions without application-specific room hints', async () => {
  const key = generateSecretKey(),
    reactor = generateSecretKey(),
    metadata = room(key, 'standard-actions');
  const group = parsePublicRoom(metadata);
  const original = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Standard events', tags: [['a', group.address]] },
    key,
  );
  const reaction = finalizeEvent(
    {
      kind: 7,
      created_at: 21,
      content: '+',
      tags: [
        ['e', original.id],
        ['p', original.pubkey],
        ['k', '9'],
      ],
    },
    reactor,
  );
  const { runtime, listeners, events } = setup([metadata, reaction, original], key);
  const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
  await runtime.open(encodeRoomLink(group));
  const displayed = () =>
    get(runtime.state).messages.map((event) => publicMessageState(event, group));
  await vi.waitFor(() => expect(displayed()[0]?.meta.reactions).toHaveLength(1));
  const removal = finalizeEvent(
    {
      kind: 5,
      created_at: 22,
      content: '',
      tags: [
        ['e', reaction.id],
        ['k', '7'],
      ],
    },
    reactor,
  );
  events.push(removal);
  for (const listener of listeners)
    if (matchFilters(listener.filters, removal))
      listener.options.onEvent?.(new ClientEvent(undefined, removal));
  await vi.waitFor(() => expect(displayed()[0]?.meta.reactions).toHaveLength(0));
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 23,
      content: '',
      tags: [
        ['e', original.id],
        ['k', '9'],
      ],
    },
    key,
  );
  events.push(deletion);
  for (const listener of listeners)
    if (matchFilters(listener.filters, deletion))
      listener.options.onEvent?.(new ClientEvent(undefined, deletion));
  await vi.waitFor(() => expect(displayed()[0]?.meta.deleted).toBeTruthy());
  await runtime.open(encodeRoomLink(group));
  expect(displayed()[0]?.meta.deleted).toBeTruthy();
});

it('shows an edited replacement to a fresh client after relays have removed its original', async () => {
  const author = generateSecretKey(),
    metadata = room(author, 'removed-original');
  const group = parsePublicRoom(metadata);
  const original = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Original', tags: [['a', group.address]] },
    author,
  );
  const replacement = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Replacement',
      tags: [
        ['a', group.address],
        ['e', original.id, '', 'edit'],
      ],
    },
    author,
  );
  const latest = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Latest replacement',
      tags: [
        ['a', group.address],
        ['e', replacement.id, '', 'edit'],
        ['e', original.id],
      ],
    },
    author,
  );
  const { runtime } = setup([metadata, latest, replacement]);
  const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
  await runtime.open(encodeRoomLink(group));
  const displayed = () =>
    get(runtime.state).messages.map((event) => publicMessageState(event, group));
  await vi.waitFor(() =>
    expect(displayed().map((message) => message.text)).toEqual(['Latest replacement']),
  );
  expect(displayed()[0].meta.edited).toBeTruthy();
  await runtime.open(encodeRoomLink(group));
  expect(displayed().map((message) => message.text)).toEqual(['Latest replacement']);
});

it.each([false, true])(
  'resolves an edited pin with its original removed (outside the loaded window: %s)',
  async (outsideWindow) => {
    const key = generateSecretKey();
    const address = `34550:${getPublicKey(key)}:edited-pin`;
    const original = finalizeEvent(
      { kind: 9, created_at: 20, content: 'Welcome', tags: [['a', address]] },
      key,
    );
    const replacement = finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        content: 'Welcome to Anagram!',
        tags: [
          ['a', address],
          ['e', original.id, '', 'edit'],
        ],
      },
      key,
    );
    const metadata = room(key, 'edited-pin', [
      ['pinned', original.id],
      ['relay', 'wss://stalled.example.org/'],
    ]);
    const recent = Array.from({ length: outsideWindow ? 55 : 0 }, (_, n) =>
      finalizeEvent(
        { kind: 9, created_at: 100 + n, content: `Recent ${n}`, tags: [['a', address]] },
        key,
      ),
    );
    const { runtime, subscriptions, events } = setup(
      [metadata, replacement, ...recent],
      key,
      (url) => !url.includes('stalled'),
    );
    await runtime.open(encodeRoomLink(parsePublicRoom(metadata)));
    await vi.waitFor(() =>
      expect(get(runtime.state).messages).toHaveLength(outsideWindow ? 50 : 1),
    );
    const window = get(runtime.state).messages.map((event) => event.id);
    const pinRequests = () =>
      subscriptions.filter((filters) => filters.some((filter) => filter.ids?.includes(original.id)))
        .length;
    const requests = pinRequests();
    const pinned = await runtime.pinnedMessage(outsideWindow);
    expect(pinned?.text).toBe('Welcome to Anagram!');
    expect(pinned?.meta.edited).toBeTruthy();
    if (!outsideWindow) expect(pinRequests()).toBe(requests);
    expect(get(runtime.state).messages.map((event) => event.id)).toEqual(window);
    // Once cached, neither the preview nor navigation needs a relay.
    events.length = 0;
    const cachedRequests = pinRequests();
    expect((await runtime.pinnedMessage())?.text).toBe('Welcome to Anagram!');
    expect((await runtime.jumpToMessage(original.id))?.id).toBe(replacement.id);
    expect(pinRequests()).toBe(cachedRequests);
  },
);

it('pages edited replacements whose originals were already removed by relays', async () => {
  const author = generateSecretKey(),
    metadata = room(author, 'paged-edits');
  const group = parsePublicRoom(metadata);
  const original = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Old original', tags: [['a', group.address]] },
    author,
  );
  const replacement = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Older replacement',
      tags: [
        ['a', group.address],
        ['e', original.id, '', 'edit'],
      ],
    },
    author,
  );
  const recent = Array.from({ length: 50 }, (_, index) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 100 + index,
        content: `Recent ${index}`,
        tags: [['a', group.address]],
      },
      author,
    ),
  );
  const { runtime } = setup([metadata, replacement, ...recent]);
  await runtime.open(encodeRoomLink(group));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  await runtime.older();
  const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
  expect(
    get(runtime.state).messages.map((event) => publicMessageState(event, group).text),
  ).toContain('Older replacement');
});

it('pins only as owner, keeps the pin across profile edits, and loads an old pin without changing the message window', async () => {
  const key = generateSecretKey(),
    definition = room(key, 'pins');
  const address = `34550:${getPublicKey(key)}:pins`;
  const notes = Array.from({ length: 80 }, (_, i) =>
    finalizeEvent(
      { kind: 9, created_at: 100 + i, tags: [['a', address]], content: `Pinned history ${i}` },
      key,
    ),
  );
  const f = setup([definition, ...notes], key);
  await f.runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await vi.waitFor(() =>
    expect(get(f.runtime.state).messages.some((message) => message.id === notes[79].id)).toBe(true),
  );
  await f.runtime.pinMessage(notes[79].id);
  expect(get(f.runtime.state).room?.pinned).toBe(notes[79].id);
  await f.runtime.update({ about: 'Updated description' }, get(f.runtime.state).room!.event.id!);
  expect(get(f.runtime.state).room?.pinned).toBe(notes[79].id);
  // Simulate a signed remote profile pin to a message outside the bounded window.
  const latest = room(
    key,
    'pins',
    [['pinned', notes[0].id]],
    get(f.runtime.state).room!.event.created_at + 1,
  );
  f.events.push(latest);
  await f.runtime.open(encodeRoomLink(parsePublicRoom(latest)));
  await vi.waitFor(() => expect(get(f.runtime.state).messages.length).toBeGreaterThan(0));
  const window = get(f.runtime.state).messages.map((m) => m.id);
  expect(window).not.toContain(notes[0].id);
  expect((await f.runtime.pinnedMessage())?.text).toBe('Pinned history 0');
  expect(get(f.runtime.state).messages.map((m) => m.id)).toEqual(window);
  await f.runtime.pinMessage(null);
  expect(get(f.runtime.state).room?.pinned).toBeUndefined();
  const member = setup(f.events);
  await member.runtime.open(encodeRoomLink(parsePublicRoom(latest)));
  await expect(member.runtime.pinMessage(notes[0].id)).rejects.toThrow(
    'Only the current group owner',
  );
});

it('seeds the verified starter group offline, once per account, without opening its timeline', async () => {
  const key = generateSecretKey();
  const seed = STARTER_PUBLIC_GROUP as Event;
  expect(parsePublicRoom(seed).address).toBe(
    '34550:c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1:c609a674-94c2-4af3-a810-ffbbdd7ac4cb',
  );
  const { runtime, subscriptions, setAccount } = setup([], key, false, seed);
  await runtime.init();
  expect(get(runtime.state).rooms.map((row) => row.room.name)).toEqual(['Anagram rants']);
  expect(get(runtime.state).room).toBeNull();
  expect(subscriptions).toEqual([]);
  const address = get(runtime.state).rooms[0].address;
  await runtime.leave(address);
  runtime.stop();
  await runtime.init();
  expect(get(runtime.state).rooms).toEqual([]);
  setAccount(getPublicKey(generateSecretKey()));
  await runtime.init();
  expect(get(runtime.state).rooms).toHaveLength(1);
  setAccount(getPublicKey(key));
  await runtime.init();
  expect(get(runtime.state).rooms).toEqual([]);
});

it('does not replace newer cached starter profiles during concurrent seeding', async () => {
  const account = getPublicKey(generateSecretKey());
  const key = generateSecretKey();
  const older = parsePublicRoom(room(key, 'starter', [], 1));
  const newer = parsePublicRoom(room(key, 'starter', [], 2));
  const db = new PublicGroupData(account);
  try {
    await db.save({ address: newer.address, room: newer, joined: true, updated: 123 });
    await Promise.all([db.seed(older), db.seed(older)]);
    expect((await db.get(newer.address))?.room.event.id).toBe(newer.event.id);
    expect((await db.get(newer.address))?.updated).toBe(123);
  } finally {
    await db.close();
  }
});

it.each(['one', 'all'])(
  'keeps live edits and later messages when %s original-lookup relays fail',
  async (failure) => {
    const author = generateSecretKey();
    const metadata = room(author, `lookup-${failure}`, [['relay', 'wss://offline.example.org/']]);
    const group = parsePublicRoom(metadata);
    const { runtime, listeners } = setup(
      [metadata],
      author,
      (_url, filters) => !filters.some((filter) => filter.ids),
    );
    await runtime.open(encodeRoomLink(group));
    const original = finalizeEvent(
      { kind: 9, created_at: 20, content: 'Removed original', tags: [['a', group.address]] },
      author,
    );
    const replacement = finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        content: 'Edited welcome',
        tags: [
          ['a', group.address],
          ['e', original.id, '', 'edit'],
        ],
      },
      author,
    );
    const later = finalizeEvent(
      { kind: 9, created_at: 21, content: 'Later post', tags: [['a', group.address]] },
      author,
    );
    for (const event of [replacement, later])
      for (const listener of [...listeners])
        if (matchFilters(listener.filters, event))
          listener.options.onEvent?.(new ClientEvent(undefined, event));
    await vi.waitFor(() =>
      expect(
        [...listeners].filter((listener) =>
          listener.filters.some((filter) => filter.ids?.includes(original.id)),
        ),
      ).toHaveLength(2),
    );
    for (const listener of [...listeners].filter((listener) =>
      listener.filters.some((filter) => filter.ids?.includes(original.id)),
    )) {
      if (failure === 'one' && listener.options.relayUrls?.[0] === 'wss://relay.example.org/')
        listener.options.onEose?.();
      else listener.options.onClose?.();
    }
    await vi.waitFor(() =>
      expect(get(runtime.state).messages.map((event) => event.content)).toEqual([
        'Edited welcome',
        'Later post',
      ]),
    );
    expect(get(runtime.state).error).toBe('');
    const db = new PublicGroupData(getPublicKey(author));
    expect((await db.message(group.address, replacement.id))?.content).toBe('Edited welcome');
    expect((await db.message(group.address, later.id))?.content).toBe('Later post');
    await db.close();
  },
);

it('still reports genuine local storage failures when saving live public messages', async () => {
  const author = generateSecretKey();
  const metadata = room(author, 'failed-write');
  const group = parsePublicRoom(metadata);
  const { runtime, listeners } = setup([metadata], author);
  await runtime.open(encodeRoomLink(group));
  vi.spyOn(PublicGroupData.prototype, 'putMany').mockRejectedValueOnce(
    new Error('Disk write failed'),
  );
  const event = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Unsaved', tags: [['a', group.address]] },
    author,
  );
  for (const listener of [...listeners])
    if (matchFilters(listener.filters, event))
      listener.options.onEvent?.(new ClientEvent(undefined, event));
  await vi.waitFor(() =>
    expect(get(runtime.state).error).toBe('Could not save public messages. Refresh to retry.'),
  );
  expect(get(runtime.state).messages).toHaveLength(0);
});

it('keeps a cached public group writable when one relay answers empty and another stalls', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'cached-empty-replica', [['relay', 'wss://stalled.example.org/']]);
  const { runtime, events } = setup([definition], key, (url) => !url.includes('stalled'));
  const link = encodeRoomLink(parsePublicRoom(definition));
  await runtime.open(link);
  events.length = 0;
  await runtime.open(link);
  expect(get(runtime.state).room?.event.id).toBe(definition.id);
  expect(get(runtime.state).stale).toBe(false);
  expect(get(runtime.state).error).toBe('');
  await runtime.send('One responding replica is enough');
});

it('loads a pin and jumps to its message through one completed replica', async () => {
  const key = generateSecretKey();
  const address = `34550:${getPublicKey(key)}:pin-replicas`;
  const messages = Array.from({ length: 55 }, (_, n) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 100 + n,
        content: `Pin replica message ${n}`,
        tags: [['a', address]],
      },
      key,
    ),
  );
  const definition = room(key, 'pin-replicas', [
    ['relay', 'wss://stalled.example.org/'],
    ['pinned', messages[0].id],
  ]);
  const { runtime } = setup([definition, ...messages], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  expect(get(runtime.state).messages.some((event) => event.id === messages[0].id)).toBe(false);
  expect((await runtime.pinnedMessage())?.text).toBe('Pin replica message 0');
  expect((await runtime.jumpToMessage(messages[1].id))?.id).toBe(messages[1].id);
  expect(get(runtime.state).error).toBe('');
});

it('returns a short history page without waiting for a stalled replica or claiming full coverage', async () => {
  const key = generateSecretKey();
  const definition = room(key, 'short-history', [['relay', 'wss://stalled.example.org/']]);
  const address = parsePublicRoom(definition).address;
  const messages = Array.from({ length: 55 }, (_, n) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: 100 + n,
        content: `Short page message ${n}`,
        tags: [['a', address]],
      },
      key,
    ),
  );
  const { runtime } = setup([definition, ...messages], key, (url) => !url.includes('stalled'));
  await runtime.open(encodeRoomLink(parsePublicRoom(definition)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  await runtime.older();
  expect(get(runtime.state).messages).toHaveLength(55);
  expect(get(runtime.state).messages[0].content).toBe('Short page message 0');
  expect(get(runtime.state).more).toBe(true);
  expect(get(runtime.state).error).toBe('');
});

it.each([false, true])(
  'resolves cached edited reply parents, including deleted ones (%s)',
  async (deleted) => {
    const key = generateSecretKey(),
      metadata = room(key, 'edited-reply');
    const group = parsePublicRoom(metadata);
    const original = finalizeEvent(
      { kind: 9, created_at: 20, content: 'Original', tags: [['a', group.address]] },
      key,
    );
    const replacement = finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        content: 'Edited parent',
        tags: [
          ['a', group.address],
          ['e', original.id, '', 'edit'],
        ],
      },
      key,
    );
    const latest = finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        content: 'Latest parent',
        tags: [
          ['a', group.address],
          ['e', replacement.id, '', 'edit'],
          ['e', original.id],
        ],
      },
      key,
    );
    const reply = finalizeEvent(
      {
        kind: 9,
        created_at: 21,
        content: 'Reply',
        tags: [
          ['a', group.address],
          ['q', original.id, '', getPublicKey(key)],
        ],
      },
      key,
    );
    const removal = finalizeEvent(
      {
        kind: 5,
        created_at: 22,
        content: '',
        tags: [
          ['h', group.address],
          ['e', latest.id],
        ],
      },
      key,
    );
    const { runtime, events, subscriptions } = setup([
      metadata,
      replacement,
      latest,
      reply,
      ...(deleted ? [removal] : []),
    ]);
    const { publicMessageState } = await import('#src/stores/nostr/publicMessageActions.ts');
    const displayedReply = () =>
      get(runtime.state)
        .messages.map((e) => publicMessageState(e, group))
        .find((m) => m.text === 'Reply');
    await runtime.open(encodeRoomLink(group));
    await vi.waitFor(() =>
      expect(displayedReply()?.meta.reply?.text).toBe(
        deleted ? 'Message deleted' : 'Latest parent',
      ),
    );
    expect(displayedReply()?.meta.reply?.eventId).toBe(original.id);
    // Restoring the cached thread must also resolve the old reference offline.
    events.splice(0, events.length, metadata);
    await runtime.open(encodeRoomLink(group));
    expect(displayedReply()?.meta.reply?.text).toBe(deleted ? 'Message deleted' : 'Latest parent');
    // No unbounded history/filter reads were introduced for preview hydration.
    expect(
      subscriptions.flat().every((f) => f.ids || f['#e'] || f.limit || f.since !== undefined),
    ).toBe(true);
  },
);

it('accepts a verified pinned event without EOSE and closes its lookup subscriptions', async () => {
  const key = generateSecretKey(),
    address = `34550:${getPublicKey(key)}:pin-without-eose`;
  const pin = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Received without EOSE', tags: [['a', address]] },
    key,
  );
  const metadata = room(key, 'pin-without-eose', [['pinned', pin.id]]);
  const { runtime, events, listeners } = setup(
    [metadata],
    key,
    (_url, filters) => !filters.some((f) => f.ids?.includes(pin.id)),
  );
  await runtime.open(encodeRoomLink(parsePublicRoom(metadata)));
  await vi.waitFor(() => expect(get(runtime.state).loading).toBe(false));
  events.push(pin);
  const before = get(runtime.state).more;
  expect((await runtime.pinnedMessage())?.text).toBe(pin.content);
  expect([...listeners].some((l) => l.filters.some((f) => f.ids?.includes(pin.id)))).toBe(false);
  expect(get(runtime.state).more).toBe(before);
}, 3000);

it('fetches a pin with many retained edit versions when the original has disappeared', async () => {
  const key = generateSecretKey(),
    address = `34550:${getPublicKey(key)}:many-pin-edits`;
  const original = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Original', tags: [['a', address]] },
    key,
  );
  let previous = original;
  const edits = Array.from({ length: 12 }, (_, n) => {
    previous = finalizeEvent(
      {
        kind: 9,
        created_at: 20,
        content: `Available edit ${n}`,
        tags: [
          ['a', address],
          ['e', previous.id, '', 'edit'],
          ['e', original.id],
        ],
      },
      key,
    );
    return previous;
  });
  const recent = Array.from({ length: 55 }, (_, n) =>
    finalizeEvent(
      { kind: 9, created_at: 100 + n, content: `Recent ${n}`, tags: [['a', address]] },
      key,
    ),
  );
  const metadata = room(key, 'many-pin-edits', [['pinned', original.id]]);
  const { runtime } = setup([metadata, ...edits, ...recent]);
  await runtime.open(encodeRoomLink(parsePublicRoom(metadata)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(50));
  expect((await runtime.pinnedMessage())?.text).toMatch(/^Available edit /);
  expect(get(runtime.state).messages).toHaveLength(50);
  expect((await runtime.jumpToMessage(original.id))?.content).toMatch(/^Available edit /);
});

it('does not accept invalid, wrong-room or blocked pin events before EOSE', async () => {
  const key = generateSecretKey(),
    other = generateSecretKey();
  const address = `34550:${getPublicKey(key)}:pin-verification`;
  const pin = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Expected', tags: [['a', address]] },
    key,
  );
  const metadata = room(key, 'pin-verification', [
    ['pinned', pin.id],
    ['blocked', getPublicKey(other)],
  ]);
  const { runtime, listeners } = setup(
    [metadata],
    key,
    (_url, fs) => !fs.some((f) => f.ids?.includes(pin.id)),
  );
  await runtime.open(encodeRoomLink(parsePublicRoom(metadata)));
  await vi.waitFor(() => expect(get(runtime.state).loading).toBe(false));
  let settled = false;
  const pending = runtime.pinnedMessage().then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await vi.waitFor(() =>
    expect([...listeners].some((l) => l.filters.some((f) => f.ids?.includes(pin.id)))).toBe(true),
  );
  const lookups = [...listeners].filter((l) => l.filters.some((f) => f.ids?.includes(pin.id)));
  const wrongRoom = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Wrong room',
      tags: [
        ['a', `${address}-other`],
        ['e', pin.id, '', 'edit'],
      ],
    },
    key,
  );
  const blocked = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Blocked',
      tags: [
        ['a', address],
        ['e', pin.id, '', 'edit'],
      ],
    },
    other,
  );
  for (const event of [{ ...pin, content: 'Tampered signature' }, wrongRoom, blocked]) {
    for (const l of lookups) l.options.onEvent?.(new ClientEvent(undefined, event));
  }
  await Promise.resolve();
  expect(settled).toBe(false);
  for (const l of lookups) l.options.onClose?.();
  expect(await pending).toBeInstanceOf(Error);
});

it('does not let another author replace an owner-controlled pin through a claimed edit', async () => {
  const owner = generateSecretKey(),
    attacker = generateSecretKey();
  const address = `34550:${getPublicKey(owner)}:pin-author-audit`;
  const missing = finalizeEvent(
    { kind: 9, created_at: 20, content: 'Real owner announcement', tags: [['a', address]] },
    owner,
  );
  const metadata = room(owner, 'pin-author-audit', [['pinned', missing.id]]);
  const claimedEdit = finalizeEvent(
    {
      kind: 9,
      created_at: 20,
      content: 'Unrelated author announcement',
      tags: [
        ['a', address],
        ['e', missing.id, '', 'edit'],
      ],
    },
    attacker,
  );
  const { runtime } = setup([metadata, claimedEdit]);
  await runtime.open(encodeRoomLink(parsePublicRoom(metadata)));
  await vi.waitFor(() => expect(get(runtime.state).messages).toHaveLength(1));
  const pin = await runtime.pinnedMessage();
  expect(pin).toBeNull();
});
