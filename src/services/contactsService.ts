import {
  rememberPublicProfile,
  clearPublicProfiles,
  type PublicProfile,
} from '#src/lib/state/publicProfiles.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type {
  ContactMetadata,
  ContactRecord,
  ContactRelay,
  ContactType,
  CreateContactInput,
  UpdateContactInput,
} from '#src/types/contact.ts';
import { searchContactsForList } from '#src/utils/contactList.ts';
import { closeIndexedDbConnection, deleteIndexedDbDatabase } from '#src/utils/indexedDbStorage.ts';

interface RawContactStoreRecord {
  id: number;
  public_key: string;
  type?: unknown;
  name: string;
  given_name?: string | null;
  relays?: unknown;
  sendMessagesToAppRelays?: unknown;
  meta: unknown;
}

interface ContactStoreRecord {
  id: number;
  public_key: string;
  type: ContactType;
  name: string;
  given_name: string | null;
  relays: ContactRelay[];
  sendMessagesToAppRelays: boolean;
  meta: ContactMetadata;
}

type DebugExecResult = Array<{
  columns: string[];
  values: unknown[][];
}>;

const CONTACTS_DB_NAME = 'contacts-indexeddb-v1';
const CONTACTS_DB_VERSION = 4;
const PUBLIC_PROFILES_STORE = 'public_profiles';

const CONTACTS_STORE = 'contacts';
const CONTACTS_PUBLIC_KEY_INDEX = 'public_key';

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function isConstraintError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'ConstraintError';
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = 'name' in error ? String(error.name) : '';
  return name === 'ConstraintError';
}

function isInvalidStateError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'InvalidStateError';
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = 'name' in error ? String(error.name) : '';
  return name === 'InvalidStateError';
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  return false;
}

function normalizeContactType(value: unknown): ContactType {
  return value === 'group' ? 'group' : 'user';
}

function parseStoredMeta(value: unknown): ContactMetadata {
  if (typeof value === 'string') {
    return inputSanitizerService.parseStoredContactMetadata(value);
  }

  return inputSanitizerService.normalizeContactMetadata(value);
}

