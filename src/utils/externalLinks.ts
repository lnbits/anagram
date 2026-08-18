import { AppLauncher } from '@capacitor/app-launcher';
import { Capacitor } from '@capacitor/core';

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
