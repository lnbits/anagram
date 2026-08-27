<template>
  <div class="app-status" :class="{ 'app-status--embedded': embedded }">
    <section class="app-status__card">
      <div v-if="!embedded" class="app-status__card-header">
        <div class="app-status__card-copy">
          <div class="app-status__card-title">{{ $t('startup.startupHistory') }}</div>
          <div class="app-status__card-subtitle">{{ cardSubtitle }}</div>
        </div>
        <span v-if="hasHeaderActivity" class="app-status__badge app-status__badge--busy">
          {{ $t('startup.syncing') }}
        </span>
      </div>

      <div class="app-status__content">
        <div v-if="startupHistory.length === 0" class="app-status__details-copy">
          {{ $t('startup.startupStepsRecordedYet') }}
        </div>

        <div v-else class="app-status__history-scroll">
          <div class="app-status__history-list">
            <template v-for="(step, index) in startupHistory" :key="step.id">
              <q-expansion-item
                v-if="step.internalTasks.length > 0"
                dense
                expand-icon="keyboard_arrow_down"
                class="app-status__history-entry app-status__history-expansion"
              >
                <template #header>
                  <div
                    class="app-status__history-item"
                    :class="{ 'app-status__history-item--rerunnable': allowStepRerun }"
                  >
                    <div class="app-status__history-counter">
                      {{ index + 1 }}/{{ startupHistory.length }}
                    </div>
                    <q-btn
                      v-if="allowStepRerun"
                      dense
                      flat
                      round
                      icon="refresh"
                      size="sm"
                      :aria-label="startupStepRefreshLabel(step)"
                      :disable="isStartupStepRefreshDisabled(step)"
                      :loading="isStartupStepRerunning(step.id)"
                      class="app-status__step-refresh"
                      @click.stop.prevent="handleStartupStepRefresh(step.id)"
                    >
                      <q-tooltip>{{ startupStepRefreshLabel(step) }}</q-tooltip>
                    </q-btn>
                    <div v-if="step.status === 'in_progress'" class="app-status__progress-track">
                      <q-linear-progress
                        indeterminate
                        rounded
                        color="primary"
                        track-color="transparent"
                        class="app-status__progress-bar"
                      />
                    </div>
                    <q-icon
                      v-else
                      :name="startupStatusIcon(step.status)"
                      :class="startupStatusClass(step.status)"
                      size="16px"
                    />
                    <div class="app-status__history-copy">
                      <div class="app-status__history-label">
                        <q-icon
                          v-if="isStartupLockedStepIdValue(step.id)"
                          name="lock"
                          size="14px"
                          class="app-status__lock-icon"
                          aria-hidden="true"
                        />
                        <span>{{ startupStepLabel(step) }}</span>
                      </div>
                      <div class="app-status__history-meta">{{ startupStepMeta(step) }}</div>
                    </div>
                    <div class="app-status__history-duration">{{ startupStepDuration(step) }}</div>
                  </div>
                </template>

                <div class="app-status__internal-list">
                  <div
                    v-for="task in step.internalTasks"
                    :key="task.id"
                    class="app-status__internal-item"
                  >
                    <div v-if="task.status === 'in_progress'" class="app-status__progress-track">
                      <q-linear-progress
                        indeterminate
                        rounded
                        color="primary"
                        track-color="transparent"
                        class="app-status__progress-bar"
                      />
                    </div>
                    <q-icon
                      v-else
                      :name="startupStatusIcon(task.status)"
                      :class="startupStatusClass(task.status)"
                      size="15px"
                    />
                    <div class="app-status__history-copy">
                      <div class="app-status__internal-label">{{ $t(task.label) }}</div>
                      <div class="app-status__history-meta">{{ startupStepMeta(task) }}</div>
                    </div>
                    <div class="app-status__history-duration">{{ startupStepDuration(task) }}</div>
                  </div>
                </div>
              </q-expansion-item>

              <div v-else class="app-status__history-entry app-status__history-static">
                <div
                  class="app-status__history-item"
                  :class="{ 'app-status__history-item--rerunnable': allowStepRerun }"
                >
                  <div class="app-status__history-counter">
                    {{ index + 1 }}/{{ startupHistory.length }}
                  </div>
                  <q-btn
                    v-if="allowStepRerun"
                    dense
                    flat
                    round
                    icon="refresh"
                    size="sm"
                    :aria-label="startupStepRefreshLabel(step)"
                    :disable="isStartupStepRefreshDisabled(step)"
                    :loading="isStartupStepRerunning(step.id)"
                    class="app-status__step-refresh"
                    @click.stop.prevent="handleStartupStepRefresh(step.id)"
                  >
                    <q-tooltip>{{ startupStepRefreshLabel(step) }}</q-tooltip>
                  </q-btn>
                  <div v-if="step.status === 'in_progress'" class="app-status__progress-track">
                    <q-linear-progress
                      indeterminate
                      rounded
                      color="primary"
                      track-color="transparent"
                      class="app-status__progress-bar"
                    />
                  </div>
                  <q-icon
                    v-else
                    :name="startupStatusIcon(step.status)"
                    :class="startupStatusClass(step.status)"
                    size="16px"
                  />
                  <div class="app-status__history-copy">
                    <div class="app-status__history-label">
                      <q-icon
                        v-if="isStartupLockedStepIdValue(step.id)"
                        name="lock"
                        size="14px"
                        class="app-status__lock-icon"
                        aria-hidden="true"
                      />
                      <span>{{ startupStepLabel(step) }}</span>
                    </div>
                    <div class="app-status__history-meta">{{ startupStepMeta(step) }}</div>
                  </div>
                  <div class="app-status__history-duration">{{ startupStepDuration(step) }}</div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar';
