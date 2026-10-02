<template>
  <q-dialog :model-value="Boolean(request)" @hide="choose(null)">
    <q-card class="q-pa-lg screen-picker">
      <div class="text-h6 q-mb-md">{{ $t('call.chooseScreen') }}</div>
      <div class="screen-picker__grid">
        <button v-for="source in request?.sources" :key="source.id" class="screen-picker__source" @click="choose(source.id)">
          <img :src="source.thumbnail" alt="" /><span>{{ source.name }}</span>
        </button>
      </div>
      <q-btn flat class="q-mt-md" :label="$t('common.cancel')" @click="choose(null)" />
    </q-card>
  </q-dialog>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useCallStore } from 'src/stores/callStore';
import { useCallRoomStore } from 'src/stores/callRoomStore';
const call = useCallStore();
const room = useCallRoomStore();
const request = ref<{ id: string; sources: Array<{ id: string; name: string; thumbnail: string }> } | null>(null);
function choose(sourceId: string | null) {
  if (!request.value) return;
  window.desktopRuntime?.selectCallScreen?.(request.value.id, sourceId);
  request.value = null;
}
const unsubscribe = window.desktopRuntime?.onCallScreenPicker?.((value) => { request.value = value; });
watch(() => room.busy || (call.session && call.session.phase !== 'ended'), (active) => { if (!active) choose(null); });
onBeforeUnmount(() => { choose(null); unsubscribe?.(); });
</script>
<style scoped>
.screen-picker { width: min(850px, 100vw); max-width: 100vw; }
.screen-picker__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; max-height: 65vh; overflow: auto; }
.screen-picker__source { padding: 8px; background: transparent; color: inherit; border: 1px solid currentColor; border-radius: 8px; cursor: pointer; }
.screen-picker__source img { width: 100%; display: block; }
.screen-picker__source span { display: block; margin-top: 8px; overflow-wrap: anywhere; }
</style>
