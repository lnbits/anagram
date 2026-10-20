import type { Message } from '#src/types/chat.ts';
import { HEX, parseKeyboard } from '#src/stores/nostr/botKeyboardProtocol.ts';
import { parseNostrMentions } from './nostrMentions.ts';

// Presentation only: examine the bounded, already-authenticated message window.
// Missing commands/cards remain visible; never fetch history to collapse a row.
export function botCommandVisibility(messages: Message[], revealed = new Set<string>()) {
  const byEvent = new Map(messages.filter((m) => m.eventId).map((m) => [m.eventId!, m]));
  const commands = new Map<string, Message>();
  const hidden = new Set<string>();
  for (const card of messages) {
    const reference = card.meta.bot_command;
    if (typeof reference !== 'string' || !HEX.test(reference)) continue;
    const command = byEvent.get(reference);
    const kind = card.meta.inline_keyboard_chat_type;
    const keyboard = parseKeyboard(card.meta.inline_keyboard);
    const delay = Date.parse(card.sentAt) - Date.parse(command?.sentAt ?? '');
    if (
      !command ||
      command.id === card.id ||
      command.chatId !== card.chatId ||
      command.authorPublicKey === card.authorPublicKey ||
      command.meta.deleted ||
      command.meta.edited ||
      command.meta.inline_keyboard ||
      command.meta.reply ||
      command.meta.call_history ||
      command.meta.group_epoch_notice ||
      command.meta.attachments?.length ||
      command.meta.reactions?.length ||
      card.meta.deleted ||
      !card.eventId ||
      card.meta.inline_keyboard_version !== card.eventId ||
      !card.text.trim() ||
      !keyboard?.inline_keyboard.some((row) => row.some((b) => b.callback_data)) ||
      !['dm', 'private', 'public'].includes(String(kind)) ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 5 * 60_000
    )
      continue;
    // Group commands must start with the bot's actual Nostr identity. Display
    // names, p tags, or a mention buried in ordinary conversation grant nothing.
    const text = (command.nostrEvent?.event.content ?? command.text).trimStart();
    const first = parseNostrMentions(text)[0];
    const addressed =
      kind === 'dm'
        ? card.chatId === card.authorPublicKey
        : first?.start === 0 && first.publicKey === card.authorPublicKey;
    if (!addressed) continue;
    commands.set(card.id, command);
    if (!revealed.has(command.id)) hidden.add(command.id);
  }
  return { commands, hidden };
}
