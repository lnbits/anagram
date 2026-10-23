import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import NostrClient, { type NostrSubscriptionOptions } from '#src/lib/nostr/client.ts';
import { PublicGroupData, type SavedPublicRoom } from '#src/services/publicGroupData.ts';
import { parsePublicRoom } from '#src/stores/nostr/publicGroups.ts';
import { createPublicGroupActivityRuntime } from '#src/stores/nostr/publicGroupActivityRuntime.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const ownerKey = generateSecretKey(),
    author = generateSecretKey();
  let account = getPublicKey(ownerKey);
  const db = new PublicGroupData(account);
  const now = Math.floor(Date.now() / 1000);
  const room = parsePublicRoom(
    finalizeEvent(
      {
        kind: 34550,
        created_at: now,
        content: '',
        tags: [
          ['d', 'activity'],
          ['name', 'Activity'],
          ['anagram-room', '1'],
          ['relay', 'wss://relay.example'],
        ],
      },
      ownerKey,
    ),
  );
  let saved: SavedPublicRoom = {
    address: room.address,
    room,
    joined: true,
    updated: now,
    activitySince: now,
  };
  await db.save(saved);
  const subscriptions: Array<{ stopped: boolean; options: NostrSubscriptionOptions }> = [];
  const subscribe = vi.fn((_filters, options: NostrSubscriptionOptions) => {
    const sub = { stopped: false, options };
    subscriptions.push(sub);
    return {
      stop: () => {
        sub.stopped = true;
      },
    };
  });
  const notify = vi.fn(),
    failed = vi.fn();
  const runtime = createPublicGroupActivityRuntime({
    client: { subscribe } as unknown as NostrClient,
    account: () => account,
    database: () => db,
    relays: async (urls) => urls,
    changed: (row) => {
      saved = row;
    },
    notify,
    failed,
  });
  runtime.sync([saved]);
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  cleanup.push(async () => {
    runtime.stop();
    await db.close();
  });
  const message = (content: string, created_at = now, tags = [['a', room.address]], key = author) =>
    finalizeEvent({ kind: 9, created_at, content, tags }, key);
  const preferences = async (patch: Parameters<PublicGroupData['updateLocal']>[1]) => {
    saved = (await db.updateLocal(room.address, patch))!;
    runtime.sync([saved]);
  };
  return {
    runtime,
    db,
    room,
    now,
    message,
    notify,
    failed,
    subscriptions,
    subscribe,
    preferences,
    saved: () => saved,
    switchAccount: () => {
      account = getPublicKey(generateSecretKey());
      runtime.stop();
    },
    ownerKey,
    author,
  };
}

it('counts messages with notifications off, deduplicates replicas, and persists read state', async () => {
  // Keep arrivals in one second: setup's vi.waitFor advances fake timers,
  // including a faked Date, which can otherwise move the read boundary.
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 21, 12, 0, 0, 950));
  const s = await setup(),
    event = s.message('hello');
  await Promise.all([
    s.runtime.ingest(s.room.address, event),
    s.runtime.ingest(s.room.address, event),
  ]);
  expect(s.saved().unreadCount).toBe(1);
  expect(s.notify).not.toHaveBeenCalled();
  await s.runtime.markRead(s.room.address);
  expect(s.saved().unreadCount).toBe(0);
  await s.runtime.ingest(s.room.address, event);
  expect(s.saved().unreadCount).toBe(0);
  expect((await s.db.list())[0].unreadCount).toBe(0);
  await s.runtime.ingest(s.room.address, s.message('another, same second'));
  expect(s.saved().unreadCount).toBe(1);
});

