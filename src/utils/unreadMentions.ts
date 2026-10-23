import { isIncomingUnreadMessageActivity } from '#src/utils/messageActivity.ts';

export const UNREAD_MENTION_AT_META_KEY = 'unread_mention_at';

// Any of these marks everything up to it as read; see chatDataService chat_activity.
const SEEN_BOUNDARY_META_KEYS = [
  'last_seen_received_activity_at',
  'last_seen_incoming_activity_at',
  'last_outgoing_message_at',
] as const;

interface MentionRowLike {
  author_public_key?: unknown;
  meta?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTimestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function readChatSeenBoundaryAt(meta: unknown): string {
  if (!isPlainRecord(meta)) {
    return '';
  }

  let latest = '';
  for (const key of SEEN_BOUNDARY_META_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && toTimestamp(value) > toTimestamp(latest)) {
      latest = value;
    }
  }
  return latest;
}

export function isAfterChatSeenBoundary(meta: unknown, at: string): boolean {
  return toTimestamp(at) > toTimestamp(readChatSeenBoundaryAt(meta));
}

/** Another member's live message whose text references the logged-in user. */
export function isIncomingMentionRow(
  row: MentionRowLike,
  loggedInPublicKey: string | null | undefined,
): boolean {
  return (
    isPlainRecord(row.meta) &&
    row.meta.mentions_me === true &&
    !row.meta.deleted &&
    isIncomingUnreadMessageActivity(row, loggedInPublicKey)
  );
}

export function laterMentionAt(current: unknown, next: string): string {
  if (toTimestamp(next) > toTimestamp(current)) {
    return next;
  }
  return typeof current === 'string' ? current : '';
}

/**
 * Group chats show "@" while an unread message mentions the user. Marking the
 * chat read moves the seen boundary past the mention, so no extra reset is needed.
 */
export function hasUnreadChatMention(chat: {
  type: string;
  unreadCount: number;
  meta: unknown;
}): boolean {
  if (chat.type !== 'group' || !(chat.unreadCount > 0) || !isPlainRecord(chat.meta)) {
    return false;
  }

  const mentionAt = chat.meta[UNREAD_MENTION_AT_META_KEY];
  return typeof mentionAt === 'string' && isAfterChatSeenBoundary(chat.meta, mentionAt);
}
