import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppLauncher } from '#src/lib/platform/legacyNative.ts';
import { Capacitor } from '#src/lib/platform/legacyNative.ts';
import { safeMagnetUrl } from '#src/stores/nostr/botKeyboardProtocol.ts';

// Called only from an explicit inline-button click. The HTTP opener remains
// restricted to HTTP(S) for its existing callers.
export async function openExternalMagnetUrl(value: string): Promise<void> {
  if (!safeMagnetUrl(value)) throw new Error('Invalid magnet link.');
  value = new URL(value).href;
  if (isTauri()) {
    await openUrl(value);
    return;
  }
  if (Capacitor.isNativePlatform()) {
    const result = await AppLauncher.openUrl({ url: value });
    if (!result.completed) throw new Error('No torrent app opened the magnet link.');
    return;
  }
  if (typeof window === 'undefined') throw new Error('A browser window is not available.');
  // Preserve the user gesture so the browser can launch its registered handler.
  // A new tab avoids navigating the Anagram conversation away.
  window.open(value, '_blank', 'noopener,noreferrer');
}

function normalizeExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

export async function openExternalHttpUrl(value: string): Promise<void> {
  const url = normalizeExternalHttpUrl(value);
  if (!url) {
    throw new Error('Only HTTP(S) links can be opened.');
  }

  if (isTauri()) {
    await openUrl(url);
    return;
  }

  if (Capacitor.isNativePlatform()) {
    const result = await AppLauncher.openUrl({ url });
    if (!result.completed) {
      throw new Error('The system browser did not open the link.');
    }
    return;
  }

  if (typeof window === 'undefined') {
    throw new Error('A browser window is not available.');
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
