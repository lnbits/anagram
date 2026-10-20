import type { Snippet } from 'svelte';
import type { InlineButton, keyboardSections } from '#src/stores/nostr/botKeyboardProtocol.ts';

// The existing message body keeps reply previews, links and message actions while
// the keyboard supplies the button rows to render between text sections.
export const BOT_KEYBOARD_LAYOUT = Symbol('bot-keyboard-layout');
export interface BotKeyboardLayout {
  readonly messageId: string;
  readonly sections: ReturnType<typeof keyboardSections>;
  buttons: Snippet<[InlineButton[]]>;
}
