import { EventEmitter } from 'node:events';
import { type NDKRelay, NDKRelayStatus, type NDKSubscriptionOptions } from '@nostr-dev-kit/ndk';
import { HISTORY_RELAY_TIMEOUT_MS, readRelaySnapshot } from 'src/stores/nostr/relaySnapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';

function fixture() {
  const relay = Object.assign(new EventEmitter(), {
    url: 'wss://fixture.example/',
    connected: true,
    get status() {
      return NDKRelayStatus.CONNECTED;
    },
  }) as unknown as NDKRelay;
  Object.defineProperty(relay, 'status', {
    configurable: true,
    get: () => NDKRelayStatus.CONNECTED,
  });
  const controller = new AbortController();
  let callbacks: Pick<NDKSubscriptionOptions, 'onEvent' | 'onEose' | 'onClose'> = {};
  const subscription = { stop: vi.fn(), on: vi.fn(), off: vi.fn(), removeAllListeners: vi.fn() };
  const onEvent = vi.fn();
  const subscribe = vi.fn((options) => {
    callbacks = options;
    return subscription as never;
  });
  return { relay, controller, subscription, callbacks: () => callbacks, onEvent, subscribe };
}

describe('bounded relay snapshots', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    'eose',
    'timeout',
    'auth-failed',
    'disconnect',
    'closed',
    'error',
    'cancelled',
  ] as const)('settles and removes every listener/timer after %s', async (outcome) => {
    vi.useFakeTimers();
    const f = fixture();
    const promise = readRelaySnapshot({ ...f, signal: f.controller.signal });
    if (outcome === 'eose') f.callbacks().onEose?.(f.subscription as never);
    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(HISTORY_RELAY_TIMEOUT_MS);
    if (outcome === 'auth-failed')
      f.relay.emit('auth:failed', new Error('Misconfigured AUTH service'));
    if (outcome === 'disconnect') f.relay.emit('disconnect');
    if (outcome === 'closed')
      f.subscription.on.mock.calls.find(([name]) => name === 'closed')?.[1](f.relay, 'restricted');
    if (outcome === 'error') {
      f.onEvent.mockImplementation(() => {
        throw new Error('callback failed');
      });
      f.callbacks().onEvent?.({} as never, f.relay, f.subscription as never, false, false);
    }
    if (outcome === 'cancelled') f.controller.abort();
    expect(await promise).toMatchObject({ outcome });
    expect(f.subscription.stop).toHaveBeenCalledTimes(1);
    expect(f.subscription.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(f.relay.listenerCount('auth:failed')).toBe(0);
    expect(f.relay.listenerCount('disconnect')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.callbacks().onEvent?.({} as never, f.relay, f.subscription as never, false, false);
    expect(f.onEvent).toHaveBeenCalledTimes(outcome === 'error' ? 1 : 0);
  });

  it.each([
    NDKRelayStatus.AUTH_REQUESTED,
    NDKRelayStatus.AUTHENTICATING,
    NDKRelayStatus.DISCONNECTED,
  ])('does not subscribe to transport-connected status %s', async (status) => {
    const f = fixture();
    vi.spyOn(f.relay, 'status', 'get').mockReturnValue(status);
    expect(await readRelaySnapshot({ ...f, signal: f.controller.signal })).toMatchObject({
      outcome: 'unavailable',
    });
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it('cleans up synchronous EOSE and thrown subscription creation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.subscribe.mockImplementation((callbacks) => {
      callbacks.onEose?.(f.subscription as never);
      return f.subscription as never;
    });
    expect(await readRelaySnapshot({ ...f, signal: f.controller.signal })).toMatchObject({
      outcome: 'eose',
    });
    expect(f.subscription.stop).toHaveBeenCalledTimes(1);
    f.subscribe.mockImplementation(() => {
      throw new Error('start failed');
    });
    expect(await readRelaySnapshot({ ...f, signal: f.controller.signal })).toMatchObject({
      outcome: 'error',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.relay.listenerCount('disconnect')).toBe(0);
  });
});
