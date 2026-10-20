import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import NostrClient, { type NostrSubscriptionOptions } from '#src/lib/nostr/client.ts';
import { PublicGroupData, type SavedPublicRoom } from '#src/services/publicGroupData.ts';
import { parsePublicRoom } from '#src/stores/nostr/publicGroups.ts';
import { createPublicGroupActivityRuntime } from '#src/stores/nostr/publicGroupActivityRuntime.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers();
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
  // This case explicitly tests arrivals within one second, even on a slow runner.
  vi.useFakeTimers({ toFake: ['Date'] });
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
  await s.runtime.ingest(s.room.address, s.message('another, same second', s.saved().readAt));
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
