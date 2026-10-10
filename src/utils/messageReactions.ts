import type { MessageReaction } from '#src/types/chat.ts';

function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizePublicKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

export function isMessageReaction(value: unknown): value is MessageReaction {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MessageReaction>;
  return (
    typeof candidate.emoji === 'string' &&
    candidate.emoji.trim().length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.reactorPublicKey === 'string' &&
    candidate.reactorPublicKey.trim().length > 0 &&
    (candidate.createdAt === undefined ||
      candidate.createdAt === null ||
      (typeof candidate.createdAt === 'string' && candidate.createdAt.trim().length > 0)) &&
    (candidate.eventId === undefined ||
      candidate.eventId === null ||
      (typeof candidate.eventId === 'string' && candidate.eventId.trim().length > 0)) &&
    (candidate.viewedByAuthorAt === undefined ||
      candidate.viewedByAuthorAt === null ||
      (typeof candidate.viewedByAuthorAt === 'string' &&
        candidate.viewedByAuthorAt.trim().length > 0))
  );
}

export function normalizeMessageReactions(value: unknown): MessageReaction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isMessageReaction).map((reaction) => ({
    emoji: reaction.emoji.trim(),
    name: reaction.name.trim(),
    reactorPublicKey: reaction.reactorPublicKey.trim().toLowerCase(),
    ...(normalizeTimestamp(reaction.createdAt)
      ? { createdAt: normalizeTimestamp(reaction.createdAt) }
      : {}),
    ...(normalizeEventId(reaction.eventId) ? { eventId: normalizeEventId(reaction.eventId) } : {}),
    ...(normalizeTimestamp(reaction.viewedByAuthorAt)
      ? { viewedByAuthorAt: normalizeTimestamp(reaction.viewedByAuthorAt) }
      : {}),
  }));
}

export function areMessageReactionsEqual(first: MessageReaction, second: MessageReaction): boolean {
  return (
    first.emoji === second.emoji &&
    first.name === second.name &&
    first.reactorPublicKey === second.reactorPublicKey &&
    normalizeTimestamp(first.createdAt) === normalizeTimestamp(second.createdAt) &&
    normalizeEventId(first.eventId) === normalizeEventId(second.eventId) &&
    normalizeTimestamp(first.viewedByAuthorAt) === normalizeTimestamp(second.viewedByAuthorAt)
  );
}

export function isReactionUnseenForAuthor(
  reaction: MessageReaction,
  authorPublicKey: string | null | undefined
): boolean {
  const normalizedAuthorPublicKey = normalizePublicKey(authorPublicKey);
  if (!normalizedAuthorPublicKey) {
    return false;
  }

  return (
    reaction.reactorPublicKey !== normalizedAuthorPublicKey &&
    !normalizeTimestamp(reaction.viewedByAuthorAt)
  );
}

export function countUnseenReactionsForAuthor(
  reactions: MessageReaction[],
  authorPublicKey: string | null | undefined
): number {
  return reactions.reduce((count, reaction) => {
    return count + (isReactionUnseenForAuthor(reaction, authorPublicKey) ? 1 : 0);
  }, 0);
}

export function markReactionsViewedByAuthor(
  reactions: MessageReaction[],
  authorPublicKey: string | null | undefined,
  viewedAt: string
): MessageReaction[] {
  const normalizedViewedAt = normalizeTimestamp(viewedAt) ?? new Date().toISOString();

  return reactions.map((reaction) => {
    if (!isReactionUnseenForAuthor(reaction, authorPublicKey)) {
      return reaction;
    }

    return {
      ...reaction,
      viewedByAuthorAt: normalizedViewedAt,
    };
  });
}

export function buildMetaWithReactions(
  meta: Record<string, unknown>,
  reactions: MessageReaction[]
): Record<string, unknown> {
  const nextMeta = { ...meta };

  if (reactions.length === 0) {
    delete nextMeta.reactions;
    return nextMeta;
  }

  nextMeta.reactions = reactions.map((reaction) => ({ ...reaction }));
  return nextMeta;
}
