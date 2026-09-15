import { closeIndexedDbConnection, deleteIndexedDbDatabase } from 'src/utils/indexedDbStorage';

export type DeveloperTraceLevel = 'info' | 'warn' | 'error';

export interface DeveloperTraceEntry {
  id: string;
  timestamp: string;
  level: DeveloperTraceLevel;
  scope: string;
  phase: string;
  details: Record<string, unknown>;
}

interface DeveloperTraceStoreRecord extends DeveloperTraceEntry {
  loggedAtMs: number;
}

const DEVELOPER_TRACE_DB_NAME = 'developer-trace-indexeddb-v1';
const DEVELOPER_TRACE_DB_VERSION = 1;
const DEVELOPER_TRACE_STORE = 'trace_entries';
const DEVELOPER_TRACE_LOGGED_AT_MS_INDEX = 'logged_at_ms';
const DEVELOPER_TRACE_LIMIT = 10000;

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    };
  });
}

function normalizeEntry(entry: DeveloperTraceEntry): DeveloperTraceStoreRecord {
  const loggedAtMs = Date.parse(entry.timestamp);

  return {
    ...entry,
    loggedAtMs: Number.isFinite(loggedAtMs) ? loggedAtMs : Date.now(),
  };
}

function toDeveloperTraceEntry(record: DeveloperTraceStoreRecord): DeveloperTraceEntry {
  return {
    id: String(record.id),
    timestamp: String(record.timestamp),
    level: record.level,
    scope: String(record.scope),
    phase: String(record.phase),
    details:
      record.details && typeof record.details === 'object' && !Array.isArray(record.details)
        ? record.details
        : {},
  };
}

function normalizeStoredRecord(value: unknown): DeveloperTraceStoreRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<DeveloperTraceStoreRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.timestamp !== 'string' ||
    typeof record.scope !== 'string' ||
    typeof record.phase !== 'string' ||
    (record.level !== 'info' && record.level !== 'warn' && record.level !== 'error')
  ) {
    return null;
  }

  return {
    id: record.id,
    timestamp: record.timestamp,
    level: record.level,
    scope: record.scope,
    phase: record.phase,
    details:
      record.details && typeof record.details === 'object' && !Array.isArray(record.details)
        ? record.details
        : {},
    loggedAtMs:
      typeof record.loggedAtMs === 'number' && Number.isFinite(record.loggedAtMs)
        ? record.loggedAtMs
        : Date.parse(record.timestamp),
  };
}

class DeveloperTraceDataService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private mutationQueue = Promise.resolve();

  async appendEntry(entry: DeveloperTraceEntry): Promise<void> {
    return this.appendEntries([entry]);
  }

  async appendEntries(entries: DeveloperTraceEntry[]): Promise<void> {
    const normalizedEntries = entries.map(normalizeEntry);
    if (!normalizedEntries.length) return;
    return this.enqueueMutation(async () => {
      const db = await this.getDatabase();
      if (!db) return;
      const transaction = db.transaction(DEVELOPER_TRACE_STORE, 'readwrite');
      const completed = waitForTransaction(transaction);
      const store = transaction.objectStore(DEVELOPER_TRACE_STORE);
      for (const entry of normalizedEntries) store.put(entry);
      // One count/prune per batch, inside the same serialized transaction.
      await Promise.all([this.pruneOverflowEntries(store), completed]);
    });
  }

  async listEntries(): Promise<DeveloperTraceEntry[]> {
    await this.mutationQueue;

    const db = await this.getDatabase();
    if (!db) {
      return [];
    }

    const transaction = db.transaction(DEVELOPER_TRACE_STORE, 'readonly');
    const store = transaction.objectStore(DEVELOPER_TRACE_STORE);
    const index = store.index(DEVELOPER_TRACE_LOGGED_AT_MS_INDEX);
    const records = await new Promise<DeveloperTraceStoreRecord[]>((resolve, reject) => {
      const entries: DeveloperTraceStoreRecord[] = [];
      const request = index.openCursor(null, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(entries);
          return;
        }

        const record = normalizeStoredRecord(cursor.value);
        if (record) {
          entries.push(record);
        }
        cursor.continue();
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to read developer trace entries.'));
      };
    });
    await waitForTransaction(transaction);
    return records.map((record) => toDeveloperTraceEntry(record));
  }

  async clearEntries(): Promise<void> {
    return this.enqueueMutation(async () => {
      const db = await this.getDatabase();
      if (!db) {
        return;
      }

      const transaction = db.transaction(DEVELOPER_TRACE_STORE, 'readwrite');
      const store = transaction.objectStore(DEVELOPER_TRACE_STORE);
      store.clear();
      await waitForTransaction(transaction);
    });
  }

  async clearAllData(): Promise<void> {
    return this.enqueueMutation(async () => {
      await closeIndexedDbConnection(this.dbPromise);
      this.dbPromise = null;
      await deleteIndexedDbDatabase(DEVELOPER_TRACE_DB_NAME);
    });
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const nextOperation = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = nextOperation.catch(() => undefined);
    return nextOperation;
  }

  private async pruneOverflowEntries(store: IDBObjectStore): Promise<void> {
    const entryCount = await requestToPromise<number>(store.count());
    let overflowCount = entryCount - DEVELOPER_TRACE_LIMIT;
    if (overflowCount <= 0) {
      return;
    }

    const index = store.index(DEVELOPER_TRACE_LOGGED_AT_MS_INDEX);
    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(null, 'next');

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || overflowCount <= 0) {
          resolve();
          return;
        }

        cursor.delete();
        overflowCount -= 1;
        cursor.continue();
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to prune developer trace entries.'));
      };
    });
  }

  private async getDatabase(): Promise<IDBDatabase | null> {
    if (!canUseIndexedDb()) {
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase().catch((error) => {
        console.error('Failed to open developer trace IndexedDB.', error);
        return null;
      });
    }

    return this.dbPromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DEVELOPER_TRACE_DB_NAME, DEVELOPER_TRACE_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const existingStoreNames = Array.from(db.objectStoreNames);
        const store = existingStoreNames.includes(DEVELOPER_TRACE_STORE)
          ? (request.transaction?.objectStore(DEVELOPER_TRACE_STORE) ?? null)
          : db.createObjectStore(DEVELOPER_TRACE_STORE, {
              keyPath: 'id',
            });

        if (store && !store.indexNames.contains(DEVELOPER_TRACE_LOGGED_AT_MS_INDEX)) {
          store.createIndex(DEVELOPER_TRACE_LOGGED_AT_MS_INDEX, 'loggedAtMs', { unique: false });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
        };
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open developer trace IndexedDB.'));
      };

      request.onblocked = () => {
        reject(new Error('Opening developer trace IndexedDB is blocked.'));
      };
    });
  }
}

export const developerTraceDataService = new DeveloperTraceDataService();
