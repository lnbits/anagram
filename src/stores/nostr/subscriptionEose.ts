import type { NDKSubscription } from '@nostr-dev-kit/ndk';
import { RELAY_QUERY_TIMEOUT_MS } from 'src/stores/nostr/constants';

// NDK waits indefinitely with one responding relay and one disconnected relay. The initial
// snapshot is complete once every connected target has sent EOSE. Keep the listener open so
// a late relay still delivers its snapshot when it connects.
export function observeConnectedRelayEose(subscription: NDKSubscription, onEose: () => void): void {
  if (!subscription.relaySet || !subscription.eosesSeen) return;
  const deadline = Date.now() + RELAY_QUERY_TIMEOUT_MS;
  const timer = globalThis.setInterval(() => {
    const connected = [...(subscription.relaySet?.relays ?? [])].filter((relay) => relay.connected);
    if (connected.length && connected.every((relay) => subscription.eosesSeen.has(relay))) {
      cleanup();
      onEose();
    } else if (Date.now() >= deadline) cleanup();
  }, 50);
  const cleanup = () => {
    globalThis.clearInterval(timer);
    subscription.off('eose', cleanup);
    subscription.off('close', cleanup);
  };
  subscription.on('eose', cleanup);
  subscription.on('close', cleanup);
}
