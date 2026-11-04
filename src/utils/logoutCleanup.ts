import { privateStorageRelayService } from '#src/services/privateStorageRelayService.ts';
import { messageInbox } from '#src/lib/nostr/inbox.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { developerTraceDataService } from '#src/services/developerTraceDataService.ts';
import { imageCacheService } from '#src/services/imageCacheService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import {
  deleteIndexedDbDatabase,
  listIndexedDbDatabaseNames,
  rememberedAccountDatabases,
} from '#src/utils/indexedDbStorage.ts';
import { hasPendingLogoutCleanup, schedulePendingLogoutCleanup } from './logoutState.ts';
import { clearBotInteractionData } from '#src/services/botInteractionData.ts';
import { PUBLIC_KEY_STORAGE_KEY } from '#src/stores/nostr/constants.ts';

export const KNOWN_APP_INDEXED_DB_NAMES = [
  'anagram-hydration-inbox',
  'anagram-ratchet',
  'anagram-private-relays',
  'chat-data-indexeddb-v2',
  'contacts-indexeddb-v1',
  'developer-trace-indexeddb-v1',
  'nostr-events-indexeddb-v1',
  'nostr-chat-image-cache',
] as const;

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function hasSessionStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

function clearBrowserStorage(options: { preservePendingLogoutCleanup?: boolean } = {}): void {
  if (hasLocalStorage()) {
    const pending = options.preservePendingLogoutCleanup && hasPendingLogoutCleanup();
    window.localStorage.clear();
    if (pending) schedulePendingLogoutCleanup();
  }

  if (!hasSessionStorage()) {
    return;
  }

  window.sessionStorage.clear();
}

async function clearIndexedDbDatabases(): Promise<void> {
  const names = new Set([...rememberedAccountDatabases(), ...(await listIndexedDbDatabaseNames())]);
  const clearResults = await Promise.allSettled([
    messageInbox.clearAllData(),
    privateStorageRelayService.clearAllData(),
    chatDataService.clearAllData(),
    contactsService.clearAllData(),
    developerTraceDataService.clearAllData(),
    nostrEventDataService.clearAllData(),
    imageCacheService.clearAllData(),
  ]);

  // Services close their own handles and delete their databases. Only the inbox
  // clears in place; retry failed deletions and delete account/legacy databases.
  KNOWN_APP_INDEXED_DB_NAMES.forEach((name, index) => {
    if (index === 0 || clearResults[index].status === 'rejected') names.add(name);
    else names.delete(name);
  });
  const results = await Promise.allSettled([...names].map(deleteIndexedDbDatabase));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export async function clearPersistedAppState(
  options: { preservePendingLogoutCleanup?: boolean; botInteractionOwner?: string | null } = {},
): Promise<void> {
  // Read the deletion index before clearing localStorage. Keep it if deletion fails
  // so a retry can still find databases without indexedDB.databases().
  await clearBotInteractionData(
    options.botInteractionOwner ??
      (hasLocalStorage() ? window.localStorage.getItem(PUBLIC_KEY_STORAGE_KEY) : null),
  );
  await clearIndexedDbDatabases();
  clearBrowserStorage(options);
}
