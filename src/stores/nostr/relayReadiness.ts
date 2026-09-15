import { type NDKRelay, NDKRelayStatus } from '@nostr-dev-kit/ndk';

const quarantinedRelays = new WeakSet<NDKRelay>();

export function setRelayQuarantined(relay: NDKRelay, quarantined: boolean): void {
  if (quarantined) quarantinedRelays.add(relay);
  else quarantinedRelays.delete(relay);
}

export function isRelayQuarantined(relay: NDKRelay): boolean {
  return quarantinedRelays.has(relay);
}

// NDK's connected getter includes AUTH_REQUESTED and AUTHENTICATING: it describes
// the socket, not whether REQ can be served.
export function isRelayQueryReady(relay: NDKRelay | undefined): boolean {
  return Boolean(
    relay &&
      !isRelayQuarantined(relay) &&
      relay.connected &&
      (relay.status === NDKRelayStatus.CONNECTED || relay.status === NDKRelayStatus.AUTHENTICATED)
  );
}
