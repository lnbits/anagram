import type {
  NDKEvent,
  NDKRelay,
  NDKSubscription,
  NDKSubscriptionOptions,
} from '@nostr-dev-kit/ndk';
import { isRelayQueryReady } from './relayReadiness';

export const HISTORY_RELAY_TIMEOUT_MS = 15_000;
export type RelaySnapshotOutcome =
  | 'eose'
  | 'unavailable'
  | 'timeout'
  | 'auth-failed'
  | 'disconnect'
  | 'closed'
  | 'error'
  | 'cancelled'
  | 'ingest-failed';
export interface RelaySnapshotResult {
  relayUrl: string;
  outcome: RelaySnapshotOutcome;
  error?: unknown;
}

// One relay per subscription avoids NDK's heuristic aggregate EOSE (which can
// finish before every relay answered). All callbacks are attached before start.
export function readRelaySnapshot(options: {
  relay: NDKRelay;
  signal: AbortSignal;
  subscribe: (
    callbacks: Pick<NDKSubscriptionOptions, 'onEvent' | 'onEose' | 'onClose'>
  ) => NDKSubscription;
  onEvent: (event: NDKEvent) => void;
  timeoutMs?: number;
}): Promise<RelaySnapshotResult> {
  const { relay, signal } = options;
  return new Promise((resolve) => {
    let subscription: NDKSubscription | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onDisconnect = () => finish('disconnect');
    const onAuthFailure = (error: Error) => finish('auth-failed', error);
    const onAbort = () => finish('cancelled');
    const onClosed = (_relay: NDKRelay, reason: string) => finish('closed', reason);
    const finish = (outcome: RelaySnapshotOutcome, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      relay.off('disconnect', onDisconnect);
      relay.off('auth:failed', onAuthFailure);
      subscription?.off('closed', onClosed);
      subscription?.stop();
      subscription?.removeAllListeners();
      resolve({ relayUrl: relay.url, outcome, ...(error ? { error } : {}) });
    };
    if (signal.aborted) return finish('cancelled');
    if (!isRelayQueryReady(relay)) return finish('unavailable');
    signal.addEventListener('abort', onAbort, { once: true });
    relay.on('disconnect', onDisconnect);
    relay.on('auth:failed', onAuthFailure);
    timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? HISTORY_RELAY_TIMEOUT_MS);
    try {
      subscription = options.subscribe({
        onEvent: (event) => {
          if (settled) return;
          try {
            options.onEvent(event);
          } catch (error) {
            finish('error', error);
          }
        },
        onEose: () => finish(isRelayQueryReady(relay) ? 'eose' : 'unavailable'),
        onClose: () => finish('closed'),
      });
      if (!settled) subscription.on('closed', onClosed);
      // Factories may deliver EOSE/close synchronously.
      if (settled) {
        subscription.stop();
        subscription.removeAllListeners();
      }
    } catch (error) {
      finish('error', error);
    }
  });
}
