import type { GroupMemberTicketDelivery } from '#src/types/chat.ts';

function normalizeComparableTimestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeMemberPublicKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeEventId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function groupMemberTicketDeliveryKey(memberPublicKey: string, epochNumber: number): string {
  return `${memberPublicKey.trim().toLowerCase()}:${Math.floor(epochNumber)}`;
}

export function normalizeGroupMemberTicketDelivery(
  value: unknown
): GroupMemberTicketDelivery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const memberPublicKey = normalizeMemberPublicKey(
    'member_public_key' in value ? value.member_public_key : ''
  );
  const epochNumber = Number('epoch_number' in value ? value.epoch_number : Number.NaN);
  const eventId = normalizeEventId('event_id' in value ? value.event_id : '');
  const createdAt =
    'created_at' in value && typeof value.created_at === 'string' ? value.created_at.trim() : '';

  if (
    !memberPublicKey ||
    !Number.isInteger(epochNumber) ||
    epochNumber < 0 ||
    !eventId ||
    !createdAt
  ) {
    return null;
  }

  return {
    member_public_key: memberPublicKey,
    epoch_number: Math.floor(epochNumber),
    event_id: eventId,
    created_at: createdAt,
  };
}

export function sortGroupMemberTicketDeliveries(
  first: GroupMemberTicketDelivery,
  second: GroupMemberTicketDelivery
): number {
  const byEpoch = second.epoch_number - first.epoch_number;
  if (byEpoch !== 0) {
    return byEpoch;
  }

  const byCreatedAt =
    normalizeComparableTimestamp(second.created_at) -
    normalizeComparableTimestamp(first.created_at);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  return first.member_public_key.localeCompare(second.member_public_key);
}

export function normalizeGroupMemberTicketDeliveries(value: unknown): GroupMemberTicketDelivery[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deliveriesByKey = new Map<string, GroupMemberTicketDelivery>();
  for (const entry of value) {
    const normalizedEntry = normalizeGroupMemberTicketDelivery(entry);
    if (!normalizedEntry) {
      continue;
    }

    deliveriesByKey.set(
      groupMemberTicketDeliveryKey(normalizedEntry.member_public_key, normalizedEntry.epoch_number),
      normalizedEntry
    );
  }

  return Array.from(deliveriesByKey.values()).sort(sortGroupMemberTicketDeliveries);
}

export function mergeGroupMemberTicketDeliveries(
  existingDeliveries: GroupMemberTicketDelivery[],
  nextDelivery: GroupMemberTicketDelivery
): GroupMemberTicketDelivery[] {
  return normalizeGroupMemberTicketDeliveries([...existingDeliveries, nextDelivery]);
}
