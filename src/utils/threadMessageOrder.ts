import type { Message } from '#src/types/chat.ts';
import { readMessageEditPreviousEventIds } from './messageEdits.ts';

// Only reorder the already-loaded display window. Keep database cursors and
// paging in their original timestamp/id order. Nostr timestamps have second
// precision, so a reply in the same second must follow its parent even when
// local millisecond timestamps, relay arrival order or event ids sort it first.
export function orderThreadMessages<T>(rows: readonly T[], messageFor: (row: T) => Message): T[] {
  const byId = new Map<string, T>();
  const byEvent = new Map<string, T>();
  const messages = new Map(rows.map((row) => [row, messageFor(row)]));
  for (const row of rows) {
    const message = messages.get(row)!;
    byId.set(message.id, row);
    for (const id of [message.eventId, ...readMessageEditPreviousEventIds(message.meta)]) {
      if (id) byEvent.set(id, row);
    }
  }
  const parents = new Map<T, T>();
  for (const row of rows) {
    const message = messages.get(row)!;
    const reply = message.meta.reply;
    if (!reply) continue;
    const parent = (reply.eventId && byEvent.get(reply.eventId)) || byId.get(reply.messageId);
    if (parent === undefined || parent === row) continue;
    const parentMessage = messages.get(parent)!;
    if (
      message.chatId === parentMessage.chatId &&
      Math.floor(Date.parse(message.sentAt) / 1000) ===
        Math.floor(Date.parse(parentMessage.sentAt) / 1000)
    )
      parents.set(row, parent);
  }
  const ordered: T[] = [];
  const emitted = new Set<T>();
  for (const row of rows) {
    const chain: T[] = [];
    const visiting = new Set<T>();
    let current: T | undefined = row;
    while (current !== undefined && !emitted.has(current) && !visiting.has(current)) {
      chain.push(current);
      visiting.add(current);
      current = parents.get(current);
    }
    // Invalid cyclic references must not hang or hide rows.
    for (const item of chain.reverse()) {
      emitted.add(item);
      ordered.push(item);
    }
  }
  return ordered;
}
