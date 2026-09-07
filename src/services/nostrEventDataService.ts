import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { MessageRelayStatus, NostrEventDirection, NostrEventEntry } from 'src/types/chat';
import { closeIndexedDbConnection, deleteIndexedDbDatabase } from 'src/utils/indexedDbStorage';
import {
  mergeMessageRelayStatuses,
  normalizeMessageRelayStatuses,
} from 'src/utils/messageRelayStatus';

interface NostrEventStoreRecord {
  gift_wraps?: Partial<Record<'recipient' | 'self', NostrEvent>>;
  event: NostrEvent;
  relay_statuses: MessageRelayStatus[];
  direction: NostrEventDirection;
}

export interface UpsertNostrEventInput {
  gift_wraps?: Partial<Record<'recipient' | 'self', NostrEvent>>;
  event: NostrEvent;
  relay_statuses?: MessageRelayStatus[];
  direction: NostrEventDirection;
}

const NOSTR_EVENTS_DB_NAME = 'nostr-events-indexeddb-v1';
const NOSTR_EVENTS_DB_VERSION = 1;
const EVENTS_STORE = 'events';

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

function normalizeEventId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeEvent(value: NostrEvent): NostrEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const eventId = normalizeEventId(value.id);
  const pubkey = typeof value.pubkey === 'string' ? value.pubkey.trim() : '';
  const content = typeof value.content === 'string' ? value.content : '';
  const createdAt = Number(value.created_at);
  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((tag): tag is string[] => Array.isArray(tag))
        .map((tag) => tag.map((entry) => String(entry)))
    : [];

  if (!eventId || !pubkey || !Number.isInteger(createdAt)) {
    return null;
  }

  const normalizedEvent: NostrEvent = {
    created_at: createdAt,
    content,
    tags,
    pubkey,
    id: eventId,
  };

  if (typeof value.kind === 'number') {
    normalizedEvent.kind = value.kind;
  }

  if (typeof value.sig === 'string' && value.sig.trim()) {
    normalizedEvent.sig = value.sig.trim();
  }

  return normalizedEvent;
}

function normalizeDirection(value: unknown): NostrEventDirection | null {
  if (value === 'in' || value === 'out') {
    return value;
  }

  return null;
}

function toNostrEventEntry(record: NostrEventStoreRecord): NostrEventEntry | null {
  const event = normalizeEvent(record.event);
  const direction = normalizeDirection(record.direction);
  if (!event || !direction) {
    return null;
  }

  return {
    event,
    direction,
    ...(record.gift_wraps ? { gift_wraps: record.gift_wraps } : {}),
    relay_statuses: normalizeMessageRelayStatuses(record.relay_statuses),
  };
}

