import type { NDKSubscription } from '@nostr-dev-kit/ndk';
import { RELAY_QUERY_TIMEOUT_MS } from 'src/stores/nostr/constants';
import { observeConnectedRelayEose } from 'src/stores/nostr/subscriptionEose';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
it('keeps observing a slow snapshot after the initial query wait has expired', () => {
  vi.useFakeTimers();
  const healthy = { connected: true },
    unavailable = { connected: false };
  const subscription = {
    relaySet: { relays: new Set([healthy, unavailable]) },
    eosesSeen: new Set(),
    on: vi.fn(),
    off: vi.fn(),
    stop: vi.fn(),
  };
  const eose = vi.fn();
  observeConnectedRelayEose(subscription as unknown as NDKSubscription, eose);
  vi.advanceTimersByTime(RELAY_QUERY_TIMEOUT_MS + 1000);
  expect(eose).not.toHaveBeenCalled();
  subscription.eosesSeen.add(healthy);
  vi.advanceTimersByTime(100);
  expect(eose).toHaveBeenCalledTimes(1);
  expect(subscription.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['eose', 'close'])('releases its observer when the subscription emits %s', (event) => {
  vi.useFakeTimers();
  const subscription = {
    relaySet: { relays: new Set([{ connected: false }]) },
    eosesSeen: new Set(),
    on: vi.fn(),
    off: vi.fn(),
  };
  const eose = vi.fn();
  observeConnectedRelayEose(subscription as unknown as NDKSubscription, eose);
  vi.advanceTimersByTime(RELAY_QUERY_TIMEOUT_MS + 1000);
  subscription.on.mock.calls.find(([name]) => name === event)?.[1]();
  expect(vi.getTimerCount()).toBe(0);
  expect(eose).not.toHaveBeenCalled();
});

it('completes from every connected relay EOSE while retaining the listener for a late connection', () => {
  vi.useFakeTimers();
  const healthy = { connected: true },
    late = { connected: false };
  const subscription = {
    relaySet: { relays: new Set([healthy, late]) },
    eosesSeen: new Set(),
    on: vi.fn(),
    off: vi.fn(),
    stop: vi.fn(),
  };
  const eose = vi.fn();
  observeConnectedRelayEose(subscription as unknown as NDKSubscription, eose);
  vi.advanceTimersByTime(100);
  expect(eose).not.toHaveBeenCalled();
  subscription.eosesSeen.add(healthy);
  vi.advanceTimersByTime(100);
  expect(eose).toHaveBeenCalledTimes(1);
  expect(subscription.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
