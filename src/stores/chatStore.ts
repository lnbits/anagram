import { defineStore } from 'pinia';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { CHAT_REQUEST_CLEARED_AT_META_KEY } from 'src/stores/nostr/constants';
import { resolveLatestReadBoundaryAtValue } from 'src/stores/nostr/valueUtils';
import type { Chat, ChatInboxState, ChatMetadata } from 'src/types/chat';
import type { ContactGroupMember, ContactRecord } from 'src/types/contact';
import { buildAvatarText } from 'src/utils/avatarText';
import { isIncomingUnreadMessageActivity } from 'src/utils/messageActivity';
import { buildImageAttachmentPreviewText } from 'src/utils/messageAttachments';
import { formatGroupMentionsForDisplay } from 'src/utils/nostrMentions';
import { computed, ref } from 'vue';

interface ChatContactContext {
  picture: string;
  givenName: string;
  contactName: string;
  groupMembers: ContactGroupMember[];
  lastSeenIncomingActivityAt: string;
}

interface AddContactOptions {
  contactName?: string;
  givenName?: string;
  picture?: string;
}

interface LiveChatPreviewInput {
  publicKey: string;
  authorPublicKey: string;
  fallbackName: string;
  messageText: string;
  at: string;
  unreadCount: number;
  meta?: Record<string, unknown>;
  messageMeta?: Record<string, unknown>;
}

interface ChatActivitySnapshot {
  lastIncomingMessageAt: string;
  lastOutgoingMessageAt: string;
}

interface ChatLastMessageAuthorSnapshot {
  authorPublicKey: string;
  at: string;
  rowId: number;
}

interface ChatReadCursor {
  at: string;
  eventId: string | null;
}

const LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY = 'last_seen_received_activity_at';
const CHAT_INBOX_STATE_META_KEY = 'inbox_state';
const CHAT_ACCEPTED_AT_META_KEY = 'accepted_at';
const CHAT_BLOCKED_AT_META_KEY = 'blocked_at';
const CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY = 'last_incoming_message_at';
const CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY = 'last_outgoing_message_at';

type ChatListCategory = 'chat' | 'request' | 'blocked' | 'hidden';

function sortByLatest(chats: Chat[]): Chat[] {
  const toTimestamp = (value: string): number => {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return [...chats].sort(
    (first, second) => toTimestamp(second.lastMessageAt) - toTimestamp(first.lastMessageAt)
  );
}

function normalizeChatIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue || null;
}

function normalizeEventId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue || null;
}

function readMetaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalInputString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isContactGroupMemberLike(value: unknown): value is ContactGroupMember {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ContactGroupMember>;
  return typeof candidate.public_key === 'string' && candidate.public_key.trim().length > 0;
}

function cloneGroupMembers(value: unknown): ContactGroupMember[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isContactGroupMemberLike).map((member) => ({ ...member }));
}

function formatChatLastMessagePreview(
  text: string,
  chatMeta: Record<string, unknown>,
  type: Chat['type'],
  messageMeta?: Record<string, unknown>
): string {
  const previewText = buildImageAttachmentPreviewText(text, messageMeta);
  return type === 'group' ? formatGroupMentionsForDisplay(previewText, chatMeta) : previewText;
}

function readMetaInboxState(meta: Record<string, unknown>): ChatInboxState | null {
  const value = readMetaString(meta, CHAT_INBOX_STATE_META_KEY);
  return value === 'accepted' || value === 'blocked' ? value : null;
}

function getLoggedInPublicKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return normalizeChatIdentifier(window.localStorage.getItem('npub'));
}

function toComparableTimestamp(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readMetaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, Math.floor(numericValue));
}

function syncMetaString(meta: Record<string, unknown>, key: string, value: string): boolean {
  const normalizedValue = value.trim();
  const currentValue = readMetaString(meta, key);

  if (!normalizedValue) {
    if (!currentValue) {
      return false;
    }

    delete meta[key];
    return true;
  }

  if (currentValue === normalizedValue) {
    return false;
  }

  meta[key] = normalizedValue;
  return true;
}

function syncMetaLatestTimestamp(
  meta: Record<string, unknown>,
  key: string,
  value: string
): boolean {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  const currentValue = readMetaString(meta, key);
  if (toComparableTimestamp(currentValue) >= toComparableTimestamp(normalizedValue)) {
    return false;
  }

  meta[key] = normalizedValue;
  return true;
}

function syncMetaInboxState(meta: Record<string, unknown>, nextState: ChatInboxState): boolean {
  const currentState = readMetaInboxState(meta);
  if (currentState === nextState) {
    return false;
  }

  meta[CHAT_INBOX_STATE_META_KEY] = nextState;
  return true;
}

function resolveChatCategory(meta: Record<string, unknown>): ChatListCategory {
  const inboxState = readMetaInboxState(meta);
  if (inboxState === 'blocked') {
    return 'blocked';
  }

  if (
    inboxState === 'accepted' ||
    readMetaString(meta, CHAT_ACCEPTED_AT_META_KEY) ||
    readMetaString(meta, CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY)
  ) {
    return 'chat';
  }

  const lastIncomingMessageAt = readMetaString(meta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY);
  if (lastIncomingMessageAt) {
    const requestClearedAt = readMetaString(meta, CHAT_REQUEST_CLEARED_AT_META_KEY);
    if (
      requestClearedAt &&
      toComparableTimestamp(requestClearedAt) >= toComparableTimestamp(lastIncomingMessageAt)
    ) {
      return 'hidden';
    }

    return 'request';
  }

  return 'chat';
}

function resolveDefaultSelectedChatId(chatList: Chat[]): string | null {
  return (
    chatList.find((chat) => resolveChatCategory(chat.meta as Record<string, unknown>) === 'chat')
      ?.id ?? null
  );
}

