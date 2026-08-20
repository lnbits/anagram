import { defineStore } from 'pinia';
import { getEmojiEntryByValue } from 'src/data/topEmojis';
import {
  type ChatRow,
  chatDataService,
  type MessageCursor as PersistedMessageCursor,
  type MessageSearchResult as PersistedMessageSearchResult,
} from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { useChatStore } from 'src/stores/chatStore';
import { resolveLatestReadBoundaryAtValue } from 'src/stores/nostr/valueUtils';
import type {
  DeletedMessageMetadata,
  Message,
  MessageAttachmentMetadata,
  MessageMetadata,
  MessageReaction,
  MessageReplyPreview,
  NostrEventEntry,
} from 'src/types/chat';
import { resolvePreferredContactRelayUrls } from 'src/utils/contactRelayUrls';
import { isIncomingUnreadMessageActivity } from 'src/utils/messageActivity';
import {
  buildAttachmentMessageMeta,
  buildAttachmentMessageText,
  buildNip92ImetaTag,
  normalizeMessageAttachment,
} from 'src/utils/messageAttachments';
import { buildMessageEditTag } from 'src/utils/messageEdits';
import {
  areMessageReactionsEqual,
  buildMetaWithReactions,
  countUnseenReactionsForAuthor,
  markReactionsViewedByAuthor,
  normalizeMessageReactions,
} from 'src/utils/messageReactions';
import { resolveMessageWindowMerge } from 'src/utils/messageWindowRange';
import { buildMentionMetadata } from 'src/utils/nostrMentions';
import { ref } from 'vue';

type MessageRow = Awaited<ReturnType<typeof chatDataService.listMessages>>[number];
const MESSAGE_PAGE_SIZE = 50;
const INITIAL_UNREAD_MESSAGE_LIMIT = 50;

interface ChatMessagePaginationState {
  oldestCursor: PersistedMessageCursor | null;
  newestCursor: PersistedMessageCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
}

interface RelaySendOptions {
  relayUrls?: string[];
  createdAt?: string;
}

interface ChatThreadSearchMatch {
  messageId: string;
  eventId: string | null;
  sentAt: string;
  text: string;
}

interface ForwardedMessagePayload {
  text: string;
  meta: MessageMetadata;
  additionalTags: string[][];
}

type NostrStoreModule = typeof import('src/stores/nostrStore');
type NostrStore = ReturnType<NostrStoreModule['useNostrStore']>;
type RelayStoreModule = typeof import('src/stores/relayStore');
type RelayStore = ReturnType<RelayStoreModule['useRelayStore']>;

export class MissingContactRelaysError extends Error {
  readonly code = 'missing-contact-relays';
  readonly chatPublicKey: string;

  constructor(chatPublicKey: string) {
    super('Inbound relays not found for this contact.');
    this.name = 'MissingContactRelaysError';
    this.chatPublicKey = chatPublicKey;
  }
}

export function isMissingContactRelaysError(error: unknown): error is MissingContactRelaysError {
  return (
    error instanceof MissingContactRelaysError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'missing-contact-relays')
  );
}

function normalizeChatIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue || null;
}

function getLoggedInPublicKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return normalizeChatIdentifier(window.localStorage.getItem('npub'));
}

function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue || null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue || null;
}

function toComparableTimestamp(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildDeletedMessageMeta(
  deletedByPublicKey: string,
  deletedEventKind: number,
  deletedAt: string,
  deleteEventId?: string | null
): DeletedMessageMetadata {
  return {
    deletedAt,
    deletedByPublicKey,
    deletedEventKind,
    ...(normalizeEventId(deleteEventId) ? { deleteEventId: normalizeEventId(deleteEventId) } : {}),
  };
}

function mapMessageRowToMessage(
  row: MessageRow,
  chatId: string,
  nostrEvent: NostrEventEntry | null = null
): Message {
  const authorKey = row.author_public_key.trim();
  const isMine = authorKey.toLowerCase() === window.localStorage.getItem('npub')?.toLowerCase();

  return {
    id: String(row.id),
    chatId,
    text: row.message,
    sender: isMine ? 'me' : 'them',
    sentAt: row.created_at,
    authorPublicKey: authorKey,
    eventId: row.event_id,
    nostrEvent,
    meta: {
      ...row.meta,
      ...buildMentionMetadata(row.message, getLoggedInPublicKey()),
    },
  };
}

function readForwardableAttachments(meta: MessageMetadata): MessageAttachmentMetadata[] {
  if (!Array.isArray(meta.attachments)) {
    return [];
  }

  const seenUrls = new Set<string>();
  const attachments: MessageAttachmentMetadata[] = [];
  for (const attachment of meta.attachments) {
    const normalized = normalizeMessageAttachment(attachment);
    const url = normalized?.url.trim();
    if (!normalized || !url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    attachments.push(normalized);
  }

  return attachments;
}

function buildForwardedMessagePayload(
  message: Pick<Message, 'text' | 'meta'>
): ForwardedMessagePayload | null {
  const text = message.text.trim();
  if (!text) {
    return null;
  }

  const attachments = readForwardableAttachments(message.meta);
  const additionalTags = attachments
    .map((attachment) => buildNip92ImetaTag(attachment))
    .filter((tag) => tag.length > 0);
  const meta: MessageMetadata = {
    ...buildMentionMetadata(text, getLoggedInPublicKey()),
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  return {
    text,
    meta,
    additionalTags,
  };
}

function buildMessageCursorFromRow(
  row: Pick<MessageRow, 'id' | 'created_at'> | null | undefined
): PersistedMessageCursor | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    created_at: row.created_at,
  };
}

function buildMessageCursorFromSearchResult(
  row: Pick<PersistedMessageSearchResult, 'id' | 'created_at'> | null | undefined
): PersistedMessageCursor | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    created_at: row.created_at,
  };
}

function buildMessageCursorFromMessage(
  message: Pick<Message, 'id' | 'sentAt'> | null | undefined
): PersistedMessageCursor | null {
  if (!message) {
    return null;
  }

  const messageId = Number.parseInt(message.id, 10);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return null;
  }

  return {
    id: messageId,
    created_at: message.sentAt,
  };
}

function compareMessageCursors(
  first: Pick<PersistedMessageCursor, 'id' | 'created_at'>,
  second: Pick<PersistedMessageCursor, 'id' | 'created_at'>
): number {
  const byTime = toComparableTimestamp(first.created_at) - toComparableTimestamp(second.created_at);
  if (byTime !== 0) {
    return byTime;
  }

  return first.id - second.id;
}

function getNormalizedMessageAuthorKey(
  row: Pick<MessageRow, 'author_public_key'> | null | undefined
): string {
  return normalizeChatIdentifier(row?.author_public_key) ?? '';
}

function takeLeadingRowsWithAuthor(rows: MessageRow[], authorKey: string): MessageRow[] {
  const matchingRows: MessageRow[] = [];
  for (const row of rows) {
    if (getNormalizedMessageAuthorKey(row) !== authorKey) {
      break;
    }

    matchingRows.push(row);
  }

  return matchingRows;
}

function takeTrailingRowsWithAuthor(rows: MessageRow[], authorKey: string): MessageRow[] {
  let startIndex = rows.length;
  while (startIndex > 0) {
    if (getNormalizedMessageAuthorKey(rows[startIndex - 1]) !== authorKey) {
      break;
    }

    startIndex -= 1;
  }

  return rows.slice(startIndex);
}

function buildDefaultChatMessagePaginationState(): ChatMessagePaginationState {
  return {
    oldestCursor: null,
    newestCursor: null,
    hasOlder: false,
    hasNewer: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
  };
}

function compareMessagesBySentAt(first: Message, second: Message): number {
  const firstTimestamp = new Date(first.sentAt).getTime();
  const secondTimestamp = new Date(second.sentAt).getTime();

  if (firstTimestamp !== secondTimestamp) {
    return firstTimestamp - secondTimestamp;
  }

  const firstId = Number.parseInt(first.id, 10);
  const secondId = Number.parseInt(second.id, 10);
  if (Number.isInteger(firstId) && Number.isInteger(secondId) && firstId !== secondId) {
    return firstId - secondId;
  }

  return first.id.localeCompare(second.id);
}

function countOwnUnseenReactions(
  rows: Array<Pick<MessageRow, 'author_public_key' | 'meta'>>,
  loggedInPublicKey: string | null | undefined
): number {
  const normalizedLoggedInPublicKey = normalizeChatIdentifier(loggedInPublicKey);
  if (!normalizedLoggedInPublicKey) {
    return 0;
  }

  return rows.reduce((count, row) => {
    if (normalizeChatIdentifier(row.author_public_key) !== normalizedLoggedInPublicKey) {
      return count;
    }

    return (
      count +
      countUnseenReactionsForAuthor(
        normalizeMessageReactions(row.meta.reactions),
        normalizedLoggedInPublicKey
      )
    );
  }, 0);
}

function resolveLatestOwnMessageAt(
  rows: Array<Pick<MessageRow, 'author_public_key' | 'created_at'>>,
  loggedInPublicKey: string | null | undefined
): string {
  const normalizedLoggedInPublicKey = normalizeChatIdentifier(loggedInPublicKey);
  if (!normalizedLoggedInPublicKey) {
    return '';
  }

  return rows.reduce((latest, row) => {
    if (normalizeChatIdentifier(row.author_public_key) !== normalizedLoggedInPublicKey) {
      return latest;
    }

    return toComparableTimestamp(row.created_at) > toComparableTimestamp(latest)
      ? row.created_at
      : latest;
  }, '');
}