import { computed, ref } from 'vue';
import { isStartupLockedStepIdValue } from 'src/stores/nostr/startupState';
import type {
  StartupStepId,
  StartupStepSnapshot,
  StartupStepStatus,
  StartupTimedSnapshot,
} from 'src/stores/nostrStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { t } from 'src/i18n';
import { reportUiError } from 'src/utils/uiErrorHandler';

const props = withDefaults(
  defineProps<{
    allowStepRerun?: boolean;
    embedded?: boolean;
  }>(),
  {
    allowStepRerun: false,
    embedded: false
  }
);

const $q = useQuasar();
const nostrStore = useNostrStore();
const rerunningStartupStepIds = ref<Partial<Record<StartupStepId, boolean>>>({});

const startupSteps = computed(() => nostrStore.startupSteps);

const displayedStartupStep = computed(() => {
  const displayStepId = nostrStore.startupDisplay.stepId;
  if (!displayStepId) {
    return null;
  }

  const step = startupSteps.value.find((entry) => entry.id === displayStepId);
  if (!step) {
    return null;
  }

  return {
    ...step,
    status: nostrStore.startupDisplay.status ?? step.status,
    showProgress: nostrStore.startupDisplay.showProgress
  };
});

const startupHistory = computed(() => {
  return [...startupSteps.value].sort((first, second) => first.order - second.order);
});

const hasHeaderActivity = computed(() => {
  return startupSteps.value.some(
    (step) =>
      step.status === 'in_progress' ||
      step.internalTasks.some((task) => task.status === 'in_progress')
  );
});

const isAnyStartupStepRerunning = computed(() => {
  return Object.values(rerunningStartupStepIds.value).some((value) => value === true);
});

const cardSubtitle = computed(() => {
  if (hasHeaderActivity.value && displayedStartupStep.value?.showProgress === true) {
    return startupStepLabel(displayedStartupStep.value);
  }

  return t('startup.recentActivity');
});

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
    return 'app-status__status-icon app-status__status-icon--success';
  }

  if (status === 'error') {
    return 'app-status__status-icon app-status__status-icon--error';
  }

  if (status === 'in_progress') {
    return 'app-status__status-icon app-status__status-icon--progress';
  }

  return 'app-status__status-icon app-status__status-icon--pending';
}

