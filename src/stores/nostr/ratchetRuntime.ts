import {
  NdrRuntime,
  createPersistentNostrOutbox,
  buildDirectRumorEvent,
  RuntimeSubscriptionTracker,
  buildRuntimeBackfillFilters,
  type Rumor,
  type OnEventMeta,
} from 'nostr-double-ratchet';
import {
  getEventHash,
  verifyEvent,
  type Filter,
  type UnsignedEvent,
  type VerifiedEvent,
} from 'nostr-tools';
import { acquireRatchetLock } from './ratchetLock.ts';
import { ratchetEditTime, applyRatchetEdit } from './ratchetEdits.ts';
import { RatchetStorage } from './ratchetStorage.ts';

interface RatchetTransport {
  owner: string;
  isCurrent: () => boolean;
  sign: (event: UnsignedEvent) => Promise<VerifiedEvent>;
  publish: (event: VerifiedEvent, recipient?: string) => Promise<void>;
  subscribe: (filter: Filter, onEvent: (event: VerifiedEvent) => void) => () => void;
  fetch: (filter: Filter) => Promise<VerifiedEvent[]>;
  registrationRoster: () => Promise<VerifiedEvent[]>;
  receive: (event: Rumor, sender: string, meta: OnEventMeta) => Promise<void>;
  published?: (innerId: string) => Promise<void>;
  signal?: AbortSignal;
  onCloseReady?: (close: () => Promise<void>) => void;
}
export function authenticatedRatchetMessage(
  event: Rumor,
  from: string,
  meta: OnEventMeta | undefined,
  owner: string,
) {
  const sender = meta?.senderOwnerPubkey;
  if (
    !sender ||
    sender !== from ||
    !/^[a-f0-9]{64}$/.test(sender) ||
    event.tags.some((tag) => tag[0] === 'l' || tag[0] === 'h')
  )
    return null;
  if (![14, 7, 5, 1009].includes(event.kind) || getEventHash(event) !== event.id) return null;
  const expiration = event.tags.find((tag) => tag[0] === 'expiration')?.[1];
  if (
    expiration !== undefined &&
    (!/^\d+$/.test(expiration) || Number(expiration) <= Date.now() / 1000)
  )
    return null;
  if (event.kind === 1009) {
    const msTags = event.tags.filter((tag) => tag[0] === 'ms');
    const ms = Number(msTags[0]?.[1]);
    if (
      msTags.length > 1 ||
      (msTags.length === 1 &&
        (!/^\d+$/.test(msTags[0][1] ?? '') ||
          !Number.isSafeInteger(ms) ||
          Math.floor(ms / 1000) !== event.created_at))
    )
      return null;
    if (
      event.tags.filter((tag) => tag[0] === 'e').length !== 1 ||
      event.tags.filter((tag) => tag[0] === 'k').length !== 1 ||
      event.tags.find((tag) => tag[0] === 'k')?.[1] !== '14' ||
      !event.content.trim() ||
      new TextEncoder().encode(event.content).length > 32768 ||
      event.created_at > Date.now() / 1000 + 300
    )
      return null;
  }
  // Only authenticated sibling devices may choose a remote conversation through a p tag.
  const peer =
    sender === owner
      ? (event.tags.find((tag) => tag[0] === 'p' && tag[1] !== owner)?.[1] ??
        event.tags.find((tag) => tag[0] === 'p' && tag[1] === owner)?.[1])
      : sender;
  if (!peer || !/^[a-f0-9]{64}$/.test(peer)) return null;
  return {
    ...event,
    pubkey: sender,
    tags: [['p', sender === owner ? peer : owner], ...event.tags.filter((tag) => tag[0] !== 'p')],
  };
}

