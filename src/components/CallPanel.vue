<template>
  <!-- Keep audio mounted and separate from the video/dialog lifecycle. -->
  <audio ref="remoteAudio" :src="audioUrl || undefined" :muted="speakerMuted" autoplay data-testid="call-remote-audio" @loadeddata="playAudio" @progress="followAudio" />
  <q-dialog :model-value="Boolean(call.session)" persistent :seamless="minimized" :maximized="!minimized" :class="{ 'call-dialog--minimized': minimized }">
    <q-card class="call-panel" :class="{ 'call-panel--minimized': minimized }" data-testid="call-panel">
      <div class="call-panel__header">
        <span>{{ $t(hasVideo || call.session?.mode === 'video' ? 'call.video' : 'call.audio') }}</span>
        <q-btn v-if="canMinimize" flat round icon="minimize" :aria-label="$t('call.minimize')" @click="minimized = true" />
      </div>
      <div class="call-panel__identity">
        <q-icon :name="hasVideo || call.session?.mode === 'video' ? 'videocam' : 'call'" size="40px" />
        <h2>{{ call.session?.peerName }}</h2>
        <div role="status" aria-live="polite" data-testid="call-status">{{ status }}</div>
      </div>
      <CallStage ref="stage" :active="Boolean(call.session && call.session.phase !== 'ended')" :screens="screens" @blocked="outputError = 'call.error.popup'">
      <div v-if="hasVideo" class="call-panel__media">
        <video v-if="videoUrl" ref="remoteVideo" :src="videoUrl" :muted="call.session?.mediaVersion === 2 || speakerMuted" autoplay playsinline class="call-panel__remote" data-testid="call-remote-media" @loadeddata="playVideo" @progress="followVideo" />
        <video v-if="call.localStream?.getVideoTracks().length" v-show="!call.session?.cameraMuted" ref="localVideo" autoplay playsinline muted class="call-panel__local" aria-hidden="true" />
      </div>
      </CallStage>
      <q-btn v-if="screens.length || hasVideo" flat icon="open_in_new" :label="$t('call.presentationWindow')" data-testid="call-open-window" @click="stage?.openWindow()" />
      <q-btn v-if="playbackBlocked" flat icon="volume_up" :label="$t('call.playAudio')" data-testid="call-play-audio" @click="playAudio" />
      <div v-if="call.error || call.deviceError || outputError" class="call-panel__error" role="alert">{{ $t(call.error || call.deviceError || outputError) }}</div>
      <div class="call-panel__controls">
        <template v-if="call.session?.phase === 'incoming'">
          <q-btn round color="negative" icon="call_end" data-testid="call-decline" :aria-label="$t('call.decline')" @click="call.end" />
          <q-btn color="positive" icon="call" no-caps data-testid="call-accept" :label="$t('call.answerAudio')" @click="call.accept('audio')" />
          <q-btn v-if="call.session.mode === 'video'" color="primary" icon="videocam" no-caps data-testid="call-accept-video" :label="$t('call.answerVideo')" @click="call.accept('video')" />
        </template>
        <q-btn v-else-if="call.session?.phase === 'ended'" color="primary" no-caps :label="$t('common.close')" data-testid="call-dismiss" @click="call.dismiss" />
        <template v-else>
          <div class="call-panel__device">
            <q-btn round :color="call.session?.microphoneMuted ? 'negative' : 'grey-8'" :icon="call.session?.microphoneMuted ? 'mic_off' : 'mic'" :disable="!call.localStream" :aria-label="$t(call.session?.microphoneMuted ? 'call.unmuteMicrophone' : 'call.muteMicrophone')" :aria-pressed="call.session?.microphoneMuted" data-testid="call-microphone" @click="call.toggleMicrophone" />
            <q-btn flat dense round icon="expand_more" :disable="call.session?.phase !== 'active' || call.changingMedia" :aria-label="$t('call.chooseMicrophone')" data-testid="call-microphone-menu">
              <q-menu @before-show="refreshDevices()">
                <q-list class="call-device-menu">
                  <q-item-label header>{{ $t('call.microphone') }}</q-item-label>
                  <q-item v-if="call.session?.mediaVersion !== 2"><q-item-section>{{ $t('call.error.peerUpgrade') }}</q-item-section></q-item>
                  <template v-else>
                    <q-item v-close-popup clickable data-testid="call-microphone-default" @click="call.selectMicrophone('')"><q-item-section>{{ $t('call.systemDefault') }}</q-item-section></q-item>
                    <q-item v-for="(device, index) in microphones" :key="device.deviceId" v-close-popup clickable :active="call.microphoneDeviceId === device.deviceId" :data-testid="`call-microphone-source-${index}`" @click="call.selectMicrophone(device.deviceId)">
                      <q-item-section>{{ device.label || `${$t('call.microphone')} ${index + 1}` }}</q-item-section>
                    </q-item>
                  </template>
                </q-list>
              </q-menu>
            </q-btn>
          </div>
          <div class="call-panel__device">
            <q-btn round :color="speakerMuted ? 'negative' : 'grey-8'" :icon="speakerMuted ? 'volume_off' : 'volume_up'" :aria-label="$t(speakerMuted ? 'call.unmuteSpeaker' : 'call.muteSpeaker')" :aria-pressed="speakerMuted" data-testid="call-speaker" @click="speakerMuted = !speakerMuted" />
            <q-btn flat dense round icon="expand_more" :aria-label="$t('call.chooseSpeaker')" data-testid="call-speaker-menu">
              <q-menu @before-show="refreshDevices()">
                <q-list class="call-device-menu">
                  <q-item-label header>{{ $t('call.speaker') }}</q-item-label>
                  <q-item v-close-popup clickable :active="!speakerDeviceId" data-testid="call-speaker-default" @click="selectSpeaker('')"><q-item-section>{{ $t('call.systemDefault') }}</q-item-section></q-item>
                  <template v-if="canSelectSpeaker">
                    <q-item v-for="(device, index) in speakers" :key="device.deviceId" v-close-popup clickable :active="speakerDeviceId === device.deviceId" :data-testid="`call-speaker-source-${index}`" @click="selectSpeaker(device.deviceId)"><q-item-section>{{ device.label || `${$t('call.speaker')} ${index + 1}` }}</q-item-section></q-item>
                    <q-item v-if="canRequestSpeaker" v-close-popup clickable @click="requestSpeaker"><q-item-section>{{ $t('call.chooseSpeaker') }}</q-item-section></q-item>
                  </template>
                  <q-item v-else><q-item-section>{{ $t('call.speakerUnavailable') }}</q-item-section></q-item>
                </q-list>
              </q-menu>
            </q-btn>
          </div>
          <q-btn round :color="call.session?.cameraMuted ? 'grey-8' : 'primary'" :icon="call.session?.cameraMuted ? 'videocam_off' : 'videocam'" :disable="!canToggleCamera || call.changingMedia" :loading="call.changingMedia" :aria-label="$t(call.session?.cameraMuted ? 'call.enableCamera' : 'call.disableCamera')" :aria-pressed="!call.session?.cameraMuted" data-testid="call-camera" @click="call.toggleCamera">
            <q-tooltip v-if="!canToggleCamera">{{ $t('call.videoUnavailable') }}</q-tooltip>
          </q-btn>
          <q-btn round :color="call.session?.screenSharing ? 'primary' : 'grey-8'" :icon="call.session?.screenSharing ? 'stop_screen_share' : 'screen_share'" :disable="call.session?.phase !== 'active' || !call.session.screenAvailable || !canShareScreen" :aria-label="$t(call.session?.screenSharing ? 'call.stopScreen' : 'call.shareScreen')" data-testid="call-share-screen" @click="toggleScreen">
            <q-tooltip>{{ $t(canShareScreen ? 'call.shareScreen' : 'call.screenUnavailable') }}</q-tooltip>
          </q-btn>
          <q-btn round color="negative" icon="call_end" :aria-label="$t('call.hangup')" data-testid="call-hangup" @click="call.end" />
        </template>
      </div>
    </q-card>
  </q-dialog>
  <div v-if="minimized && call.session" class="call-compact" role="status" data-testid="call-compact">
    <q-btn flat no-caps icon="call" :label="`${call.session.peerName} · ${status}`" :aria-label="$t('call.restore')" @click="minimized = false" />
    <q-btn v-if="playbackBlocked" flat icon="volume_up" :label="$t('call.playAudio')" @click="playAudio" />
    <q-btn flat round color="negative" icon="call_end" :aria-label="$t('call.hangup')" @click="call.end" />
  </div>
  <q-dialog :model-value="Boolean(call.error) && !call.session" @hide="call.dismiss">
    <q-card class="q-pa-lg"><div role="alert">{{ $t(call.error) }}</div><q-btn class="q-mt-md" color="primary" :label="$t('common.close')" @click="call.dismiss" /></q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useCallStore } from 'src/stores/callStore';
