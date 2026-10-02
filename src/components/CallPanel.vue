<template>
  <q-dialog :model-value="Boolean(call.session)" persistent :seamless="minimized" :maximized="$q.screen.lt.sm && !minimized" :class="{ 'call-dialog--minimized': minimized }">
    <q-card class="call-panel" data-testid="call-panel">
      <div class="call-panel__header">
        <span>{{ $t(call.session?.mode === 'video' ? 'call.video' : 'call.audio') }}</span>
        <q-btn v-if="canMinimize" flat round icon="minimize" :aria-label="$t('call.minimize')" @click="minimized = true" />
      </div>
      <div class="call-panel__identity">
        <q-icon :name="call.session?.mode === 'video' ? 'videocam' : 'call'" size="40px" />
        <h2>{{ call.session?.peerName }}</h2>
        <div role="status" aria-live="polite" data-testid="call-status">{{ status }}</div>
      </div>
      <div v-if="call.remoteMediaUrl || call.localStream" class="call-panel__media" :class="{ 'call-panel__media--audio': call.session?.mode === 'audio' }">
        <video v-if="call.remoteMediaUrl" ref="remoteVideo" :src="call.remoteMediaUrl" autoplay playsinline class="call-panel__remote" data-testid="call-remote-media" @loadeddata="playRemote" @progress="followLive" />
        <video v-if="call.localStream && call.session?.mode === 'video'" v-show="!call.session.cameraMuted" ref="localVideo" autoplay playsinline muted class="call-panel__local" aria-hidden="true" />
      </div>
      <q-btn v-if="playbackBlocked" flat icon="volume_up" :label="$t('call.playAudio')" @click="playRemote" />
      <div v-if="call.error" class="call-panel__error" role="alert">{{ $t(call.error) }}</div>
      <div class="call-panel__controls">
        <template v-if="call.session?.phase === 'incoming'">
          <q-btn round color="negative" icon="call_end" data-testid="call-decline" :aria-label="$t('call.decline')" @click="call.end" />
          <q-btn round color="positive" :icon="call.session.mode === 'video' ? 'videocam' : 'call'" data-testid="call-accept" :aria-label="$t('call.accept')" @click="call.accept" />
        </template>
        <q-btn v-else-if="call.session?.phase === 'ended'" color="primary" no-caps :label="$t('common.close')" data-testid="call-dismiss" @click="call.dismiss" />
        <template v-else>
          <q-btn round :color="call.session?.microphoneMuted ? 'negative' : 'grey-8'" :icon="call.session?.microphoneMuted ? 'mic_off' : 'mic'" :disable="!call.localStream" :aria-label="$t(call.session?.microphoneMuted ? 'call.unmuteMicrophone' : 'call.muteMicrophone')" :aria-pressed="call.session?.microphoneMuted" data-testid="call-microphone" @click="call.toggleMicrophone" />
          <q-btn v-if="call.session?.mode === 'video'" round :color="call.session.cameraMuted ? 'negative' : 'grey-8'" :icon="call.session.cameraMuted ? 'videocam_off' : 'videocam'" :disable="!call.localStream" :aria-label="$t(call.session.cameraMuted ? 'call.enableCamera' : 'call.disableCamera')" :aria-pressed="call.session.cameraMuted" data-testid="call-camera" @click="call.toggleCamera" />
          <q-btn round color="negative" icon="call_end" :aria-label="$t('call.hangup')" data-testid="call-hangup" @click="call.end" />
        </template>
      </div>
    </q-card>
  </q-dialog>
  <div v-if="minimized && call.session" class="call-compact" role="status" data-testid="call-compact">
    <q-btn flat no-caps icon="call" :label="`${call.session.peerName} · ${status}`" :aria-label="$t('call.restore')" @click="minimized = false" />
    <q-btn flat round color="negative" icon="call_end" :aria-label="$t('call.hangup')" @click="call.end" />
  </div>
  <q-dialog :model-value="Boolean(call.error) && !call.session" @hide="call.dismiss">
    <q-card class="q-pa-lg"><div role="alert">{{ $t(call.error) }}</div><q-btn class="q-mt-md" color="primary" :label="$t('common.close')" @click="call.dismiss" /></q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useCallStore } from 'src/stores/callStore';
