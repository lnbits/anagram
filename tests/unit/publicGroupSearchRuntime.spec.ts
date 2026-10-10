import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import NostrClient, { ClientEvent, type NostrSubscriptionOptions } from '#src/lib/nostr/client.ts';
import {
  searchRelayPublicGroups,
  publicGroupMatches,
} from '#src/stores/nostr/publicGroupSearchRuntime.ts';
import { parsePublicRoom, roomTags } from '#src/stores/nostr/publicGroups.ts';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const key = generateSecretKey();
function room(name: string, created_at = 10, slug = 'room-id') {
  return new ClientEvent(
    undefined,
    finalizeEvent(
      {
        kind: 34550,
        created_at,
        content: '',
        tags: roomTags({
          name,
          slug,
          about: 'Bitcoin community',
          picture: '',
          relays: ['wss://rooms.test'],
          trusted: [],
          blocked: [],
        }),
      },
      key,
    ),
  );
}
function fixture() {
  const requests: { options: NostrSubscriptionOptions; stop: ReturnType<typeof vi.fn> }[] = [];
  const subscribe = vi.fn((_filters, options) => {
    const stop = vi.fn();
    requests.push({ options, stop });
    return { stop };
  });
  const client = { subscribe } as unknown as NostrClient;
  const controller = new AbortController();
  const options = { signal: controller.signal, onResults: vi.fn(), isBlocked: vi.fn(() => false) };
  return { client, subscribe, controller, options, requests };
}
it('streams signed groups, filters ignored searches, and replaces stale metadata across relays', async () => {
  const f = fixture();
  const done = searchRelayPublicGroups(
    f.client,
    'LNbits',
    ['wss://rooms.test', 'wss://slow.test'],
    f.options,
  );
  expect(f.subscribe.mock.calls[0][0]).toEqual({ kinds: [34550], search: 'LNbits', limit: 40 });
  expect(f.subscribe.mock.calls[1][0]).toEqual({ kinds: [34550], limit: 100 });
  f.requests[0].options.onEvent!(room('LNbits lounge'));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'LNbits lounge' }),
  ]);
  f.requests[0].options.onEvent!(room('Unrelated', 10, 'other'));
  f.requests[2].options.onEvent!(room('LNbits updated', 20));
  f.requests[0].options.onEvent!(room('LNbits stale', 15));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'LNbits updated' }),
  ]);
  f.requests[2].options.onEvent!(room('Renamed', 30));
  expect(f.options.onResults).toHaveBeenLastCalledWith([]);
  f.requests[0].options.onEose!();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await done).toBe('complete');
  expect(f.requests.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
  expect(publicGroupMatches(parsePublicRoom(room('Lounge').rawEvent()), 'bitcoin lounge')).toBe(
    true,
  );
});
it('rejects forged, unsupported and blocked groups and cancels stale searches', async () => {
  const f = fixture();
  const done = searchRelayPublicGroups(f.client, 'LNbits', ['wss://rooms.test'], f.options);
  const forged = new ClientEvent(undefined, { ...room('LNbits').rawEvent(), content: 'tampered' });
  f.requests[0].options.onEvent!(forged);
  const unsupported = finalizeEvent(
    {
      kind: 34550,
      created_at: 10,
      content: '',
      tags: [
        ['d', 'room'],
        ['name', 'LNbits'],
      ],
    },
    key,
  );
  f.requests[0].options.onEvent!(new ClientEvent(undefined, unsupported));
  f.options.isBlocked.mockReturnValue(true);
  f.requests[0].options.onEvent!(room('LNbits'));
  expect(f.options.onResults).not.toHaveBeenCalled();
  f.controller.abort();
  f.options.isBlocked.mockReturnValue(false);
  f.requests[0].options.onEvent!(room('LNbits'));
  expect(await done).toBe('complete');
  expect(f.options.onResults).not.toHaveBeenCalled();
  expect(f.requests[0].stop).toHaveBeenCalledOnce();
});
it('bounds result counts and distinguishes no matches from unavailable relays', async () => {
  const f = fixture();
  const done = searchRelayPublicGroups(f.client, 'LNbits', ['wss://rooms.test'], f.options);
  for (let i = 0; i < 25; i++) f.requests[0].options.onEvent!(room(`LNbits ${i}`, 10, `room-${i}`));
  expect(f.options.onResults.mock.calls.at(-1)![0]).toHaveLength(20);
  f.requests.forEach(({ options }) => options.onClose!());
  expect(await done).toBe('complete');
  const empty = fixture();
  const noMatches = searchRelayPublicGroups(
    empty.client,
    'empty',
    ['wss://rooms.test'],
    empty.options,
  );
  empty.requests.forEach(({ options }) => options.onEose!());
  expect(await noMatches).toBe('complete');
  const offline = fixture();
  const unavailable = searchRelayPublicGroups(
    offline.client,
    'empty',
    ['wss://rooms.test'],
    offline.options,
  );
  await vi.advanceTimersByTimeAsync(6000);
  expect(await unavailable).toBe('unavailable');
  expect(
    await searchRelayPublicGroups(
      offline.client,
      'nsec1secret',
      ['wss://rooms.test'],
      offline.options,
    ),
  ).toBe('invalid');
  expect(offline.subscribe).toHaveBeenCalledTimes(2);
});

it('finds groups through an independent ordinary read when a relay rejects search', async () => {
  const f = fixture();
  const done = searchRelayPublicGroups(f.client, 'LNbits', ['wss://rooms.test'], f.options);
  f.requests[0].options.onClose!(); // CLOSED: unrecognised filter item: search
  f.requests[1].options.onEvent!(room('LNbits lounge'));
  f.requests[1].options.onEose!();
  expect(await done).toBe('complete');
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'LNbits lounge' }),
  ]);
  expect(f.requests.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
});
