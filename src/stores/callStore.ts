import { defineStore } from 'pinia';
import {
  callMediaSupported,
  createCallMediaReceiver,
  getCallCamera,
  getCallMedia,
  getCallMicrophone,
  getCallScreen,
  recordCallMedia,
} from 'src/services/callMediaService';
import { primeCallAudio } from 'src/services/callPlaybackService';
import { hasSeenCallControl, rememberCallControl } from 'src/services/callReplayCache';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { createIrohCallEndpoint } from 'src/services/irohCallTransport';
import { useCallRoomStore } from 'src/stores/callRoomStore';
import { useMessageStore } from 'src/stores/messageStore';
import { createCallRuntime } from 'src/stores/nostr/callRuntime';
import { resolveIncomingChatInboxStateValue } from 'src/stores/nostr/valueUtils';
import { useNostrStore } from 'src/stores/nostrStore';
import type { CallMode } from 'src/types/call';
import { callHistoryFromSession } from 'src/utils/callHistory';

export const useCallStore = defineStore('calls', () => {
  const runtime = createCallRuntime({
    async onEnded(session) {
      await useMessageStore().sendCallHistory(session.peerPubkey, callHistoryFromSession(session));
    },
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
    otherCallBusy: () => useCallRoomStore().busy,
    hasSeen: (peer, id) =>
      hasSeenCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    remember: (peer, id) =>
      rememberCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    createEndpoint: () =>
      createIrohCallEndpoint(
        useNostrStore()
          .getIrohRelays()
          .filter((entry) => entry.enabled)
          .map((entry) => entry.url)
      ),
    getMedia: getCallMedia,
    getMicrophone: getCallMicrophone,
    getCamera: getCallCamera,
    getScreen: getCallScreen,
    unlockPlayback: primeCallAudio,
    createReceiver: createCallMediaReceiver,
    record: recordCallMedia,
  });
  return {
    ...runtime,
    async start(peer: string, mode: CallMode) {
      if (useCallRoomStore().busy) {
        runtime.error.value = 'room.error.busy';
        return;
      }
      await runtime.start(peer, mode);
    },
  };
});
