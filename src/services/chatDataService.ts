import { mergeGroupEpochMetadata } from '#src/utils/groupEpochMetadata.ts';
import type { ChatType } from '#src/types/chat.ts';
import { closeIndexedDbConnection, deleteIndexedDbDatabase } from '#src/utils/indexedDbStorage.ts';
import { isIncomingUnreadMessageActivity } from '#src/utils/messageActivity.ts';
import {
  areMessageEditTimestampsEqual,
  buildEditedMessageMeta,
  messageEditReferencesEventId,
} from '#src/utils/messageEdits.ts';
import {
  isDeletedMessageMeta,
  messageRecordMatchesSearchQuery,
  normalizeMessageSearchText,
  searchMessageRecords,
} from '#src/utils/messageSearch.ts';

export interface ChatRow {
  id: string;
  public_key: string;
  type: ChatType;
  name: string;
  last_message: string;
  last_message_at: string | null;
  unread_count: number;
  meta: Record<string, unknown>;
}

export interface MessageRow {
  id: number;
  chat_public_key: string;
  author_public_key: string;
  message: string;
  created_at: string;
  event_id: string | null;
  meta: Record<string, unknown>;
}

export interface MessageCursor {
  id: number;
  created_at: string;
}

export interface MessageBatchResult {
  rows: MessageRow[];
  has_more: boolean;
}

export interface MessageSearchResult {
  id: number;
  chat_public_key: string;
  message: string;
  created_at: string;
  event_id: string | null;
}

export interface CreateChatInput {
  public_key: string;
  type?: ChatType;
  name: string;
  last_message?: string;
  last_message_at?: string | null;
  unread_count?: number;
  meta?: Record<string, unknown>;
}

export interface UpdateChatInput {
  type?: ChatType;
  name?: string;
  meta?: Record<string, unknown>;
}

export interface ClearChatMessagesInput {
  last_message?: string;
  last_message_at?: string | null;
  unread_count?: number;
  meta?: Record<string, unknown>;
}

export interface CreateMessageInput {
  // Incoming-message summary commits atomically with the row. Kept out of the
  // stored message metadata; sender keys and unrelated chat metadata are untouched.
  chat_activity?: {
    incomingAt: string;
    unreadCount: number;
    preview?: { text: string; at: string };
  };
  chat_public_key: string;
  author_public_key: string;
  message: string;
  created_at?: string;
  event_id?: string | null;
  meta?: Record<string, unknown>;
}

export interface ApplyMessageEditInput {
  message: string;
  created_at: string;
  event_id: string;
  previous_event_id: string;
  edited_at: string;
  meta?: Record<string, unknown>;
}

interface ChatRecord {
  public_key: string;
  type: ChatType;
  name: string;
  last_message: string;
  last_message_at: string | null;
  unread_count: number;
  meta: Record<string, unknown>;
}

interface MessageRecord {
  id: number;
  chat_public_key: string;
  author_public_key: string;
  message: string;
  created_at: string;
  event_id?: string;
  meta: Record<string, unknown>;
}

const CHAT_DATA_DB_NAME = 'chat-data-indexeddb-v2';
const CHAT_DATA_DB_VERSION = 5;

const CHATS_STORE = 'chats';
const MESSAGES_STORE = 'messages';

const CHATS_PUBLIC_KEY_KEY = 'public_key';
const CHATS_LAST_MESSAGE_AT_INDEX = 'last_message_at';

const MESSAGES_CHAT_PUBLIC_KEY_INDEX = 'chat_public_key';
const MESSAGES_CHAT_CREATED_AT_INDEX = 'chat_public_key_created_at';
const MESSAGES_EVENT_ID_INDEX = 'event_id';
const MESSAGES_EDIT_IDS_INDEX = 'edit_event_ids';
const MESSAGES_REACTION_IDS_INDEX = 'reaction_event_ids';
const MESSAGES_AUTHOR_CREATED_INDEX = 'chat_author_created';
const MESSAGES_REPLY_INDEX = 'chat_reply_event';
const MESSAGES_REACTION_ROWS_INDEX = 'chat_reaction_rows';

function withReactionIndex<T extends { meta: Record<string, unknown> }>(
  record: T,
): T & { reaction_event_ids: string[] } {
  const reactions = Array.isArray(record.meta.reactions) ? record.meta.reactions : [];
  return {
    ...record,
    reaction_event_ids: reactions
      .map((item) => normalizeEventId(item?.eventId))
      .filter((id): id is string => !!id),
  };
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMetaValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMetaValue(entry)).filter((entry) => entry !== undefined);
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const normalizedEntry = normalizeMetaValue(entry);
        return normalizedEntry === undefined ? [] : [[key, normalizedEntry]];
      }),
    );
  }

  return undefined;
}

function normalizeMeta(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return {};
  }

  const normalized = normalizeMetaValue(value);
  return isPlainRecord(normalized) ? normalized : {};
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeUnreadCount(value: unknown): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.floor(numeric));
}

function normalizeChatType(value: unknown): ChatType {
  return value === 'group' ? 'group' : 'user';
}

function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function hasReactionEventId(meta: Record<string, unknown>, eventId: string): boolean {
  const reactions = meta.reactions;
  if (!Array.isArray(reactions)) {
    return false;
  }

  return reactions.some((reaction) => {
    if (!reaction || typeof reaction !== 'object') {
      return false;
    }

    const reactionEventId = normalizeEventId('eventId' in reaction ? reaction.eventId : null);
    return reactionEventId === eventId;
  });
}

function normalizePublicKeyValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function toComparableTimestamp(value: string | null): number {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortChatsByLatest(first: ChatRecord, second: ChatRecord): number {
  const byTime =
    toComparableTimestamp(second.last_message_at) - toComparableTimestamp(first.last_message_at);
  if (byTime !== 0) {
    return byTime;
  }

  return second.public_key.localeCompare(first.public_key);
}

function sortMessagesByCreated(first: MessageRecord, second: MessageRecord): number {
  const byTime = toComparableTimestamp(first.created_at) - toComparableTimestamp(second.created_at);
  if (byTime !== 0) {
    return byTime;
  }

  return first.id - second.id;
}

function compareMessageCursor(
  first: Pick<MessageRecord, 'created_at' | 'id'>,
  second: Pick<MessageCursor, 'created_at' | 'id'>,
): number {
  const byTime = toComparableTimestamp(first.created_at) - toComparableTimestamp(second.created_at);
  if (byTime !== 0) {
    return byTime;
  }

  return first.id - second.id;
}

function createChatCreatedAtRange(chatPublicKey: string): IDBKeyRange {
  return IDBKeyRange.bound([chatPublicKey, ''], [chatPublicKey, '\uffff']);
}

function createChatCreatedAtRangeFromCursor(
  chatPublicKey: string,
  cursor: MessageCursor | undefined,
  direction: IDBCursorDirection,
): IDBKeyRange {
  if (!cursor) {
    return createChatCreatedAtRange(chatPublicKey);
  }

  return direction === 'next'
    ? IDBKeyRange.bound([chatPublicKey, cursor.created_at], [chatPublicKey, '\uffff'])
    : IDBKeyRange.bound([chatPublicKey, ''], [chatPublicKey, cursor.created_at]);
}

function toChatRow(record: ChatRecord): ChatRow {
  return {
    id: record.public_key,
    public_key: record.public_key,
    type: normalizeChatType(record.type),
    name: record.name,
    last_message: record.last_message,
    last_message_at: record.last_message_at,
    unread_count: record.unread_count,
    meta: normalizeMeta(record.meta),
  };
}

function toMessageRow(record: MessageRecord): MessageRow {
  return {
    id: record.id,
    chat_public_key: record.chat_public_key,
    author_public_key: record.author_public_key,
    message: record.message,
    created_at: record.created_at,
    event_id: normalizeEventId(record.event_id),
    meta: normalizeMeta(record.meta),
  };
}

function isConstraintError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'ConstraintError';
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = 'name' in error ? String(error.name) : '';
  return name === 'ConstraintError';
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    };
  });
}