function buildChatSearchText(chat: Chat): string {
  const candidates = [
    chat.name,
    chat.publicKey,
    chat.lastMessage,
    readMetaString(chat.meta as Record<string, unknown>, 'given_name'),
    readMetaString(chat.meta as Record<string, unknown>, 'contact_name'),
  ];

  return candidates
    .map((candidate) => candidate.trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
}

function chatMatchesSearch(chat: Chat, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return buildChatSearchText(chat).includes(normalizedQuery);
}

function buildChatActivitySnapshotByPublicKey(
  messageRows: Awaited<ReturnType<typeof chatDataService.listAllMessages>>,
  loggedInPublicKey: string | null
): Map<string, ChatActivitySnapshot> {
  const snapshotsByPublicKey = new Map<string, ChatActivitySnapshot>();
  if (!loggedInPublicKey) {
    return snapshotsByPublicKey;
  }

  for (const row of messageRows) {
    const chatPublicKey = normalizeChatIdentifier(row.chat_public_key);
    if (!chatPublicKey) {
      continue;
    }

    const snapshot = snapshotsByPublicKey.get(chatPublicKey) ?? {
      lastIncomingMessageAt: '',
      lastOutgoingMessageAt: '',
    };
    const authorPublicKey = normalizeChatIdentifier(row.author_public_key);

    if (authorPublicKey === loggedInPublicKey) {
      if (
        toComparableTimestamp(row.created_at) >
        toComparableTimestamp(snapshot.lastOutgoingMessageAt)
      ) {
        snapshot.lastOutgoingMessageAt = row.created_at;
      }
    } else if (
      isIncomingUnreadMessageActivity(row, loggedInPublicKey) &&
      toComparableTimestamp(row.created_at) > toComparableTimestamp(snapshot.lastIncomingMessageAt)
    ) {
      snapshot.lastIncomingMessageAt = row.created_at;
    }

    snapshotsByPublicKey.set(chatPublicKey, snapshot);
  }

  return snapshotsByPublicKey;
}

function buildIncomingMessageTimestampsByPublicKey(
  messageRows: Awaited<ReturnType<typeof chatDataService.listAllMessages>>,
  loggedInPublicKey: string | null
): Map<string, string[]> {
  const timestampsByPublicKey = new Map<string, string[]>();
  if (!loggedInPublicKey) {
    return timestampsByPublicKey;
  }

  for (const row of messageRows) {
    const chatPublicKey = normalizeChatIdentifier(row.chat_public_key);
    const authorPublicKey = normalizeChatIdentifier(row.author_public_key);
    if (
      !chatPublicKey ||
      !authorPublicKey ||
      !isIncomingUnreadMessageActivity(row, loggedInPublicKey)
    ) {
      continue;
    }

    const timestamps = timestampsByPublicKey.get(chatPublicKey) ?? [];
    timestamps.push(row.created_at);
    timestampsByPublicKey.set(chatPublicKey, timestamps);
  }

  return timestampsByPublicKey;
}

function buildLastMessageAuthorSnapshotByPublicKey(
  messageRows: Awaited<ReturnType<typeof chatDataService.listAllMessages>>
): Map<string, ChatLastMessageAuthorSnapshot> {
  const snapshotsByPublicKey = new Map<string, ChatLastMessageAuthorSnapshot>();

  for (const row of messageRows) {
    const chatPublicKey = normalizeChatIdentifier(row.chat_public_key);
    const authorPublicKey = normalizeChatIdentifier(row.author_public_key);
    if (!chatPublicKey || !authorPublicKey) {
      continue;
    }

    const existing = snapshotsByPublicKey.get(chatPublicKey);
    const rowTimestamp = toComparableTimestamp(row.created_at);
    const existingTimestamp = toComparableTimestamp(existing?.at);
    if (
      existing &&
      (existingTimestamp > rowTimestamp ||
        (existingTimestamp === rowTimestamp && existing.rowId >= row.id))
    ) {
      continue;
    }

    snapshotsByPublicKey.set(chatPublicKey, {
      authorPublicKey,
      at: row.created_at,
      rowId: row.id,
    });
  }

  return snapshotsByPublicKey;
}

function countUnreadMessagesAfter(
  timestamps: string[] | undefined,
  lastSeenReceivedActivityAt: string
): number {
  if (!timestamps || timestamps.length === 0) {
    return 0;
  }

  const lastSeenTimestamp = toComparableTimestamp(lastSeenReceivedActivityAt);
  return timestamps.reduce((count, timestamp) => {
    return count + (toComparableTimestamp(timestamp) > lastSeenTimestamp ? 1 : 0);
  }, 0);
}

function findLatestIncomingMessageActivity(
  messageRows: Awaited<ReturnType<typeof chatDataService.listMessages>>,
  loggedInPublicKey: string | null
): ChatReadCursor | null {
  if (!loggedInPublicKey) {
    return null;
  }

  let latestIncomingActivity: ChatReadCursor | null = null;
  let latestIncomingTimestamp = 0;
  let latestIncomingRowId = 0;
  for (const row of messageRows) {
    if (!isIncomingUnreadMessageActivity(row, loggedInPublicKey)) {
      continue;
    }

    const messageTimestamp = toComparableTimestamp(row.created_at);
    if (messageTimestamp <= 0) {
      continue;
    }

    const messageRowId = Number(row.id ?? 0);
    if (
      messageTimestamp > latestIncomingTimestamp ||
      (messageTimestamp === latestIncomingTimestamp && messageRowId > latestIncomingRowId)
    ) {
      latestIncomingTimestamp = messageTimestamp;
      latestIncomingRowId = messageRowId;
      latestIncomingActivity = {
        at: row.created_at,
        eventId: normalizeEventId(row.event_id),
      };
    }
  }

  return latestIncomingActivity;
}

function findLatestIncomingMessageAt(
  messageRows: Awaited<ReturnType<typeof chatDataService.listMessages>>,
  loggedInPublicKey: string | null
): string {
  return findLatestIncomingMessageActivity(messageRows, loggedInPublicKey)?.at ?? '';
}

function resolveEffectiveLastSeenReceivedActivityAt(
  chatLastSeenReceivedActivityAt: string,
  contactLastSeenIncomingActivityAt: string,
  lastOutgoingMessageAt = ''
): string {
  return resolveLatestReadBoundaryAtValue(
    chatLastSeenReceivedActivityAt,
    contactLastSeenIncomingActivityAt,
    lastOutgoingMessageAt
  );
}

function resolveMarkAsReadBoundaryAt(
  currentLastSeenReceivedActivityAt: string,
  lastIncomingMessageAt: string,
  latestIncomingMessageAt: string
): string {
  const latestIncomingBoundaryAt =
    toComparableTimestamp(latestIncomingMessageAt) > toComparableTimestamp(lastIncomingMessageAt)
      ? latestIncomingMessageAt
      : lastIncomingMessageAt;

  return toComparableTimestamp(latestIncomingBoundaryAt) >
    toComparableTimestamp(currentLastSeenReceivedActivityAt)
    ? latestIncomingBoundaryAt
    : '';
}

function syncChatActivityMeta(
  meta: Record<string, unknown>,
  snapshot: ChatActivitySnapshot | undefined
): Record<string, unknown> {
  if (!snapshot) {
    return meta;
  }

  const currentInboxState = readMetaInboxState(meta);
  let nextMeta = meta;

  const ensureWritableMeta = (): Record<string, unknown> => {
    if (nextMeta === meta) {
      nextMeta = { ...meta };
    }

    return nextMeta;
  };

  if (
    snapshot.lastIncomingMessageAt &&
    toComparableTimestamp(snapshot.lastIncomingMessageAt) >
      toComparableTimestamp(readMetaString(meta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY))
  ) {
    syncMetaLatestTimestamp(
      ensureWritableMeta(),
      CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY,
      snapshot.lastIncomingMessageAt
    );
  }

  if (
    snapshot.lastOutgoingMessageAt &&
    currentInboxState !== 'blocked' &&
    (toComparableTimestamp(snapshot.lastOutgoingMessageAt) >
      toComparableTimestamp(readMetaString(meta, CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY)) ||
      currentInboxState !== 'accepted' ||
      toComparableTimestamp(snapshot.lastOutgoingMessageAt) >
        toComparableTimestamp(readMetaString(meta, CHAT_ACCEPTED_AT_META_KEY)) ||
      readMetaString(meta, CHAT_BLOCKED_AT_META_KEY))
  ) {
    const writableMeta = ensureWritableMeta();
    syncMetaLatestTimestamp(
      writableMeta,
      CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY,
      snapshot.lastOutgoingMessageAt
    );
    syncMetaInboxState(writableMeta, 'accepted');
    syncMetaLatestTimestamp(
      writableMeta,
      CHAT_ACCEPTED_AT_META_KEY,
      snapshot.lastOutgoingMessageAt
    );
    delete writableMeta[CHAT_BLOCKED_AT_META_KEY];
    delete writableMeta[CHAT_REQUEST_CLEARED_AT_META_KEY];
  }

  return nextMeta;
}

function resolvePictureFromContactMeta(meta: Record<string, unknown>): string {
  const picture = meta.picture;
  if (typeof picture === 'string' && picture.trim()) {
    return picture.trim();
  }

  return '';
}

function toContactContext(contact: ContactRecord): ChatContactContext {
  const contactMeta =
    contact.meta && typeof contact.meta === 'object' && !Array.isArray(contact.meta)
      ? (contact.meta as Record<string, unknown>)
      : {};

  return {
    picture: resolvePictureFromContactMeta(contactMeta),
    givenName: contact.given_name?.trim() ?? '',
    contactName: contact.name.trim(),
    groupMembers: cloneGroupMembers(contactMeta.group_members),
    lastSeenIncomingActivityAt: readMetaString(contactMeta, 'last_seen_incoming_activity_at'),
  };
}

function toContactContextFromOptions(
  options: AddContactOptions | undefined,
  fallbackName: string
): ChatContactContext | undefined {
  const picture = readOptionalInputString(options?.picture);
  const givenName = readOptionalInputString(options?.givenName);
  const contactName = readOptionalInputString(options?.contactName);
  if (!picture && !givenName && !contactName) {
    return undefined;
  }

  return {
    picture,
    givenName,
    contactName: contactName || givenName || fallbackName.trim(),
    groupMembers: [],
    lastSeenIncomingActivityAt: '',
  };
}

function syncMetaJsonValue(
  meta: Record<string, unknown>,
  key: string,
  value: unknown[] | undefined
): boolean {
  const nextValue = Array.isArray(value) ? value : [];
  const currentValue = Array.isArray(meta[key]) ? (meta[key] as unknown[]) : [];
  if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) {
    return false;
  }

  if (nextValue.length === 0) {
    delete meta[key];
  } else {
    meta[key] = nextValue.map((entry) =>
      entry && typeof entry === 'object' ? { ...(entry as Record<string, unknown>) } : entry
    );
  }
  return true;
}

