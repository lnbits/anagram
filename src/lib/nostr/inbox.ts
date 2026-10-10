import { MESSAGE_HYDRATION_VERSION } from '#src/lib/nostr/hydrationVersion.ts';
import type { NostrEvent } from './client';
export interface InboxRecord {
  account: string;
  id: string;
  event: NostrEvent;
  priority: number;
  queuedAt: number;
  throttle: number;
  reprocess?: boolean;
  relayUrls?: string[];
}
// Ciphertext journal and account-scoped completion receipts. No plaintext or keys.
export class MessageInbox {
  private database?: Promise<IDBDatabase>;
  private db() {
    return (this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('anagram-hydration-inbox', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('inbox')) {
          const store = db.createObjectStore('inbox', { keyPath: ['account', 'id'] });
          store.createIndex('priority', ['account', 'priority', 'queuedAt', 'id']);
        }
        if (!db.objectStoreNames.contains('processed'))
          db.createObjectStore('processed', { keyPath: ['account', 'id'] });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }));
  }
  private pendingWrites: Array<{
    record: InboxRecord;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private flushing = false;
  private writesDone: Promise<void> = Promise.resolve();
  put(record: InboxRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ record, resolve, reject });
      if (!this.flushing) {
        this.flushing = true;
        this.writesDone = this.flushWrites();
      }
    });
  }
  private async flushWrites() {
    try {
      const db = await this.db();
      while (this.pendingWrites.length) {
        // Bound both transaction size and time before the first messages can drain.
        const batch = this.pendingWrites.splice(0, 64);
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('inbox', 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
            try {
              const store = tx.objectStore('inbox');
              for (const item of batch) store.put(item.record);
            } catch (error) {
              tx.abort();
              reject(error);
            }
          });
          batch.forEach((item) => item.resolve());
        } catch (error) {
          batch.forEach((item) => item.reject(error));
        }
      }
    } catch (error) {
      this.pendingWrites.splice(0).forEach((item) => item.reject(error));
      this.database = undefined;
    } finally {
      this.flushing = false;
    }
  }
  async next(
    account: string,
    limit = 32,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<InboxRecord[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('inbox', 'readonly');
      const index = tx.objectStore('inbox').index('priority');
      const range = IDBKeyRange.bound(
        [account, 0, 0, ''],
        [account, 1, Number.MAX_SAFE_INTEGER, '\uffff'],
      );
      if (excluded.size) {
        const rows: InboxRecord[] = [];
        const cursor = index.openCursor(range);
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item || rows.length >= limit) {
            resolve(rows);
            return;
          }
          if (!excluded.has(item.value.id)) rows.push(item.value);
          if (rows.length >= limit) resolve(rows);
          else item.continue();
        };
        return;
      }
      const request = index.getAll(range, limit);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async clearAllData(): Promise<void> {
    await this.writesDone;
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['inbox', 'processed'], 'readwrite');
      tx.objectStore('inbox').clear();
      tx.objectStore('processed').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async hasPending(account: string, id: string): Promise<boolean> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction('inbox', 'readonly')
        .objectStore('inbox')
        .getKey([account, id]);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  }
  async hasProcessed(account: string, id: string): Promise<boolean> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction('processed', 'readonly')
        .objectStore('processed')
        .get([account, id]);
      request.onsuccess = () => resolve(request.result?.version === MESSAGE_HYDRATION_VERSION);
      request.onerror = () => reject(request.error);
    });
  }
  // Called only after message processing commits. A crash before this transaction
  // can replay an already committed rumor, which the message's unique ID deduplicates.
  async complete(account: string, id: string): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['inbox', 'processed'], 'readwrite');
      tx.objectStore('processed').put({ account, id, version: MESSAGE_HYDRATION_VERSION });
      tx.objectStore('inbox').delete([account, id]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async remove(account: string, id: string) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('inbox', 'readwrite');
      tx.objectStore('inbox').delete([account, id]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}

export const messageInbox = new MessageInbox();
