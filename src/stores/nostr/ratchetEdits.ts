import type { Rumor } from 'nostr-double-ratchet';
import { chatDataService } from '#src/services/chatDataService.ts';

export function ratchetEditTime(event: Rumor): number {
  return Number(event.tags.find((tag) => tag[0] === 'ms')?.[1] ?? event.created_at * 1000);
}

// Iris kind-1009 edits retain the original message ID and timestamp.
export async function applyRatchetEdit(
  event: Rumor,
  sender: string,
  owner: string,
): Promise<boolean> {
  const expiration = event.tags.find((tag) => tag[0] === 'expiration')?.[1];
  if (expiration !== undefined && Number(expiration) <= Date.now() / 1000) return true;
  const targetId = event.tags.find((tag) => tag[0] === 'e')?.[1];
  if (!targetId) return true;
  const target = await chatDataService.getMessageByEventId(targetId);
  if (!target) return false;
  const peer = sender === owner ? event.tags.find((tag) => tag[0] === 'p')?.[1] : sender;
  if (
    target.meta.protocol !== 'ndr' ||
    target.author_public_key !== sender ||
    target.chat_public_key !== peer ||
    target.meta.deleted ||
    event.created_at < Math.floor(Date.parse(target.created_at) / 1000)
  )
    return true;
  const editedAt = ratchetEditTime(event);
  const previousAt = Number(target.meta.ratchet_edit_at ?? 0);
  if (
    previousAt > editedAt ||
    (previousAt === editedAt && String(target.meta.ratchet_edit_id ?? '') >= event.id)
  )
    return true;
  const edited = await chatDataService.applyMessageEdit(target.id, {
    message: event.content,
    created_at: target.created_at,
    event_id: targetId,
    previous_event_id: targetId,
    edited_at: new Date(editedAt).toISOString(),
    meta: { ...target.meta, ratchet_edit_at: editedAt, ratchet_edit_id: event.id },
  });
  if (!edited) throw new Error('Could not save message edit.');
  const { useMessageStore } = await import('#src/stores/messageStore.svelte.ts');
  await useMessageStore().upsertPersistedMessage(edited);
  return true;
}
