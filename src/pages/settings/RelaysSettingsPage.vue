<template>
  <SettingsDetailLayout :title="$t('relays.title')" icon="satellite_alt">
    <div class="relays-content">
      <q-tabs
        v-model="activeTab"
        dense
        align="justify"
        active-color="primary"
        indicator-color="primary"
        class="relays-tabs"
      >
        <q-tab
          name="my"
          :label="$t('relays.nip65.mineTitle')"
          class="relays-tab"
          data-testid="settings-relays-my-tab"
        />
        <q-tab
          name="app"
          :label="$t('relays.appRelays.title')"
          class="relays-tab"
          data-testid="settings-relays-app-tab"
        />
        <q-tab name="iroh" :label="$t('iroh.title')" class="relays-tab" data-testid="settings-relays-iroh-tab" />
      </q-tabs>

      <q-tab-panels v-model="activeTab" animated class="relays-panels">
        <q-tab-panel name="my" class="relays-panel">
          <RelayEditorPanel
            v-model:new-relay="myNewRelay"
            :relays="nip65RelayStore.relays"
            :relay-validation-error="myRelayValidationError"
            :can-add-relay="canAddMyRelay"
            :empty-message="$t('relays.nip65RelaysConfigured')"
            :secondary-action-disabled="!canUseDefaultMyRelays"
            :secondary-action-label="$t('relays.useDefaultRelays')"
            secondary-action-icon="restart_alt"
            :relay-read-enabled="myRelayReadEnabled"
            :relay-write-enabled="myRelayWriteEnabled"
            :relay-icon-url="relayIconUrl"
            :is-relay-connected="isRelayConnected"
            :is-relay-info-loading="isRelayInfoLoading"
            :relay-info-error="relayInfoError"
            :relay-info="relayInfo"
            @add-relay="addMyRelay"
            @remove-relay="removeMyRelay"
            @secondary-action="useDefaultMyRelays"
            @relay-expand="handleRelayExpand"
            @retry-relay-info="retryRelayInfo"
            @relay-icon-error="handleRelayIconError"
            @update-relay-read="updateMyRelayRead"
            @update-relay-write="updateMyRelayWrite"
          />
        </q-tab-panel>

        <q-tab-panel
          name="app"
          class="relays-panel"
          data-testid="settings-relays-app-panel"
        >
          <RelayEditorPanel
            v-model:new-relay="appNewRelay"
            :relays="relayStore.relays"
            :relay-validation-error="appRelayValidationError"
            :can-add-relay="canAddAppRelay"
            :empty-message="$t('relays.appRelaysConfigured')"
            :secondary-action-disabled="!canRestoreDefaults"
            :secondary-action-label="$t('relays.restoreDefaultRelays')"
            secondary-action-icon="restart_alt"
            :relay-read-enabled="appRelayReadEnabled"
            :relay-write-enabled="appRelayWriteEnabled"
            :relay-icon-url="relayIconUrl"
            :is-relay-connected="isRelayConnected"
            :is-relay-info-loading="isRelayInfoLoading"
            :relay-info-error="relayInfoError"
            :relay-info="relayInfo"
            @add-relay="addAppRelay"
            @remove-relay="removeAppRelay"
            @secondary-action="restoreDefaults"
            @relay-expand="handleRelayExpand"
            @retry-relay-info="retryRelayInfo"
            @relay-icon-error="handleRelayIconError"
            @update-relay-read="updateAppRelayRead"
            @update-relay-write="updateAppRelayWrite"
          />
        </q-tab-panel>

        <q-tab-panel name="iroh" class="relays-panel"><IrohRelaySettingsPanel /></q-tab-panel>
      </q-tab-panels>
    </div>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { useRelayDecorations } from 'src/composables/useRelayDecorations';
