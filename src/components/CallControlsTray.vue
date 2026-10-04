<template>
  <div class="call-controls-tray" :class="{ 'call-controls-tray--hidden': hidden }" data-testid="call-controls-tray" @pointerenter="enter" @pointerleave="leave" @focusin="cancelHide" @focusout="scheduleHide">
    <div class="call-controls-tray__clip" :inert="hidden">
      <slot :auto-hide="autoHide" :toggle="toggle" />
    </div>
  </div>
  <button v-if="autoHide" class="call-controls-edge" type="button" :aria-label="$t('call.showControls')" data-testid="call-controls-edge" @pointerenter="reveal" @focus="reveal" @click="reveal">
    <span aria-hidden="true">⌃</span>
  </button>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps<{ enabled: boolean }>();
const autoHide = ref(false);
watch(() => props.enabled, () => { autoHide.value = false; revealed.value = false; cancelHide(); });
const revealed = ref(false);
const hidden = computed(() => autoHide.value && !revealed.value);
let hovered = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function cancelHide() { clearTimeout(timer); }
function reveal() { cancelHide(); revealed.value = true; }
function enter() { hovered = true; cancelHide(); }
function scheduleHide() {
  cancelHide();
  timer = setTimeout(() => {
    if (!hovered && !document.activeElement?.closest('.call-controls-tray, .q-menu')) revealed.value = false;
  }, 400);
}
function leave() { hovered = false; scheduleHide(); }
function toggle() {
  cancelHide();
  autoHide.value = !autoHide.value;
  revealed.value = false;
  if (autoHide.value && document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
onBeforeUnmount(cancelHide);
</script>
<style scoped>
.call-controls-tray { display: grid; grid-template-rows: 1fr; min-height: 0; flex-shrink: 0; transition: grid-template-rows 220ms ease; }
.call-controls-tray__clip { min-height: 0; overflow: hidden; transform: translateY(0); transition: transform 220ms ease, opacity 220ms ease; }
.call-controls-tray--hidden { grid-template-rows: 0fr; }
.call-controls-tray--hidden .call-controls-tray__clip { transform: translateY(100%); opacity: 0; pointer-events: none; }
.call-controls-edge { position: fixed; z-index: 1; bottom: 0; left: 0; width: 100%; height: max(16px, env(safe-area-inset-bottom)); padding: 0; border: 0; background: transparent; color: white; cursor: pointer; }
.call-controls-edge span { opacity: 0; }
.call-controls-edge:focus-visible { outline: 2px solid var(--q-primary); background: #101418; }
.call-controls-edge:focus-visible span { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .call-controls-tray, .call-controls-tray__clip { transition: none; } }
</style>