it('only notifies after explicit opt-in and honours mute, disable and block', async () => {
  const s = await setup();
  await s.preferences({ notificationsEnabled: true });
  await s.runtime.ingest(s.room.address, s.message('enabled'));
  expect(s.notify).toHaveBeenCalledOnce();
  await s.preferences({ muted: true });
  await s.runtime.ingest(s.room.address, s.message('muted'));
  expect(s.saved().unreadCount).toBe(2);
  await s.preferences({ muted: false, notificationsEnabled: false });
  await s.runtime.ingest(s.room.address, s.message('disabled'));
  expect(s.saved().unreadCount).toBe(3);
  await s.preferences({ blocked: true });
  await s.runtime.ingest(s.room.address, s.message('blocked'));
  expect(s.saved().unreadCount).toBe(3);
  expect(s.notify).toHaveBeenCalledOnce();
  expect(s.subscriptions.every((sub) => sub.stopped)).toBe(true);
});

it('suppresses history, own messages, edits, blocked authors, invalid signatures and future timestamps', async () => {
  const s = await setup();
  await s.preferences({ notificationsEnabled: true });
  const forged = { ...s.message('valid'), content: 'forged' };
  for (const event of [
    s.message('history', s.now - 1),
    s.message('own', s.now, undefined, s.ownerKey),
    s.message('edit', s.now, [
      ['a', s.room.address],
      ['e', '1'.repeat(64), '', 'edit'],
    ]),
    s.message('wrong room', s.now, [['a', `${s.room.address}-wrong`]]),
    forged,
    s.message('future', s.now + 301),
  ])
    await s.runtime.ingest(s.room.address, event);
  const saved = await s.db.save({
    ...s.saved(),
    room: { ...s.room, blocked: [getPublicKey(s.author)] },
  });
  s.runtime.sync([saved]);
  await s.runtime.ingest(s.room.address, s.message('blocked author'));
  expect(s.notify).not.toHaveBeenCalled();
  expect(s.saved().unreadCount ?? 0).toBe(0);
});

it('marks a focused room read but counts new messages when the window is in the background', async () => {
  const s = await setup();
  let focus = false;
  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => focus });
  await s.preferences({ notificationsEnabled: true });
  s.runtime.setVisible(s.room.address);
  await s.runtime.ingest(s.room.address, s.message('background'));
  expect(s.saved().unreadCount).toBe(1);
  focus = true;
  s.runtime.setVisible(s.room.address);
  await vi.waitFor(() => expect(s.saved().unreadCount).toBe(0));
  await s.runtime.ingest(s.room.address, s.message('reading'));
  expect(s.saved().unreadCount).toBe(0);
  expect(s.notify).toHaveBeenCalledOnce();
});

it('hands the active thread its subscription and restores background watching on exit', async () => {
  const s = await setup();
  s.runtime.setActive(s.room.address);
  expect(s.subscriptions[0].stopped).toBe(true);
  await s.runtime.ingest(s.room.address, s.message('from active thread'), true, true);
  expect(s.saved().unreadCount).toBe(1);
  s.runtime.setActive('');
  await vi.waitFor(() => expect(s.subscriptions).toHaveLength(2));
  expect(s.subscriptions.filter((sub) => !sub.stopped)).toHaveLength(1);
  s.runtime.stop();
  expect(s.subscriptions.every((sub) => sub.stopped)).toBe(true);
});

it('cancels pending notification delivery on account switch', async () => {
  const s = await setup();
  await s.preferences({ notificationsEnabled: true });
  const pending = s.runtime.ingest(s.room.address, s.message('old account'));
  s.switchAccount();
  await pending;
  expect(s.notify).not.toHaveBeenCalled();
  expect(s.saved().unreadCount ?? 0).toBe(0);
});