class ChatDataService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private initPromise: Promise<void> | null = null;
  private databaseGeneration = 0;

  async init(): Promise<void> {
    await this.ensureInitialized();
  }

  async clearAllData(): Promise<void> {
    this.databaseGeneration += 1;
    const dbPromise = this.dbPromise;
    this.dbPromise = null;
    this.initPromise = null;
    await closeIndexedDbConnection(dbPromise);
    await deleteIndexedDbDatabase(CHAT_DATA_DB_NAME);
  }

  async persist(): Promise<void> {
    // IndexedDB commits data automatically per transaction.
  }

  async listChats(): Promise<ChatRow[]> {
    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readonly');
    const store = transaction.objectStore(CHATS_STORE);
    const records = await requestToPromise<ChatRecord[]>(
      store.getAll() as IDBRequest<ChatRecord[]>,
    );
    await waitForTransaction(transaction);

    return records.sort(sortChatsByLatest).map((record) => toChatRow(record));
  }

  async getChatByPublicKey(publicKey: string): Promise<ChatRow | null> {
    const normalizedPublicKey = normalizePublicKeyValue(publicKey);
    if (!normalizedPublicKey) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readonly');
    const store = transaction.objectStore(CHATS_STORE);
    const record = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );
    await waitForTransaction(transaction);

    return record ? toChatRow(record) : null;
  }

  async createChat(input: CreateChatInput): Promise<ChatRow | null> {
    const publicKey = normalizePublicKeyValue(input.public_key);
    const name = input.name.trim();
    if (!publicKey || !name) {
      return null;
    }

    const record: ChatRecord = {
      public_key: publicKey,
      type: normalizeChatType(input.type),
      name,
      last_message: input.last_message?.trim() ?? '',
      last_message_at: toIsoTimestamp(input.last_message_at),
      unread_count: normalizeUnreadCount(input.unread_count),
      meta: normalizeMeta(input.meta),
    };

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const completed = waitForTransaction(transaction);
    void completed.catch(() => {});
    try {
      const existing = await requestToPromise<ChatRecord | undefined>(store.get(publicKey));
      if (existing) {
        // A profile/owner restore and the first epoch ticket can create the same
        // group concurrently. Keep the existing chat and atomically add its key.
        if (record.type === 'group' && Array.isArray(record.meta.group_epoch_keys)) {
          existing.type = 'group';
          existing.meta = mergeGroupEpochMetadata(existing.meta, {
            ...existing.meta,
            group_epoch_keys: record.meta.group_epoch_keys,
          });
          store.put(existing);
        }
        await completed;
        return toChatRow(existing);
      }
      if (record.type === 'group') record.meta = mergeGroupEpochMetadata({}, record.meta);
      store.add(withReactionIndex(record));
      await completed;
      return toChatRow(record);
    } catch (error) {
      console.error('Failed to create chat row in IndexedDB.', error);
      return null;
    }
  }

  async updateChatPreview(
    chatPublicKey: string,
    lastMessage: string,
    lastMessageAt: string,
    unreadCount: number,
    authorPublicKey?: string | null,
  ): Promise<void> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord || existingRecord.meta.deleted_locally === true) {
      await waitForTransaction(transaction);
      return;
    }

    store.put({
      ...existingRecord,
      type: normalizeChatType(existingRecord.type),
      last_message: lastMessage,
      last_message_at: toIsoTimestamp(lastMessageAt),
      ...(authorPublicKey
        ? {
            meta: {
              ...normalizeMeta(existingRecord.meta),
              last_message_author_public_key: authorPublicKey,
            },
          }
        : {}),
      unread_count: normalizeUnreadCount(unreadCount),
    });
    await waitForTransaction(transaction);
  }

  async updateChatUnreadCount(chatPublicKey: string, unreadCount: number): Promise<void> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (
      !existingRecord ||
      existingRecord.meta.deleted_locally === true ||
      existingRecord.unread_count === normalizeUnreadCount(unreadCount)
    ) {
      await waitForTransaction(transaction);
      return;
    }

    store.put({
      ...existingRecord,
      type: normalizeChatType(existingRecord.type),
      unread_count: normalizeUnreadCount(unreadCount),
    });
    await waitForTransaction(transaction);
  }

  async markChatAsRead(chatPublicKey: string): Promise<void> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord || existingRecord.unread_count === 0) {
      await waitForTransaction(transaction);
      return;
    }

    store.put({
      ...existingRecord,
      type: normalizeChatType(existingRecord.type),
      unread_count: 0,
    });
    await waitForTransaction(transaction);
  }

  async updateChatMeta(chatPublicKey: string, meta: Record<string, unknown>): Promise<void> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord) {
      await waitForTransaction(transaction);
      return;
    }

    store.put({
      ...existingRecord,
      type: normalizeChatType(existingRecord.type),
      meta:
        existingRecord.type === 'group'
          ? mergeGroupEpochMetadata(existingRecord.meta, normalizeMeta(meta))
          : normalizeMeta(meta),
    });
    await waitForTransaction(transaction);
  }

  async updateChat(chatPublicKey: string, input: UpdateChatInput): Promise<void> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      store.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord) {
      await waitForTransaction(transaction);
      return;
    }

    const nextName = input.name?.trim();
    const nextType = input.type !== undefined ? normalizeChatType(input.type) : undefined;
    store.put({
      ...existingRecord,
      ...(nextType ? { type: nextType } : {}),
      ...(nextName ? { name: nextName } : {}),
      ...(input.meta !== undefined
        ? {
            meta:
              (nextType ?? existingRecord.type) === 'group'
                ? mergeGroupEpochMetadata(existingRecord.meta, normalizeMeta(input.meta))
                : normalizeMeta(input.meta),
          }
        : {}),
    });
    await waitForTransaction(transaction);
  }

  async clearChatMessages(
    chatPublicKey: string,
    input: ClearChatMessagesInput = {},
  ): Promise<boolean> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return false;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction([CHATS_STORE, MESSAGES_STORE], 'readwrite');
    const chatsStore = transaction.objectStore(CHATS_STORE);
    const messagesStore = transaction.objectStore(MESSAGES_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      chatsStore.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord) {
      await waitForTransaction(transaction);
      return false;
    }

    chatsStore.put({
      ...existingRecord,
      last_message: input.last_message?.trim() ?? '',
      last_message_at:
        input.last_message_at !== undefined
          ? toIsoTimestamp(input.last_message_at)
          : existingRecord.last_message_at,
      unread_count:
        input.unread_count !== undefined
          ? normalizeUnreadCount(input.unread_count)
          : existingRecord.unread_count,
      meta: input.meta !== undefined ? normalizeMeta(input.meta) : existingRecord.meta,
    });

    const messagesByChatIndex = messagesStore.index(MESSAGES_CHAT_PUBLIC_KEY_INDEX);
    const messageIds = await requestToPromise<IDBValidKey[]>(
      messagesByChatIndex.getAllKeys(IDBKeyRange.only(normalizedPublicKey)) as IDBRequest<
        IDBValidKey[]
      >,
    );

    for (const messageId of messageIds) {
      messagesStore.delete(messageId);
    }

    try {
      await waitForTransaction(transaction);
      return true;
    } catch (error) {
      console.error('Failed to clear chat messages in IndexedDB.', error);
      return false;
    }
  }

  async deleteChat(chatPublicKey: string): Promise<boolean> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return false;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction([CHATS_STORE, MESSAGES_STORE], 'readwrite');
    const chatsStore = transaction.objectStore(CHATS_STORE);
    const messagesStore = transaction.objectStore(MESSAGES_STORE);
    const existingRecord = await requestToPromise<ChatRecord | undefined>(
      chatsStore.get(normalizedPublicKey) as IDBRequest<ChatRecord | undefined>,
    );

    if (!existingRecord) {
      await waitForTransaction(transaction);
      return false;
    }

    if (existingRecord.type === 'group') {
      // Keep encrypted epoch keys and a local tombstone: relay backups and
      // reissued tickets must not silently recreate a deleted conversation.
      chatsStore.put({
        ...existingRecord,
        last_message: '',
        unread_count: 0,
        meta: { ...existingRecord.meta, deleted_locally: true, unseen_reaction_count: 0 },
      });
    } else {
      chatsStore.delete(normalizedPublicKey);
    }

    const messagesByChatIndex = messagesStore.index(MESSAGES_CHAT_PUBLIC_KEY_INDEX);
    const messageIds = await requestToPromise<IDBValidKey[]>(
      messagesByChatIndex.getAllKeys(IDBKeyRange.only(normalizedPublicKey)) as IDBRequest<
        IDBValidKey[]
      >,
    );

    for (const messageId of messageIds) {
      messagesStore.delete(messageId);
    }

    try {
      await waitForTransaction(transaction);
      return true;
    } catch (error) {
      console.error('Failed to delete chat from IndexedDB.', error);
      return false;
    }
  }

  async reopenDeletedGroupChat(chatPublicKey: string): Promise<ChatRow | null> {
    const key = normalizePublicKeyValue(chatPublicKey);
    if (!key) return null;
    const db = await this.getDatabase();
    const transaction = db.transaction(CHATS_STORE, 'readwrite');
    const store = transaction.objectStore(CHATS_STORE);
    const record = await requestToPromise<ChatRecord | undefined>(store.get(key));
    if (record?.type === 'group' && record.meta.deleted_locally === true) {
      record.meta = { ...record.meta };
      delete record.meta.deleted_locally;
      store.put(record);
    }
    await waitForTransaction(transaction);
    return record ? toChatRow(record) : null;
  }

  async listMessages(chatPublicKey: string): Promise<MessageRow[]> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    if (!normalizedPublicKey) {
      return [];
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index(MESSAGES_CHAT_PUBLIC_KEY_INDEX);
    const records = await requestToPromise<MessageRecord[]>(
      index.getAll(IDBKeyRange.only(normalizedPublicKey)) as IDBRequest<MessageRecord[]>,
    );
    await waitForTransaction(transaction);

    return records.sort(sortMessagesByCreated).map((record) => toMessageRow(record));
  }

  async listMessagesInSecond(chatPublicKey: string, timestamp: string): Promise<MessageRow[]> {
    const chat = normalizePublicKeyValue(chatPublicKey);
    const time = Date.parse(timestamp);
    if (!chat || !Number.isFinite(time)) return [];
    const start = new Date(Math.floor(time / 1000) * 1000).toISOString();
    const end = new Date(Date.parse(start) + 1000).toISOString();
    const db = await this.getDatabase();
    const tx = db.transaction(MESSAGES_STORE, 'readonly');
    const rows = await requestToPromise<MessageRecord[]>(
      tx
        .objectStore(MESSAGES_STORE)
        .index(MESSAGES_CHAT_CREATED_AT_INDEX)
        .getAll(IDBKeyRange.bound([chat, start], [chat, end], false, true)),
    );
    await waitForTransaction(tx);
    return rows.map(toMessageRow);
  }

  // Legacy delete-and-replace edits share an author and Nostr second. Look up
  // that second through the compound index, never scan the whole conversation.
  async findDeletedMessageInSecond(
    chatPublicKey: string,
    author: string,
    timestamp: string,
  ): Promise<MessageRow | null> {
    const start = new Date(Math.floor(Date.parse(timestamp) / 1000) * 1000).toISOString();
    const end = new Date(Date.parse(start) + 1000).toISOString();
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MESSAGES_STORE, 'readonly');
      const request = tx
        .objectStore(MESSAGES_STORE)
        .index(MESSAGES_CHAT_CREATED_AT_INDEX)
        .openCursor(IDBKeyRange.bound([chatPublicKey, start], [chatPublicKey, end], false, true));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(null);
        const row = toMessageRow(cursor.value as MessageRecord);
        if (row.author_public_key.toLowerCase() === author && row.event_id && row.meta.deleted)
          return resolve(row);
        cursor.continue();
      };
    });
  }

  // Seek once per author instead of reading every message when opening a chat.
  async findLatestIncomingMessage(
    chatPublicKey: string,
    ownPublicKey: string | null,
  ): Promise<MessageRow | null> {
    return this.findLatestActivityMessage(chatPublicKey, ownPublicKey, true);
  }

  async findLatestMessageByAuthor(
    chatPublicKey: string,
    authorPublicKey: string | null,
  ): Promise<MessageRow | null> {
    return this.findLatestActivityMessage(chatPublicKey, authorPublicKey, false);
  }

  private async findLatestActivityMessage(
    chatPublicKey: string,
    ownPublicKey: string | null,
    incoming: boolean,
  ): Promise<MessageRow | null> {
    const chat = normalizePublicKeyValue(chatPublicKey);
    const own = normalizePublicKeyValue(ownPublicKey);
    if (!chat || !own) return null;
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MESSAGES_STORE, 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index(MESSAGES_AUTHOR_CREATED_INDEX);
      let latest: MessageRow | null = null;
      const authors = index.openKeyCursor(IDBKeyRange.bound([chat], [chat, []]));
      authors.onsuccess = () => {
        const cursor = authors.result;
        if (!cursor) return;
        const author = (cursor.key as string[])[1];
        if (
          normalizePublicKeyValue(author) &&
          (incoming
            ? normalizePublicKeyValue(author) !== own
            : normalizePublicKeyValue(author) === own)
        ) {
          const rows = index.openCursor(
            IDBKeyRange.bound([chat, author], [chat, author, []]),
            'prev',
          );
          rows.onsuccess = () => {
            const rowCursor = rows.result;
            if (!rowCursor) return;
            const row = toMessageRow(rowCursor.value as MessageRecord);
            const timestamp = Date.parse(row.created_at);
            if ((incoming && !isIncomingUnreadMessageActivity(row, own)) || !(timestamp > 0)) {
              rowCursor.continue();
              return;
            }
            if (
              !latest ||
              timestamp > Date.parse(latest.created_at) ||
              (timestamp === Date.parse(latest.created_at) && row.id > latest.id)
            )
              latest = row;
          };
        }
        // Array keys sort after string timestamps: skip this author's entire history.
        cursor.continue([chat, author, []]);
      };
      tx.oncomplete = () => resolve(latest);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async listMessagesReplyingTo(chatPublicKey: string, eventIds: string[]): Promise<MessageRow[]> {
    const chat = normalizePublicKeyValue(chatPublicKey);
    const ids = [...new Set(eventIds.map(normalizeEventId).filter((id): id is string => !!id))];
    if (!chat || !ids.length) return [];
    const db = await this.getDatabase();
    const tx = db.transaction(MESSAGES_STORE, 'readonly');
    const index = tx.objectStore(MESSAGES_STORE).index(MESSAGES_REPLY_INDEX);
    const batches = await Promise.all(
      ids.map((id) => requestToPromise<MessageRecord[]>(index.getAll([chat, id]))),
    );
    await waitForTransaction(tx);
    return batches.flat().sort(sortMessagesByCreated).map(toMessageRow);
  }

  // Sparse compound index includes only rows that carry a non-empty reaction array,
  // including legacy reactions without event IDs. Page by length + row ID.
  async *reactionMessageBatches(chatPublicKey: string, size = 250): AsyncGenerator<MessageRow[]> {
    const chat = normalizePublicKeyValue(chatPublicKey);
    if (!chat) return;
    const db = await this.getDatabase();
    let after: IDBValidKey[] = [chat, 1];
    let excludeAfter = false;
    const limit = Math.max(1, Math.min(1000, Math.floor(size) || 250));
    for (;;) {
      const tx = db.transaction(MESSAGES_STORE, 'readonly');
      const request = tx
        .objectStore(MESSAGES_STORE)
        .index(MESSAGES_REACTION_ROWS_INDEX)
        .getAll(
          IDBKeyRange.bound(
            after,
            [chat, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
            excludeAfter,
          ),
          limit,
        );
      const rows = await requestToPromise<MessageRecord[]>(request);
      await waitForTransaction(tx);
      if (!rows.length) return;
      yield rows.map(toMessageRow);
      if (rows.length < limit) return;
      const last = rows[rows.length - 1];
      after = [chat, (last.meta.reactions as unknown[]).length, last.id];
      excludeAfter = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async *messageBatches(
    chatPublicKey: string,
    size = 250,
    afterTimestamp = '',
  ): AsyncGenerator<MessageRow[]> {
    let cursor: MessageCursor =
      afterTimestamp && Date.parse(afterTimestamp) > 0
        ? { id: Number.MAX_SAFE_INTEGER, created_at: afterTimestamp }
        : { id: 0, created_at: '' };
    for (;;) {
      const batch = await this.listMessagesAfter(chatPublicKey, cursor, size);
      if (!batch.rows.length) return;
      yield batch.rows;
      if (!batch.has_more) return;
      const last = batch.rows[batch.rows.length - 1];
      cursor = { id: last.id, created_at: last.created_at };
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async searchMessages(chatPublicKey: string, query: string): Promise<MessageSearchResult[]> {
    const results: MessageSearchResult[] = [];
    if (!query.trim()) return results;
    for await (const batch of this.messageBatches(chatPublicKey)) {
      for (const row of batch) {
        if (messageRecordMatchesSearchQuery(row, normalizeMessageSearchText(query), normalizeMeta))
          results.push({
            id: row.id,
            chat_public_key: row.chat_public_key,
            message: row.message,
            created_at: row.created_at,
            event_id: row.event_id,
          });
      }
    }
    return results.reverse();
  }

  async listLatestMessages(chatPublicKey: string, limit: number): Promise<MessageBatchResult> {
    return this.collectMessagesByCursor(chatPublicKey, {
      direction: 'prev',
      limit,
    });
  }

  async listMessagesBefore(
    chatPublicKey: string,
    cursor: MessageCursor,
    limit: number,
  ): Promise<MessageBatchResult> {
    return this.collectMessagesByCursor(chatPublicKey, {
      direction: 'prev',
      limit,
      cursor,
    });
  }

  async listMessagesAfter(
    chatPublicKey: string,
    cursor: MessageCursor,
    limit: number,
  ): Promise<MessageBatchResult> {
    return this.collectMessagesByCursor(chatPublicKey, {
      direction: 'next',
      limit,
      cursor,
    });
  }

  async findFirstIncomingMessageAfter(
    chatPublicKey: string,
    afterTimestamp: string,
    loggedInPublicKey: string,
  ): Promise<MessageRow | null> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    const normalizedLoggedInPublicKey = normalizePublicKeyValue(loggedInPublicKey);
    const trimmedAfterTimestamp = String(afterTimestamp ?? '').trim();
    if (!normalizedPublicKey || !normalizedLoggedInPublicKey || !trimmedAfterTimestamp) {
      return null;
    }

    const db = await this.getDatabase();
    // Seek each sender's first unread row. A long run of our own outgoing
    // messages must never turn opening a thread into a full-history walk.
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MESSAGES_STORE, 'readonly');
      const index = tx.objectStore(MESSAGES_STORE).index(MESSAGES_AUTHOR_CREATED_INDEX);
      let first: MessageRow | null = null;
      const authors = index.openKeyCursor(
        IDBKeyRange.bound([normalizedPublicKey], [normalizedPublicKey, []]),
      );
      authors.onsuccess = () => {
        const cursor = authors.result;
        if (!cursor) return;
        const author = (cursor.key as string[])[1];
        if (
          normalizePublicKeyValue(author) &&
          normalizePublicKeyValue(author) !== normalizedLoggedInPublicKey
        ) {
          const rows = index.openCursor(
            IDBKeyRange.bound(
              [normalizedPublicKey, author, trimmedAfterTimestamp],
              [normalizedPublicKey, author, []],
              true,
            ),
          );
          rows.onsuccess = () => {
            const item = rows.result;
            if (!item) return;
            const row = toMessageRow(item.value as MessageRecord);
            if (!isIncomingUnreadMessageActivity(row, normalizedLoggedInPublicKey)) {
              item.continue();
              return;
            }
            if (
              !first ||
              row.created_at < first.created_at ||
              (row.created_at === first.created_at && row.id < first.id)
            )
              first = row;
          };
        }
        cursor.continue([normalizedPublicKey, author, []]);
      };
      tx.oncomplete = () => resolve(first);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async listAllMessages(): Promise<MessageRow[]> {
    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const records = await requestToPromise<MessageRecord[]>(
      store.getAll() as IDBRequest<MessageRecord[]>,
    );
    await waitForTransaction(transaction);

    return records.sort(sortMessagesByCreated).map((record) => toMessageRow(record));
  }

  async getMessageById(messageId: number): Promise<MessageRow | null> {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const record = await requestToPromise<MessageRecord | undefined>(
      store.get(messageId) as IDBRequest<MessageRecord | undefined>,
    );
    await waitForTransaction(transaction);

    return record ? toMessageRow(record) : null;
  }

  async createMessage(input: CreateMessageInput): Promise<MessageRow | null> {
    const chatPublicKey = normalizePublicKeyValue(input.chat_public_key);
    const authorPublicKey = String(input.author_public_key ?? '').trim();
    const message = String(input.message ?? '').trim();
    const createdAt = String(input.created_at ?? '').trim() || new Date().toISOString();
    const eventId = normalizeEventId(input.event_id);

    if (!chatPublicKey || !authorPublicKey || !message || !createdAt) {
      return null;
    }

    const record: Omit<MessageRecord, 'id'> = {
      chat_public_key: chatPublicKey,
      author_public_key: authorPublicKey,
      message,
      created_at: createdAt,
      ...(eventId ? { event_id: eventId } : {}),
      meta: normalizeMeta(input.meta),
    };

    const db = await this.getDatabase();
    // Validate and insert within the same transaction: no duplicate preflight
    // transactions, and concurrent deliveries observe a single committed row.
    const transaction = db.transaction([CHATS_STORE, MESSAGES_STORE], 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const completed = waitForTransaction(transaction);
    void completed.catch(() => {});
    try {
      const [chat, existing] = await Promise.all([
        requestToPromise<ChatRecord | undefined>(
          transaction.objectStore(CHATS_STORE).get(chatPublicKey),
        ),
        eventId
          ? requestToPromise<MessageRecord | undefined>(
              store.index(MESSAGES_EVENT_ID_INDEX).get(eventId),
            )
          : undefined,
      ]);
      if (chat?.type === 'group' && chat.meta.deleted_locally === true) {
        await completed;
        return null;
      }
      if (!chat || existing) {
        await completed;
        return chat && existing ? toMessageRow(existing) : null;
      }
      if (input.chat_activity) {
        const activity = input.chat_activity;
        const meta = normalizeMeta(chat.meta);
        const currentIncoming = String(meta.last_incoming_message_at ?? '');
        const seenAt =
          [
            meta.last_seen_received_activity_at,
            meta.last_seen_incoming_activity_at,
            meta.last_outgoing_message_at,
          ]
            .filter((value): value is string => typeof value === 'string')
            .sort()
            .at(-1) ?? '';
        const preview =
          activity.preview && activity.preview.at >= chat.last_message_at
            ? activity.preview
            : undefined;
        transaction.objectStore(CHATS_STORE).put({
          ...chat,
          meta: {
            ...meta,
            ...(preview ? { last_message_author_public_key: authorPublicKey } : {}),
            last_incoming_message_at:
              activity.incomingAt > currentIncoming ? activity.incomingAt : currentIncoming,
          },
          unread_count:
            seenAt >= activity.incomingAt
              ? chat.unread_count
              : normalizeUnreadCount(activity.unreadCount),
          ...(preview ? { last_message: preview.text, last_message_at: preview.at } : {}),
        });
      }
      const insertedId = await requestToPromise<IDBValidKey>(
        store.add(withReactionIndex(record)) as IDBRequest<IDBValidKey>,
      );
      await completed;

      return toMessageRow({
        ...record,
        id: Number(insertedId),
      });
    } catch (error) {
      if (eventId && isConstraintError(error)) {
        return this.getMessageByEventId(eventId);
      }

      console.error('Failed to create message row in IndexedDB.', error);
      return null;
    }
  }

  async updateMessageMeta(
    messageId: number,
    meta: Record<string, unknown>,
  ): Promise<MessageRow | null> {
    const normalizedMessageId = Number(messageId);
    if (!Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const record = await requestToPromise<MessageRecord | undefined>(
      store.get(normalizedMessageId) as IDBRequest<MessageRecord | undefined>,
    );
    if (!record) {
      await waitForTransaction(transaction);
      return null;
    }

    const nextRecord: MessageRecord = {
      ...record,
      meta: normalizeMeta(meta),
    };

    try {
      await requestToPromise<IDBValidKey>(
        store.put(withReactionIndex(nextRecord)) as IDBRequest<IDBValidKey>,
      );
      await waitForTransaction(transaction);
      return toMessageRow(nextRecord);
    } catch (error) {
      console.error('Failed to update message metadata in IndexedDB.', error);
      return null;
    }
  }

  async applyMessageEdit(
    messageId: number,
    input: ApplyMessageEditInput,
  ): Promise<MessageRow | null> {
    const normalizedMessageId = Number(messageId);
    const replacementEventId = normalizeEventId(input.event_id);
    const previousEventId = normalizeEventId(input.previous_event_id);
    const replacementMessage = String(input.message ?? '').trim();
    const replacementCreatedAt = String(input.created_at ?? '').trim();
    const editedAt = String(input.edited_at ?? '').trim();
    if (
      !Number.isInteger(normalizedMessageId) ||
      normalizedMessageId <= 0 ||
      !replacementEventId ||
      !previousEventId ||
      !replacementMessage ||
      !replacementCreatedAt ||
      !editedAt
    ) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const eventIdIndex = store.index(MESSAGES_EVENT_ID_INDEX);
    const originalRecord = await requestToPromise<MessageRecord | undefined>(
      store.get(normalizedMessageId) as IDBRequest<MessageRecord | undefined>,
    );
    if (!originalRecord) {
      await waitForTransaction(transaction);
      return null;
    }

    const persistedReplacement = await requestToPromise<MessageRecord | undefined>(
      eventIdIndex.get(replacementEventId) as IDBRequest<MessageRecord | undefined>,
    );
    if (
      persistedReplacement &&
      persistedReplacement.id !== originalRecord.id &&
      (normalizePublicKeyValue(persistedReplacement.chat_public_key) !==
        normalizePublicKeyValue(originalRecord.chat_public_key) ||
        persistedReplacement.author_public_key.trim().toLowerCase() !==
          originalRecord.author_public_key.trim().toLowerCase() ||
        !areMessageEditTimestampsEqual(persistedReplacement.created_at, originalRecord.created_at))
    ) {
      await waitForTransaction(transaction);
      return null;
    }

    const effectiveReplacement =
      persistedReplacement && persistedReplacement.id !== originalRecord.id
        ? persistedReplacement
        : {
            ...originalRecord,
            message: replacementMessage,
            created_at: replacementCreatedAt,
            event_id: replacementEventId,
            meta: normalizeMeta(input.meta),
          };
    if (
      !areMessageEditTimestampsEqual(effectiveReplacement.created_at, originalRecord.created_at)
    ) {
      await waitForTransaction(transaction);
      return null;
    }

    const nextRecord: MessageRecord = {
      ...originalRecord,
      message: effectiveReplacement.message.trim(),
      created_at: originalRecord.created_at,
      event_id: replacementEventId,
      meta: normalizeMeta(
        buildEditedMessageMeta(
          originalRecord.meta,
          effectiveReplacement.meta,
          previousEventId,
          editedAt,
        ),
      ),
    };

    try {
      if (persistedReplacement && persistedReplacement.id !== originalRecord.id) {
        await requestToPromise<undefined>(
          store.delete(persistedReplacement.id) as IDBRequest<undefined>,
        );
      }
      await requestToPromise<IDBValidKey>(
        store.put(withReactionIndex(nextRecord)) as IDBRequest<IDBValidKey>,
      );
      await waitForTransaction(transaction);
      return toMessageRow(nextRecord);
    } catch (error) {
      console.error('Failed to apply message edit in IndexedDB.', error);
      return null;
    }
  }

  // Reconcile a late intermediate edit without replacing the newer text or scanning history.
  async reconcileMessageEditPredecessor(
    messageId: number,
    incoming: {
      eventId: string;
      previousEventId: string;
      chat: string;
      author: string;
      createdAt: string;
    },
  ): Promise<MessageRow | null> {
    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const latest = await requestToPromise<MessageRecord | undefined>(store.get(messageId));
    const references = (record: MessageRecord) => {
      const edited = record.meta.edited as { previousEventIds?: string[] } | undefined;
      return edited?.previousEventIds ?? [];
    };
    const matches = (record: MessageRecord) =>
      record.chat_public_key === incoming.chat &&
      record.author_public_key === incoming.author &&
      areMessageEditTimestampsEqual(record.created_at, incoming.createdAt);
    if (
      !latest ||
      !matches(latest) ||
      !references(latest).includes(incoming.eventId) ||
      incoming.previousEventId === latest.event_id ||
      incoming.previousEventId === incoming.eventId
    ) {
      await waitForTransaction(transaction);
      return latest ? toMessageRow(latest) : null;
    }
    const [exact, edited] = await Promise.all([
      requestToPromise<MessageRecord | undefined>(
        store.index(MESSAGES_EVENT_ID_INDEX).get(incoming.previousEventId),
      ),
      requestToPromise<MessageRecord | undefined>(
        store.index(MESSAGES_EDIT_IDS_INDEX).get(incoming.previousEventId),
      ),
    ]);
    const ancestor = exact ?? edited;
    if (ancestor && !matches(ancestor)) {
      await waitForTransaction(transaction);
      return toMessageRow(latest);
    }
    const next: MessageRecord = {
      ...latest,
      meta: {
        ...latest.meta,
        edited: {
          ...(latest.meta.edited as Record<string, unknown>),
          previousEventIds: [
            ...new Set([
              ...references(latest),
              incoming.previousEventId,
              ...(ancestor ? references(ancestor) : []),
              ...(ancestor?.event_id && ancestor.event_id !== latest.event_id
                ? [ancestor.event_id]
                : []),
            ]),
          ],
        },
      },
    };
    if (ancestor && ancestor.id !== latest.id) store.delete(ancestor.id);
    store.put(withReactionIndex(next));
    await waitForTransaction(transaction);
    return toMessageRow(next);
  }

  async updateMessageEventId(messageId: number, eventId: string): Promise<MessageRow | null> {
    const normalizedMessageId = Number(messageId);
    const normalizedEventId = normalizeEventId(eventId);
    if (!Number.isInteger(normalizedMessageId) || normalizedMessageId <= 0 || !normalizedEventId) {
      return null;
    }

    const existingMessage = await this.getMessageByEventId(normalizedEventId);
    if (existingMessage) {
      return existingMessage;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    const record = await requestToPromise<MessageRecord | undefined>(
      store.get(normalizedMessageId) as IDBRequest<MessageRecord | undefined>,
    );
    if (!record) {
      await waitForTransaction(transaction);
      return null;
    }

    // Relay acknowledgements may finish after an edit has replaced this row.
    // Check inside the write transaction so an old publish cannot rebind the
    // replacement to a deleted predecessor (including during a retry).
    if (messageEditReferencesEventId(record.meta, normalizedEventId)) {
      await waitForTransaction(transaction);
      return toMessageRow(record);
    }

    const nextRecord: MessageRecord = {
      ...record,
      event_id: normalizedEventId,
    };

    try {
      await requestToPromise<IDBValidKey>(
        store.put(withReactionIndex(nextRecord)) as IDBRequest<IDBValidKey>,
      );
      await waitForTransaction(transaction);
      return toMessageRow(nextRecord);
    } catch (error) {
      if (isConstraintError(error)) {
        return this.getMessageByEventId(normalizedEventId);
      }

      console.error('Failed to update message event id in IndexedDB.', error);
      return null;
    }
  }

  async getMessageByEventId(eventId: string): Promise<MessageRow | null> {
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index(MESSAGES_EVENT_ID_INDEX);
    const record = await requestToPromise<MessageRecord | undefined>(
      index.get(normalizedEventId) as IDBRequest<MessageRecord | undefined>,
    );
    await waitForTransaction(transaction);

    return record ? toMessageRow(record) : null;
  }

  async getIncomingMessageContext(
    chatPublicKey: string,
    eventId: string,
  ): Promise<{ chat: ChatRow | null; existingMessage: MessageRow | null }> {
    const db = await this.getDatabase();
    const tx = db.transaction([CHATS_STORE, MESSAGES_STORE], 'readonly');
    const store = tx.objectStore(MESSAGES_STORE);
    const id = normalizeEventId(eventId);
    const [chat, exact, edited] = await Promise.all([
      requestToPromise<ChatRecord | undefined>(
        tx.objectStore(CHATS_STORE).get(normalizePublicKeyValue(chatPublicKey)),
      ),
      id
        ? requestToPromise<MessageRecord | undefined>(store.index(MESSAGES_EVENT_ID_INDEX).get(id))
        : undefined,
      id
        ? requestToPromise<MessageRecord | undefined>(store.index(MESSAGES_EDIT_IDS_INDEX).get(id))
        : undefined,
    ]);
    await waitForTransaction(tx);
    const message = exact ?? edited;
    return {
      chat: chat ? toChatRow(chat) : null,
      existingMessage: message ? toMessageRow(message) : null,
    };
  }

  async getMessageByEventIdOrEditReference(eventId: string): Promise<MessageRow | null> {
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const [exact, edited] = await Promise.all([
      requestToPromise<MessageRecord | undefined>(
        store.index(MESSAGES_EVENT_ID_INDEX).get(normalizedEventId),
      ),
      requestToPromise<MessageRecord | undefined>(
        store.index(MESSAGES_EDIT_IDS_INDEX).get(normalizedEventId),
      ),
    ]);
    await waitForTransaction(transaction);
    const record = exact ?? edited;
    return record ? toMessageRow(record) : null;
  }

  async deleteMessageByEventId(eventId: string): Promise<boolean> {
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return false;
    }

    const existingMessage = await this.getMessageByEventId(normalizedEventId);
    if (!existingMessage) {
      return false;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = transaction.objectStore(MESSAGES_STORE);
    store.delete(existingMessage.id);

    try {
      await waitForTransaction(transaction);
      return true;
    } catch (error) {
      console.error('Failed to delete message row from IndexedDB.', error);
      return false;
    }
  }

  async findMessageByReactionEventId(eventId: string): Promise<MessageRow | null> {
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const record = await requestToPromise<MessageRecord | undefined>(
      store.index(MESSAGES_REACTION_IDS_INDEX).get(normalizedEventId),
    );
    await waitForTransaction(transaction);
    return record ? toMessageRow(record) : null;
  }

  async getDatabase(): Promise<IDBDatabase> {
    await this.ensureInitialized();

    if (!this.dbPromise) {
      throw new Error('IndexedDB is not initialized.');
    }

    return this.dbPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }

    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    const databaseGeneration = this.databaseGeneration;
    const db = await this.openDatabase();
    if (databaseGeneration !== this.databaseGeneration) {
      db.close();
      return;
    }

    this.dbPromise = Promise.resolve(db);
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!canUseIndexedDb()) {
      return Promise.reject(new Error('IndexedDB is not available in this environment.'));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(CHAT_DATA_DB_NAME, CHAT_DATA_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const transaction = request.transaction;
        if (!transaction) {
          return;
        }

        const chatsStore = db.objectStoreNames.contains(CHATS_STORE)
          ? transaction.objectStore(CHATS_STORE)
          : db.createObjectStore(CHATS_STORE, { keyPath: CHATS_PUBLIC_KEY_KEY });
        if (!chatsStore.indexNames.contains(CHATS_LAST_MESSAGE_AT_INDEX)) {
          chatsStore.createIndex(CHATS_LAST_MESSAGE_AT_INDEX, CHATS_LAST_MESSAGE_AT_INDEX, {
            unique: false,
          });
        }

        const messagesStore = db.objectStoreNames.contains(MESSAGES_STORE)
          ? transaction.objectStore(MESSAGES_STORE)
          : db.createObjectStore(MESSAGES_STORE, { keyPath: 'id', autoIncrement: true });
        if (!messagesStore.indexNames.contains(MESSAGES_CHAT_PUBLIC_KEY_INDEX)) {
          messagesStore.createIndex(
            MESSAGES_CHAT_PUBLIC_KEY_INDEX,
            MESSAGES_CHAT_PUBLIC_KEY_INDEX,
            {
              unique: false,
            },
          );
        }
        if (!messagesStore.indexNames.contains(MESSAGES_CHAT_CREATED_AT_INDEX)) {
          messagesStore.createIndex(
            MESSAGES_CHAT_CREATED_AT_INDEX,
            [MESSAGES_CHAT_PUBLIC_KEY_INDEX, 'created_at'],
            {
              unique: false,
            },
          );
        }
        if (!messagesStore.indexNames.contains(MESSAGES_EDIT_IDS_INDEX)) {
          messagesStore.createIndex(MESSAGES_EDIT_IDS_INDEX, 'meta.edited.previousEventIds', {
            multiEntry: true,
          });
        }
        if (!messagesStore.indexNames.contains(MESSAGES_REACTION_IDS_INDEX)) {
          messagesStore.createIndex(MESSAGES_REACTION_IDS_INDEX, MESSAGES_REACTION_IDS_INDEX, {
            multiEntry: true,
          });
          // Upgrade old rows one cursor at a time, never materializing the history.
          const backfill = messagesStore.openCursor();
          backfill.onsuccess = () => {
            const cursor = backfill.result;
            if (!cursor) return;
            const record = cursor.value as MessageRecord;
            if (Array.isArray(record.meta?.reactions) && record.meta.reactions.length)
              cursor.update(withReactionIndex(record));
            cursor.continue();
          };
        }
        // Additive indexes: IndexedDB indexes existing rows atomically; no row rewrites.
        if (!messagesStore.indexNames.contains(MESSAGES_AUTHOR_CREATED_INDEX)) {
          messagesStore.createIndex(MESSAGES_AUTHOR_CREATED_INDEX, [
            'chat_public_key',
            'author_public_key',
            'created_at',
          ]);
        }
        if (!messagesStore.indexNames.contains(MESSAGES_REPLY_INDEX)) {
          messagesStore.createIndex(MESSAGES_REPLY_INDEX, [
            'chat_public_key',
            'meta.reply.eventId',
          ]);
        }
        if (!messagesStore.indexNames.contains(MESSAGES_REACTION_ROWS_INDEX)) {
          messagesStore.createIndex(MESSAGES_REACTION_ROWS_INDEX, [
            'chat_public_key',
            'meta.reactions.length',
            'id',
          ]);
        }
        if (!messagesStore.indexNames.contains(MESSAGES_EVENT_ID_INDEX)) {
          messagesStore.createIndex(MESSAGES_EVENT_ID_INDEX, MESSAGES_EVENT_ID_INDEX, {
            unique: true,
          });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
        };
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open chat IndexedDB database.'));
      };

      request.onblocked = () => {
        console.error('IndexedDB chat database open request is blocked by another tab.');
      };
    });
  }

  private async collectMessagesByCursor(
    chatPublicKey: string,
    options: {
      direction: IDBCursorDirection;
      limit: number;
      cursor?: MessageCursor;
    },
  ): Promise<MessageBatchResult> {
    const normalizedPublicKey = normalizePublicKeyValue(chatPublicKey);
    const normalizedLimit = Math.max(0, Math.floor(Number(options.limit) || 0));
    if (!normalizedPublicKey || normalizedLimit <= 0) {
      return {
        rows: [],
        has_more: false,
      };
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(MESSAGES_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGES_STORE);
    const index = store.index(MESSAGES_CHAT_CREATED_AT_INDEX);
    const request = index.openCursor(
      createChatCreatedAtRangeFromCursor(normalizedPublicKey, options.cursor, options.direction),
      options.direction,
    );

    const batchResult = await new Promise<MessageBatchResult>((resolve, reject) => {
      const rows: MessageRow[] = [];
      let hasMore = false;

      request.onsuccess = () => {
        const cursorValue = request.result;
        if (!cursorValue) {
          resolve({
            rows: options.direction === 'prev' ? rows.reverse() : rows,
            has_more: hasMore,
          });
          return;
        }

        const record = cursorValue.value as MessageRecord;
        if (normalizePublicKeyValue(record.chat_public_key) !== normalizedPublicKey) {
          cursorValue.continue();
          return;
        }

        if (options.cursor) {
          const comparison = compareMessageCursor(record, options.cursor);
          const shouldInclude = options.direction === 'next' ? comparison > 0 : comparison < 0;

          if (!shouldInclude) {
            // Skip a large run sharing one timestamp in a single index operation.
            if (
              record.created_at === options.cursor.created_at &&
              record.id !== options.cursor.id
            ) {
              cursorValue.continuePrimaryKey(
                [normalizedPublicKey, options.cursor.created_at],
                options.cursor.id,
              );
            } else cursorValue.continue();
            return;
          }
        }

        if (rows.length >= normalizedLimit) {
          hasMore = true;
          resolve({
            rows: options.direction === 'prev' ? rows.reverse() : rows,
            has_more: hasMore,
          });
          return;
        }

        rows.push(toMessageRow(record));
        cursorValue.continue();
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to iterate paged message cursor.'));
      };
    });

    await waitForTransaction(transaction);
    return batchResult;
  }
}

export const __chatDataServiceTestUtils = {
  isDeletedMessageMeta,
  messageRecordMatchesSearchQuery,
  normalizeMessageSearchText,
};

export const chatDataService = new ChatDataService();
