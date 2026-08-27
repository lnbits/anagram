<template>
  <SettingsDetailLayout :title="$t('settings.appearance')" icon="wallpaper">
    <q-card flat bordered class="theme-card">
      <q-card-section class="theme-card__section">
        <div class="theme-card__setting">
          <div class="theme-card__copy">
            <div class="text-body1">{{ $t('settings.appearance') }}</div>
            <div class="text-caption text-grey-6">
              {{ $t('settings.theme.description') }}
            </div>
          </div>

          <q-toggle
            v-model="darkMode"
            color="primary"
            checked-icon="dark_mode"
            unchecked-icon="light_mode"
            :label="$t('common.darkMode')"
            left-label
            class="theme-card__toggle"
          />
        </div>

        <q-separator />

        <div class="theme-card__setting theme-card__setting--stacked">
          <div class="theme-card__copy">
            <div class="text-body1">{{ $t('settings.desktopMessageLayout.title') }}</div>
            <div class="text-caption text-grey-6">
              {{ $t('settings.desktopMessageLayout.description') }}
            </div>
          </div>

          <q-select
            v-model="desktopMessageLayout"
            class="nc-input theme-card__layout-select"
            data-testid="settings-desktop-message-layout-toggle"
            outlined
            dense
            emit-value
            map-options
            option-label="label"
            option-value="value"
            :label="$t('settings.desktopMessageLayout.title')"
            :options="desktopMessageLayoutOptions"
          />
        </div>
      </q-card-section>
    </q-card>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import { t } from 'src/i18n';
import {
  readDesktopMessageLayoutPreference,
  saveDarkModePreference,
  saveDesktopMessageLayoutPreference,
  type DesktopMessageLayoutPreference
} from 'src/utils/themeStorage';

const $q = useQuasar();

const darkMode = computed({
  get: () => $q.dark.isActive,
  set: (value: boolean) => {
    $q.dark.set(value);
    saveDarkModePreference(value);
  }
});

const desktopMessageLayout = ref<DesktopMessageLayoutPreference>(
  readDesktopMessageLayoutPreference()
);

const desktopMessageLayoutOptions = computed(() => [
  {
    label: t('settings.desktopMessageLayout.text'),
    value: 'text'
  },
  {
    label: t('settings.desktopMessageLayout.bubbles'),
    value: 'bubbles'
  }
]);

watch(desktopMessageLayout, (value) => {
  saveDesktopMessageLayoutPreference(value);
});
</script>

<style scoped>
.theme-card {
  width: 100%;
  max-width: none;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.theme-card__section {
  display: grid;
  gap: 18px;
}

.theme-card__setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-width: 0;
}

.theme-card__setting--stacked {
  align-items: stretch;
  flex-direction: column;
}

.theme-card__copy {
  min-width: 0;
}

.theme-card__toggle {
  flex: 0 0 auto;
  justify-content: space-between;
}

.theme-card__toggle :deep(.q-toggle__inner) {
  flex-shrink: 0;
}

.theme-card__toggle :deep(.q-toggle__label) {
  flex: 1 1 auto;
  min-width: 0;
}

.theme-card__toggle :deep(.q-toggle__inner + .q-toggle__label),
.theme-card__toggle :deep(.q-toggle__label + .q-toggle__inner) {
  margin-left: 0;
}

.theme-card__layout-select {
  width: min(100%, 360px);
}

@media (--nc-mobile-viewport) {
  .theme-card__setting {
    align-items: stretch;
    flex-direction: column;
  }

  .theme-card__toggle {
    width: 100%;
  }

  .theme-card__layout-select {
    width: 100%;
  }
}
</style>
