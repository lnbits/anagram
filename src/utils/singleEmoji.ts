// Match one complete emoji, including modifiers, ZWJ sequences, flags and keycaps.
// Anchoring prevents ordinary text, numbers and multiple emoji from being enlarged.
const singleEmoji =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})$/u;
export function isSingleEmoji(text: string): boolean {
  return singleEmoji.test(text.trim());
}
