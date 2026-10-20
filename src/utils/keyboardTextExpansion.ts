import type { keyboardSections } from '#src/stores/nostr/botKeyboardProtocol.ts';
import { COLLAPSED_MESSAGE_CHARACTER_LIMIT } from '#src/utils/messageTextExpansion.ts';

// One text budget for the whole card, not a fresh budget for every button row.
// A partly hidden item loses its buttons until the user expands the message.
export function collapseKeyboardSections(
  sections: ReturnType<typeof keyboardSections>,
): ReturnType<typeof keyboardSections> {
  if (!sections) return null;
  let remaining = COLLAPSED_MESSAGE_CHARACTER_LIMIT;
  const visible: NonNullable<typeof sections> = [];
  for (const section of sections) {
    if (remaining < section.text.length) {
      visible.push({
        text: section.text.slice(0, Math.max(0, remaining)).trimEnd() + '...',
        row: [],
      });
      break;
    }
    visible.push(section);
    remaining -= section.text.length + 2; // Paragraph separator between sections.
  }
  return visible;
}
