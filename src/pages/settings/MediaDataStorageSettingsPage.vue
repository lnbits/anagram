<template>
  <SettingsDetailLayout :title="$t('mediaDataStorage.title')" icon="storage">
    <q-card flat bordered class="media-data-card">
      <q-card-section class="media-data-card__section">
        <div>
          <div class="text-body1">{{ $t('mediaDataStorage.blossomServer') }}</div>
          <div class="text-caption text-grey-6">
            {{ $t('mediaDataStorage.blossomServerDescription') }}
          </div>
        </div>

        <q-form class="media-data-card__form" @submit.prevent="saveServer">
          <q-input
            v-model="serverUrlInput"
            outlined
            type="url"
            inputmode="url"
            autocomplete="url"
            autocapitalize="none"
            spellcheck="false"
            class="nc-input"
            data-testid="settings-blossom-server-input"
            :label="$t('mediaDataStorage.serverUrl')"
            :hint="$t('mediaDataStorage.serverUrlHint')"
            :error="Boolean(serverValidationError)"
            :error-message="serverValidationError"
            :disable="isSaving"
          />

          <div class="media-data-card__actions">
            <q-btn
              flat
              no-caps
              icon="restart_alt"
              data-testid="settings-blossom-restore-default"
              :label="$t('mediaDataStorage.restoreDefault')"
              :disable="isSaving || !canRestoreDefault"
              @click="restoreDefaultServer"
            />
            <q-btn
              unelevated
              no-caps
              color="primary"
              type="submit"
              data-testid="settings-blossom-save"
              :label="$t('common.save')"
              :loading="isSaving"
              :disable="!canSave"
            />
          </div>
        </q-form>

        <div class="media-data-card__privacy text-caption text-grey-6">
          <q-icon name="encrypted" size="18px" aria-hidden="true" />
          <span>{{ $t('mediaDataStorage.encryptedPreference') }}</span>
        </div>
      </q-card-section>
    </q-card>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import { t } from 'src/i18n';
import { useNostrStore } from 'src/stores/nostrStore';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  normalizeBlossomServerUrl,
} from 'src/utils/blossomServer';
import { reportUiError } from 'src/utils/uiErrorHandler';

const $q = useQuasar();
const nostrStore = useNostrStore();
const savedServerUrl = ref(nostrStore.getBlossomServerUrl());
const serverUrlInput = ref(savedServerUrl.value);
const isSaving = ref(false);

const normalizedServerUrl = computed(() =>
  normalizeBlossomServerUrl(serverUrlInput.value)
);
const serverValidationError = computed(() => {
  if (!serverUrlInput.value.trim()) {
    return t('mediaDataStorage.serverUrlRequired');
  }

  return normalizedServerUrl.value ? '' : t('mediaDataStorage.serverUrlInvalid');
});
const canSave = computed(
  () =>
    !isSaving.value &&
    Boolean(normalizedServerUrl.value) &&
    normalizedServerUrl.value !== savedServerUrl.value
);
const canRestoreDefault = computed(
  () =>
    serverUrlInput.value.trim() !== DEFAULT_BLOSSOM_SERVER_URL ||
    savedServerUrl.value !== DEFAULT_BLOSSOM_SERVER_URL
);

async function persistServer(serverUrl: string): Promise<void> {
  if (isSaving.value) {
    return;
  }

  isSaving.value = true;
  try {
    const savedUrl = await nostrStore.saveBlossomServerUrl(serverUrl);
    savedServerUrl.value = savedUrl;
    serverUrlInput.value = savedUrl;
    $q.notify({
      type: 'positive',
      message: t('mediaDataStorage.serverSaved'),
      position: 'top',
    });
  } catch (error) {
    reportUiError(
      'Failed to save Blossom server preference',
      error,
      t('mediaDataStorage.serverSaveFailed')
    );
  } finally {
    isSaving.value = false;
  }
}

function saveServer(): void {
  if (!canSave.value || !normalizedServerUrl.value) {
    return;
  }

  void persistServer(normalizedServerUrl.value);
}

function restoreDefaultServer(): void {
  if (!canRestoreDefault.value) {
    return;
  }

  void persistServer(DEFAULT_BLOSSOM_SERVER_URL);
}
</script>

<style scoped>
.media-data-card {
  width: 100%;
  max-width: none;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.media-data-card__section {
  display: grid;
  gap: 20px;
}

.media-data-card__form {
  display: grid;
  gap: 18px;
  max-width: 720px;
}

.media-data-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.media-data-card__privacy {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 720px;
}

.media-data-card__privacy .q-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

@media (--nc-mobile-viewport) {
  .media-data-card__actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
}
</style>
