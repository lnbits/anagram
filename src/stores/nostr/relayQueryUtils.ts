import type NDK from '@nostr-dev-kit/ndk';
import {
  type NDKEvent,
  type NDKFilter,
  NDKRelaySet,
  type NDKSubscriptionOptions,
  normalizeRelayUrl,
} from '@nostr-dev-kit/ndk';
import { RELAY_QUERY_TIMEOUT_MS } from 'src/stores/nostr/constants';
import { raceWithTimeout, selectReadyRelayUrls } from 'src/stores/nostr/relayTimeoutUtils';

function isNdkRelayConnected(ndk: Pick<NDK, 'pool'>, relayUrl: string): boolean {
  try {
    const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
    const relay = ndk.pool?.relays?.get(normalizedRelayUrl);
    return Boolean(relay?.connected);
  } catch {
    return false;
  }
}

export function createReadyRelaySet(ndk: NDK, relayUrls: string[]): NDKRelaySet | null {
  const readyRelayUrls = selectReadyRelayUrls(relayUrls, (relayUrl) =>
    isNdkRelayConnected(ndk, relayUrl)
  );
  if (readyRelayUrls.length > 0) {
    return NDKRelaySet.fromRelayUrls(readyRelayUrls, ndk, false);
  }

  if ((ndk.pool?.relays?.size ?? 0) === 0) {
    return NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
  }

  return null;
}

export async function fetchEventWithRelayTimeout(
  ndk: Pick<NDK, 'fetchEvent'>,
  filter: string | NDKFilter | NDKFilter[],
  opts: NDKSubscriptionOptions | undefined,
  relaySet: NDKRelaySet | null | undefined,
  timeoutMs = RELAY_QUERY_TIMEOUT_MS
): Promise<NDKEvent | null> {
  if (!relaySet || relaySet.size === 0) {
    return null;
  }

  return raceWithTimeout(ndk.fetchEvent(filter, opts, relaySet), timeoutMs, null);
}

export async function fetchEventsWithRelayTimeout(
  ndk: Pick<NDK, 'fetchEvents'>,
  filters: NDKFilter | NDKFilter[],
  opts: NDKSubscriptionOptions | undefined,
  relaySet: NDKRelaySet | null | undefined,
  timeoutMs = RELAY_QUERY_TIMEOUT_MS
): Promise<Set<NDKEvent>> {
  if (!relaySet || relaySet.size === 0) {
    return new Set<NDKEvent>();
  }

  return raceWithTimeout(ndk.fetchEvents(filters, opts, relaySet), timeoutMs, new Set<NDKEvent>());
}
