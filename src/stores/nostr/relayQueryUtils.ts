import type NostrClient from '#src/lib/nostr/client.ts';
import {
  filterFromId,
  type ClientEvent,
  type NostrFilter,
  NostrRelaySet,
  type NostrSubscriptionOptions,
  normalizeRelayUrl,
} from '#src/lib/nostr/client.ts';
import { RELAY_QUERY_TIMEOUT_MS } from '#src/stores/nostr/constants.ts';
import { selectReadyRelayUrls } from '#src/stores/nostr/relayTimeoutUtils.ts';

type RelayQueryNdk = Pick<NostrClient, 'fetchEvent' | 'fetchEvents' | 'subscribe'>;

type RelayQuerySubscriptionOptions = Omit<
  NostrSubscriptionOptions,
  'closeOnEose' | 'onEose' | 'onEvent' | 'onEvents' | 'relaySet' | 'relayUrls'
> & { allowPartialResults?: boolean };

export class RelayQueryUnavailableError extends Error {
  constructor() {
    super('No requested relay is connected for the query.');
    this.name = 'RelayQueryUnavailableError';
  }
}

export class RelayQueryTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Relay query timed out after ${timeoutMs}ms.`);
    this.name = 'RelayQueryTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function isNdkRelayConnected(ndk: Pick<NostrClient, 'pool'>, relayUrl: string): boolean {
  try {
    const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
    const relay = ndk.pool?.relays?.get(normalizedRelayUrl);
    return Boolean(relay?.connected);
  } catch {
    return false;
  }
}

export function createReadyRelaySet(ndk: NostrClient, relayUrls: string[]): NostrRelaySet | null {
  const readyRelayUrls = selectReadyRelayUrls(relayUrls, (relayUrl) =>
    isNdkRelayConnected(ndk, relayUrl),
  );
  if (readyRelayUrls.length > 0) {
    return NostrRelaySet.fromRelayUrls(readyRelayUrls, ndk, false);
  }

  if ((ndk.pool?.relays?.size ?? 0) === 0) {
    return NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
  }

  return null;
}

function normalizeQueryTimeoutMs(timeoutMs: number): number {
  return Math.max(0, Math.floor(timeoutMs));
}

function runLegacyQueryWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new RelayQueryTimeoutError(timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function fetchRelayEventsWithSubscription(
  ndk: RelayQueryNdk,
  filters: NostrFilter | NostrFilter[],
  opts: RelayQuerySubscriptionOptions | undefined,
  relaySet: NostrRelaySet,
  timeoutMs: number,
): Promise<Set<ClientEvent>> {
  return new Promise<Set<ClientEvent>>((resolve, reject) => {
    const eventsByDeduplicationKey = new Map<string, ClientEvent>();
    let subscription: ReturnType<NostrClient['subscribe']> | null = null;
    let settled = false;

    const collectEvent = (event: ClientEvent): void => {
      const deduplicationKey = event.deduplicationKey();
      const existingEvent = eventsByDeduplicationKey.get(deduplicationKey);
      if (!existingEvent || Number(event.created_at ?? 0) > Number(existingEvent.created_at ?? 0)) {
        eventsByDeduplicationKey.set(deduplicationKey, event);
      }
    };

    const timeoutId = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      subscription?.stop();
      if (opts?.allowPartialResults && eventsByDeduplicationKey.size)
        resolve(new Set(eventsByDeduplicationKey.values()));
      else reject(new RelayQueryTimeoutError(timeoutMs));
    }, timeoutMs);

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(new Set(eventsByDeduplicationKey.values()));
    };

    try {
      const { allowPartialResults: _partial, ...subscriptionOptions } = opts ?? {};
      subscription = ndk.subscribe(filters, {
        ...subscriptionOptions,
        closeOnEose: true,
        relaySet,
        onEvents: (events) => {
          events.forEach(collectEvent);
        },
        onEvent: collectEvent,
        onEose: finish,
      });
    } catch (error) {
      settled = true;
      globalThis.clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function fetchRelayEventsWithTimeout(
  ndk: RelayQueryNdk,
  filters: NostrFilter | NostrFilter[],
  opts: RelayQuerySubscriptionOptions | undefined,
  relaySet: NostrRelaySet | null | undefined,
  timeoutMs: number,
): Promise<Set<ClientEvent>> {
  if (!relaySet || relaySet.size === 0) {
    throw new RelayQueryUnavailableError();
  }

  const normalizedTimeoutMs = normalizeQueryTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === 0) {
    throw new RelayQueryTimeoutError(normalizedTimeoutMs);
  }

  if (typeof ndk.subscribe === 'function') {
    return fetchRelayEventsWithSubscription(ndk, filters, opts, relaySet, normalizedTimeoutMs);
  }

  return runLegacyQueryWithTimeout(ndk.fetchEvents(filters, opts, relaySet), normalizedTimeoutMs);
}

export async function fetchEventWithRelayTimeout(
  ndk: RelayQueryNdk,
  filter: string | NostrFilter | NostrFilter[],
  opts: RelayQuerySubscriptionOptions | undefined,
  relaySet: NostrRelaySet | null | undefined,
  timeoutMs = RELAY_QUERY_TIMEOUT_MS,
): Promise<ClientEvent | null> {
  if (!relaySet || relaySet.size === 0) {
    throw new RelayQueryUnavailableError();
  }

  const normalizedTimeoutMs = normalizeQueryTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === 0) {
    throw new RelayQueryTimeoutError(normalizedTimeoutMs);
  }

  if (typeof ndk.subscribe !== 'function') {
    return runLegacyQueryWithTimeout(ndk.fetchEvent(filter, opts, relaySet), normalizedTimeoutMs);
  }

  const filters = typeof filter === 'string' ? filterFromId(filter) : filter;
  const events = await fetchRelayEventsWithSubscription(
    ndk,
    filters,
    opts,
    relaySet,
    normalizedTimeoutMs,
  );
  let newestEvent: ClientEvent | null = null;
  for (const event of events) {
    if (!newestEvent || Number(event.created_at ?? 0) > Number(newestEvent.created_at ?? 0)) {
      newestEvent = event;
    }
  }

  return newestEvent;
}

export async function fetchEventsWithRelayTimeout(
  ndk: RelayQueryNdk,
  filters: NostrFilter | NostrFilter[],
  opts: RelayQuerySubscriptionOptions | undefined,
  relaySet: NostrRelaySet | null | undefined,
  timeoutMs = RELAY_QUERY_TIMEOUT_MS,
): Promise<Set<ClientEvent>> {
  return fetchRelayEventsWithTimeout(ndk, filters, opts, relaySet, timeoutMs);
}
