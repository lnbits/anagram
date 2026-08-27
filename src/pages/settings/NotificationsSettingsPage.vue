<template>
  <SettingsDetailLayout :title="$t('notifications.notifications')" icon="notifications">
    <q-card flat bordered class="notifications-card">
      <q-card-section class="notifications-card__section">
        <div class="notifications-card__row">
          <div>
            <div class="text-body1">{{ notificationsTitle }}</div>
            <div class="text-caption text-grey-6">
              {{ notificationCaption }}
            </div>
          </div>

          <q-toggle
            :model-value="notificationsEnabled"
            :disable="isPermissionRequestInFlight || !notificationsSupported"
            color="primary"
            checked-icon="notifications_active"
            unchecked-icon="notifications_off"
            @update:model-value="handleNotificationsToggle"
          />
        </div>

        <template v-if="isAndroidRuntime && notificationsEnabled">
          <q-separator />
          <div class="notifications-card__row">
            <div>
              <div class="text-body2">
                {{ $t('notifications.android.startOnBoot') }}
              </div>
              <div class="text-caption text-grey-6">
                {{ $t('notifications.android.startOnBootCaption') }}
              </div>
            </div>

            <q-toggle
              :model-value="startOnBoot"
              :disable="isStartOnBootUpdating"
              color="primary"
              data-testid="notifications-android-start-on-boot-toggle"
              @update:model-value="handleStartOnBootToggle"
            />
          </div>

          <div class="notifications-card__privacy text-caption text-grey-6">
            <q-icon name="privacy_tip" size="18px" aria-hidden="true" />
            <span>{{ $t('notifications.android.privacyCaption') }}</span>
          </div>
        </template>
      </q-card-section>
    </q-card>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import { t } from 'src/i18n';
import {
  clearAndroidRelayNotificationsPreference,
  disableAndroidRelayNotifications,
  getAndroidRelayNotificationState,
  isAndroidRelayNotificationSupported,
  readAndroidRelayStartOnBootPreference,
  requestAndroidRelayNotificationsAfterLogin,
  setAndroidRelayNotificationStartOnBoot,
  type AndroidRelayNotificationPermissionState
} from 'src/services/androidRelayNotificationService';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationSupported,
  readBrowserNotificationsPreference,
  requestBrowserNotificationPermission,
  saveBrowserNotificationsPreference
} from 'src/utils/browserNotificationPreference';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const $q = useQuasar();

type BrowserNotificationPermissionState = ReturnType<typeof getBrowserNotificationPermission>;
type NotificationPermissionState =
  | BrowserNotificationPermissionState
  | AndroidRelayNotificationPermissionState;

const isAndroidRuntime = isAndroidRelayNotificationSupported();
const storedBrowserNotificationsPreference = readBrowserNotificationsPreference();
const notificationsSupported = isAndroidRuntime || isBrowserNotificationSupported();
const notificationPermission = ref<NotificationPermissionState>(
  isAndroidRuntime ? 'prompt' : getBrowserNotificationPermission()
);
const notificationsEnabled = ref(
  !isAndroidRuntime &&
    storedBrowserNotificationsPreference &&
    (notificationPermission.value === 'granted' || notificationPermission.value === 'native')
);
const startOnBoot = ref(readAndroidRelayStartOnBootPreference());
const isPermissionRequestInFlight = ref(false);
const isStartOnBootUpdating = ref(false);
const isDesktopRuntime =
  typeof window !== 'undefined' && Boolean(window.desktopRuntime?.isElectron);

if (
  storedBrowserNotificationsPreference &&
  notificationPermission.value !== 'granted' &&
  notificationPermission.value !== 'native'
) {
  saveBrowserNotificationsPreference(false);
}

onMounted(() => {
  if (isAndroidRuntime) {
    document.addEventListener('visibilitychange', handleAndroidVisibilityChange);
    void refreshAndroidState().catch((error) => {
      console.warn('Failed to read Android relay notification state.', error);
    });
  }
});

onBeforeUnmount(() => {
  if (isAndroidRuntime) {
    document.removeEventListener('visibilitychange', handleAndroidVisibilityChange);
  }
});

const notificationsTitle = computed(() => {
  if (isAndroidRuntime) {
    return t('notifications.showAndroidPushNotifications');
  }

  return isDesktopRuntime
    ? t('notifications.showDesktopNotifications')
    : t('notifications.showBrowserNotifications');
});

