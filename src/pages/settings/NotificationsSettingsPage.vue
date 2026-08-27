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

        <div v-if="showPushGatewaySettings" class="notifications-card__gateway">
          <q-input
            v-model="pushGatewayUrlInput"
            outlined
            dense
            :label="$t('notifications.android.pushGatewayUrl')"
            :error="pushGatewayUrlValidationError.length > 0"
            :error-message="pushGatewayUrlValidationError"
            :disable="isPushGatewayUrlSaving"
            data-testid="notifications-push-gateway-url-input"
          />

          <q-btn
            unelevated
            no-caps
            color="primary"
            icon="save"
            :label="$t('notifications.android.savePushGatewayUrl')"
            :disable="!canSavePushGatewayUrl"
            :loading="isPushGatewayUrlSaving"
            data-testid="notifications-push-gateway-url-save"
            @click="savePushGatewayUrl"
          />
        </div>
      </q-card-section>
    </q-card>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import {
  clearAndroidPushNotificationsPreference,
  getAndroidPushPermission,
  isAndroidPushNotificationConfigured,
  isAndroidPushNotificationSupported,
  readAndroidPushNotificationsPreference,
  refreshAndroidPushRegistration,
  requestAndroidPushNotificationsAfterLogin,
  saveAndroidPushNotificationsPreference,
  unregisterAndroidPushNotifications,
  type AndroidPushPermissionState
} from 'src/services/androidPushNotificationService';
import {
  readPushGatewayBaseUrl,
  savePushGatewayBaseUrl,
  validatePushGatewayBaseUrl
} from 'src/services/pushGatewayClient';
import {
  getBrowserNotificationPermission,
  isBrowserNotificationSupported,
  readBrowserNotificationsPreference,
  requestBrowserNotificationPermission,
  saveBrowserNotificationsPreference
} from 'src/utils/browserNotificationPreference';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { t } from 'src/i18n';

const $q = useQuasar();

type NotificationPermissionState =
  | BrowserNotificationPermissionState
  | AndroidPushPermissionState;

type BrowserNotificationPermissionState = ReturnType<typeof getBrowserNotificationPermission>;

const isAndroidRuntime = isAndroidPushNotificationSupported();
const storedBrowserNotificationsPreference = readBrowserNotificationsPreference();
const storedAndroidPushPreference = readAndroidPushNotificationsPreference();
const notificationsSupported = isAndroidRuntime
  ? isAndroidPushNotificationConfigured()
  : isBrowserNotificationSupported();
const notificationPermission = ref<NotificationPermissionState>(
  isAndroidRuntime ? 'prompt' : getBrowserNotificationPermission()
);
const notificationsEnabled = ref(
  isAndroidRuntime
    ? storedAndroidPushPreference && notificationPermission.value === 'granted'
    : storedBrowserNotificationsPreference &&
        (notificationPermission.value === 'granted' || notificationPermission.value === 'native')
);
const isPermissionRequestInFlight = ref(false);
const isPushGatewayUrlSaving = ref(false);
const pushGatewayUrlInput = ref(readPushGatewayBaseUrl());
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
  if (!isAndroidRuntime) {
    return;
  }

  void refreshAndroidPermissionState();
});

watch(notificationsEnabled, (isEnabled) => {
  if (isAndroidRuntime && isEnabled) {
    pushGatewayUrlInput.value = readPushGatewayBaseUrl();
  }
});

const notificationsTitle = computed(() => {
  if (isAndroidRuntime) {
    return t('notifications.showAndroidPushNotifications');
  }

  return isDesktopRuntime ? t('notifications.showDesktopNotifications') : t('notifications.showBrowserNotifications');
});

const showPushGatewaySettings = computed(() => isAndroidRuntime && notificationsEnabled.value);

const pushGatewayUrlValidation = computed(() =>
  validatePushGatewayBaseUrl(pushGatewayUrlInput.value)
);

