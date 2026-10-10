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
export interface SavedPublicRoom {
  address: string;
  room: PublicRoom;
  joined: boolean;
  successor?: string;
  updated: number;
}
export class PublicGroupData {
  private db: Promise<IDBDatabase>;
  constructor(account: string) {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new Error('Public groups require an account.');
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(`anagram-public-groups-${account}`, 3);
      req.onupgradeneeded = () => {
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
          ...value,
          room: previous && newerRoom(previous.room, value.room) ? previous.room : value.room,
          successor: previous?.successor || value.successor,
        };
        store.put(saved);
        done(saved);
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
        let remaining = batch.length;
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
            if (--remaining === 0) prune();
          };
        }
        function prune() {
          let positioned = false;
          const request = s
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
              cursor.advance(2000);
              return;
            }
            cursor.delete();
            cursor.continue();
          };
        }
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
