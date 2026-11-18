import { describe, expect, it, vi } from 'vitest';
import { adaptCallEndpoint, mergeCallLanes } from '#src/services/callTransportLanes.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('independent call transport streams', () => {
  it('keeps datagram reads independent of blocked reliable video reads', async () => {
    const raw = {
      send: vi.fn(),
      close: vi.fn(),
      recv: vi.fn(),
      recv_lane: vi.fn(() => new Promise<Uint8Array>(() => {})),
      send_audio: vi.fn(),
      recv_audio: vi.fn().mockResolvedValue(new Uint8Array([9, 1, 42])),
      stats_json: () => JSON.stringify({ relayOnly: true, rttMs: 25, paths: 1 }),
    };
    const connection = mergeCallLanes(raw);
    const pending = connection.recv();
    await expect(connection.recvAudio!()).resolves.toEqual(new Uint8Array([9, 1, 42]));
    await connection.sendAudio!(new Uint8Array([9, 1, 42]));
    expect(raw.send_audio).toHaveBeenCalledOnce();
    await expect(connection.transportStats!()).resolves.toMatchObject({
      relayOnly: true,
      rttMs: 25,
    });
    connection.close();
    await expect(pending).rejects.toThrow('closed');
  });
  it('delivers readiness first, then audio and heartbeats while video is blocked, without read-ahead', async () => {
    const lanes = Array.from({ length: 4 }, () => deferred<Uint8Array>());
    const raw = {
      send: vi.fn(),
      close: vi.fn(),
      recv: vi.fn(),
      recv_lane: vi.fn((lane: number) => lanes[lane].promise),
    };
    const connection = mergeCallLanes(raw);
    const ready = connection.recv();
    expect(raw.recv_lane.mock.calls).toEqual([[0]]);
    lanes[0].resolve(new Uint8Array([2]));
    await expect(ready).resolves.toEqual(new Uint8Array([2]));
    lanes[0] = deferred();
    const audio = connection.recv();
    lanes[1].resolve(new Uint8Array([0, 42]));
    await expect(audio).resolves.toEqual(new Uint8Array([0, 42]));
    lanes[1] = deferred();
    const heartbeat = connection.recv();
    lanes[0].resolve(new Uint8Array([1]));
    await expect(heartbeat).resolves.toEqual(new Uint8Array([1]));
    expect(raw.recv_lane.mock.calls.filter(([lane]) => lane === 2)).toHaveLength(1);
    expect(raw.recv_lane.mock.calls.filter(([lane]) => lane === 3)).toHaveLength(1);
    connection.close();
    await expect(connection.recv()).rejects.toThrow('closed');
  });
  it('attaches one listener to a dormant lane throughout a video call', async () => {
    // Count subscriptions on the idle read and its derived promises. Promise.race
    // used to subscribe to the same pending result once per delivered video frame.
    let listeners = 0;
    class IdleRead<T> extends Promise<T> {
      override then<A = T, B = never>(
        fulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ) {
        listeners++;
        return super.then(fulfilled, rejected);
      }
    }
    const idle = new IdleRead<Uint8Array>(() => {});
    const control = deferred<Uint8Array>();
    const connection = mergeCallLanes({
      recv_lane: (lane) =>
        lane === 0 ? control.promise : lane === 2 ? Promise.resolve(Uint8Array.of(3)) : idle,
      recv: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    });
    const first = connection.recv();
    control.resolve(Uint8Array.of(2));
    await first;
    // Subsequent control reads can stay blocked between heartbeats.
    control.promise = new Promise(() => {});
    for (let i = 0; i < 100; i++)
      await expect(connection.recv()).resolves.toEqual(Uint8Array.of(3));
    expect(listeners).toBe(2); // One reader for each dormant media lane.
    connection.close();
  });
  it('keeps the legacy transport when newer bindings or negotiation are absent', async () => {
    const connection = { send: vi.fn(), recv: vi.fn(), close: vi.fn() };
    const raw = {
      online: vi.fn(),
      id: () => 'id',
      relay_url: () => 'relay',
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(connection),
      accept: vi.fn().mockResolvedValue(connection),
    };
    const endpoint = adaptCallEndpoint(raw);
    expect(endpoint.multiplexed).toBe(false);
    expect(await endpoint.connect('peer', 'relay', 'call', true)).toBe(connection);
    expect(raw.connect).toHaveBeenCalledWith('peer', 'relay', 'call');
  });
});
