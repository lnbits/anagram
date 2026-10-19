import type { StorageAdapter } from 'nostr-double-ratchet';

// Separate, account-scoped state: no chat history scans, JSON conversion, or localStorage keys.
export class RatchetStorage implements StorageAdapter {
  private database?: Promise<IDBDatabase>;
  private closed = false;
  constructor(private readonly owner: string) {}
  private db(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Messaging session closed.'));
    return (this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('anagram-ratchet', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        if (this.closed) {
          request.result.close();
          reject(new Error('Messaging session closed.'));
        } else resolve(request.result);
      };
    }));
  }
  private async request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    if (this.closed) throw new Error('Messaging session closed.');
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', mode);
      const request = operation(tx.objectStore('state'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.request('readonly', (store) => store.get(`${this.owner}:${key}`));
  }
  async put<T>(key: string, value: T): Promise<void> {
    await this.request('readwrite', (store) => store.put(value, `${this.owner}:${key}`));
  }
  async del(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(`${this.owner}:${key}`));
  }
  async list(prefix = ''): Promise<string[]> {
    const start = `${this.owner}:${prefix}`;
    const keys = await this.request('readonly', (store) =>
      store.getAllKeys(IDBKeyRange.bound(start, `${start}\uffff`)),
    );
    return keys.map((key) => String(key).slice(this.owner.length + 1));
  }
  async close(): Promise<void> {
    this.closed = true;
    (await this.database)?.close();
  }
}
