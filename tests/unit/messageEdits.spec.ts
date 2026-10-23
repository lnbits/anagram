import {
  areMessageEditTimestampsEqual,
  buildEditedMessageMeta,
  buildMessageEditTag,
  messageEditReferencesEventId,
  readEditedMessageMetadata,
  readMessageEditTargetEventId,
  withoutEditSelfReply,
} from '#src/utils/messageEdits.ts';
import { describe, expect, it } from 'vitest';

describe('message edit helpers', () => {
  it('builds and reads the private edit marker tag', () => {
    const eventId = 'A'.repeat(64);
    const tag = buildMessageEditTag(eventId);

    expect(tag).toEqual(['e', eventId.toLowerCase(), '', 'edit']);
    expect(readMessageEditTargetEventId([['p', 'recipient'], tag ?? []])).toBe(
      eventId.toLowerCase(),
    );
  });

  it('preserves the empty relay slot in edit marker tags on kind 14 rumors', () => {
    const runtime = createMessageEventRuntime({
      issueOwnGroupInvitation: async () => null,
      getLoggedInPublicKeyHex: () => null,
      decryptPrivateStringContent: async () => null,
      derivePublicKeyFromPrivateKey: () => null,
      findGroupChatEpochContextByRecipientPubkey: async () => null,
      getOrCreateSigner: async () => ({}) as never,
      ndk: new NostrClient(),
      readEpochNumberTag: () => null,
      readFirstTagValue: () => null,
    });
    const eventId = 'a'.repeat(64);
    const rumor = runtime.createDirectMessageRumorEvent(
      'b'.repeat(64),
      'c'.repeat(64),
      'Edited text',
      1_767_225_600,
      null,
      [['e', eventId, '', 'edit']],
    );

    expect(rumor.tags).toContainEqual(['e', eventId, '', 'edit']);
    expect(runtime.readReplyTargetEventId(rumor)).toBeNull();
    const parent = 'd'.repeat(64);
    // Explicit and legacy unmarked replies still work alongside an edit link.
    for (const marker of ['reply', '']) {
      rumor.tags = [
        ['e', eventId, '', ' EDIT '],
        ['e', parent, '', marker],
      ];
      expect(runtime.readReplyTargetEventId(rumor)).toBe(parent);
    }
  });

  it('accumulates predecessor ids while clearing deletion metadata', () => {
    const firstEventId = 'a'.repeat(64);
    const secondEventId = 'b'.repeat(64);
    const meta = buildEditedMessageMeta(
      {
        deleted: { deletedAt: '2026-01-01T00:00:01.000Z' },
        edited: {
          editedAt: '2026-01-01T00:00:02.000Z',
          previousEventIds: [firstEventId],
        },
      },
      { source: 'nostr' },
      secondEventId,
      '2026-01-01T00:00:03.000Z',
    );

    expect(meta.deleted).toBeUndefined();
    expect(readEditedMessageMetadata(meta.edited)).toEqual({
      editedAt: '2026-01-01T00:00:03.000Z',
      previousEventIds: [firstEventId, secondEventId],
    });
    expect(messageEditReferencesEventId(meta, firstEventId)).toBe(true);
    expect(messageEditReferencesEventId(meta, secondEventId)).toBe(true);
  });

  it('takes mentions from the replacement text, never from the original', () => {
    const original = {
      mentions: [{ publicKey: 'b'.repeat(64) }],
      mentions_me: true,
    };
    const removed = buildEditedMessageMeta(original, { source: 'nostr' }, 'old-id', 'edited-at');
    expect(removed.mentions).toBeUndefined();
    expect(removed.mentions_me).toBeUndefined();
    const added = buildEditedMessageMeta({}, original, 'old-id', 'edited-at');
    expect(added.mentions_me).toBe(true);
  });

  it('removes cached replies to edit predecessors without removing genuine replies', () => {
    const meta = {
      edited: { editedAt: '2026-01-01T00:00:00.000Z', previousEventIds: ['old-id'] },
      reply: { eventId: 'old-id', text: 'Original text' },
    };
    expect(withoutEditSelfReply(meta)).toEqual({ edited: meta.edited });
    expect(meta.reply).toBeDefined();
    const actualReply = { ...meta, reply: { eventId: 'parent-id', text: 'Parent' } };
    expect(withoutEditSelfReply(actualReply)).toBe(actualReply);
    expect(
      buildEditedMessageMeta({}, { reply: meta.reply }, 'old-id', meta.edited.editedAt).reply,
    ).toBeUndefined();
  });

  it('matches timestamps at Nostr second precision only', () => {
    expect(
      areMessageEditTimestampsEqual('2026-01-01T00:00:00.100Z', '2026-01-01T00:00:00.900Z'),
    ).toBe(true);
    expect(
      areMessageEditTimestampsEqual('2026-01-01T00:00:00.900Z', '2026-01-01T00:00:01.000Z'),
    ).toBe(false);
  });
});

import NostrClient from '#src/lib/nostr/client.ts';
import { createMessageEventRuntime } from '#src/stores/nostr/messageEventRuntime.ts';

it('drops an old inline keyboard unless the replacement supplies its own signed keyboard', () => {
  const original = { inline_keyboard: { inline_keyboard: [[{ text: 'Old', callback_data: 'old' }]] },
    inline_keyboard_version: 'a'.repeat(64), inline_keyboard_chat_type: 'dm', bot_command: 'c'.repeat(64), source: 'nostr' };
  const edited = buildEditedMessageMeta(original, { source: 'nostr' }, 'a'.repeat(64), '2026-01-01T00:00:00Z');
  expect(edited).not.toHaveProperty('inline_keyboard');
  expect(edited).not.toHaveProperty('inline_keyboard_version');
  expect(edited).not.toHaveProperty('bot_command');
  const replacement = { ...original, inline_keyboard_version: 'b'.repeat(64) };
  expect(buildEditedMessageMeta(original, replacement, 'a'.repeat(64), '2026-01-01T00:00:00Z').inline_keyboard_version).toBe('b'.repeat(64));
});
