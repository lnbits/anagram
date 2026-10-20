import type { NostrEvent } from '#src/lib/nostr/client.ts';
import {
  HEX,
  targetKey,
  type BotControl,
  type InlineKeyboard,
} from '#src/stores/nostr/botKeyboardProtocol.ts';
import { deleteIndexedDbDatabase } from '#src/utils/indexedDbStorage.ts';

const DATABASE_PREFIX = 'anagram-bot-interactions-';
const knownOwners = new Set<string>();
let clearing = false;
let generation = 0;

// Keep a deletion index outside IndexedDB: older WebViews cannot enumerate databases.
function rememberOwner(owner: string): void {
  if (!HEX.test(owner)) return;
  if (typeof window !== 'undefined' && window.localStorage.getItem(DATABASE_PREFIX + owner) !== '1')
    window.localStorage.setItem(DATABASE_PREFIX + owner, '1');
  knownOwners.add(owner);
}

export async function clearBotInteractionData(legacyOwner?: string | null): Promise<void> {
  if (clearing) throw new Error('Bot interaction cleanup is already running');
  rememberOwner(legacyOwner ?? '');
  if (typeof window !== 'undefined') {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(DATABASE_PREFIX) && HEX.test(key.slice(DATABASE_PREFIX.length)))
        knownOwners.add(key.slice(DATABASE_PREFIX.length));
    }
  }
  clearing = true;
  generation++;
  try {
    for (const owner of knownOwners) {
      await deleteIndexedDbDatabase(DATABASE_PREFIX + owner);
      if (typeof window !== 'undefined') window.localStorage.removeItem(DATABASE_PREFIX + owner);
      knownOwners.delete(owner);
    }
  } finally {
    clearing = false;
  }
}

export interface BotInteraction {
  key: string;
  updated: number;
  request: BotControl;
  created: number;
  wrap?: NostrEvent;
  answer?: { eventId: string; text: string; keyboard: InlineKeyboard | null };
  previous?: BotInteraction['answer'];
}

// Small account-specific interaction cache. Never read the message archive.
async function database(owner: string): Promise<IDBDatabase> {
  if (!HEX.test(owner)) throw new Error('No active account');
  if (clearing) throw new Error('Bot interaction cleanup is running');
  rememberOwner(owner);
  const token = generation;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DATABASE_PREFIX + owner, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('interactions', { keyPath: 'key' });
      store.createIndex('request', 'request.id', { unique: true });
      store.createIndex('updated', 'updated');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      if (token !== generation) {
        db.close();
        reject(new Error('Bot interaction account was cleared'));
      } else resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function readBotInteraction(
  owner: string,
  key: string,
  byRequest = false,
): Promise<BotInteraction | undefined> {
  const db = await database(owner);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('interactions', 'readonly');
    const store = tx.objectStore('interactions');
    const req = (byRequest ? store.index('request') : store).get(key);
    tx.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveBotInteraction(
  owner: string,
  value: BotInteraction,
  expectedId?: string,
): Promise<boolean> {
  const db = await database(owner);
  return new Promise((resolve, reject) => {
    let saved = false;
    const tx = db.transaction('interactions', 'readwrite');
    const store = tx.objectStore('interactions');
    const current = store.get(value.key);
    current.onsuccess = () => {
      if (
        value.key !== targetKey(value.request.target) ||
        (expectedId && current.result?.request.id !== expectedId) ||
        (expectedId && current.result?.answer && !value.answer)
      )
        return;
      store.put(value);
      saved = true;
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - 500;
        if (excess <= 0) return;
        const cursor = store.index('updated').openCursor();
        cursor.onsuccess = () => {
          if (cursor.result && excess-- > 0) {
            cursor.result.delete();
            cursor.result.continue();
          }
        };
      };
    };
    tx.oncomplete = () => {
      db.close();
      resolve(saved);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