function startupStepMeta(step: StartupTimedSnapshot & { showProgress?: boolean }): string {
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
    const statusMeta =
      'showProgress' in step && step.showProgress === true
        ? t('relays.fetchingRelays')
        : t('common.progress');
    return [statusMeta, eventCountMeta].filter(Boolean).join(' - ');
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

function startupStepDuration(step: StartupTimedSnapshot): string {
  if (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs)) {
    return step.status === 'in_progress' ? t('common.runningLabel') : t('common.pending');
  }

  if (step.durationMs < 1000) {
    return `${Math.max(1, Math.round(step.durationMs))} ms`;
  }

  return `${(step.durationMs / 1000).toFixed(step.durationMs >= 10000 ? 0 : 1)} s`;
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

function startupStepRefreshLabel(
  step: Pick<StartupStepSnapshot, 'eventCount' | 'id' | 'label'>
): string {
  return `${t('common.refresh')}: ${startupStepLabel(step)}`;
}

function isStartupStepRerunning(stepId: StartupStepId): boolean {
  return rerunningStartupStepIds.value[stepId] === true;
}

function isStartupStepRefreshDisabled(step: StartupStepSnapshot): boolean {
  return (
    !props.allowStepRerun ||
    nostrStore.isRestoringStartupState ||
    isAnyStartupStepRerunning.value ||
    step.status === 'in_progress'
  );
}

async function handleStartupStepRefresh(stepId: StartupStepId): Promise<void> {
  const step = startupSteps.value.find((entry) => entry.id === stepId);
  if (!step || isStartupStepRefreshDisabled(step)) {
    return;
  }

  rerunningStartupStepIds.value = {
    ...rerunningStartupStepIds.value,
    [stepId]: true,
  };

  try {
    await nostrStore.rerunStartupStep(stepId);
    notifyStartupStepRefreshComplete(stepId);
  } catch (error) {
    reportUiError('Failed to refresh startup step', error, 'Failed to refresh startup step.');
  } finally {
    const nextRerunningStepIds = { ...rerunningStartupStepIds.value };
    delete nextRerunningStepIds[stepId];
    rerunningStartupStepIds.value = nextRerunningStepIds;
  }
}

function notifyStartupStepRefreshComplete(stepId: StartupStepId): void {
  if (stepId !== 'private-contact-list-restore') {
    return;
  }

  const step = startupSteps.value.find((entry) => entry.id === stepId);
  if (!step) {
    return;
  }

  const entryCount = startupStepEntryCount(step);
  if (entryCount === null) {
    return;
  }

  $q.notify({
    type: 'positive',
    message: `Fetched ${entryCount} private contact list ${entryCount === 1 ? 'entry' : 'entries'}.`,
    position: 'top',
    timeout: 2500,
  });
}
</script>

<style scoped>
.app-status {
  --app-status-history-item-height: 58px;
  height: 100%;
  min-height: 0;
}

.app-status--embedded {
  height: auto;
}

.app-status__card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid color-mix(in srgb, var(--nc-border) 88%, #8ea4c0 12%);
  border-radius: 14px;
  overflow: hidden;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.app-status--embedded .app-status__card {
  height: auto;
  min-height: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.app-status__card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--nc-border) 90%, transparent);
  background: color-mix(in srgb, var(--nc-panel-header-bg) 92%, rgba(255, 255, 255, 0.08));
}

.app-status__card-copy {
  min-width: 0;
  flex: 1;
}

.app-status__card-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--nc-text);
}

.app-status__card-subtitle {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--nc-text-secondary);
}

.app-status__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}

.app-status__badge--busy {
  color: #235e97;
  background: rgba(59, 130, 246, 0.14);
}

.app-status__content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 14px 16px 16px;
}

.app-status--embedded .app-status__content {
  padding: 0;
}

.app-status__details-copy {
  font-size: 12px;
  line-height: 1.5;
  color: var(--nc-text-secondary);
}

.app-status__history-expansion {
  border-radius: 0;
}

