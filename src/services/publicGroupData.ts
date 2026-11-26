import { rememberAccountDatabase } from '#src/utils/indexedDbStorage.ts';
import { normalizeMessageSearchText } from '#src/utils/messageSearch.ts';
import type { NostrEvent } from '#src/lib/nostr/client.ts';
import type { MessageRelayStatus } from '#src/types/chat.ts';
import { mergeMessageRelayStatuses } from '#src/utils/messageRelayStatus.ts';
import { newerRoom, type PublicRoom } from '#src/stores/nostr/publicGroups.ts';
export type PublicGroupMessage = NostrEvent & {
  relay_statuses?: MessageRelayStatus[];
  activity?: PublicGroupMessage[];
  replyEvent?: PublicGroupMessage;
};
export interface PublicInboxRecord {
  sequence: number;
  revision: number;
  room: string;
  event: PublicGroupMessage;
  timeline: boolean;
}
export interface SavedPublicRoom {
  address: string;
  room: PublicRoom;
  joined: boolean;
  successor?: string;
  updated: number;
  unreadCount?: number;
  unreadMentionCount?: number;
  notificationsEnabled?: boolean;
  notificationsSince?: number;
  muted?: boolean;
  blocked?: boolean;
  readAt?: number;
  activitySince?: number;
  lastActivityAt?: number;
}
export class PublicGroupData {
  private db: Promise<IDBDatabase>;
  constructor(account: string) {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new Error('Public groups require an account.');
    rememberAccountDatabase(`anagram-public-groups-${account}`);
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(`anagram-public-groups-${account}`, 5);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('receipts')) {
          const receipts = req.result.createObjectStore('receipts', { keyPath: ['room', 'id'] });
          receipts.createIndex('unread', ['room', 'unread']);
        }
        if (!req.result.objectStoreNames.contains('inbox')) {
          const inbox = req.result.createObjectStore('inbox', {
            keyPath: 'sequence',
            autoIncrement: true,
          });
          inbox.createIndex('identity', ['room', 'event.id'], { unique: true });
          inbox.createIndex('room', ['room', 'sequence']);
        }
        if (!req.result.objectStoreNames.contains('rooms')) {
          req.result.createObjectStore('rooms', { keyPath: 'address' });
          const messages = req.result.createObjectStore('messages', { keyPath: ['room', 'id'] });
          messages.createIndex('timeline', ['room', 'created_at', 'id']);
        }
        const actions = req.result.objectStoreNames.contains('actions')
          ? req.transaction!.objectStore('actions')
          : req.result.createObjectStore('actions', { keyPath: ['room', 'id'] });
        if (!actions.indexNames.contains('targets'))
          actions.createIndex('targets', 'targets', { multiEntry: true });
        if (!actions.indexNames.contains('timeline'))
          actions.createIndex('timeline', ['room', 'created_at', 'id']);
        if (!actions.indexNames.contains('authoredTargets')) {
          actions.createIndex('authoredTargets', 'authoredTargets', { multiEntry: true });
          actions.createIndex('kindTargets', 'kindTargets', { multiEntry: true });
          const cursor = actions.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const value = row.value;
            row.update({
              ...value,
              authoredTargets: value.targets.map((key: string[]) => [...key, value.pubkey]),
              kindTargets: value.targets.map((key: string[]) => [...key, value.kind]),
            });
            row.continue();
          };
        }
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  async close() {
    await this.writesDone;
    (await this.db).close();
  }
  private async transaction<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Public group storage failed.'));
      run(tx.objectStore(store), (v) => {
        value = v;
      });
    });
  }
  private writes = new Map<
    string,
    {
      room: string;
      event: PublicGroupMessage;
      timeline: boolean;
      resolve: () => void;
      reject: (error: unknown) => void;
      promise: Promise<void>;
    }
  >();
  private writing = false;
  private writesDone: Promise<void> = Promise.resolve();
  /** Coalesce replica receipts before bounded journal writes, independently of hydration. */
  enqueue(room: string, event: PublicGroupMessage, timeline: boolean): Promise<void> {
    const key = JSON.stringify([room, event.id]);
    const previous = this.writes.get(key);
    if (previous) {
      previous.event = {
        ...event,
        relay_statuses: mergeMessageRelayStatuses(
          previous.event.relay_statuses ?? [],
          event.relay_statuses ?? [],
        ).slice(-32),
      };
      previous.timeline ||= timeline;
      return previous.promise;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.writes.set(key, { room, event, timeline, resolve, reject, promise });
    if (!this.writing) {
      this.writing = true;
      this.writesDone = this.flushInbox();
    }
    return promise;
  }
  private async flushInbox() {
    // Coalesce a synchronous relay burst before taking the first write batch.
    await Promise.resolve();
    try {
      while (this.writes.size) {
        const batch = [];
        for (const entry of this.writes) {
          batch.push(entry);
          if (batch.length === 64) break;
        }
        for (const [key] of batch) this.writes.delete(key);
        try {
          await this.transaction<void>('inbox', 'readwrite', (store) => {
            for (const [, item] of batch) {
              const request = store.index('identity').get([item.room, item.event.id!]);
              request.onsuccess = () => {
                const previous = request.result as PublicInboxRecord | undefined;
                store.put({
                  ...(previous ? { sequence: previous.sequence } : {}),
                  revision: (previous?.revision ?? 0) + 1,
                  room: item.room,
                  timeline: item.timeline || previous?.timeline || false,
                  event: {
                    ...item.event,
                    relay_statuses: mergeMessageRelayStatuses(
                      previous?.event.relay_statuses ?? [],
                      item.event.relay_statuses ?? [],
                    ).slice(-32),
                  },
                });
              };
            }
          });
          for (const [, item] of batch) item.resolve();
        } catch (error) {
          for (const [, item] of batch) item.reject(error);
        }
      }
    } finally {
      this.writing = false;
    }
  }
  inboxPage(room: string): Promise<PublicInboxRecord[]> {
    return this.transaction('inbox', 'readonly', (store, done) => {
      const request = store
        .index('room')
        .getAll(IDBKeyRange.bound([room, 0], [room, Number.MAX_SAFE_INTEGER]), 64);
      request.onsuccess = () => done(request.result);
    });
  }
  completeInbox(records: PublicInboxRecord[]): Promise<void> {
    return this.transaction('inbox', 'readwrite', (store) => {
      for (const record of records) {
        const request = store.get(record.sequence);
        request.onsuccess = () => {
          // A receipt arriving during processing must survive this acknowledgement.
          if (request.result?.revision === record.revision) store.delete(record.sequence);
        };
      }
    });
  }
  list(): Promise<SavedPublicRoom[]> {
    return this.transaction('rooms', 'readonly', (s, done) => {
      const rows: SavedPublicRoom[] = [];
      const request = s.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= 200) {
          done(rows);
          return;
        }
        if (cursor.value.joined && !cursor.value.successor) rows.push(cursor.value);
        cursor.continue();
      };
    });
  }
  get(address: string): Promise<SavedPublicRoom | undefined> {
    return this.transaction('rooms', 'readonly', (s, done) => {
      const r = s.get(address);
      r.onsuccess = () => done(r.result);
    });
  }
  seed(room: PublicRoom): Promise<void> {
    return this.transaction('rooms', 'readwrite', (store) => {
      const request = store.get(room.address);
      request.onsuccess = () => {
        // Existing rows include explicit leaves and accepted ownership transfers.
        // Never overwrite either, or a newer profile, with the bundled snapshot.
        if (!request.result) store.add({ address: room.address, room, joined: true, updated: 0 });
      };
    });
  }
  save(value: SavedPublicRoom): Promise<SavedPublicRoom> {
    return this.transaction('rooms', 'readwrite', (store, done) => {
      const request = store.get(value.address);
      request.onsuccess = () => {
        const previous = request.result as SavedPublicRoom | undefined;
        // A refresh can finish after a newer live policy has already been saved.
        // Compare inside the write transaction so concurrent saves cannot regress it.
        const saved = {
          ...previous,
          ...value,
          room: previous && newerRoom(previous.room, value.room) ? previous.room : value.room,
          successor: previous?.successor || value.successor,
        };
        store.put(saved);
        done(saved);
      };
    });
  }
  /** Local preferences are independent of signed room metadata and relay refreshes. */
  updateLocal(address: string, patch: Partial<Pick<SavedPublicRoom,
    'notificationsEnabled' | 'notificationsSince' | 'muted' | 'blocked' | 'activitySince'>>): Promise<SavedPublicRoom | undefined> {
    return this.transaction('rooms', 'readwrite', (store, done) => {
      const request = store.get(address);
      request.onsuccess = () => {
        if (!request.result) return done(undefined);
        const row = { ...request.result, ...patch };
        store.put(row);
        done(row);
      };
    });
  }
  async recordActivity(
    address: string,
    event: PublicGroupMessage,
    visible: boolean,
    mentionsMe = false,
  ): Promise<{
    row: SavedPublicRoom | undefined; fresh: boolean;
  }> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['rooms', 'receipts'], 'readwrite');
      let row: SavedPublicRoom | undefined;
      let fresh = false;
      tx.oncomplete = () => resolve({ row, fresh });
      tx.onerror = tx.onabort = () => reject(tx.error);
      const rooms = tx.objectStore('rooms'), receipts = tx.objectStore('receipts');
      const request = rooms.get(address);
      request.onsuccess = () => {
        row = request.result;
        if (!row?.joined || row.blocked || row.successor) return;
        const membership = row;
        if (event.created_at < (membership.activitySince ?? Number.MAX_SAFE_INTEGER)) return;
        const known = receipts.get([address, event.id!]);
        known.onsuccess = () => {
          if (known.result) return;
          fresh = event.created_at >= (membership.activitySince ?? Number.MAX_SAFE_INTEGER);
          const unread = fresh && !visible && event.created_at >= (membership.readAt ?? 0);
          const mention = unread && mentionsMe;
          // author/version let later edits and deletions retarget the mention.
          receipts.add({ room: address, id: event.id, unread: unread ? 1 : 0,
            author: event.pubkey, version: event.id, mention: mention ? 1 : 0 });
          row = { ...membership,
            unreadCount: (membership.unreadCount ?? 0) + (unread ? 1 : 0),
            unreadMentionCount: (membership.unreadMentionCount ?? 0) + (mention ? 1 : 0),
            lastActivityAt: Math.max(membership.lastActivityAt ?? 0, event.created_at),
          };
          rooms.put(row);
        };
      };
    });
  }
  /**
   * Apply an edit or deletion to an unread message's mention. `version` is the
   * signed event whose text is current: an edit applies only on top of it, and a
   * deletion clears the mention only when it removes that version.
   */
  async updateMention(
    address: string,
    change:
      | {
          kind: 'edit';
          root: string;
          target: string;
          id: string;
          author: string;
          mentionsMe: boolean;
        }
      | { kind: 'delete'; targets: string[]; author: string },
  ): Promise<SavedPublicRoom | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['rooms', 'receipts'], 'readwrite');
      let row: SavedPublicRoom | undefined;
      let delta = 0;
      tx.oncomplete = () => resolve(row);
      tx.onerror = tx.onabort = () => reject(tx.error);
      const rooms = tx.objectStore('rooms'), receipts = tx.objectStore('receipts');
      const roots = change.kind === 'edit' ? [change.root] : change.targets;
      let pending = roots.length;
      const finish = () => {
        if (--pending > 0 || delta === 0) return;
        const request = rooms.get(address);
        request.onsuccess = () => {
          if (!request.result) return;
          row = { ...request.result,
            unreadMentionCount: Math.max(0, (request.result.unreadMentionCount ?? 0) + delta) };
          rooms.put(row);
        };
      };
      for (const root of roots) {
        const request = receipts.get([address, root]);
        request.onsuccess = () => {
          const receipt = request.result;
          const version = receipt?.version ?? root;
          if (receipt?.unread === 1 && receipt.author === change.author) {
            if (change.kind === 'edit' && (change.target === version || version === root)) {
              const mention = change.mentionsMe ? 1 : 0;
              delta += mention - (receipt.mention ?? 0);
              receipts.put({ ...receipt, version: change.id, mention });
            } else if (
              change.kind === 'delete' &&
              receipt.mention === 1 &&
              change.targets.includes(version)
            ) {
              delta -= 1;
              receipts.put({ ...receipt, mention: 0 });
            }
          }
          finish();
        };
      }
    });
  }
  async markRead(address: string): Promise<SavedPublicRoom | undefined> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['rooms', 'receipts'], 'readwrite');
      let row: SavedPublicRoom | undefined;
      tx.oncomplete = () => resolve(row);
      tx.onerror = tx.onabort = () => reject(tx.error);
      const rooms = tx.objectStore('rooms');
      const request = rooms.get(address);
      request.onsuccess = () => {
        if (!request.result) return;
        row = { ...request.result, unreadCount: 0, unreadMentionCount: 0,
          readAt: Math.floor(Date.now() / 1000) };
        rooms.put(row);
      };
      const unread = tx.objectStore('receipts').index('unread').openCursor(IDBKeyRange.only([address, 1]));
      unread.onsuccess = () => {
        const cursor = unread.result;
        if (!cursor) return;
        cursor.update({ ...cursor.value, unread: 0 });
        cursor.continue();
      };
    });
  }
  message(room: string, id: string): Promise<PublicGroupMessage | undefined> {
    return this.transaction('messages', 'readonly', (s, done) => {
      const request = s.get([room, id]);
      request.onsuccess = () => {
        const value = request.result;
        if (!value) return done(undefined);
        const { room: _, ...event } = value;
        done(event);
      };
    });
  }
  async put(room: string, event: PublicGroupMessage): Promise<PublicGroupMessage> {
    return (await this.putMany(room, [event]))[0];
  }
  async putMany(room: string, events: PublicGroupMessage[]): Promise<PublicGroupMessage[]> {
    const saved: PublicGroupMessage[] = [];
    // Merge receipt and ACK evidence atomically; replay must not erase delivery status.
    for (let offset = 0; offset < events.length; offset += 64) {
      const merged = new Map<string, PublicGroupMessage>();
      for (const event of events.slice(offset, offset + 64))
        merged.set(event.id!, {
          ...event,
          relay_statuses: mergeMessageRelayStatuses(
            merged.get(event.id!)?.relay_statuses ?? [],
            event.relay_statuses ?? [],
          ),
        });
      const batch = [...merged.values()];
      await this.transaction<void>('messages', 'readwrite', (s) => {
        for (const event of batch) {
          const request = s.get([room, event.id!]);
          request.onsuccess = () => {
            const relay_statuses = mergeMessageRelayStatuses(
              request.result?.relay_statuses ?? [],
              event.relay_statuses ?? [],
            ).slice(-32);
            const value = { ...event, ...(relay_statuses.length ? { relay_statuses } : {}) };
            saved.push(value);
            s.put({ ...value, room });
          };
        }
        // Retain fetched history, as private groups do. Reads and writes remain
        // bounded; deleting older rows here would invalidate completed cursors.
      });
    }
    return saved;
  }
  action(room: string, id: string): Promise<PublicGroupMessage | undefined> {
    return this.transaction('actions', 'readonly', (store, done) => {
      const request = store.get([room, id]);
      request.onsuccess = () => {
        if (!request.result) return done(undefined);
        const {
          room: _,
          targets: __,
          authoredTargets: ___,
          kindTargets: ____,
          ...event
        } = request.result;
        done(event);
      };
    });
  }
  async putActions(room: string, entries: { event: PublicGroupMessage; targets: string[] }[]) {
    for (let offset = 0; offset < entries.length; offset += 64) {
      await this.transaction<void>('actions', 'readwrite', (store) => {
        const batch = entries.slice(offset, offset + 64);
        let remaining = batch.length;
        for (const { event, targets } of batch) {
          const request = store.get([room, event.id!]);
          request.onsuccess = () => {
            store.put({
              ...event,
              room,
              targets: targets.map((id) => [room, id]),
              authoredTargets: targets.map((id) => [room, id, event.pubkey]),
              kindTargets: targets.map((id) => [room, id, event.kind]),
              relay_statuses: mergeMessageRelayStatuses(
                request.result?.relay_statuses ?? [],
                event.relay_statuses ?? [],
              ).slice(-32),
            });
            if (--remaining === 0) prune();
          };
        }
        function prune() {
          let positioned = false;
          const request = store
            .index('timeline')
            .openCursor(
              IDBKeyRange.bound([room, 0, ''], [room, Number.MAX_SAFE_INTEGER, '\uffff']),
              'prev',
            );
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (!positioned) {
              positioned = true;
              cursor.advance(8000);
              return;
            }
            cursor.delete();
            cursor.continue();
          };
        }
      });
    }
  }
  actionsFor(
    room: string,
    ids: string[],
    authors?: Map<string, string>,
  ): Promise<PublicGroupMessage[]> {
    return this.transaction('actions', 'readonly', (store, done) => {
      const values = new Map<string, PublicGroupMessage>();
      const targets = [...new Set(ids)].slice(0, 512);
      const queries = targets.flatMap((id) =>
        authors?.has(id)
          ? [
              { index: 'authoredTargets', key: [room, id, authors.get(id)!] },
              { index: 'kindTargets', key: [room, id, 7] },
            ]
          : [{ index: 'targets', key: [room, id] }],
      );
      let remaining = queries.length;
      if (!remaining) return done([]);
      for (const { index, key } of queries) {
        let count = 0;
        const request = store.index(index).openCursor(IDBKeyRange.only(key));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || count++ >= 128) {
            if (--remaining === 0) done([...values.values()]);
            return;
          }
          const {
            room: _,
            targets: __,
            authoredTargets: ___,
            kindTargets: ____,
            ...event
          } = cursor.value;
          values.set(event.id, event);
          cursor.continue();
        };
      }
    });
  }
  search(
    room: string,
    query: string,
    textFor: (event: PublicGroupMessage) => string | null,
    signal?: AbortSignal,
  ): Promise<{ messageId: string; text: string }[]> {
    const normalized = normalizeMessageSearchText(query);
    if (!normalized || signal?.aborted) return Promise.resolve([]);
    return this.transaction('messages', 'readonly', (store, done) => {
      const results: { messageId: string; text: string }[] = [];
      const request = store
        .index('timeline')
        .openCursor(
          IDBKeyRange.bound([room, 0, ''], [room, Number.MAX_SAFE_INTEGER, '\uffff']),
          'prev',
        );
      request.onsuccess = () => {
        const cursor = request.result;
        if (signal?.aborted) return done([]);
        if (!cursor || results.length >= 100) return done(results);
        const { room: _, ...event } = cursor.value;
        const text = textFor(event);
        if (text !== null && normalizeMessageSearchText(text).includes(normalized))
          results.push({ messageId: event.id, text });
        cursor.continue();
      };
    });
  }
  page(
    room: string,
    before?: { created_at: number; id: string },
    limit = 50,
    direction: IDBCursorDirection = 'prev',
  ): Promise<PublicGroupMessage[]> {
    return this.transaction('messages', 'readonly', (s, done) => {
      const values: PublicGroupMessage[] = [];
      const r = s
        .index('timeline')
        .openCursor(
          IDBKeyRange.bound(
            direction === 'next' && before ? [room, before.created_at, before.id] : [room, 0, ''],
            direction === 'prev' && before
              ? [room, before.created_at, before.id]
              : [room, Number.MAX_SAFE_INTEGER, '\uffff'],
            direction === 'next' && Boolean(before),
            direction === 'prev' && Boolean(before),
          ),
          direction,
        );
      r.onsuccess = () => {
        const c = r.result;
        if (!c || values.length >= limit) {
          done(direction === 'prev' ? values.reverse() : values);
          return;
        }
        const { room: _, ...event } = c.value;
        values.push(event);
        c.continue();
      };
    });
  }
}
