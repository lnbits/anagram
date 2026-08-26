<template>
  <div
    class="startup-history-banner"
    :class="{ 'startup-history-banner--expanded': isVisible && isDetailsVisible }"
    :aria-live="isVisible && isDetailsVisible ? 'polite' : 'off'"
    :aria-hidden="isVisible ? undefined : 'true'"
  >
    <div v-if="isVisible && isDetailsVisible" class="startup-history-banner__details">
      <div class="startup-history-banner__header">
        <span class="startup-history-banner__title">{{ $t('startup.startupHistory') }}</span>
        <span class="startup-history-banner__summary">{{ summaryLabel }}</span>
      </div>

      <div class="startup-history-banner__list">
        <div
          v-for="(step, index) in startupHistory"
          :key="step.id"
          class="startup-history-banner__step"
        >
          <div class="startup-history-banner__row">
            <div class="startup-history-banner__counter">
              {{ index + 1 }}/{{ startupHistory.length }}
            </div>
            <div
              v-if="step.status === 'in_progress'"
              class="startup-history-banner__progress-track"
            >
              <q-linear-progress
                indeterminate
                rounded
                color="primary"
                track-color="transparent"
                class="startup-history-banner__mini-progress"
              />
            </div>
            <q-icon
              v-else
              :name="startupStatusIcon(step.status)"
              :class="startupStatusClass(step.status)"
              size="14px"
            />
            <div class="startup-history-banner__copy">
              <div class="startup-history-banner__label">
                <q-icon
                  v-if="isStartupLockedStepIdValue(step.id)"
                  name="lock"
                  size="12px"
                  class="startup-history-banner__lock-icon"
                  aria-hidden="true"
                />
                <span>{{ startupStepLabel(step) }}</span>
              </div>
              <div class="startup-history-banner__meta">{{ startupStepMeta(step) }}</div>
            </div>
            <div class="startup-history-banner__duration">
              {{ startupStepDuration(step) }}
            </div>
          </div>

          <div v-if="step.internalTasks.length > 0" class="startup-history-banner__task-list">
            <div
              v-for="task in step.internalTasks"
              :key="task.id"
              class="startup-history-banner__task-row"
            >
              <div
                v-if="task.status === 'in_progress'"
                class="startup-history-banner__progress-track"
              >
                <q-linear-progress
                  indeterminate
                  rounded
                  color="primary"
                  track-color="transparent"
                  class="startup-history-banner__mini-progress"
                />
              </div>
              <q-icon
                v-else
                :name="startupStatusIcon(task.status)"
                :class="startupStatusClass(task.status)"
                size="13px"
              />
              <div class="startup-history-banner__copy">
                <div class="startup-history-banner__task-label">{{ $t(task.label) }}</div>
                <div class="startup-history-banner__meta">{{ startupStepMeta(task) }}</div>
              </div>
              <div class="startup-history-banner__duration">
                {{ startupStepDuration(task) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <q-linear-progress
      v-if="isVisible && isDetailsVisible"
      indeterminate
      color="primary"
      size="1px"
      class="startup-history-banner__progress"
      aria-hidden="true"
    />
    <q-btn
      dense
      flat
      icon="more"
      size="xs"
      :ripple="false"
      class="startup-history-banner__toggle"
      :class="{ 'startup-history-banner__toggle--visible': isVisible }"
      :aria-label="detailsButtonLabel"
      :aria-expanded="isDetailsVisible"
      :aria-hidden="isVisible ? undefined : 'true'"
      :tabindex="isVisible ? 0 : -1"
      @click="toggleDetails"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { isStartupLockedStepIdValue } from 'src/stores/nostr/startupState';
import type { StartupStepStatus, StartupTimedSnapshot } from 'src/stores/nostrStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { t } from 'src/i18n';

const STARTUP_HISTORY_DETAILS_STORAGE_KEY = 'nostr-chat:startup-history-details-visible';

const nostrStore = useNostrStore();
const isDetailsVisible = ref(false);

const startupHistory = computed(() => {
  return [...nostrStore.startupSteps].sort((first, second) => first.order - second.order);
});

const activeStep = computed(() => {
  const displayStepId = nostrStore.startupDisplay.stepId;
  if (displayStepId) {
    const displayStep = startupHistory.value.find((step) => step.id === displayStepId);
    if (displayStep) {
      return displayStep;
    }
  }

  return (
    startupHistory.value.find(
      (step) =>
        step.status === 'in_progress' ||
        step.internalTasks.some((task) => task.status === 'in_progress')
    ) ?? null
  );
});

const isVisible = computed(() => {
  return startupHistory.value.some(
    (step) =>
      step.status === 'in_progress' ||
      step.internalTasks.some((task) => task.status === 'in_progress')
  );
});

const summaryLabel = computed(() => {
  if (!activeStep.value) {
    return t('startup.preparingStartupRestore');
  }

  const activeIndex = startupHistory.value.findIndex((step) => step.id === activeStep.value?.id);
  const counter =
    activeIndex >= 0 ? `${activeIndex + 1}/${startupHistory.value.length}` : t('startup.startup');
  return `${counter} ${startupStepLabel(activeStep.value)}`;
});

const detailsButtonLabel = computed(() =>
  isDetailsVisible.value ? t('startup.hideStartupHistory') : t('startup.showStartupHistory')
);

function toggleDetails(): void {
  isDetailsVisible.value = !isDetailsVisible.value;
}

function readStoredDetailsVisibility(): boolean {
  try {
    return window.localStorage.getItem(STARTUP_HISTORY_DETAILS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredDetailsVisibility(value: boolean): void {
  try {
    window.localStorage.setItem(STARTUP_HISTORY_DETAILS_STORAGE_KEY, String(value));
  } catch {
    // Ignore storage errors; the toggle should still work for the current session.
  }
}

function startupStatusIcon(status: StartupStepStatus | null): string {
  if (status === 'success') {
    return 'check_circle';
  }

  if (status === 'error') {
    return 'cancel';
  }

  if (status === 'in_progress') {
    return 'radio_button_unchecked';
  }

  return 'more_horiz';
}

function startupStatusClass(status: StartupStepStatus | null): string {
  if (status === 'success') {
    return 'startup-history-banner__status-icon startup-history-banner__status-icon--success';
  }

  if (status === 'error') {
    return 'startup-history-banner__status-icon startup-history-banner__status-icon--error';
  }

  if (status === 'in_progress') {
    return 'startup-history-banner__status-icon startup-history-banner__status-icon--progress';
  }

  return 'startup-history-banner__status-icon startup-history-banner__status-icon--pending';
}

function startupStepMeta(step: StartupTimedSnapshot): string {
  const eventCountMeta = startupStepEventCountMeta(step);
  if (step.status === 'error') {
    return [step.errorMessage?.trim() || t('common.failed'), eventCountMeta].filter(Boolean).join(' - ');
  }

  if (step.status === 'success') {
    return [t('common.completed', { duration: startupStepDuration(step) }), eventCountMeta]
      .filter(Boolean)
      .join(' - ');
  }

  if (step.status === 'in_progress') {
    return [t('common.progress'), eventCountMeta].filter(Boolean).join(' - ');
  }

  return [t('common.pending'), eventCountMeta].filter(Boolean).join(' - ');
}

function startupStepEventCountMeta(step: StartupTimedSnapshot): string | null {
  if (startupStepEntryCount(step) !== null) {
    return null;
  }

  if (typeof step.eventCount !== 'number' || !Number.isFinite(step.eventCount)) {
    return null;
  }

  const eventCount = Math.max(0, Math.floor(step.eventCount));
  return eventCount === 1 ? t('common.eventCount.one', { count: eventCount }) : t('common.eventCount.many', { count: eventCount });
}

function startupStepEntryCount(
  step: Pick<StartupTimedSnapshot, 'eventCount' | 'id'>
): number | null {
  if (step.id !== 'private-contact-list-restore') {
    return null;
  }

  if (typeof step.eventCount !== 'number' || !Number.isFinite(step.eventCount)) {
    return null;
  }

  return Math.max(0, Math.floor(step.eventCount));
}

function startupStepLabel(step: Pick<StartupTimedSnapshot, 'eventCount' | 'id' | 'label'>): string {
  const label = t(step.label);
  const entryCount = startupStepEntryCount(step);
  return entryCount === null ? label : `${label} (${entryCount} entries)`;
}

function startupStepDuration(step: StartupTimedSnapshot): string {
  if (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs)) {
    return step.status === 'in_progress' ? t('common.runningLabel') : t('common.pending');
  }

  if (step.durationMs < 1000) {
    return `${Math.max(1, Math.round(step.durationMs))} ms`;
  }

  return `${(step.durationMs / 1000).toFixed(step.durationMs >= 10000 ? 0 : 1)} s`;
}

onMounted(() => {
  isDetailsVisible.value = readStoredDetailsVisibility();
});

watch(isDetailsVisible, (value) => {
  writeStoredDetailsVisibility(value);
});
</script>

<style scoped>
.startup-history-banner {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  height: 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  color: var(--nc-text-primary);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.15;
  pointer-events: none;
}

.startup-history-banner--expanded {
  position: relative;
  right: auto;
  bottom: auto;
  left: auto;
  z-index: auto;
  height: auto;
  min-height: 24px;
  margin: 6px -8px -8px;
  padding: 6px 34px 8px 8px;
  border-top: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--q-primary) 7%, var(--nc-panel-header-bg));
  pointer-events: auto;
}

.startup-history-banner__details {
  min-width: 0;
  width: 100%;
}

.startup-history-banner__header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin-bottom: 6px;
}

.startup-history-banner__title {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--nc-text);
}

