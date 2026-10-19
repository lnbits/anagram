import type { Filter, VerifiedEvent } from 'nostr-tools';
import type NostrClient from '#src/lib/nostr/client.ts';
import { ClientEvent, type NostrSigner, type NostrEvent } from '#src/lib/nostr/client.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import type { createRatchetRuntime } from './ratchetRuntime.ts';
import { createRatchetPreferences, type DirectMessagePreference } from './ratchetPreferences.ts';

type Runtime = Awaited<ReturnType<typeof createRatchetRuntime>>;

export function createRatchetIntegration(deps: {
  client: NostrClient;
  owner: () => string | null;
  signer: () => Promise<NostrSigner>;
  relays: (peer?: string) => Promise<string[]>;
  receive: (event: ClientEvent, owner: string, outerId: string) => Promise<unknown>;
}) {
  let generation = 0;
  let active: { owner: string; runtime: Promise<Runtime>; cancel: () => Promise<void> } | undefined;
  const key = (owner = deps.owner()) => `anagram-ndr:${owner}`;
  const protocols = createRatchetPreferences({
    owner: deps.owner,
    history: async (peer) => (await chatDataService.listLatestMessages(peer, 2)).rows,
    subscribe: (peer, onEvent, onReady) => {
      const owner = deps.owner();
      let cancelled = false;
      let stop: (() => void) | undefined;
      void deps
        .relays(peer)
        .then((relays) => {
          if (cancelled || deps.owner() !== owner) return;
          const sub = deps.client.subscribe(
            { kinds: [37368], authors: [peer], limit: 10 },
            { relayUrls: relays },
          );
          sub.on('event', (event: ClientEvent) => onEvent(event.rawEvent() as VerifiedEvent));
          sub.on('eose', () => {
            if (sub.eosesSeen.size > 0) onReady();
          });
          stop = () => sub.stop();
        })
        .catch(onReady);
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  });
  async function ensure(): Promise<Runtime> {
    const owner = deps.owner();
    if (!owner) throw new Error('Sign in to enable encrypted messaging.');
    if (active?.owner === owner) return active.runtime;
    if (active) await close();
    const version = generation;
    const controller = new AbortController();
    let closeRuntime: (() => Promise<void>) | undefined;
    const current = () => generation === version && deps.owner() === owner;
    const runtime = (async () => {
      const { createRatchetRuntime } = await import('./ratchetRuntime.ts');
      if (!current()) throw new Error('Messaging account changed.');
      return createRatchetRuntime({
        owner,
        isCurrent: current,
        signal: controller.signal,
        onCloseReady: (close) => {
          closeRuntime = close;
        },
        sign: async (event) => {
          const signer = await deps.signer();
          if (!current() || signer.pubkey !== owner) throw new Error('Messaging account changed.');
          const signed = new ClientEvent(deps.client, event);
          await signed.sign(signer);
          return signed.rawEvent() as VerifiedEvent;
        },
        publish: async (event, peer) => {
          const relays = await deps.relays(peer);
          if (!current()) throw new Error('Messaging account changed.');
          await Promise.any(deps.client.transport.publish(relays, event));
        },
        published: async (innerId) => {
          if (!current()) throw new Error('Messaging account changed.');
          const row = await chatDataService.getMessageByEventId(innerId);
          if (!current()) throw new Error('Messaging account changed.');
          if (!row || row.meta.protocol !== 'ndr' || row.meta.ratchet_delivery === 'published')
            return;
          const updated = await chatDataService.updateMessageMeta(row.id, {
            ...row.meta,
            ratchet_delivery: 'published',
          });
          if (!current()) throw new Error('Messaging account changed.');
          if (updated) {
            const { useMessageStore } = await import('#src/stores/messageStore.svelte.ts');
            await useMessageStore().upsertPersistedMessage(updated);
          }
        },
        registrationRoster: async () => {
          const relays = await deps.relays();
          if (!current() || !relays.length) throw new Error('No messaging relay available.');
          return new Promise<VerifiedEvent[]>((resolve, reject) => {
            const events: VerifiedEvent[] = [];
            const sub = deps.client.subscribe(
              { kinds: [37368], authors: [owner], limit: 10 },
              { relayUrls: relays },
            );
            const finish = () => {
              clearTimeout(timer);
              sub.stop();
              if (current() && sub.eosesSeen.size > 0) resolve(events);
              else reject(new Error('Could not verify the existing messaging devices.'));
            };
            const timer = setTimeout(finish, 5000);
            sub.on('event', (event: ClientEvent) => events.push(event.rawEvent() as VerifiedEvent));
            sub.on('eose', finish);
          });
        },
        fetch: async (filter) => {
          const relays = await deps.relays();
          if (!current()) return [];
          return [...(await deps.client.fetchEvents(filter, { relayUrls: relays }))].map(
            (event) => event.rawEvent() as VerifiedEvent,
          );
        },
        subscribe: (filter: Filter, onEvent: (event: VerifiedEvent) => void) => {
          let subscription: ReturnType<NostrClient['subscribe']> | undefined;
          let retry: ReturnType<typeof setTimeout> | undefined;
          let retryDelay = 1000;
          let cancelled = false;
          const active = () => !cancelled && !controller.signal.aborted && current();
          function stop() {
            cancelled = true;
            clearTimeout(retry);
            controller.signal.removeEventListener('abort', stop);
            const previous = subscription;
            subscription = undefined;
            previous?.stop();
          }
          function retryLater() {
            if (!active()) return stop();
            if (retry !== undefined) return;
            retry = setTimeout(() => {
              retry = undefined;
              void start();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
          }
          async function start() {
            if (!active()) return stop();
            try {
              const relays = await deps.relays();
              if (!active()) return stop();
              if (!relays.length) return retryLater();
              const sub = deps.client.subscribe(filter, { relayUrls: relays });
              subscription = sub;
              sub.on('event', (event: ClientEvent) => {
                if (!active()) return stop();
                if (subscription !== sub) return;
                retryDelay = 1000;
                onEvent(event.rawEvent() as VerifiedEvent);
              });
              sub.on('eose', () => {
                if (active() && subscription === sub && sub.eosesSeen.size > 0) retryDelay = 1000;
              });
              sub.on('close', () => {
                if (subscription !== sub) return;
                subscription = undefined;
                // The client recovers partial failures. An all-relay close ends
                // its reconnect listeners, so retain this logical NDR interest.
                retryLater();
              });
            } catch {
              retryLater();
            }
          }
          controller.signal.addEventListener('abort', stop, { once: true });
          void start();
          return stop;
        },
        receive: async (event, _from, meta) => {
          if (!current()) throw new Error('Messaging account changed.');
          const result = await deps.receive(
            new ClientEvent(deps.client, event),
            owner,
            meta.outerEventId ?? event.id,
          );
          if (result === false) throw new Error('Message persistence interrupted.');
          if (!current()) throw new Error('Messaging account changed.');
          const peer =
            event.pubkey === owner ? event.tags.find((tag) => tag[0] === 'p')?.[1] : event.pubkey;
          if (peer) protocols.received(peer);
        },
      });
    })();
    active = {
      owner,
      runtime,
      cancel: async () => {
        controller.abort();
        await closeRuntime?.();
      },
    };
    try {
      return await runtime;
    } catch (error) {
      if (active?.runtime === runtime) active = undefined;
      throw error;
    }
  }
  async function close() {
    generation++;
    protocols.close();
    const previous = active;
    active = undefined;
    if (previous) {
      await previous.cancel();
      // A signer prompt can remain open indefinitely; a late completion is stale
      // and may only clean up its already-cancelled runtime.
      void previous.runtime.then((runtime) => runtime.close()).catch(() => {});
    }
  }
  async function setDirectMessageProtocol(peer: string, protocol: DirectMessagePreference) {
    const owner = deps.owner();
    if (!owner || !/^[a-f0-9]{64}$/.test(peer)) throw new Error('Invalid conversation.');
    // Keep the explicit choice even if device registration needs another attempt.
    await protocols.setPreference(peer, protocol);
    if (owner !== deps.owner()) throw new Error('Messaging account changed.');
    if (protocol === 'ndr') {
      await ensure();
      if (owner !== deps.owner()) throw new Error('Messaging account changed.');
      localStorage.setItem(`${key(owner)}:enabled`, '1');
    }
  }
  async function resume() {
    if (active && active.owner !== deps.owner()) await close();
    const owner = deps.owner();
    if (
      owner &&
      (localStorage.getItem(`${key(owner)}:enabled`) === '1' ||
        Object.values(JSON.parse(localStorage.getItem(key(owner)) ?? '{}')).includes('ndr'))
    )
      await ensure();
  }
  async function send(
    peer: string,
    event: NostrEvent,
    options: { localMessageId?: number; targetEventId?: string | null } = {},
  ): Promise<NostrEvent | null> {
    const local = options.localMessageId
      ? await chatDataService.getMessageById(options.localMessageId)
      : null;
    const target = options.targetEventId
      ? await chatDataService.getMessageByEventId(options.targetEventId)
      : null;
    const protocol =
      local?.meta.protocol ??
      (event.kind !== 14 && target ? (target.meta.protocol ?? 'nip17') : undefined) ??
      (await protocols.resolve(peer, options.localMessageId));
    if (protocol !== 'ndr') {
      if (local && !local.meta.protocol)
        await chatDataService.updateMessageMeta(local.id, { ...local.meta, protocol: 'nip17' });
      return null;
    }
    // Persist the chosen protocol before initialization or signing can fail. A retry cannot downgrade it.
    if (local)
      await chatDataService.updateMessageMeta(local.id, { ...local.meta, protocol: 'ndr' });
    localStorage.setItem(`${key()}:enabled`, '1');
    const runtime = await ensure();
    const rumor = await runtime.send(peer, event, async (prepared) => {
      if (local && event.kind === 14) {
        await chatDataService.updateMessageMeta(local.id, {
          ...local.meta,
          protocol: 'ndr',
          ratchet_delivery: 'queued',
        });
        await chatDataService.updateMessageEventId(local.id, prepared.id);
      }
      await nostrEventDataService.upsertEvent({
        event: prepared,
        direction: 'out',
        relay_statuses: [],
      });
    });
    return rumor;
  }
  return {
    async readMessagingDevices(signal?: AbortSignal) {
      const owner = deps.owner();
      const version = generation;
      if (!owner) throw new Error('Sign in to view messaging devices.');
      const { readMessagingDevices } = await import('./ratchetDevices.ts');
      return readMessagingDevices({
        client: deps.client,
        owner,
        isCurrent: () => deps.owner() === owner && version === generation,
        relays: () => deps.relays(),
        signal,
      });
    },
    getDirectMessageProtocol: protocols.getPreference,
    setDirectMessageProtocol,
    directMessageMode: protocols.mode,
    watchDirectMessagePeer: protocols.watch,
    getPreferRatchet: protocols.getPreferRatchet,
    setPreferRatchet: protocols.setPreferRatchet,
    resume,
    close,
    send,
  };
}
