import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NostrClient, { guardRelayTraffic } from '#src/lib/nostr/client.ts';
import { RelayTrafficPolicy } from '#src/stores/nostr/relayTrafficPolicy.ts';
import { normalizeMessageRelayStatus } from '#src/utils/messageRelayStatus.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function transport(policy = new RelayTrafficPolicy()) {
  const relay = new AbstractRelay('wss://policy.example/', { verifyEvent: () => true });
  Object.defineProperty(relay, 'connected', { get: () => true });
  const wire: unknown[][] = [];
  relay.send = vi.fn(async (message) => {
    wire.push(JSON.parse(message));
  });
  relay.close = vi.fn();
  guardRelayTraffic(relay, policy);
  const receive = (frame: unknown[]) =>
    relay._onmessage({ data: JSON.stringify(frame) } as MessageEvent);
  return { relay, wire, receive, policy };
}

it('honours publish retry hints for every sender, across replacement sockets, without blocking reads or AUTH', async () => {
  const { relay, wire, receive, policy } = transport();
  const event = { id: 'event-1' } as never;
  const published = relay.publish(event);
  const failed = expect(published).rejects.toThrow('rate-limited');
  receive(['OK', 'event-1', false, 'rate-limited: slow down', '45000']);
  await failed;
  expect(policy.delay('EVENT')).toBe(45000);
  await expect(relay.publish({ id: 'event-2' } as never)).rejects.toThrow('rate-limited');
  await relay.send('["AUTH",{"id":"auth"}]');
  await relay.send('["REQ","query",{"kinds":[1059]}]');
  expect(wire.map((frame) => frame[0])).toEqual(['EVENT', 'AUTH', 'REQ']);
  relay.close();
  const replacement = transport(policy);
  await expect(replacement.relay.publish({ id: 'event-3' } as never)).rejects.toThrow(
    'rate-limited',
  );
  expect(replacement.wire).toEqual([]);
  await vi.advanceTimersByTimeAsync(45000);
  const resumed = replacement.relay.publish({ id: 'event-3' } as never);
  replacement.receive(['OK', 'event-3', true, '']);
  await expect(resumed).resolves.toBe('');
  expect(replacement.wire).toHaveLength(1);
});

it('reports held REQs through CLOSED without false EOSE, and isolates COUNT limits', async () => {
  const { relay, receive, policy, wire } = transport();
  const closed = vi.fn(),
    eose = vi.fn();
  relay.subscribe([{ kinds: [1059] }], {
    id: 'inbox',
    onclose: closed,
    oneose: eose,
    eoseTimeout: 2147483647,
  });
  receive(['CLOSED', 'inbox', 'rate-limited: wait', '60000']);
  expect(policy.delay('REQ')).toBe(60000);
  const held = vi.fn();
  relay.subscribe([{ kinds: [0] }], {
    id: 'profile',
    onclose: held,
    oneose: eose,
    eoseTimeout: 2147483647,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(held).toHaveBeenCalledWith(expect.stringContaining('rate-limited'));
  expect(wire.filter((frame) => frame[0] === 'REQ')).toHaveLength(1);
  expect(eose).not.toHaveBeenCalled();
  const count = relay.count([{ kinds: [0] }], { id: 'count' });
  const rejected = expect(count).rejects.toThrow('rate-limited');
  receive(['CLOSED', 'count', 'rate-limited: count slower', '120000']);
  await rejected;
  expect(policy.delay('COUNT')).toBe(120000);
  expect(policy.delay('REQ')).toBe(60000);
  expect(policy.delay('EVENT')).toBe(0);
});

it('distinguishes an unprefixed server refusal from a network failure and preserves auth handling', async () => {
  const { relay, receive, policy } = transport();
  const rejected = relay.publish({ id: 'refused' } as never);
  const assertion = expect(rejected).rejects.toThrow('relay-rejected: no writes here');
  receive(['OK', 'refused', false, 'no writes here']);
  await assertion;
  await relay.send('["AUTH",{"id":"auth"}]');
  receive(['OK', 'auth', false, 'rate-limited: auth refused', '60000']);
  expect(policy.delay('EVENT')).toBe(0);
});

it('backs off explicit rate-limit bans without a hint, and does not shorten an existing pause', async () => {
  const { relay, receive, policy } = transport();
  const result = relay.publish({ id: 'banned' } as never);
  const rejected = expect(result).rejects.toThrow('banned:');
  receive(['OK', 'banned', false, 'banned: too many rate-limit violations, try again later']);
  await rejected;
  expect(policy.delay('EVENT')).toBe(300000);
  policy.rateLimited('EVENT', 'rate-limited: wait', '1');
  expect(policy.delay('EVENT')).toBe(300000);
});

it('retains retry deadlines through persisted status normalization and keeps relay state isolated', () => {
  const retry_after = new Date(Date.now() + 120000).toISOString();
  expect(
    normalizeMessageRelayStatus({
      relay_url: 'wss://policy.example/',
      direction: 'outbound',
      scope: 'recipient',
      status: 'failed',
      retry_after,
    }),
  ).toMatchObject({ retry_after });
  const client = new NostrClient(),
    other = new NostrClient();
  client
    .relayTrafficPolicy('wss://policy.example')
    .rateLimited('EVENT', 'rate-limited: wait', 60000);
  expect(client.relayTrafficPolicy('wss://policy.example/').delay('EVENT')).toBe(60000);
  expect(client.relayTrafficPolicy('wss://healthy.example/').delay('EVENT')).toBe(0);
  expect(other.relayTrafficPolicy('wss://policy.example/').delay('EVENT')).toBe(0);
});

it('still reads rate-limit feedback after a live subscription reached EOSE', async () => {
  const { relay, receive, policy } = transport();
  const closed = vi.fn();
  relay.subscribe([{ kinds: [1059] }], { id: 'live', onclose: closed, eoseTimeout: 2147483647 });
  receive(['EOSE', 'live']);
  receive(['CLOSED', 'live', 'rate-limited: wait', '90000']);
  expect(policy.delay('REQ')).toBe(90000);
  expect(closed).toHaveBeenCalledWith('rate-limited: wait');
});

it('does not close a replacement subscription when an older queued rejection is delivered', async () => {
  const { relay, policy } = transport();
  policy.rateLimited('REQ', 'rate-limited: wait', 1000);
  const old = relay.subscribe([{ kinds: [0] }], { id: 'same', eoseTimeout: 2147483647 });
  old.close();
  // Reach the deadline without flushing the queued close callback.
  vi.setSystemTime(Date.now() + 1000);
  const closed = vi.fn();
  const replacement = relay.subscribe([{ kinds: [1059] }], {
    id: 'same',
    onclose: closed,
    eoseTimeout: 2147483647,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).not.toHaveBeenCalled();
  expect(relay.openSubs.get('same')).toBe(replacement);
  replacement.close();
});

it('rejects a recovery backlog before its publication timers expire, without later wire sends', async () => {
  const { relay, policy, wire, receive } = transport();
  relay.publishTimeout = 100;
  policy.rateLimited('EVENT', 'rate-limited: wait', 1);
  vi.setSystemTime(Date.now() + 1);
  const first = relay.publish({ id: 'first' } as never);
  receive(['OK', 'first', true, '']);
  await first;
  const queued = [1, 2, 3].map((id) =>
    expect(relay.publish({ id: String(id) } as never)).rejects.toThrow('before send'),
  );
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all(queued);
  expect(wire.filter((frame) => frame[0] === 'EVENT')).toHaveLength(1);
});