const notificationCaption = computed(() => {
  if (!notificationsSupported) {
    return isDesktopRuntime
      ? t('notifications.desktop.unsupportedEnvironment')
      : t('notifications.browser.unsupportedApp');
  }

  if (notificationsEnabled.value) {
    if (isAndroidRuntime) {
      return t('notifications.android.toggleLabel');
    }

    return isDesktopRuntime
      ? t('notifications.desktop.toggleLabel')
      : t('notifications.browser.toggleLabel');
  }

  if (notificationPermission.value === 'denied') {
    return isAndroidRuntime
      ? t('notifications.android.blockedInstructions')
      : t('notifications.browser.blockedInstructions');
  }

  if (notificationPermission.value === 'native') {
    return t('notifications.desktop.toggleCaption');
  }

  return isAndroidRuntime
    ? t('notifications.android.toggleCaption')
    : t('notifications.browser.toggleCaption');
});

async function refreshAndroidState(): Promise<void> {
  const state = await getAndroidRelayNotificationState();
  notificationPermission.value = state.permission;
  startOnBoot.value = state.startOnBoot;
  notificationsEnabled.value = state.enabled && state.permission === 'granted';

  if (state.enabled && state.permission !== 'granted') {
    await disableAndroidRelayNotifications();
    notificationsEnabled.value = false;
  }
}

function handleAndroidVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    void refreshAndroidState().catch((error) => {
      console.warn('Failed to refresh Android relay notification state.', error);
    });
  }
}

async function handleNotificationsToggle(nextValue: boolean): Promise<void> {
  if (isAndroidRuntime) {
    await handleAndroidNotificationsToggle(nextValue);
    return;
  }

  if (!nextValue) {
    notificationsEnabled.value = false;
    saveBrowserNotificationsPreference(false);
    notificationPermission.value = getBrowserNotificationPermission();
    return;
  }

  if (!notificationsSupported) {
    notificationsEnabled.value = false;
    saveBrowserNotificationsPreference(false);
    $q.notify({
      type: 'warning',
      message: t('notifications.browser.unsupported'),
      position: 'top',
      timeout: 3000
    });
    return;
  }

  if (notificationPermission.value === 'native') {
    notificationsEnabled.value = true;
    saveBrowserNotificationsPreference(true);
    return;
  }

  isPermissionRequestInFlight.value = true;

  try {
    const permission = await requestBrowserNotificationPermission();
    notificationPermission.value = permission;

    if (permission === 'granted') {
      notificationsEnabled.value = true;
      saveBrowserNotificationsPreference(true);
      return;
    }

    notificationsEnabled.value = false;
    saveBrowserNotificationsPreference(false);

    $q.notify({
      type: permission === 'denied' ? 'warning' : 'info',
      message:
        permission === 'denied'
          ? t('notifications.browser.blockedEnableInstructions')
          : t('notifications.browser.permissionDenied'),
      position: 'top',
      timeout: 3200
    });
  } catch (error) {
    notificationsEnabled.value = false;
    saveBrowserNotificationsPreference(false);
    reportUiError(
      'Failed to update browser notification preference',
      error,
      t('errors.failedUpdateBrowserNotifications')
    );
  } finally {
    isPermissionRequestInFlight.value = false;
  }
}

async function handleAndroidNotificationsToggle(nextValue: boolean): Promise<void> {
  isPermissionRequestInFlight.value = true;
  try {
    if (!nextValue) {
      await disableAndroidRelayNotifications();
      notificationsEnabled.value = false;
      notificationPermission.value = (await getAndroidRelayNotificationState()).permission;
      return;
    }

    const permission = await requestAndroidRelayNotificationsAfterLogin();
    notificationPermission.value = permission;
    notificationsEnabled.value = permission === 'granted';

    if (permission !== 'granted') {
      clearAndroidRelayNotificationsPreference();
      $q.notify({
        type: permission === 'denied' ? 'warning' : 'info',
        message:
          permission === 'denied'
            ? t('notifications.android.blockedEnableInstructions')
            : t('notifications.android.permissionDenied'),
        position: 'top',
        timeout: 3200
      });
    }
  } catch (error) {
    notificationsEnabled.value = false;
    clearAndroidRelayNotificationsPreference();
    reportUiError(
      'Failed to update Android relay notification preference',
      error,
      t('errors.failedUpdatePushNotifications')
    );
  } finally {
    isPermissionRequestInFlight.value = false;
  }
}

async function handleStartOnBootToggle(nextValue: boolean): Promise<void> {
  isStartOnBootUpdating.value = true;
  try {
    await setAndroidRelayNotificationStartOnBoot(nextValue);
    startOnBoot.value = nextValue;
  } catch (error) {
    startOnBoot.value = !nextValue;
    reportUiError(
      'Failed to update Android notification startup preference',
      error,
      t('errors.failedUpdatePushNotifications')
    );
  } finally {
    isStartOnBootUpdating.value = false;
  }
}
</script>

<style scoped>
.notifications-card {
  max-width: 520px;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.notifications-card__section {
  display: grid;
  gap: 18px;
}

.notifications-card__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.notifications-card__privacy {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
</style>
