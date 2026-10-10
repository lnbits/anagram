import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NostrClient, { ClientEvent, nip19 } from '#src/lib/nostr/client.ts';
import { searchRelayProfiles } from '#src/stores/nostr/profileSearchRuntime.ts';
const key = 'a'.repeat(64),
  other = 'b'.repeat(64);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const client = new NostrClient();
  const requests: Array<{ filter: any; options: any; stop: ReturnType<typeof vi.fn> }> = [];
  vi.spyOn(client, 'subscribe').mockImplementation((filter, options) => {
    const stop = vi.fn();
    requests.push({ filter, options, stop });
    return { stop } as any;
  });
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    onResults: vi.fn(),
    isBlocked: () => false,
    resolveNip05: vi.fn(),
  };
  return { client, requests, controller, options };
}
function event(client: NostrClient, pubkey = key, created_at = 10, name = 'Alice') {
  return new ClientEvent(client, {
    kind: 0,
    pubkey,
    created_at,
    id: String(created_at).padStart(64, '0'),
    content: JSON.stringify({ name, picture: 'https://image.test/a.png' }),
    tags: [],
  });
}
it('streams matching profiles before EOSE, selects newest metadata and bounds silent relays', async () => {
  const f = fixture();
  const done = searchRelayProfiles(
    f.client,
    'alice',
    ['wss://one.test', 'wss://silent.test'],
    f.options,
  );
  expect(f.requests[0].filter).toEqual({ kinds: [0], search: 'alice', limit: 20 });
  f.requests[0].options.onEvent(event(f.client));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ publicKey: key, name: 'Alice' }),
  ]);
  f.requests[0].options.onEvent(event(f.client, key, 5, 'Alice stale'));
  f.requests[0].options.onEvent(event(f.client, other, 10, 'Unrelated'));
  expect(f.options.onResults).toHaveBeenCalledTimes(1);
  f.requests[0].options.onEvent(event(f.client, key, 20, 'Alice latest'));
  f.requests[0].options.onEose();
  await vi.advanceTimersByTimeAsync(6000);
  expect(await done).toBe('complete');
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'Alice latest' }),
  ]);
  expect(f.requests.every((r) => r.stop.mock.calls.length === 1)).toBe(true);
});
it('cancels subscriptions and ignores results from an old search', async () => {
  const f = fixture();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], f.options);
  f.controller.abort();
  f.requests[0].options.onEvent(event(f.client));
  expect(await done).toBe('complete');
  expect(f.options.onResults).not.toHaveBeenCalled();
  expect(f.requests[0].stop).toHaveBeenCalledOnce();
});
it('resolves exact NIP-05 addresses authoritatively and follows their relay hints', async () => {
  const f = fixture();
  f.options.resolveNip05.mockResolvedValue({
    isValid: true,
    normalizedPubkey: key,
    relays: ['wss://hint.test'],
  });
  const done = searchRelayProfiles(f.client, 'alice@example.com', ['wss://one.test'], f.options);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0].filter).toEqual({ kinds: [0], authors: [key], limit: 1 });
  f.requests[0].options.onEvent(event(f.client, other));
  expect(f.options.onResults).toHaveBeenCalledTimes(1);
  f.requests[0].options.onEvent(event(f.client));
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ publicKey: key, nip05: 'alice@example.com', name: 'Alice' }),
  ]);
  f.controller.abort();
  await done;
});
it('does not send private keys to relays or NIP-05 endpoints, and supports public identifiers', async () => {
  const f = fixture();
  const secret = nip19.nsecEncode(new Uint8Array(32).fill(1));
  expect(await searchRelayProfiles(f.client, secret, ['wss://one.test'], f.options)).toBe(
    'invalid',
  );
  expect(f.requests).toHaveLength(0);
  expect(f.options.resolveNip05).not.toHaveBeenCalled();
  const done = searchRelayProfiles(
    f.client,
    nip19.nprofileEncode({ pubkey: key, relays: ['wss://hint.test'] }),
    [],
    f.options,
  );
  expect(f.requests[0].filter.authors).toEqual([key]);
  f.controller.abort();
  await done;
});

it('finds matching profiles through a bounded ordinary read when search is rejected', async () => {
  const f = fixture();
  const done = searchRelayProfiles(f.client, 'alice', ['wss://one.test'], f.options);
  expect(f.requests[1].filter).toEqual({ kinds: [0], limit: 100 });
  f.requests[0].options.onClose(); // CLOSED: unrecognised filter item: search
  f.requests[1].options.onEvent(event(f.client, other, 10, 'Unrelated'));
  f.requests[1].options.onEvent(event(f.client));
  f.requests[1].options.onEose();
  expect(await done).toBe('complete');
  expect(f.options.onResults).toHaveBeenLastCalledWith([
    expect.objectContaining({ name: 'Alice' }),
  ]);
  expect(f.requests.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
});