it('reconnects a closed activity subscription and cancels retries when stopped', async () => {
  const s = await setup();
  vi.useFakeTimers();
  try {
    s.subscriptions[0].options.onClose?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.subscriptions).toHaveLength(2);
    expect(s.subscriptions[0].stopped).toBe(true);
    s.subscriptions[1].options.onClose?.();
    s.runtime.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.subscriptions).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it('does not alert for backlog received before notifications were enabled', async () => {
  const s = await setup();
  await s.preferences({ notificationsEnabled: true, notificationsSince: s.now + 1 });
  await s.runtime.ingest(s.room.address, s.message('before opt-in'));
  expect(s.saved().unreadCount).toBe(1);
  expect(s.notify).not.toHaveBeenCalled();
  await s.runtime.ingest(s.room.address, s.message('after opt-in', s.now + 1));
  expect(s.notify).toHaveBeenCalledOnce();
});

async function trustedMentionSetup() {
  const s = await setup();
  const saved = await s.db.save({
    ...s.saved(),
    room: { ...s.room, trusted: [getPublicKey(s.author)] },
  });
  s.runtime.sync([saved]);
  const account = getPublicKey(s.ownerKey);
  const mention = `hi nostr:${nip19.npubEncode(account)}`;
  const edit = (target: string, root: string, content: string) =>
    s.message(content, s.now, [
      ['a', s.room.address],
      ['e', target, '', 'edit'],
      ...(target === root ? [] : [['e', root]]),
    ]);
  const remove = (ids: string[], key = s.author) =>
    finalizeEvent(
      {
        kind: 5,
        created_at: s.now,
        content: '',
        tags: [['h', s.room.address], ['k', '9'], ...ids.map((id) => ['e', id])],
      },
      key,
    );
  return { ...s, mention, edit, remove };
}

it('counts unread mentions only from trusted posts and clears them on read', async () => {
  const s = await trustedMentionSetup();
  expect(s.subscribe.mock.calls[0][0]).toContainEqual(
    expect.objectContaining({ kinds: [5], '#h': [s.room.address], '#k': ['9'] }),
  );
  const stranger = generateSecretKey();
  await s.runtime.ingest(s.room.address, s.message(s.mention, s.now, undefined, stranger));
  expect(s.saved()).toMatchObject({ unreadCount: 1, unreadMentionCount: 0 });
  await s.runtime.ingest(s.room.address, s.message('plain @owner text'));
  await s.runtime.ingest(
    s.room.address,
    s.message(`hi nostr:${nip19.npubEncode(getPublicKey(stranger))}`),
  );
  expect(s.saved()).toMatchObject({ unreadCount: 3, unreadMentionCount: 0 });
  await s.runtime.ingest(s.room.address, s.message(s.mention));
  await s.preferences({ muted: true });
  await s.runtime.ingest(s.room.address, s.message(`${s.mention} again`));
  expect(s.saved()).toMatchObject({ unreadCount: 5, unreadMentionCount: 2 });
  await s.runtime.markRead(s.room.address);
  expect(s.saved()).toMatchObject({ unreadCount: 0, unreadMentionCount: 0 });

  vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
  s.runtime.setVisible(s.room.address);
  await s.runtime.ingest(s.room.address, s.message(`${s.mention} while reading`));
  expect(s.saved()).toMatchObject({ unreadCount: 0, unreadMentionCount: 0 });
});

it('applies edits and author deletions to an unread mention in either arrival order', async () => {
  const s = await trustedMentionSetup();
  const first = s.message(s.mention);
  await s.runtime.ingest(s.room.address, first);
  expect(s.saved().unreadMentionCount).toBe(1);

  const removed = s.edit(first.id, first.id, 'mention removed');
  await s.runtime.ingest(s.room.address, removed);
  expect(s.saved().unreadMentionCount).toBe(0);
  const restored = s.edit(removed.id, first.id, `${s.mention} restored`);
  await s.runtime.ingest(s.room.address, restored);
  expect(s.saved().unreadMentionCount).toBe(1);
  // The first edit's deletion of the root arrives late; the current version survives.
  await s.runtime.ingest(s.room.address, s.remove([first.id]));
  expect(s.saved().unreadMentionCount).toBe(1);
  // Only the author can retract it.
  await s.runtime.ingest(s.room.address, s.remove([first.id, removed.id, restored.id], s.ownerKey));
  expect(s.saved().unreadMentionCount).toBe(1);
  await s.runtime.ingest(s.room.address, s.remove([first.id, removed.id, restored.id]));
  expect(s.saved().unreadMentionCount).toBe(0);

  // Deletion before its replacement edit: cleared, then raised by the edited text.
  const second = s.message(`${s.mention} second`);
  await s.runtime.ingest(s.room.address, second);
  await s.runtime.ingest(s.room.address, s.remove([second.id]));
  expect(s.saved().unreadMentionCount).toBe(0);
  await s.runtime.ingest(s.room.address, s.edit(second.id, second.id, `${s.mention} edited`));
  expect(s.saved().unreadMentionCount).toBe(1);
  expect(s.saved().unreadCount).toBe(2);

  // Read messages stay read when an edit adds a mention.
  await s.runtime.markRead(s.room.address);
  const plain = s.message('plain');
  await s.runtime.ingest(s.room.address, plain);
  await s.runtime.markRead(s.room.address);
  await s.runtime.ingest(s.room.address, s.edit(plain.id, plain.id, `${s.mention} late`));
  expect(s.saved().unreadMentionCount).toBe(0);
});

it('drops mention updates after an account switch', async () => {
  const s = await trustedMentionSetup();
  const pending = s.runtime.ingest(s.room.address, s.message(s.mention));
  s.switchAccount();
  await pending;
  await s.runtime.ingest(s.room.address, s.message(`${s.mention} after switch`));
  expect(s.saved().unreadMentionCount ?? 0).toBe(0);
});

it('skips edits and deletions that cannot change unread mentions', async () => {
  const s = await trustedMentionSetup();
  const update = vi.spyOn(s.db, 'updateMention');
  const read = s.message('already read');
  await s.runtime.ingest(s.room.address, read);
  await s.runtime.markRead(s.room.address);
  // Nothing unread: neither edits nor deletions touch storage.
  await s.runtime.ingest(s.room.address, s.edit(read.id, read.id, s.mention));
  await s.runtime.ingest(s.room.address, s.remove([read.id]));
  expect(update).not.toHaveBeenCalled();

  // Unread messages without mentions: edits apply, deletions are skipped.
  const plain = s.message('plain unread');
  await s.runtime.ingest(s.room.address, plain);
  await s.runtime.ingest(s.room.address, s.remove([plain.id]));
  expect(update).not.toHaveBeenCalled();
  const edit = s.edit(plain.id, plain.id, `${s.mention} added`);
  await s.runtime.ingest(s.room.address, edit);
  expect(update).toHaveBeenCalledOnce();
  expect(s.saved().unreadMentionCount).toBe(1);

  // Reaction deletions never retract a message mention.
  const reactionDeletion = finalizeEvent(
    {
      kind: 5,
      created_at: s.now,
      content: '',
      tags: [['h', s.room.address], ['k', '7'], ['e', plain.id]],
    },
    s.author,
  );
  await s.runtime.ingest(s.room.address, reactionDeletion);
  expect(update).toHaveBeenCalledOnce();
  // Rapid edit then deletion of the current version.
  await s.runtime.ingest(s.room.address, s.edit(edit.id, plain.id, 'removed again'));
  await s.runtime.ingest(s.room.address, s.edit(edit.id, plain.id, `${s.mention} stale`));
  expect(s.saved().unreadMentionCount).toBe(0);
  expect(s.saved().unreadCount).toBe(1);
});

it('keeps one subscription per background room and stops it on room or account switch', async () => {
  const s = await trustedMentionSetup();
  const live = () => s.subscriptions.filter((sub) => !sub.stopped);
  expect(live()).toHaveLength(1);
  s.runtime.sync([s.saved()]);
  expect(live()).toHaveLength(1);
  s.runtime.setActive(s.room.address);
  expect(live()).toHaveLength(0);
  s.runtime.setActive('');
  await vi.waitFor(() => expect(live()).toHaveLength(1));
  s.switchAccount();
  expect(live()).toHaveLength(0);
});