function normalizeRelayValue(value: unknown): ContactRelay | null {
  if (typeof value === 'string') {
    const relayWs = inputSanitizerService.normalizeRelayWs(value);
    if (!relayWs) {
      return null;
    }

    return {
      url: relayWs,
      read: true,
      write: true,
    };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const relay = value as Partial<ContactRelay>;
  const relayWs = inputSanitizerService.normalizeRelayWs(String(relay.url ?? ''));
  if (!relayWs) {
    return null;
  }

  const normalizedRelay: ContactRelay = {
    url: relayWs,
    read: relay.read !== false,
    write: relay.write !== false,
  };

  if (!normalizedRelay.read && !normalizedRelay.write) {
    return null;
  }

  return normalizedRelay;
}

function compareRelayUrls(first: string, second: string): number {
  const byValue = first.localeCompare(second, undefined, { sensitivity: 'base' });
  if (byValue !== 0) {
    return byValue;
  }

  return first.localeCompare(second);
}

function normalizeRelayList(value: unknown): ContactRelay[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byUrl = new Map<string, ContactRelay>();
  for (const entry of value) {
    const relay = normalizeRelayValue(entry);
    if (!relay) {
      continue;
    }

    const key = relay.url.toLowerCase();
    const existingRelay = byUrl.get(key);
    if (existingRelay) {
      existingRelay.read = existingRelay.read || relay.read;
      existingRelay.write = existingRelay.write || relay.write;
      continue;
    }

    byUrl.set(key, relay);
  }

  return Array.from(byUrl.values()).sort((first, second) =>
    compareRelayUrls(first.url, second.url),
  );
}

function relayListsEqual(first: ContactRelay[], second: ContactRelay[]): boolean {
  if (first.length !== second.length) {
    return false;
  }

  for (let index = 0; index < first.length; index += 1) {
    const firstRelay = first[index];
    const secondRelay = second[index];
    if (
      firstRelay.url !== secondRelay.url ||
      firstRelay.read !== secondRelay.read ||
      firstRelay.write !== secondRelay.write
    ) {
      return false;
    }
  }

  return true;
}

function normalizeRecord(raw: RawContactStoreRecord): ContactStoreRecord | null {
  const id = Number(raw.id ?? 0);
  const publicKey = inputSanitizerService.normalizePublicKey(String(raw.public_key ?? ''));
  if (!Number.isInteger(id) || id <= 0 || !publicKey) {
    return null;
  }

  const name = String(raw.name ?? '').trim() || publicKey;
  const givenName = normalizeOptionalString(raw.given_name);

  return {
    id,
    public_key: publicKey,
    type: normalizeContactType(raw.type),
    name,
    given_name: givenName,
    relays: normalizeRelayList(raw.relays),
    sendMessagesToAppRelays: normalizeBooleanFlag(raw.sendMessagesToAppRelays),
    meta: parseStoredMeta(raw.meta),
  };
}

function toContactRecord(record: ContactStoreRecord): ContactRecord {
  const meta = parseStoredMeta(record.meta);
  if (!meta.blocked) {
    rememberPublicProfile(record.public_key, meta, meta.profile_event_created_at);
    for (const member of meta.group_members ?? []) rememberPublicProfile(member.public_key, member);
  }
  return {
    id: record.id,
    public_key: record.public_key,
    type: normalizeContactType(record.type),
    name: record.name,
    given_name: record.given_name,
    relays: normalizeRelayList(record.relays),
    sendMessagesToAppRelays: normalizeBooleanFlag(record.sendMessagesToAppRelays),
    meta: parseStoredMeta(record.meta),
  };
}

function compareContactsByName(first: ContactStoreRecord, second: ContactStoreRecord): number {
  const byName = first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) {
    return byName;
  }

  const byPublicKey = first.public_key.localeCompare(second.public_key, undefined, {
    sensitivity: 'base',
  });
  if (byPublicKey !== 0) {
    return byPublicKey;
  }

  return first.id - second.id;
}

function contactMetaEquals(first: ContactMetadata, second: ContactMetadata): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

class ContactsService {
  private activeDb: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private initPromise: Promise<void> | null = null;
  private databaseGeneration = 0;

  async init(): Promise<void> {
    await this.ensureInitialized();
  }

  async clearAllData(): Promise<void> {
    clearPublicProfiles();
    this.databaseGeneration += 1;
    const dbPromise = this.dbPromise;
    this.activeDb = null;
    this.dbPromise = null;
    this.initPromise = null;
    await closeIndexedDbConnection(dbPromise);
    await deleteIndexedDbDatabase(CONTACTS_DB_NAME);
  }

  async restorePublicProfiles(publicKeys: string[]): Promise<void> {
    const generation = this.databaseGeneration;
    const db = await this.getDatabase();
    if (generation !== this.databaseGeneration) return;
    const tx = db.transaction(PUBLIC_PROFILES_STORE, 'readonly');
    const done = waitForTransaction(tx);
    await Promise.all(
      [...new Set(publicKeys)].map(async (publicKey) => {
        const record = await requestToPromise<PublicProfile | undefined>(
          tx.objectStore(PUBLIC_PROFILES_STORE).get(publicKey),
        );
        if (record && generation === this.databaseGeneration)
          rememberPublicProfile(publicKey, record, record.createdAt, record.eventId);
      }),
    );
    await done;
  }

  async savePublicProfile(publicKey: string, profile: PublicProfile): Promise<void> {
    const generation = this.databaseGeneration;
    const db = await this.getDatabase();
    if (generation !== this.databaseGeneration) return;
    const tx = db.transaction(PUBLIC_PROFILES_STORE, 'readwrite');
    const done = waitForTransaction(tx);
    const store = tx.objectStore(PUBLIC_PROFILES_STORE);
    const get = store.get(publicKey);
    get.onsuccess = () => {
      const previous = get.result as PublicProfile | undefined;
      if (
        previous &&
        ((previous.createdAt ?? 0) > (profile.createdAt ?? 0) ||
          (previous.createdAt === profile.createdAt &&
            previous.eventId &&
            (!profile.eventId || previous.eventId <= profile.eventId)))
      )
        return;
      // Public display fields only. No contact/group secrets or membership.
      store.put({
        publicKey,
        name: profile.name,
        picture: profile.picture,
        createdAt: profile.createdAt,
        eventId: profile.eventId,
      });
    };
    await done;
  }