.startup-history-banner__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nc-text-secondary);
}

.startup-history-banner__list {
  display: grid;
  gap: 7px;
  max-height: 260px;
  overflow-y: auto;
  padding-right: 4px;
}

.startup-history-banner__step + .startup-history-banner__step {
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 70%, transparent);
}

.startup-history-banner__row {
  display: grid;
  grid-template-columns: 34px 22px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: start;
  min-width: 0;
}

.startup-history-banner__counter {
  padding-top: 1px;
  font-size: 10px;
  font-weight: 700;
  color: var(--nc-text-secondary);
  white-space: nowrap;
}

.startup-history-banner__progress-track {
  width: 18px;
  padding-top: 6px;
}

.startup-history-banner__mini-progress {
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nc-border) 70%, transparent);
}

.startup-history-banner__copy {
  min-width: 0;
}

.startup-history-banner__label,
.startup-history-banner__task-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.startup-history-banner__label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.25;
}

.startup-history-banner__label span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.startup-history-banner__lock-icon {
  flex: 0 0 auto;
  color: var(--nc-text-secondary);
}

.startup-history-banner__task-label {
  font-size: 10px;
  font-weight: 600;
  line-height: 1.25;
}

.startup-history-banner__meta,
.startup-history-banner__duration {
  font-size: 10px;
  line-height: 1.35;
  color: var(--nc-text-secondary);
}

