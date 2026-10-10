import { isTauri } from '@tauri-apps/api/core';
import { Capacitor } from '#src/lib/platform/legacyNative.ts';

export function isPackagedAppRuntime(): boolean {
  if (isTauri() || Capacitor.isNativePlatform()) {
    return true;
  }

  return typeof window !== 'undefined' && window.desktopRuntime?.isElectron === true;
}
