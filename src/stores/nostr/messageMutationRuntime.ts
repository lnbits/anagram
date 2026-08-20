import NDK, { NDKEvent, NDKKind, type NostrEvent } from '@nostr-dev-kit/ndk';
import { getEmojiEntryByValue } from 'src/data/topEmojis';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { UNKNOWN_REPLY_MESSAGE_TEXT } from 'src/stores/nostr/constants';
import type {
  MessageRow,
  PendingIncomingDeletion,
  PendingIncomingReaction,
  QueuePrivateMessageUiRefreshOptions,
} from 'src/stores/nostr/types';
import type {
  MessageReaction,
  MessageRelayStatus,
  MessageReplyPreview,
  NostrEventDirection,
} from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';
import { buildMessageReplyPreviewContent } from 'src/utils/messageAttachments';
import { buildMetaWithReactions, normalizeMessageReactions } from 'src/utils/messageReactions';

interface MessageMutationRuntimeDeps {
  buildInboundTraceDetails: (options: {
    wrappedEvent?: NDKEvent | null;
    rumorEvent?: NDKEvent | NostrEvent | null;
    senderPubkeyHex?: string | null;
    chatPubkey?: string | null;
    targetEventId?: string | null;
    relayUrls?: string[];
  }) => Record<string, unknown>;
  deriveChatName: (contact: ContactRecord | null, publicKey: string) => string;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  logInboundEvent: (stage: string, details?: Record<string, unknown>) => void;
  ndk: NDK;
  normalizeEventId: (value: unknown) => string | null;
  normalizeThrottleMs: (value: number | undefined) => number;
  queuePendingIncomingDeletion: (
    targetEventId: string,
    pendingDeletion: PendingIncomingDeletion
  ) => void;
  queuePendingIncomingReaction: (
    targetEventId: string,
    pendingReaction: PendingIncomingReaction
  ) => void;
  queuePrivateMessagesUiRefresh: (options?: QueuePrivateMessageUiRefreshOptions) => void;
  readDeletionTargetEntries: (event: NDKEvent) => Array<{ eventId: string; kind: number | null }>;
  readReactionTargetAuthorPubkey: (event: NDKEvent) => string | null;
  readReactionTargetEventId: (event: NDKEvent) => string | null;
  refreshMessageInLiveState: (messageId: number) => Promise<void>;
  removePendingIncomingReaction: (
    targetEventId: string,
    reactionEventId: string,
    reactorPublicKey: string
  ) => void;
  repairMissingMessageDependency: (
    chatPublicKey: string,
    targetEventId: string,
    options: {
      reason: 'reply-target-missing' | 'reaction-target-missing' | 'deletion-target-missing';
      immediate?: boolean;
      referenceCreatedAt?: number | null;
      seedRelayUrls?: string[];
    }
  ) => Promise<boolean>;
  resolveMissingMessageDependencyRepair: (targetEventId: string) => void;
  toIsoTimestampFromUnix: (value: number | undefined) => string;
  consumePendingIncomingDeletions: (targetEventId: string) => PendingIncomingDeletion[];
  consumePendingIncomingReactions: (targetEventId: string) => PendingIncomingReaction[];
}

