import { privateStorageRelayService } from '#src/services/privateStorageRelayService.ts';
import { messageInbox } from '#src/lib/nostr/inbox.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { developerTraceDataService } from '#src/services/developerTraceDataService.ts';
import { imageCacheService } from '#src/services/imageCacheService.ts';
import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
import { deleteAllIndexedDbDatabases } from '#src/utils/indexedDbStorage.ts';
import { clearBotInteractionData } from '#src/services/botInteractionData.ts';
import { PUBLIC_KEY_STORAGE_KEY } from '#src/stores/nostr/constants.ts';

const PENDING_LOGOUT_CLEANUP_SESSION_KEY = 'nostr-chat-pending-logout-cleanup';

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
    window.localStorage.clear();
  }

  if (!hasSessionStorage()) {
    return;
  }

  const shouldRestorePendingFlag =
    options.preservePendingLogoutCleanup === true &&
    window.sessionStorage.getItem(PENDING_LOGOUT_CLEANUP_SESSION_KEY) === '1';

  window.sessionStorage.clear();

  if (shouldRestorePendingFlag) {
    window.sessionStorage.setItem(PENDING_LOGOUT_CLEANUP_SESSION_KEY, '1');
  }
}

async function clearIndexedDbDatabases(): Promise<void> {
  const clearResults = await Promise.allSettled([
    messageInbox.clearAllData(),
    privateStorageRelayService.clearAllData(),
    chatDataService.clearAllData(),
    contactsService.clearAllData(),
    developerTraceDataService.clearAllData(),
    nostrEventDataService.clearAllData(),
    imageCacheService.clearAllData(),
  ]);

  await deleteAllIndexedDbDatabases([...KNOWN_APP_INDEXED_DB_NAMES]);

  const rejectedResults = clearResults.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejectedResults.length > 0) {
    console.warn(
      'Some logout cleanup steps failed before the full IndexedDB reset completed.',
      rejectedResults.map((result) => result.reason),
    );
  }
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
  clearBrowserStorage(options);
  await clearIndexedDbDatabases();
}

export function schedulePendingLogoutCleanup(): void {
  if (!hasSessionStorage()) {
    return;
  }

  window.sessionStorage.setItem(PENDING_LOGOUT_CLEANUP_SESSION_KEY, '1');
}

export function hasPendingLogoutCleanup(): boolean {
  return (
    hasSessionStorage() && window.sessionStorage.getItem(PENDING_LOGOUT_CLEANUP_SESSION_KEY) === '1'
  );
}

export async function finalizePendingLogoutCleanup(): Promise<void> {
  if (!hasPendingLogoutCleanup()) {
    return;
  }

  try {
    await clearPersistedAppState({
      preservePendingLogoutCleanup: true,
    });
  } finally {
    if (hasSessionStorage()) {
      window.sessionStorage.removeItem(PENDING_LOGOUT_CLEANUP_SESSION_KEY);
    }
  }
}
