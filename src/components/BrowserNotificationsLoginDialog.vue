<template>
  <AppDialog
    v-model="dialogModel"
    :title="dialogTitle"
    :subtitle="dialogSubtitle"
    :persistent="true"
    :show-close="false"
    :max-width="isAndroidRuntime ? '560px' : '440px'"
  >
    <div class="browser-notifications-login-dialog__body">
      <AndroidNotificationRelayPicker
        v-if="isAndroidRuntime"
        :candidates="notificationRelayCandidates"
        :model-value="selectedNotificationRelayUrls"
        :loading="areNotificationRelayChoicesLoading"
        :disabled="isSavingRelaySelection"
        @update:model-value="selectedNotificationRelayUrls = $event"
      />
      <span v-else>{{ $t('notifications.manageLaterHint') }}</span>
      <div v-if="relaySelectionError" class="text-caption text-negative">
        {{ relaySelectionError }}
      </div>
    </div>

    <template #actions>
      <q-btn flat no-caps :label="$t('common.now')" @click="handleSkip" />
      <q-btn
        unelevated
        no-caps
        color="primary"
        :label="$t('common.enable')"
        :loading="isSavingRelaySelection"
        :disable="
          isAndroidRuntime &&
          (areNotificationRelayChoicesLoading || !hasAvailableSelectedRelay)
        "
        @click="handleEnable"
      />
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AndroidNotificationRelayPicker from 'src/components/AndroidNotificationRelayPicker.vue';
import AppDialog from 'src/components/AppDialog.vue';
import { isAndroidRelayNotificationSupported } from 'src/services/androidRelayNotificationService';
import {
  loadAndroidNotificationRelayChoices,
  saveAndroidNotificationRelaySelection,
  type AndroidNotificationRelayCandidate,
} from 'src/services/androidNotificationRelaySelectionService';
import { t } from 'src/i18n';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'enable'): void;
  (event: 'skip'): void;
}>();

const dialogModel = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});

const isDesktopRuntime = computed(
  () => typeof window !== 'undefined' && Boolean(window.desktopRuntime?.isElectron)
);
const isAndroidRuntime = computed(() => isAndroidRelayNotificationSupported());
const areNotificationRelayChoicesLoading = ref(false);
const isSavingRelaySelection = ref(false);
const notificationRelayCandidates = ref<AndroidNotificationRelayCandidate[]>([]);
const selectedNotificationRelayUrls = ref<string[]>([]);
const relaySelectionError = ref('');
const hasAvailableSelectedRelay = computed(() => {
  const selectedRelayUrls = new Set(selectedNotificationRelayUrls.value);
  return notificationRelayCandidates.value.some(
    (candidate) => candidate.available && selectedRelayUrls.has(candidate.url)
  );
});
const dialogTitle = computed(() => {
  if (isAndroidRuntime.value || isDesktopRuntime.value) {
    return t('notifications.enableNotifications');
  }

  return t('notifications.enableBrowserNotifications');
});
const dialogSubtitle = computed(() => {
  if (isAndroidRuntime.value) {
    return t('notifications.android.enablePrompt');
  }

  return isDesktopRuntime.value
    ? t('notifications.desktop.enablePrompt')
    : t('notifications.browser.enablePrompt');
});

watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen || !isAndroidRuntime.value) {
      return;
    }
    void loadRelayChoices();
  },
  { immediate: true }
);

async function loadRelayChoices(): Promise<void> {
  areNotificationRelayChoicesLoading.value = true;
  relaySelectionError.value = '';
  try {
    const choices = await loadAndroidNotificationRelayChoices();
    notificationRelayCandidates.value = choices.candidates;
    selectedNotificationRelayUrls.value = choices.selectedRelayUrls;
  } catch (error) {
    relaySelectionError.value =
      error instanceof Error
        ? error.message
        : t('errors.failedUpdatePushNotifications');
  } finally {
    areNotificationRelayChoicesLoading.value = false;
  }
}

async function handleEnable(): Promise<void> {
  if (isAndroidRuntime.value) {
    if (!hasAvailableSelectedRelay.value) {
      relaySelectionError.value = t('notifications.android.relays.required');
      return;
    }
    isSavingRelaySelection.value = true;
    relaySelectionError.value = '';
    try {
      selectedNotificationRelayUrls.value = saveAndroidNotificationRelaySelection(
        selectedNotificationRelayUrls.value
      );
    } catch (error) {
      relaySelectionError.value =
        error instanceof Error
          ? error.message
          : t('errors.failedUpdatePushNotifications');
      return;
    } finally {
      isSavingRelaySelection.value = false;
    }
  }

  emit('update:modelValue', false);
  emit('enable');
}

function handleSkip(): void {
  emit('update:modelValue', false);
  emit('skip');
}
</script>

<style scoped>
.browser-notifications-login-dialog__body {
  display: grid;
  gap: 12px;
  color: var(--nc-text);
  line-height: 1.5;
}
</style>
