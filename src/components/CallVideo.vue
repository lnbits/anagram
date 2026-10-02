<template>
  <video ref="video" :src="url || undefined" muted autoplay playsinline @loadeddata="play" @progress="followLive" />
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ url?: string; stream?: MediaStream | null }>();
const video = ref<HTMLVideoElement | null>(null);
function play() { void video.value?.play().catch(() => {}); }
function followLive() {
  const element = video.value;
  if (!element?.buffered.length) return;
  const end = element.buffered.end(element.buffered.length - 1);
  if (end - element.currentTime > 1.5) element.currentTime = Math.max(element.buffered.start(0), end - 0.35);
}
watch([video, () => props.stream, () => props.url], () => {
  if (video.value) { video.value.srcObject = props.stream ?? null; play(); }
}, { flush: 'post' });
</script>
