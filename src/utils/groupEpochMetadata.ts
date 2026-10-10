import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ChatGroupEpochKey } from '#src/types/chat.ts';

// Keep timestamp and signature together; recovery-only key writes must not erase a ticket.
export function preferGroupEpochInvitation(
  previous: ChatGroupEpochKey,
  next: ChatGroupEpochKey,
): ChatGroupEpochKey {
  if (!next.invitation_created_at || (previous.invitation_proof && !next.invitation_proof))
    return previous;
  const before = Date.parse(previous.invitation_created_at ?? '') || 0;
  const after = Date.parse(next.invitation_created_at) || 0;
  if (
    after < before ||
    (after === before &&
      previous.invitation_proof &&
      (previous.invitation_event_id ?? '') <= (next.invitation_event_id ?? ''))
  )
    return previous;
  return {
    ...previous,
    invitation_created_at: next.invitation_created_at,
    invitation_proof: next.invitation_proof,
    invitation_event_id: next.invitation_event_id,
  };
}

export function normalizeChatGroupEpochKeysValue(value: unknown): ChatGroupEpochKey[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entriesByEpoch = new Map<string, ChatGroupEpochKey>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const epochNumber = Number('epoch_number' in entry ? entry.epoch_number : Number.NaN);
    const epochPublicKey = inputSanitizerService.normalizeHexKey(
      'epoch_public_key' in entry && typeof entry.epoch_public_key === 'string'
        ? entry.epoch_public_key
        : '',
    );
    const epochPrivateKeyEncrypted =
      'epoch_private_key_encrypted' in entry &&
      typeof entry.epoch_private_key_encrypted === 'string'
        ? entry.epoch_private_key_encrypted.trim()
        : '';

    if (
      !Number.isSafeInteger(epochNumber) ||
      epochNumber < 0 ||
      !epochPublicKey ||
      !epochPrivateKeyEncrypted
    ) {
      continue;
    }

    entriesByEpoch.set(`${epochNumber}:${epochPublicKey}`, {
      epoch_number: Math.floor(epochNumber),
      epoch_public_key: epochPublicKey,
      epoch_private_key_encrypted: epochPrivateKeyEncrypted,
      ...('invitation_proof' in entry &&
      typeof entry.invitation_proof === 'string' &&
      /^[0-9a-f]{128}$/.test(entry.invitation_proof)
        ? { invitation_proof: entry.invitation_proof }
        : {}),
      ...('invitation_event_id' in entry &&
      typeof entry.invitation_event_id === 'string' &&
      /^[0-9a-f]{64}$/.test(entry.invitation_event_id)
        ? { invitation_event_id: entry.invitation_event_id }
        : {}),
      ...('invitation_created_at' in entry &&
      typeof entry.invitation_created_at === 'string' &&
      entry.invitation_created_at.trim()
        ? { invitation_created_at: entry.invitation_created_at.trim() }
        : {}),
    });
  }

  return Array.from(entriesByEpoch.values()).sort(
    (first, second) => second.epoch_number - first.epoch_number,
  );
}

// Tickets establish durable epoch keys. A profile, roster, or older ticket may
// have read an earlier chat snapshot; merge keys inside the database transaction
// so these independent writes cannot erase history or roll back the current key.
export function mergeGroupEpochMetadata(
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  // Only explicit local delete/reopen operations may change this marker.
  // Stale profile, ticket and owner-backup writes must preserve the stored choice.
  next = { ...next };
  if (stored.deleted_locally === true) next.deleted_locally = true;
  else delete next.deleted_locally;
  const epochs = new Map(
    normalizeChatGroupEpochKeysValue(stored.group_epoch_keys).map((entry) => [
      `${entry.epoch_number}:${entry.epoch_public_key}`,
      entry,
    ]),
  );
  for (const entry of normalizeChatGroupEpochKeysValue(next.group_epoch_keys)) {
    const previous = epochs.get(`${entry.epoch_number}:${entry.epoch_public_key}`);
    if (!previous) epochs.set(`${entry.epoch_number}:${entry.epoch_public_key}`, entry);
    else
      epochs.set(
        `${entry.epoch_number}:${entry.epoch_public_key}`,
        preferGroupEpochInvitation(previous, entry),
      );
  }
  const keys = [...epochs.values()].sort((a, b) => b.epoch_number - a.epoch_number);
  const current = keys[0];
  if (!current) return next;
  const conflict =
    keys.filter((entry) => entry.epoch_number === current.epoch_number).length > 1 ||
    Number(stored.group_conflicting_epoch ?? -1) >= current.epoch_number ||
    Number(next.group_conflicting_epoch ?? -1) >= current.epoch_number;
  return {
    ...next,
    group_conflicting_epoch: conflict ? current.epoch_number : -1,
    group_epoch_keys: keys,
    current_epoch_public_key: current.epoch_public_key,
    current_epoch_private_key_encrypted: current.epoch_private_key_encrypted,
    epoch_public_key: current.epoch_public_key,
  };
}
