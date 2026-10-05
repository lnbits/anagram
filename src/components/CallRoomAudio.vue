<template>
  <audio ref="audio" :src="url || undefined" :muted="muted" autoplay :data-testid="`room-audio-${peer}`" @loadeddata="play" @progress="followLive" />
  <q-btn v-if="blocked && url" flat icon="volume_up" :label="$t('call.playAudio') + (name ? ' · ' + name : '')" @click="play" />
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { observeCallActivity } from 'src/services/callActivityService';
import { followCallLive, setCallSpeaker } from 'src/services/callPlaybackService';
const props = defineProps<{ peer: string; name: string; url: string; muted: boolean; sink: string; activity?: boolean }>();
const emit = defineEmits<{ outputError: []; level: [value: number] }>();
let stopActivity: (() => void) | undefined;
function startActivity() {
  if (!props.activity) { emit('level', 0); return; }
  if (!audio.value || stopActivity) return;
  const element = audio.value as HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  try {
    const stream = element.captureStream?.() ?? element.mozCaptureStream?.();
    if (stream) stopActivity = observeCallActivity(stream, (level) => { if (props.activity) emit('level', level); });
  } catch { /* Playback remains available if this browser cannot expose decoded audio. */ }
}
const audio = ref<HTMLAudioElement | null>(null);
const blocked = ref(false);
let attempt = 0;
async function play() {
  if (!audio.value || !props.url) return;
  const current = ++attempt;
  try { await audio.value.play(); if (current === attempt) { blocked.value = false; startActivity(); } }
  catch (cause) { if (current === attempt && !(cause instanceof DOMException && cause.name === 'AbortError')) blocked.value = true; }
}
const followLive = () => followCallLive(audio.value);
watch(() => props.url, async () => { stopActivity?.(); stopActivity = undefined; attempt += 1; await nextTick(); await play(); });
watch([audio, () => props.sink], async () => {
  if (!audio.value) return;
  try { await setCallSpeaker(audio.value, props.sink); } catch { emit('outputError'); }
}, { flush: 'post' });
watch(() => props.activity, startActivity);
onBeforeUnmount(() => { stopActivity?.(); emit('level', 0); });
</script>
