import { afterEach, expect, it, vi } from 'vitest';
import { paceRelayRequests } from '#src/lib/nostr/relayPacing.ts';
afterEach(() => vi.useRealTimers());
it('bounds startup bursts, prioritizes outgoing events and cancels unsent history requests', async () => {
  vi.useFakeTimers();
  const frames: string[][] = [];
  const relay = {
    send: vi.fn(async (message: string) => {
      frames.push(JSON.parse(message));
    }),
    close: vi.fn(),
  };
  paceRelayRequests(relay);
  const requests = Array.from({ length: 12 }, (_, i) =>
    relay.send(JSON.stringify(['REQ', String(i), {}])),
  );
  const event = relay.send(JSON.stringify(['EVENT', 'outgoing']));
  await relay.send(JSON.stringify(['CLOSE', '9']));
  await relay.send(JSON.stringify(['AUTH', 'challenge']));
  expect(frames.filter((f) => f[0] === 'REQ')).toHaveLength(8);
  expect(frames.at(-1)?.[0]).toBe('AUTH');
  await vi.advanceTimersByTimeAsync(120);
  await Promise.all([...requests, event]);
  expect(frames.slice(10).map((f) => f.slice(0, 2))).toEqual([
    ['EVENT', 'outgoing'],
    ['REQ', '8'],
    ['REQ', '10'],
    ['REQ', '11'],
  ]);
});
it('does not publish queued messages after closing the relay', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_message: string) => {}),
    close = vi.fn();
  const relay = { send, close };
  paceRelayRequests(relay);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => relay.send(JSON.stringify(['REQ', String(i)]))),
  );
  const pending = relay.send(JSON.stringify(['EVENT', 'queued']));
  const rejected = expect(pending).rejects.toThrow('Relay closed before publish');
  relay.close();
  await rejected;
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(8);
  expect(close).toHaveBeenCalledOnce();
});

it('spreads recovery sends, cancels expired publications, and discards work on account change', async () => {
  vi.useFakeTimers();
  const { RelayTrafficPolicy } = await import('#src/stores/nostr/relayTrafficPolicy.ts');
  const policy = new RelayTrafficPolicy();
  policy.rateLimited('EVENT', 'rate-limited: wait', 1000);
  await vi.advanceTimersByTimeAsync(1000);
  const wire: string[] = [];
  let account = 'first';
  const relay = {
    send: vi.fn(async (message: string) => {
      wire.push(message);
    }),
    close: vi.fn(),
    publishTimeout: 100,
  };
  const paced = paceRelayRequests(relay, policy, undefined, () => account);
  await relay.send('["EVENT",{"id":"first"}]');
  const stale = relay.send('["EVENT",{"id":"stale"}]');
  const expired = expect(stale).rejects.toThrow('timed out before send');
  await vi.advanceTimersByTimeAsync(250);
  await expired;
  expect(wire).toHaveLength(1);
  await relay.send('["EVENT",{"id":"second"}]');
  const wrongAccount = relay.send('["EVENT",{"id":"wrong-account"}]');
  const cancelled = expect(wrongAccount).rejects.toThrow('account change');
  account = 'second';
  await vi.advanceTimersByTimeAsync(250);
  await cancelled;
  expect(wire).toHaveLength(2);
  const next = relay.send('["EVENT",{"id":"next"}]');
  await next;
  const pending = relay.send('["EVENT",{"id":"disconnected"}]');
  const disconnected = expect(pending).rejects.toThrow('Relay closed before publish');
  paced.cancel();
  await disconnected;
  await vi.advanceTimersByTimeAsync(1000);
  expect(wire).toHaveLength(3);
});

it('cancels a queued REQ before the recovery budget releases it', async () => {
  vi.useFakeTimers();
  const { RelayTrafficPolicy } = await import('#src/stores/nostr/relayTrafficPolicy.ts');
  const policy = new RelayTrafficPolicy();
  policy.rateLimited('REQ', 'rate-limited: wait', 1000);
  await vi.advanceTimersByTimeAsync(1000);
  const send = vi.fn(async (_message: string) => {});
  const relay = { send, close: vi.fn() };
  paceRelayRequests(relay, policy);
  await relay.send('["REQ","one",{}]');
  const queued = relay.send('["REQ","two",{}]');
  await relay.send('["CLOSE","two"]');
  await queued;
  await vi.advanceTimersByTimeAsync(1000);
  expect(send.mock.calls.map(([message]) => JSON.parse(message)[0])).toEqual(['REQ', 'CLOSE']);
});

it('shares one burst budget across many group sockets and prioritizes account publications', async () => {
  vi.useFakeTimers();
  const { RelayTrafficPolicy } = await import('#src/stores/nostr/relayTrafficPolicy.ts');
  const policy = new RelayTrafficPolicy();
  const frames: unknown[][] = [];
  const sockets = Array.from({ length: 20 }, () => {
    const relay = {
      send: vi.fn(async (message: string) => {
        frames.push(JSON.parse(message));
      }),
      close: vi.fn(),
    };
    paceRelayRequests(relay, policy);
    return relay;
  });
  const requests = sockets.map((socket, i) => socket.send(JSON.stringify(['REQ', String(i)])));
  expect(frames).toHaveLength(8);
  const publication = sockets[0].send('["EVENT","personal-message"]');
  // Closing one group must neither cancel another group's same-ID request nor reset the budget.
  sockets[8].close();
  await vi.advanceTimersByTimeAsync(119);
  expect(frames).toHaveLength(8);
  await vi.advanceTimersByTimeAsync(1);
  expect(frames).toHaveLength(16);
  expect(frames[8]).toEqual(['EVENT', 'personal-message']);
  expect(frames).not.toContainEqual(['REQ', '8']);
  await vi.advanceTimersByTimeAsync(120);
  await Promise.all([...requests, publication]);
  expect(frames).toHaveLength(20);
});

it('cancels only the requesting socket when multiple group subscriptions reuse an ID', async () => {
  vi.useFakeTimers();
  const { RelayTrafficPolicy } = await import('#src/stores/nostr/relayTrafficPolicy.ts');
  const policy = new RelayTrafficPolicy();
  const wireA = vi.fn(async (_message: string) => {}),
    wireB = vi.fn(async (_message: string) => {});
  const a = { send: wireA, close: vi.fn() },
    b = { send: wireB, close: vi.fn() };
  paceRelayRequests(a, policy);
  paceRelayRequests(b, policy);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => a.send(JSON.stringify(['REQ', String(i)]))),
  );
  const first = a.send('["REQ","same"]'),
    second = b.send('["REQ","same"]');
  await a.send('["CLOSE","same"]');
  await vi.advanceTimersByTimeAsync(120);
  await Promise.all([first, second]);
  expect(wireA.mock.calls.map(([message]) => JSON.parse(message))).not.toContainEqual([
    'REQ',
    'same',
  ]);
  expect(wireB).toHaveBeenCalledWith('["REQ","same"]');
});
