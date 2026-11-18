import type NostrClient from '#src/lib/nostr/client.ts';
import { ClientEvent } from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { createRelayPublishRuntime } from '#src/stores/nostr/relayPublishRuntime.ts';
import { CALL_SIGNAL_KIND, type CallSignal } from '#src/types/call.ts';
import type { CallRoomSignal } from '#src/types/callRoom.ts';
import { parseRoomSignal, roomRelays } from '#src/utils/callRoom.ts';
import { parseCallSignal } from '#src/utils/callSignal.ts';
import { resolvePreferredContactRelayUrls } from '#src/utils/contactRelayUrls.ts';
import type { createRatchetIntegration } from './ratchetIntegration.ts';

export function createCallSignalingRuntime(deps: {
  ndk: NostrClient;
  getOwnPubkey(): string | null;
  isBlocked(peer: string): boolean;
  refreshRelays(peer: string): Promise<unknown>;
  getAppRelays(): string[];
  sendRumor: ReturnType<typeof createRelayPublishRuntime>['sendGiftWrappedRumor'];
  sendRatchet: ReturnType<typeof createRatchetIntegration>['send'];
}) {
  const refreshes = new Map<string, Promise<void>>();
  function refreshRoutes(own: string, peer: string) {
    const key = `${own}:${peer}`;
    let pending = refreshes.get(key);
    if (!pending) {
      // Repeated recovery controls share discovery; a stalled relay must not
      // create a new metadata subscription for every retry.
      if (refreshes.size >= 32) return Promise.resolve();
      pending = deps
        .refreshRelays(peer)
        .then(() => {})
        .catch(() => {})
        .finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    return pending;
  }
  async function readPeer(own: string, peer: string) {
    const contact = await contactsService.getContactByPublicKey(peer);
    if (contact?.type === 'group' || contact?.meta?.blocked || deps.isBlocked(peer) || deps.getOwnPubkey() !== own)
      throw new Error('Call recipient is unavailable.');
    return contact;
  }
  async function queueRatchet(own: string, peer: string, content: string) {
    const draft = new ClientEvent(deps.ndk, {
      kind: CALL_SIGNAL_KIND, pubkey: own, tags: [['p', peer]], content,
    });
    return await deps.sendRatchet(peer, draft.rawEvent()) !== null;
  }
  function publishSignal(own: string, peer: string, relays: string[], content: string) {
    return deps.sendRumor(
      peer,
      relays,
      CALL_SIGNAL_KIND,
      (sender, recipient, createdAt) => {
        if (sender !== own || deps.getOwnPubkey() !== own || deps.isBlocked(peer))
          throw new Error('Call session changed');
        return new ClientEvent(deps.ndk, {
          kind: CALL_SIGNAL_KIND,
          pubkey: sender,
          created_at: createdAt,
          tags: [['p', recipient]],
          content,
        });
      },
      { publishSelfCopy: false, returnOnFirstAck: true },
    );
  }
  async function sendCallSignal(peerInput: string, signal: CallSignal): Promise<void> {
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    const own = deps.getOwnPubkey();
    if (!peer || !own || peer === own || deps.isBlocked(peer))
      throw new Error('Call recipient is unavailable.');
    const content = JSON.stringify(signal);
    const now = Math.floor(Date.now() / 1000);
    if (!parseCallSignal(content, now)) throw new Error('Invalid call signal.');
    const contact = await readPeer(own, peer);
    if (await queueRatchet(own, peer, content)) return;
    const routes = (contact: Awaited<ReturnType<typeof readPeer>>) => {
      return inputSanitizerService
        .normalizeRelayEntriesFromUrls([
          ...resolvePreferredContactRelayUrls(contact?.relays),
          ...deps.getAppRelays(),
        ])
        .map((entry) => entry.url);
    };
    const known = routes(contact);
    // Discovery must not hold up ringing, answering or hanging up on known routes.
    const refresh = refreshRoutes(own, peer);
    const publish = (relays: string[]) => {
      if (deps.getOwnPubkey() !== own || deps.isBlocked(peer))
        throw new Error('Call recipient is unavailable.');
      if (Date.parse(signal.expiresAt) <= Date.now()) throw new Error('Call signal expired');
      if (!relays.length) throw new Error('No call delivery relays');
      return publishSignal(own, peer, relays, content);
    };
    let failure: unknown;
    if (known.length) {
      try {
        await publish(known);
        return;
      } catch (cause) {
        failure = cause;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refresh,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const updated = routes(await readPeer(own, peer));
    if (failure && !updated.some((url) => !known.includes(url))) throw failure;
    await publish(updated);
  }

  async function sendRoomSignal(
    peerInput: string,
    signal: CallRoomSignal,
    relayHints: string[],
  ): Promise<void> {
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    const own = deps.getOwnPubkey();
    const content = JSON.stringify(signal);
    if (
      !peer ||
      !own ||
      peer === own ||
      deps.isBlocked(peer) ||
      !parseRoomSignal(content, Math.floor(Date.now() / 1000))
    )
      throw new Error('Invalid room control');
    await readPeer(own, peer);
    if (await queueRatchet(own, peer, content)) return;
    const relays = roomRelays(relayHints);
    if (!relays) throw new Error('Invalid room control');
    await publishSignal(own, peer, relays, content);
  }
  return { sendCallSignal, sendRoomSignal };
}