.app-status__history-expansion :deep(.q-item) {
  min-height: var(--app-status-history-item-height);
  padding: 0;
}

.app-status__history-expansion :deep(.q-focus-helper) {
  display: none;
}

.app-status__history-item {
  display: grid;
  grid-template-columns: 44px 30px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  width: 100%;
  min-height: var(--app-status-history-item-height);
}

.app-status__history-item--rerunnable {
  grid-template-columns: 40px 28px 30px minmax(0, 1fr) auto;
  column-gap: 6px;
}

.app-status__history-counter {
  padding-top: 1px;
  font-size: 12px;
  font-weight: 700;
  color: var(--nc-text-secondary);
  white-space: nowrap;
}

.app-status__progress-track {
  width: 26px;
  padding-top: 7px;
}

.app-status__progress-bar {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nc-border) 70%, transparent);
}

.app-status__history-copy {
  min-width: 0;
}

.app-status__history-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.app-status__history-label span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-status__lock-icon {
  flex: 0 0 auto;
  color: var(--nc-text-secondary);
}

.app-status__history-meta,
.app-status__history-duration {
  font-size: 12px;
  line-height: 1.45;
  color: var(--nc-text-secondary);
}

.app-status__history-list {
  display: grid;
  gap: 10px;
}

.app-status__history-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.app-status--embedded .app-status__history-scroll {
  overflow: visible;
  padding-right: 0;
}

.app-status__history-entry + .app-status__history-entry {
  padding-top: 10px;
  border-top: 1px solid var(--nc-border);
}

.app-status__history-duration {
  white-space: nowrap;
}

.q-btn.app-status__step-refresh {
  align-self: start;
  min-width: 24px;
  width: 24px;
  min-height: 24px;
  height: 24px;
  margin-top: -5px;
  padding: 0;
  color: var(--nc-text-secondary);
}

.q-btn.app-status__step-refresh :deep(.q-icon) {
  font-size: 16px;
}

.app-status__status-icon {
  margin-top: 1px;
}

.app-status__internal-list {
  display: grid;
  gap: 8px;
  padding: 2px 0 10px 94px;
}

.app-status__internal-item {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}

.app-status__internal-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
}

.app-status__status-icon--success {
  color: #16a34a;
}

.app-status__status-icon--error {
  color: #dc2626;
}

.app-status__status-icon--progress,
.app-status__status-icon--pending {
  color: #74839b;
}

body.body--dark .app-status__badge--busy {
  color: #a8d0ff;
  background: rgba(37, 99, 235, 0.24);
}

body.body--dark .app-status__status-icon--success {
  color: #7ee2a8;
}

body.body--dark .app-status__status-icon--error {
  color: #ff9b90;
}

body.body--dark .app-status__status-icon--progress,
body.body--dark .app-status__status-icon--pending {
  color: var(--nc-text-secondary);
}

@media (max-width: 420px) {
  .app-status__history-item {
    grid-template-columns: 38px 26px minmax(0, 1fr);
  }

  .app-status__history-item--rerunnable {
    grid-template-columns: 36px 28px 26px minmax(0, 1fr);
    column-gap: 6px;
  }

  .app-status__history-duration {
    grid-column: 3;
  }

  .app-status__history-item--rerunnable .app-status__history-duration {
    grid-column: 4;
  }

  .app-status__internal-list {
    padding-left: 84px;
  }

  .app-status__internal-item {
    grid-template-columns: 26px minmax(0, 1fr);
  }

  .app-status__internal-item .app-status__history-duration {
    grid-column: 2;
  }
}

@media (--nc-mobile-viewport) {
  .app-status {
    --app-status-history-item-height: 52px;
  }

  .app-status__card-header {
    padding: 12px 14px;
  }

  .app-status__badge {
    min-height: 22px;
    padding: 0 9px;
    font-size: 10px;
  }

  .app-status__content {
    padding: 12px 14px 14px;
  }

  .app-status__history-scroll {
    min-height: 0;
  }
}
</style>
