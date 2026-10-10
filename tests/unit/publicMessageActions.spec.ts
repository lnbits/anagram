import { expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { parsePublicRoom, roomTags } from '#src/stores/nostr/publicGroups.ts';
import {
  publicMessageState,
  publicMessageReference,
  validPublicAction,
} from '#src/stores/nostr/publicMessageActions.ts';

function fixture() {
  const owner = generateSecretKey(),
    other = generateSecretKey();
  const room = parsePublicRoom(
    finalizeEvent(
      {
        kind: 34550,
        created_at: 1,
        content: '',
        tags: roomTags({
          slug: 'actions',
          name: 'Actions',
          about: '',
          picture: '',
          relays: ['wss://relay.example'],
          trusted: [],
          blocked: [],
        }),
      },
      owner,
    ),
  );
  const root = finalizeEvent(
    { kind: 9, created_at: 2, content: 'original', tags: [['a', room.address]] },
    owner,
  );
  const action = (kind: number, content: string, tags: string[][], key = owner, created_at = 3) =>
    finalizeEvent(
      {
        kind,
        content,
        created_at: kind === 9 ? 2 : created_at,
        tags: [[kind === 9 ? 'a' : 'h', room.address], ...tags],
      },
      key,
    );
  return { owner, other, room, root, action };
}
it('only signed same-author, same-room edits and deletion requests affect a public message', () => {
  const { root, room, other, action } = fixture();
  const edit = action(9, 'edited', [['e', root.id, '', 'edit']]);
  const forged = action(9, 'forged', [['e', root.id, '', 'edit']], other, 4);
  const removal = action(5, '', [['e', root.id]], other);
  const message = publicMessageState({ ...root, activity: [removal, forged, edit] }, room);
  expect(message.text).toBe('edited');
  expect(message.meta.edited).toBeTruthy();
  expect(message.meta.deleted).toBeUndefined();
  expect(message.id).toBe(root.id);
  expect(message.nostrEvent?.event.id).toBe(edit.id);
  expect(message.nostrEvent?.event).not.toHaveProperty('activity');
  expect(validPublicAction(edit, `${room.address}-other`)).toBe(false);
  const deleted = publicMessageState(
    {
      ...root,
      activity: [
        edit,
        action(5, '', [
          ['e', root.id],
          ['e', edit.id],
        ]),
      ],
    },
    room,
  );
  expect(deleted.meta.deleted).toBeTruthy();
});
it('uses private-group delete-and-replace edits and ignores unacknowledged local actions', () => {
  const { root, room, action } = fixture();
  const deletion = action(5, '', [['e', root.id]]);
  const late = action(9, 'late edit', [['e', root.id, '', 'edit']], undefined, 5);
  expect(
    publicMessageState({ ...root, activity: [late, deletion] }, room).meta.deleted,
  ).toBeUndefined();
  expect(
    publicMessageState(
      { ...root, activity: [late, deletion, action(5, '', [['e', late.id]])] },
      room,
    ).meta.deleted,
  ).toBeTruthy();
  const status = {
    relay_url: 'wss://relay.example',
    direction: 'outbound' as const,
    scope: 'recipient' as const,
    status: 'failed' as const,
    updated_at: new Date().toISOString(),
  };
  expect(
    publicMessageState({ ...root, activity: [{ ...deletion, relay_statuses: [status] }] }, room)
      .meta.deleted,
  ).toBeUndefined();
});
it('deduplicates reactions, supports author removals and filters blocked reactors', () => {
  const { root, room, owner, other, action } = fixture();
  const reaction = action(
    7,
    '👍',
    [
      ['e', root.id],
      ['p', root.pubkey],
    ],
    other,
  );
  const duplicate = action(
    7,
    '👍',
    [
      ['e', root.id],
      ['p', root.pubkey],
    ],
    other,
    4,
  );
  const forgedRemoval = action(5, '', [['e', reaction.id]], owner);
  let message = publicMessageState(
    { ...root, activity: [reaction, duplicate, forgedRemoval] },
    room,
  );
  expect(message.meta.reactions).toHaveLength(1);
  expect(message.meta.reactions?.[0].eventId).toBe(duplicate.id);
  const removal = action(
    5,
    '',
    [
      ['e', reaction.id],
      ['e', duplicate.id],
    ],
    other,
    5,
  );
  message = publicMessageState({ ...root, activity: [reaction, duplicate, removal] }, room);
  expect(message.meta.reactions).toHaveLength(0);
  expect(
    publicMessageState(
      { ...root, activity: [reaction] },
      { ...room, blocked: [getPublicKey(other)] },
    ).meta.reactions,
  ).toHaveLength(0);
});
it('redacts untrusted edited content and reply previews, including blocked and deleted parents', () => {
  const { root, room, other, action } = fixture();
  const parent = action(9, 'parent https://hidden.example/test', [], other);
  const reply = action(9, 'reply', [['q', parent.id, '', parent.pubkey]]);
  expect(publicMessageState({ ...reply, replyEvent: parent }, room).meta.reply?.text).toBe(
    'parent [link removed]',
  );
  expect(
    publicMessageState({ ...reply, replyEvent: parent }, { ...room, blocked: [parent.pubkey] }).meta
      .reply?.text,
  ).toBe('Message unavailable');
  const removedParent = { ...parent, activity: [action(5, '', [['e', parent.id]], other)] };
  expect(publicMessageState({ ...reply, replyEvent: removedParent }, room).meta.reply?.text).toBe(
    'Message deleted',
  );
  const edit = action(9, 'updated https://hidden.example/test', [['e', root.id, '', 'edit']]);
  expect(
    publicMessageState({ ...root, activity: [edit] }, { ...room, owner: getPublicKey(other) }).text,
  ).toBe('updated [link removed]');
});

it('resolves edited references only within their room and expected author', () => {
  const { root, room, other, action } = fixture();
  const edited = action(9, 'edited', [['e', root.id, '', 'edit']]);
  const impostor = action(9, 'impostor', [['e', root.id, '', 'edit']], other);
  expect(publicMessageReference([impostor], root.id, room.address)).toBeUndefined();
  expect(publicMessageReference([edited], root.id, room.address, root.pubkey)?.id).toBe(edited.id);
  expect(publicMessageReference([edited], root.id, `${room.address}-other`)).toBeUndefined();
  expect(
    publicMessageReference([edited], root.id, room.address, getPublicKey(other)),
  ).toBeUndefined();
  expect(
    publicMessageReference([{ ...edited, content: 'invalid signature' }], root.id, room.address),
  ).toBeUndefined();
  expect(publicMessageReference([edited, impostor], root.id, room.address)).toBeUndefined();
  expect(publicMessageReference([edited, impostor], root.id, room.address, root.pubkey)?.id).toBe(
    edited.id,
  );
  // A claimed replacement cannot override the actual original's author.
  expect(
    publicMessageReference([root, impostor], root.id, room.address, getPublicKey(other)),
  ).toBeUndefined();
});

it('applies reply trust, author and deletion rules to edited parents', () => {
  const { root, room, other, action } = fixture();
  const parent = action(
    9,
    'updated https://hidden.example/test',
    [['e', root.id, '', 'edit']],
    other,
  );
  const reply = action(9, 'reply', [['q', root.id, '', parent.pubkey]]);
  expect(publicMessageState({ ...reply, replyEvent: parent }, room).meta.reply?.text).toBe(
    'updated [link removed]',
  );
  expect(
    publicMessageState({ ...reply, replyEvent: parent }, { ...room, blocked: [parent.pubkey] }).meta
      .reply?.text,
  ).toBe('Message unavailable');
  const wrongAuthor = action(9, 'reply', [['q', root.id, '', root.pubkey]]);
  expect(publicMessageState({ ...wrongAuthor, replyEvent: parent }, room).meta.reply?.text).toBe(
    'Message unavailable',
  );
  const removed = { ...parent, activity: [action(5, '', [['e', parent.id]], other)] };
  expect(publicMessageState({ ...reply, replyEvent: removed }, room).meta.reply?.text).toBe(
    'Message deleted',
  );
});