const pushGatewayUrlValidationError = computed(() => {
  switch (pushGatewayUrlValidation.value.reason) {
    case 'empty':
      return t('notifications.android.pushGatewayUrlRequired');
    case 'invalid':
      return t('notifications.android.pushGatewayUrlInvalid');
    case 'protocol':
      return t('notifications.android.pushGatewayUrlProtocol');
    default:
      return '';
  }
});

const canSavePushGatewayUrl = computed(
  () =>
    showPushGatewaySettings.value &&
    pushGatewayUrlValidation.value.isValid &&
    !isPushGatewayUrlSaving.value
);

const notificationCaption = computed(() => {
  if (!notificationsSupported) {
    if (isAndroidRuntime) {
      return t('notifications.android.pushGatewayMissing');
    }

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

async function refreshAndroidPermissionState(): Promise<void> {
  notificationPermission.value = await getAndroidPushPermission();
  notificationsEnabled.value =
    readAndroidPushNotificationsPreference() && notificationPermission.value === 'granted';
  if (readAndroidPushNotificationsPreference() && notificationPermission.value !== 'granted') {
    saveAndroidPushNotificationsPreference(false);
    notificationsEnabled.value = false;
  }
}

async function savePushGatewayUrl(): Promise<void> {
  if (!pushGatewayUrlValidation.value.isValid || !pushGatewayUrlValidation.value.normalizedUrl) {
    $q.notify({
      type: 'warning',
      message: pushGatewayUrlValidationError.value,
      position: 'top',
      timeout: 3200
    });
    return;
  }

  isPushGatewayUrlSaving.value = true;
  try {
    const savedUrl = savePushGatewayBaseUrl(pushGatewayUrlInput.value);
    pushGatewayUrlInput.value = savedUrl;
    await refreshAndroidPushRegistration();
    $q.notify({
      type: 'positive',
      message: t('notifications.android.pushGatewayUrlSaved'),
      position: 'top',
      timeout: 2400
    });
  } catch (error) {
    reportUiError(
      'Failed to update Android push gateway URL',
      error,
      t('errors.failedUpdatePushGatewayUrl')
    );
  } finally {
    isPushGatewayUrlSaving.value = false;
  }
}

async function handleNotificationsToggle(nextValue: boolean): Promise<void> {
  if (isAndroidRuntime) {
    await handleAndroidPushNotificationsToggle(nextValue);
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

async function handleAndroidPushNotificationsToggle(nextValue: boolean): Promise<void> {
  if (!nextValue) {
    isPermissionRequestInFlight.value = true;
    try {
      await unregisterAndroidPushNotifications();
      notificationsEnabled.value = false;
      notificationPermission.value = await getAndroidPushPermission();
    } catch (error) {
      notificationsEnabled.value = readAndroidPushNotificationsPreference();
      reportUiError(
        'Failed to disable Android push notifications',
        error,
        t('errors.failedDisablePushNotifications')
      );
    } finally {
      isPermissionRequestInFlight.value = false;
    }
    return;
  }

  if (!notificationsSupported) {
    notificationsEnabled.value = false;
    clearAndroidPushNotificationsPreference();
    $q.notify({
      type: 'warning',
      message: t('notifications.android.pushGatewayMissing'),
      position: 'top',
      timeout: 3200
    });
    return;
  }

  isPermissionRequestInFlight.value = true;
  try {
    const permission = await requestAndroidPushNotificationsAfterLogin();
    notificationPermission.value = permission;
    notificationsEnabled.value = permission === 'granted';
    if (permission === 'granted') {
      pushGatewayUrlInput.value = readPushGatewayBaseUrl();
    }

    if (permission !== 'granted') {
      clearAndroidPushNotificationsPreference();
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
    clearAndroidPushNotificationsPreference();
    reportUiError(
      'Failed to update Android push notification preference',
      error,
      t('errors.failedUpdatePushNotifications')
    );
  } finally {
    isPermissionRequestInFlight.value = false;
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

.notifications-card__gateway {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

@media (--nc-mobile-viewport) {
  .notifications-card__gateway {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