import { createCallRingtone } from 'src/services/callRingtone';
import { registerCallAudio, setCallSpeaker } from 'src/services/callPlaybackService';
import { t } from 'src/i18n';
import { canShareCallScreen } from 'src/services/callMediaService';
import CallStage from './CallStage.vue';

const $q = useQuasar();
const call = useCallStore();
const ringtone = createCallRingtone();
const stage = ref<InstanceType<typeof CallStage> | null>(null);
const canShareScreen = canShareCallScreen();
const screens = computed(() => [
  ...(call.remoteScreenUrl ? [{ id: 'remote', name: call.session?.peerName || '', url: call.remoteScreenUrl }] : []),
  ...(call.localScreenStream ? [{ id: 'local', name: t('call.yourScreen'), stream: call.localScreenStream }] : []),
]);
async function toggleScreen() {
  if (call.session?.screenSharing) { await call.stopScreenSharing(); return; }
  const capture = call.startScreenSharing();
  stage.value?.openWindow();
  window.focus();
  await capture;
  stage.value?.focusWindow();
}
const minimized = ref(false);
const localVideo = ref<HTMLVideoElement | null>(null);
const remoteVideo = ref<HTMLVideoElement | null>(null);
const remoteAudio = ref<HTMLAudioElement | null>(null);
const playbackBlocked = ref(false);
const outputError = ref('');
const speakerMuted = ref(false);
const speakerDeviceId = ref('');
const microphones = ref<MediaDeviceInfo[]>([]);
const speakers = ref<MediaDeviceInfo[]>([]);
const canSelectSpeaker = computed(() => typeof remoteAudio.value?.setSinkId === 'function');
const outputDevices = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
const canRequestSpeaker = typeof outputDevices?.selectAudioOutput === 'function';
const audioUrl = computed(() => call.session?.mediaVersion === 2 || call.session?.mode === 'audio' ? call.remoteMediaUrl : '');
const videoUrl = computed(() => call.remoteVideoUrl || (call.session?.mediaVersion !== 2 && call.session?.mode === 'video' ? call.remoteMediaUrl : ''));
const hasVideo = computed(() => Boolean(videoUrl.value || (!call.session?.cameraMuted && call.localStream?.getVideoTracks().length)));
const canToggleCamera = computed(() => Boolean(call.localStream && call.session?.phase === 'active' && (call.session.mediaVersion === 2 ? call.session.videoAvailable : call.session.mode === 'video')));
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 1000);
let disposed = false;
let playbackAttempt = 0;
const canMinimize = computed(() => ['active', 'connecting', 'outgoing'].includes(call.session?.phase ?? ''));
const status = computed(() => {
  const session = call.session;
  if (!session) return '';
  if (session.phase === 'active' && session.startedAt) {
    const seconds = Math.max(0, Math.floor((now.value - Date.parse(session.startedAt)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (session.phase === 'outgoing' && !session.peerConfirmed) return t('call.phase.checkingSupport');
  return t(session.phase === 'ended' ? `call.ended.${session.endReason}` : `call.phase.${session.phase}`);
});
async function playAudio() {
  const element = audioUrl.value ? remoteAudio.value : videoUrl.value && call.session?.mediaVersion !== 2 ? remoteVideo.value : null;
  if (!element) return;
  const attempt = ++playbackAttempt;
  try {
    await element.play();
    if (attempt === playbackAttempt) playbackBlocked.value = false;
  } catch (cause) {
    if (attempt !== playbackAttempt || disposed || !call.remoteMediaUrl) return;
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    playbackBlocked.value = true;
  }
}
async function playVideo() {
  if (call.session?.mediaVersion !== 2) { await playAudio(); return; }
  try { await remoteVideo.value?.play(); } catch { /* Muted video retries on loadeddata. */ }
}
function followLive(element: HTMLMediaElement | null) {
  if (!element?.buffered.length) return;
  const end = element.buffered.end(element.buffered.length - 1);
  if (end - element.currentTime > 1.5) element.currentTime = Math.max(element.buffered.start(0), end - 0.35);
}
const followAudio = () => followLive(remoteAudio.value);
const followVideo = () => followLive(remoteVideo.value);
async function selectSpeaker(id: string) {
  outputError.value = '';
  try {
    if (remoteAudio.value) await setCallSpeaker(remoteAudio.value, id);
    if (remoteVideo.value && call.session?.mediaVersion !== 2) await setCallSpeaker(remoteVideo.value, id);
    if (!disposed) speakerDeviceId.value = id;
  } catch (cause) {
    if (!disposed) outputError.value = cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'call.error.speakerPermission' : 'call.error.speaker';
  }
}
async function requestSpeaker() {
  try {
    // Invoke while the menu click still has transient user activation.
    const device = await outputDevices.selectAudioOutput?.();
    if (device && !disposed) { await selectSpeaker(device.deviceId); await refreshDevices(); }
  } catch { if (!disposed) outputError.value = 'call.error.speakerPermission'; }
}
async function refreshDevices(recover = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (disposed) return;
    microphones.value = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    speakers.value = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default');
    if (recover && speakerDeviceId.value && !speakers.value.some((device) => device.deviceId === speakerDeviceId.value)) await selectSpeaker('');
    if (recover && microphones.value.length && call.microphoneDeviceId && !microphones.value.some((device) => device.deviceId === call.microphoneDeviceId)) await call.selectMicrophone('');
  } catch { /* A denied device list does not revoke an already working microphone. */ }
}
const devicesChanged = () => { void refreshDevices(true); };
watch([() => call.localStream, localVideo], () => {
  if (localVideo.value) { localVideo.value.srcObject = call.localStream; void localVideo.value.play().catch(() => {}); }
}, { flush: 'post' });
watch(() => call.session?.id, () => {
  minimized.value = false;
  playbackBlocked.value = false;
  outputError.value = '';
  speakerMuted.value = false;
  playbackAttempt += 1;
});
watch(() => call.session?.phase, (phase) => {
  ringtone.setRinging(phase === 'incoming' || phase === 'outgoing');
  if (phase === 'ended') minimized.value = false;
});
watch(audioUrl, async (url) => {
  playbackAttempt += 1;
  await nextTick();
  if (!url) { remoteAudio.value?.pause(); remoteAudio.value?.load(); return; }
  await playAudio();
});
watch(videoUrl, async () => { await nextTick(); await playVideo(); if (speakerDeviceId.value && call.session?.mediaVersion !== 2) await selectSpeaker(speakerDeviceId.value); });
onMounted(() => {
  registerCallAudio(remoteAudio.value);
  navigator.mediaDevices?.addEventListener('devicechange', devicesChanged);
});
onBeforeUnmount(() => {
  disposed = true;
  playbackAttempt += 1;
  registerCallAudio(null);
  navigator.mediaDevices?.removeEventListener('devicechange', devicesChanged);
  clearInterval(clock);
  ringtone.dispose();
  call.reset();
});
</script>

<style scoped>
.call-panel--minimized { visibility: hidden; pointer-events: none; }
.call-panel { width: 100%; height: 100dvh; max-width: 100%; max-height: 100dvh; overflow: hidden; display: flex; flex-direction: column; background: var(--nc-panel-header-bg); color: var(--nc-text); border-radius: 0; padding: clamp(8px, 2vw, 20px); }
.call-panel > :not(.call-stage) { flex-shrink: 0; }
.call-panel__header { display: flex; justify-content: space-between; align-items: center; color: var(--nc-text-secondary); }
.call-panel__identity { text-align: center; padding: 4px 0; }
.call-panel__identity h2 { font-size: 1.5rem; line-height: 1.3; margin: 4px 0; overflow-wrap: anywhere; }
.call-panel__media { position: relative; background: #101418; height: 100%; min-height: 0; border-radius: 12px; overflow: hidden; }
.call-panel__remote { width: 100%; height: 100%; object-fit: contain; }
.call-panel__local { position: absolute; bottom: 12px; right: 12px; width: 28%; max-height: 35%; object-fit: contain; border-radius: 8px; transform: scaleX(-1); }
.call-panel__controls { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; align-items: flex-start; padding: 8px 0 0; }
.call-panel__controls > .q-btn--round, .call-panel__device > .q-btn--round:first-child { width: 52px; height: 52px; }
.call-panel__device { display: flex; flex-direction: column; align-items: center; }
.call-device-menu { min-width: 220px; max-width: 320px; }
.call-panel__error { text-align: center; color: var(--q-negative); padding: 12px 0; }
.call-compact { position: fixed; z-index: 6000; top: calc(env(safe-area-inset-top, 0px) + 12px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; max-width: calc(100vw - 24px); border-radius: 30px; box-shadow: var(--nc-shadow-md); background: var(--nc-panel-header-bg); color: var(--nc-text); }
@media (max-width: 599px), (max-height: 500px) {
  .call-panel { padding: 8px; padding-top: max(8px, env(safe-area-inset-top)); padding-bottom: max(8px, env(safe-area-inset-bottom)); }
  .call-panel__identity > .q-icon { display: none; }
  .call-panel__controls { gap: 4px; }
  .call-panel__controls > .q-btn--round, .call-panel__device > .q-btn--round:first-child { width: 40px; height: 40px; }
}
</style>