function countUnreadMessageRowsAfterBoundary(
  rows: Array<Pick<MessageRow, 'author_public_key' | 'created_at' | 'meta'>>,
  loggedInPublicKey: string | null | undefined,
  boundaryAt: string
): number {
  const boundaryTimestamp = toComparableTimestamp(boundaryAt);

  return rows.reduce((count, row) => {
    if (!isIncomingUnreadMessageActivity(row, loggedInPublicKey)) {
      return count;
    }

    return count + (toComparableTimestamp(row.created_at) > boundaryTimestamp ? 1 : 0);
  }, 0);
}

function areReactionListsEqualValue(
  currentReactions: MessageReaction[],
  nextReactions: MessageReaction[]
): boolean {
  return (
    currentReactions.length === nextReactions.length &&
    currentReactions.every((reaction, index) => {
      const nextReaction = nextReactions[index];
      return nextReaction ? areMessageReactionsEqual(reaction, nextReaction) : false;
    })
  );
}

function mergeMessagesById(currentMessages: Message[], incomingMessages: Message[]): Message[] {
  if (incomingMessages.length === 0) {
    return currentMessages;
  }

  const mergedMessagesById = new Map<string, Message>();
  currentMessages.forEach((message) => {
    mergedMessagesById.set(message.id, message);
  });
  incomingMessages.forEach((message) => {
    mergedMessagesById.set(message.id, message);
  });

  return Array.from(mergedMessagesById.values()).sort(compareMessagesBySentAt);
}

function readUnseenReactionCountFromMetaValue(meta: Record<string, unknown>): number {
  const rawValue = meta.unseen_reaction_count;
  const numericValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.floor(numericValue));
}

function buildChatMetaWithUnseenReactionCountValue(
  meta: Record<string, unknown>,
  unseenReactionCount: number
): Record<string, unknown> {
  const normalizedCount = Math.max(0, Math.floor(Number(unseenReactionCount) || 0));
  const nextMeta = { ...meta };

  if (normalizedCount > 0) {
    nextMeta.unseen_reaction_count = normalizedCount;
    return nextMeta;
  }

  delete nextMeta.unseen_reaction_count;
  return nextMeta;
}

function buildInitialMessageWindowFromUnreadAnchor(
  olderRows: MessageRow[],
  firstUnreadRow: MessageRow,
  newerRows: MessageRow[],
  hasOlder: boolean,
  hasNewer: boolean
): {
  rows: MessageRow[];
  hasOlder: boolean;
  hasNewer: boolean;
} {
  return {
    rows: [...olderRows, firstUnreadRow, ...newerRows],
    hasOlder,
    hasNewer,
  };
}

function resolveChatRecipientPublicKeyFromRow(
  chat: Pick<ChatRow, 'public_key' | 'type' | 'meta'>
): string {
  return chat.type === 'group'
    ? typeof chat.meta.current_epoch_public_key === 'string'
      ? chat.meta.current_epoch_public_key.trim().toLowerCase()
      : ''
    : chat.public_key;
}

function resolveSendRelayUrlsValue(options: {
  chatPublicKey: string;
  relayUrls?: string[];
  recipientRelayUrls?: string[];
}): string[] {
  const hasExplicitRelayUrls = Array.isArray(options.relayUrls);
  const normalizedRelayUrls = hasExplicitRelayUrls
    ? inputSanitizerService.normalizeStringArray(options.relayUrls)
    : inputSanitizerService.normalizeStringArray(options.recipientRelayUrls ?? []);

  if (normalizedRelayUrls.length === 0) {
    if (hasExplicitRelayUrls) {
      throw new Error('Cannot send encrypted event without application relays.');
    }

    throw new MissingContactRelaysError(options.chatPublicKey);
  }

  return normalizedRelayUrls;
}

function shouldPublishSelfCopyForChatRow(chat: Pick<ChatRow, 'public_key' | 'type'>): boolean {
  if (chat.type === 'group') {
    return false;
  }

  const loggedInPublicKey = getLoggedInPublicKey();
  if (!loggedInPublicKey) {
    return true;
  }

  return normalizeChatIdentifier(chat.public_key) !== loggedInPublicKey;
}

function resolveChatDeliveryTargetValue<T extends Pick<ChatRow, 'public_key' | 'type' | 'meta'>>(
  chat: T | null | undefined,
  options: {
    relayUrls?: string[];
    recipientRelayUrls?: string[];
  } = {}
): {
  chat: T;
  recipientPublicKey: string;
  relayUrls: string[];
  publishSelfCopy: boolean;
} | null {
  if (!chat) {
    return null;
  }

  const recipientPublicKey = resolveChatRecipientPublicKeyFromRow(chat);
  if (!recipientPublicKey) {
    throw new Error('Group chat is missing the current epoch public key.');
  }

  return {
    chat,
    recipientPublicKey,
    relayUrls: resolveSendRelayUrlsValue({
      chatPublicKey: chat.public_key,
      relayUrls: options.relayUrls,
      recipientRelayUrls: options.recipientRelayUrls,
    }),
    publishSelfCopy: shouldPublishSelfCopyForChatRow(chat),
  };
}

function resolveReplyTargetEventIdValue(
  replyTo: Pick<MessageReplyPreview, 'eventId' | 'messageId'> | null,
  persistedEventId?: string | null
): string | null {
  const directEventId = normalizeEventId(replyTo?.eventId);
  if (directEventId) {
    return directEventId;
  }

  const localMessageId = Number.parseInt(replyTo?.messageId ?? '', 10);
  if (!Number.isInteger(localMessageId) || localMessageId <= 0) {
    return null;
  }

  return normalizeEventId(persistedEventId);
}

function applyMessageUpsert(
  currentMessages: Message[],
  paginationState: ChatMessagePaginationState | null | undefined,
  message: Message,
  options: {
    allowOutsideLoadedWindow?: boolean;
  } = {}
): {
  ignored: boolean;
  messages: Message[];
  paginationState: ChatMessagePaginationState;
} {
  const existingIndex = currentMessages.findIndex((entry) => entry.id === message.id);
  if (existingIndex >= 0) {
    const nextMessages = [...currentMessages];
    nextMessages[existingIndex] = message;
    return {
      ignored: false,
      messages: nextMessages,
      paginationState: paginationState ?? buildDefaultChatMessagePaginationState(),
    };
  }

  const nextPaginationState = paginationState ?? buildDefaultChatMessagePaginationState();
  const incomingCursor = buildMessageCursorFromMessage(message);
  const firstLoadedCursor = buildMessageCursorFromMessage(currentMessages[0] ?? null);
  const lastLoadedCursor = buildMessageCursorFromMessage(
    currentMessages[currentMessages.length - 1] ?? null
  );
  const isBeforeLoadedRange =
    incomingCursor !== null &&
    firstLoadedCursor !== null &&
    compareMessageCursors(incomingCursor, firstLoadedCursor) < 0;
  const isAfterLoadedRange =
    incomingCursor !== null &&
    lastLoadedCursor !== null &&
    compareMessageCursors(incomingCursor, lastLoadedCursor) > 0;

  if (
    !options.allowOutsideLoadedWindow &&
    paginationState &&
    ((isBeforeLoadedRange && paginationState.hasOlder) ||
      (isAfterLoadedRange && paginationState.hasNewer))
  ) {
    return {
      ignored: true,
      messages: currentMessages,
      paginationState: nextPaginationState,
    };
  }

  const nextMessages = mergeMessagesById(currentMessages, [message]);
  if (!incomingCursor) {
    return {
      ignored: false,
      messages: nextMessages,
      paginationState: nextPaginationState,
    };
  }

  const paginationPatch: Partial<ChatMessagePaginationState> = {};

  if (
    !nextPaginationState.oldestCursor ||
    (!nextPaginationState.hasOlder &&
      compareMessageCursors(incomingCursor, nextPaginationState.oldestCursor) < 0)
  ) {
    paginationPatch.oldestCursor = incomingCursor;
  }

  if (
    !nextPaginationState.newestCursor ||
    (!nextPaginationState.hasNewer &&
      compareMessageCursors(incomingCursor, nextPaginationState.newestCursor) > 0)
  ) {
    paginationPatch.newestCursor = incomingCursor;
  }

  return {
    ignored: false,
    messages: nextMessages,
    paginationState: {
      ...nextPaginationState,
      ...paginationPatch,
    },
  };
}

export const __messageStoreTestUtils = {
  applyMessageUpsert,
  areReactionListsEqual: areReactionListsEqualValue,
  buildChatMetaWithUnseenReactionCount: buildChatMetaWithUnseenReactionCountValue,
  buildDeletedMessageMeta,
  buildDefaultChatMessagePaginationState,
  buildForwardedMessagePayload,
  buildInitialMessageWindowFromUnreadAnchor,
  buildMessageCursorFromMessage,
  buildMessageCursorFromSearchResult,
  compareMessageCursors,
  countUnreadMessageRowsAfterBoundary,
  countOwnUnseenReactions,
  mapMessageRowToMessage,
  mergeMessagesById,
  readUnseenReactionCountFromMeta: readUnseenReactionCountFromMetaValue,
  resolveLatestOwnMessageAt,
  resolveChatDeliveryTarget: resolveChatDeliveryTargetValue,
  resolveChatRecipientPublicKey: resolveChatRecipientPublicKeyFromRow,
  resolveReplyTargetEventId: resolveReplyTargetEventIdValue,
  resolveSendRelayUrls: resolveSendRelayUrlsValue,
  takeLeadingRowsWithAuthor,
  takeTrailingRowsWithAuthor,
};

