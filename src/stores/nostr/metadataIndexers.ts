// Public metadata discovery only. Never use these as DM delivery/history targets
// unless the account separately advertises them as inbox or backup relays.
export const PUBLIC_METADATA_INDEXERS = [
  'wss://purplepag.es/',
  'wss://indexer.coracle.social/',
  'wss://relay.nos.social/',
];
// Amethyst keeps a separate set with kind-10050 coverage. Only the account's
// own discovery fans out to this set; ordinary avatar lookups stay small.
export const PUBLIC_INBOX_INDEXERS = [
  'wss://relay.nos.social/',
  'wss://relay.damus.io/',
  'wss://nos.lol/',
  'wss://relay.nostr.band/',
  'wss://purplerelay.com/',
];
export const PUBLIC_DISCOVERY_INDEXERS = [
  ...new Set([...PUBLIC_METADATA_INDEXERS, ...PUBLIC_INBOX_INDEXERS]),
];
export function metadataIndexerFallbacks(relays: string[], includeInboxIndexers = false): string[] {
  // A local/private relay-only configuration should stay local (including E2E).
  return relays.some((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'wss:' &&
        !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(url.hostname) &&
        !url.hostname.endsWith('.test') &&
        !url.hostname.endsWith('.local')
      );
    } catch {
      return false;
    }
  })
    ? includeInboxIndexers
      ? PUBLIC_DISCOVERY_INDEXERS
      : PUBLIC_METADATA_INDEXERS
    : [];
}
