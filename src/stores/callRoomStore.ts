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
import { contactsService } from 'src/services/contactsService';
import { createIrohCallEndpoint } from 'src/services/irohCallTransport';
import { useCallStore } from './callStore';
import { createCallRoomRuntime } from './nostr/callRoomRuntime';
import { useNostrStore } from './nostrStore';

export const useCallRoomStore = defineStore('callRooms', () =>
  createCallRoomRuntime({
    getOwnPubkey: () => useNostrStore().getLoggedInPublicKeyHex(),
    async getIdentity() {
      const nostr = useNostrStore();
      const own = nostr.getLoggedInPublicKeyHex();
      if (!own) throw new Error('No active account');
      const contact = await contactsService.getContactByPublicKey(own);
      return {
        name: contact?.name || own.slice(0, 12),
        relays: await nostr.listPrivateMessageReadRelayUrls(),
      };
    },
    isBlocked: (peer) => useNostrStore().isPubkeyBlocked(peer),
    otherCallBusy: () => {
      const session = useCallStore().session;
      return Boolean(session && session.phase !== 'ended');
    },
    send: (peer, signal, relays) => useNostrStore().sendRoomSignal(peer, signal, relays),
    media: {
      supported: callMediaSupported,
      getMedia: getCallMedia,
      getCamera: getCallCamera,
      getMicrophone: getCallMicrophone,
      getScreen: getCallScreen,
      createEndpoint: () =>
        createIrohCallEndpoint(
          useNostrStore()
            .getIrohRelays()
            .filter((entry) => entry.enabled)
            .map((entry) => entry.url)
        ),
      createReceiver: createCallMediaReceiver,
      record: recordCallMedia,
      unlockPlayback: primeCallAudio,
    },
  })
);
