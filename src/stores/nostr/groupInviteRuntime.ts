import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { GROUP_INVITE_REQUEST_MESSAGE } from 'src/stores/nostr/constants';
import {
  buildAcceptedGroupInviteChatPlanValue,
  buildGroupInviteRequestPlanValue,
  resolveCurrentGroupChatEpochEntryValue,
  resolveGroupDisplayNameValue,
} from 'src/stores/nostr/valueUtils';
import type { ChatMetadata } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';

interface GroupInviteRuntimeDeps {
  bumpContactListVersion: () => void;
  chatStore: {
    init: () => Promise<void>;
    reload: () => Promise<void>;
    syncContactProfile: (publicKey: string) => Promise<void>;
  };
  ensureContactListedInPrivateContactList: (
    targetPubkeyHex: string,
    options?: {
      fallbackName?: string;
      type?: 'user' | 'group';
    }
  ) => Promise<{
    contact: ContactRecord | null;
    didChange: boolean;
  }>;
  ensureContactStoredAsGroup: (
    groupPublicKey: string,
    options?: {
      fallbackName?: string;
    }
  ) => Promise<ContactRecord | null>;
  getAppRelayUrls: () => string[];
  getLoggedInPublicKeyHex: () => string | null;
  publishPrivateContactList: (seedRelayUrls?: string[]) => Promise<void>;
  refreshGroupContactByPublicKey: (
    groupPublicKey: string,
    fallbackName?: string,
    seedRelayUrls?: string[]
  ) => Promise<ContactRecord | null>;
  restoreGroupEpochHistory: (
    groupPublicKey: string,
    epochPublicKey: string,
    options?: {
      force?: boolean;
      seedRelayUrls?: string[];
    }
  ) => Promise<void>;
  subscribeGroupMembershipRosterUpdates: (
    seedRelayUrls?: string[],
    force?: boolean
  ) => Promise<void>;
  subscribePrivateMessagesForLoggedInUser: (force?: boolean) => Promise<void>;
}