import IrohRelaySettingsPanel from 'src/components/IrohRelaySettingsPanel.vue';
import RelayEditorPanel from 'src/components/RelayEditorPanel.vue';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import { DEFAULT_RELAYS } from 'src/constants/relays';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { useRelayStore } from 'src/stores/relayStore';
import { uniqueRelayUrls } from 'src/utils/relayUrls';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { t } from 'src/i18n';

type RelayTab = 'my' | 'app' | 'iroh';
interface RelayTogglePayload {
  index: number;
  value: boolean;
}

const relayStore = useRelayStore();
const nip65RelayStore = useNip65RelayStore();
const nostrStore = useNostrStore();
const activeTab = ref<RelayTab>('my');
const appNewRelay = ref('');
const myNewRelay = ref('');
let myRelaysSyncPromise: Promise<void> | null = null;
let hasPendingMyRelaysSync = false;
const {
  isRelayConnected,
  isRelayInfoLoading,
  loadRelayInfo,
  prepareRelayDecorations: prepareRelayDecorationState,
  pruneRelayInfoCache,
  relayIconUrl,
  relayInfo,
  relayInfoError,
  setRelayIconError
} = useRelayDecorations(nostrStore);
const appRelayValidationError = computed(() => validateRelayUrl(appNewRelay.value.trim()));
const myRelayValidationError = computed(() => validateRelayUrl(myNewRelay.value.trim()));
const canAddAppRelay = computed(() => {
  const value = appNewRelay.value.trim();
  return value.length > 0 && appRelayValidationError.value.length === 0;
});
const canAddMyRelay = computed(() => {
  const value = myNewRelay.value.trim();
  return value.length > 0 && myRelayValidationError.value.length === 0;
});
const canRestoreDefaults = computed(() => {
  if (relayStore.relays.length !== DEFAULT_RELAYS.length) {
    return true;
  }

  if (relayStore.relays.some((relay, index) => relay !== DEFAULT_RELAYS[index])) {
    return true;
  }

  return relayStore.relayEntries.some((entry) => entry.read !== true || entry.write !== true);
});
const canUseDefaultMyRelays = computed(() => {
  if (nip65RelayStore.relays.length !== DEFAULT_RELAYS.length) {
    return true;
  }

  if (nip65RelayStore.relays.some((relay, index) => relay !== DEFAULT_RELAYS[index])) {
    return true;
  }

  return nip65RelayStore.relayEntries.some((entry) => entry.read !== true || entry.write !== true);
});
const allKnownRelays = computed(() =>
  uniqueRelayUrls([...relayStore.relays, ...nip65RelayStore.relays])
);

relayStore.init();
nip65RelayStore.init();

watch(
  allKnownRelays,
  (relays) => {
    pruneRelayInfoCache(relays);
    void prepareRelayDecorationState(relays);
  },
  { immediate: true }
);

function handleRelayExpand(relay: string): void {
  try {
    void loadRelayInfo(relay);
  } catch (error) {
    reportUiError('Failed to expand relay details', error);
  }
}

function retryRelayInfo(relay: string): void {
  try {
    void loadRelayInfo(relay, true);
  } catch (error) {
    reportUiError('Failed to retry relay info load', error);
  }
}

function handleRelayIconError(relay: string): void {
  try {
    setRelayIconError(relay);
  } catch (error) {
    reportUiError('Failed to handle relay icon error', error);
  }
}

function addAppRelay(): void {
  try {
    const value = appNewRelay.value.trim();
    if (!value || appRelayValidationError.value) {
      return;
    }

    relayStore.addRelay(value);
    appNewRelay.value = '';
  } catch (error) {
    reportUiError('Failed to add app relay', error);
  }
}

function addMyRelay(): void {
  try {
    const value = myNewRelay.value.trim();
    if (!value || myRelayValidationError.value) {
      return;
    }

    nip65RelayStore.addRelay(value);
    myNewRelay.value = '';
    queueMyRelaysSync();
  } catch (error) {
    reportUiError('Failed to add personal relay', error);
  }
}

