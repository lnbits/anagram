import { rememberAccountDatabase } from './indexedDbStorage.ts';

const KEY = 'nostr-chat-pending-logout-cleanup';
export function hasPendingLogoutCleanup(): boolean {
  return typeof window !== 'undefined' && window.localStorage?.getItem(KEY) === '1';
}
export function schedulePendingLogoutCleanup(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const owner = window.localStorage.getItem('npub');
  if (owner && /^[a-f0-9]{64}$/.test(owner))
    rememberAccountDatabase(`anagram-public-groups-${owner}`);
  window.localStorage.setItem(KEY, '1');
}
export function completePendingLogoutCleanup(): void {
  if (typeof window !== 'undefined') window.localStorage?.removeItem(KEY);
}