function syncChatMeta(
  meta: Record<string, unknown>,
  contactContext: ChatContactContext | undefined,
  avatarSeed: string
): Record<string, unknown> {
  let nextMeta = meta;

  const ensureWritableMeta = (): Record<string, unknown> => {
    if (nextMeta === meta) {
      nextMeta = { ...meta };
    }

    return nextMeta;
  };

  if (contactContext) {
    const writableMeta = ensureWritableMeta();
    const didChangePicture = syncMetaString(writableMeta, 'picture', contactContext.picture);
    const didChangeGivenName = syncMetaString(writableMeta, 'given_name', contactContext.givenName);
    const didChangeContactName = syncMetaString(
      writableMeta,
      'contact_name',
      contactContext.contactName
    );
    const didChangeLastSeenReceivedActivityAt = syncMetaLatestTimestamp(
      writableMeta,
      LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
      contactContext.lastSeenIncomingActivityAt
    );
    const didChangeGroupMembers = syncMetaJsonValue(
      writableMeta,
      'group_members',
      contactContext.groupMembers
    );

    if (
      !didChangePicture &&
      !didChangeGivenName &&
      !didChangeContactName &&
      !didChangeGroupMembers &&
      !didChangeLastSeenReceivedActivityAt &&
      nextMeta !== meta
    ) {
      nextMeta = meta;
    }
  }

  const nextAvatar = buildAvatarText(avatarSeed);
  const currentAvatar = readMetaString(nextMeta, 'avatar');
  if (currentAvatar !== nextAvatar) {
    ensureWritableMeta().avatar = nextAvatar;
  }

  return nextMeta;
}

function mapChatRowToChat(
  row: Awaited<ReturnType<typeof chatDataService.listChats>>[number],
  contactContext?: ChatContactContext,
  lastMessageAuthorSnapshot?: ChatLastMessageAuthorSnapshot
): Chat {
  const nextName = contactContext?.contactName || row.name;
  const nextMeta = syncChatMeta(
    row.meta,
    contactContext,
    contactContext?.givenName || nextName || row.public_key
  );
  const avatarFromMeta = readMetaString(nextMeta, 'avatar');
  const avatar = avatarFromMeta || buildAvatarText(nextName || row.public_key);
  const lastMessage = formatChatLastMessagePreview(row.last_message || '', nextMeta, row.type);
  const lastMessageAt = row.last_message_at || new Date(0).toISOString();
  const lastMessageAuthorPublicKey =
    row.last_message_at &&
    lastMessageAuthorSnapshot &&
    toComparableTimestamp(lastMessageAuthorSnapshot.at) === toComparableTimestamp(lastMessageAt)
      ? lastMessageAuthorSnapshot.authorPublicKey
      : null;

  return {
    id: row.public_key,
    publicKey: row.public_key,
    epochPublicKey: readMetaString(nextMeta, 'current_epoch_public_key') || null,
    type: row.type,
    name: nextName,
    avatar,
    lastMessage,
    lastMessageAuthorPublicKey,
    lastMessageAt,
    unreadCount: row.unread_count,
    meta: nextMeta,
  };
}

