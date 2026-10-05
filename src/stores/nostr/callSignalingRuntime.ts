import type NDK from '@nostr-dev-kit/ndk';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import type { createRelayPublishRuntime } from 'src/stores/nostr/relayPublishRuntime';
import { CALL_SIGNAL_KIND, type CallSignal } from 'src/types/call';
import type { CallRoomSignal } from 'src/types/callRoom';
import { parseRoomSignal, roomRelays } from 'src/utils/callRoom';
import { parseCallSignal } from 'src/utils/callSignal';
import { resolvePreferredContactRelayUrls } from 'src/utils/contactRelayUrls';

export function createCallSignalingRuntime(deps: {
  ndk: NDK;
  getOwnPubkey(): string | null;
  isBlocked(peer: string): boolean;
  refreshRelays(peer: string): Promise<unknown>;
  getAppRelays(): string[];
  sendRumor: ReturnType<typeof createRelayPublishRuntime>['sendGiftWrappedRumor'];
}) {
  function publishSignal(own: string, peer: string, relays: string[], content: string) {
    return deps.sendRumor(
      peer,
      relays,
      CALL_SIGNAL_KIND,
      (sender, recipient, createdAt) => {
        if (sender !== own || deps.getOwnPubkey() !== own || deps.isBlocked(peer))
          throw new Error('Call session changed');
        return new NDKEvent(deps.ndk, {
          kind: CALL_SIGNAL_KIND,
          pubkey: sender,
          created_at: createdAt,
          tags: [['p', recipient]],
          content,
        });
      },
      { publishSelfCopy: false }
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
    let refreshError: unknown;
    try {
      await deps.refreshRelays(peer);
    } catch (cause) {
      refreshError = cause;
    }
    // A metadata relay timing out must not discard an already known delivery route.
    const contact = await contactsService.getContactByPublicKey(peer);
    if (
      contact?.type === 'group' ||
      contact?.meta.blocked ||
      deps.isBlocked(peer) ||
      deps.getOwnPubkey() !== own
    ) {
      throw new Error('Call recipient is unavailable.');
    }
    const relays = inputSanitizerService
      .normalizeRelayEntriesFromUrls([
        ...resolvePreferredContactRelayUrls(contact?.relays),
        ...(contact?.sendMessagesToAppRelays ? deps.getAppRelays() : []),
      ])
      .map((entry) => entry.url);
    if (!relays.length && refreshError) throw refreshError;
    await publishSignal(own, peer, relays, content);
  }
  async function sendRoomSignal(
    peerInput: string,
    signal: CallRoomSignal,
    relayHints: string[]
  ): Promise<void> {
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    const own = deps.getOwnPubkey();
    const relays = roomRelays(relayHints);
    const content = JSON.stringify(signal);
    if (
      !peer ||
      !own ||
      peer === own ||
      deps.isBlocked(peer) ||
      !relays ||
      !parseRoomSignal(content, Math.floor(Date.now() / 1000))
    )
      throw new Error('Invalid room control');
    await publishSignal(own, peer, relays, content);
  }
  return { sendCallSignal, sendRoomSignal };
}
