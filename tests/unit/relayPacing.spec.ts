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