function buildAcceptedChatMeta(
  meta: Record<string, unknown>,
  acceptedAt: string,
  lastOutgoingMessageAt = ''
): ChatMetadata {
  const nextMeta: ChatMetadata = {
    ...(meta as ChatMetadata),
    [CHAT_INBOX_STATE_META_KEY]: 'accepted',
    [CHAT_ACCEPTED_AT_META_KEY]: acceptedAt,
  };

  if (lastOutgoingMessageAt) {
    const currentOutgoingAt = readMetaString(nextMeta, CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY);
    if (toComparableTimestamp(lastOutgoingMessageAt) > toComparableTimestamp(currentOutgoingAt)) {
      nextMeta[CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY] = lastOutgoingMessageAt;
    }
    syncMetaLatestTimestamp(
      nextMeta,
      LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY,
      lastOutgoingMessageAt
    );
  }

  delete nextMeta[CHAT_BLOCKED_AT_META_KEY];
  delete nextMeta[CHAT_REQUEST_CLEARED_AT_META_KEY];
  return nextMeta;
}

function buildBlockedChatMeta(meta: Record<string, unknown>, blockedAt: string): ChatMetadata {
  return {
    ...(meta as ChatMetadata),
    [CHAT_INBOX_STATE_META_KEY]: 'blocked',
    [CHAT_BLOCKED_AT_META_KEY]: blockedAt,
  };
}

function buildUpdatedChatPreview(
  chat: Chat,
  text: string,
  at: string,
  isVisible: boolean,
  messageMeta?: Record<string, unknown>,
  authorPublicKey?: string | null
): Chat {
  return {
    ...chat,
    lastMessage: formatChatLastMessagePreview(text, chat.meta, chat.type, messageMeta),
    lastMessageAuthorPublicKey: normalizeChatIdentifier(authorPublicKey),
    lastMessageAt: at,
    unreadCount: isVisible ? 0 : chat.unreadCount,
  };
}

function resolveRequestClearBoundaryAt(
  meta: Record<string, unknown>,
  messages: Array<{ created_at: string }>,
  fallbackAt: string | null | undefined
): string {
  const candidates = [
    readMetaString(meta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY),
    fallbackAt ?? '',
    ...messages.map((message) => message.created_at),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);

  const latestCandidate = candidates.reduce(
    (latest, candidate) =>
      toComparableTimestamp(candidate) > toComparableTimestamp(latest) ? candidate : latest,
    ''
  );

  return latestCandidate || new Date().toISOString();
}

export const __chatStoreTestUtils = {
  buildChatSearchText,
  buildAcceptedChatMeta,
  buildBlockedChatMeta,
  buildChatActivitySnapshotByPublicKey,
  buildLastMessageAuthorSnapshotByPublicKey,
  buildUpdatedChatPreview,
  chatMatchesSearch,
  countUnreadMessagesAfter,
  findLatestIncomingMessageAt,
  findLatestIncomingMessageActivity,
  mapChatRowToChat,
  resolveChatCategory,
  resolveDefaultSelectedChatId,
  resolveEffectiveLastSeenReceivedActivityAt,
  resolveMarkAsReadBoundaryAt,
  resolveRequestClearBoundaryAt,
  syncChatActivityMeta,
};

