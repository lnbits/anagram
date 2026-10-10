import { normalizeRelayUrl } from '#src/lib/nostr/client.ts';

export function buildRelayLookupKey(relay: string): string {
  try {
    return normalizeRelayUrl(relay);
  } catch {
    return relay.trim().toLowerCase();
  }
}

export function uniqueRelayUrls(relays: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const relay of relays) {
    const normalizedRelay = relay.trim();
    if (!normalizedRelay) {
      continue;
    }

    const key = buildRelayLookupKey(normalizedRelay);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalizedRelay);
  }

  return result;
}
