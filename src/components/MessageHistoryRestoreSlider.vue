<template>
  <div class="history-restore" data-testid="auth-history-restore">
    <div class="row items-center justify-between q-mb-sm">
      <span class="text-weight-medium">{{ $t('auth.restoreMessageHistory') }}</span>
      <span class="text-primary" data-testid="auth-history-restore-value">{{ selectedLabel }}</span>
    </div>
    <q-slider
      v-model="selectedIndex"
      :min="0"
      :max="MESSAGE_HISTORY_RESTORE_DAYS.length - 1"
      :step="1"
      markers
      snap
      :disable="disable"
      :aria-label="$t('auth.restoreMessageHistory')"
      :aria-valuetext="selectedLabel"
      data-testid="auth-history-restore-slider"
    />
    <div
      v-if="model > DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS"
      class="history-restore__warning q-mt-md"
      role="status"
      data-testid="auth-history-restore-warning"
    >
      <q-icon name="schedule" size="18px" class="q-mr-xs text-amber-9" />
      {{ $t('auth.longHistoryRestoreWarning') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from 'src/i18n';
import {
  DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS,
  MESSAGE_HISTORY_RESTORE_DAYS,
} from 'src/utils/messageHistoryRestore';

defineProps<{ disable?: boolean }>();
const model = defineModel<number>({ default: DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS });
const labels = computed(() =>
  MESSAGE_HISTORY_RESTORE_DAYS.map((days) => t(`auth.historyRestoreDays${days}`))
);
const selectedIndex = computed({
  get: () => MESSAGE_HISTORY_RESTORE_DAYS.findIndex((days) => days === model.value),
  set: (index: number) => {
    model.value = MESSAGE_HISTORY_RESTORE_DAYS[index] ?? DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS;
  },
});
const selectedLabel = computed(() => labels.value[selectedIndex.value]);
</script>

<style scoped>
.history-restore {
  margin: 24px 0;
}

.history-restore__warning {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.12);
  font-size: 13px;
}
</style>