export const useChatStore = defineStore('chatStore', () => {
  const chats = ref<Chat[]>([]);
  const selectedChatId = ref<string | null>(null);
  const visibleChatId = ref<string | null>(null);
  const searchQuery = ref('');
  const composerDraftsByChatId = ref<Record<string, string>>({});
  const isLoaded = ref(false);
  let initPromise: Promise<void> | null = null;

  const selectedChat = computed(
    () => chats.value.find((chat) => chat.id === selectedChatId.value) ?? null
  );
  const inboxChats = computed(() =>
    chats.value.filter(
      (chat) => resolveChatCategory(chat.meta as Record<string, unknown>) === 'chat'
    )
  );
  const requestChats = computed(() =>
    chats.value.filter(
      (chat) => resolveChatCategory(chat.meta as Record<string, unknown>) === 'request'
    )
  );
  const visibleChats = computed(() =>
    inboxChats.value.filter((chat) => chatMatchesSearch(chat, searchQuery.value))
  );
  const requestCount = computed(() => requestChats.value.length);
  const unreadChatCount = computed(
    () =>
      chats.value.filter((chat) => {
        const category = resolveChatCategory(chat.meta as Record<string, unknown>);
        return category !== 'blocked' && category !== 'hidden' && chat.unreadCount > 0;
      }).length
  );
  const unreadMessageCount = computed(() =>
    chats.value.reduce((count, chat) => {
      const category = resolveChatCategory(chat.meta as Record<string, unknown>);
      if (category === 'blocked' || category === 'hidden') {
        return count;
      }

      const unreadCount = Number.isFinite(chat.unreadCount)
        ? Math.max(0, Math.floor(chat.unreadCount))
        : 0;
      return count + unreadCount;
    }, 0)
  );

  async function loadChatsIntoState(): Promise<void> {
    await Promise.all([chatDataService.init(), contactsService.init()]);
    const [rows, contacts, messageRows] = await Promise.all([
      chatDataService.listChats(),
      contactsService.listContacts(),
      chatDataService.listAllMessages(),
    ]);
    const contactContextByPublicKey = new Map<string, ChatContactContext>();
    const activitySnapshotByPublicKey = buildChatActivitySnapshotByPublicKey(
      messageRows,
      getLoggedInPublicKey()
    );
    const incomingMessageTimestampsByPublicKey = buildIncomingMessageTimestampsByPublicKey(
      messageRows,
      getLoggedInPublicKey()
    );
    const lastMessageAuthorSnapshotByPublicKey =
      buildLastMessageAuthorSnapshotByPublicKey(messageRows);
    const metaSyncPromises: Promise<void>[] = [];
    const unreadCountSyncPromises: Promise<void>[] = [];

    for (const contact of contacts) {
      contactContextByPublicKey.set(contact.public_key.toLowerCase(), toContactContext(contact));
    }

    chats.value = sortByLatest(
      rows.map((row) => {
        const contactContext = contactContextByPublicKey.get(row.public_key.toLowerCase());
        const nextMetaWithContactContext = syncChatMeta(
          row.meta,
          contactContext,
          contactContext?.givenName || contactContext?.contactName || row.name || row.public_key
        );
        let nextMeta = syncChatActivityMeta(
          nextMetaWithContactContext,
          activitySnapshotByPublicKey.get(row.public_key.toLowerCase())
        );
        const effectiveLastSeenReceivedActivityAt = resolveEffectiveLastSeenReceivedActivityAt(
          readMetaString(nextMeta, LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY),
          contactContext?.lastSeenIncomingActivityAt ?? '',
          readMetaString(nextMeta, CHAT_LAST_OUTGOING_MESSAGE_AT_META_KEY)
        );
        if (
          toComparableTimestamp(effectiveLastSeenReceivedActivityAt) >
          toComparableTimestamp(readMetaString(nextMeta, LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY))
        ) {
          nextMeta = {
            ...nextMeta,
            [LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY]: effectiveLastSeenReceivedActivityAt,
          };
        }
        if (nextMeta !== row.meta) {
          metaSyncPromises.push(
            chatDataService.updateChatMeta(row.public_key, nextMeta).catch((error) => {
              console.error('Failed to persist derived chat inbox metadata', error);
            })
          );
        }

        const normalizedUnreadCount = countUnreadMessagesAfter(
          incomingMessageTimestampsByPublicKey.get(row.public_key.toLowerCase()),
          effectiveLastSeenReceivedActivityAt
        );
        if (normalizedUnreadCount !== row.unread_count) {
          unreadCountSyncPromises.push(
            chatDataService
              .updateChatUnreadCount(row.public_key, normalizedUnreadCount)
              .catch((error) => {
                console.error('Failed to persist derived chat unread count', error);
              })
          );
        }

        return mapChatRowToChat(
          {
            ...row,
            unread_count: normalizedUnreadCount,
            meta: nextMeta,
          },
          contactContext,
          lastMessageAuthorSnapshotByPublicKey.get(row.public_key.toLowerCase())
        );
      })
    );
    await Promise.all([...metaSyncPromises, ...unreadCountSyncPromises]);

    if (selectedChatId.value && chats.value.some((chat) => chat.id === selectedChatId.value)) {
      return;
    }

    selectedChatId.value = resolveDefaultSelectedChatId(chats.value);
  }

  async function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          await loadChatsIntoState();
        } catch (error) {
          console.error('Failed to initialize chats', error);
          chats.value = [];
          selectedChatId.value = null;
        } finally {
          isLoaded.value = true;
        }
      })();
    }

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function reload(): Promise<void> {
    if (initPromise) {
      await initPromise;
    }

    try {
      await loadChatsIntoState();
    } catch (error) {
      console.error('Failed to reload chats', error);
      throw error;
    } finally {
      isLoaded.value = true;
    }
  }

  function selectChat(chatId: string): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    selectedChatId.value = normalizedChatId;
  }

  function setVisibleChatId(chatId: string | null): void {
    const nextChatId = normalizeChatIdentifier(chatId);
    visibleChatId.value = nextChatId;
  }

  async function setLastSeenReceivedActivityAt(chatId: string, at: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedAt = at.trim();
    if (!normalizedChatId || !normalizedAt) {
      return;
    }

    let nextMetaToPersist: Record<string, unknown> | null = null;
    const existingChat = chats.value.find((chat) => chat.id === normalizedChatId) ?? null;

    if (existingChat) {
      const currentMeta = existingChat.meta as Record<string, unknown>;
      const currentAt = readMetaString(currentMeta, LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY);
      if (toComparableTimestamp(currentAt) >= toComparableTimestamp(normalizedAt)) {
        return;
      }

      nextMetaToPersist = {
        ...currentMeta,
        [LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY]: normalizedAt,
      };

      chats.value = chats.value.map((chat) =>
        chat.id === normalizedChatId
          ? {
              ...chat,
              meta: nextMetaToPersist ?? chat.meta,
            }
          : chat
      );
    } else {
      await chatDataService.init();
      const existingRow = await chatDataService.getChatByPublicKey(normalizedChatId);
      if (!existingRow) {
        return;
      }

      const currentAt = readMetaString(existingRow.meta, LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY);
      if (toComparableTimestamp(currentAt) >= toComparableTimestamp(normalizedAt)) {
        return;
      }

      nextMetaToPersist = {
        ...existingRow.meta,
        [LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY]: normalizedAt,
      };
    }

    if (!nextMetaToPersist) {
      return;
    }

    try {
      await chatDataService.updateChatMeta(normalizedChatId, nextMetaToPersist);
    } catch (error) {
      console.error('Failed to persist last seen received activity for chat', error);
    }
  }

  function isRequestChat(chatId: string | null | undefined): boolean {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return false;
    }

    const chat = chats.value.find((candidate) => candidate.id === normalizedChatId);
    if (!chat) {
      return false;
    }

    return resolveChatCategory(chat.meta as Record<string, unknown>) === 'request';
  }

  async function recordIncomingActivity(chatId: string, at: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const normalizedAt = at.trim();
    if (!normalizedChatId || !normalizedAt) {
      return;
    }

    let nextMetaToPersist: ChatMetadata | null = null;
    const existingChat = chats.value.find((chat) => chat.id === normalizedChatId) ?? null;

    if (existingChat) {
      const currentMeta = existingChat.meta as Record<string, unknown>;
      const currentAt = readMetaString(currentMeta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY);
      if (toComparableTimestamp(currentAt) >= toComparableTimestamp(normalizedAt)) {
        return;
      }

      nextMetaToPersist = {
        ...(currentMeta as ChatMetadata),
        [CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY]: normalizedAt,
      };

      chats.value = chats.value.map((chat) =>
        chat.id === normalizedChatId
          ? {
              ...chat,
              meta: nextMetaToPersist ?? chat.meta,
            }
          : chat
      );
    } else {
      await chatDataService.init();
      const existingRow = await chatDataService.getChatByPublicKey(normalizedChatId);
      if (!existingRow) {
        return;
      }

      const currentAt = readMetaString(existingRow.meta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY);
      if (toComparableTimestamp(currentAt) >= toComparableTimestamp(normalizedAt)) {
        return;
      }

      nextMetaToPersist = {
        ...(existingRow.meta as ChatMetadata),
        [CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY]: normalizedAt,
      };
    }

    if (!nextMetaToPersist) {
      return;
    }

    try {
      await chatDataService.updateChatMeta(normalizedChatId, nextMetaToPersist);
    } catch (error) {
      console.error('Failed to persist inbound chat activity', error);
    }
  }

  async function acceptChat(
    chatId: string,
    options: {
      acceptedAt?: string;
      lastOutgoingMessageAt?: string;
    } = {}
  ): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    const acceptedAt =
      options.acceptedAt?.trim() ||
      options.lastOutgoingMessageAt?.trim() ||
      new Date().toISOString();
    const lastOutgoingMessageAt = options.lastOutgoingMessageAt?.trim() || '';
    if (!normalizedChatId || !acceptedAt) {
      return;
    }

    let nextMetaToPersist: ChatMetadata | null = null;
    let nextUnreadCountToPersist: number | null = null;
    let outgoingBoundaryMessageRows: Awaited<
      ReturnType<typeof chatDataService.listMessages>
    > | null = null;
    if (lastOutgoingMessageAt) {
      await chatDataService.init();
      outgoingBoundaryMessageRows = await chatDataService.listMessages(normalizedChatId);
    }
    const existingChat = chats.value.find((chat) => chat.id === normalizedChatId) ?? null;

    if (existingChat) {
      nextMetaToPersist = buildAcceptedChatMeta(
        existingChat.meta as Record<string, unknown>,
        acceptedAt,
        lastOutgoingMessageAt
      );
    } else {
      await chatDataService.init();
      const existingRow = await chatDataService.getChatByPublicKey(normalizedChatId);
      if (!existingRow) {
        return;
      }

      nextMetaToPersist = buildAcceptedChatMeta(
        existingRow.meta,
        acceptedAt,
        lastOutgoingMessageAt
      );
    }

    if (!nextMetaToPersist) {
      return;
    }

    if (outgoingBoundaryMessageRows) {
      const loggedInPublicKey = getLoggedInPublicKey();
      const incomingTimestamps = outgoingBoundaryMessageRows
        .filter((row) => {
          const authorPublicKey = normalizeChatIdentifier(row.author_public_key);
          return authorPublicKey && authorPublicKey !== loggedInPublicKey;
        })
        .map((row) => row.created_at);
      nextUnreadCountToPersist = countUnreadMessagesAfter(
        incomingTimestamps,
        readMetaString(nextMetaToPersist, LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY)
      );
    }

    if (existingChat) {
      chats.value = chats.value.map((chat) =>
        chat.id === normalizedChatId
          ? {
              ...chat,
              meta: nextMetaToPersist ?? chat.meta,
              unreadCount:
                nextUnreadCountToPersist === null ? chat.unreadCount : nextUnreadCountToPersist,
            }
          : chat
      );
    }

    try {
      await Promise.all([
        chatDataService.updateChatMeta(normalizedChatId, nextMetaToPersist),
        ...(nextUnreadCountToPersist === null
          ? []
          : [chatDataService.updateChatUnreadCount(normalizedChatId, nextUnreadCountToPersist)]),
      ]);
    } catch (error) {
      console.error('Failed to accept chat request', error);
    }
  }

  async function markAsRead(chatId: string): Promise<ChatReadCursor | null> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return null;
    }

    const existingChat = chats.value.find((chat) => chat.id === normalizedChatId) ?? null;
    let persistedMeta: Record<string, unknown> = {};
    if (!existingChat) {
      await chatDataService.init();
      const persistedChat = await chatDataService.getChatByPublicKey(normalizedChatId);
      if (
        persistedChat?.meta &&
        typeof persistedChat.meta === 'object' &&
        !Array.isArray(persistedChat.meta)
      ) {
        persistedMeta = persistedChat.meta as Record<string, unknown>;
      }
    }
    const currentMeta =
      existingChat?.meta &&
      typeof existingChat.meta === 'object' &&
      !Array.isArray(existingChat.meta)
        ? (existingChat.meta as Record<string, unknown>)
        : persistedMeta;
    const currentLastSeenReceivedActivityAt = readMetaString(
      currentMeta,
      LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY
    );
    const lastIncomingMessageAt = readMetaString(
      currentMeta,
      CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY
    );
    const latestIncomingActivity = findLatestIncomingMessageActivity(
      await chatDataService.listMessages(normalizedChatId),
      getLoggedInPublicKey()
    );
    const latestIncomingMessageAt = latestIncomingActivity?.at ?? '';
    const nextLastSeenReceivedActivityAt = resolveMarkAsReadBoundaryAt(
      currentLastSeenReceivedActivityAt,
      lastIncomingMessageAt,
      latestIncomingMessageAt
    );

    if (nextLastSeenReceivedActivityAt) {
      await setLastSeenReceivedActivityAt(normalizedChatId, nextLastSeenReceivedActivityAt);
    }

    await setUnreadCount(normalizedChatId, 0);
    const cursorAt =
      nextLastSeenReceivedActivityAt ||
      currentLastSeenReceivedActivityAt ||
      latestIncomingMessageAt;
    return cursorAt
      ? {
          at: cursorAt,
          eventId: latestIncomingActivity?.eventId ?? null,
        }
      : null;
  }

  async function muteChat(chatId: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const targetChat = chats.value.find((chat) => chat.id === normalizedChatId);
    if (!targetChat) {
      return;
    }

    const isAlreadyMuted = targetChat.meta.muted === true;
    if (isAlreadyMuted) {
      return;
    }

    const nextMeta = {
      ...(targetChat.meta as Record<string, unknown>),
      muted: true,
    };

    chats.value = chats.value.map((chat) =>
      chat.id === normalizedChatId
        ? {
            ...chat,
            meta: nextMeta,
          }
        : chat
    );

    try {
      await chatDataService.updateChatMeta(normalizedChatId, nextMeta);
    } catch (error) {
      console.error('Failed to mute chat', error);
    }
  }

  async function blockChat(chatId: string): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const blockedAt = new Date().toISOString();
    let nextMetaToPersist: ChatMetadata | null = null;

    chats.value = chats.value.map((chat) => {
      if (chat.id !== normalizedChatId) {
        return chat;
      }

      nextMetaToPersist = buildBlockedChatMeta(chat.meta as ChatMetadata, blockedAt);
      return {
        ...chat,
        unreadCount: 0,
        meta: nextMetaToPersist,
      };
    });

    if (!nextMetaToPersist) {
      await chatDataService.init();
      const existingRow = await chatDataService.getChatByPublicKey(normalizedChatId);
      if (!existingRow) {
        return;
      }

      nextMetaToPersist = buildBlockedChatMeta(existingRow.meta as ChatMetadata, blockedAt);
    }

    if (selectedChatId.value === normalizedChatId) {
      selectedChatId.value = resolveDefaultSelectedChatId(
        chats.value.filter((chat) => chat.id !== normalizedChatId)
      );
    }

    if (!nextMetaToPersist) {
      return;
    }

    try {
      await Promise.all([
        chatDataService.updateChatMeta(normalizedChatId, nextMetaToPersist),
        chatDataService.markChatAsRead(normalizedChatId),
      ]);
    } catch (error) {
      console.error('Failed to block chat request', error);
    }
  }

  async function deleteChat(chatId: string): Promise<boolean> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return false;
    }

    try {
      await chatDataService.init();
      const existingChat = chats.value.find((chat) => chat.id === normalizedChatId) ?? null;
      const existingRow = existingChat
        ? null
        : await chatDataService.getChatByPublicKey(normalizedChatId);
      const existingMeta = (existingChat?.meta ?? existingRow?.meta ?? {}) as Record<
        string,
        unknown
      >;
      const existingMessages = await chatDataService.listMessages(normalizedChatId);
      const isRequestLikeChat =
        resolveChatCategory(existingMeta) === 'request' ||
        resolveChatCategory(existingMeta) === 'hidden';

      if (isRequestLikeChat) {
        const requestClearedAt = resolveRequestClearBoundaryAt(
          existingMeta,
          existingMessages,
          existingChat?.lastMessageAt ?? existingRow?.last_message_at ?? null
        );
        const nextMeta = {
          ...existingMeta,
          [CHAT_REQUEST_CLEARED_AT_META_KEY]: requestClearedAt,
        };
        const cleared = await chatDataService.clearChatMessages(normalizedChatId, {
          last_message: '',
          last_message_at: requestClearedAt,
          unread_count: 0,
          meta: nextMeta,
        });
        if (!cleared) {
          return false;
        }
      } else {
        const deleted = await chatDataService.deleteChat(normalizedChatId);
        if (!deleted) {
          return false;
        }
      }

      try {
        await nostrEventDataService.deleteEventsByIds(
          existingMessages
            .map((message) => message.event_id)
            .filter(
              (eventId): eventId is string =>
                typeof eventId === 'string' && eventId.trim().length > 0
            )
        );
      } catch (error) {
        console.error('Failed to delete nostr events for chat', error);
      }

      const nextChats = chats.value.filter((chat) => chat.id !== normalizedChatId);
      chats.value = nextChats;
      const nextComposerDraftsByChatId = { ...composerDraftsByChatId.value };
      delete nextComposerDraftsByChatId[normalizedChatId];
      composerDraftsByChatId.value = nextComposerDraftsByChatId;

      if (selectedChatId.value === normalizedChatId) {
        selectedChatId.value = resolveDefaultSelectedChatId(nextChats);
      }

      return true;
    } catch (error) {
      console.error('Failed to delete chat', error);
      return false;
    }
  }

  function setSearchQuery(query: string | null | undefined): void {
    searchQuery.value = typeof query === 'string' ? query : '';
  }

  function getComposerDraft(chatId: string | null | undefined): string {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return '';
    }

    const storedDraft = composerDraftsByChatId.value[normalizedChatId];
    return typeof storedDraft === 'string' ? storedDraft : '';
  }

  function setComposerDraft(chatId: string | null | undefined, draft: string): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const normalizedDraft = typeof draft === 'string' ? draft : '';
    const currentDraft = composerDraftsByChatId.value[normalizedChatId] ?? '';
    if (currentDraft === normalizedDraft) {
      return;
    }

    if (!normalizedDraft) {
      if (!(normalizedChatId in composerDraftsByChatId.value)) {
        return;
      }

      const nextComposerDraftsByChatId = { ...composerDraftsByChatId.value };
      delete nextComposerDraftsByChatId[normalizedChatId];
      composerDraftsByChatId.value = nextComposerDraftsByChatId;
      return;
    }

    composerDraftsByChatId.value = {
      ...composerDraftsByChatId.value,
      [normalizedChatId]: normalizedDraft,
    };
  }

  function clearComposerDraft(chatId: string | null | undefined): void {
    setComposerDraft(chatId, '');
  }

  function clearAllComposerDrafts(): void {
    if (Object.keys(composerDraftsByChatId.value).length === 0) {
      return;
    }

    composerDraftsByChatId.value = {};
  }

  async function updateChatPreview(
    chatId: string,
    text: string,
    at: string,
    options: { messageMeta?: Record<string, unknown> } = {}
  ): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    let nextUnreadCount = 0;
    const authorPublicKey = getLoggedInPublicKey();
    let previewText = buildImageAttachmentPreviewText(text, options.messageMeta);
    let previewChatType: Chat['type'] | null = null;
    chats.value = sortByLatest(
      chats.value.map((chat) => {
        if (chat.id !== normalizedChatId) {
          return chat;
        }

        previewChatType = chat.type;
        const nextChat = buildUpdatedChatPreview(
          chat,
          text,
          at,
          visibleChatId.value === normalizedChatId,
          options.messageMeta,
          authorPublicKey
        );
        previewText = nextChat.lastMessage;
        nextUnreadCount = nextChat.unreadCount;
        return nextChat;
      })
    );

    try {
      if (text.includes('nostr:') && previewChatType !== 'user') {
        await contactsService.init();
        const contact = await contactsService.getContactByPublicKey(normalizedChatId);
        const contactPreviewText =
          contact?.type === 'group'
            ? formatGroupMentionsForDisplay(
                buildImageAttachmentPreviewText(text, options.messageMeta),
                contact.meta
              )
            : buildImageAttachmentPreviewText(text, options.messageMeta);
        if (contactPreviewText !== text && contactPreviewText !== previewText) {
          previewText = contactPreviewText;
          chats.value = sortByLatest(
            chats.value.map((chat) =>
              chat.id === normalizedChatId ? { ...chat, lastMessage: previewText } : chat
            )
          );
        }
      }

      await chatDataService.updateChatPreview(normalizedChatId, previewText, at, nextUnreadCount);
    } catch (error) {
      console.error('Failed to update chat preview', error);
    }
  }

  function setUnseenReactionCount(chatId: string, count: number): void {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));

    chats.value = chats.value.map((chat) => {
      if (chat.id !== normalizedChatId) {
        return chat;
      }

      const currentMeta = chat.meta as Record<string, unknown>;
      const currentCount = readMetaNumber(currentMeta, 'unseen_reaction_count') ?? 0;
      if (currentCount === normalizedCount) {
        return chat;
      }

      const nextMeta = { ...currentMeta };
      if (normalizedCount > 0) {
        nextMeta.unseen_reaction_count = normalizedCount;
      } else {
        delete nextMeta.unseen_reaction_count;
      }

      return {
        ...chat,
        meta: nextMeta,
      };
    });
  }

  async function setUnreadCount(chatId: string, count: number): Promise<void> {
    const normalizedChatId = normalizeChatIdentifier(chatId);
    if (!normalizedChatId) {
      return;
    }

    const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));

    chats.value = chats.value.map((chat) =>
      chat.id === normalizedChatId
        ? {
            ...chat,
            unreadCount: normalizedCount,
          }
        : chat
    );

    try {
      await chatDataService.updateChatUnreadCount(normalizedChatId, normalizedCount);
    } catch (error) {
      console.error('Failed to persist chat unread count', error);
    }
  }

  function applyIncomingMessage(input: LiveChatPreviewInput): void {
    const nextPublicKey = normalizeChatIdentifier(input.publicKey);

    if (!nextPublicKey) {
      return;
    }

    const fallbackName = input.fallbackName.trim() || nextPublicKey;
    const authorPublicKey = normalizeChatIdentifier(input.authorPublicKey);
    const nextChatId = nextPublicKey;
    const existingChat = chats.value.find((chat) => chat.id === nextChatId) ?? null;
    const currentMeta = {
      ...((existingChat?.meta as Record<string, unknown> | undefined) ?? {}),
      ...(input.meta ? { ...input.meta } : {}),
    };
    const currentIncomingAt = readMetaString(currentMeta, CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY);
    if (toComparableTimestamp(input.at) > toComparableTimestamp(currentIncomingAt)) {
      currentMeta[CHAT_LAST_INCOMING_MESSAGE_AT_META_KEY] = input.at;
    }
    const nextName = existingChat?.name || fallbackName;
    const nextMeta = syncChatMeta(currentMeta, undefined, nextName || nextPublicKey);
    const nextType =
      existingChat?.type ?? (Array.isArray(input.meta?.group_members) ? 'group' : 'user');
    const nextAvatar =
      readMetaString(nextMeta, 'avatar') ||
      existingChat?.avatar ||
      buildAvatarText(nextName || nextPublicKey);
    const nextChat: Chat = {
      id: nextChatId,
      publicKey: existingChat?.publicKey || nextPublicKey,
      epochPublicKey:
        existingChat?.epochPublicKey ||
        readMetaString(nextMeta, 'current_epoch_public_key') ||
        null,
      type: nextType,
      name: nextName,
      avatar: nextAvatar,
      lastMessage: formatChatLastMessagePreview(
        input.messageText,
        nextMeta,
        nextType,
        input.messageMeta
      ),
      lastMessageAuthorPublicKey: authorPublicKey,
      lastMessageAt: input.at,
      unreadCount: visibleChatId.value === nextChatId ? 0 : Math.max(0, input.unreadCount),
      meta: nextMeta,
    };

    if (existingChat) {
      chats.value = sortByLatest(
        chats.value.map((chat) => (chat.id === nextChatId ? nextChat : chat))
      );
      return;
    }

    chats.value = sortByLatest([...chats.value, nextChat]);
  }

  async function addContact(
    nameOrIdentifier: string,
    publicKey = nameOrIdentifier,
    options: AddContactOptions = {}
  ): Promise<Chat | null> {
    const cleanName = nameOrIdentifier.trim();
    const cleanPublicKey =
      normalizeChatIdentifier(publicKey) ?? normalizeChatIdentifier(cleanName) ?? '';

    if (!cleanName || !cleanPublicKey) {
      return null;
    }

    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(cleanPublicKey);
    const contactContext = contact
      ? toContactContext(contact)
      : toContactContextFromOptions(options, cleanName);

    const existingInStore = chats.value.find(
      (chat) => chat.publicKey.toLowerCase() === cleanPublicKey.toLowerCase()
    );
    if (existingInStore) {
      const nextName = contactContext?.contactName || existingInStore.name;
      const nextMeta = syncChatMeta(
        existingInStore.meta as Record<string, unknown>,
        contactContext,
        contactContext?.givenName || nextName || cleanPublicKey
      );
      if (nextMeta === existingInStore.meta && nextName === existingInStore.name) {
        return existingInStore;
      }

      let nextChat: Chat | null = null;
      chats.value = chats.value.map((chat) => {
        if (chat.id !== existingInStore.id) {
          return chat;
        }

        nextChat = {
          ...chat,
          name: nextName,
          avatar: readMetaString(nextMeta, 'avatar') || chat.avatar,
          meta: nextMeta,
        };
        return nextChat;
      });

      return nextChat ?? existingInStore;
    }

    const existingInDb = await chatDataService.getChatByPublicKey(cleanPublicKey);
    if (existingInDb) {
      const mapped = mapChatRowToChat(existingInDb, contactContext);
      if (!chats.value.some((chat) => chat.id === mapped.id)) {
        chats.value = sortByLatest([...chats.value, mapped]);
      }

      return mapped;
    }

    const now = new Date().toISOString();
    const created = await chatDataService.createChat({
      public_key: cleanPublicKey,
      type: 'user',
      name: cleanName,
      last_message: '',
      last_message_at: now,
      unread_count: 0,
      meta: {
        avatar: buildAvatarText(
          contactContext?.givenName || contactContext?.contactName || cleanName
        ),
        ...(contactContext?.picture ? { picture: contactContext.picture } : {}),
        ...(contactContext?.givenName ? { given_name: contactContext.givenName } : {}),
        ...(contactContext?.contactName ? { contact_name: contactContext.contactName } : {}),
        [CHAT_INBOX_STATE_META_KEY]: 'accepted',
        [CHAT_ACCEPTED_AT_META_KEY]: now,
      },
    });
    if (!created) {
      return null;
    }

    const newChat = mapChatRowToChat(created, contactContext);
    chats.value = sortByLatest([...chats.value, newChat]);
    return newChat;
  }

  async function syncContactProfile(publicKey: string): Promise<void> {
    const normalizedPublicKey = publicKey.trim().toLowerCase();
    if (!normalizedPublicKey) {
      return;
    }

    await Promise.all([chatDataService.init(), contactsService.init()]);

    const existingChatRow = await chatDataService.getChatByPublicKey(normalizedPublicKey);
    const existingChatInStore = chats.value.find(
      (chat) => chat.publicKey.trim().toLowerCase() === normalizedPublicKey
    );
    if (!existingChatRow && !existingChatInStore) {
      return;
    }

    const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return;
    }

    const contactContext = toContactContext(contact);
    const currentName = existingChatRow?.name || existingChatInStore?.name || normalizedPublicKey;
    const nextName = contactContext.contactName || currentName;
    const currentMeta =
      (existingChatRow?.meta as Record<string, unknown> | undefined) ??
      (existingChatInStore?.meta as Record<string, unknown> | undefined) ??
      {};
    const nextMeta = syncChatMeta(
      currentMeta,
      contactContext,
      contactContext.givenName || nextName || normalizedPublicKey
    );
    const nextAvatar =
      readMetaString(nextMeta, 'avatar') || buildAvatarText(nextName || normalizedPublicKey);

    if (existingChatRow) {
      await chatDataService.updateChat(existingChatRow.id, {
        name: nextName,
        meta: nextMeta,
      });
    }

    if (!isLoaded.value || !existingChatInStore) {
      await reload();
      return;
    }

    chats.value = sortByLatest(
      chats.value.map((chat) =>
        chat.publicKey.trim().toLowerCase() === normalizedPublicKey
          ? {
              ...chat,
              name: nextName,
              avatar: nextAvatar,
              meta: nextMeta,
            }
          : chat
      )
    );
  }

  if (getLoggedInPublicKey()) {
    void init().catch((error) => {
      console.error('Failed to preload chats', error);
    });
  }

  return {
    chats,
    inboxChats,
    visibleChats,
    requestChats,
    requestCount,
    unreadChatCount,
    unreadMessageCount,
    isLoaded,
    searchQuery,
    composerDraftsByChatId,
    selectedChat,
    selectedChatId,
    visibleChatId,
    isRequestChat,
    recordIncomingActivity,
    acceptChat,
    markAsRead,
    muteChat,
    blockChat,
    deleteChat,
    init,
    reload,
    selectChat,
    setVisibleChatId,
    setSearchQuery,
    getComposerDraft,
    setComposerDraft,
    clearComposerDraft,
    clearAllComposerDrafts,
    updateChatPreview,
    setLastSeenReceivedActivityAt,
    setUnreadCount,
    setUnseenReactionCount,
    applyIncomingMessage,
    addContact,
    syncContactProfile,
  };
});
