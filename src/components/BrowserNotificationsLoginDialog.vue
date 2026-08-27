<template>
  <AppDialog
    v-model="dialogModel"
    :title="dialogTitle"
    :subtitle="dialogSubtitle"
    :persistent="true"
    :show-close="false"
    max-width="440px"
  >
    <div class="browser-notifications-login-dialog__body">
      {{ $t('notifications.manageLaterHint') }}
    </div>

    <template #actions>
      <q-btn flat no-caps :label="$t('common.now')" @click="handleSkip" />
      <q-btn unelevated no-caps color="primary" :label="$t('common.enable')" @click="handleEnable" />
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppDialog from 'src/components/AppDialog.vue';
import { isAndroidRelayNotificationSupported } from 'src/services/androidRelayNotificationService';
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

function handleEnable(): void {
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
  color: var(--nc-text);
  line-height: 1.5;
}
</style>