export async function createRatchetRuntime(transport: RatchetTransport) {
  const release = await acquireRatchetLock(transport.owner);
  if (transport.signal?.aborted || !transport.isCurrent()) {
    release();
    throw new Error('Messaging account changed.');
  }
  const storage = new RatchetStorage(transport.owner);
  const tracker = new RuntimeSubscriptionTracker();
  const subscriptions = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const current = () => !closed && transport.isCurrent();
  const assertCurrent = () => {
    if (!current()) throw new Error('Messaging account changed.');
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const outbox = createPersistentNostrOutbox({
    storage,
    keyPrefix: 'outbox/',
    onPublished: async ({ innerEventId }) => {
      assertCurrent();
      if (innerEventId) await track(transport.published?.(innerEventId) ?? Promise.resolve());
    },
    publish: async (event, _innerId, context) => {
      assertCurrent();
      await transport.publish(event, context?.recipientOwnerPubkey);
      assertCurrent();
      return event;
    },
  });
  const runtime = new NdrRuntime({
    storage,
    nostrSign: async (event) => {
      assertCurrent();
      const signed = await transport.sign(event);
      assertCurrent();
      return signed;
    },
    nostrEnqueue: (event, id, context) =>
      track(
        (async () => {
          assertCurrent();
          await outbox.enqueue(event, id, context);
        })(),
      ),
    nostrPublish: async (event, id, context) => {
      assertCurrent();
      const signed = 'sig' in event ? event : await transport.sign(event);
      assertCurrent();
      return outbox.publish(signed, id, context);
    },
    nostrFetch: (filter) =>
      transport.fetch({ ...filter, limit: Math.min(filter.limit ?? 200, 200) }),
    nostrSubscribe: (filter, onEvent) => {
      if (!current()) return () => {};
      const registered = tracker.registerFilter(filter);
      let active = true;
      const receive = (event: VerifiedEvent) => {
        if (active && current() && verifyEvent(event)) onEvent(event);
      };
      const stop = transport.subscribe(
        { ...filter, limit: Math.min(filter.limit ?? 200, 200) },
        receive,
      );
      for (const backfill of buildRuntimeBackfillFilters(registered, 200)) {
        void transport
          .fetch(backfill)
          .then((events) => events.sort((a, b) => a.created_at - b.created_at).forEach(receive))
          .catch(() => {});
      }
      const cleanup = () => {
        active = false;
        stop();
        tracker.unregister(registered.token);
        subscriptions.delete(cleanup);
      };
      subscriptions.add(cleanup);
      return cleanup;
    },
  });
  runtime.onDurableSessionEvent([14, 7, 5, 1009], async (event, from, meta) => {
    assertCurrent();
    const normalized = authenticatedRatchetMessage(event, from, meta, transport.owner);
    if (!normalized) return;
    if (event.kind === 1009) {
      const peer = from === transport.owner ? normalized.tags[0][1] : from;
      const editKey = `edit/${from}/${peer}/${event.tags.find((tag) => tag[0] === 'e')![1]}`;
      if (await track(applyRatchetEdit(normalized, from, transport.owner)))
        await storage.del(editKey);
      else {
        const previous = await storage.get<Rumor>(editKey);
        if (
          !previous ||
          ratchetEditTime(previous) < ratchetEditTime(normalized) ||
          (ratchetEditTime(previous) === ratchetEditTime(normalized) && previous.id < normalized.id)
        )
          await storage.put(editKey, normalized);
      }
      return;
    }
    await track(transport.receive(normalized, from, meta ?? {}));
    if (event.kind === 14) {
      const peer = from === transport.owner ? normalized.tags[0][1] : from;
      const editKey = `edit/${from}/${peer}/${event.id}`;
      const edit = await storage.get<Rumor>(editKey);
      if (edit && (await track(applyRatchetEdit(edit, edit.pubkey, transport.owner))))
        await storage.del(editKey);
    }
  });
  const online = () => {
    if (current()) void outbox.retry().catch(() => {});
  };
  window.addEventListener('online', online);
  let closePromise: Promise<void> | undefined;
  const abort = () => {
    void close().catch(() => {});
  };
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    transport.signal?.removeEventListener('abort', abort);
    window.removeEventListener('online', online);
    runtime.close();
    subscriptions.forEach((stop) => stop());
    closePromise = (async () => {
      try {
        await outbox.close();
        // Do not await an external signer dialog or relay fetch. Only durable writes
        // must settle before logout deletes local data and releases this device.
        await Promise.allSettled([...pending]);
        await storage.close();
      } finally {
        release();
      }
    })();
    return closePromise;
  }
  transport.onCloseReady?.(close);
  transport.signal?.addEventListener('abort', abort, { once: true });
  try {
    await runtime.initForOwner(transport.owner);
    assertCurrent();
    if (!runtime.getState().isCurrentDeviceRegistered) {
      // An unavailable relay is not evidence that an owner has no other devices.
      for (const event of await transport.registrationRoster())
        await runtime.applyVerifiedAppKeysEvent(event);
      assertCurrent();
      await runtime.ensureCurrentDeviceRegistered(transport.owner);
    }
    assertCurrent();
    await runtime.republishInvite();
    assertCurrent();
    void outbox.retry().catch(() => {});
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async send(peer: string, event: Partial<Rumor>, prepared?: (event: Rumor) => Promise<void>) {
      assertCurrent();
      const now = Date.now();
      const createdAt = event.created_at ?? Math.floor(now / 1000);
      const complete = buildDirectRumorEvent(
        transport.owner,
        peer,
        event.kind ?? 14,
        event.content ?? '',
        event.tags,
        {
          createdAt,
          nowMs: Math.min(now, createdAt * 1000 + 999),
        },
      );
      await track(prepared?.(complete) ?? Promise.resolve());
      assertCurrent();
      const rumor = await runtime.sendEvent(peer, complete);
      assertCurrent();
      if (!rumor) throw new Error('Could not queue double-ratchet message.');
      return { ...rumor, pubkey: transport.owner };
    },
    close,
  };
}