class NostrEventDataService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private initPromise: Promise<void> | null = null;
  private databaseGeneration = 0;

  async init(): Promise<void> {
    await this.ensureInitialized();
  }

  async clearAllData(): Promise<void> {
    this.databaseGeneration += 1;
    const dbPromise = this.dbPromise;
    this.dbPromise = null;
    this.initPromise = null;
    await closeIndexedDbConnection(dbPromise);
    await deleteIndexedDbDatabase(NOSTR_EVENTS_DB_NAME);
  }

  async getEventById(eventId: string): Promise<NostrEventEntry | null> {
    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readonly');
    const store = transaction.objectStore(EVENTS_STORE);
    const record = await requestToPromise<NostrEventStoreRecord | undefined>(
      store.get(normalizedEventId) as IDBRequest<NostrEventStoreRecord | undefined>
    );
    await waitForTransaction(transaction);

    return record ? toNostrEventEntry(record) : null;
  }

  async getEventsByIds(eventIds: string[]): Promise<Map<string, NostrEventEntry>> {
    const normalizedEventIds = Array.from(
      new Set(
        eventIds
          .map((eventId) => normalizeEventId(eventId))
          .filter((eventId): eventId is string => Boolean(eventId))
      )
    );
    if (normalizedEventIds.length === 0) {
      return new Map<string, NostrEventEntry>();
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readonly');
    const store = transaction.objectStore(EVENTS_STORE);
    const requests = normalizedEventIds.map((eventId) => ({
      eventId,
      request: store.get(eventId) as IDBRequest<NostrEventStoreRecord | undefined>,
    }));

    const records = await Promise.all(
      requests.map(async ({ eventId, request }) => ({
        eventId,
        record: await requestToPromise<NostrEventStoreRecord | undefined>(request),
      }))
    );
    await waitForTransaction(transaction);

    const eventsById = new Map<string, NostrEventEntry>();
    for (const { eventId, record } of records) {
      if (!record) {
        continue;
      }

      const entry = toNostrEventEntry(record);
      if (entry) {
        eventsById.set(eventId, entry);
      }
    }

    return eventsById;
  }

  async listEventsByDirection(direction?: NostrEventDirection): Promise<NostrEventEntry[]> {
    const normalizedDirection =
      direction === undefined ? undefined : normalizeDirection(direction as unknown);
    if (direction !== undefined && !normalizedDirection) {
      return [];
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readonly');
    const store = transaction.objectStore(EVENTS_STORE);
    const records = await requestToPromise<NostrEventStoreRecord[]>(
      store.getAll() as IDBRequest<NostrEventStoreRecord[]>
    );
    await waitForTransaction(transaction);

    return records
      .map((record) => toNostrEventEntry(record))
      .filter((entry): entry is NostrEventEntry => {
        if (!entry) {
          return false;
        }

        return normalizedDirection ? entry.direction === normalizedDirection : true;
      });
  }

  async upsertEvent(input: UpsertNostrEventInput): Promise<NostrEventEntry | null> {
    const event = normalizeEvent(input.event);
    const direction = normalizeDirection(input.direction);
    if (!event || !direction) {
      return null;
    }

    const eventId = normalizeEventId(event.id);
    if (!eventId) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readwrite');
    const store = transaction.objectStore(EVENTS_STORE);
    const existingRecord = await requestToPromise<NostrEventStoreRecord | undefined>(
      store.get(eventId) as IDBRequest<NostrEventStoreRecord | undefined>
    );

    const nextRecord: NostrEventStoreRecord = {
      ...(existingRecord?.gift_wraps || input.gift_wraps
        ? { gift_wraps: { ...input.gift_wraps, ...existingRecord?.gift_wraps } }
        : {}),
      event,
      direction: existingRecord?.direction ?? direction,
      relay_statuses: mergeMessageRelayStatuses(
        normalizeMessageRelayStatuses(existingRecord?.relay_statuses),
        normalizeMessageRelayStatuses(input.relay_statuses)
      ),
    };

    await requestToPromise<IDBValidKey>(store.put(nextRecord, eventId) as IDBRequest<IDBValidKey>);
    await waitForTransaction(transaction);

    return toNostrEventEntry(nextRecord);
  }

  async appendRelayStatuses(
    eventId: string,
    relayStatuses: MessageRelayStatus[],
    options: {
      event?: NostrEvent;
      direction?: NostrEventDirection;
    } = {}
  ): Promise<NostrEventEntry | null> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedRelayStatuses = normalizeMessageRelayStatuses(relayStatuses);
    if (!normalizedEventId || normalizedRelayStatuses.length === 0) {
      return null;
    }

    const existingEvent = await this.getEventById(normalizedEventId);
    const nextEventInput = options.event
      ? { ...options.event, id: normalizedEventId }
      : existingEvent?.event
        ? { ...existingEvent.event, id: normalizedEventId }
        : null;
    const event = nextEventInput ? normalizeEvent(nextEventInput) : null;
    const direction = existingEvent?.direction ?? normalizeDirection(options.direction);
    if (!event || !direction) {
      return null;
    }

    return this.upsertEvent({
      event,
      direction,
      relay_statuses: normalizedRelayStatuses,
    });
  }

  async resolvePendingOutboundRelayStatuses(
    detail = 'Marked as failed after app reload interrupted publish.'
  ): Promise<number> {
    const normalizedDetail =
      detail.trim() || 'Marked as failed after app reload interrupted publish.';
    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readwrite');
    const store = transaction.objectStore(EVENTS_STORE);
    const records = await requestToPromise<NostrEventStoreRecord[]>(
      store.getAll() as IDBRequest<NostrEventStoreRecord[]>
    );

    let updatedStatusCount = 0;
    const updatedAt = new Date().toISOString();

    for (const record of records) {
      const event = normalizeEvent(record.event);
      const direction = normalizeDirection(record.direction);
      if (!event || !direction) {
        continue;
      }

      let didChange = false;
      const nextRelayStatuses = normalizeMessageRelayStatuses(record.relay_statuses).map(
        (relayStatus) => {
          if (relayStatus.direction !== 'outbound' || relayStatus.status !== 'pending') {
            return relayStatus;
          }

          didChange = true;
          updatedStatusCount += 1;
          return {
            ...relayStatus,
            status: 'failed' as const,
            updated_at: updatedAt,
            detail: relayStatus.detail?.trim() || normalizedDetail,
          };
        }
      );

      if (!didChange) {
        continue;
      }

      const nextRecord: NostrEventStoreRecord = {
        ...record,
        event,
        direction,
        relay_statuses: nextRelayStatuses,
      };

      await requestToPromise<IDBValidKey>(
        store.put(nextRecord, event.id) as IDBRequest<IDBValidKey>
      );
    }

    await waitForTransaction(transaction);
    return updatedStatusCount;
  }

  async deleteEventsByIds(eventIds: string[]): Promise<void> {
    const normalizedEventIds = Array.from(
      new Set(
        eventIds
          .map((eventId) => normalizeEventId(eventId))
          .filter((eventId): eventId is string => Boolean(eventId))
      )
    );
    if (normalizedEventIds.length === 0) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(EVENTS_STORE, 'readwrite');
    const store = transaction.objectStore(EVENTS_STORE);

    for (const eventId of normalizedEventIds) {
      store.delete(eventId);
    }

    await waitForTransaction(transaction);
  }

  private async getDatabase(): Promise<IDBDatabase> {
    await this.ensureInitialized();

    if (!this.dbPromise) {
      throw new Error('IndexedDB is not initialized.');
    }

    return this.dbPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }

    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    const databaseGeneration = this.databaseGeneration;
    const db = await this.openDatabase();
    if (databaseGeneration !== this.databaseGeneration) {
      db.close();
      return;
    }

    this.dbPromise = Promise.resolve(db);
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!canUseIndexedDb()) {
      return Promise.reject(new Error('IndexedDB is not available in this environment.'));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(NOSTR_EVENTS_DB_NAME, NOSTR_EVENTS_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          db.createObjectStore(EVENTS_STORE);
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
        reject(request.error ?? new Error('Failed to open nostr events IndexedDB database.'));
      };

      request.onblocked = () => {
        console.error('IndexedDB nostr events database open request is blocked by another tab.');
      };
    });
  }
}

export const nostrEventDataService = new NostrEventDataService();
