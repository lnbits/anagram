import { getEventHash, validateEvent, type UnsignedEvent } from 'nostr-tools';

/** Call only after verifying the seal signature and decrypting its content.
 * The signed seal authenticates the payload. A rumor's ID is derived data, not
 * a signature: older clients may omit it or send a stale value. Never trust that
 * value as a storage key, and never substitute the seal author for a mismatch. */
export function normalizeRumor(value: unknown, sealAuthor: string): UnsignedEvent & { id: string } {
  if (!validateEvent(value)) throw new Error('Invalid rumor structure');
  if (value.pubkey !== sealAuthor) throw new Error('Invalid rumor author');
  if (
    !Number.isSafeInteger(value.created_at) ||
    value.created_at < 0 ||
    !Number.isSafeInteger(value.kind) ||
    value.kind < 0
  )
    throw new Error('Invalid rumor structure');
  const rumor: UnsignedEvent = {
    pubkey: value.pubkey,
    kind: value.kind,
    created_at: value.created_at,
    tags: value.tags,
    content: value.content,
  };
  return { ...rumor, id: getEventHash(rumor) };
}