  async listContacts(): Promise<ContactRecord[]> {
    const records = await this.listStoreRecords();
    return records.sort(compareContactsByName).map((record) => toContactRecord(record));
  }

  async searchContacts(searchText: string): Promise<ContactRecord[]> {
    const query = searchText.trim();
    if (!query) {
      return this.listContacts();
    }

    const contacts = (await this.listStoreRecords())
      .sort(compareContactsByName)
      .map((record) => toContactRecord(record));

    return searchContactsForList(contacts, query);
  }

  async getContactById(id: number): Promise<ContactRecord | null> {
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readonly');
    const store = transaction.objectStore(CONTACTS_STORE);
    const rawRecord = await requestToPromise<RawContactStoreRecord | undefined>(
      store.get(id) as IDBRequest<RawContactStoreRecord | undefined>,
    );
    await waitForTransaction(transaction);

    const record = rawRecord ? normalizeRecord(rawRecord) : null;
    return record ? toContactRecord(record) : null;
  }

  async getContactByPublicKey(publicKey: string): Promise<ContactRecord | null> {
    return this.getContactByPublicKeyInternal(publicKey, true);
  }

  private async getContactByPublicKeyInternal(
    publicKey: string,
    allowRetry: boolean,
  ): Promise<ContactRecord | null> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return null;
    }

    try {
      const db = await this.getDatabase();
      const transaction = db.transaction(CONTACTS_STORE, 'readonly');
      const store = transaction.objectStore(CONTACTS_STORE);
      const index = store.index(CONTACTS_PUBLIC_KEY_INDEX);
      const rawRecord = await requestToPromise<RawContactStoreRecord | undefined>(
        index.get(normalizedPublicKey) as IDBRequest<RawContactStoreRecord | undefined>,
      );
      await waitForTransaction(transaction);

      const record = rawRecord ? normalizeRecord(rawRecord) : null;
      return record ? toContactRecord(record) : null;
    } catch (error) {
      if (allowRetry && isInvalidStateError(error)) {
        this.resetDatabaseState();
        return this.getContactByPublicKeyInternal(publicKey, false);
      }

      throw error;
    }
  }

  async publicKeyExists(publicKey: string): Promise<boolean> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return false;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readonly');
    const store = transaction.objectStore(CONTACTS_STORE);
    const index = store.index(CONTACTS_PUBLIC_KEY_INDEX);
    const count = await requestToPromise<number>(
      index.count(IDBKeyRange.only(normalizedPublicKey)),
    );
    await waitForTransaction(transaction);

    return count > 0;
  }

  async createContact(input: CreateContactInput): Promise<ContactRecord | null> {
    const publicKey = inputSanitizerService.normalizePublicKey(input.public_key);
    if (!publicKey) {
      return null;
    }

    const name = input.name.trim() || publicKey;
    const givenName = input.given_name?.trim() || null;
    const meta = inputSanitizerService.normalizeContactMetadata(input.meta);
    const relays = normalizeRelayList(input.relays ?? []);
    const sendMessagesToAppRelays = input.sendMessagesToAppRelays === true;

    const record: Omit<ContactStoreRecord, 'id'> = {
      public_key: publicKey,
      type: normalizeContactType(input.type),
      name,
      given_name: givenName,
      relays,
      sendMessagesToAppRelays,
      meta,
    };

    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readwrite');
    const store = transaction.objectStore(CONTACTS_STORE);

    try {
      const insertedId = await requestToPromise<IDBValidKey>(
        store.add(record) as IDBRequest<IDBValidKey>,
      );
      await waitForTransaction(transaction);

      return toContactRecord({
        ...record,
        id: Number(insertedId),
      });
    } catch (error) {
      if (isConstraintError(error)) {
        return null;
      }

      console.error('Failed to create contact in IndexedDB.', error);
      return null;
    }
  }

  async updateContact(id: number, input: UpdateContactInput): Promise<ContactRecord | null> {
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readwrite');
    const store = transaction.objectStore(CONTACTS_STORE);
    const rawExistingRecord = await requestToPromise<RawContactStoreRecord | undefined>(
      store.get(id) as IDBRequest<RawContactStoreRecord | undefined>,
    );
    const existingRecord = rawExistingRecord ? normalizeRecord(rawExistingRecord) : null;
    if (!existingRecord) {
      await waitForTransaction(transaction);
      return null;
    }

    const nextRecord: ContactStoreRecord = {
      ...existingRecord,
    };
    let didUpdateRecord = false;

    if (input.public_key !== undefined) {
      const publicKey = inputSanitizerService.normalizePublicKey(input.public_key);
      if (!publicKey) {
        await waitForTransaction(transaction);
        return null;
      }

      if (nextRecord.public_key !== publicKey) {
        nextRecord.public_key = publicKey;
        didUpdateRecord = true;
      }
    }

    if (input.type !== undefined) {
      const nextType = normalizeContactType(input.type);
      if (nextRecord.type !== nextType) {
        nextRecord.type = nextType;
        didUpdateRecord = true;
      }
    }

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        await waitForTransaction(transaction);
        return null;
      }

      if (nextRecord.name !== name) {
        nextRecord.name = name;
        didUpdateRecord = true;
      }
    }

    if (input.given_name !== undefined) {
      const givenName = input.given_name?.trim() || null;
      if (nextRecord.given_name !== givenName) {
        nextRecord.given_name = givenName;
        didUpdateRecord = true;
      }
    }

    if (input.relays !== undefined) {
      const nextRelays = normalizeRelayList(input.relays);
      if (!relayListsEqual(nextRecord.relays, nextRelays)) {
        nextRecord.relays = nextRelays;
        didUpdateRecord = true;
      }
    }

    if (input.sendMessagesToAppRelays !== undefined) {
      const nextSendMessagesToAppRelays = input.sendMessagesToAppRelays === true;
      if (nextRecord.sendMessagesToAppRelays !== nextSendMessagesToAppRelays) {
        nextRecord.sendMessagesToAppRelays = nextSendMessagesToAppRelays;
        didUpdateRecord = true;
      }
    }

    if (input.meta !== undefined) {
      let nextMeta = inputSanitizerService.normalizeContactMetadata(input.meta);
      if (input.metaBase !== undefined) {
        // The caller may have awaited a relay/profile lookup since reading its
        // snapshot. Merge only its changes inside this readwrite transaction so
        // concurrent ownership, cursor and preference updates are not erased.
        const base = inputSanitizerService.normalizeContactMetadata(input.metaBase);
        const merged: Record<string, unknown> = { ...nextRecord.meta };
        for (const key of new Set([...Object.keys(base), ...Object.keys(nextMeta)])) {
          const field = key as keyof ContactMetadata;
          if (JSON.stringify(base[field]) === JSON.stringify(nextMeta[field])) continue;
          if (Object.hasOwn(nextMeta, key)) merged[key] = nextMeta[field];
          else delete merged[key];
        }
        nextMeta = inputSanitizerService.normalizeContactMetadata(merged);
      }
      if (!contactMetaEquals(nextRecord.meta, nextMeta)) {
        nextRecord.meta = nextMeta;
        didUpdateRecord = true;
      }
    }

    if (didUpdateRecord) {
      store.put(nextRecord);
    }

    try {
      await waitForTransaction(transaction);
    } catch (error) {
      if (isConstraintError(error)) {
        return null;
      }

      console.error('Failed to update contact in IndexedDB.', error);
      return null;
    }

    return toContactRecord(nextRecord);
  }

  async updateSendMessagesToAppRelays(
    publicKey: string,
    sendMessagesToAppRelays: boolean,
  ): Promise<ContactRecord | null> {
    const normalizedPublicKey = inputSanitizerService.normalizePublicKey(publicKey);
    if (!normalizedPublicKey) {
      return null;
    }

    const contact = await this.getContactByPublicKey(normalizedPublicKey);
    if (!contact) {
      return null;
    }

    return this.updateContact(contact.id, {
      sendMessagesToAppRelays,
    });
  }

  async deleteContact(id: number): Promise<boolean> {
    if (!Number.isInteger(id) || id <= 0) {
      return false;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readwrite');
    const store = transaction.objectStore(CONTACTS_STORE);
    const rawExistingRecord = await requestToPromise<RawContactStoreRecord | undefined>(
      store.get(id) as IDBRequest<RawContactStoreRecord | undefined>,
    );
    const existingRecord = rawExistingRecord ? normalizeRecord(rawExistingRecord) : null;
    if (!existingRecord) {
      await waitForTransaction(transaction);
      return false;
    }

    store.delete(id);

    try {
      await waitForTransaction(transaction);
      return true;
    } catch (error) {
      console.error('Failed to delete contact in IndexedDB.', error);
      return false;
    }
  }

  async debugExec(sql: string, params?: unknown): Promise<DebugExecResult> {
    if (!import.meta.env.DEV) {
      throw new Error('debugExec is available only in development mode.');
    }

    void sql;
    void params;

    const contacts = await this.listContacts();
    return [
      {
        columns: [
          'id',
          'public_key',
          'type',
          'name',
          'given_name',
          'meta',
          'relays',
          'sendMessagesToAppRelays',
        ],
        values: contacts.map((contact) => [
          contact.id,
          contact.public_key,
          contact.type,
          contact.name,
          contact.given_name,
          contact.meta,
          contact.relays ?? [],
          contact.sendMessagesToAppRelays,
        ]),
      },
    ];
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

    this.activeDb = db;
    this.dbPromise = Promise.resolve(db);
  }

  private async getDatabase(): Promise<IDBDatabase> {
    await this.ensureInitialized();

    if (!this.dbPromise) {
      throw new Error('Contacts IndexedDB is not initialized.');
    }

    return this.dbPromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!canUseIndexedDb()) {
      return Promise.reject(new Error('IndexedDB is not available in this environment.'));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(CONTACTS_DB_NAME, CONTACTS_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const transaction = request.transaction;
        if (!transaction) {
          return;
        }

        if (!db.objectStoreNames.contains(PUBLIC_PROFILES_STORE))
          db.createObjectStore(PUBLIC_PROFILES_STORE, { keyPath: 'publicKey' });

        const contactsStore = db.objectStoreNames.contains(CONTACTS_STORE)
          ? transaction.objectStore(CONTACTS_STORE)
          : db.createObjectStore(CONTACTS_STORE, { keyPath: 'id', autoIncrement: true });
        if (!contactsStore.indexNames.contains(CONTACTS_PUBLIC_KEY_INDEX)) {
          contactsStore.createIndex(CONTACTS_PUBLIC_KEY_INDEX, CONTACTS_PUBLIC_KEY_INDEX, {
            unique: true,
          });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (this.activeDb === db) {
            this.resetDatabaseState();
          }
        };
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open contacts IndexedDB database.'));
      };

      request.onblocked = () => {
        console.error('Contacts IndexedDB open request is blocked by another tab.');
      };
    });
  }

  private async listStoreRecords(): Promise<ContactStoreRecord[]> {
    const db = await this.getDatabase();
    const transaction = db.transaction(CONTACTS_STORE, 'readonly');
    const store = transaction.objectStore(CONTACTS_STORE);
    const rawRecords = await requestToPromise<RawContactStoreRecord[]>(
      store.getAll() as IDBRequest<RawContactStoreRecord[]>,
    );
    await waitForTransaction(transaction);

    return rawRecords
      .map((record) => normalizeRecord(record))
      .filter((record): record is ContactStoreRecord => record !== null);
  }

  private resetDatabaseState(): void {
    this.activeDb = null;
    this.dbPromise = null;
    this.initPromise = null;
  }
}

export const contactsService = new ContactsService();
