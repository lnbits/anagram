import type { NDKSubscription } from '@nostr-dev-kit/ndk';
import { observeConnectedRelayEose } from 'src/stores/nostr/subscriptionEose';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
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
