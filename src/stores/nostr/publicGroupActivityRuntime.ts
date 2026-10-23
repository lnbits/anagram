import type NostrClient from '#src/lib/nostr/client.ts';
import type { NostrEvent, NostrSubscription } from '#src/lib/nostr/client.ts';
import type { PublicGroupData, SavedPublicRoom } from '#src/services/publicGroupData.ts';
import { textMentionsPublicKey } from '#src/utils/nostrMentions.ts';
import { actionTargets, editRoot, editTarget, validPublicAction } from './publicMessageActions.ts';
import { roomPolicy, validRoomMessage, type PublicRoom } from './publicGroups.ts';

// Untrusted posts display profile mentions as "[profile removed]"; only count visible mentions.
function mentionsAccount(room: PublicRoom, event: NostrEvent, account: string): boolean {
  return (
    roomPolicy(room, event.pubkey) === 'trusted' && textMentionsPublicKey(event.content, account)
  );
}

/** Small live inbox summaries for joined rooms, independent of the displayed history window. */
export function createPublicGroupActivityRuntime(deps: {
  client: NostrClient;
  account: () => string | null;
  database: () => PublicGroupData | undefined;
  relays: (hints: string[]) => Promise<string[]>;
  changed: (row: SavedPublicRoom) => void;
  notify?: (row: SavedPublicRoom, event: NostrEvent) => void;
  failed: () => void;
}) {
  const watches = new Map<string, { key: string; stop: () => void }>();
  let rows = new Map<string, SavedPublicRoom>();
  let generation = 0;
  let visible = '';
  let activeAddress = '';
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  const focused = () =>
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus();

  async function ingest(address: string, event: NostrEvent, notify = true, cached = false) {
    const db = deps.database(),
      account = deps.account(),
      token = generation;
    const row = rows.get(address);
    if (event.kind === 5 || (event.kind === 9 && editTarget(event))) {
      // Only unread messages can change mention state: skip signature checks and writes
      // for deletions without unread mentions and edits without unread messages.
      const kinds = event.tags.filter((tag) => tag[0] === 'k').map((tag) => tag[1]);
      const relevant =
        event.kind === 5
          ? (row?.unreadMentionCount ?? 0) > 0 && (!kinds.length || kinds.includes('9'))
          : (row?.unreadCount ?? 0) > 0;
      if (!db || !account || !row?.joined || row.blocked || !relevant) return;
      if (!validPublicAction(event, address)) return;
      const updated = await db.updateMention(
        address,
        event.kind === 5
          ? { kind: 'delete', targets: actionTargets(event), author: event.pubkey }
          : {
              kind: 'edit',
              root: editRoot(event)!,
              target: editTarget(event)!,
              id: event.id!,
              author: event.pubkey,
              mentionsMe: mentionsAccount(row.room, event, account),
            },
      );
      const current =
        generation === token && deps.account() === account && deps.database() === db;
      if (updated && current) {
        rows.set(address, updated);
        deps.changed(updated);
      }
      return;
    }
    if (
      !db ||
      !account ||
      !row?.joined ||
      row.blocked ||
      event.created_at < (row.activitySince ?? 0) ||
      event.created_at > Math.floor(Date.now() / 1000) + 300 ||
      !validRoomMessage(event, address) ||
      event.pubkey === account ||
      roomPolicy(row.room, event.pubkey) === 'blocked' ||
      event.tags.some((tag) => tag[0] === 'e' && tag[3] === 'edit')
    )
      return;
    const active = () =>
      generation === token && deps.account() === account && deps.database() === db;
    if (!cached) await db.put(address, event);
    if (!active()) return;
    const reading = visible === address && focused();
    const result = await db.recordActivity(
      address,
      event,
      reading,
      !reading && mentionsAccount(row.room, event, account),
    );
    if (!active() || !result.row || !result.fresh) return;
    rows.set(address, result.row);
    deps.changed(result.row);
    if (
      notify &&
      result.fresh &&
      !reading &&
      event.created_at >= (result.row.readAt ?? 0) &&
      event.created_at >= (result.row.notificationsSince ?? 0) &&
      result.row.notificationsEnabled === true &&
      !result.row.muted &&
      !result.row.blocked
    )
      deps.notify?.(result.row, event);
  }
  function sync(next: SavedPublicRoom[]) {
    rows = new Map(next.map((row) => [row.address, row]));
    for (const [address, watch] of watches) {
      const row = rows.get(address);
      if (!row?.joined || row.blocked || row.successor || address === activeAddress) {
        watch.stop();
        watches.delete(address);
      }
    }
    for (const row of next) {
      if (!row.joined || row.blocked || row.successor || row.address === activeAddress) continue;
      const key = JSON.stringify(row.room.relays);
      if (watches.get(row.address)?.key === key) continue;
      watches.get(row.address)?.stop();
      let stopped = false;
      let subscription: NostrSubscription | undefined;
      const token = generation,
        db = deps.database(),
        account = deps.account();
      const active = () =>
        !stopped && generation === token && deps.database() === db && deps.account() === account;
      const stop = () => {
        stopped = true;
        subscription?.stop();
      };
      watches.set(row.address, { key, stop });
      void (async () => {
        if (!db) return;
        const saved =
          row.activitySince === undefined
            ? await db.updateLocal(row.address, { activitySince: Math.floor(Date.now() / 1000) })
            : row;
        if (!active() || !saved) return;
        if (row.activitySince === undefined) {
          rows.set(row.address, saved);
          deps.changed(saved);
        }
        const urls = await deps.relays(saved.room.relays);
        if (!active()) return;
        // Only recent activity; opening/paging the thread remains the history hydrator.
        subscription = deps.client.subscribe(
          [
            {
              kinds: [9],
              '#a': [row.address],
              since: Math.max(saved.activitySince ?? 0, (saved.lastActivityAt ?? 0) - 1),
              limit: 50,
            },
            // Message deletions can retract an unread mention.
            {
              kinds: [5],
              '#h': [row.address],
              '#k': ['9'],
              since: Math.max(saved.activitySince ?? 0, (saved.lastActivityAt ?? 0) - 1),
              limit: 50,
            },
          ],
          {
            relayUrls: urls,
            onEvent: (event) => {
              if (active()) void ingest(row.address, event.rawEvent()).catch(deps.failed);
            },
            onEose: () => {
              retryDelay = 1000;
            },
            onClose: () => {
              if (!active()) return;
              stop();
              watches.delete(row.address);
              if (retry !== undefined) return;
              retry = setTimeout(() => {
                retry = undefined;
                sync([...rows.values()]);
              }, retryDelay);
              retryDelay = Math.min(retryDelay * 2, 30000);
            },
          },
        );
      })().catch(() => {
        if (!active()) return;
        stop();
        watches.delete(row.address);
        deps.failed();
      });
    }
  }
  async function markRead(address: string) {
    const db = deps.database(),
      token = generation;
    if (!db) return;
    const row = await db.markRead(address);
    if (generation === token && db === deps.database() && row) {
      rows.set(address, row);
      deps.changed(row);
    }
  }
  return {
    sync,
    ingest,
    markRead,
    setActive(address: string) {
      activeAddress = address;
      sync([...rows.values()]);
    },
    setVisible(address: string) {
      visible = address;
      if (address && focused()) void markRead(address).catch(deps.failed);
    },
    stop() {
      generation++;
      clearTimeout(retry);
      retry = undefined;
      retryDelay = 1000;
      for (const watch of watches.values()) watch.stop();
      watches.clear();
      rows.clear();
      visible = '';
      activeAddress = '';
    },
  };
}