import { createCallRingtone } from 'src/services/callRingtone';
import { t } from 'src/i18n';

const $q = useQuasar();
const call = useCallStore();
const ringtone = createCallRingtone();
const minimized = ref(false);
const localVideo = ref<HTMLVideoElement | null>(null);
const remoteVideo = ref<HTMLVideoElement | null>(null);
const playbackBlocked = ref(false);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 1000);
const canMinimize = computed(() => ['active', 'connecting', 'outgoing'].includes(call.session?.phase ?? ''));
const status = computed(() => {
  const session = call.session;
  if (!session) return '';
  if (session.phase === 'active' && session.startedAt) {
    const seconds = Math.max(0, Math.floor((now.value - Date.parse(session.startedAt)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return t(session.phase === 'ended' ? `call.ended.${session.endReason}` : `call.phase.${session.phase}`);
});
async function playRemote() {
  try { await remoteVideo.value?.play(); playbackBlocked.value = false; }
  catch { playbackBlocked.value = true; }
}
function followLive() {
  const video = remoteVideo.value;
  if (!video?.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  if (end - video.currentTime > 1.2) video.currentTime = Math.max(video.buffered.start(0), end - 0.3);
}
watch([() => call.localStream, localVideo], () => {
  if (localVideo.value) { localVideo.value.srcObject = call.localStream; void localVideo.value.play().catch(() => {}); }
}, { flush: 'post' });
watch(() => call.session?.id, () => { minimized.value = false; playbackBlocked.value = false; });
watch(() => call.session?.phase, (phase) => {
  ringtone.setRinging(phase === 'incoming' || phase === 'outgoing');
  if (phase === 'ended') minimized.value = false;
});
watch(() => call.remoteMediaUrl, async () => { await nextTick(); await playRemote(); });
onBeforeUnmount(() => { clearInterval(clock); ringtone.dispose(); call.reset(); });
</script>

<style scoped>
.call-dialog--minimized :deep(.q-dialog__inner) { visibility: hidden; pointer-events: none; }
.call-panel { width: min(560px, 100vw); max-width: 100vw; display: flex; flex-direction: column; background: var(--nc-panel-header-bg); color: var(--nc-text); border-radius: 20px; padding: 20px; }
.call-panel__header { display: flex; justify-content: space-between; align-items: center; color: var(--nc-text-secondary); }
.call-panel__identity { text-align: center; padding: 24px 0; }
.call-panel__identity h2 { font-size: 1.5rem; line-height: 1.3; margin: 14px 0 8px; overflow-wrap: anywhere; }
.call-panel__media { position: relative; background: #101418; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; }
.call-panel__remote { width: 100%; height: 100%; object-fit: contain; }
.call-panel__local { position: absolute; bottom: 12px; right: 12px; width: 28%; border-radius: 8px; transform: scaleX(-1); }
.call-panel__media--audio { height: 1px; width: 1px; aspect-ratio: auto; position: absolute; overflow: hidden; }
.call-panel__controls { display: flex; gap: 20px; justify-content: center; padding: 28px 0 16px; }
.call-panel__controls .q-btn--round { width: 56px; height: 56px; }
.call-panel__error { text-align: center; color: var(--q-negative); padding: 12px 0; }
.call-compact { position: fixed; z-index: 6000; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; max-width: calc(100vw - 24px); border-radius: 30px; box-shadow: var(--nc-shadow-md); background: var(--nc-panel-header-bg); color: var(--nc-text); }
@media (max-width: 599px) { .call-panel { border-radius: 0; justify-content: center; padding-top: max(20px, env(safe-area-inset-top)); padding-bottom: max(20px, env(safe-area-inset-bottom)); } }
</style>
