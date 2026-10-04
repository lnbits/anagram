<template>
  <video ref="video" :src="url || undefined" muted autoplay playsinline @loadeddata="play" @progress="followLive" />
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { followCallLive } from 'src/services/callPlaybackService';
const props = defineProps<{ url?: string; stream?: MediaStream | null }>();
const video = ref<HTMLVideoElement | null>(null);
function play() { void video.value?.play().catch(() => {}); }
const followLive = () => followCallLive(video.value);
watch([video, () => props.stream, () => props.url], () => {
  if (video.value) { video.value.srcObject = props.stream ?? null; play(); }
}, { flush: 'post' });
</script>
