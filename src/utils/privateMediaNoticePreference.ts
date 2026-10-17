const PRIVATE_MEDIA_NOTICE_STORAGE_KEY = 'ui-private-media-notice-dismissed';

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

// Only hides the informational "media is end-to-end encrypted" notice shown before picking
// private media. Upload errors, retries and server changes are never affected by it.
export function isPrivateMediaNoticeDismissed(): boolean {
  if (!canUseStorage()) {
    return false;
  }

  try {
    return window.localStorage.getItem(PRIVATE_MEDIA_NOTICE_STORAGE_KEY) === '1';
  } catch (error) {
    console.error('Failed to read private media notice preference.', error);
  }

  return false;
}

// Set from the notice's "Don't show this again" and from Settings; both share this key.
export function setPrivateMediaNoticeDismissed(dismissed: boolean): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    if (dismissed) {
      window.localStorage.setItem(PRIVATE_MEDIA_NOTICE_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(PRIVATE_MEDIA_NOTICE_STORAGE_KEY);
    }
  } catch (error) {
    console.error('Failed to persist private media notice preference.', error);
  }
}
