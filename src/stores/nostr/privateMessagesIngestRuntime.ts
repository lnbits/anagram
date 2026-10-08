import { disposeCryptoWorker } from '#src/lib/nostr/cryptoWorker.ts';
import { messageInbox, type InboxRecord } from '#src/lib/nostr/inbox.ts';
import { yieldToMainThread } from '#src/utils/backgroundTasks.ts';
import { giftUnwrap, ClientEvent, NostrKind } from '#src/lib/nostr/client.ts';
import { type ChatRow, chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import { CHAT_REQUEST_CLEARED_AT_META_KEY } from '#src/stores/nostr/constants.ts';
import type {
  GroupEpochContext,
  PrivateMessagesIngestRuntimeDeps,
} from '#src/stores/nostr/privateMessagesIngestTypes.ts';
import { isPlainRecord } from '#src/stores/nostr/shared.ts';
import { resolveLatestReadBoundaryAtValue } from '#src/stores/nostr/valueUtils.ts';
import { CALL_SIGNAL_KIND } from '#src/types/call.ts';
import type { NostrEventDirection } from '#src/types/chat.ts';
import type { ContactRecord } from '#src/types/contact.ts';
import { callHistoryFromTags } from '#src/utils/callHistory.ts';
import { parseRoomSignal } from '#src/utils/callRoom.ts';
import { parseCallSignal } from '#src/utils/callSignal.ts';
import {
  buildImageAttachmentPreviewText,
  extractMediaAttachmentsFromTags,
  FILE_MESSAGE_KIND,
  isChatMessageRumorKind,
  parseNip17FileMessageAttachment,
} from '#src/utils/messageAttachments.ts';
import {
  buildEditedMessageMeta,
  messageEditReferencesEventId,
  readMessageEditTargetEventId,
} from '#src/utils/messageEdits.ts';
import { buildMentionMetadata, formatGroupMentionsForDisplay } from '#src/utils/nostrMentions.ts';

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
  processIncomingCallSignal,
  processIncomingRoomSignal,
  processIncomingDeletionRumorEvent,
  processIncomingReactionRumorEvent,
  queueBackgroundGroupContactRefresh,
  queueChatProfileRefresh,
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
  let resolveDrained: (() => void) | null = null;
  let ingestQueueGeneration = 0;
  let activeIngestWorkerGeneration: number | null = null;

  let profileRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function queueNewChatProfile() {
    if (!queueChatProfileRefresh || profileRefreshTimer) return;
    profileRefreshTimer = setTimeout(() => {
      profileRefreshTimer = undefined;
      queueChatProfileRefresh();
    }, 100);
  }
  function getPrivateMessagesIngestQueue(): Promise<void> {
    return privateMessagesIngestQueue;
  }

  function resetPrivateMessagesIngestRuntimeState(): void {
    clearTimeout(profileRefreshTimer);
    profileRefreshTimer = undefined;
    disposeCryptoWorker();
    ingestQueueGeneration += 1;
    spoolRunning = false;
    wakeSpool?.();
    commitTail = Promise.resolve();
    stagedChats.clear();
    stagedEvents.clear();
    hotInbox.clear();
    for (const waiting of spoolWaiters.values()) waiting.forEach((resolve) => resolve(false));
    spoolWaiters.clear();
    const abandonedTasks = [...foregroundIngestTasks, ...backgroundIngestTasks];
    foregroundIngestTasks.length = 0;
    backgroundIngestTasks.length = 0;
    activeIngestWorkerGeneration = null;
    resolveDrained?.();
    resolveDrained = null;
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
        let sliceStarted = performance.now();
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
          if (performance.now() - sliceStarted >= 8) {
            await yieldToMainThread();
            sliceStarted = performance.now();
          }
        }
      } finally {
        if (activeIngestWorkerGeneration === generation) {
          activeIngestWorkerGeneration = null;
          resolveDrained?.();
          resolveDrained = null;
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
    lastSeenActivityAt: string | null,
  ): boolean {
    return toComparableTimestamp(createdAt) > toComparableTimestamp(lastSeenActivityAt);
  }

  function normalizeNotificationTitle(value: string | null | undefined): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function isFallbackNotificationTitle(
    value: string,
    chat: Pick<ChatRow, 'public_key' | 'type'>,
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
    fallbackPublicKey: string,
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

  const inbox = messageInbox;
  let spoolRunning = false;
  let spoolWrites = 0;
  let foregroundArrivalVersion = 0;
  let wakeSpool: (() => void) | undefined;
  // Decrypt/stage one event at a time, with at most eight uncommitted messages.
  // Commits remain ordered so edits, deletes, counters and relay coverage agree.
  let commitTail: Promise<void> = Promise.resolve();
  const stagedChats = new Map<string, ChatRow>();
  const stagedEvents = new Set<string>();
  // Only the next small page stays in memory. Overflow drains from the journal.
  const hotInbox = new Map<string, { record: InboxRecord; durable: Promise<boolean> }>();
  const spoolWaiters = new Map<string, Array<(value: boolean) => void>>();
  async function queuePrivateMessageIngestion(
    wrappedEvent: ClientEvent,
    loggedInPubkeyHex: string,
    options: { priority?: IngestPriority; uiThrottleMs?: number; reprocess?: boolean } = {},
  ): Promise<boolean> {
    const uiThrottleMs =
      typeof options.uiThrottleMs === 'number'
        ? normalizeThrottleMs(options.uiThrottleMs)
        : getPrivateMessagesRestoreThrottleMs();
    // Runtime mocks do not have a raw event. Keep the injected test seam usable.
    if (typeof indexedDB === 'undefined' || typeof wrappedEvent.rawEvent !== 'function') {
      if (!resolveDrained)
        privateMessagesIngestQueue = new Promise<void>((resolve) => {
          resolveDrained = resolve;
        });
      const generation = ingestQueueGeneration;
      return new Promise<boolean>((resolve) => {
        const task = {
          generation,
          resolve,
          run: async () => {
            try {
              return (
                (await processIncomingPrivateMessage(wrappedEvent, loggedInPubkeyHex, {
                  uiThrottleMs,
                })) !== false
              );
            } catch {
              return false;
            }
          },
        };
        (options.priority === 'foreground' ? foregroundIngestTasks : backgroundIngestTasks).push(
          task,
        );
        startPrivateMessagesIngestWorker(generation);
      });
    }
    const generation = ingestQueueGeneration;
    const client = wrappedEvent.ndk;
    const key = `${loggedInPubkeyHex}:${wrappedEvent.id}`;
    const alreadyQueued = spoolWaiters.has(key);
    const result = new Promise<boolean>((resolve) => {
      const waiting = spoolWaiters.get(key) ?? [];
      waiting.push(resolve);
      spoolWaiters.set(key, waiting);
    });
    if (alreadyQueued) {
      if (options.reprocess) {
        await result;
        if (generation !== ingestQueueGeneration) return false;
        return queuePrivateMessageIngestion(wrappedEvent, loggedInPubkeyHex, options);
      }
      return result;
    }
    if (!resolveDrained)
      privateMessagesIngestQueue = new Promise<void>((resolve) => {
        resolveDrained = resolve;
      });
    const record: InboxRecord = {
      account: loggedInPubkeyHex,
      id: wrappedEvent.id,
      event: wrappedEvent.rawEvent(),
      priority: options.priority === 'foreground' ? 0 : 1,
      queuedAt: Date.now(),
      throttle: uiThrottleMs,
      ...(options.reprocess ? { reprocess: true } : {}),
      relayUrls: wrappedEvent.onRelays.map((r) => r.url),
    };
    spoolWrites++;
    // Start the journal concurrently. Immediate processing does not wait for its
    // write/read round trip; acknowledgement still requires durable success.
    const durable = inbox
      .put(record)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        spoolWrites--;
        wakeSpool?.();
      });
    if (hotInbox.size < 64) hotInbox.set(key, { record, durable });
    else if (record.priority === 0) {
      const background = [...hotInbox].find(([, item]) => item.record.priority === 1);
      if (background) {
        hotInbox.delete(background[0]);
        hotInbox.set(key, { record, durable });
      }
    }
    if (record.priority === 0) foregroundArrivalVersion++;
    wakeSpool?.();
    if (!spoolRunning) {
      commitTail = Promise.resolve();
      spoolRunning = true;
      void (async () => {
        const pending = new Set<Promise<void>>();
        const activeIds = new Set<string>();
        const deferredIds = new Set<string>();
        let failed = false;
        try {
          while (generation === ingestQueueGeneration) {
            if (failed) return;
            const awakened = new Promise<void>((resolve) => {
              wakeSpool = resolve;
            });
            const batchArrivalVersion = foregroundArrivalVersion;
            const hot = [...hotInbox.values()]
              .filter(
                ({ record }) => record.account === loggedInPubkeyHex && !activeIds.has(record.id),
              )
              .sort((a, b) => a.record.priority - b.record.priority);
            const batch = hot.length
              ? hot.slice(0, 32).map(({ record }) => record)
              : (await inbox.next(loggedInPubkeyHex, 32, deferredIds)).filter(
                  (record) => !activeIds.has(record.id),
                );
            if (!batch.length) {
              if (pending.size) {
                await Promise.race([...pending, awakened]);
                continue;
              }
              if (spoolWrites) {
                await yieldToMainThread();
                continue;
              }
              break;
            }
            for (const record of batch) {
              if (generation !== ingestQueueGeneration || failed) break;
              if (pending.size >= 8) await Promise.race(pending);
              if (failed) break;
              let releaseStage!: () => void;
              const staged = new Promise<void>((resolve) => {
                releaseStage = resolve;
              });
              activeIds.add(record.id);
              const hotKey = `${loggedInPubkeyHex}:${record.id}`;
              const journal = hotInbox.get(hotKey)?.durable;
              hotInbox.delete(hotKey);
              const job = (async () => {
                let accepted = false;
                try {
                  const event = new ClientEvent(client, record.event);
                  event.onRelays = (record.relayUrls ?? []).map((url) =>
                    client!.pool.getRelay(url, false),
                  );
                  event.relay = event.onRelays[0];
                  accepted =
                    !record.reprocess && (await inbox.hasProcessed(loggedInPubkeyHex, record.id));
                  if (generation !== ingestQueueGeneration) return;
                  if (!accepted)
                    accepted =
                      (await processIncomingPrivateMessage(event, loggedInPubkeyHex, {
                        uiThrottleMs: record.throttle,
                        onStaged: releaseStage,
                      })) !== false;
                  if (generation !== ingestQueueGeneration) return;
                  if (journal && !(await journal)) throw new Error('Ciphertext journal failed');
                  if (generation !== ingestQueueGeneration) return;
                  if (accepted) await inbox.complete(loggedInPubkeyHex, record.id);
                  else deferredIds.add(record.id);
                } catch {
                  accepted = false;
                  failed = true;
                  console.error(
                    'Failed to persist private message; encrypted inbox retained for retry',
                  );
                } finally {
                  releaseStage();
                }
                const itemKey = `${loggedInPubkeyHex}:${record.id}`;
                spoolWaiters.get(itemKey)?.forEach((resolve) => resolve(accepted));
                spoolWaiters.delete(itemKey);
              })();
              pending.add(job);
              void job.finally(() => {
                pending.delete(job);
                activeIds.delete(record.id);
              });
              await staged;
              await yieldToMainThread();
              // Re-read the priority index when live traffic arrives mid-history-page.
              if (foregroundArrivalVersion !== batchArrivalVersion) break;
            }
            if (failed) return;
          }
        } catch (error) {
          console.error('Message inbox failed');
        } finally {
          await Promise.all(pending);
          if (generation !== ingestQueueGeneration) return;
          spoolRunning = false;
          hotInbox.clear();
          for (const waiting of spoolWaiters.values()) waiting.forEach((resolve) => resolve(false));
          spoolWaiters.clear();
          resolveDrained?.();
          resolveDrained = null;
        }
      })();
    }
    return result;
  }

  async function repairRestoredOutgoingChats(account: string): Promise<void> {
    const generation = ingestQueueGeneration;
    const rows = await chatDataService.listChats();
    for (const row of rows) {
      if (generation !== ingestQueueGeneration) return;
      if (
        row.meta.inbox_state === 'blocked' ||
        row.meta.inbox_state === 'accepted' ||
        row.meta.accepted_at ||
        row.meta[CHAT_REQUEST_CLEARED_AT_META_KEY]
      )
        continue;
      // Seek the author index; never load a conversation's message history.
      const outgoing = await chatDataService.findLatestMessageByAuthor(row.public_key, account);
      if (generation !== ingestQueueGeneration) return;
      if (outgoing) {
        const [current, contact] = await Promise.all([
          chatDataService.getChatByPublicKey(row.public_key),
          contactsService.getContactByPublicKey(row.public_key),
        ]);
        if (generation !== ingestQueueGeneration) return;
        if (
          current &&
          current.meta.inbox_state !== 'blocked' &&
          !current.meta[CHAT_REQUEST_CLEARED_AT_META_KEY] &&
          !contact?.meta.blocked
        )
          await chatStore.acceptChat(row.public_key, { acceptedAt: outgoing.created_at });
      }
      await yieldToMainThread();
    }
  }

  async function resumePendingPrivateMessages(
    client: ClientEvent['ndk'],
    account: string,
  ): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    const [record] = await inbox.next(account, 1);
    if (!record) return;
    const event = new ClientEvent(client, record.event);
    event.onRelays = (record.relayUrls ?? []).map((url) => client!.pool.getRelay(url, false));
    await queuePrivateMessageIngestion(event, account, {
      priority: record.priority === 0 ? 'foreground' : 'background',
      uiThrottleMs: record.throttle,
    });
  }

  async function processIncomingPrivateMessage(
    wrappedEvent: ClientEvent,
    loggedInPubkeyHex: string,
    options: {
      uiThrottleMs?: number;
      onStaged?: () => void;
    } = {},
  ): Promise<boolean | undefined> {
    const processingGeneration = ingestQueueGeneration;
    const wrappedRelayUrls = extractRelayUrlsFromEvent(wrappedEvent);
    if (wrappedEvent.kind !== NostrKind.GiftWrap) {
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
      loggedInPubkeyHex,
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

    let rumorEvent: ClientEvent;
    try {
      rumorEvent = await giftUnwrap(wrappedEvent, undefined, recipientContext.unwrapSigner);
      if (processingGeneration !== ingestQueueGeneration) return false;
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

    // Call controls never enter chat, contact, message, unread, or notification persistence.
    // Only one-to-one rumors addressed to the active account can negotiate a call.
    if (rumorEvent.kind === CALL_SIGNAL_KIND) {
      if (
        !isSelfSentMessage &&
        !recipientContext.groupChatPublicKey &&
        recipientContext.recipientPubkey === loggedInPubkeyHex &&
        recipients.length === 1 &&
        recipients[0] === loggedInPubkeyHex &&
        !isPubkeyBlocked(senderPubkeyHex)
      ) {
        const signal = parseCallSignal(rumorEvent.content, rumorEvent.created_at);
        if (signal) await processIncomingCallSignal?.(senderPubkeyHex, signal);
        else {
          const roomSignal = parseRoomSignal(rumorEvent.content, rumorEvent.created_at);
          if (roomSignal) await processIncomingRoomSignal?.(senderPubkeyHex, roomSignal);
        }
      }
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
    let preflightMessage:
      Awaited<ReturnType<typeof chatDataService.getMessageByEventIdOrEditReference>> | undefined;
    // Edits are a kind 14 text convention; kind 15 file messages are never replacements.
    const rumorEditTargetEventId =
      rumorEvent.kind === NostrKind.PrivateDirectMessage
        ? readMessageEditTargetEventId(rumorEvent.tags)
        : null;
    const canReadMessageContext =
      isChatMessageRumorKind(rumorEvent.kind) &&
      !rumorEditTargetEventId &&
      !stagedEvents.has(rumorEvent.id);
    if (!isSelfSentMessage) {
      await Promise.all([chatDataService.init(), contactsService.init()]);
      const [blockedContact, blockedSenderContact, context] = await Promise.all([
        contactsService.getContactByPublicKey(chatPubkey),
        senderPubkeyHex === chatPubkey
          ? Promise.resolve(null)
          : contactsService.getContactByPublicKey(senderPubkeyHex),
        canReadMessageContext
          ? chatDataService.getIncomingMessageContext(chatPubkey, rumorEvent.id)
          : chatDataService
              .getChatByPublicKey(chatPubkey)
              .then((chat) => ({ chat, existingMessage: undefined })),
      ]);
      const blockedChat = context.chat;
      preflightContact = blockedContact;
      preflightChat = blockedChat;
      preflightMessage = context.existingMessage;
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

    if (resolvedGroupChatPublicKey && preflightChat === undefined)
      preflightChat = await chatDataService.getChatByPublicKey(chatPubkey);
    if (preflightChat?.meta.deleted_locally === true && rumorEvent.kind !== 1014) return;

    if (
      !isChatMessageRumorKind(rumorEvent.kind) ||
      rumorEditTargetEventId ||
      stagedEvents.has(rumorEvent.id)
    ) {
      await commitTail;
      if (processingGeneration !== ingestQueueGeneration) return false;
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

    if (rumorEvent.kind === NostrKind.EventDeletion) {
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

    if (rumorEvent.kind === NostrKind.Reaction) {
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
        verificationResult.epochPrivateKey ?? '',
      );

      await contactsService.init();
      await chatDataService.init();
      const senderContact = await contactsService.getContactByPublicKey(senderPubkeyHex);
      const existingGroupChat = await chatDataService.getChatByPublicKey(senderPubkeyHex);
      const incomingEpochCreatedAt = toIsoTimestampFromUnix(rumorEvent.created_at);
      const conflictingEpochNumber = findConflictingKnownGroupEpochNumber(
        existingGroupChat,
        epochNumber,
        epochPublicKey ?? '',
      );
      if (conflictingEpochNumber) {
        if (existingGroupChat) await chatDataService.updateChat(senderPubkeyHex, { meta: {
          ...existingGroupChat.meta, group_conflicting_epoch: Math.max(Number(existingGroupChat.meta.group_conflicting_epoch ?? -1), epochNumber),
        } });
        logConflictingIncomingEpochNumber(
          senderPubkeyHex,
          epochNumber,
          epochPublicKey ?? '',
          incomingEpochCreatedAt,
          conflictingEpochNumber,
        );
        logInboundEvent('drop', {
          reason: 'conflicting-epoch-public-key',
          epochNumber,
          epochPublicKey: formatSubscriptionLogValue(epochPublicKey),
          conflictingEpochPublicKey: formatSubscriptionLogValue(
            conflictingEpochNumber.epoch_public_key,
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
          verificationResult.signedEvent?.id ?? loggedEvent.id ?? null,
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
        },
      );
      // Retain verified keys for an explicit reopen, without restoring notices
      // or invitations to the inbox for a locally deleted group.
      if (existingGroupChat?.meta.deleted_locally === true) return;
      queueBackgroundGroupContactRefresh(senderPubkeyHex, fallbackGroupName, wrappedRelayUrls);
      queueNewChatProfile();

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
              },
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
        const { useMessageStore } = await import('#src/stores/messageStore.ts');
        await useMessageStore().upsertPersistedMessage(epochNoticeMessage);
      } catch (error) {
        console.error('Failed to sync incoming epoch notice into live state', error);
      }
      return;
    }

    if (!isChatMessageRumorKind(rumorEvent.kind)) {
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
    const isFileMessage = rumorEvent.kind === FILE_MESSAGE_KIND;
    // Kind 15 rumors must carry a complete, valid set of decryption tags; anything else is dropped
    // rather than shown as a plaintext link.
    const fileMessageAttachment = isFileMessage
      ? parseNip17FileMessageAttachment(messageText, rumorEvent.tags)
      : null;
    if (isFileMessage && !fileMessageAttachment) {
      logInboundEvent('drop', {
        reason: 'invalid-file-message',
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
      const existingOrEditedMessage =
        preflightMessage !== undefined
          ? preflightMessage
          : await chatDataService.getMessageByEventIdOrEditReference(rumorEventId);
      const existingMessage =
        normalizeEventId(existingOrEditedMessage?.event_id) === rumorEventId
          ? existingOrEditedMessage
          : null;
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
          },
        );
        updatedExistingMessage = await applyPendingIncomingDeletionsForMessage(
          updatedExistingMessage,
          {
            uiThrottleMs,
          },
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

      const existingEditedMessage = existingOrEditedMessage;
      if (
        existingEditedMessage &&
        messageEditReferencesEventId(existingEditedMessage.meta, rumorEventId)
      ) {
        let refreshedEditedMessage = await applyPendingIncomingReactionsForMessage(
          existingEditedMessage,
          { uiThrottleMs },
        );
        refreshedEditedMessage = await applyPendingIncomingDeletionsForMessage(
          refreshedEditedMessage,
          { uiThrottleMs },
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
            createdAt,
          )
        : null;
      if (higherEpochConflict?.olderHigherEpochEntry) {
        logInvalidIncomingEpochNumber(
          resolvedGroupChatPublicKey,
          incomingEpochNumber,
          resolvedGroupEpochContext.epochEntry.epoch_public_key,
          createdAt,
          higherEpochConflict,
        );
        logInboundEvent('drop', {
          reason: 'invalid-epoch-number',
          epochNumber: incomingEpochNumber,
          epochPublicKey: formatSubscriptionLogValue(
            resolvedGroupEpochContext.epochEntry.epoch_public_key,
          ),
          higherEpochNumber: higherEpochConflict.higherEpochEntry.epoch_number,
          higherEpochPublicKey: formatSubscriptionLogValue(
            higherEpochConflict.higherEpochEntry.epoch_public_key,
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

    const incomingChatInboxState =
      existingChat?.meta.inbox_state === 'blocked' || contact?.meta.blocked === true
        ? 'blocked'
        : resolveIncomingChatInboxStateValue({
            chat: existingChat,
            isAcceptedContact: isAcceptedContact || isSelfSentMessage,
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
      isPlainRecord(existingChat?.meta)
        ? existingChat.meta[CHAT_REQUEST_CLEARED_AT_META_KEY]
        : null,
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
    if (createdChat) queueNewChatProfile();
    let chat =
      stagedChats.get(chatPubkey) ??
      existingChat ??
      createdChat ??
      (await chatDataService.getChatByPublicKey(chatPubkey));
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
      isPlainRecord(contact?.meta) ? contact.meta.last_seen_incoming_activity_at : null,
    );
    const chatLastSeenReceivedActivityAt = normalizeTimestamp(
      isPlainRecord(chat.meta) ? chat.meta[lastSeenReceivedActivityAtMetaKey] : null,
    );
    const chatLastOutgoingMessageAt = normalizeTimestamp(
      isPlainRecord(chat.meta) ? chat.meta.last_outgoing_message_at : null,
    );
    const effectiveLastSeenIncomingActivityAt = resolveLatestReadBoundaryAtValue(
      contactLastSeenIncomingActivityAt,
      chatLastSeenReceivedActivityAt,
      chatLastOutgoingMessageAt,
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
          },
        )
      : null;
    const attachments = fileMessageAttachment
      ? [fileMessageAttachment]
      : extractMediaAttachmentsFromTags(rumorEvent.tags);
    const editTargetEventId = rumorEditTargetEventId;
    const callHistory =
      !resolvedGroupChatPublicKey && !isFileMessage ? callHistoryFromTags(rumorEvent.tags) : null;
    let messageMeta: Record<string, unknown> = {
      source: 'nostr',
      ...(callHistory ? { call_history: callHistory } : {}),
      kind: isFileMessage ? FILE_MESSAGE_KIND : NostrKind.PrivateDirectMessage,
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

    if (!editTargetMessage && !isFileMessage) {
      editTargetMessage = await chatDataService.findDeletedMessageInSecond(
        chat.public_key,
        senderPubkeyHex,
        createdAt,
      );
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
            chat.unread_count,
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
    const currentUnreadCount = Math.max(0, Number(chat.unread_count ?? 0));
    const attachmentPreviewText = buildImageAttachmentPreviewText(messageText, messageMeta);
    const messagePreviewText = resolvedGroupChatPublicKey
      ? formatGroupMentionsForDisplay(attachmentPreviewText, contact?.meta ?? null)
      : attachmentPreviewText;
    const isAfterSeenBoundary = isIncomingActivityAfterSeenBoundary(
      createdAt,
      effectiveLastSeenIncomingActivityAt,
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
      chat.last_message_at,
    );
    const nextPreviewAt = shouldUpdateChatPreview
      ? resolveIncomingPreviewTimestamp(createdAt, chat.last_message_at)
      : chat.last_message_at;
    // Publish verified content to reactive state before any message write. The
    // ingestion promise still represents the durable commit for EOSE coverage.
    const { useMessageStore } = await import('#src/stores/messageStore.ts');
    if (shouldUpdateChatPreview) {
      chatStore.applyIncomingMessage({
        publicKey: chat.public_key,
        authorPublicKey: senderPubkeyHex,
        fallbackName: deriveChatName(contact, chatPubkey),
        messageText: messagePreviewText,
        at: nextPreviewAt,
        unreadCount: nextUnreadCount,
        messageMeta,
        meta: { ...chat.meta, ...(contact?.meta.picture ? { picture: contact.meta.picture } : {}) },
      });
    }
    useMessageStore().stageIncomingMessage({
      chat_public_key: chat.public_key,
      author_public_key: senderPubkeyHex,
      message: messageText,
      created_at: createdAt,
      event_id: rumorEventId,
      meta: messageMeta,
    });
    const previousCommit = commitTail;
    const stagedChat = {
      ...chat,
      unread_count: nextUnreadCount,
      ...(shouldUpdateChatPreview
        ? { last_message: messagePreviewText, last_message_at: nextPreviewAt }
        : {}),
    };
    stagedChats.set(chat.public_key, stagedChat);
    if (rumorEventId) stagedEvents.add(rumorEventId);
    const commit = (async () => {
      await previousCommit;
      await yieldToMainThread();
      if (processingGeneration !== ingestQueueGeneration) return false;
      const createdMessage = await chatDataService.createMessage({
        chat_activity: {
          incomingAt: createdAt,
          unreadCount: nextUnreadCount,
          ...(shouldUpdateChatPreview
            ? { preview: { text: messagePreviewText, at: nextPreviewAt } }
            : {}),
        },
        chat_public_key: chat.public_key,
        author_public_key: senderPubkeyHex,
        message: messageText,
        created_at: createdAt,
        event_id: rumorEventId,
        meta: messageMeta,
      });
      if (!createdMessage) {
        // Deletion may win the race after this message was staged for display.
        const latestChat = await chatDataService.getChatByPublicKey(chat.public_key);
        if (latestChat?.meta.deleted_locally === true) {
          useMessageStore().removeChatMessages(chat.public_key);
          return;
        }
        throw new Error('Incoming message persistence failed');
      }
      if (processingGeneration !== ingestQueueGeneration) return false;

      let nextMessageRow = await applyPendingIncomingReactionsForMessage(createdMessage, {
        uiThrottleMs,
      });
      nextMessageRow = await applyPendingIncomingDeletionsForMessage(nextMessageRow, {
        uiThrottleMs,
      });
      await refreshReplyPreviewsForTargetMessage(nextMessageRow, {
        uiThrottleMs,
      });
      if (processingGeneration !== ingestQueueGeneration) return false;

      if (rumorNostrEvent) {
        await nostrEventDataService.upsertEvent({
          event: rumorNostrEvent,
          direction,
          relay_statuses: receivedRelayStatuses,
        });
      }

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

      await useMessageStore().upsertPersistedMessage(nextMessageRow);
    })();
    commitTail = commit.then(() => undefined);
    // The tail rejection is observed here as well as by the event's durable result.
    void commitTail.catch(() => {});
    options.onStaged?.();
    try {
      return await commit;
    } finally {
      if (processingGeneration === ingestQueueGeneration) {
        if (stagedChats.get(chat.public_key) === stagedChat) stagedChats.delete(chat.public_key);
        if (rumorEventId) stagedEvents.delete(rumorEventId);
      }
    }
  }

  return {
    getPrivateMessagesIngestQueue,
    queuePrivateMessageIngestion,
    resetPrivateMessagesIngestRuntimeState,
    resumePendingPrivateMessages,
    repairRestoredOutgoingChats,
  };
}
