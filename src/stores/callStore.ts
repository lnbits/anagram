import { defineStore } from 'pinia';
import {
  callMediaSupported,
  createCallMediaReceiver,
  getCallMedia,
  recordCallMedia,
} from 'src/services/callMediaService';
import { hasSeenCallControl, rememberCallControl } from 'src/services/callReplayCache';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { createIrohCallEndpoint } from 'src/services/irohCallTransport';
import { createCallRuntime } from 'src/stores/nostr/callRuntime';
import { resolveIncomingChatInboxStateValue } from 'src/stores/nostr/valueUtils';
import { useNostrStore } from 'src/stores/nostrStore';

export const useCallStore = defineStore('calls', () =>
  createCallRuntime({
    sendSignal: (peer, signal) => useNostrStore().sendCallSignal(peer, signal),
    getOwnPubkey: () => useNostrStore().getLoggedInPublicKeyHex(),
    async resolvePeer(peer) {
      const nostr = useNostrStore();
      if (nostr.isPubkeyBlocked(peer)) return null;
      const [contact, chat] = await Promise.all([
        contactsService.getContactByPublicKey(peer),
        chatDataService.getChatByPublicKey(peer),
      ]);
      if (
        contact?.type === 'group' ||
        chat?.type === 'group' ||
        contact?.meta.blocked ||
        chat?.meta?.inbox_state === 'blocked' ||
        contact?.meta.muted ||
        chat?.meta?.muted
      )
        return null;
      if (
        resolveIncomingChatInboxStateValue({
          chat,
          isAcceptedContact: contact?.meta.private_contact_list_member === true,
        }) !== 'accepted'
      )
        return null;
      return { name: contact?.name || chat?.name || peer.slice(0, 12) };
    },
    supported: callMediaSupported,
    hasSeen: (peer, id) =>
      hasSeenCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    remember: (peer, id) =>
      rememberCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    createEndpoint: createIrohCallEndpoint,
    getMedia: getCallMedia,
    createReceiver: createCallMediaReceiver,
    record: recordCallMedia,
  })
);