export function createGroupInviteRuntime({
  bumpContactListVersion,
  chatStore,
  ensureContactListedInPrivateContactList,
  ensureContactStoredAsGroup,
  getAppRelayUrls,
  getLoggedInPublicKeyHex,
  publishPrivateContactList,
  refreshGroupContactByPublicKey,
  restoreGroupEpochHistory,
  subscribeGroupMembershipRosterUpdates,
  subscribePrivateMessagesForLoggedInUser,
}: GroupInviteRuntimeDeps) {
  async function upsertIncomingGroupInviteRequestChat(
    groupPublicKey: string,
    createdAt: string,
    preview: Pick<ContactRecord, 'name' | 'meta'> | null = null
  ): Promise<void> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    if (!normalizedGroupPublicKey) {
      return;
    }

    await Promise.all([chatDataService.init(), chatStore.init()]);

    const existingChat = await chatDataService.getChatByPublicKey(normalizedGroupPublicKey);
    const invitePlan = buildGroupInviteRequestPlanValue({
      groupPublicKey: normalizedGroupPublicKey,
      createdAt,
      existingChat,
      preview,
    });
    if (!invitePlan) {
      return;
    }

    if (!existingChat) {
      await chatDataService.createChat({
        public_key: normalizedGroupPublicKey,
        type: 'group',
        name: invitePlan.nextName,
        last_message: GROUP_INVITE_REQUEST_MESSAGE,
        last_message_at: createdAt,
        unread_count: invitePlan.nextUnreadCount,
        meta: invitePlan.nextMeta,
      });
      await chatStore.reload();
      return;
    }

    await chatDataService.updateChat(normalizedGroupPublicKey, {
      type: 'group',
      ...(existingChat.name !== invitePlan.nextName ? { name: invitePlan.nextName } : {}),
      meta: invitePlan.nextMeta,
    });
    await chatDataService.updateChatPreview(
      normalizedGroupPublicKey,
      GROUP_INVITE_REQUEST_MESSAGE,
      createdAt,
      invitePlan.nextUnreadCount
    );
    await chatStore.reload();
  }

  async function ensureGroupInvitePubkeyIsContact(
    targetPubkeyHex: string,
    fallbackName = ''
  ): Promise<void> {
    const normalizedTargetPubkey = inputSanitizerService.normalizeHexKey(targetPubkeyHex);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (
      !normalizedTargetPubkey ||
      !loggedInPubkeyHex ||
      normalizedTargetPubkey === loggedInPubkeyHex
    ) {
      return;
    }

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const initialName = fallbackName.trim() || resolveGroupDisplayNameValue(normalizedTargetPubkey);
    await ensureContactStoredAsGroup(normalizedTargetPubkey, {
      fallbackName: initialName,
    });
    await ensureContactListedInPrivateContactList(normalizedTargetPubkey, {
      fallbackName: initialName,
      type: 'group',
    });

    const existingChat = await chatDataService.getChatByPublicKey(normalizedTargetPubkey);
    const hadTrackedGroupEpochBeforeAccept =
      existingChat?.type === 'group' &&
      typeof existingChat.meta?.current_epoch_public_key === 'string' &&
      existingChat.meta.current_epoch_public_key.trim().length > 0;
    let acceptedGroupEpochPublicKey = '';
    if (existingChat) {
      const acceptedChatPlan = buildAcceptedGroupInviteChatPlanValue({
        groupPublicKey: normalizedTargetPubkey,
        fallbackName: initialName,
        existingChat,
        acceptedAt: new Date().toISOString(),
      });

      if (acceptedChatPlan) {
        await chatDataService.updateChat(normalizedTargetPubkey, {
          type: 'group',
          ...(existingChat.name !== acceptedChatPlan.nextName
            ? { name: acceptedChatPlan.nextName }
            : {}),
          meta: acceptedChatPlan.nextMeta as ChatMetadata,
        });

        acceptedGroupEpochPublicKey =
          resolveCurrentGroupChatEpochEntryValue({
            type: 'group',
            meta: acceptedChatPlan.nextMeta as ChatMetadata,
          })?.epoch_public_key ?? '';
      }

      if (!acceptedGroupEpochPublicKey) {
        acceptedGroupEpochPublicKey =
          resolveCurrentGroupChatEpochEntryValue(existingChat)?.epoch_public_key ?? '';
      }
    }

    if (acceptedGroupEpochPublicKey) {
      try {
        await restoreGroupEpochHistory(normalizedTargetPubkey, acceptedGroupEpochPublicKey, {
          force: false,
        });
      } catch (error) {
        console.warn(
          'Failed to restore group epoch history after accepting group invite',
          normalizedTargetPubkey,
          acceptedGroupEpochPublicKey,
          error
        );
      }
    } else if (!hadTrackedGroupEpochBeforeAccept) {
      try {
        await subscribePrivateMessagesForLoggedInUser(true);
      } catch (error) {
        console.warn(
          'Failed to refresh private messages after accepting group invite',
          normalizedTargetPubkey,
          error
        );
      }
    }

    try {
      await refreshGroupContactByPublicKey(normalizedTargetPubkey, initialName);
    } catch (error) {
      console.warn(
        'Failed to refresh accepted group invite profile',
        normalizedTargetPubkey,
        error
      );
      await chatStore.syncContactProfile(normalizedTargetPubkey);
    }

    bumpContactListVersion();
    await chatStore.reload();

    try {
      await subscribeGroupMembershipRosterUpdates(getAppRelayUrls(), true);
    } catch (error) {
      console.warn(
        'Failed to refresh group roster subscription after accepting group invite',
        normalizedTargetPubkey,
        error
      );
    }

    try {
      await publishPrivateContactList(getAppRelayUrls());
    } catch (error) {
      console.warn('Failed to publish private contact list after accepting group invite', error);
    }
  }

  return {
    ensureGroupInvitePubkeyIsContact,
    upsertIncomingGroupInviteRequestChat,
  };
}
