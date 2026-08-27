import {
  getAndroidRelayNotificationState,
  isAndroidRelayNotificationSupported,
  refreshAndroidRelayNotificationListener,
  requestAndroidRelayNotificationsAfterLogin,
  saveAndroidRelayNotificationsPreference,
} from 'src/services/androidRelayNotificationService';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationSupported,
  readBrowserNotificationsPreference,
  requestBrowserNotificationsAfterLogin,
  saveBrowserNotificationsPreference,
} from 'src/utils/browserNotificationPreference';
import { onBeforeUnmount, ref } from 'vue';

export function useBrowserNotificationsLoginPrompt() {
  const isDialogOpen = ref(false);
  let pendingResolver: ((value: boolean) => void) | null = null;

  function resolveDialog(value: boolean): void {
    const resolver = pendingResolver;
    pendingResolver = null;
    isDialogOpen.value = false;
    resolver?.(value);
  }

  async function openDialog(): Promise<boolean> {
    if (pendingResolver) {
      return false;
    }

    isDialogOpen.value = true;
    return await new Promise<boolean>((resolve) => {
      pendingResolver = resolve;
    });
  }

  async function handleBrowserNotificationsAfterLogin(): Promise<void> {
    if (isAndroidRelayNotificationSupported()) {
      const state = await getAndroidRelayNotificationState().catch(() => null);
      if (state?.enabled) {
        await refreshAndroidRelayNotificationListener().catch((error) => {
          console.warn('Failed to refresh Android relay notifications after login.', error);
        });
        return;
      }

      const shouldEnableNotifications = await openDialog();
      if (!shouldEnableNotifications) {
        saveAndroidRelayNotificationsPreference(false);
        return;
      }

      await requestAndroidRelayNotificationsAfterLogin().catch((error) => {
        console.warn('Failed to enable Android relay notifications after login.', error);
        saveAndroidRelayNotificationsPreference(false);
      });
      return;
    }

    if (!isBrowserNotificationSupported()) {
      saveBrowserNotificationsPreference(false);
      return;
    }

    const permission = getBrowserNotificationPermission();
    if (permission === 'native') {
      if (readBrowserNotificationsPreference()) {
        return;
      }

      const shouldEnableNotifications = await openDialog();
      if (!shouldEnableNotifications) {
        saveBrowserNotificationsPreference(false);
        return;
      }

      await requestBrowserNotificationsAfterLogin();
      return;
    }

    if (permission === 'granted') {
      saveBrowserNotificationsPreference(true);
      return;
    }

    saveBrowserNotificationsPreference(false);

    if (permission === 'denied') {
      return;
    }

    const shouldRequestPermission = await openDialog();
    if (!shouldRequestPermission) {
      return;
    }

    await requestBrowserNotificationsAfterLogin();
  }

  onBeforeUnmount(() => {
    resolveDialog(false);
  });

  return {
    isBrowserNotificationsLoginDialogOpen: isDialogOpen,
    handleBrowserNotificationsAfterLogin,
    confirmBrowserNotificationsLoginDialog: () => resolveDialog(true),
    skipBrowserNotificationsLoginDialog: () => resolveDialog(false),
  };
}
