<template>
  <div class="settings-detail-layout">
    <div class="settings-detail-layout__header">
      <q-btn
        v-if="showMobileBackButton"
        flat
        dense
        round
        icon="arrow_back"
        :aria-label="$t('settings.backSettings')"
        class="settings-detail-layout__back"
        @click="goBack"
      />
      <q-icon v-if="icon" :name="icon" size="20px" class="settings-detail-layout__icon" />
      <div class="settings-detail-layout__title">{{ title }}</div>
      <div class="settings-detail-layout__spacer" />
      <div class="settings-detail-layout__actions">
        <slot name="actions" />
      </div>
    </div>

    <div class="settings-detail-layout__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';
import { reportUiError } from 'src/utils/uiErrorHandler';

defineProps<{
  title: string;
  icon?: string;
}>();

const $q = useQuasar();
const route = useRoute();
const router = useRouter();

const showMobileBackButton = computed(() => {
  return $q.screen.lt.sm && String(route.name ?? '').startsWith('settings-');
});

function goBack(): void {
  try {
    void router.push({ name: 'settings' });
  } catch (error) {
    reportUiError('Failed to navigate back to settings list', error);
  }
}
</script>

<style scoped>
.settings-detail-layout {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--nc-panel-thread-bg);
}

.settings-detail-layout__header {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
  backdrop-filter: blur(var(--nc-glass-blur));
}

.settings-detail-layout__title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--nc-text);
}

.settings-detail-layout__spacer {
  flex: 1;
}

.settings-detail-layout__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-detail-layout__icon {
  margin-right: 10px;
  opacity: 0.86;
  color: color-mix(in srgb, var(--q-primary) 78%, #0f5ea9 22%);
}

.settings-detail-layout__back {
  margin-right: 8px;
}

.settings-detail-layout__body {
  flex: 1;
  overflow-y: auto;
  padding: 18px;
}

body.body--dark .settings-detail-layout__icon {
  color: var(--nc-text-secondary);
  opacity: 1;
}
</style>
