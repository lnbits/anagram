import type { EditedMessageMetadata } from 'src/types/chat';

export const MESSAGE_EDIT_MARKER = 'edit';

function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readEditedMessageMetadata(value: unknown): EditedMessageMetadata | null {
  if (!isPlainRecord(value) || typeof value.editedAt !== 'string') {
    return null;
  }

  const editedAt = value.editedAt.trim();
  const previousEventIds = Array.from(
    new Set(
      (Array.isArray(value.previousEventIds) ? value.previousEventIds : [])
        .map((eventId) => normalizeEventId(eventId))
        .filter((eventId): eventId is string => Boolean(eventId))
    )
  );
  if (!editedAt || previousEventIds.length === 0) {
    return null;
  }

  return {
    editedAt,
    previousEventIds,
  };
}

export function readMessageEditPreviousEventIds(meta: Record<string, unknown>): string[] {
  return readEditedMessageMetadata(meta.edited)?.previousEventIds ?? [];
}

export function messageEditReferencesEventId(
  meta: Record<string, unknown>,
  eventId: string
): boolean {
  const normalizedEventId = normalizeEventId(eventId);
  return Boolean(
    normalizedEventId && readMessageEditPreviousEventIds(meta).includes(normalizedEventId)
  );
}

export function buildEditedMessageMeta(
  originalMeta: Record<string, unknown>,
  replacementMeta: Record<string, unknown>,
  previousEventId: string,
  editedAt: string
): Record<string, unknown> {
  const normalizedPreviousEventId = normalizeEventId(previousEventId);
  const normalizedEditedAt = editedAt.trim();
  const previousEventIds = Array.from(
    new Set([
      ...readMessageEditPreviousEventIds(originalMeta),
      ...readMessageEditPreviousEventIds(replacementMeta),
      ...(normalizedPreviousEventId ? [normalizedPreviousEventId] : []),
    ])
  );
  const nextMeta: Record<string, unknown> = {
    ...originalMeta,
    ...replacementMeta,
  };

  delete nextMeta.deleted;
  if (normalizedEditedAt && previousEventIds.length > 0) {
    nextMeta.edited = {
      editedAt: normalizedEditedAt,
      previousEventIds,
    } satisfies EditedMessageMetadata;
  }

  return nextMeta;
}

export function readMessageEditTargetEventId(tags: string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] !== 'e' || tag[3]?.trim().toLowerCase() !== MESSAGE_EDIT_MARKER) {
      continue;
    }

    const targetEventId = normalizeEventId(tag[1]);
    if (targetEventId) {
      return targetEventId;
    }
  }

  return null;
}

export function buildMessageEditTag(targetEventId: string): string[] | null {
  const normalizedTargetEventId = normalizeEventId(targetEventId);
  return normalizedTargetEventId ? ['e', normalizedTargetEventId, '', MESSAGE_EDIT_MARKER] : null;
}

export function areMessageEditTimestampsEqual(first: string, second: string): boolean {
  const firstTimestamp = new Date(first).getTime();
  const secondTimestamp = new Date(second).getTime();
  if (!Number.isFinite(firstTimestamp) || !Number.isFinite(secondTimestamp)) {
    return false;
  }

  return Math.floor(firstTimestamp / 1000) === Math.floor(secondTimestamp / 1000);
}
