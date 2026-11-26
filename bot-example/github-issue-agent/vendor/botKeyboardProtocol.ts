// Anagram extension, not an assigned NIP. No imports: bots can use this with Node 24.
export const BOT_CONTROL_KIND = 21118;
export const KEYBOARD_TAG = 'anagram-inline-keyboard';
export const CONTROL_TAG = 'anagram-bot';
export const COMMAND_TAG = 'anagram-bot-command';
// Bounded Anagram extensions allow complete magnets in ten three-action rows.
export const MAX_KEYBOARD_BYTES = 64 * 1024;
export const MAX_BUTTON_URL_BYTES = 4096;
export const MAX_COPY_TEXT_BYTES = 2048;
export const HEX = /^[0-9a-f]{64}$/;
export function commandFromTags(tags: string[][]): string | null {
  const matches = tags.filter((tag) => tag[0] === COMMAND_TAG);
  const tag = matches[0];
  return matches.length === 1 && tag.length === 3 && tag[1] === '1' && HEX.test(tag[2])
    ? tag[2]
    : null;
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Size is an Anagram extension; Telegram defines copy_text but no inline button size.
export type InlineButton = { text: string; size?: 'small' | 'medium' | 'large' } & (
  | { callback_data: string; url?: never; copy_text?: never }
  | { url: string; callback_data?: never; copy_text?: never }
  | { copy_text: { text: string }; callback_data?: never; url?: never }
);
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
  // Anagram extension: zero-based blank-line-separated paragraph for each row.
  row_after?: number[];
}
export interface BotTarget {
  type: 'dm' | 'private' | 'public';
  chat: string;
  root: string;
  version: string;
  bot: string;
}
export interface BotMembership {
  epoch: number;
  invited_at: number;
  invitation_proof: string;
}
export interface BotControl {
  op: 'request' | 'answer';
  id: string;
  target: BotTarget;
  expires: number;
  data?: string;
  // A personal keyboard's source is the bot's previous answer event.
  view?: string;
  membership?: BotMembership;
}

export function safeMagnetUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^magnet:\?/i.test(value) ||
    bytes(value) > MAX_BUTTON_URL_BYTES ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    const topics = url.searchParams.getAll('xt');
    return (
      url.protocol === 'magnet:' &&
      !url.host &&
      !url.pathname &&
      !url.hash &&
      topics.length === 1 &&
      /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(topics[0]) &&
      [...url.searchParams].every(([key, text]) => !/[\u0000-\u001f\u007f]/.test(key + text))
    );
  } catch {
    return false;
  }
}

export function safeButtonUrl(value: unknown): value is string {
  if (typeof value !== 'string' || bytes(value) > MAX_BUTTON_URL_BYTES) return false;
  if (safeMagnetUrl(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !/[\u0000-\u0020\u007f]/.test(value)
    );
  } catch {
    return false;
  }
}

export function parseKeyboard(value: unknown): InlineKeyboard | null {
  if (
    !record(value) ||
    Object.keys(value).some((k) => !['inline_keyboard', 'row_after'].includes(k))
  )
    return null;
  const rows = value.inline_keyboard;
  const positions = value.row_after;
  if (!Array.isArray(rows) || rows.length > ('row_after' in value ? 16 : 8)) return null;
  if (
    'row_after' in value &&
    (!Array.isArray(positions) ||
      positions.length !== rows.length ||
      positions.some(
        (position, i) =>
          !Number.isInteger(position) ||
          position < 0 ||
          position > 255 ||
          (i > 0 && position <= positions[i - 1]),
      ))
  )
    return null;
  let count = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length || row.length > 4) return null;
    for (const button of row) {
      if (
        !record(button) ||
        typeof button.text !== 'string' ||
        !button.text.trim() ||
        bytes(button.text) > 128 ||
        /[\u0000-\u001f\u007f]/.test(button.text) ||
        Object.keys(button).some(
          (k) => !['text', 'callback_data', 'url', 'copy_text', 'size'].includes(k),
        ) ||
        ('size' in button && !['small', 'medium', 'large'].includes(button.size as string))
      )
        return null;
      if (['callback_data', 'url', 'copy_text'].filter((key) => key in button).length !== 1)
        return null;
      if ('callback_data' in button) {
        if (
          typeof button.callback_data !== 'string' ||
          bytes(button.callback_data) < 1 ||
          bytes(button.callback_data) > 64
        )
          return null;
      } else if ('copy_text' in button) {
        const copy = button.copy_text;
        if (
          !record(copy) ||
          Object.keys(copy).some((key) => key !== 'text') ||
          typeof copy.text !== 'string' ||
          bytes(copy.text) < 1 ||
          bytes(copy.text) > MAX_COPY_TEXT_BYTES
        )
          return null;
      } else if (!safeButtonUrl(button.url)) return null;
      if (++count > 32) return null;
    }
  }
  if (bytes(JSON.stringify(value)) > MAX_KEYBOARD_BYTES) return null;
  return value as unknown as InlineKeyboard;
}

