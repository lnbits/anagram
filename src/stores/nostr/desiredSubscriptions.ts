import type { NDKFilter } from '@nostr-dev-kit/ndk';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { normalizeRelayStatusUrlsValue } from 'src/stores/nostr/valueUtils';

export function subscriptionSignature(
  filters: NDKFilter | NDKFilter[],
  relayUrls: string[]
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value
        .map(canonical)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)])
      );
    return value;
  };
  return JSON.stringify(
    canonical({ filters, relayUrls: normalizeRelayStatusUrlsValue(relayUrls) })
  );
}

export interface DesiredSubscription {
  key: string;
  signature: string;
  prepare: () => Promise<void>;
  start: (eose: () => void, close: () => void) => { stop: () => void };
  applied?: () => Promise<void>;
}

// Entries are reserved before the first await. Identical callers share both setup and EOSE.
// Removal invalidates pending setup too, so logout cannot resurrect a subscription.
export function createDesiredSubscriptions() {
  interface Entry {
    signature: string;
    subscription?: { stop: () => void };
    started: Promise<void>;
    ready: Promise<void>;
    cancel: () => void;
  }
  const entries = new Map<string, Entry>();

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entry.cancel();
    entry.subscription?.stop();
  }

  function ensure(desired: DesiredSubscription, unhealthy = false): Promise<void> {
    const existing = entries.get(desired.key);
    if (existing?.signature === desired.signature && (!unhealthy || !existing.subscription)) return existing.started;
    remove(desired.key);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A live-only caller need not wait for initial hydration.
    void ready.catch(() => {});
    const entry: Entry = {
      signature: desired.signature,
      ready,
      started: Promise.resolve(),
      cancel: () => rejectReady(new Error('Subscription closed before hydration completed.')),
    };
    entries.set(desired.key, entry);
    entry.started = Promise.resolve()
      .then(async () => {
        await desired.prepare();
        if (entries.get(desired.key) !== entry) return;
        entry.subscription = desired.start(
          () => {
            void (desired.applied?.() ?? Promise.resolve()).then(resolveReady, rejectReady);
          },
          () => {
            if (entries.get(desired.key) === entry) entries.delete(desired.key);
            entry.cancel();
          }
        );
      })
      .catch((error) => {
        if (entries.get(desired.key) === entry) entries.delete(desired.key);
        rejectReady(error);
        throw error;
      });
    return entry.started;
  }

  async function reconcile(desired: DesiredSubscription[], unhealthy = false): Promise<void> {
    const keys = new Set(desired.map((item) => item.key));
    for (const key of entries.keys()) if (!keys.has(key)) remove(key);
    await Promise.all(desired.map((item) => ensure(item, unhealthy)));
  }

  async function waitForEose(timeoutMs = 15_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...entries.values()].map((entry) => entry.ready)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out waiting for subscription EOSE.')),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    ensure,
    reconcile,
    waitForEose,
    stop: () => {
      for (const key of entries.keys()) remove(key);
    },
    size: () => entries.size,
  };
}

// Batch targets with identical routes. A fallback is used only when no route is known.
export function bucketRelayTargets(
  targets: Array<{ publicKey: string; relayUrls: string[] }>,
  fallback: string[] = []
): Array<{ publicKeys: string[]; relayUrls: string[] }> {
  const buckets = new Map<string, { publicKeys: string[]; relayUrls: string[] }>();
  for (const target of targets) {
    const publicKey = inputSanitizerService.normalizeHexKey(target.publicKey);
    const known = normalizeRelayStatusUrlsValue(target.relayUrls).sort();
    const relayUrls = known.length
      ? known
      : normalizeRelayStatusUrlsValue(fallback).sort().slice(0, 2);
    if (!publicKey || !relayUrls.length) continue;
    const key = relayUrls.join('|');
    const bucket = buckets.get(key) ?? { publicKeys: [], relayUrls };
    if (!bucket.publicKeys.includes(publicKey)) bucket.publicKeys.push(publicKey);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, publicKeys: bucket.publicKeys.sort() }))
    .sort((a, b) => a.relayUrls.join('|').localeCompare(b.relayUrls.join('|')));
}
