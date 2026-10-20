import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { Message } from '#src/types/chat.ts';
import { botCommandVisibility } from '#src/utils/botCommandVisibility.ts';
import { commandFromTags } from '#src/stores/nostr/botKeyboardProtocol.ts';

const bot = 'b'.repeat(64),
  user = 'a'.repeat(64),
  commandId = 'c'.repeat(64),
  cardId = 'd'.repeat(64);
function fixture(type: 'dm' | 'private' | 'public' = 'public') {
  const chat = type === 'dm' ? bot : type === 'public' ? `34550:${user}:room` : user;
  const command: Message = {
    id: 'command',
    eventId: commandId,
    chatId: chat,
    authorPublicKey: user,
    text: `nostr:${nip19.npubEncode(bot)} What should we watch?\nThe Wire\nThe Sopranos`,
    sentAt: '2026-01-01T00:00:00Z',
    sender: 'me',
    nostrEvent: null,
    meta: {},
  };
  const card: Message = {
    id: 'card',
    eventId: cardId,
    chatId: chat,
    authorPublicKey: bot,
    text: 'What should we watch?',
    sentAt: '2026-01-01T00:00:02Z',
    sender: 'them',
    nostrEvent: null,
    meta: {
      inline_keyboard: { inline_keyboard: [[{ text: 'The Wire', callback_data: 'vote:0' }]] },
      inline_keyboard_version: cardId,
      inline_keyboard_chat_type: type,
      bot_command: commandId,
    },
  };
  return { command, card };
}
describe('bot command collapsing', () => {
  for (const type of ['dm', 'private', 'public'] as const)
    it(`${type}: collapses only the addressed command and supports reveal without mutating messages`, () => {
      const { command, card } = fixture(type);
      if (type === 'dm') command.text = 'What should we watch?\nThe Wire\nThe Sopranos';
      const rows = [command, card];
      const before = JSON.stringify(rows);
      expect([...botCommandVisibility(rows).hidden]).toEqual(['command']);
      expect(botCommandVisibility(rows).commands.get('card')).toBe(command);
      expect(botCommandVisibility(rows, new Set(['command'])).hidden.size).toBe(0);
      expect(botCommandVisibility([command]).hidden.size).toBe(0);
      expect(botCommandVisibility([card]).commands.size).toBe(0);
      expect(JSON.stringify(rows)).toBe(before);
    });
  const hostile: [string, (command: Message, card: Message) => void][] = [
    [
      'unrelated conversation',
      (m) => {
        m.chatId = 'other';
      },
    ],
    [
      'wrong bot',
      (_, c) => {
        c.authorPublicKey = 'e'.repeat(64);
      },
    ],
    [
      'ordinary message',
      (m) => {
        m.text = 'Hello everyone';
      },
    ],
    [
      'mention in passing',
      (m) => {
        m.text = `I spoke to ${m.text}`;
      },
    ],
    [
      'display-name impersonation',
      (m) => {
        m.text = '@AnagramPollBot question';
      },
    ],
    [
      'missing command',
      (_, c) => {
        c.meta.bot_command = 'e'.repeat(64);
      },
    ],
    [
      'edited command',
      (m) => {
        m.meta.edited = true;
      },
    ],
    [
      'deleted command',
      (m) => {
        m.meta.deleted = {} as never;
      },
    ],
    [
      'deleted response',
      (_, c) => {
        c.meta.deleted = {} as never;
      },
    ],
    [
      'help response',
      (_, c) => {
        delete c.meta.inline_keyboard;
      },
    ],
    [
      'empty keyboard',
      (_, c) => {
        c.meta.inline_keyboard = { inline_keyboard: [] };
      },
    ],
    [
      'stale keyboard',
      (_, c) => {
        c.meta.inline_keyboard_version = 'e'.repeat(64);
      },
    ],
    [
      'old command',
      (_, c) => {
        c.sentAt = '2026-01-02T00:00:00Z';
      },
    ],
    [
      'response before command',
      (_, c) => {
        c.sentAt = '2025-12-31T23:59:59Z';
      },
    ],
    [
      'reply to someone else',
      (m) => {
        m.meta.reply = {} as never;
      },
    ],
    [
      'another bot card',
      (m, c) => {
        m.meta.inline_keyboard = c.meta.inline_keyboard;
      },
    ],
    [
      'missing validated chat type',
      (_, c) => {
        delete c.meta.inline_keyboard_chat_type;
      },
    ],
    [
      'same-author claim',
      (m, c) => {
        m.authorPublicKey = c.authorPublicKey;
      },
    ],
  ];
  for (const [name, alter] of hostile)
    it(`rejects ${name}`, () => {
      const { command, card } = fixture();
      alter(command, card);
      expect(botCommandVisibility([command, card]).hidden.size).toBe(0);
      expect(botCommandVisibility([command, card]).commands.size).toBe(0);
    });
  it('requires a single exact versioned command reference', () => {
    const tag = ['anagram-bot-command', '1', commandId];
    expect(commandFromTags([tag])).toBe(commandId);
    for (const tags of [
      [],
      [tag, tag],
      [[...tag, 'extra']],
      [['anagram-bot-command', '2', commandId]],
      [['anagram-bot-command', '1', '*']],
    ])
      expect(commandFromTags(tags)).toBeNull();
  });
  it('does not let a bot collapse call history in its DM conversation', () => {
    const { command, card } = fixture('dm');
    command.text = 'Audio call';
    command.meta.call_history = { mode: 'audio' };
    expect(botCommandVisibility([command, card]).hidden.size).toBe(0);
  });
});