export function keyboardSections(
  keyboard: InlineKeyboard | null | undefined,
  text: string,
): { text: string; row: InlineButton[] }[] | null {
  if (!keyboard?.row_after?.length) return null;
  const paragraphs = text.split(/\r?\n[\t ]*\r?\n/);
  if (keyboard.row_after.at(-1)! >= paragraphs.length) return null;
  let start = 0;
  const sections = keyboard.row_after.map((after, i) => {
    const section = {
      text: paragraphs.slice(start, after + 1).join('\n\n'),
      row: keyboard.inline_keyboard[i],
    };
    start = after + 1;
    return section;
  });
  if (start < paragraphs.length)
    sections.push({ text: paragraphs.slice(start).join('\n\n'), row: [] });
  return sections;
}

export function keyboardFromTags(tags: string[][]): InlineKeyboard | null {
  const matches = tags.filter((t) => t[0] === KEYBOARD_TAG);
  if (
    matches.length !== 1 ||
    matches[0].length !== 3 ||
    matches[0][1] !== '1' ||
    bytes(matches[0][2]) > MAX_KEYBOARD_BYTES
  )
    return null;
  try {
    return parseKeyboard(JSON.parse(matches[0][2]));
  } catch {
    return null;
  }
}

export function keyboardTag(keyboard: InlineKeyboard): string[] {
  if (!parseKeyboard(keyboard)) throw new Error('Invalid inline keyboard');
  return [KEYBOARD_TAG, '1', JSON.stringify(keyboard)];
}

export function validTarget(value: unknown): value is BotTarget {
  if (
    !record(value) ||
    !['dm', 'private', 'public'].includes(value.type as string) ||
    typeof value.bot !== 'string' ||
    !HEX.test(value.bot) ||
    typeof value.root !== 'string' ||
    !HEX.test(value.root) ||
    typeof value.version !== 'string' ||
    !HEX.test(value.version) ||
    typeof value.chat !== 'string'
  )
    return false;
  return value.type === 'public'
    ? /^34550:[0-9a-f]{64}:[a-zA-Z0-9_-]{1,128}$/.test(value.chat)
    : HEX.test(value.chat) && (value.type !== 'dm' || value.chat === value.bot);
}

export function parseControl(tags: string[][]): BotControl | null {
  const matches = tags.filter((t) => t[0] === CONTROL_TAG);
  if (
    matches.length !== 1 ||
    matches[0].length !== 3 ||
    matches[0][1] !== '1' ||
    bytes(matches[0][2]) > 4096
  )
    return null;
  try {
    const v = JSON.parse(matches[0][2]);
    if (
      !record(v) ||
      !['request', 'answer'].includes(v.op as string) ||
      typeof v.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(v.id) ||
      !validTarget(v.target) ||
      !Number.isSafeInteger(v.expires) ||
      Number(v.expires) < 0 ||
      (v.view !== undefined && (typeof v.view !== 'string' || !HEX.test(v.view)))
    )
      return null;
    if (
      v.op === 'request' &&
      (typeof v.data !== 'string' || bytes(v.data) < 1 || bytes(v.data) > 64)
    )
      return null;
    if (v.target.type === 'private') {
      const m = v.membership;
      if (
        !record(m) ||
        !Number.isSafeInteger(m.epoch) ||
        Number(m.epoch) < 0 ||
        !Number.isSafeInteger(m.invited_at) ||
        Number(m.invited_at) < 0 ||
        typeof m.invitation_proof !== 'string' ||
        !/^[0-9a-f]{128}$/.test(m.invitation_proof)
      )
        return null;
    } else if (v.membership !== undefined) return null;
    return v as unknown as BotControl;
  } catch {
    return null;
  }
}

export function controlTag(control: BotControl): string[] {
  const tag = [CONTROL_TAG, '1', JSON.stringify(control)];
  if (!parseControl([tag])) throw new Error('Invalid bot control');
  return tag;
}

export const targetKey = (target: BotTarget) =>
  [target.type, target.chat, target.bot, target.root, target.version].join(':');

export function hasCallback(keyboard: InlineKeyboard | null, data: string): boolean {
  return !!keyboard?.inline_keyboard.some((row) => row.some((b) => b.callback_data === data));
}
