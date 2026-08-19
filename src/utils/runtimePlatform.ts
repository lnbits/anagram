import { Capacitor } from '@capacitor/core';

export function isPackagedAppRuntime(): boolean {
  if (Capacitor.isNativePlatform()) {
    return true;
  }

  return typeof window !== 'undefined' && window.desktopRuntime?.isElectron === true;
}
