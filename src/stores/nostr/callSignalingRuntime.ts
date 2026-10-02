import type NDK from '@nostr-dev-kit/ndk';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import type { createRelayPublishRuntime } from 'src/stores/nostr/relayPublishRuntime';
import { CALL_SIGNAL_KIND, type CallSignal } from 'src/types/call';
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
  async function sendCallSignal(peerInput: string, signal: CallSignal): Promise<void> {
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    const own = deps.getOwnPubkey();
    if (!peer || !own || peer === own || deps.isBlocked(peer))
      throw new Error('Call recipient is unavailable.');
    const content = JSON.stringify(signal);
    const now = Math.floor(Date.now() / 1000);
    if (!parseCallSignal(content, now)) throw new Error('Invalid call signal.');
    await deps.refreshRelays(peer);
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
    await deps.sendRumor(
      peer,
      relays,
      CALL_SIGNAL_KIND,
      (sender, recipient, createdAt) =>
        new NDKEvent(deps.ndk, {
          kind: CALL_SIGNAL_KIND,
          pubkey: sender,
          created_at: createdAt,
          tags: [['p', recipient]],
          content,
        }),
      { publishSelfCopy: false }
    );
  }
  return { sendCallSignal };
}