.startup-history-banner__duration {
  white-space: nowrap;
}

.startup-history-banner__task-list {
  display: grid;
  gap: 5px;
  padding: 6px 0 0 56px;
}

.startup-history-banner__task-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: start;
  min-width: 0;
}

.startup-history-banner__status-icon {
  margin-top: 1px;
}

.startup-history-banner__status-icon--success {
  color: #16a34a;
}

.startup-history-banner__status-icon--error {
  color: #dc2626;
}

.startup-history-banner__status-icon--progress,
.startup-history-banner__status-icon--pending {
  color: #74839b;
}

.startup-history-banner__progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
}

.startup-history-banner__progress
  :deep(.q-linear-progress__model--indeterminate::before) {
  animation-name: startup-history-progress-indeterminate;
}

.startup-history-banner__progress
  :deep(.q-linear-progress__model--indeterminate::after) {
  animation-name: startup-history-progress-indeterminate-short;
}

@keyframes startup-history-progress-indeterminate {
  0% {
    transform: translate3d(-4.5%, 0, 0) scale3d(0.04375, 1, 1);
  }

  60% {
    transform: translate3d(100%, 0, 0) scale3d(0.1125, 1, 1);
  }

  100% {
    transform: translate3d(100%, 0, 0) scale3d(0.1125, 1, 1);
  }
}

@keyframes startup-history-progress-indeterminate-short {
  0% {
    transform: translate3d(-12.5%, 0, 0) scale3d(0.125, 1, 1);
  }

  60% {
    transform: translate3d(107%, 0, 0) scale3d(0.00125, 1, 1);
  }

  100% {
    transform: translate3d(107%, 0, 0) scale3d(0.00125, 1, 1);
  }
}

.q-btn.startup-history-banner__toggle {
  position: absolute;
  right: 3px;
  bottom: -4px;
  z-index: 1;
  min-height: 10px;
  min-width: 18px;
  width: 18px;
  height: 12px;
  padding: 0;
  color: var(--nc-text-secondary) !important;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  transition:
    color 0.2s ease,
    opacity 2.5s ease;
  opacity: 0;
  pointer-events: none;
}

.q-btn.startup-history-banner__toggle--visible {
  opacity: 1;
  pointer-events: auto;
}

.q-btn.startup-history-banner__toggle :deep(.q-icon) {
  font-size: 14px;
}

.q-btn.startup-history-banner__toggle:hover {
  color: var(--nc-text) !important;
}

.q-btn.startup-history-banner__toggle::before {
  display: none;
  background: transparent;
  box-shadow: none;
}

.q-btn.startup-history-banner__toggle :deep(.q-focus-helper) {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .q-btn.startup-history-banner__toggle {
    transition-duration: 0.2s, 0.01ms;
  }
}

body.body--dark .startup-history-banner__status-icon--success {
  color: #7ee2a8;
}

body.body--dark .startup-history-banner__status-icon--error {
  color: #ff9b90;
}

body.body--dark .startup-history-banner__status-icon--progress,
body.body--dark .startup-history-banner__status-icon--pending {
  color: var(--nc-text-secondary);
}

@media (max-width: 420px) {
  .startup-history-banner__row {
    grid-template-columns: 34px 22px minmax(0, 1fr);
  }

  .startup-history-banner__duration {
    grid-column: 3;
  }

  .startup-history-banner__task-list {
    padding-left: 56px;
  }

  .startup-history-banner__task-row {
    grid-template-columns: 22px minmax(0, 1fr);
  }

  .startup-history-banner__task-row .startup-history-banner__duration {
    grid-column: 2;
  }
}
</style>
