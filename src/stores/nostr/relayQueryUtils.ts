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
import { retainStartupRelayQueries, startupRelayObserver, startupRelaySignal } from '#src/stores/nostr/startupRelayTracking.ts';
import type { StartupTrackId } from '#src/stores/nostr/startupState.ts';

type RelayQueryNdk = Pick<NostrClient, 'fetchEvent' | 'fetchEvents' | 'subscribe'>;

type RelayQuerySubscriptionOptions = Omit<
  NostrSubscriptionOptions,
  'closeOnEose' | 'onEose' | 'onEvent' | 'onEvents' | 'relaySet' | 'relayUrls'
> & { allowPartialResults?: boolean; startupTrackId?: StartupTrackId };

interface StartupQueryCache {
  signal: AbortSignal;
  release: () => void;
  complete: Set<string>;
  events: Map<string, ClientEvent>;
  running?: Promise<Set<ClientEvent>>;
}
const startupQueries = new WeakMap<object, Map<string, StartupQueryCache>>();

// A recovered contact secret or changed contact list produces new cursor filters.
// Retire obsolete batches so they neither retain ciphertext nor request endless retries.
export function retainStartupQueryFilters(ndk: object, track: StartupTrackId, filters: NostrFilter[]): void {
  const keys = new Set(filters.map((filter) => JSON.stringify([track, filter])));
  retainStartupRelayQueries(ndk, track, keys);
  const queries = startupQueries.get(ndk);
  for (const [key, cache] of queries ?? []) {
    if (!key.startsWith(`[${JSON.stringify(track)},`) || keys.has(key) || cache.running) continue;
    cache.release();
    cache.events.clear();
    queries?.delete(key);
  }
}

// Startup snapshots retry failed replicas independently and keep data already
// received. This is deliberately separate from history/coverage queries.
function fetchStartupRelayEvents(
  ndk: RelayQueryNdk,
  filters: NostrFilter | NostrFilter[],
  opts: RelayQuerySubscriptionOptions,
  relaySet: NostrRelaySet,
  timeoutMs: number,
): Promise<Set<ClientEvent>> {
  const track = opts.startupTrackId!;
  const key = JSON.stringify([track, filters]);
  const signal = startupRelaySignal(ndk);
  let queries = startupQueries.get(ndk);
  if (!queries || [...queries.values()].some((query) => query.signal !== signal)) {
    queries = new Map();
    startupQueries.set(ndk, queries);
  }
  let cache = queries.get(key);
  if (!cache) {
    cache = { signal, complete: new Set(), events: new Map(), release: () => {} };
    queries.set(key, cache);
    const entry = cache;
    const aborted = () => {
      entry.events.clear();
      entry.complete.clear();
      queries?.delete(key);
    };
    signal.addEventListener('abort', aborted, { once: true });
    entry.release = () => signal.removeEventListener('abort', aborted);
  }
  if (cache.running) return cache.running;
  const current = cache;
  const report = startupRelayObserver(ndk, [track], key, relaySet.relayUrls, { snapshot: true });
  const collect = (event: ClientEvent) => {
    if (signal.aborted) return;
    const id = event.deduplicationKey();
    const previous = current.events.get(id);
    if (!previous || Number(event.created_at) > Number(previous.created_at) ||
      (event.created_at === previous.created_at && event.id < previous.id)) current.events.set(id, event);
  };
  current.running = Promise.all(relaySet.relayUrls.map(async (relayUrl) => {
    if (current.complete.has(relayUrl)) {
      report({ relayUrl, status: 'success' });
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let subscription: ReturnType<NostrClient['subscribe']> | undefined;
      const finish = (complete = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (complete && !signal.aborted) {
          current.complete.add(relayUrl);
          report({ relayUrl, status: 'success' });
        }
        subscription?.stop();
        resolve();
      };
      const aborted = () => finish();
      const timer = setTimeout(() => {
        report({ relayUrl, status: 'error', reason: 'timeout' });
        finish();
      }, timeoutMs);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { finish(); return; }
      try {
        const { startupTrackId: _track, allowPartialResults: _partial, ...options } = opts;
        subscription = ndk.subscribe(filters, {
          ...options,
          relaySet: NostrRelaySet.fromRelayUrls([relayUrl], ndk as NostrClient, false),
          closeOnEose: true,
          onRelayStatus: (update) => {
            if (settled) return;
            report(update);
            if (update.status === 'error') finish();
          },
          onEvent: (event) => { if (!settled) collect(event); },
          onEvents: (events) => { if (!settled) events.forEach(collect); },
          onEose: () => finish(true),
          onClose: () => {
            if (settled) return;
            report({ relayUrl, status: 'error', reason: 'closed' });
            finish();
          },
        });
        if (settled) subscription.stop();
      } catch {
        report({ relayUrl, status: 'error', reason: 'unavailable' });
        finish();
      }
    });
  })).then(() => {
    if (signal.aborted) throw new DOMException('Startup cancelled', 'AbortError');
    if (!current.complete.size && !current.events.size) throw new RelayQueryTimeoutError(timeoutMs);
    if (relaySet.relayUrls.every((url) => current.complete.has(url))) {
      current.release();
      queries?.delete(key);
    }
    return new Set(current.events.values());
  }).finally(() => { current.running = undefined; });
  return current.running;
}

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
  if (opts?.startupTrackId) return fetchStartupRelayEvents(ndk, filters, opts, relaySet, timeoutMs);
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