function validateRelayUrl(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return t('relays.relayMustUseWs');
    }

    if (!url.hostname) {
      return t('relays.relayUrlMustInclude');
    }

    return '';
  } catch {
    return t('relays.relayMustValidWs');
  }
}

function removeAppRelay(index: number): void {
  try {
    relayStore.removeRelay(index);
  } catch (error) {
    reportUiError('Failed to remove app relay', error);
  }
}

function removeMyRelay(index: number): void {
  try {
    nip65RelayStore.removeRelay(index);
    queueMyRelaysSync();
  } catch (error) {
    reportUiError('Failed to remove personal relay', error);
  }
}

function appRelayReadEnabled(index: number): boolean {
  return relayStore.getRelayFlags(index).read;
}

function appRelayWriteEnabled(index: number): boolean {
  return relayStore.getRelayFlags(index).write;
}

function updateAppRelayRead({ index, value }: RelayTogglePayload): void {
  try {
    relayStore.setRelayFlags(index, { read: value });
  } catch (error) {
    reportUiError('Failed to update app relay read flag', error);
  }
}

function updateAppRelayWrite({ index, value }: RelayTogglePayload): void {
  try {
    relayStore.setRelayFlags(index, { write: value });
  } catch (error) {
    reportUiError('Failed to update app relay write flag', error);
  }
}

function myRelayReadEnabled(index: number): boolean {
  return nip65RelayStore.getRelayFlags(index).read;
}

function myRelayWriteEnabled(index: number): boolean {
  return nip65RelayStore.getRelayFlags(index).write;
}

function updateMyRelayRead({ index, value }: RelayTogglePayload): void {
  try {
    nip65RelayStore.setRelayFlags(index, { read: value });
    queueMyRelaysSync();
  } catch (error) {
    reportUiError('Failed to update personal relay read flag', error);
  }
}

function updateMyRelayWrite({ index, value }: RelayTogglePayload): void {
  try {
    nip65RelayStore.setRelayFlags(index, { write: value });
    queueMyRelaysSync();
  } catch (error) {
    reportUiError('Failed to update personal relay write flag', error);
  }
}

function restoreDefaults(): void {
  try {
    relayStore.restoreDefaults();
  } catch (error) {
    reportUiError('Failed to restore default app relays', error);
  }
}

function useDefaultMyRelays(): void {
  try {
    nip65RelayStore.restoreDefaults();
    for (const relay of DEFAULT_RELAYS) {
      nip65RelayStore.addRelay(relay);
    }

    queueMyRelaysSync();
  } catch (error) {
    reportUiError('Failed to reset personal relays', error);
  }
}

function queueMyRelaysSync(): void {
  hasPendingMyRelaysSync = true;

  if (myRelaysSyncPromise) {
    return;
  }

  myRelaysSyncPromise = (async () => {
    while (hasPendingMyRelaysSync) {
      hasPendingMyRelaysSync = false;
      const relayEntriesSnapshot = nip65RelayStore.relayEntries.map((entry) => ({ ...entry }));

      try {
        await nostrStore.publishMyRelayList(relayEntriesSnapshot, relayStore.relays);
        await nostrStore.updateLoggedInUserRelayList(relayEntriesSnapshot);
      } catch (error) {
        reportUiError('Failed to sync My Relays updates', error);
      }
    }
  })().finally(() => {
    myRelaysSyncPromise = null;
  });
}
</script>

<style scoped>
.relays-content {
  width: 100%;
}

.relays-tabs {
  width: 100%;
  border-bottom: 1px solid var(--nc-border);
}

.relays-tabs :deep(.q-tabs__content) {
  width: 100%;
}

.relays-tabs :deep(.q-tab) {
  flex: 1 1 0;
  max-width: none;
  min-width: 0;
}

.relays-tabs :deep(.q-tab__label) { white-space: normal; overflow-wrap: anywhere; }

.relays-tab {
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.relays-panels {
  background: transparent;
}

.relays-panel {
  padding: 0;
}

</style>
