import { t } from 'src/i18n';
import { disableAndroidRelayNotifications } from 'src/services/androidRelayNotificationService';
import { useNostrStore } from 'src/stores/nostrStore';
import { schedulePendingLogoutCleanup } from 'src/utils/logoutCleanup';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

export function useOnboardingLogout() {
  const router = useRouter();
  const nostrStore = useNostrStore();
  const isLoggingOut = ref(false);

  async function logoutFromOnboarding(): Promise<void> {
    if (isLoggingOut.value) return;
    isLoggingOut.value = true;
    try {
      await disableAndroidRelayNotifications().catch((error) => {
        console.warn('Failed to stop Android relay notifications during logout.', error);
      });
      await nostrStore.logout();
      await router.replace({ name: 'auth' });
      schedulePendingLogoutCleanup();
      window.location.reload();
    } catch (error) {
      isLoggingOut.value = false;
      reportUiError('Failed to log out', error, t('errors.failedLogOut'));
    }
  }

  return { isLoggingOut, logoutFromOnboarding };
}
