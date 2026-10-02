<template>
  <div data-testid="settings-iroh-panel">
    <div class="iroh-modes" role="group" :aria-label="$t('iroh.mode')">
      <q-radio v-for="mode in modes" :key="mode" :model-value="settings.mode" :val="mode"
        :label="$t(`iroh.mode.${mode}`)" :data-testid="`iroh-mode-${mode}`"
        :disable="saving || (mode !== 'pool' && settings.customRelays.length === 0)"
        @update:model-value="value => save({ ...settings, mode: value })" />
    </div>
    <div class="iroh-toolbar">
      <q-input v-model="newRelay" class="nc-input iroh-input" outlined dense rounded
        :label="$t('relays.relayUrl')" placeholder="https://iroh.example.com"
        data-testid="iroh-new-relay" :disable="saving" :error="Boolean(validationError)"
        :error-message="validationError" @keydown.enter.prevent="addRelay">
        <template #append>
          <q-btn unelevated round dense color="primary" icon="add" size="sm"
            :aria-label="$t('relays.addRelay')" data-testid="iroh-add-relay"
            :disable="saving || !canAdd" @click="addRelay" />
        </template>
      </q-input>
      <q-btn flat color="primary" icon="restart_alt" :label="$t('relays.useDefaultRelays')"
        data-testid="iroh-default-relays" :disable="saving" @click="save({ mode: 'pool', customRelays: [] })" />
    </div>
    <p class="iroh-hint">{{ $t('iroh.explanation') }}</p>
    <q-banner v-if="error" rounded class="bg-negative text-white q-mb-md" role="alert">{{ error }}</q-banner>
    <q-linear-progress v-if="saving" indeterminate class="q-mb-sm" :aria-label="$t('iroh.saving')" />
    <q-list bordered separator class="iroh-list" :aria-busy="saving">
      <q-item v-for="entry in entries" :key="entry.url" data-testid="iroh-relay-row">
        <q-item-section avatar><q-avatar size="22px" class="iroh-icon"><q-icon name="satellite_alt" size="14px" /></q-avatar></q-item-section>
        <q-item-section class="iroh-url-section">
          <q-item-label class="iroh-url">{{ entry.url }}</q-item-label>
          <q-item-label caption>{{ $t(entry.shared ? 'iroh.sharedPool' : settings.mode === 'pool' ? 'iroh.customInactive' : 'iroh.customRelay') }}</q-item-label>
        </q-item-section>
        <q-item-section v-if="!entry.shared" side class="iroh-actions">
          <q-btn flat round dense icon="delete" color="negative" :aria-label="$t('relays.deleteRelay')"
            data-testid="iroh-delete-relay" :disable="saving || (settings.mode === 'custom' && settings.customRelays.length === 1)"
            @click="removeCustom(entry.url)" />
        </q-item-section>
      </q-item>
    </q-list>
    <p class="iroh-hint q-mt-sm">{{ $t('iroh.nextCalls') }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useNostrStore } from 'src/stores/nostrStore';
import { t } from 'src/i18n';
import { defaultIrohRelays, isSharedIrohRelay, normalizeIrohRelayUrl, type IrohRelaySettings, type IrohRelayMode } from 'src/utils/irohRelays';
const nostr = useNostrStore();
const settings = ref(nostr.getIrohRelaySettings());
const modes: IrohRelayMode[] = ['pool', 'pool-custom', 'custom'];
const entries = computed(() => [
  ...(settings.value.mode === 'custom' ? [] : defaultIrohRelays().map(entry => ({ url: entry.url, shared: true }))),
  ...settings.value.customRelays.map(url => ({ url, shared: false })),
]);
const newRelay = ref('');
const publishing = ref(false);
const saving = computed(() => publishing.value || nostr.isRestoringStartupState);
const error = ref('');
const validationError = computed(() => {
  if (!newRelay.value.trim()) return '';
  const url = normalizeIrohRelayUrl(newRelay.value);
  if (!url) return t('iroh.invalidUrl');
  if (isSharedIrohRelay(url)) return t('iroh.builtInRelay');
  if (settings.value.customRelays.includes(url)) return t('iroh.duplicate');
  if (settings.value.customRelays.length >= 16) return t('iroh.limit');
  return '';
});
const canAdd = computed(() => Boolean(newRelay.value.trim()) && !validationError.value);
async function save(value: IrohRelaySettings): Promise<boolean> {
  if (saving.value) return false;
  publishing.value = true;
  error.value = '';
  try { settings.value = await nostr.saveIrohRelaySettings(value); return true; }
  catch { error.value = t('iroh.saveFailed'); return false; }
  finally { publishing.value = false; }
}
async function addRelay() {
  if (!canAdd.value) return;
  const url = normalizeIrohRelayUrl(newRelay.value);
  if (url && await save({ mode: settings.value.mode === 'pool' ? 'pool-custom' : settings.value.mode, customRelays: [...settings.value.customRelays, url] })) newRelay.value = '';
}
function removeCustom(url: string) {
  const customRelays = settings.value.customRelays.filter(value => value !== url);
  if (settings.value.mode === 'custom' && customRelays.length === 0) return;
  void save({ mode: customRelays.length ? settings.value.mode : 'pool', customRelays });
}
function refresh() { if (!saving.value) settings.value = nostr.getIrohRelaySettings(); }
watch(() => nostr.isRestoringStartupState, restoring => { if (!restoring) refresh(); });
onMounted(() => window.addEventListener('storage', refresh));
onUnmounted(() => window.removeEventListener('storage', refresh));
</script>
<style scoped>
.iroh-toolbar { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; margin-top: 12px; }
.iroh-input { flex: 1 1 260px; min-width: 0; }
.iroh-hint { font-size: 13px; color: var(--nc-text-secondary); }
.iroh-list { border-radius: 12px; background: color-mix(in srgb, var(--nc-sidebar) 90%, transparent); }
.iroh-icon { background: color-mix(in srgb, var(--nc-text-secondary) 12%, transparent); color: var(--nc-text-secondary); }
.iroh-url-section { min-width: 0; }
.iroh-url { overflow-wrap: anywhere; }
.iroh-modes { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px; }
.iroh-actions { margin-left: 8px; padding-left: 8px; border-left: 1px solid var(--nc-border); }
</style>
