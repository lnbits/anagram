<template>
  <audio ref="audio" :src="url || undefined" :muted="muted" autoplay :data-testid="`room-audio-${peer}`" @loadeddata="play" @progress="followLive" />
  <q-btn v-if="blocked && url" flat icon="volume_up" :label="$t('call.playAudio') + ' · ' + name" @click="play" />
</template>
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { setCallSpeaker } from 'src/services/callPlaybackService';
const props = defineProps<{ peer: string; name: string; url: string; muted: boolean; sink: string }>();
const emit = defineEmits<{ outputError: [] }>();
const audio = ref<HTMLAudioElement | null>(null);
const blocked = ref(false);
let attempt = 0;
async function play() {
  if (!audio.value || !props.url) return;
  const current = ++attempt;
  try { await audio.value.play(); if (current === attempt) blocked.value = false; }
  catch (cause) { if (current === attempt && !(cause instanceof DOMException && cause.name === 'AbortError')) blocked.value = true; }
}
function followLive() {
  const element = audio.value;
  if (!element?.buffered.length) return;
  const end = element.buffered.end(element.buffered.length - 1);
  if (end - element.currentTime > 1.5) element.currentTime = Math.max(element.buffered.start(0), end - 0.35);
}
watch(() => props.url, async () => { attempt += 1; await nextTick(); await play(); });
watch([audio, () => props.sink], async () => {
  if (!audio.value) return;
  try { await setCallSpeaker(audio.value, props.sink); } catch { emit('outputError'); }
}, { flush: 'post' });
</script>
