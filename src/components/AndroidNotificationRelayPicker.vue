<template>
  <div class="notification-relay-picker">
    <div>
      <div class="text-body2">{{ $t('notifications.android.relays.title') }}</div>
      <div class="text-caption text-grey-6">
        {{ $t('notifications.android.relays.caption') }}
      </div>
    </div>

    <q-linear-progress v-if="loading" indeterminate rounded color="primary" />

    <div v-else-if="candidates.length === 0" class="notification-relay-picker__empty">
      {{ $t('notifications.android.relays.empty') }}
    </div>

    <template v-else>
      <section
        v-for="group in candidateGroups"
        :key="group.source"
        class="notification-relay-picker__group"
      >
        <div class="notification-relay-picker__group-header">
          <span class="text-caption text-weight-medium">{{ $t(group.labelKey) }}</span>
          <q-btn
            v-if="group.source !== 'unavailable'"
            flat
            dense
            no-caps
            color="primary"
            size="sm"
            :disable="disabled"
            :label="
              isGroupFullySelected(group.candidates)
                ? $t('notifications.android.relays.clear')
                : $t('notifications.android.relays.selectAll')
            "
            @click="toggleGroup(group.candidates)"
          />
        </div>

        <q-list bordered separator class="notification-relay-picker__list">
          <q-item v-for="candidate in group.candidates" :key="candidate.url" dense>
            <q-item-section avatar>
              <q-checkbox
                :model-value="isSelected(candidate.url)"
                :disable="disabled || (!candidate.available && !isSelected(candidate.url))"
                color="primary"
                :data-testid="`notifications-android-relay-${candidate.url}`"
                @update:model-value="(value) => updateRelay(candidate.url, Boolean(value))"
              />
            </q-item-section>

            <q-item-section>
              <q-item-label class="notification-relay-picker__url">
                {{ candidate.url }}
              </q-item-label>
              <q-item-label v-if="candidate.sources.length > 1" caption>
                <q-chip
                  v-for="source in candidate.sources"
                  :key="source"
                  dense
                  outline
                  size="sm"
                  color="primary"
                >
                  {{ sourceLabel(source) }}
                </q-chip>
              </q-item-label>
              <q-item-label v-else-if="!candidate.available" caption class="text-negative">
                {{ $t('notifications.android.relays.unavailableCaption') }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </section>
    </template>

    <div
      v-if="selectedAvailableCount > 5"
      class="notification-relay-picker__notice text-caption text-warning"
    >
      <q-icon name="battery_alert" size="18px" aria-hidden="true" />
      <span>{{ $t('notifications.android.relays.batteryWarning') }}</span>
    </div>
    <div
      v-else-if="selectedAvailableCount === 0 && !loading"
      class="notification-relay-picker__notice text-caption text-negative"
    >
      <q-icon name="error_outline" size="18px" aria-hidden="true" />
      <span>{{ $t('notifications.android.relays.required') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from 'src/i18n';
import type {
  AndroidNotificationRelayCandidate,
  AndroidNotificationRelaySource,
} from 'src/services/androidNotificationRelaySelectionService';
import { computed } from 'vue';

type CandidateGroupSource = AndroidNotificationRelaySource | 'unavailable';

interface CandidateGroup {
  source: CandidateGroupSource;
  labelKey: string;
  candidates: AndroidNotificationRelayCandidate[];
}

const props = withDefaults(
  defineProps<{
    candidates: AndroidNotificationRelayCandidate[];
    modelValue: string[];
    loading?: boolean;
    disabled?: boolean;
  }>(),
  {
    loading: false,
    disabled: false,
  }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string[]): void;
}>();

const selectedRelaySet = computed(() => new Set(props.modelValue));
const selectedAvailableCount = computed(
  () =>
    props.candidates.filter(
      (candidate) => candidate.available && selectedRelaySet.value.has(candidate.url)
    ).length
);
const candidateGroups = computed<CandidateGroup[]>(() => {
  const groups: CandidateGroup[] = [
    {
      source: 'user',
      labelKey: 'notifications.android.relays.user',
      candidates: [],
    },
    {
      source: 'app',
      labelKey: 'notifications.android.relays.app',
      candidates: [],
    },
    {
      source: 'group',
      labelKey: 'notifications.android.relays.group',
      candidates: [],
    },
    {
      source: 'unavailable',
      labelKey: 'notifications.android.relays.unavailable',
      candidates: [],
    },
  ];
  const groupsBySource = new Map(groups.map((group) => [group.source, group]));

  for (const candidate of props.candidates) {
    const primarySource = candidate.available ? candidate.sources[0] : 'unavailable';
    if (primarySource) {
      groupsBySource.get(primarySource)?.candidates.push(candidate);
    }
  }

  return groups.filter((group) => group.candidates.length > 0);
});

function isSelected(relayUrl: string): boolean {
  return selectedRelaySet.value.has(relayUrl);
}

function orderedSelection(selection: Set<string>): string[] {
  const candidateOrder = new Map(
    props.candidates.map((candidate, index) => [candidate.url, index])
  );
  return Array.from(selection).sort(
    (first, second) =>
      (candidateOrder.get(first) ?? Number.MAX_SAFE_INTEGER) -
        (candidateOrder.get(second) ?? Number.MAX_SAFE_INTEGER) || first.localeCompare(second)
  );
}

function updateRelay(relayUrl: string, selected: boolean): void {
  const nextSelection = new Set(props.modelValue);
  if (selected) {
    nextSelection.add(relayUrl);
  } else {
    nextSelection.delete(relayUrl);
  }
  emit('update:modelValue', orderedSelection(nextSelection));
}

function isGroupFullySelected(candidates: AndroidNotificationRelayCandidate[]): boolean {
  return candidates.every((candidate) => selectedRelaySet.value.has(candidate.url));
}

function toggleGroup(candidates: AndroidNotificationRelayCandidate[]): void {
  const nextSelection = new Set(props.modelValue);
  const shouldSelect = !isGroupFullySelected(candidates);
  for (const candidate of candidates) {
    if (shouldSelect) {
      nextSelection.add(candidate.url);
    } else {
      nextSelection.delete(candidate.url);
    }
  }
  emit('update:modelValue', orderedSelection(nextSelection));
}

function sourceLabel(source: AndroidNotificationRelaySource): string {
  return t(`notifications.android.relays.${source}`);
}
</script>

<style scoped>
.notification-relay-picker {
  display: grid;
  gap: 14px;
}

.notification-relay-picker__group {
  display: grid;
  gap: 6px;
}

.notification-relay-picker__group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.notification-relay-picker__list {
  border-radius: 12px;
  overflow: hidden;
}

.notification-relay-picker__url {
  overflow-wrap: anywhere;
}

.notification-relay-picker__empty {
  padding: 14px;
  border: 1px dashed color-mix(in srgb, var(--nc-text) 25%, transparent);
  border-radius: 12px;
  color: var(--nc-text-muted);
}

.notification-relay-picker__notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
</style>
