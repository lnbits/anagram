import { deleteIndexedDbDatabase } from '#src/utils/indexedDbStorage.ts';
import { verifyEvent, type Event } from 'nostr-tools';
import { NostrUser, type NostrSigner } from '#src/lib/nostr/client.ts';

// Persist only the signed, encrypted kind-10013 event. Decrypted private relay
// URLs stay account-scoped in memory and never enter public contact metadata.
const snapshots = new Map<string, { event: Event; urls: string[] }>();
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('anagram-private-relays', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('events', { keyPath: 'pubkey' });
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
function older(a: Event, b: Event) {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id >= b.id);
}
export const privateStorageRelayService = {
  urls(owner: string): string[] {
    return [...(snapshots.get(owner)?.urls ?? [])];
  },
  reset() {
    snapshots.clear();
  },
  async clearAllData(): Promise<void> {
    snapshots.clear();
    const opened = database;
    database = undefined;
    if (opened) (await opened.catch(() => undefined))?.close();
    await deleteIndexedDbDatabase('anagram-private-relays');
  },
  async apply(
    event: Event,
    signer: NostrSigner,
    isCurrent: () => boolean,
    persist = true,
  ): Promise<boolean> {
    // Do not inherit nostr-tools' cached verification symbol from a mutable event.
    event = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    };
    if (
      !isCurrent() ||
      event.kind !== 10013 ||
      event.pubkey !== signer.pubkey ||
      !verifyEvent(event)
    )
      return false;
    const previous = snapshots.get(event.pubkey);
    if (previous && older(event, previous.event)) return false;
    const privateTags: unknown = event.content
      ? JSON.parse(
          await signer.decrypt(new NostrUser({ pubkey: event.pubkey }), event.content, 'nip44'),
        )
      : [];
    if (!Array.isArray(privateTags)) throw new Error('Invalid private relay list');
    const urls = [
      ...new Set(
        [...event.tags, ...privateTags]
          .filter((tag) => Array.isArray(tag) && tag[0] === 'relay' && typeof tag[1] === 'string')
          .flatMap((tag) => {
            try {
              const url = new URL(tag[1]);
              return ['ws:', 'wss:'].includes(url.protocol) ? [url.toString()] : [];
            } catch {
              return [];
            }
          }),
      ),
    ];
    if (!isCurrent()) return false;
    const latest = snapshots.get(event.pubkey);
    if (latest && older(event, latest.event)) return false;
    snapshots.set(event.pubkey, { event, urls });
    if (persist && typeof indexedDB !== 'undefined') {
      try {
        const database = await db();
        if (!isCurrent()) return false;
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction('events', 'readwrite');
          tx.objectStore('events').put(event);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch {
        // Storage failure must not prevent using the freshly decrypted routes.
      }
    }
    return true;
  },
  async restore(signer: NostrSigner, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent() || typeof indexedDB === 'undefined') return;
    const database = await db();
    const event = await new Promise<Event | undefined>((resolve, reject) => {
      const request = database.transaction('events').objectStore('events').get(signer.pubkey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (event) await this.apply(event, signer, isCurrent, false);
  },
};
