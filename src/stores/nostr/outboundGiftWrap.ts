import { type NDKEvent, NDKKind, type NostrEvent } from '@nostr-dev-kit/ndk';
import { nostrEventDataService } from 'src/services/nostrEventDataService';

const pending = new Map<string, Promise<NostrEvent>>();

// Recipient and self are different ciphertexts even when published to the same relay.
// Commit the signed event before any network publication; an absent ACK is unknown delivery.
export function getOrCreateOutboundGiftWrap(
  rumor: NostrEvent,
  scope: 'recipient' | 'self',
  create: () => Promise<NDKEvent>
): Promise<NostrEvent> {
  const key = `${rumor.id}:${scope}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = (async () => {
    const stored = await nostrEventDataService.getEventById(rumor.id ?? '');
    const saved = stored?.gift_wraps?.[scope];
    if (saved?.id && saved.sig && saved.kind === NDKKind.GiftWrap) return saved;
    const event = await (await create()).toNostrEvent();
    const persisted = await nostrEventDataService.upsertEvent({
      event: rumor,
      direction: 'out',
      gift_wraps: { [scope]: event },
    });
    if (!persisted?.gift_wraps?.[scope])
      throw new Error('Failed to persist signed gift wrap before publication.');
    return persisted.gift_wraps[scope];
  })().finally(() => {
    pending.delete(key);
  });
  pending.set(key, operation);
  return operation;
}
