import { describe, expect, it } from 'vitest';
import type { Message } from '#src/types/chat.ts';
import { orderThreadMessages } from '#src/utils/threadMessageOrder.ts';

function message(id: string, sentAt = '2026-10-09T13:02:00.000Z', parent?: string): Message {
  return {
    id,
    eventId: id,
    chatId: 'group',
    authorPublicKey: 'author',
    sender: 'them',
    text: id,
    sentAt,
    nostrEvent: null,
    meta: parent
      ? {
          reply: {
            messageId: parent,
            eventId: parent,
            authorPublicKey: 'author',
            authorName: 'Author',
            sender: 'them',
            text: parent,
            sentAt,
          },
        }
      : {},
  };
}
const order = (rows: Message[]) => orderThreadMessages(rows, (row) => row);

describe('loaded thread reply ordering', () => {
  it('puts a same-second reply after an older locally saved millisecond timestamp', () => {
    const parent = message('parent', '2026-10-09T13:02:00.950Z');
    const reply = message('reply', '2026-10-09T13:02:00.000Z', parent.eventId!);
    const rows = [reply, parent];
    expect(order(rows)).toEqual([parent, reply]);
    expect(rows).toEqual([reply, parent]);
  });

  it('keeps public same-second reply chains after their parents despite reverse event-id order', () => {
    const parent = message('ff');
    const reply = message('bb', parent.sentAt, parent.id);
    const next = message('aa', parent.sentAt, reply.id);
    const before = message('before', '2026-10-09T13:01:59.000Z');
    const after = message('after', '2026-10-09T13:02:01.000Z');
    expect(order([before, next, reply, parent, after])).toEqual([
      before,
      parent,
      reply,
      next,
      after,
    ]);
  });

  it('resolves old edit ids and local reply ids without changing the underlying rows', () => {
    const parent = message('local-parent');
    parent.eventId = 'replacement';
    parent.meta.edited = { editedAt: parent.sentAt, previousEventIds: ['original'] };
    const reply = message('reply', parent.sentAt, 'original');
    const localReply = message('local-reply', parent.sentAt, parent.id);
    localReply.meta.reply!.eventId = null;
    const entries = [reply, localReply, parent].map((message) => ({
      message,
      event: message.eventId,
    }));
    expect(orderThreadMessages(entries, (row) => row.message)).toEqual([
      entries[2],
      entries[0],
      entries[1],
    ]);
  });

  it('leaves unrelated rows, other seconds and missing parents in their existing order', () => {
    const earlierReply = message('earlier', '2026-10-09T13:01:59.000Z', 'parent');
    const orphan = message('orphan', undefined, 'not-in-this-window');
    const parent = message('parent');
    const unrelated = message('unrelated');
    const rows = [earlierReply, orphan, parent, unrelated];
    expect(order(rows)).toEqual(rows);
  });

  it('does not follow cross-chat references or loop on malformed cycles', () => {
    const a = message('a', undefined, 'b');
    const b = message('b', undefined, 'a');
    expect(new Set(order([a, b]))).toEqual(new Set([a, b]));
    expect(order([a, b])).toHaveLength(2);
    b.chatId = 'another-chat';
    expect(order([a, b])).toEqual([a, b]);
  });
});
