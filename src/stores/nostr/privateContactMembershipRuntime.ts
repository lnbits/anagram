import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY } from '#src/stores/nostr/constants.ts';
import type { ContactMetadata, ContactRecord } from '#src/types/contact.ts';

interface PrivateContactMembershipRuntimeDeps {
  bumpContactListVersion: () => void;
  chatStore: {
    acceptChat: (publicKey: string, options: { acceptedAt: string }) => Promise<void>;
    init: () => Promise<void>;
  };
}

export function createPrivateContactMembershipRuntime({
  bumpContactListVersion,
  chatStore,
}: PrivateContactMembershipRuntimeDeps) {
  async function ensureContactListedInPrivateContactList(
    targetPubkeyHex: string,
    options: {
      fallbackName?: string;
      type?: 'user' | 'group';
    } = {}
  ): Promise<{
    contact: ContactRecord | null;
    didChange: boolean;
  }> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    if (!normalizedTargetPubkey) {
      return {
        contact: null,
        didChange: false,
      };
    }

    await contactsService.init();
    const existingContact = await contactsService.getContactByPublicKey(normalizedTargetPubkey);
    const fallbackName =
      options.fallbackName?.trim() ||
      existingContact?.name?.trim() ||
      normalizedTargetPubkey.slice(0, 16);

    const nextMeta: ContactMetadata = {
      ...(existingContact?.meta ?? {}),
      [PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY]: true,
    };

    if (!existingContact) {
      const createdContact = await contactsService.createContact({
        public_key: normalizedTargetPubkey,
        ...(options.type ? { type: options.type } : {}),
        name: fallbackName,
        given_name: null,
        meta: nextMeta,
        relays: [],
      });
      if (createdContact) {
        bumpContactListVersion();
      }
      return {
        contact: createdContact,
        didChange: Boolean(createdContact),
      };
    }

    const shouldUpdateType = options.type ? existingContact.type !== options.type : false;
    const shouldUpdateMeta =
      JSON.stringify(inputSanitizerService.normalizeContactMetadata(existingContact.meta ?? {})) !==
      JSON.stringify(inputSanitizerService.normalizeContactMetadata(nextMeta));

    if (!shouldUpdateType && !shouldUpdateMeta) {
      return {
        contact: existingContact,
        didChange: false,
      };
    }

    const updatedContact = await contactsService.updateContact(existingContact.id, {
      metaBase: existingContact.meta,
      ...(shouldUpdateType ? { type: options.type } : {}),
      ...(shouldUpdateMeta ? { meta: nextMeta } : {}),
    });
    if (updatedContact) {
      bumpContactListVersion();
    }

    return {
      contact: updatedContact ?? existingContact,
      didChange: Boolean(updatedContact),
    };
  }

  async function reconcileAcceptedChatFromPrivateContactList(
    contactPublicKey: string
  ): Promise<void> {
    const normalizedContactPublicKey = inputSanitizerService.normalizeHexKey(contactPublicKey);
    if (!normalizedContactPublicKey) {
      return;
    }

    await Promise.all([chatDataService.init(), chatStore.init()]);
    const existingChat = await chatDataService.getChatByPublicKey(normalizedContactPublicKey);
    if (!existingChat) {
      return;
    }

    const currentInboxState =
      existingChat.meta && typeof existingChat.meta.inbox_state === 'string'
        ? existingChat.meta.inbox_state.trim()
        : '';
    const acceptedAt =
      existingChat.meta && typeof existingChat.meta.accepted_at === 'string'
        ? existingChat.meta.accepted_at.trim()
        : '';
    if (currentInboxState === 'accepted' && acceptedAt) {
      return;
    }

    await chatStore.acceptChat(normalizedContactPublicKey, {
      acceptedAt: acceptedAt || new Date().toISOString(),
    });
  }

  return {
    ensureContactListedInPrivateContactList,
    reconcileAcceptedChatFromPrivateContactList,
  };
}
