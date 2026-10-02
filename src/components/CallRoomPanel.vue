<template>
  <div class="room-audio-recovery">
    <CallRoomAudio v-for="peer in room.participants" :key="peer.pubkey + peer.sessionId" :peer="peer.pubkey" :name="peer.name" :url="peer.audioUrl" :muted="speakerMuted" :sink="speakerId" @output-error="outputError = 'call.error.speaker'" />
  </div>
  <q-dialog :model-value="Boolean(room.session)" persistent :seamless="minimized" :maximized="!minimized" :class="{ 'room-dialog--minimized': minimized }">
    <q-card class="room-panel" :class="{ 'room-panel--minimized': minimized }" data-testid="room-panel">
      <div class="row items-center justify-between q-mb-md">
        <div class="text-h6">{{ $t('room.title') }} · {{ room.session?.members.length || 1 }}/{{ ROOM_MAX_MEMBERS }}</div>
        <q-btn v-if="room.busy" flat round icon="minimize" :aria-label="$t('call.minimize')" @click="minimized = true" />
      </div>
      <div role="status" data-testid="room-status">{{ $t(`room.phase.${room.session?.phase || 'preparing'}`) }}</div>
      <div v-if="room.shareLink && room.busy" class="row items-center q-gutter-sm q-my-md">
        <q-input :model-value="room.shareLink" readonly outlined dense class="col" :label="$t('room.link')" data-testid="room-link" />
        <q-btn flat icon="content_copy" :label="$t('room.copyLink')" data-testid="room-copy-link" @click="copyLink" />
      </div>
      <CallStage ref="stage" :active="room.busy" :screens="screens" @blocked="outputError = 'call.error.popup'">
        <div class="room-grid">
          <div v-if="room.localStream" class="room-tile">
            <CallVideo v-if="!room.cameraMuted" :stream="room.localStream" />
            <q-icon v-else name="account_circle" size="64px" />
            <div>{{ $t('room.you') }} <q-icon v-if="room.microphoneMuted" name="mic_off" /></div>
          </div>
          <div v-for="peer in room.participants" :key="peer.pubkey + peer.sessionId" class="room-tile" :data-testid="`room-peer-${peer.pubkey}`">
            <CallVideo v-if="peer.videoUrl" :url="peer.videoUrl" />
            <q-icon v-else name="account_circle" size="64px" />
            <div>{{ peer.name }} <span v-if="peer.phase !== 'active'">· {{ $t(peer.phase === 'ended' ? 'call.ended.failed' : 'call.phase.connecting') }}</span></div>
          </div>
        </div>
      </CallStage>
      <div v-if="room.error || outputError" class="text-negative q-pa-sm" role="alert">{{ $t(room.error || outputError) }}</div>
      <div v-if="room.busy" class="room-controls">
        <div class="row items-center">
          <q-btn round :color="room.microphoneMuted ? 'negative' : 'grey-8'" :icon="room.microphoneMuted ? 'mic_off' : 'mic'" :aria-label="$t(room.microphoneMuted ? 'call.unmuteMicrophone' : 'call.muteMicrophone')" data-testid="room-microphone" @click="room.toggleMicrophone" />
          <q-btn flat dense round icon="expand_more" :disable="room.changingMedia" :aria-label="$t('call.chooseMicrophone')"><q-menu @before-show="refreshDevices"><q-list>
            <q-item v-close-popup clickable @click="room.selectMicrophone('')"><q-item-section>{{ $t('call.systemDefault') }}</q-item-section></q-item>
            <q-item v-for="device in microphones" :key="device.deviceId" v-close-popup clickable :active="room.microphoneDeviceId === device.deviceId" @click="room.selectMicrophone(device.deviceId)"><q-item-section>{{ device.label || $t('call.microphone') }}</q-item-section></q-item>
          </q-list></q-menu></q-btn>
        </div>
        <div class="row items-center">
          <q-btn round :color="speakerMuted ? 'negative' : 'grey-8'" :icon="speakerMuted ? 'volume_off' : 'volume_up'" :aria-label="$t(speakerMuted ? 'call.unmuteSpeaker' : 'call.muteSpeaker')" @click="speakerMuted = !speakerMuted" />
          <q-btn flat dense round icon="expand_more" :aria-label="$t('call.chooseSpeaker')"><q-menu @before-show="refreshDevices"><q-list>
            <q-item v-close-popup clickable @click="speakerId = ''"><q-item-section>{{ $t('call.systemDefault') }}</q-item-section></q-item>
            <template v-if="canSelectSpeaker">
              <q-item v-for="device in speakers" :key="device.deviceId" v-close-popup clickable :active="speakerId === device.deviceId" @click="speakerId = device.deviceId"><q-item-section>{{ device.label || $t('call.speaker') }}</q-item-section></q-item>
              <q-item v-if="canRequestSpeaker" v-close-popup clickable @click="requestSpeaker"><q-item-section>{{ $t('call.chooseSpeaker') }}</q-item-section></q-item>
            </template>
            <q-item v-else><q-item-section>{{ $t('call.speakerUnavailable') }}</q-item-section></q-item>
          </q-list></q-menu></q-btn>
        </div>
        <q-btn round :color="room.cameraMuted ? 'grey-8' : 'primary'" :icon="room.cameraMuted ? 'videocam_off' : 'videocam'" :disable="room.changingMedia || !videoSupported" :aria-label="$t(room.cameraMuted ? 'call.enableCamera' : 'call.disableCamera')" data-testid="room-camera" @click="room.toggleCamera" />
        <q-btn round :color="room.localScreenStream ? 'primary' : 'grey-8'" :icon="room.localScreenStream ? 'stop_screen_share' : 'screen_share'" :disable="!canShareScreen" :aria-label="$t(room.localScreenStream ? 'call.stopScreen' : 'call.shareScreen')" data-testid="room-share-screen" @click="toggleScreen"><q-tooltip>{{ $t(canShareScreen ? 'call.shareScreen' : 'call.screenUnavailable') }}</q-tooltip></q-btn>
        <q-btn round color="grey-8" icon="open_in_new" data-testid="room-open-window" :aria-label="$t('call.presentationWindow')" @click="stage?.openWindow()" />
        <q-btn round color="negative" icon="call_end" :aria-label="$t('room.leave')" data-testid="room-leave" @click="room.leave()" />
      </div>
      <q-btn v-else color="primary" :label="$t('common.close')" data-testid="room-dismiss" @click="room.dismiss" />
    </q-card>
  </q-dialog>
  <div v-if="minimized && room.busy" class="room-compact">
    <q-btn flat icon="groups" :label="$t('room.return')" data-testid="room-restore" @click="minimized = false" />
    <q-btn flat round color="negative" icon="call_end" :aria-label="$t('room.leave')" @click="room.leave()" />
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';
import { useCallRoomStore } from 'src/stores/callRoomStore';
import { callMediaSupported, canShareCallScreen } from 'src/services/callMediaService';
import { ROOM_MAX_MEMBERS } from 'src/types/callRoom';
import { t } from 'src/i18n';
import CallStage from './CallStage.vue';
import CallVideo from './CallVideo.vue';
import CallRoomAudio from './CallRoomAudio.vue';
const $q = useQuasar();
const room = useCallRoomStore();
const stage = ref<InstanceType<typeof CallStage> | null>(null);
const minimized = ref(false);
const outputError = ref('');
const speakerMuted = ref(false);
const speakerId = ref('');
const microphones = ref<MediaDeviceInfo[]>([]);
const speakers = ref<MediaDeviceInfo[]>([]);
const canSelectSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
const outputs = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
const canRequestSpeaker = typeof outputs?.selectAudioOutput === 'function';
const videoSupported = callMediaSupported('video');
const canShareScreen = canShareCallScreen();
const screens = computed(() => [
  ...room.participants.filter((peer) => peer.screenUrl).map((peer) => ({ id: peer.pubkey, name: peer.name, url: peer.screenUrl })),
  ...(room.localScreenStream ? [{ id: 'local', name: t('call.yourScreen'), stream: room.localScreenStream }] : []),
]);
async function copyLink() { try { await copyToClipboard(room.shareLink); $q.notify({ message: t('room.linkCopied'), timeout: 1500 }); } catch { outputError.value = 'room.copyManually'; } }
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    microphones.value = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    speakers.value = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default');
  } catch { /* The running media remains usable when enumeration is unavailable. */ }
}
async function requestSpeaker() { try { const device = await outputs.selectAudioOutput?.(); if (device) speakerId.value = device.deviceId; } catch { outputError.value = 'call.error.speakerPermission'; } }
async function toggleScreen() {
  if (room.localScreenStream) { await room.stopScreenSharing(); return; }
  await room.startScreenSharing();
}
watch(() => room.session?.own.sessionId, () => { minimized.value = false; outputError.value = ''; speakerMuted.value = false; });
watch(() => room.session?.phase, (phase) => { if (phase === 'ended') minimized.value = false; });
onBeforeUnmount(() => room.reset());
</script>
<style scoped>
.room-panel--minimized { visibility: hidden; pointer-events: none; }
.room-panel { width: 100%; height: 100dvh; max-width: 100%; max-height: 100dvh; display: flex; flex-direction: column; overflow: hidden; padding: clamp(8px, 2vw, 20px); padding-bottom: max(8px, env(safe-area-inset-bottom)); background: var(--nc-panel-header-bg); color: var(--nc-text); }
.room-panel > :not(.call-stage) { flex-shrink: 0; }
.room-grid { height: 100%; min-height: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); grid-auto-rows: minmax(0, 1fr); gap: 8px; }
.room-tile { min-width: 0; min-height: 0; background: #101418; color: #fff; border-radius: 12px; overflow: hidden; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.room-tile video, .room-tile canvas { flex: 1; min-height: 0; width: 100%; height: 100%; object-fit: contain; }
.room-tile > div { flex-shrink: 0; width: 100%; padding: 4px 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.room-tile > .q-icon { min-height: 0; max-height: 100%; }
.room-controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 8px 0 0; }
.room-compact, .room-audio-recovery:has(.q-btn) { position: fixed; z-index: 6500; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 12px); background: var(--nc-panel-header-bg); border-radius: 24px; box-shadow: var(--nc-shadow-md); }
.room-audio-recovery:has(.q-btn) { top: auto; bottom: 12px; }
@media (max-width: 599px), (max-height: 500px) {
  .room-controls { gap: 4px; }
  .room-controls :deep(.q-btn--round) { min-width: 32px; min-height: 32px; }
  .room-panel > .q-mb-md { margin-bottom: 4px; }
  .room-panel > .q-my-md { margin-top: 4px; margin-bottom: 4px; }
}
</style>
