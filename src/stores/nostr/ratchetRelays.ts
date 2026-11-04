// Shared device discovery with Iris. This does not change NIP-17 or public-room relays.
export function ratchetRelayUrls(configured: string[]): string[] {
  return [...new Set([...configured, 'wss://relay.snort.social'])];
}