export const useMessageStore = defineStore('messageStore', () => {
  const chatStore = useChatStore();
  const messagesByChat = ref<Record<string, Message[]>>({});
  const paginationStateByChat = ref<Record<string, ChatMessagePaginationState>>({});
  const loadedChatIds = new Set<string>();
  const loadingChatPromises = new Map<string, Promise<void>>();
  const paginationLoadPromises = new Map<string, Promise<void>>();
  const unseenReactionSyncPromises = new Map<string, Promise<number>>();
  let nostrStorePromise: Promise<NostrStore> | null = null;
  let relayStorePromise: Promise<RelayStore> | null = null;

  function getMessages(chatId: string | null): Message[] {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return [];
    }

    if (!loadedChatIds.has(normalizedChatId) && !loadingChatPromises.has(normalizedChatId)) {
      void loadMessages(normalizedChatId);
    }

    return messagesByChat.value[normalizedChatId] ?? [];
  }

  function getPaginationState(chatId: string | null): ChatMessagePaginationState {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return buildDefaultChatMessagePaginationState();
    }

    return (
      paginationStateByChat.value[normalizedChatId] ?? buildDefaultChatMessagePaginationState()
    );
  }

  function setPaginationState(
    chatId: string,
    nextState: Partial<ChatMessagePaginationState>
  ): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    paginationStateByChat.value[normalizedChatId] = {
      ...(paginationStateByChat.value[normalizedChatId] ??
        buildDefaultChatMessagePaginationState()),
      ...nextState,
    };
  }

  async function init(): Promise<void> {
    await Promise.all([chatDataService.init(), nostrEventDataService.init()]);
  }

  async function getNostrStore(): Promise<NostrStore> {
    if (!nostrStorePromise) {
      nostrStorePromise = import('src/stores/nostrStore').then(({ useNostrStore }) =>
        useNostrStore()
      );
    }

    return nostrStorePromise;
  }

  async function getRelayStore(): Promise<RelayStore> {
    if (!relayStorePromise) {
      relayStorePromise = import('src/stores/relayStore').then(({ useRelayStore }) => {
        const relayStore = useRelayStore();
        relayStore.init();
        return relayStore;
      });
    }

    return relayStorePromise;
  }

  async function hydrateMessageRows(rows: MessageRow[], chatId: string): Promise<Message[]> {
    const eventIds = rows
      .map((row) => row.event_id)
      .filter(
        (eventId): eventId is string => typeof eventId === 'string' && eventId.trim().length > 0
      );
    const eventsById = await nostrEventDataService.getEventsByIds(eventIds);

    return rows.map((row) =>
      mapMessageRowToMessage(
        row,
        chatId,
        row.event_id ? (eventsById.get(row.event_id) ?? null) : null
      )
    );
  }

  async function hydrateMessageRow(row: MessageRow, chatId?: string): Promise<Message> {
    const resolvedChatId =
      normalizeChatIdentifier(chatId) ?? normalizeChatIdentifier(row.chat_public_key);
    if (!resolvedChatId) {
      throw new Error('Failed to resolve message chat public key.');
    }

    const nostrEvent = row.event_id ? await nostrEventDataService.getEventById(row.event_id) : null;
    return mapMessageRowToMessage(row, resolvedChatId, nostrEvent);
  }

  function replaceMessageInState(chatId: string, message: Message): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const existingMessages = messagesByChat.value[normalizedChatId] ?? [];
    const existingIndex = existingMessages.findIndex((entry) => entry.id === message.id);
    if (existingIndex === -1) {
      return;
    }

    const nextMessages = [...existingMessages];
    nextMessages[existingIndex] = message;
    messagesByChat.value[normalizedChatId] = nextMessages;
  }

  function getMessageFromState(chatId: string, messageId: string): Message | null {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return null;
    }

    return (
      messagesByChat.value[normalizedChatId]?.find((message) => message.id === messageId) ?? null
    );
  }

  function areReactionListsEqual(
    currentReactions: MessageReaction[],
    nextReactions: MessageReaction[]
  ): boolean {
    return (
      currentReactions.length === nextReactions.length &&
      currentReactions.every((reaction, index) => {
        const nextReaction = nextReactions[index];
        return nextReaction ? areMessageReactionsEqual(reaction, nextReaction) : false;
      })
    );
  }

  function readMetaString(meta: Record<string, unknown>, key: string): string {
    const value = meta[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  async function performSyncChatUnseenReactionCount(chatId: string): Promise<number> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return 0;
    }

    await chatDataService.init();

    const [chatRow, messageRows] = await Promise.all([
      chatDataService.getChatByPublicKey(normalizedChatId),
      chatDataService.listMessages(normalizedChatId),
    ]);
    const loggedInPublicKey = getLoggedInPublicKey();
    const nextUnseenReactionCount = countOwnUnseenReactions(messageRows, loggedInPublicKey);

    if (chatRow) {
      const currentCount = readUnseenReactionCountFromMetaValue(chatRow.meta);
      if (currentCount !== nextUnseenReactionCount) {
        await chatDataService.updateChatMeta(
          normalizedChatId,
          buildChatMetaWithUnseenReactionCountValue(chatRow.meta, nextUnseenReactionCount)
        );
      }
    }

    chatStore.setUnseenReactionCount(normalizedChatId, nextUnseenReactionCount);
    return nextUnseenReactionCount;
  }

  async function syncChatUnseenReactionCount(chatId: string): Promise<number> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return 0;
    }

    const existingSync = unseenReactionSyncPromises.get(normalizedChatId) ?? Promise.resolve(0);
    const nextSync = existingSync
      .catch(() => 0)
      .then(() => performSyncChatUnseenReactionCount(normalizedChatId));

    unseenReactionSyncPromises.set(normalizedChatId, nextSync);

    try {
      return await nextSync;
    } finally {
      if (unseenReactionSyncPromises.get(normalizedChatId) === nextSync) {
        unseenReactionSyncPromises.delete(normalizedChatId);
      }
    }
  }

  async function resolveAppRelayUrls(): Promise<string[]> {
    const relayStore = await getRelayStore();
    return inputSanitizerService.normalizeStringArray(relayStore.relays);
  }

  async function resolveRecipientRelayUrls(chatPublicKey: string): Promise<string[]> {
    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(chatPublicKey);
    const contactRelayUrls = resolvePreferredContactRelayUrls(contact?.relays);
    const appRelayUrls = contact?.sendMessagesToAppRelays ? await resolveAppRelayUrls() : [];
    return inputSanitizerService.normalizeStringArray([...contactRelayUrls, ...appRelayUrls]);
  }

  async function resolveSendRelayUrls(
    chatPublicKey: string,
    relayUrls: string[] | undefined
  ): Promise<string[]> {
    return resolveSendRelayUrlsValue({
      chatPublicKey,
      relayUrls,
      recipientRelayUrls: Array.isArray(relayUrls)
        ? relayUrls
        : await resolveRecipientRelayUrls(chatPublicKey),
    });
  }

  async function resolveChatDeliveryTarget(
    chatPublicKey: string,
    relayUrls: string[] | undefined
  ): Promise<{
    chat: ChatRow;
    recipientPublicKey: string;
    relayUrls: string[];
    publishSelfCopy: boolean;
  } | null> {
    const chat = await chatDataService.getChatByPublicKey(chatPublicKey);
    if (!chat) {
      return null;
    }

    return resolveChatDeliveryTargetValue(chat, {
      relayUrls,
      recipientRelayUrls: relayUrls ? relayUrls : await resolveRecipientRelayUrls(chat.public_key),
    });
  }

  async function resolveReplyTargetEventId(
    replyTo: MessageReplyPreview | null
  ): Promise<string | null> {
    const localMessageId = Number.parseInt(replyTo?.messageId ?? '', 10);
    if (Number.isInteger(localMessageId) && localMessageId > 0) {
      await chatDataService.init();
      const replyMessageRow = await chatDataService.getMessageById(localMessageId);
      const persistedEventId = normalizeEventId(replyMessageRow?.event_id);
      if (persistedEventId) {
        return persistedEventId;
      }
    }

    return resolveReplyTargetEventIdValue(replyTo, null);
  }

  function upsertMessageInState(
    chatId: string,
    message: Message,
    options: {
      allowOutsideLoadedWindow?: boolean;
    } = {}
  ): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const existingMessages = messagesByChat.value[normalizedChatId] ?? [];
    const computedUpsert = applyMessageUpsert(
      existingMessages,
      paginationStateByChat.value[normalizedChatId],
      message,
      options
    );

    if (computedUpsert.ignored) {
      return;
    }

    messagesByChat.value[normalizedChatId] = computedUpsert.messages;
    paginationStateByChat.value[normalizedChatId] = computedUpsert.paginationState;
  }

  function upsertPersistedMessage(row: MessageRow): Promise<void> {
    const chatId = normalizeChatIdentifier(row.chat_public_key);
    if (!chatId || (!loadedChatIds.has(chatId) && !messagesByChat.value[chatId])) {
      return Promise.resolve();
    }

    return hydrateMessageRow(row, chatId).then((message) => {
      upsertMessageInState(chatId, message);
    });
  }

  async function refreshPersistedMessage(messageId: number): Promise<void> {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return;
    }

    await chatDataService.init();
    const row = await chatDataService.getMessageById(messageId);
    if (!row) {
      return;
    }

    await upsertPersistedMessage(row);
  }

  async function extendOlderEdgeRows(
    chatId: string,
    initialRows: MessageRow[],
    initialHasMore: boolean
  ): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
    if (initialRows.length === 0 || !initialHasMore) {
      return {
        rows: initialRows,
        hasMore: initialHasMore,
      };
    }

    const boundaryAuthorKey = getNormalizedMessageAuthorKey(initialRows[0]);
    if (!boundaryAuthorKey) {
      return {
        rows: initialRows,
        hasMore: initialHasMore,
      };
    }

    const rows = [...initialRows];
    let hasMore: boolean = initialHasMore;

    while (hasMore) {
      const oldestCursor = buildMessageCursorFromRow(rows[0] ?? null);
      if (!oldestCursor) {
        break;
      }

      const nextBatch = await chatDataService.listMessagesBefore(
        chatId,
        oldestCursor,
        MESSAGE_PAGE_SIZE
      );
      if (nextBatch.rows.length === 0) {
        hasMore = false;
        break;
      }

      const matchingRows = takeTrailingRowsWithAuthor(nextBatch.rows, boundaryAuthorKey);
      if (matchingRows.length > 0) {
        rows.unshift(...matchingRows);
      }

      if (matchingRows.length !== nextBatch.rows.length) {
        hasMore = true;
        break;
      }

      hasMore = nextBatch.has_more;
    }

    return {
      rows,
      hasMore,
    };
  }

  async function extendNewerEdgeRows(
    chatId: string,
    initialRows: MessageRow[],
    initialHasMore: boolean
  ): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
    if (initialRows.length === 0 || !initialHasMore) {
      return {
        rows: initialRows,
        hasMore: initialHasMore,
      };
    }

    const boundaryAuthorKey = getNormalizedMessageAuthorKey(
      initialRows[initialRows.length - 1] ?? null
    );
    if (!boundaryAuthorKey) {
      return {
        rows: initialRows,
        hasMore: initialHasMore,
      };
    }

    const rows = [...initialRows];
    let hasMore: boolean = initialHasMore;

    while (hasMore) {
      const newestCursor = buildMessageCursorFromRow(rows[rows.length - 1] ?? null);
      if (!newestCursor) {
        break;
      }

      const nextBatch = await chatDataService.listMessagesAfter(
        chatId,
        newestCursor,
        MESSAGE_PAGE_SIZE
      );
      if (nextBatch.rows.length === 0) {
        hasMore = false;
        break;
      }

      const matchingRows = takeLeadingRowsWithAuthor(nextBatch.rows, boundaryAuthorKey);
      if (matchingRows.length > 0) {
        rows.push(...matchingRows);
      }

      if (matchingRows.length !== nextBatch.rows.length) {
        hasMore = true;
        break;
      }

      hasMore = nextBatch.has_more;
    }

    return {
      rows,
      hasMore,
    };
  }

  async function loadInitialMessageWindow(chatId: string): Promise<{
    rows: MessageRow[];
    hasOlder: boolean;
    hasNewer: boolean;
  }> {
    const chat = await chatDataService.getChatByPublicKey(chatId);
    if (!chat) {
      return {
        rows: [],
        hasOlder: false,
        hasNewer: false,
      };
    }

    const lastSeenReceivedActivityAt =
      typeof chat.meta.last_seen_received_activity_at === 'string'
        ? chat.meta.last_seen_received_activity_at.trim()
        : '';
    const unreadCount = Math.max(0, Number(chat.unread_count ?? 0));
    const loggedInPublicKey = getLoggedInPublicKey();

    if (unreadCount > 0 && lastSeenReceivedActivityAt && loggedInPublicKey) {
      const firstUnreadRow = await chatDataService.findFirstIncomingMessageAfter(
        chatId,
        lastSeenReceivedActivityAt,
        loggedInPublicKey
      );

      if (firstUnreadRow) {
        const firstUnreadCursor = buildMessageCursorFromRow(firstUnreadRow);
        if (firstUnreadCursor) {
          const [initialOlderBatch, initialUnreadBatch] = await Promise.all([
            chatDataService.listMessagesBefore(chatId, firstUnreadCursor, MESSAGE_PAGE_SIZE),
            chatDataService.listMessagesAfter(
              chatId,
              firstUnreadCursor,
              INITIAL_UNREAD_MESSAGE_LIMIT - 1
            ),
          ]);
          const [olderBatch, unreadBatch] = await Promise.all([
            extendOlderEdgeRows(chatId, initialOlderBatch.rows, initialOlderBatch.has_more),
            extendNewerEdgeRows(
              chatId,
              [firstUnreadRow, ...initialUnreadBatch.rows],
              initialUnreadBatch.has_more
            ),
          ]);

          return buildInitialMessageWindowFromUnreadAnchor(
            olderBatch.rows,
            firstUnreadRow,
            unreadBatch.rows.slice(1),
            olderBatch.hasMore,
            unreadBatch.hasMore
          );
        }
      }
    }

    const latestBatch = await chatDataService.listLatestMessages(chatId, MESSAGE_PAGE_SIZE);
    const extendedLatestBatch = await extendOlderEdgeRows(
      chatId,
      latestBatch.rows,
      latestBatch.has_more
    );
    return {
      rows: extendedLatestBatch.rows,
      hasOlder: extendedLatestBatch.hasMore,
      hasNewer: false,
    };
  }

  async function loadMessages(chatId: string, force = false): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    if (!force && loadedChatIds.has(normalizedChatId)) {
      return;
    }

    const existingLoad = loadingChatPromises.get(normalizedChatId);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    const loadPromise = (async () => {
      try {
        const initialWindow = await loadInitialMessageWindow(normalizedChatId);
        messagesByChat.value[normalizedChatId] = await hydrateMessageRows(
          initialWindow.rows,
          normalizedChatId
        );
        setPaginationState(normalizedChatId, {
          oldestCursor: buildMessageCursorFromRow(initialWindow.rows[0] ?? null),
          newestCursor: buildMessageCursorFromRow(
            initialWindow.rows[initialWindow.rows.length - 1] ?? null
          ),
          hasOlder: initialWindow.hasOlder,
          hasNewer: initialWindow.hasNewer,
          isLoadingOlder: false,
          isLoadingNewer: false,
        });
        loadedChatIds.add(normalizedChatId);
      } catch (error) {
        console.error('Failed to load messages for chat', normalizedChatId, error);
      }
    })();

    loadingChatPromises.set(normalizedChatId, loadPromise);
    try {
      await loadPromise;
    } finally {
      loadingChatPromises.delete(normalizedChatId);
    }
  }

  async function reloadLoadedMessages(): Promise<void> {
    const chatIds = Array.from(loadedChatIds);
    if (chatIds.length === 0) {
      return;
    }

    await Promise.all(chatIds.map((chatId) => loadMessages(chatId, true)));
  }

  async function searchMessages(chatId: string, query: string): Promise<ChatThreadSearchMatch[]> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedQuery = query.trim();
    if (!normalizedChatId || !normalizedQuery) {
      return [];
    }

    await chatDataService.init();
    const rows = await chatDataService.searchMessages(normalizedChatId, normalizedQuery);
    return rows.map((row) => ({
      messageId: String(row.id),
      eventId: row.event_id,
      sentAt: row.created_at,
      text: row.message,
    }));
  }

  async function ensureMessageLoaded(chatId: string, messageId: string): Promise<Message | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    if (!normalizedChatId || !Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    const existingMessage = getMessageFromState(normalizedChatId, String(normalizedMessageId));
    if (existingMessage) {
      return existingMessage;
    }

    if (!loadedChatIds.has(normalizedChatId)) {
      await loadMessages(normalizedChatId);
    }

    const loadedAfterInitialLoad = getMessageFromState(
      normalizedChatId,
      String(normalizedMessageId)
    );
    if (loadedAfterInitialLoad) {
      return loadedAfterInitialLoad;
    }

    await chatDataService.init();
    const targetRow = await chatDataService.getMessageById(normalizedMessageId);
    if (!targetRow || normalizeChatIdentifier(targetRow.chat_public_key) !== normalizedChatId) {
      return null;
    }

    const targetCursor = buildMessageCursorFromRow(targetRow);
    if (!targetCursor) {
      return null;
    }

    let iterationCount = 0;
    while (iterationCount < 200) {
      const currentMessage = getMessageFromState(normalizedChatId, String(normalizedMessageId));
      if (currentMessage) {
        return currentMessage;
      }

      const paginationState = paginationStateByChat.value[normalizedChatId];
      const oldestCursor = paginationState?.oldestCursor ?? null;
      const newestCursor = paginationState?.newestCursor ?? null;
      const needsOlderLoad =
        Boolean(oldestCursor) &&
        compareMessageCursors(targetCursor, oldestCursor as PersistedMessageCursor) < 0;
      const needsNewerLoad =
        Boolean(newestCursor) &&
        compareMessageCursors(targetCursor, newestCursor as PersistedMessageCursor) > 0;

      if (needsOlderLoad && paginationState?.hasOlder) {
        iterationCount += 1;
        await loadOlderMessages(normalizedChatId);
        continue;
      }

      if (needsNewerLoad && paginationState?.hasNewer) {
        iterationCount += 1;
        await loadNewerMessages(normalizedChatId);
        continue;
      }

      break;
    }

    const loadedMessage = getMessageFromState(normalizedChatId, String(normalizedMessageId));
    if (loadedMessage) {
      return loadedMessage;
    }

    const allRows = await chatDataService.listMessages(normalizedChatId);
    const currentMessages = messagesByChat.value[normalizedChatId] ?? [];
    const mergeResult = resolveMessageWindowMerge(allRows, currentMessages, normalizedMessageId);
    if (!mergeResult) {
      return null;
    }

    const paginationPatch: Partial<ChatMessagePaginationState> = {};
    if (mergeResult.oldestRow) {
      paginationPatch.oldestCursor = buildMessageCursorFromRow(mergeResult.oldestRow);
      paginationPatch.hasOlder = mergeResult.hasOlder ?? false;
    }

    if (mergeResult.newestRow) {
      paginationPatch.newestCursor = buildMessageCursorFromRow(mergeResult.newestRow);
      paginationPatch.hasNewer = mergeResult.hasNewer ?? false;
    }

    const hydratedMessages = await hydrateMessageRows(mergeResult.rowsToMerge, normalizedChatId);
    messagesByChat.value[normalizedChatId] = mergeMessagesById(currentMessages, hydratedMessages);

    if (Object.keys(paginationPatch).length > 0) {
      setPaginationState(normalizedChatId, paginationPatch);
    }

    return getMessageFromState(normalizedChatId, String(normalizedMessageId)) ?? null;
  }

  async function ensureMessageLoadedByEventId(
    chatId: string,
    eventId: string
  ): Promise<Message | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedChatId || !normalizedEventId) {
      return null;
    }

    const existingMessage =
      messagesByChat.value[normalizedChatId]?.find((message) => {
        return normalizeEventId(message.eventId) === normalizedEventId;
      }) ?? null;
    if (existingMessage) {
      return existingMessage;
    }

    if (!loadedChatIds.has(normalizedChatId)) {
      await loadMessages(normalizedChatId);
    }

    const loadedMessage =
      messagesByChat.value[normalizedChatId]?.find((message) => {
        return normalizeEventId(message.eventId) === normalizedEventId;
      }) ?? null;
    if (loadedMessage) {
      return loadedMessage;
    }

    await chatDataService.init();
    const targetRow = await chatDataService.getMessageByEventIdOrEditReference(normalizedEventId);
    if (!targetRow || normalizeChatIdentifier(targetRow.chat_public_key) !== normalizedChatId) {
      return null;
    }

    return ensureMessageLoaded(normalizedChatId, String(targetRow.id));
  }

  async function loadOlderMessages(chatId: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    if (!loadedChatIds.has(normalizedChatId)) {
      await loadMessages(normalizedChatId);
    }

    const paginationState = paginationStateByChat.value[normalizedChatId];
    if (!paginationState?.hasOlder || !paginationState.oldestCursor) {
      return;
    }

    const loadKey = `${normalizedChatId}:older`;
    const existingLoad = paginationLoadPromises.get(loadKey);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    setPaginationState(normalizedChatId, { isLoadingOlder: true });
    const loadPromise = (async () => {
      try {
        const initialBatch = await chatDataService.listMessagesBefore(
          normalizedChatId,
          paginationState.oldestCursor as PersistedMessageCursor,
          MESSAGE_PAGE_SIZE
        );
        const batch = await extendOlderEdgeRows(
          normalizedChatId,
          initialBatch.rows,
          initialBatch.has_more
        );
        if (batch.rows.length === 0) {
          setPaginationState(normalizedChatId, { hasOlder: false });
          return;
        }

        const hydratedMessages = await hydrateMessageRows(batch.rows, normalizedChatId);
        messagesByChat.value[normalizedChatId] = mergeMessagesById(
          messagesByChat.value[normalizedChatId] ?? [],
          hydratedMessages
        );
        setPaginationState(normalizedChatId, {
          oldestCursor: buildMessageCursorFromRow(batch.rows[0] ?? null),
          hasOlder: batch.hasMore,
        });
      } finally {
        setPaginationState(normalizedChatId, { isLoadingOlder: false });
      }
    })();

    paginationLoadPromises.set(loadKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      paginationLoadPromises.delete(loadKey);
    }
  }

  async function loadNewerMessages(chatId: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    if (!loadedChatIds.has(normalizedChatId)) {
      await loadMessages(normalizedChatId);
    }

    const paginationState = paginationStateByChat.value[normalizedChatId];
    if (!paginationState?.hasNewer || !paginationState.newestCursor) {
      return;
    }

    const loadKey = `${normalizedChatId}:newer`;
    const existingLoad = paginationLoadPromises.get(loadKey);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    setPaginationState(normalizedChatId, { isLoadingNewer: true });
    const loadPromise = (async () => {
      try {
        const initialBatch = await chatDataService.listMessagesAfter(
          normalizedChatId,
          paginationState.newestCursor as PersistedMessageCursor,
          MESSAGE_PAGE_SIZE
        );
        const batch = await extendNewerEdgeRows(
          normalizedChatId,
          initialBatch.rows,
          initialBatch.has_more
        );
        if (batch.rows.length === 0) {
          setPaginationState(normalizedChatId, { hasNewer: false });
          return;
        }

        const hydratedMessages = await hydrateMessageRows(batch.rows, normalizedChatId);
        messagesByChat.value[normalizedChatId] = mergeMessagesById(
          messagesByChat.value[normalizedChatId] ?? [],
          hydratedMessages
        );
        setPaginationState(normalizedChatId, {
          newestCursor: buildMessageCursorFromRow(batch.rows[batch.rows.length - 1] ?? null),
          hasNewer: batch.hasMore,
        });
      } finally {
        setPaginationState(normalizedChatId, { isLoadingNewer: false });
      }
    })();

    paginationLoadPromises.set(loadKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      paginationLoadPromises.delete(loadKey);
    }
  }

  async function sendMessage(
    chatId: string,
    text: string,
    replyTo: MessageReplyPreview | null = null,
    options: RelaySendOptions = {}
  ): Promise<Message | null> {
    const cleanText = text.trim();

    if (!cleanText) {
      return null;
    }

    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return null;
    }

    await chatDataService.init();
    const chat = await chatDataService.getChatByPublicKey(normalizedChatId);
    if (!chat) {
      return null;
    }

    const recipientPublicKey = resolveChatRecipientPublicKeyFromRow(chat);
    if (!recipientPublicKey) {
      throw new Error('Group chat is missing the current epoch public key.');
    }

    const recipientRelayUrls = await resolveSendRelayUrls(chat.public_key, options.relayUrls);

    const replyTargetEventId = await resolveReplyTargetEventId(replyTo);
    const replyPreview = replyTo
      ? {
          ...replyTo,
          eventId: replyTargetEventId ?? replyTo.eventId,
        }
      : null;
    const createdAt = typeof options.createdAt === 'string' ? options.createdAt.trim() : '';
    const mentionMeta = buildMentionMetadata(cleanText, getLoggedInPublicKey());
    const meta = {
      ...mentionMeta,
      ...(replyPreview ? { reply: replyPreview } : {}),
    };

    const created = await chatDataService.createMessage({
      chat_public_key: chat.public_key,
      author_public_key: window.localStorage.getItem('npub'),
      message: cleanText,
      created_at: createdAt || new Date().toISOString(),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    if (!created) {
      return null;
    }

    const newMessage = mapMessageRowToMessage(created, normalizedChatId);

    loadedChatIds.add(normalizedChatId);
    upsertMessageInState(normalizedChatId, newMessage, {
      allowOutsideLoadedWindow: true,
    });
    let sendError: unknown = null;

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.sendDirectMessage(recipientPublicKey, newMessage.text, recipientRelayUrls, {
        localMessageId: created.id,
        createdAt: created.created_at,
        replyToEventId: replyTargetEventId,
        publishSelfCopy: shouldPublishSelfCopyForChatRow(chat),
      });
    } catch (error) {
      sendError = error;
    }

    const updatedMessageRow = await chatDataService.getMessageById(created.id);
    const finalMessage = updatedMessageRow
      ? await hydrateMessageRow(updatedMessageRow, normalizedChatId)
      : newMessage;
    replaceMessageInState(normalizedChatId, finalMessage);

    if (sendError) {
      throw sendError;
    }

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.ensureRespondedPubkeyIsContact(chat.public_key, chat.name);
    } catch (error) {
      console.warn('Failed to add responded pubkey to contacts', chat.public_key, error);
    }

    return finalMessage;
  }

  async function editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options: RelaySendOptions = {}
  ): Promise<Message | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    const cleanText = text.trim();
    const loggedInPublicKey = getLoggedInPublicKey();
    if (
      !normalizedChatId ||
      !Number.isInteger(normalizedMessageId) ||
      normalizedMessageId <= 0 ||
      !cleanText ||
      !loggedInPublicKey
    ) {
      return null;
    }

    await chatDataService.init();
    const existingRow = await chatDataService.getMessageById(normalizedMessageId);
    if (
      !existingRow ||
      normalizeChatIdentifier(existingRow.chat_public_key) !== normalizedChatId ||
      normalizeChatIdentifier(existingRow.author_public_key) !== loggedInPublicKey ||
      existingRow.meta.deleted ||
      (Array.isArray(existingRow.meta.attachments) && existingRow.meta.attachments.length > 0) ||
      !existingRow.event_id ||
      cleanText === existingRow.message.trim()
    ) {
      return existingRow ? hydrateMessageRow(existingRow, normalizedChatId) : null;
    }

    const targetKind = Number.isInteger(existingRow.meta.kind) ? Number(existingRow.meta.kind) : 14;
    if (targetKind !== 14) {
      return hydrateMessageRow(existingRow, normalizedChatId);
    }

    const deliveryTarget = await resolveChatDeliveryTarget(
      existingRow.chat_public_key,
      options.relayUrls
    );
    if (!deliveryTarget) {
      return null;
    }

    const previousEventId = existingRow.event_id;
    const editedAt = new Date().toISOString();
    const editTag = buildMessageEditTag(previousEventId);
    if (!editTag) {
      return hydrateMessageRow(existingRow, normalizedChatId);
    }

    const replyMeta =
      existingRow.meta.reply &&
      typeof existingRow.meta.reply === 'object' &&
      !Array.isArray(existingRow.meta.reply)
        ? (existingRow.meta.reply as Record<string, unknown>)
        : null;
    const replyTargetEventId = normalizeEventId(replyMeta?.eventId);
    const nostrStore = await getNostrStore();
    const deletionEvent = await nostrStore.sendDirectMessageDeletion(
      deliveryTarget.recipientPublicKey,
      previousEventId,
      targetKind,
      deliveryTarget.relayUrls,
      {
        createdAt: editedAt,
        publishSelfCopy: deliveryTarget.publishSelfCopy,
      }
    );

    let sendError: unknown = null;
    try {
      await nostrStore.sendDirectMessage(
        deliveryTarget.recipientPublicKey,
        cleanText,
        deliveryTarget.relayUrls,
        {
          localMessageId: existingRow.id,
          createdAt: existingRow.created_at,
          replyToEventId: replyTargetEventId,
          additionalTags: [editTag],
          publishSelfCopy: deliveryTarget.publishSelfCopy,
        }
      );
    } catch (error) {
      sendError = error;
    }

    const replacementBoundRow =
      (await chatDataService.getMessageById(existingRow.id)) ?? existingRow;
    const replacementEventId = normalizeEventId(replacementBoundRow.event_id);
    if (!replacementEventId || replacementEventId === normalizeEventId(previousEventId)) {
      const deletedRow = await chatDataService.updateMessageMeta(existingRow.id, {
        ...existingRow.meta,
        deleted: buildDeletedMessageMeta(
          loggedInPublicKey,
          targetKind,
          editedAt,
          deletionEvent?.id ?? null
        ),
      });
      if (deletedRow) {
        replaceMessageInState(
          normalizedChatId,
          await hydrateMessageRow(deletedRow, normalizedChatId)
        );
      }
      if (sendError) {
        throw sendError;
      }
      return deletedRow ? hydrateMessageRow(deletedRow, normalizedChatId) : null;
    }

    const replacementMeta = { ...existingRow.meta };
    delete replacementMeta.mentions;
    delete replacementMeta.mentions_me;
    Object.assign(replacementMeta, buildMentionMetadata(cleanText, loggedInPublicKey));
    const updatedRow = await chatDataService.applyMessageEdit(existingRow.id, {
      message: cleanText,
      created_at: existingRow.created_at,
      event_id: replacementEventId,
      previous_event_id: previousEventId,
      edited_at: editedAt,
      meta: replacementMeta,
    });
    if (!updatedRow) {
      if (sendError) {
        throw sendError;
      }
      return null;
    }

    const updatedMessage = await hydrateMessageRow(updatedRow, normalizedChatId);
    replaceMessageInState(normalizedChatId, updatedMessage);
    if (sendError) {
      throw sendError;
    }

    return updatedMessage;
  }

  async function sendMediaAttachment(
    chatId: string,
    attachment: MessageAttachmentMetadata,
    replyTo: MessageReplyPreview | null = null,
    options: RelaySendOptions = {}
  ): Promise<Message | null> {
    const messageText = buildAttachmentMessageText(attachment);
    const attachmentMeta = buildAttachmentMessageMeta(attachment);
    const imetaTag = buildNip92ImetaTag(attachment);

    if (!messageText || imetaTag.length === 0 || !('attachments' in attachmentMeta)) {
      return null;
    }

    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return null;
    }

    await chatDataService.init();
    const chat = await chatDataService.getChatByPublicKey(normalizedChatId);
    if (!chat) {
      return null;
    }

    const recipientPublicKey = resolveChatRecipientPublicKeyFromRow(chat);
    if (!recipientPublicKey) {
      throw new Error('Group chat is missing the current epoch public key.');
    }

    const recipientRelayUrls = await resolveSendRelayUrls(chat.public_key, options.relayUrls);

    const replyTargetEventId = await resolveReplyTargetEventId(replyTo);
    const replyPreview = replyTo
      ? {
          ...replyTo,
          eventId: replyTargetEventId ?? replyTo.eventId,
        }
      : null;
    const createdAt = typeof options.createdAt === 'string' ? options.createdAt.trim() : '';
    const meta = {
      ...attachmentMeta,
      ...(replyPreview ? { reply: replyPreview } : {}),
    };

    const created = await chatDataService.createMessage({
      chat_public_key: chat.public_key,
      author_public_key: window.localStorage.getItem('npub'),
      message: messageText,
      created_at: createdAt || new Date().toISOString(),
      meta,
    });
    if (!created) {
      return null;
    }

    const newMessage = mapMessageRowToMessage(created, normalizedChatId);

    loadedChatIds.add(normalizedChatId);
    upsertMessageInState(normalizedChatId, newMessage, {
      allowOutsideLoadedWindow: true,
    });
    let sendError: unknown = null;

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.sendDirectMessage(recipientPublicKey, newMessage.text, recipientRelayUrls, {
        localMessageId: created.id,
        createdAt: created.created_at,
        replyToEventId: replyTargetEventId,
        publishSelfCopy: shouldPublishSelfCopyForChatRow(chat),
        additionalTags: [imetaTag],
      });
    } catch (error) {
      sendError = error;
    }

    const updatedMessageRow = await chatDataService.getMessageById(created.id);
    const finalMessage = updatedMessageRow
      ? await hydrateMessageRow(updatedMessageRow, normalizedChatId)
      : newMessage;
    replaceMessageInState(normalizedChatId, finalMessage);

    if (sendError) {
      throw sendError;
    }

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.ensureRespondedPubkeyIsContact(chat.public_key, chat.name);
    } catch (error) {
      console.warn('Failed to add responded pubkey to contacts', chat.public_key, error);
    }

    return finalMessage;
  }

  async function forwardMessage(
    chatId: string,
    message: Pick<Message, 'text' | 'meta'>,
    options: RelaySendOptions = {}
  ): Promise<Message | null> {
    const forwardedPayload = buildForwardedMessagePayload(message);
    if (!forwardedPayload) {
      return null;
    }

    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return null;
    }

    await chatDataService.init();
    const chat = await chatDataService.getChatByPublicKey(normalizedChatId);
    if (!chat) {
      return null;
    }

    const recipientPublicKey = resolveChatRecipientPublicKeyFromRow(chat);
    if (!recipientPublicKey) {
      throw new Error('Group chat is missing the current epoch public key.');
    }

    const recipientRelayUrls = await resolveSendRelayUrls(chat.public_key, options.relayUrls);
    const createdAt = typeof options.createdAt === 'string' ? options.createdAt.trim() : '';

    const created = await chatDataService.createMessage({
      chat_public_key: chat.public_key,
      author_public_key: window.localStorage.getItem('npub'),
      message: forwardedPayload.text,
      created_at: createdAt || new Date().toISOString(),
      ...(Object.keys(forwardedPayload.meta).length > 0 ? { meta: forwardedPayload.meta } : {}),
    });
    if (!created) {
      return null;
    }

    const newMessage = mapMessageRowToMessage(created, normalizedChatId);
    const shouldSyncLiveMessage =
      loadedChatIds.has(normalizedChatId) ||
      chatStore.selectedChatId === normalizedChatId ||
      chatStore.visibleChatId === normalizedChatId;

    if (shouldSyncLiveMessage) {
      loadedChatIds.add(normalizedChatId);
      upsertMessageInState(normalizedChatId, newMessage, {
        allowOutsideLoadedWindow: true,
      });
    }
    let sendError: unknown = null;

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.sendDirectMessage(recipientPublicKey, newMessage.text, recipientRelayUrls, {
        localMessageId: created.id,
        createdAt: created.created_at,
        publishSelfCopy: shouldPublishSelfCopyForChatRow(chat),
        ...(forwardedPayload.additionalTags.length > 0
          ? { additionalTags: forwardedPayload.additionalTags }
          : {}),
      });
    } catch (error) {
      sendError = error;
    }

    const updatedMessageRow = await chatDataService.getMessageById(created.id);
    const finalMessage = updatedMessageRow
      ? await hydrateMessageRow(updatedMessageRow, normalizedChatId)
      : newMessage;
    if (shouldSyncLiveMessage) {
      replaceMessageInState(normalizedChatId, finalMessage);
    }

    if (sendError) {
      throw sendError;
    }

    try {
      const nostrStore = await getNostrStore();
      await nostrStore.ensureRespondedPubkeyIsContact(chat.public_key, chat.name);
    } catch (error) {
      console.warn('Failed to add responded pubkey to contacts', chat.public_key, error);
    }

    return finalMessage;
  }

  async function updateMessageReactions(
    chatId: string,
    messageId: string,
    transform: (reactions: MessageReaction[], loggedInPublicKey: string) => MessageReaction[]
  ): Promise<Message | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    const loggedInPublicKey = getLoggedInPublicKey();

    if (!normalizedChatId || !Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    if (!loggedInPublicKey) {
      return null;
    }

    await chatDataService.init();
    const existingRow = await chatDataService.getMessageById(normalizedMessageId);
    if (!existingRow) {
      return null;
    }

    const currentReactions = normalizeMessageReactions(existingRow.meta.reactions);
    const nextReactions = transform(currentReactions, loggedInPublicKey);
    if (areReactionListsEqual(currentReactions, nextReactions)) {
      return getMessageFromState(normalizedChatId, String(normalizedMessageId));
    }

    const updatedRow = await chatDataService.updateMessageMeta(
      normalizedMessageId,
      buildMetaWithReactions(existingRow.meta, nextReactions)
    );
    if (!updatedRow) {
      return null;
    }

    const updatedMessage = await hydrateMessageRow(updatedRow, normalizedChatId);
    replaceMessageInState(normalizedChatId, updatedMessage);
    await syncChatUnseenReactionCount(normalizedChatId);
    return updatedMessage;
  }

  async function addReaction(
    chatId: string,
    messageId: string,
    emoji: string,
    options: RelaySendOptions = {}
  ): Promise<Message | null> {
    const normalizedEmoji = emoji.trim();
    if (!normalizedEmoji) {
      return null;
    }

    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    const loggedInPublicKey = getLoggedInPublicKey();
    if (!normalizedChatId || !Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    if (!loggedInPublicKey) {
      return null;
    }

    await chatDataService.init();
    const existingRow = await chatDataService.getMessageById(normalizedMessageId);
    if (!existingRow) {
      return null;
    }

    const currentReactions = normalizeMessageReactions(existingRow.meta.reactions);
    const alreadyExists = currentReactions.some((reaction) => {
      return (
        reaction.emoji === normalizedEmoji &&
        normalizeChatIdentifier(reaction.reactorPublicKey) === loggedInPublicKey
      );
    });
    if (alreadyExists) {
      return getMessageFromState(normalizedChatId, String(normalizedMessageId));
    }

    let reactionRecipientPublicKey: string | null = null;
    let reactionRelayUrls: string[] = [];
    let shouldPublishReactionSelfCopy = true;
    if (existingRow.event_id) {
      const deliveryTarget = await resolveChatDeliveryTarget(
        existingRow.chat_public_key,
        options.relayUrls
      );
      if (deliveryTarget) {
        reactionRecipientPublicKey = deliveryTarget.recipientPublicKey;
        reactionRelayUrls = deliveryTarget.relayUrls;
        shouldPublishReactionSelfCopy = deliveryTarget.publishSelfCopy;
      }
    }

    const updatedMessage = await updateMessageReactions(
      normalizedChatId,
      String(normalizedMessageId),
      (reactions) => {
        const emojiEntry = getEmojiEntryByValue(normalizedEmoji);
        const isOwnMessage =
          normalizeChatIdentifier(existingRow.author_public_key) === loggedInPublicKey;
        const createdAt = new Date().toISOString();
        return [
          ...reactions,
          {
            emoji: normalizedEmoji,
            name: emojiEntry?.label ?? normalizedEmoji,
            reactorPublicKey: loggedInPublicKey,
            eventId: null,
            createdAt,
            ...(isOwnMessage ? { viewedByAuthorAt: createdAt } : {}),
          },
        ];
      }
    );

    if (!updatedMessage || !existingRow.event_id) {
      return updatedMessage;
    }

    if (!reactionRecipientPublicKey || reactionRelayUrls.length === 0) {
      return updatedMessage;
    }

    const createdAt = new Date().toISOString();
    const nostrStore = await getNostrStore();

    const publishedReactionEvent = await nostrStore.sendDirectMessageReaction(
      reactionRecipientPublicKey,
      normalizedEmoji,
      existingRow.event_id,
      existingRow.author_public_key,
      reactionRelayUrls,
      {
        createdAt,
        targetKind: updatedMessage.nostrEvent?.event.kind,
        publishSelfCopy: shouldPublishReactionSelfCopy,
      }
    );

    const publishedReactionEventId = normalizeEventId(publishedReactionEvent?.id);
    if (!publishedReactionEventId) {
      return updatedMessage;
    }

    return updateMessageReactions(
      normalizedChatId,
      String(normalizedMessageId),
      (reactions, currentLoggedInPublicKey) => {
        return reactions.map((reaction) => {
          const isMatchingReaction =
            reaction.emoji === normalizedEmoji &&
            normalizeChatIdentifier(reaction.reactorPublicKey) === currentLoggedInPublicKey &&
            !normalizeEventId(reaction.eventId);
          if (!isMatchingReaction) {
            return reaction;
          }

          return {
            ...reaction,
            eventId: publishedReactionEventId,
          };
        });
      }
    );
  }

  async function removeReaction(
    chatId: string,
    messageId: string,
    reactionToRemove: MessageReaction
  ): Promise<Message | null> {
    const loggedInPublicKey = getLoggedInPublicKey();
    if (
      !loggedInPublicKey ||
      normalizeChatIdentifier(reactionToRemove.reactorPublicKey) !== loggedInPublicKey
    ) {
      return getMessageFromState(chatId, messageId);
    }

    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    if (!normalizedChatId || !Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    await chatDataService.init();
    const existingRow = await chatDataService.getMessageById(normalizedMessageId);
    if (!existingRow) {
      return null;
    }

    const reactionEventId = normalizeEventId(reactionToRemove.eventId);
    let reactionDeletionRecipientPublicKey: string | null = null;
    let reactionDeletionRelayUrls: string[] = [];
    let shouldPublishReactionDeletionSelfCopy = true;
    if (reactionEventId) {
      const deliveryTarget = await resolveChatDeliveryTarget(
        existingRow.chat_public_key,
        undefined
      );
      if (deliveryTarget) {
        reactionDeletionRecipientPublicKey = deliveryTarget.recipientPublicKey;
        reactionDeletionRelayUrls = deliveryTarget.relayUrls;
        shouldPublishReactionDeletionSelfCopy = deliveryTarget.publishSelfCopy;
      }
    }

    const updatedMessage = await updateMessageReactions(chatId, messageId, (reactions) => {
      return reactions.filter((reaction) => {
        return !(
          reaction.emoji === reactionToRemove.emoji &&
          reaction.name === reactionToRemove.name &&
          normalizeChatIdentifier(reaction.reactorPublicKey) ===
            normalizeChatIdentifier(reactionToRemove.reactorPublicKey)
        );
      });
    });
    if (!updatedMessage) {
      return null;
    }

    if (!reactionEventId) {
      return updatedMessage;
    }

    if (!reactionDeletionRecipientPublicKey || reactionDeletionRelayUrls.length === 0) {
      return updatedMessage;
    }

    const nostrStore = await getNostrStore();
    await nostrStore.sendDirectMessageDeletion(
      reactionDeletionRecipientPublicKey,
      reactionEventId,
      7,
      reactionDeletionRelayUrls,
      {
        createdAt: new Date().toISOString(),
        publishSelfCopy: shouldPublishReactionDeletionSelfCopy,
      }
    );
    await nostrEventDataService.deleteEventsByIds([reactionEventId]);

    return updatedMessage;
  }

  async function deleteMessage(chatId: string, messageId: string): Promise<Message | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedMessageId = Number.parseInt(messageId, 10);
    const loggedInPublicKey = getLoggedInPublicKey();
    if (!normalizedChatId || !Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    if (!loggedInPublicKey) {
      return null;
    }

    await chatDataService.init();
    const existingRow = await chatDataService.getMessageById(normalizedMessageId);
    if (!existingRow) {
      return null;
    }

    if (normalizeChatIdentifier(existingRow.author_public_key) !== loggedInPublicKey) {
      return getMessageFromState(normalizedChatId, String(normalizedMessageId));
    }

    if (!existingRow.event_id) {
      return getMessageFromState(normalizedChatId, String(normalizedMessageId));
    }

    const targetKind = Number.isInteger(existingRow.meta.kind) ? Number(existingRow.meta.kind) : 14;
    let deletionRecipientPublicKey: string | null = null;
    let deletionRelayUrls: string[] = [];
    let shouldPublishDeletionSelfCopy = true;
    const deliveryTarget = await resolveChatDeliveryTarget(existingRow.chat_public_key, undefined);
    if (deliveryTarget) {
      deletionRecipientPublicKey = deliveryTarget.recipientPublicKey;
      deletionRelayUrls = deliveryTarget.relayUrls;
      shouldPublishDeletionSelfCopy = deliveryTarget.publishSelfCopy;
    }

    const updatedRow = await chatDataService.updateMessageMeta(normalizedMessageId, {
      ...existingRow.meta,
      deleted: buildDeletedMessageMeta(loggedInPublicKey, targetKind, new Date().toISOString()),
    });
    if (!updatedRow) {
      return null;
    }

    const updatedMessage = await hydrateMessageRow(updatedRow, normalizedChatId);
    replaceMessageInState(normalizedChatId, updatedMessage);

    if (!deletionRecipientPublicKey || deletionRelayUrls.length === 0) {
      return updatedMessage;
    }

    const nostrStore = await getNostrStore();
    const deleteEvent = await nostrStore.sendDirectMessageDeletion(
      deletionRecipientPublicKey,
      existingRow.event_id,
      targetKind,
      deletionRelayUrls,
      {
        createdAt: new Date().toISOString(),
        publishSelfCopy: shouldPublishDeletionSelfCopy,
      }
    );
    const deleteEventId = normalizeEventId(deleteEvent?.id);
    if (!deleteEventId) {
      return updatedMessage;
    }

    const rowWithDeleteEvent = await chatDataService.updateMessageMeta(normalizedMessageId, {
      ...updatedRow.meta,
      deleted: buildDeletedMessageMeta(
        loggedInPublicKey,
        targetKind,
        (updatedRow.meta.deleted as DeletedMessageMetadata | undefined)?.deletedAt ??
          new Date().toISOString(),
        deleteEventId
      ),
    });
    if (!rowWithDeleteEvent) {
      return updatedMessage;
    }

    const finalMessage = await hydrateMessageRow(rowWithDeleteEvent, normalizedChatId);
    replaceMessageInState(normalizedChatId, finalMessage);
    return finalMessage;
  }

  async function markMessagesReactionsViewed(chatId: string, messageIds: string[]): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const loggedInPublicKey = getLoggedInPublicKey();
    const normalizedMessageIds = Array.from(
      new Set(
        messageIds
          .map((messageId) => Number.parseInt(messageId, 10))
          .filter((messageId) => Number.isInteger(messageId) && messageId > 0)
      )
    );

    if (!normalizedChatId || !loggedInPublicKey || normalizedMessageIds.length === 0) {
      return;
    }

    await chatDataService.init();

    const viewedAt = new Date().toISOString();
    let didChange = false;
    let latestViewedIncomingReactionAt: string | null = null;

    for (const messageId of normalizedMessageIds) {
      const existingRow = await chatDataService.getMessageById(messageId);
      if (
        !existingRow ||
        normalizeChatIdentifier(existingRow.chat_public_key) !== normalizedChatId
      ) {
        continue;
      }

      if (normalizeChatIdentifier(existingRow.author_public_key) !== loggedInPublicKey) {
        continue;
      }

      const currentReactions = normalizeMessageReactions(existingRow.meta.reactions);
      if (countUnseenReactionsForAuthor(currentReactions, loggedInPublicKey) === 0) {
        continue;
      }

      const nextReactions = markReactionsViewedByAuthor(
        currentReactions,
        loggedInPublicKey,
        viewedAt
      );
      if (areReactionListsEqual(currentReactions, nextReactions)) {
        continue;
      }

      const updatedRow = await chatDataService.updateMessageMeta(
        messageId,
        buildMetaWithReactions(existingRow.meta, nextReactions)
      );
      if (!updatedRow) {
        continue;
      }

      didChange = true;
      nextReactions.forEach((reaction) => {
        const reactionCreatedAt = normalizeTimestamp(reaction.createdAt);
        if (
          reaction.viewedByAuthorAt !== viewedAt ||
          normalizeChatIdentifier(reaction.reactorPublicKey) === loggedInPublicKey ||
          !reactionCreatedAt
        ) {
          return;
        }

        if (
          !latestViewedIncomingReactionAt ||
          toComparableTimestamp(reactionCreatedAt) >
            toComparableTimestamp(latestViewedIncomingReactionAt)
        ) {
          latestViewedIncomingReactionAt = reactionCreatedAt;
        }
      });
      await upsertPersistedMessage(updatedRow);
    }

    if (didChange) {
      if (latestViewedIncomingReactionAt) {
        await chatStore.setLastSeenReceivedActivityAt(
          normalizedChatId,
          latestViewedIncomingReactionAt
        );
      }
      await syncChatUnseenReactionCount(normalizedChatId);
    }
  }

  async function syncChatsReadStateFromSeenBoundary(chatIds: string[] = []): Promise<{
    chatCount: number;
    boundaryAdvancedCount: number;
    unreadCountAdjustedCount: number;
    reactionMessageCount: number;
    reactionsMarkedCount: number;
  }> {
    const normalizedChatIds = Array.from(
      new Set(
        chatIds
          .map((chatId) => normalizeChatIdentifier(chatId))
          .filter((chatId): chatId is string => Boolean(chatId))
      )
    );
    const targetChatIds = normalizedChatIds.length > 0 ? new Set(normalizedChatIds) : null;
    const loggedInPublicKey = getLoggedInPublicKey();
    const summary = {
      chatCount: 0,
      boundaryAdvancedCount: 0,
      unreadCountAdjustedCount: 0,
      reactionMessageCount: 0,
      reactionsMarkedCount: 0,
    };

    await Promise.all([chatDataService.init(), contactsService.init()]);

    const [chatRows, messageRows, contacts] = await Promise.all([
      chatDataService.listChats(),
      chatDataService.listAllMessages(),
      contactsService.listContacts(),
    ]);
    const messageRowsByChat = new Map<string, MessageRow[]>();
    const seenBoundaryByChat = new Map<string, string>();

    for (const contact of contacts) {
      const normalizedChatId = normalizeChatIdentifier(contact.public_key);
      if (!normalizedChatId || (targetChatIds && !targetChatIds.has(normalizedChatId))) {
        continue;
      }

      const contactMeta =
        contact.meta && typeof contact.meta === 'object' && !Array.isArray(contact.meta)
          ? (contact.meta as Record<string, unknown>)
          : {};
      const seenBoundaryAt = readMetaString(contactMeta, 'last_seen_incoming_activity_at');
      if (toComparableTimestamp(seenBoundaryAt) <= 0) {
        continue;
      }

      seenBoundaryByChat.set(normalizedChatId, seenBoundaryAt);
    }

    for (const row of messageRows) {
      const normalizedChatId = normalizeChatIdentifier(row.chat_public_key);
      if (!normalizedChatId || (targetChatIds && !targetChatIds.has(normalizedChatId))) {
        continue;
      }

      const chatMessageRows = messageRowsByChat.get(normalizedChatId) ?? [];
      chatMessageRows.push(row);
      messageRowsByChat.set(normalizedChatId, chatMessageRows);
    }

    for (const chatRow of chatRows) {
      const normalizedChatId = normalizeChatIdentifier(chatRow.public_key);
      if (!normalizedChatId || (targetChatIds && !targetChatIds.has(normalizedChatId))) {
        continue;
      }

      summary.chatCount += 1;

      const currentLastSeenReceivedActivityAt = readMetaString(
        chatRow.meta,
        'last_seen_received_activity_at'
      );
      const contactLastSeenIncomingActivityAt = seenBoundaryByChat.get(normalizedChatId) ?? '';
      const chatMessageRows = messageRowsByChat.get(normalizedChatId) ?? [];
      const boundaryAt = resolveLatestReadBoundaryAtValue(
        currentLastSeenReceivedActivityAt,
        contactLastSeenIncomingActivityAt,
        resolveLatestOwnMessageAt(chatMessageRows, loggedInPublicKey)
      );
      const boundaryTimestamp = toComparableTimestamp(boundaryAt);

      if (
        boundaryTimestamp > 0 &&
        boundaryTimestamp > toComparableTimestamp(currentLastSeenReceivedActivityAt)
      ) {
        await chatDataService.updateChatMeta(normalizedChatId, {
          ...chatRow.meta,
          last_seen_received_activity_at: boundaryAt,
        });
        summary.boundaryAdvancedCount += 1;
      }

      const nextUnreadCount = countUnreadMessageRowsAfterBoundary(
        chatMessageRows,
        loggedInPublicKey,
        boundaryAt
      );

      if (Number(chatRow.unread_count ?? 0) !== nextUnreadCount) {
        await chatDataService.updateChatUnreadCount(normalizedChatId, nextUnreadCount);
        summary.unreadCountAdjustedCount += 1;
      }

      if (!loggedInPublicKey) {
        continue;
      }

      if (boundaryTimestamp <= 0) {
        continue;
      }

      for (const row of chatMessageRows) {
        if (normalizeChatIdentifier(row.author_public_key) !== loggedInPublicKey) {
          continue;
        }

        const currentReactions = normalizeMessageReactions(row.meta.reactions);
        let markedReactionCount = 0;
        const nextReactions = currentReactions.map((reaction) => {
          const reactionCreatedAt = normalizeTimestamp(reaction.createdAt);
          if (
            !reactionCreatedAt ||
            reaction.viewedByAuthorAt ||
            normalizeChatIdentifier(reaction.reactorPublicKey) === loggedInPublicKey ||
            toComparableTimestamp(reactionCreatedAt) > boundaryTimestamp
          ) {
            return reaction;
          }

          markedReactionCount += 1;
          return {
            ...reaction,
            viewedByAuthorAt: boundaryAt,
          };
        });

        if (markedReactionCount === 0) {
          continue;
        }

        const updatedRow = await chatDataService.updateMessageMeta(
          row.id,
          buildMetaWithReactions(row.meta, nextReactions)
        );
        if (!updatedRow) {
          continue;
        }

        summary.reactionMessageCount += 1;
        summary.reactionsMarkedCount += markedReactionCount;
        await upsertPersistedMessage(updatedRow);
      }
    }

    return summary;
  }

  async function markMessageReactionsViewed(chatId: string, messageId: string): Promise<void> {
    await markMessagesReactionsViewed(chatId, [messageId]);
  }

  function removeChatMessages(chatId: string): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    delete messagesByChat.value[normalizedChatId];
    delete paginationStateByChat.value[normalizedChatId];
    loadedChatIds.delete(normalizedChatId);
    loadingChatPromises.delete(normalizedChatId);
    paginationLoadPromises.delete(`${normalizedChatId}:older`);
    paginationLoadPromises.delete(`${normalizedChatId}:newer`);
  }

  void init().catch((error) => {
    console.error('Failed to preload message store', error);
  });

  return {
    messagesByChat,
    paginationStateByChat,
    init,
    loadMessages,
    loadOlderMessages,
    loadNewerMessages,
    reloadLoadedMessages,
    searchMessages,
    ensureMessageLoaded,
    ensureMessageLoadedByEventId,
    getMessages,
    getPaginationState,
    sendMessage,
    editMessage,
    sendMediaAttachment,
    forwardMessage,
    addReaction,
    removeReaction,
    deleteMessage,
    markMessageReactionsViewed,
    markMessagesReactionsViewed,
    syncChatsReadStateFromSeenBoundary,
    syncChatUnseenReactionCount,
    removeChatMessages,
    upsertPersistedMessage,
    refreshPersistedMessage,
  };
});