export function createMessageMutationRuntime({
  buildInboundTraceDetails,
  deriveChatName,
  formatSubscriptionLogValue,
  getLoggedInPublicKeyHex,
  logInboundEvent,
  ndk,
  normalizeEventId,
  normalizeThrottleMs,
  queuePendingIncomingDeletion,
  queuePendingIncomingReaction,
  queuePrivateMessagesUiRefresh,
  readDeletionTargetEntries,
  readReactionTargetAuthorPubkey,
  readReactionTargetEventId,
  refreshMessageInLiveState,
  removePendingIncomingReaction,
  repairMissingMessageDependency,
  resolveMissingMessageDependencyRepair,
  toIsoTimestampFromUnix,
  consumePendingIncomingDeletions,
  consumePendingIncomingReactions,
}: MessageMutationRuntimeDeps) {
  function buildDeletedMessageMeta(
    deletedByPublicKey: string,
    deletedEventKind: number,
    deletedAt: string,
    deleteEventId?: string | null
  ): Record<string, unknown> {
    return {
      deletedAt,
      deletedByPublicKey,
      deletedEventKind,
      ...(normalizeEventId(deleteEventId)
        ? { deleteEventId: normalizeEventId(deleteEventId) }
        : {}),
    };
  }

  async function syncChatUnseenReactionCount(chatPublicKey: string): Promise<void> {
    try {
      const { useMessageStore } = await import('src/stores/messageStore');
      await useMessageStore().syncChatUnseenReactionCount(chatPublicKey);
    } catch (error) {
      console.warn('Failed to synchronize unseen reaction count for chat', chatPublicKey, error);
    }
  }

  function queueMissingMessageDependencyRepair(
    chatPubkey: string,
    targetEventId: string,
    options: {
      reason: 'reply-target-missing' | 'reaction-target-missing' | 'deletion-target-missing';
      referenceCreatedAt?: number | null;
      seedRelayUrls?: string[];
    }
  ): void {
    const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(chatPubkey);
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedChatPubkey || !normalizedTargetEventId) {
      return;
    }

    void repairMissingMessageDependency(normalizedChatPubkey, normalizedTargetEventId, {
      reason: options.reason,
      immediate: true,
      referenceCreatedAt: options.referenceCreatedAt ?? null,
      seedRelayUrls: options.seedRelayUrls,
    }).catch((error) => {
      console.warn(
        'Failed to queue missing message dependency repair',
        normalizedChatPubkey,
        normalizedTargetEventId,
        error
      );
    });
  }

  function buildUnknownReplyPreview(targetEventId: string | null): MessageReplyPreview {
    return {
      messageId: targetEventId ?? '',
      text: UNKNOWN_REPLY_MESSAGE_TEXT,
      sender: 'them',
      authorName: 'Unknown',
      authorPublicKey: '',
      sentAt: '',
      eventId: targetEventId,
    };
  }

  async function buildReplyPreviewFromMessageRow(
    targetMessage: MessageRow,
    chatPubkey: string,
    loggedInPubkeyHex: string,
    contact?: ContactRecord | null
  ): Promise<MessageReplyPreview> {
    const targetAuthorPublicKey =
      inputSanitizerService.normalizeHexKey(targetMessage.author_public_key) ?? '';
    const isOwnTargetMessage = targetAuthorPublicKey === loggedInPubkeyHex;
    const replyContact =
      contact === undefined ? await contactsService.getContactByPublicKey(chatPubkey) : contact;
    const replyContent = buildMessageReplyPreviewContent(targetMessage.message, targetMessage.meta);

    return {
      messageId: String(targetMessage.id),
      text: replyContent.text || UNKNOWN_REPLY_MESSAGE_TEXT,
      ...(replyContent.imageUrl ? { imageUrl: replyContent.imageUrl } : {}),
      sender: isOwnTargetMessage ? 'me' : 'them',
      authorName: isOwnTargetMessage ? 'You' : deriveChatName(replyContact, chatPubkey),
      authorPublicKey: targetAuthorPublicKey,
      sentAt: targetMessage.created_at,
      eventId: normalizeEventId(targetMessage.event_id),
    };
  }

  async function upsertReactionOnMessageRow(
    messageRow: MessageRow,
    pendingReaction: PendingIncomingReaction,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<MessageRow | null> {
    const normalizedMessageChatPubkey = inputSanitizerService.normalizeHexKey(
      messageRow.chat_public_key
    );
    if (
      !normalizedMessageChatPubkey ||
      normalizedMessageChatPubkey !== pendingReaction.chatPublicKey
    ) {
      return null;
    }

    const normalizedMessageAuthorPubkey = inputSanitizerService.normalizeHexKey(
      messageRow.author_public_key
    );
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const shouldDefaultReactionAsViewed =
      loggedInPubkeyHex !== null &&
      normalizedMessageAuthorPubkey === loggedInPubkeyHex &&
      pendingReaction.reaction.reactorPublicKey === loggedInPubkeyHex;
    const defaultViewedByAuthorAt =
      pendingReaction.reaction.viewedByAuthorAt ??
      (shouldDefaultReactionAsViewed ? new Date().toISOString() : null);
    if (
      pendingReaction.targetAuthorPublicKey &&
      normalizedMessageAuthorPubkey !== pendingReaction.targetAuthorPublicKey
    ) {
      return null;
    }

    const currentReactions = normalizeMessageReactions(messageRow.meta.reactions);
    const existingReactionIndex = currentReactions.findIndex((reaction) => {
      const sameEventId =
        normalizeEventId(reaction.eventId) &&
        normalizeEventId(reaction.eventId) === normalizeEventId(pendingReaction.reaction.eventId);
      if (sameEventId) {
        return true;
      }

      return (
        reaction.emoji === pendingReaction.reaction.emoji &&
        reaction.reactorPublicKey === pendingReaction.reaction.reactorPublicKey
      );
    });
    if (existingReactionIndex >= 0) {
      const existingReaction = currentReactions[existingReactionIndex];
      const nextReaction: MessageReaction = {
        ...existingReaction,
        ...pendingReaction.reaction,
        createdAt: pendingReaction.reaction.createdAt ?? existingReaction.createdAt ?? null,
        eventId:
          normalizeEventId(pendingReaction.reaction.eventId) ??
          normalizeEventId(existingReaction.eventId) ??
          null,
        viewedByAuthorAt:
          pendingReaction.reaction.viewedByAuthorAt ??
          existingReaction.viewedByAuthorAt ??
          defaultViewedByAuthorAt,
      };
      const isUnchanged =
        nextReaction.emoji === existingReaction.emoji &&
        nextReaction.name === existingReaction.name &&
        nextReaction.reactorPublicKey === existingReaction.reactorPublicKey &&
        nextReaction.createdAt === existingReaction.createdAt &&
        normalizeEventId(nextReaction.eventId) === normalizeEventId(existingReaction.eventId) &&
        nextReaction.viewedByAuthorAt === existingReaction.viewedByAuthorAt;
      if (isUnchanged) {
        return messageRow;
      }

      const nextReactions = [...currentReactions];
      nextReactions.splice(existingReactionIndex, 1, nextReaction);
      const updatedRow = await chatDataService.updateMessageMeta(
        messageRow.id,
        buildMetaWithReactions(messageRow.meta, nextReactions)
      );
      if (!updatedRow) {
        return null;
      }

      const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
      if (uiThrottleMs > 0) {
        await syncChatUnseenReactionCount(updatedRow.chat_public_key);
        queuePrivateMessagesUiRefresh({
          throttleMs: uiThrottleMs,
          reloadMessages: true,
        });
        return updatedRow;
      }

      await refreshMessageInLiveState(updatedRow.id);
      await syncChatUnseenReactionCount(updatedRow.chat_public_key);
      return updatedRow;
    }

    if (
      pendingReaction.targetAuthorPublicKey &&
      normalizedMessageAuthorPubkey !== pendingReaction.targetAuthorPublicKey
    ) {
      return messageRow;
    }

    const updatedRow = await chatDataService.updateMessageMeta(
      messageRow.id,
      buildMetaWithReactions(messageRow.meta, [
        ...currentReactions,
        {
          ...pendingReaction.reaction,
          ...(defaultViewedByAuthorAt ? { viewedByAuthorAt: defaultViewedByAuthorAt } : {}),
        },
      ])
    );
    if (!updatedRow) {
      return null;
    }

    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
    if (uiThrottleMs > 0) {
      await syncChatUnseenReactionCount(updatedRow.chat_public_key);
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadMessages: true,
      });
      return updatedRow;
    }

    await refreshMessageInLiveState(updatedRow.id);
    await syncChatUnseenReactionCount(updatedRow.chat_public_key);
    return updatedRow;
  }

  async function removeReactionByEventIdFromMessageRow(
    messageRow: MessageRow,
    reactionEventId: string,
    reactorPublicKey: string,
    reactionEmoji: string | null,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<MessageRow | null> {
    const normalizedReactionEventId = normalizeEventId(reactionEventId);
    const normalizedReactorPublicKey = inputSanitizerService.normalizeHexKey(reactorPublicKey);
    if (!normalizedReactionEventId || !normalizedReactorPublicKey) {
      return null;
    }

    const currentReactions = normalizeMessageReactions(messageRow.meta.reactions);
    const nextReactions = currentReactions.filter((reaction) => {
      const sameEventId = normalizeEventId(reaction.eventId) === normalizedReactionEventId;
      if (sameEventId) {
        return false;
      }

      return !(
        normalizeEventId(reaction.eventId) === null &&
        reaction.reactorPublicKey === normalizedReactorPublicKey &&
        (!reactionEmoji || reaction.emoji === reactionEmoji)
      );
    });
    if (nextReactions.length === currentReactions.length) {
      return messageRow;
    }

    const updatedRow = await chatDataService.updateMessageMeta(
      messageRow.id,
      buildMetaWithReactions(messageRow.meta, nextReactions)
    );
    if (!updatedRow) {
      return null;
    }

    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
    if (uiThrottleMs > 0) {
      await syncChatUnseenReactionCount(updatedRow.chat_public_key);
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadMessages: true,
      });
      return updatedRow;
    }

    await refreshMessageInLiveState(updatedRow.id);
    await syncChatUnseenReactionCount(updatedRow.chat_public_key);
    return updatedRow;
  }

  async function markMessageRowDeleted(
    messageRow: MessageRow,
    deletedByPublicKey: string,
    deletedAt: string,
    deletedEventKind: number,
    deleteEventId: string | null,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<MessageRow | null> {
    const normalizedDeletedByPublicKey = inputSanitizerService.normalizeHexKey(deletedByPublicKey);
    if (!normalizedDeletedByPublicKey) {
      return null;
    }

    const updatedRow = await chatDataService.updateMessageMeta(messageRow.id, {
      ...messageRow.meta,
      deleted: buildDeletedMessageMeta(
        normalizedDeletedByPublicKey,
        deletedEventKind,
        deletedAt,
        deleteEventId
      ),
    });
    if (!updatedRow) {
      return null;
    }

    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
    if (uiThrottleMs > 0) {
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadMessages: true,
      });
      return updatedRow;
    }

    await refreshMessageInLiveState(updatedRow.id);
    return updatedRow;
  }

  async function applyPendingIncomingReactionsForMessage(
    messageRow: MessageRow,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<MessageRow> {
    const normalizedStoredEventId = normalizeEventId(messageRow.event_id);
    if (!normalizedStoredEventId) {
      return messageRow;
    }

    const pendingEntries = consumePendingIncomingReactions(normalizedStoredEventId);
    if (pendingEntries.length === 0) {
      return messageRow;
    }

    let currentMessageRow = messageRow;
    const remainingEntries: PendingIncomingReaction[] = [];
    for (const pendingReaction of pendingEntries) {
      const updatedRow = await upsertReactionOnMessageRow(
        currentMessageRow,
        pendingReaction,
        options
      );
      if (!updatedRow) {
        remainingEntries.push(pendingReaction);
        continue;
      }

      currentMessageRow = updatedRow;
    }

    if (remainingEntries.length > 0) {
      for (const remainingEntry of remainingEntries) {
        queuePendingIncomingReaction(normalizedStoredEventId, remainingEntry);
      }
    }

    return currentMessageRow;
  }

  async function applyPendingIncomingDeletionsForMessage(
    messageRow: MessageRow,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<MessageRow> {
    const normalizedMessageEventId = normalizeEventId(messageRow.event_id);
    const normalizedMessageAuthorPublicKey = inputSanitizerService.normalizeHexKey(
      messageRow.author_public_key
    );
    if (!normalizedMessageEventId || !normalizedMessageAuthorPublicKey) {
      return messageRow;
    }

    const pendingDeletions = consumePendingIncomingDeletions(normalizedMessageEventId);
    if (pendingDeletions.length === 0) {
      return messageRow;
    }

    let currentMessageRow = messageRow;
    for (const pendingDeletion of pendingDeletions) {
      if (
        pendingDeletion.deletionAuthorPublicKey !== normalizedMessageAuthorPublicKey ||
        (pendingDeletion.targetKind !== null &&
          pendingDeletion.targetKind !== NDKKind.PrivateDirectMessage)
      ) {
        continue;
      }

      const updatedRow = await markMessageRowDeleted(
        currentMessageRow,
        pendingDeletion.deletionAuthorPublicKey,
        pendingDeletion.deletedAt,
        NDKKind.PrivateDirectMessage,
        pendingDeletion.deleteEventId,
        options
      );
      if (updatedRow) {
        currentMessageRow = updatedRow;
      }
    }

    return currentMessageRow;
  }

  function consumePendingIncomingDeletionForReaction(
    reactionEventId: string,
    reactorPublicKey: string
  ): PendingIncomingDeletion | null {
    const normalizedReactionEventId = normalizeEventId(reactionEventId);
    const normalizedReactorPublicKey = inputSanitizerService.normalizeHexKey(reactorPublicKey);
    if (!normalizedReactionEventId || !normalizedReactorPublicKey) {
      return null;
    }

    const pendingDeletions = consumePendingIncomingDeletions(normalizedReactionEventId);
    return (
      pendingDeletions.find((entry) => {
        return (
          entry.deletionAuthorPublicKey === normalizedReactorPublicKey &&
          (entry.targetKind === null || entry.targetKind === NDKKind.Reaction)
        );
      }) ?? null
    );
  }

  async function processIncomingReactionRumorEvent(
    rumorEvent: NDKEvent,
    chatPubkey: string,
    senderPubkeyHex: string,
    options: {
      uiThrottleMs?: number;
      direction: NostrEventDirection;
      rumorNostrEvent: NostrEvent | null;
      relayStatuses: MessageRelayStatus[];
    }
  ): Promise<void> {
    const reactionEmoji = rumorEvent.content.trim();
    const targetEventId = readReactionTargetEventId(rumorEvent);
    const targetAuthorPublicKey = readReactionTargetAuthorPubkey(rumorEvent);
    const reactionEventId = normalizeEventId(options.rumorNostrEvent?.id ?? rumorEvent.id);
    const relayUrls = options.relayStatuses.map((entry) => entry.relay_url);
    if (!reactionEmoji || !targetEventId) {
      logInboundEvent('reaction-drop', {
        reason: 'missing-reaction-data',
        hasReactionEmoji: Boolean(reactionEmoji),
        hasTargetEventId: Boolean(targetEventId),
        ...buildInboundTraceDetails({
          rumorEvent,
          senderPubkeyHex,
          chatPubkey,
          targetEventId,
          relayUrls,
        }),
      });
      return;
    }

    await Promise.all([chatDataService.init(), nostrEventDataService.init()]);

    if (options.rumorNostrEvent && reactionEventId) {
      await nostrEventDataService.upsertEvent({
        event: options.rumorNostrEvent,
        direction: options.direction,
        relay_statuses: options.relayStatuses,
      });
    }

    if (reactionEventId) {
      const pendingDeletion = consumePendingIncomingDeletionForReaction(
        reactionEventId,
        senderPubkeyHex
      );
      if (pendingDeletion) {
        logInboundEvent('reaction-drop', {
          reason: 'pending-deletion-match',
          deleteEventId: formatSubscriptionLogValue(pendingDeletion.deleteEventId),
          ...buildInboundTraceDetails({
            rumorEvent,
            senderPubkeyHex,
            chatPubkey,
            targetEventId,
            relayUrls,
          }),
        });
        await nostrEventDataService.deleteEventsByIds([reactionEventId]);
        resolveMissingMessageDependencyRepair(reactionEventId);
        return;
      }
    }

    const pendingReaction: PendingIncomingReaction = {
      chatPublicKey: chatPubkey,
      targetAuthorPublicKey,
      reaction: {
        emoji: reactionEmoji,
        name: getEmojiEntryByValue(reactionEmoji)?.label ?? reactionEmoji,
        reactorPublicKey: senderPubkeyHex,
        createdAt: toIsoTimestampFromUnix(rumorEvent.created_at),
        ...(() => {
          const loggedInPubkeyHex = getLoggedInPublicKeyHex();
          if (
            loggedInPubkeyHex &&
            targetAuthorPublicKey === loggedInPubkeyHex &&
            senderPubkeyHex === loggedInPubkeyHex
          ) {
            return { viewedByAuthorAt: toIsoTimestampFromUnix(rumorEvent.created_at) };
          }

          return {};
        })(),
        ...(reactionEventId ? { eventId: reactionEventId } : {}),
      },
    };

    const targetMessage = await chatDataService.getMessageByEventId(targetEventId);
    if (!targetMessage) {
      logInboundEvent('reaction-pending', {
        reason: 'target-message-missing',
        ...buildInboundTraceDetails({
          rumorEvent,
          senderPubkeyHex,
          chatPubkey,
          targetEventId,
          relayUrls,
        }),
      });
      queuePendingIncomingReaction(targetEventId, pendingReaction);
      queueMissingMessageDependencyRepair(chatPubkey, targetEventId, {
        reason: 'reaction-target-missing',
        referenceCreatedAt: rumorEvent.created_at,
        seedRelayUrls: relayUrls,
      });
      return;
    }

    await upsertReactionOnMessageRow(targetMessage, pendingReaction, options);
    logInboundEvent('reaction-applied', {
      messageId: targetMessage.id,
      targetMessageEventId: formatSubscriptionLogValue(targetMessage.event_id),
      ...buildInboundTraceDetails({
        rumorEvent,
        senderPubkeyHex,
        chatPubkey,
        targetEventId,
        relayUrls,
      }),
    });
  }

  async function buildReplyPreviewFromTargetEvent(
    targetEventId: string,
    chatPubkey: string,
    loggedInPubkeyHex: string,
    contact?: ContactRecord | null,
    options: {
      referenceCreatedAt?: number | null;
      seedRelayUrls?: string[];
    } = {}
  ): Promise<MessageReplyPreview> {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      return buildUnknownReplyPreview(null);
    }

    const targetMessage = await chatDataService.getMessageByEventId(normalizedTargetEventId);
    if (!targetMessage) {
      queueMissingMessageDependencyRepair(chatPubkey, normalizedTargetEventId, {
        reason: 'reply-target-missing',
        referenceCreatedAt: options.referenceCreatedAt,
        seedRelayUrls: options.seedRelayUrls,
      });
      return buildUnknownReplyPreview(normalizedTargetEventId);
    }

    return buildReplyPreviewFromMessageRow(targetMessage, chatPubkey, loggedInPubkeyHex, contact);
  }

  async function refreshReplyPreviewsForTargetMessage(
    targetMessage: MessageRow,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<number> {
    const normalizedTargetEventId = normalizeEventId(targetMessage.event_id);
    const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(
      targetMessage.chat_public_key
    );
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!normalizedTargetEventId || !normalizedChatPubkey || !loggedInPubkeyHex) {
      return 0;
    }

    resolveMissingMessageDependencyRepair(normalizedTargetEventId);
    await Promise.all([chatDataService.init(), contactsService.init()]);
    const replyContact = await contactsService.getContactByPublicKey(normalizedChatPubkey);
    const nextReplyPreview = await buildReplyPreviewFromMessageRow(
      targetMessage,
      normalizedChatPubkey,
      loggedInPubkeyHex,
      replyContact
    );
    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);
    const chatMessages = await chatDataService.listMessages(normalizedChatPubkey);
    let updatedCount = 0;

    for (const messageRow of chatMessages) {
      const candidateReply = messageRow.meta.reply;
      if (!candidateReply || typeof candidateReply !== 'object' || Array.isArray(candidateReply)) {
        continue;
      }

      const currentReply = candidateReply as Record<string, unknown>;
      if (normalizeEventId(currentReply.eventId) !== normalizedTargetEventId) {
        continue;
      }

      const currentMessageId =
        typeof currentReply.messageId === 'string' ? currentReply.messageId.trim() : '';
      const currentText = typeof currentReply.text === 'string' ? currentReply.text.trim() : '';
      const currentImageUrl =
        typeof currentReply.imageUrl === 'string' ? currentReply.imageUrl.trim() : '';
      const currentSender = currentReply.sender === 'me' ? 'me' : 'them';
      const currentAuthorName =
        typeof currentReply.authorName === 'string' ? currentReply.authorName.trim() : '';
      const currentAuthorPublicKey =
        typeof currentReply.authorPublicKey === 'string' ? currentReply.authorPublicKey.trim() : '';
      const currentSentAt =
        typeof currentReply.sentAt === 'string' ? currentReply.sentAt.trim() : '';
      const isUnchanged =
        currentMessageId === nextReplyPreview.messageId &&
        currentText === nextReplyPreview.text &&
        currentImageUrl === (nextReplyPreview.imageUrl?.trim() ?? '') &&
        currentSender === nextReplyPreview.sender &&
        currentAuthorName === nextReplyPreview.authorName &&
        currentAuthorPublicKey === nextReplyPreview.authorPublicKey &&
        currentSentAt === nextReplyPreview.sentAt;
      if (isUnchanged) {
        continue;
      }

      const updatedRow = await chatDataService.updateMessageMeta(messageRow.id, {
        ...messageRow.meta,
        reply: nextReplyPreview,
      });
      if (!updatedRow) {
        continue;
      }

      updatedCount += 1;
      if (uiThrottleMs > 0) {
        continue;
      }

      await refreshMessageInLiveState(updatedRow.id);
    }

    if (updatedCount > 0 && uiThrottleMs > 0) {
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadMessages: true,
      });
    }

    return updatedCount;
  }

  async function processIncomingReactionDeletion(
    reactionEventId: string,
    deletionAuthorPublicKey: string,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<boolean> {
    await Promise.all([chatDataService.init(), nostrEventDataService.init()]);

    const normalizedReactionEventId = normalizeEventId(reactionEventId);
    const normalizedDeletionAuthorPublicKey =
      inputSanitizerService.normalizeHexKey(deletionAuthorPublicKey);
    if (!normalizedReactionEventId || !normalizedDeletionAuthorPublicKey) {
      return true;
    }

    const storedReactionEvent = await nostrEventDataService.getEventById(normalizedReactionEventId);
    if (storedReactionEvent) {
      const reactionAuthorPublicKey = inputSanitizerService.normalizeHexKey(
        storedReactionEvent.event.pubkey
      );
      if (
        reactionAuthorPublicKey &&
        reactionAuthorPublicKey !== normalizedDeletionAuthorPublicKey
      ) {
        return true;
      }
    }

    let targetMessage =
      await chatDataService.findMessageByReactionEventId(normalizedReactionEventId);
    const reactionEmoji = storedReactionEvent?.event.content.trim() || null;
    if (!targetMessage && storedReactionEvent) {
      const reactionEvent = new NDKEvent(ndk, storedReactionEvent.event);
      const targetMessageEventId = readReactionTargetEventId(reactionEvent);
      if (targetMessageEventId) {
        targetMessage = await chatDataService.getMessageByEventId(targetMessageEventId);
      }
    }

    if (!targetMessage) {
      if (storedReactionEvent) {
        const reactionEvent = new NDKEvent(ndk, storedReactionEvent.event);
        const targetMessageEventId = readReactionTargetEventId(reactionEvent);
        if (targetMessageEventId) {
          removePendingIncomingReaction(
            targetMessageEventId,
            normalizedReactionEventId,
            normalizedDeletionAuthorPublicKey
          );
        }

        await nostrEventDataService.deleteEventsByIds([normalizedReactionEventId]);
        return true;
      }

      return false;
    }

    const matchingReaction = normalizeMessageReactions(targetMessage.meta.reactions).find(
      (reaction) => {
        return normalizeEventId(reaction.eventId) === normalizedReactionEventId;
      }
    );
    if (
      matchingReaction &&
      matchingReaction.reactorPublicKey !== normalizedDeletionAuthorPublicKey
    ) {
      return true;
    }

    await removeReactionByEventIdFromMessageRow(
      targetMessage,
      normalizedReactionEventId,
      normalizedDeletionAuthorPublicKey,
      reactionEmoji,
      options
    );
    await nostrEventDataService.deleteEventsByIds([normalizedReactionEventId]);
    return true;
  }

  async function processIncomingMessageDeletion(
    messageEventId: string,
    deletionAuthorPublicKey: string,
    deleteEventId: string | null,
    deletedAt: string,
    targetKind: number,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<boolean> {
    await chatDataService.init();

    const targetMessage = await chatDataService.getMessageByEventId(messageEventId);
    if (!targetMessage) {
      return false;
    }

    const normalizedMessageAuthorPublicKey = inputSanitizerService.normalizeHexKey(
      targetMessage.author_public_key
    );
    const normalizedDeletionAuthorPublicKey =
      inputSanitizerService.normalizeHexKey(deletionAuthorPublicKey);
    if (
      !normalizedMessageAuthorPublicKey ||
      !normalizedDeletionAuthorPublicKey ||
      normalizedMessageAuthorPublicKey !== normalizedDeletionAuthorPublicKey
    ) {
      return true;
    }

    await markMessageRowDeleted(
      targetMessage,
      normalizedDeletionAuthorPublicKey,
      deletedAt,
      targetKind,
      deleteEventId,
      options
    );
    return true;
  }

  async function processIncomingDeletionRumorEvent(
    rumorEvent: NDKEvent,
    chatPubkey: string,
    senderPubkeyHex: string,
    options: {
      uiThrottleMs?: number;
      seedRelayUrls?: string[];
    } = {}
  ): Promise<void> {
    await Promise.all([chatDataService.init(), nostrEventDataService.init()]);

    const deleteEventId = normalizeEventId(rumorEvent.id);
    const deletedAt = toIsoTimestampFromUnix(rumorEvent.created_at);
    const deletionTargets = readDeletionTargetEntries(rumorEvent);
    if (deletionTargets.length === 0) {
      return;
    }

    for (const target of deletionTargets) {
      const targetKind = target.kind ?? null;
      let handled = false;

      if (targetKind === NDKKind.Reaction) {
        handled = await processIncomingReactionDeletion(target.eventId, senderPubkeyHex, options);
      } else if (targetKind === NDKKind.PrivateDirectMessage) {
        handled = await processIncomingMessageDeletion(
          target.eventId,
          senderPubkeyHex,
          deleteEventId,
          deletedAt,
          NDKKind.PrivateDirectMessage,
          options
        );
      } else {
        const matchingMessage = await chatDataService.getMessageByEventId(target.eventId);
        if (matchingMessage) {
          handled = await processIncomingMessageDeletion(
            target.eventId,
            senderPubkeyHex,
            deleteEventId,
            deletedAt,
            NDKKind.PrivateDirectMessage,
            options
          );
        } else {
          handled = await processIncomingReactionDeletion(target.eventId, senderPubkeyHex, options);
        }
      }

      if (!handled) {
        queuePendingIncomingDeletion(target.eventId, {
          deletionAuthorPublicKey: senderPubkeyHex,
          deleteEventId,
          deletedAt,
          targetKind,
        });
        queueMissingMessageDependencyRepair(chatPubkey, target.eventId, {
          reason: 'deletion-target-missing',
          referenceCreatedAt: rumorEvent.created_at,
          seedRelayUrls: options.seedRelayUrls,
        });
        continue;
      }

      resolveMissingMessageDependencyRepair(target.eventId);
    }
  }

  return {
    applyPendingIncomingDeletionsForMessage,
    applyPendingIncomingReactionsForMessage,
    buildReplyPreviewFromTargetEvent,
    refreshReplyPreviewsForTargetMessage,
    processIncomingDeletionRumorEvent,
    processIncomingReactionDeletion,
    processIncomingReactionRumorEvent,
  };
}
