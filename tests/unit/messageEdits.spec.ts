import {
  areMessageEditTimestampsEqual,
  buildEditedMessageMeta,
  buildMessageEditTag,
  messageEditReferencesEventId,
  readEditedMessageMetadata,
  readMessageEditTargetEventId,
} from 'src/utils/messageEdits';
import { describe, expect, it } from 'vitest';

describe('message edit helpers', () => {
  it('builds and reads the private edit marker tag', () => {
    const eventId = 'A'.repeat(64);
    const tag = buildMessageEditTag(eventId);

    expect(tag).toEqual(['e', eventId.toLowerCase(), '', 'edit']);
    expect(readMessageEditTargetEventId([['p', 'recipient'], tag ?? []])).toBe(
      eventId.toLowerCase()
    );
  });

  it('preserves the empty relay slot in edit marker tags on kind 14 rumors', () => {
    const runtime = createMessageEventRuntime({
      decryptPrivateStringContent: async () => null,
      derivePublicKeyFromPrivateKey: () => null,
      findGroupChatEpochContextByRecipientPubkey: async () => null,
      getOrCreateSigner: async () => ({}) as never,
      ndk: new NDK(),
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
      [['e', eventId, '', 'edit']]
    );

    expect(rumor.tags).toContainEqual(['e', eventId, '', 'edit']);
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
      '2026-01-01T00:00:03.000Z'
    );

    expect(meta.deleted).toBeUndefined();
    expect(readEditedMessageMetadata(meta.edited)).toEqual({
      editedAt: '2026-01-01T00:00:03.000Z',
      previousEventIds: [firstEventId, secondEventId],
    });
    expect(messageEditReferencesEventId(meta, firstEventId)).toBe(true);
    expect(messageEditReferencesEventId(meta, secondEventId)).toBe(true);
  });

  it('matches timestamps at Nostr second precision only', () => {
    expect(
      areMessageEditTimestampsEqual('2026-01-01T00:00:00.100Z', '2026-01-01T00:00:00.900Z')
    ).toBe(true);
    expect(
      areMessageEditTimestampsEqual('2026-01-01T00:00:00.900Z', '2026-01-01T00:00:01.000Z')
    ).toBe(false);
  });
});

import NDK from '@nostr-dev-kit/ndk';
import { createMessageEventRuntime } from 'src/stores/nostr/messageEventRuntime';
