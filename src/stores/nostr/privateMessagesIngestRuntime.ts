import { giftUnwrap, type NDKEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { type ChatRow, chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { CHAT_REQUEST_CLEARED_AT_META_KEY } from 'src/stores/nostr/constants';
import type {
  GroupEpochContext,
  PrivateMessagesIngestRuntimeDeps,
} from 'src/stores/nostr/privateMessagesIngestTypes';
import { isPlainRecord } from 'src/stores/nostr/shared';
import { resolveLatestReadBoundaryAtValue } from 'src/stores/nostr/valueUtils';
import type { NostrEventDirection } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';
import {
  buildImageAttachmentPreviewText,
  extractMediaAttachmentsFromTags,
} from 'src/utils/messageAttachments';
import {
  buildEditedMessageMeta,
  messageEditReferencesEventId,
  readMessageEditTargetEventId,
} from 'src/utils/messageEdits';
import { buildMentionMetadata, formatGroupMentionsForDisplay } from 'src/utils/nostrMentions';

export function createPrivateMessagesIngestRuntime({
  appendRelayStatusesToMessageEvent,
  applyPendingIncomingDeletionsForMessage,
  applyPendingIncomingReactionsForMessage,
  buildInboundRelayStatuses,
  buildInboundTraceDetails,
  buildLoggedNostrEvent,
  buildReplyPreviewFromTargetEvent,
  buildSubscriptionEventDetails,
  chatStore,
  deriveChatName,
  derivePublicKeyFromPrivateKey,
  extractRelayUrlsFromEvent,
  findConflictingKnownGroupEpochNumber,
  findGroupChatEpochContextByRecipientPubkey,
  findHigherKnownGroupEpochConflict,
  formatSubscriptionLogValue,
  getPrivateMessagesRestoreThrottleMs,
  isContactListedInPrivateContactList,
  isPubkeyBlocked,
  lastSeenReceivedActivityAtMetaKey,
  logConflictingIncomingEpochNumber,
  logDeveloperTrace,
  logInboundEvent,
  logInvalidIncomingEpochNumber,
  logSubscription,
  normalizeEventId,
  normalizeThrottleMs,
  normalizeTimestamp,
  persistIncomingGroupEpochTicket,
  processIncomingDeletionRumorEvent,
  processIncomingReactionRumorEvent,
  queueBackgroundGroupContactRefresh,
  queuePrivateMessagesUiRefresh,
  readReplyTargetEventId,
  refreshReplyPreviewsForTargetMessage,
  resolveCurrentGroupChatEpochEntry,
  resolveGroupDisplayName,
  resolveIncomingChatInboxStateValue,
  resolveIncomingPrivateMessageRecipientContext,
  shouldNotifyForAcceptedChatOnly,
  showIncomingMessageBrowserNotification,
  toComparableTimestamp,
  toIsoTimestampFromUnix,
  toStoredNostrEvent,
  unwrapGiftWrapSealEvent,
  upsertIncomingGroupInviteRequestChat,
  verifyIncomingGroupEpochTicket,
}: PrivateMessagesIngestRuntimeDeps) {
  type IngestPriority = 'background' | 'foreground';
  interface QueuedIngestTask {
    generation: number;
    run: () => Promise<boolean>;
    resolve: (shouldAcknowledge: boolean) => void;
  }

  const foregroundIngestTasks: QueuedIngestTask[] = [];
  const backgroundIngestTasks: QueuedIngestTask[] = [];
  let privateMessagesIngestQueue = Promise.resolve();
  let ingestQueueGeneration = 0;
  let activeIngestWorkerGeneration: number | null = null;

  function getPrivateMessagesIngestQueue(): Promise<void> {
    return privateMessagesIngestQueue;
  }

  function resetPrivateMessagesIngestRuntimeState(): void {
    ingestQueueGeneration += 1;
    const abandonedTasks = [...foregroundIngestTasks, ...backgroundIngestTasks];
    foregroundIngestTasks.length = 0;
    backgroundIngestTasks.length = 0;
    activeIngestWorkerGeneration = null;
    privateMessagesIngestQueue = Promise.resolve();
    for (const task of abandonedTasks) {
      task.resolve(false);
    }
  }

  function startPrivateMessagesIngestWorker(generation: number): void {
    if (activeIngestWorkerGeneration === generation) {
      return;
    }

    activeIngestWorkerGeneration = generation;
    void (async () => {
      try {
        while (ingestQueueGeneration === generation) {
          const task = foregroundIngestTasks.shift() ?? backgroundIngestTasks.shift();
          if (!task) {
            return;
          }
          if (task.generation !== generation) {
            task.resolve(false);
            continue;
          }

          task.resolve(await task.run());
        }
      } finally {
        if (activeIngestWorkerGeneration === generation) {
          activeIngestWorkerGeneration = null;
        }
        if (
          ingestQueueGeneration === generation &&
          (foregroundIngestTasks.length > 0 || backgroundIngestTasks.length > 0)
        ) {
          startPrivateMessagesIngestWorker(generation);
        }
      }
    })();
  }

  function isSameNostrSecond(firstTimestamp: string, secondTimestamp: string): boolean {
    const firstComparableTimestamp = toComparableTimestamp(firstTimestamp);
    const secondComparableTimestamp = toComparableTimestamp(secondTimestamp);

    return (
      firstComparableTimestamp > 0 &&
      secondComparableTimestamp > 0 &&
      Math.floor(firstComparableTimestamp / 1000) === Math.floor(secondComparableTimestamp / 1000)
    );
  }

  function shouldUseIncomingMessagePreview(createdAt: string, currentPreviewAt: string): boolean {
    return (
      toComparableTimestamp(createdAt) >= toComparableTimestamp(currentPreviewAt) ||
      isSameNostrSecond(createdAt, currentPreviewAt)
    );
  }

  function resolveIncomingPreviewTimestamp(createdAt: string, currentPreviewAt: string): string {
    return toComparableTimestamp(createdAt) >= toComparableTimestamp(currentPreviewAt)
      ? createdAt
      : currentPreviewAt;
  }

  function isIncomingActivityAfterSeenBoundary(
    createdAt: string,
    lastSeenActivityAt: string | null
  ): boolean {
    return toComparableTimestamp(createdAt) > toComparableTimestamp(lastSeenActivityAt);
  }

  function normalizeNotificationTitle(value: string | null | undefined): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function isFallbackNotificationTitle(
    value: string,
    chat: Pick<ChatRow, 'public_key' | 'type'>
  ): boolean {
    const normalizedValue = value.trim().toLowerCase();
    const normalizedPublicKey = chat.public_key.trim().toLowerCase();
    if (!normalizedValue || normalizedValue === normalizedPublicKey) {
      return true;
    }

    if (normalizedValue === normalizedPublicKey.slice(0, 16)) {
      return true;
    }

    if (normalizedValue === `chat ${normalizedPublicKey.slice(0, 8)}`) {
      return true;
    }

    return (
      chat.type === 'group' &&
      normalizedValue === resolveGroupDisplayName(chat.public_key).trim().toLowerCase()
    );
  }

  function resolveIncomingNotificationTitle(
    chat: Pick<ChatRow, 'name' | 'public_key' | 'type'>,
    contact: ContactRecord | null,
    fallbackPublicKey: string
  ): string {
    const candidateTitles = [
      chat.name,
      contact?.meta.display_name,
      contact?.meta.name,
      contact?.name,
      deriveChatName(contact, fallbackPublicKey),
    ];

    for (const candidate of candidateTitles) {
      const title = normalizeNotificationTitle(candidate);
      if (title && !isFallbackNotificationTitle(title, chat)) {
        return title;
      }
    }

    return chat.type === 'group' ? 'Group' : 'Chat';
  }

  function queuePrivateMessageIngestion(
    wrappedEvent: NDKEvent,
    loggedInPubkeyHex: string,
    options: {
      priority?: IngestPriority;
      uiThrottleMs?: number;
    } = {}
  ): Promise<boolean> {
    const uiThrottleMs =
      typeof options.uiThrottleMs === 'number'
        ? normalizeThrottleMs(options.uiThrottleMs)
        : getPrivateMessagesRestoreThrottleMs();

    const generation = ingestQueueGeneration;
    const ingestionResult = new Promise<boolean>((resolve) => {
      const task: QueuedIngestTask = {
        generation,
        resolve,
        run: async () => {
          try {
            const shouldAcknowledge = await processIncomingPrivateMessage(
              wrappedEvent,
              loggedInPubkeyHex,
              {
                uiThrottleMs,
              }
            );
            return shouldAcknowledge !== false;
          } catch (error) {
            console.error('Failed to process incoming private message', error);
            return false;
          }
        },
      };
      const queue =
        options.priority === 'foreground' ? foregroundIngestTasks : backgroundIngestTasks;
      queue.push(task);
      startPrivateMessagesIngestWorker(generation);
    });
    const previousQueue = privateMessagesIngestQueue;
    privateMessagesIngestQueue = Promise.all([previousQueue, ingestionResult]).then(
      () => undefined
    );
    return ingestionResult;
  }

  async function processIncomingPrivateMessage(
    wrappedEvent: NDKEvent,
    loggedInPubkeyHex: string,
    options: {
      uiThrottleMs?: number;
    } = {}
  ): Promise<boolean | undefined> {
    const wrappedRelayUrls = extractRelayUrlsFromEvent(wrappedEvent);
    if (wrappedEvent.kind !== NDKKind.GiftWrap) {
      logInboundEvent('drop', {
        reason: 'unsupported-wrapper-kind',
        ...buildInboundTraceDetails({
          wrappedEvent,
          loggedInPubkeyHex,
          relayUrls: wrappedRelayUrls,
        }),
      });
      return;
    }

    const recipientContext = await resolveIncomingPrivateMessageRecipientContext(
      wrappedEvent,
      loggedInPubkeyHex
    );
    if (!recipientContext) {
      logInboundEvent('drop', {
        reason: 'unknown-recipient-context',
        ...buildInboundTraceDetails({
          wrappedEvent,
          loggedInPubkeyHex,
          relayUrls: wrappedRelayUrls,
        }),
      });
      return false;
    }

    let rumorEvent: NDKEvent;
    try {
      rumorEvent = await giftUnwrap(wrappedEvent, undefined, recipientContext.unwrapSigner);
    } catch (error) {
      logDeveloperTrace('warn', 'inbound', 'unwrap-failed', {
        error,
        reason: 'unwrap-failed',
        ...buildInboundTraceDetails({
          wrappedEvent,
          loggedInPubkeyHex,
          relayUrls: wrappedRelayUrls,
        }),
      });
      return false;
    }

    const senderPubkeyHex = inputSanitizerService.normalizeHexKey(rumorEvent.pubkey ?? '');
    if (!senderPubkeyHex) {
      logInboundEvent('drop', {
        reason: 'invalid-sender-pubkey',
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          relayUrls: wrappedRelayUrls,
        }),
      });
      return;
    }

    const recipients = rumorEvent
      .getMatchingTags('p')
      .map((tag) => inputSanitizerService.normalizeHexKey(tag[1] ?? ''))
      .filter((value): value is string => Boolean(value));
    const isSelfSentMessage = senderPubkeyHex === loggedInPubkeyHex;
    if (!isSelfSentMessage && !recipients.includes(recipientContext.recipientPubkey)) {
      logInboundEvent('drop', {
        reason: 'recipient-mismatch',
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    let resolvedGroupEpochContext: GroupEpochContext | null = recipientContext.groupChatPublicKey
      ? await findGroupChatEpochContextByRecipientPubkey(recipientContext.recipientPubkey)
      : null;
    let resolvedGroupChatPublicKey =
      resolvedGroupEpochContext?.chat.public_key ?? recipientContext.groupChatPublicKey;
    if (!resolvedGroupChatPublicKey) {
      for (const recipientPubkey of recipients) {
        const matchingGroupChatContext =
          await findGroupChatEpochContextByRecipientPubkey(recipientPubkey);
        if (matchingGroupChatContext) {
          resolvedGroupEpochContext = matchingGroupChatContext;
          resolvedGroupChatPublicKey = matchingGroupChatContext.chat.public_key;
          break;
        }
      }
    }

    const chatPubkey = resolvedGroupChatPublicKey
      ? resolvedGroupChatPublicKey
      : isSelfSentMessage
        ? (recipients.find((pubkey) => pubkey !== loggedInPubkeyHex) ??
          (recipients.includes(loggedInPubkeyHex) ? loggedInPubkeyHex : null))
        : senderPubkeyHex;
    if (!chatPubkey) {
      logInboundEvent('drop', {
        reason: 'missing-chat-pubkey',
        isSelfSentMessage,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    if (!isSelfSentMessage && (isPubkeyBlocked(senderPubkeyHex) || isPubkeyBlocked(chatPubkey))) {
      logInboundEvent('drop', {
        reason: 'blocked-pubkey',
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    let preflightContact: ContactRecord | null | undefined;
    let preflightChat: ChatRow | null | undefined;
    if (!isSelfSentMessage) {
      await Promise.all([chatDataService.init(), contactsService.init()]);
      const [blockedContact, blockedSenderContact, blockedChat] = await Promise.all([
        contactsService.getContactByPublicKey(chatPubkey),
        senderPubkeyHex === chatPubkey
          ? Promise.resolve(null)
          : contactsService.getContactByPublicKey(senderPubkeyHex),
        chatDataService.getChatByPublicKey(chatPubkey),
      ]);
      preflightContact = blockedContact;
      preflightChat = blockedChat;
      if (
        blockedContact?.meta.blocked === true ||
        blockedSenderContact?.meta.blocked === true ||
        (isPlainRecord(blockedChat?.meta) && blockedChat.meta.inbox_state === 'blocked')
      ) {
        logInboundEvent('drop', {
          reason: 'blocked-pubkey',
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }
    }

    const uiThrottleMs = normalizeThrottleMs(options.uiThrottleMs);

    const rumorNostrEvent = await toStoredNostrEvent(rumorEvent);
    const loggedRumorEvent = buildLoggedNostrEvent(rumorEvent, rumorNostrEvent);
    const receivedRelayStatuses = buildInboundRelayStatuses(wrappedRelayUrls);
    const direction: NostrEventDirection = isSelfSentMessage ? 'out' : 'in';
    const replyTargetEventId = readReplyTargetEventId(rumorEvent);

    logSubscription('private-messages', 'rumor', {
      wrappedEventId: formatSubscriptionLogValue(wrappedEvent.id),
      chatPubkey: formatSubscriptionLogValue(chatPubkey),
      direction,
      recipientCount: recipients.length,
      ...buildSubscriptionEventDetails(rumorEvent),
    });

    if (rumorEvent.kind === NDKKind.EventDeletion) {
      logInboundEvent('route', {
        route: 'deletion',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      await processIncomingDeletionRumorEvent(rumorEvent, chatPubkey, senderPubkeyHex, {
        uiThrottleMs,
        seedRelayUrls: wrappedRelayUrls,
      });
      return;
    }

    if (rumorEvent.kind === NDKKind.Reaction) {
      logInboundEvent('route', {
        route: 'reaction',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      await processIncomingReactionRumorEvent(rumorEvent, chatPubkey, senderPubkeyHex, {
        uiThrottleMs,
        direction,
        rumorNostrEvent,
        relayStatuses: receivedRelayStatuses,
      });
      return;
    }

    if (rumorEvent.kind === 1014) {
      const loggedEvent = rumorNostrEvent ?? (await toStoredNostrEvent(rumorEvent)) ?? rumorEvent;
      const loggedSealEvent = await unwrapGiftWrapSealEvent(wrappedEvent);

      const verificationResult = await verifyIncomingGroupEpochTicket(rumorEvent, loggedSealEvent);
      if (!verificationResult.isValid) {
        return;
      }
      const epochNumber = verificationResult.epochNumber ?? 0;
      const epochPublicKey = derivePublicKeyFromPrivateKey(
        verificationResult.epochPrivateKey ?? ''
      );

      await contactsService.init();
      await chatDataService.init();
      const senderContact = await contactsService.getContactByPublicKey(senderPubkeyHex);
      const existingGroupChat = await chatDataService.getChatByPublicKey(senderPubkeyHex);
      const incomingEpochCreatedAt = toIsoTimestampFromUnix(rumorEvent.created_at);
      const conflictingEpochNumber = findConflictingKnownGroupEpochNumber(
        existingGroupChat,
        epochNumber,
        epochPublicKey ?? ''
      );
      if (conflictingEpochNumber) {
        logConflictingIncomingEpochNumber(
          senderPubkeyHex,
          epochNumber,
          epochPublicKey ?? '',
          incomingEpochCreatedAt,
          conflictingEpochNumber
        );
        logInboundEvent('drop', {
          reason: 'conflicting-epoch-public-key',
          epochNumber,
          epochPublicKey: formatSubscriptionLogValue(epochPublicKey),
          conflictingEpochPublicKey: formatSubscriptionLogValue(
            conflictingEpochNumber.epoch_public_key
          ),
          conflictingEpochCreatedAt: conflictingEpochNumber.invitation_created_at ?? null,
          createdAt: incomingEpochCreatedAt,
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey: senderPubkeyHex,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }
      const wasAcceptedGroup =
        resolveIncomingChatInboxStateValue({
          chat: existingGroupChat,
          isAcceptedContact: isContactListedInPrivateContactList(senderContact),
        }) === 'accepted';
      const existingGroupChatContactName =
        typeof existingGroupChat?.meta?.contact_name === 'string'
          ? existingGroupChat.meta.contact_name.trim()
          : '';
      const fallbackGroupName =
        senderContact?.meta?.display_name?.trim() ||
        senderContact?.meta?.name?.trim() ||
        senderContact?.name?.trim() ||
        existingGroupChatContactName ||
        existingGroupChat?.name?.trim() ||
        resolveGroupDisplayName(senderPubkeyHex);

      logInboundEvent('epoch-ticket-received', {
        direction,
        epochNumber,
        epochPublicKey: formatSubscriptionLogValue(epochPublicKey),
        acceptedGroup: wasAcceptedGroup,
        groupName: fallbackGroupName,
        deliveryRecipientPubkey: formatSubscriptionLogValue(recipientContext.recipientPubkey),
        signedEventId: formatSubscriptionLogValue(
          verificationResult.signedEvent?.id ?? loggedEvent.id ?? null
        ),
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey: senderPubkeyHex,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });

      await persistIncomingGroupEpochTicket(
        senderPubkeyHex,
        epochNumber,
        verificationResult.epochPrivateKey ?? '',
        {
          fallbackName: fallbackGroupName,
          accepted: wasAcceptedGroup,
          invitationCreatedAt: incomingEpochCreatedAt,
          seedRelayUrls: wrappedRelayUrls,
        }
      );
      queueBackgroundGroupContactRefresh(senderPubkeyHex, fallbackGroupName, wrappedRelayUrls);

      if (!wasAcceptedGroup) {
        await upsertIncomingGroupInviteRequestChat(
          senderPubkeyHex,
          toIsoTimestampFromUnix(rumorEvent.created_at),
          senderContact
            ? {
                name: senderContact.name,
                meta: senderContact.meta,
              }
            : {
                name: fallbackGroupName,
                meta: {},
              }
        );
      }

      const epochNoticeMessage = await chatDataService.createMessage({
        chat_public_key: senderPubkeyHex,
        author_public_key: senderPubkeyHex,
        message: `Epoch ${epochNumber}`,
        created_at: incomingEpochCreatedAt,
        event_id: verificationResult.signedEvent?.id ?? loggedEvent.id ?? null,
        meta: {
          source: 'nostr',
          kind: 1014,
          group_epoch_notice: {
            epochNumber,
          },
        },
      });
      if (!epochNoticeMessage) {
        return;
      }

      if (uiThrottleMs > 0) {
        queuePrivateMessagesUiRefresh({
          throttleMs: uiThrottleMs,
          reloadMessages: true,
        });
        return;
      }

      try {
        const { useMessageStore } = await import('src/stores/messageStore');
        await useMessageStore().upsertPersistedMessage(epochNoticeMessage);
      } catch (error) {
        console.error('Failed to sync incoming epoch notice into live state', error);
      }
      return;
    }

    if (rumorEvent.kind !== NDKKind.PrivateDirectMessage) {
      logInboundEvent('drop', {
        reason: 'unsupported-rumor-kind',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    const messageText = rumorEvent.content.trim();
    if (!messageText) {
      logInboundEvent('drop', {
        reason: 'empty-content',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    await Promise.all([
      chatDataService.init(),
      contactsService.init(),
      nostrEventDataService.init(),
    ]);

    const rumorEventId = normalizeEventId(rumorNostrEvent?.id ?? rumorEvent.id);
    if (rumorEventId) {
      const existingMessage = await chatDataService.getMessageByEventId(rumorEventId);
      if (existingMessage) {
        await appendRelayStatusesToMessageEvent(existingMessage.id, receivedRelayStatuses, {
          event: rumorNostrEvent ?? undefined,
          direction,
          eventId: rumorEventId,
          uiThrottleMs,
        });
        const refreshedExistingMessage =
          (await chatDataService.getMessageById(existingMessage.id)) ?? existingMessage;
        let updatedExistingMessage = await applyPendingIncomingReactionsForMessage(
          refreshedExistingMessage,
          {
            uiThrottleMs,
          }
        );
        updatedExistingMessage = await applyPendingIncomingDeletionsForMessage(
          updatedExistingMessage,
          {
            uiThrottleMs,
          }
        );
        await refreshReplyPreviewsForTargetMessage(updatedExistingMessage, {
          uiThrottleMs,
        });
        logInboundEvent('message-persisted', {
          persistence: 'duplicate-existing-message',
          direction,
          messageId: updatedExistingMessage.id,
          uiThrottleMs,
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }

      const existingEditedMessage =
        await chatDataService.getMessageByEventIdOrEditReference(rumorEventId);
      if (
        existingEditedMessage &&
        messageEditReferencesEventId(existingEditedMessage.meta, rumorEventId)
      ) {
        let refreshedEditedMessage = await applyPendingIncomingReactionsForMessage(
          existingEditedMessage,
          { uiThrottleMs }
        );
        refreshedEditedMessage = await applyPendingIncomingDeletionsForMessage(
          refreshedEditedMessage,
          { uiThrottleMs }
        );
        if (rumorNostrEvent) {
          await nostrEventDataService.upsertEvent({
            event: rumorNostrEvent,
            direction,
            relay_statuses: receivedRelayStatuses,
          });
        }
        await refreshReplyPreviewsForTargetMessage(refreshedEditedMessage, {
          uiThrottleMs,
        });
        logInboundEvent('message-persisted', {
          persistence: 'ignored-edit-predecessor',
          direction,
          messageId: refreshedEditedMessage.id,
          uiThrottleMs,
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }
    }

    const createdAt = toIsoTimestampFromUnix(rumorEvent.created_at);
    const contact =
      preflightContact !== undefined
        ? preflightContact
        : await contactsService.getContactByPublicKey(chatPubkey);
    const isAcceptedContact = isContactListedInPrivateContactList(contact);
    const existingChat =
      preflightChat !== undefined
        ? preflightChat
        : await chatDataService.getChatByPublicKey(chatPubkey);
    if (resolvedGroupChatPublicKey && resolvedGroupEpochContext?.epochEntry) {
      const incomingEpochNumber = Number(resolvedGroupEpochContext.epochEntry.epoch_number);
      const higherEpochConflict = Number.isInteger(incomingEpochNumber)
        ? findHigherKnownGroupEpochConflict(
            existingChat ?? resolvedGroupEpochContext.chat,
            incomingEpochNumber,
            createdAt
          )
        : null;
      if (higherEpochConflict?.olderHigherEpochEntry) {
        logInvalidIncomingEpochNumber(
          resolvedGroupChatPublicKey,
          incomingEpochNumber,
          resolvedGroupEpochContext.epochEntry.epoch_public_key,
          createdAt,
          higherEpochConflict
        );
        logInboundEvent('drop', {
          reason: 'invalid-epoch-number',
          epochNumber: incomingEpochNumber,
          epochPublicKey: formatSubscriptionLogValue(
            resolvedGroupEpochContext.epochEntry.epoch_public_key
          ),
          higherEpochNumber: higherEpochConflict.higherEpochEntry.epoch_number,
          higherEpochPublicKey: formatSubscriptionLogValue(
            higherEpochConflict.higherEpochEntry.epoch_public_key
          ),
          higherEpochCreatedAt:
            higherEpochConflict.olderHigherEpochEntry.invitation_created_at ??
            higherEpochConflict.higherEpochEntry.invitation_created_at ??
            null,
          createdAt,
          direction,
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey: resolvedGroupChatPublicKey,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }
    }

    const incomingChatInboxState = resolveIncomingChatInboxStateValue({
      chat: existingChat,
      isAcceptedContact,
    });
    if (
      !isSelfSentMessage &&
      (incomingChatInboxState === 'blocked' || contact?.meta.blocked === true)
    ) {
      logInboundEvent('drop', {
        reason: 'blocked-pubkey',
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    const existingRequestClearedAt = normalizeTimestamp(
      isPlainRecord(existingChat?.meta) ? existingChat.meta[CHAT_REQUEST_CLEARED_AT_META_KEY] : null
    );
    if (
      incomingChatInboxState === 'request' &&
      existingRequestClearedAt &&
      toComparableTimestamp(createdAt) <= toComparableTimestamp(existingRequestClearedAt)
    ) {
      logInboundEvent('drop', {
        reason: 'cleared-request-message',
        requestClearedAt: existingRequestClearedAt,
        createdAt,
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }
    const createdChat = existingChat
      ? null
      : await chatDataService.createChat({
          public_key: chatPubkey,
          ...(recipientContext.groupChatPublicKey ? { type: 'group' as const } : {}),
          name: deriveChatName(contact, chatPubkey),
          last_message: '',
          last_message_at: createdAt,
          unread_count: 0,
          meta: {
            ...(contact?.meta.picture ? { picture: contact.meta.picture } : {}),
            ...(Array.isArray(contact?.meta.group_members)
              ? { group_members: contact.meta.group_members }
              : {}),
            ...(contact?.meta.muted === true ? { muted: true } : {}),
            ...(incomingChatInboxState === 'accepted'
              ? {
                  inbox_state: 'accepted',
                  accepted_at: createdAt,
                }
              : {}),
          },
        });
    let chat =
      existingChat ?? createdChat ?? (await chatDataService.getChatByPublicKey(chatPubkey));
    if (!chat) {
      logInboundEvent('drop', {
        reason: 'chat-create-failed',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    if (incomingChatInboxState === 'accepted') {
      const currentInboxState =
        chat.meta && typeof chat.meta.inbox_state === 'string' ? chat.meta.inbox_state.trim() : '';
      const currentAcceptedAt =
        chat.meta && typeof chat.meta.accepted_at === 'string' ? chat.meta.accepted_at.trim() : '';
      if (currentInboxState !== 'accepted' || !currentAcceptedAt) {
        await chatStore.acceptChat(chat.public_key, {
          acceptedAt: currentAcceptedAt || createdAt,
        });
        chat = (await chatDataService.getChatByPublicKey(chat.public_key)) ?? chat;
      }
    }

    const isBlockedChat = incomingChatInboxState === 'blocked';
    const contactLastSeenIncomingActivityAt = normalizeTimestamp(
      isPlainRecord(contact?.meta) ? contact.meta.last_seen_incoming_activity_at : null
    );
    const chatLastSeenReceivedActivityAt = normalizeTimestamp(
      isPlainRecord(chat.meta) ? chat.meta[lastSeenReceivedActivityAtMetaKey] : null
    );
    const chatLastOutgoingMessageAt = normalizeTimestamp(
      isPlainRecord(chat.meta) ? chat.meta.last_outgoing_message_at : null
    );
    const effectiveLastSeenIncomingActivityAt = resolveLatestReadBoundaryAtValue(
      contactLastSeenIncomingActivityAt,
      chatLastSeenReceivedActivityAt,
      chatLastOutgoingMessageAt
    );
    const replyPreview = replyTargetEventId
      ? await buildReplyPreviewFromTargetEvent(
          replyTargetEventId,
          chatPubkey,
          loggedInPubkeyHex,
          contact,
          {
            referenceCreatedAt: rumorEvent.created_at,
            seedRelayUrls: wrappedRelayUrls,
          }
        )
      : null;
    const attachments = extractMediaAttachmentsFromTags(rumorEvent.tags);
    const editTargetEventId = readMessageEditTargetEventId(rumorEvent.tags);
    let messageMeta: Record<string, unknown> = {
      source: 'nostr',
      kind: NDKKind.PrivateDirectMessage,
      wrapper_event_id: wrappedEvent.id ?? '',
      ...buildMentionMetadata(messageText, loggedInPubkeyHex),
      ...(replyPreview ? { reply: replyPreview } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const editedAt = new Date().toISOString();
    let editTargetMessage = editTargetEventId
      ? await chatDataService.getMessageByEventId(editTargetEventId)
      : null;
    if (
      editTargetMessage &&
      (editTargetMessage.chat_public_key !== chat.public_key ||
        editTargetMessage.author_public_key.trim().toLowerCase() !== senderPubkeyHex ||
        !isSameNostrSecond(editTargetMessage.created_at, createdAt))
    ) {
      editTargetMessage = null;
    }

    if (!editTargetMessage) {
      const chatMessages = await chatDataService.listMessages(chat.public_key);
      editTargetMessage =
        chatMessages.find((candidate) => {
          return (
            candidate.author_public_key.trim().toLowerCase() === senderPubkeyHex &&
            Boolean(candidate.event_id) &&
            Boolean(candidate.meta.deleted) &&
            isSameNostrSecond(candidate.created_at, createdAt)
          );
        }) ?? null;
    }

    if (editTargetMessage?.event_id && rumorEventId) {
      const editedMessage = await chatDataService.applyMessageEdit(editTargetMessage.id, {
        message: messageText,
        created_at: createdAt,
        event_id: rumorEventId,
        previous_event_id: editTargetMessage.event_id,
        edited_at: editedAt,
        meta: messageMeta,
      });
      if (editedMessage) {
        await appendRelayStatusesToMessageEvent(editedMessage.id, receivedRelayStatuses, {
          event: rumorNostrEvent ?? undefined,
          direction,
          eventId: rumorEventId,
          uiThrottleMs,
        });
        let nextEditedMessage = await applyPendingIncomingReactionsForMessage(editedMessage, {
          uiThrottleMs,
        });
        nextEditedMessage = await applyPendingIncomingDeletionsForMessage(nextEditedMessage, {
          uiThrottleMs,
        });
        await refreshReplyPreviewsForTargetMessage(nextEditedMessage, { uiThrottleMs });
        if (rumorNostrEvent) {
          await nostrEventDataService.upsertEvent({
            event: rumorNostrEvent,
            direction,
            relay_statuses: receivedRelayStatuses,
          });
        }

        if (isSameNostrSecond(chat.last_message_at ?? '', editTargetMessage.created_at)) {
          const attachmentPreviewText = buildImageAttachmentPreviewText(messageText, messageMeta);
          const messagePreviewText = resolvedGroupChatPublicKey
            ? formatGroupMentionsForDisplay(attachmentPreviewText, contact?.meta ?? null)
            : attachmentPreviewText;
          await chatDataService.updateChatPreview(
            chat.public_key,
            messagePreviewText,
            chat.last_message_at,
            chat.unread_count
          );
        }
        if (uiThrottleMs > 0) {
          queuePrivateMessagesUiRefresh({
            throttleMs: uiThrottleMs,
            reloadChats: true,
            reloadMessages: true,
          });
        }
        logInboundEvent('message-persisted', {
          persistence: 'applied-edit',
          direction,
          messageId: nextEditedMessage.id,
          previousEventId: formatSubscriptionLogValue(editTargetMessage.event_id),
          uiThrottleMs,
          ...buildInboundTraceDetails({
            wrappedEvent,
            rumorEvent,
            loggedInPubkeyHex,
            senderPubkeyHex,
            chatPubkey,
            relayUrls: wrappedRelayUrls,
            recipients,
          }),
        });
        return;
      }
    }

    if (editTargetEventId) {
      messageMeta = buildEditedMessageMeta({}, messageMeta, editTargetEventId, editedAt);
    }
    const createdMessage = await chatDataService.createMessage({
      chat_public_key: chat.public_key,
      author_public_key: senderPubkeyHex,
      message: messageText,
      created_at: createdAt,
      event_id: rumorEventId,
      meta: messageMeta,
    });
    if (!createdMessage) {
      logInboundEvent('drop', {
        reason: 'message-create-failed',
        direction,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
      return;
    }

    await chatStore.recordIncomingActivity(chat.public_key, createdAt);
    let nextMessageRow = await applyPendingIncomingReactionsForMessage(createdMessage, {
      uiThrottleMs,
    });
    nextMessageRow = await applyPendingIncomingDeletionsForMessage(nextMessageRow, {
      uiThrottleMs,
    });
    await refreshReplyPreviewsForTargetMessage(nextMessageRow, {
      uiThrottleMs,
    });

    if (rumorNostrEvent) {
      await nostrEventDataService.upsertEvent({
        event: rumorNostrEvent,
        direction,
        relay_statuses: receivedRelayStatuses,
      });
    }

    const currentUnreadCount = Math.max(0, Number(chat.unread_count ?? 0));
    const attachmentPreviewText = buildImageAttachmentPreviewText(messageText, messageMeta);
    const messagePreviewText = resolvedGroupChatPublicKey
      ? formatGroupMentionsForDisplay(attachmentPreviewText, contact?.meta ?? null)
      : attachmentPreviewText;
    const isAfterSeenBoundary = isIncomingActivityAfterSeenBoundary(
      createdAt,
      effectiveLastSeenIncomingActivityAt
    );
    const shouldIncrementUnreadCount =
      !isSelfSentMessage &&
      !isBlockedChat &&
      chatStore.visibleChatId !== chat.public_key &&
      isAfterSeenBoundary;
    const nextUnreadCount = isSelfSentMessage
      ? currentUnreadCount
      : isBlockedChat || chatStore.visibleChatId === chat.public_key
        ? 0
        : shouldIncrementUnreadCount
          ? currentUnreadCount + 1
          : currentUnreadCount;
    const shouldUpdateChatPreview = shouldUseIncomingMessagePreview(
      createdAt,
      chat.last_message_at
    );
    const nextPreviewAt = shouldUpdateChatPreview
      ? resolveIncomingPreviewTimestamp(createdAt, chat.last_message_at)
      : chat.last_message_at;
    const currentGroupEpochEntry = resolvedGroupChatPublicKey
      ? resolveCurrentGroupChatEpochEntry(chat)
      : null;
    const hasValidInvitation = Boolean(resolvedGroupEpochContext?.epochEntry);
    const invitationCreatedAt =
      resolvedGroupEpochContext?.epochEntry?.invitation_created_at ?? null;
    const isCurrentEpochRecipient =
      Boolean(currentGroupEpochEntry?.epoch_public_key) &&
      currentGroupEpochEntry?.epoch_public_key ===
        resolvedGroupEpochContext?.epochEntry?.epoch_public_key;

    if (shouldUpdateChatPreview) {
      await chatDataService.updateChatPreview(
        chat.public_key,
        messagePreviewText,
        nextPreviewAt,
        nextUnreadCount
      );
    } else if (nextUnreadCount !== currentUnreadCount) {
      await chatDataService.updateChatUnreadCount(chat.public_key, nextUnreadCount);
    }

    logInboundEvent('private-message-received', {
      direction,
      messageId: createdMessage.id,
      messageLength: messageText.length,
      isGroupMessage: Boolean(resolvedGroupChatPublicKey),
      rumor: loggedRumorEvent,
      ...(resolvedGroupChatPublicKey
        ? {
            groupChatPubkey: formatSubscriptionLogValue(resolvedGroupChatPublicKey),
            epochRecipientPubkey: formatSubscriptionLogValue(recipientContext.recipientPubkey),
            hasValidInvitation,
            invitationCreatedAt,
            isCurrentEpochRecipient,
          }
        : {}),
      ...buildInboundTraceDetails({
        wrappedEvent,
        rumorEvent,
        loggedInPubkeyHex,
        senderPubkeyHex,
        chatPubkey,
        relayUrls: wrappedRelayUrls,
        recipients,
      }),
    });

    logInboundEvent('message-persisted', {
      persistence: 'created',
      direction,
      messageId: nextMessageRow.id,
      chatId: chat.id,
      effectiveLastSeenIncomingActivityAt,
      unreadCount: nextUnreadCount,
      updatedPreview: shouldUpdateChatPreview,
      uiThrottleMs,
      ...buildInboundTraceDetails({
        wrappedEvent,
        rumorEvent,
        loggedInPubkeyHex,
        senderPubkeyHex,
        chatPubkey,
        relayUrls: wrappedRelayUrls,
        recipients,
      }),
    });

    if (resolvedGroupChatPublicKey) {
      logInboundEvent('group-message-received', {
        direction,
        messageId: nextMessageRow.id,
        messageLength: messageText.length,
        groupChatPubkey: formatSubscriptionLogValue(resolvedGroupChatPublicKey),
        epochRecipientPubkey: formatSubscriptionLogValue(recipientContext.recipientPubkey),
        authorPubkey: formatSubscriptionLogValue(senderPubkeyHex),
        hasValidInvitation,
        invitationCreatedAt,
        isCurrentEpochRecipient,
        rumor: loggedRumorEvent,
        ...buildInboundTraceDetails({
          wrappedEvent,
          rumorEvent,
          loggedInPubkeyHex,
          senderPubkeyHex,
          chatPubkey: resolvedGroupChatPublicKey,
          relayUrls: wrappedRelayUrls,
          recipients,
        }),
      });
    }

    if (
      !isSelfSentMessage &&
      !isBlockedChat &&
      isAfterSeenBoundary &&
      (await shouldNotifyForAcceptedChatOnly(chat.public_key, chat.meta ?? {}))
    ) {
      showIncomingMessageBrowserNotification({
        chatPubkey: chat.public_key,
        title: resolveIncomingNotificationTitle(chat, contact, chatPubkey),
        messageText: messagePreviewText,
        iconUrl: contact?.meta.picture?.trim() || undefined,
      });
    }

    if (uiThrottleMs > 0) {
      queuePrivateMessagesUiRefresh({
        throttleMs: uiThrottleMs,
        reloadChats: true,
        reloadMessages: true,
      });
      return;
    }

    try {
      if (shouldUpdateChatPreview) {
        chatStore.applyIncomingMessage({
          publicKey: chat.public_key,
          authorPublicKey: senderPubkeyHex,
          fallbackName: deriveChatName(contact, chatPubkey),
          messageText: messagePreviewText,
          at: nextPreviewAt,
          unreadCount: nextUnreadCount,
          messageMeta,
          meta: {
            ...(chat.meta ?? {}),
            ...(contact?.meta.picture ? { picture: contact.meta.picture } : {}),
            ...(Array.isArray(contact?.meta.group_members)
              ? { group_members: contact.meta.group_members }
              : {}),
          },
        });
      } else if (nextUnreadCount !== currentUnreadCount) {
        await chatStore.setUnreadCount(chat.public_key, nextUnreadCount);
      }

      const { useMessageStore } = await import('src/stores/messageStore');
      await useMessageStore().upsertPersistedMessage(nextMessageRow);
    } catch (error) {
      console.error('Failed to sync incoming private message into live state', error);
    }
  }

  return {
    getPrivateMessagesIngestQueue,
    queuePrivateMessageIngestion,
    resetPrivateMessagesIngestRuntimeState,
  };
}
