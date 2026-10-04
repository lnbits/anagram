<template>
  <div class="room-audio-recovery">
    <CallRoomAudio v-for="peer in room.participants" :key="peer.pubkey + peer.sessionId" :peer="peer.pubkey" :name="participantNames[peer.pubkey] || ''" :url="peer.audioUrl" :muted="speakerMuted" :sink="speakerId" :activity="speakerView" @level="updateLevel(peer.pubkey, $event)" @output-error="outputError = 'call.error.speaker'" />
  </div>
  <q-dialog :model-value="Boolean(room.session)" persistent :seamless="minimized" :maximized="!minimized" :class="{ 'room-dialog--minimized': minimized }">
    <q-card class="room-panel" :class="{ 'room-panel--minimized': minimized, 'room-panel--fill': maxFill }" data-testid="room-panel">
      <div role="status" :class="{ 'room-status--hidden': room.session?.phase === 'active' }" data-testid="room-status">{{ $t(`room.phase.${room.session?.phase || 'preparing'}`) }}</div>
      <CallStage ref="stage" :active="room.busy" :screens="screens" :max-fill="maxFill" @blocked="outputError = 'call.error.popup'">
        <div class="room-grid" :class="{ 'room-grid--fill': maxFill, 'room-grid--sharing': screens.length, 'room-grid--speaker': speakerView && !screens.length && room.participants.length }" :style="{ '--sidebar-count': Math.max(1, room.participants.length), '--gallery-columns': Math.ceil(Math.sqrt(room.participants.length + 1)), '--gallery-rows': Math.ceil((room.participants.length + 1) / Math.ceil(Math.sqrt(room.participants.length + 1))) }">
          <div v-if="room.localStream" class="room-tile" :class="{ 'room-tile--speaker': focusedSpeaker === 'local' }">
            <CallVideo v-if="!room.cameraMuted" :stream="room.localStream" />
            <q-icon v-else name="account_circle" size="64px" />
            <div v-if="ownName" class="room-tile__overlay" :class="{ 'room-tile__overlay--muted': room.microphoneMuted }"><span v-if="ownName" class="room-tile__name">{{ ownName }}</span></div>
            <q-icon v-if="room.microphoneMuted" class="room-tile__mute" name="mic_off" :aria-label="$t('call.microphoneMuted')" role="img" data-testid="room-local-muted" />
          </div>
          <div v-for="peer in room.participants" :key="peer.pubkey + peer.sessionId" class="room-tile" :class="{ 'room-tile--speaker': focusedSpeaker === peer.pubkey }" :data-testid="`room-peer-${peer.pubkey}`">
            <q-icon v-if="peer.microphoneMuted" class="room-tile__mute" name="mic_off" :aria-label="$t('call.microphoneMuted')" role="img" data-testid="room-peer-muted" />
            <CallVideo v-if="peer.videoUrl" :url="peer.videoUrl" />
            <q-icon v-else name="account_circle" size="64px" />
            <div v-if="participantNames[peer.pubkey] || peer.phase !== 'active'" class="room-tile__overlay" :class="{ 'room-tile__overlay--muted': peer.microphoneMuted }"><span v-if="participantNames[peer.pubkey]" class="room-tile__name">{{ participantNames[peer.pubkey] }}</span> <span v-if="peer.phase !== 'active'">{{ $t(peer.phase === 'ended' ? 'call.ended.failed' : 'call.phase.connecting') }}</span></div>
          </div>
        </div>
      </CallStage>
      <div v-if="room.error || outputError" class="text-negative q-pa-sm" role="alert">{{ $t(room.error || outputError) }}</div>
      <CallControlsTray v-if="room.busy" :enabled="room.busy" v-slot="{ autoHide, toggle }">
      <div class="room-controls">
        <q-btn round :color="maxFill ? 'primary' : 'grey-8'" icon="aspect_ratio" :aria-label="$t('call.maxFill')" :aria-pressed="maxFill" data-testid="room-max-fill" @click="maxFill = !maxFill"><q-tooltip>{{ $t(maxFill ? 'call.fitMedia' : 'call.maxFill') }}</q-tooltip></q-btn>
        <q-btn round color="grey-8" :icon="autoHide ? 'visibility' : 'expand_more'" :aria-label="$t(autoHide ? 'call.keepControls' : 'call.hideControls')" data-testid="room-hide-controls" :aria-pressed="autoHide" @click="toggle"><q-tooltip>{{ $t(autoHide ? 'call.keepControls' : 'call.hideControls') }}</q-tooltip></q-btn>
        <q-btn round color="grey-8" :icon="speakerView ? 'grid_view' : 'record_voice_over'" :aria-label="$t(speakerView ? 'room.galleryView' : 'room.speakerView')" data-testid="room-view-toggle" @click="speakerView = !speakerView"><q-tooltip>{{ $t(speakerView ? 'room.galleryView' : 'room.speakerView') }}</q-tooltip></q-btn>
        <q-btn flat round icon="minimize" data-testid="room-minimize" :aria-label="$t('call.minimize')" @click="minimized = true" />
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
        <div class="row items-center">
        <q-btn round :color="room.cameraMuted ? 'grey-8' : 'primary'" :icon="room.cameraMuted ? 'videocam_off' : 'videocam'" :disable="room.changingMedia || !videoSupported" :aria-label="$t(room.cameraMuted ? 'call.enableCamera' : 'call.disableCamera')" data-testid="room-camera" @click="room.toggleCamera" />
          <q-btn flat dense round icon="expand_more" :disable="room.changingMedia || !videoSupported" :aria-label="$t('call.chooseCamera')" data-testid="room-camera-menu"><q-menu @before-show="refreshDevices"><q-list class="call-camera-menu">
            <q-item v-close-popup clickable data-testid="room-camera-default" @click="room.selectCamera('')"><q-item-section>{{ $t('call.systemDefault') }}</q-item-section></q-item>
            <q-item v-for="(device, index) in cameras" :key="device.deviceId" v-close-popup clickable :active="room.cameraDeviceId === device.deviceId" :data-testid="`room-camera-source-${index}`" @click="room.selectCamera(device.deviceId)"><q-item-section>{{ device.label || `${$t('call.camera')} ${index + 1}` }}</q-item-section></q-item>
          </q-list></q-menu></q-btn>
        </div>
        <q-btn round :color="room.localScreenStream ? 'primary' : 'grey-8'" :icon="room.localScreenStream ? 'stop_screen_share' : 'screen_share'" :disable="!canShareScreen" :aria-label="$t(room.localScreenStream ? 'call.stopScreen' : 'call.shareScreen')" data-testid="room-share-screen" @click="toggleScreen"><q-tooltip>{{ $t(canShareScreen ? 'call.shareScreen' : 'call.screenUnavailable') }}</q-tooltip></q-btn>
        <q-btn round color="grey-8" icon="open_in_new" data-testid="room-open-window" :aria-label="$t('call.presentationWindow')" @click="stage?.openWindow()" />
        <q-btn v-if="room.shareLink" round color="grey-8" icon="person_add" :aria-label="$t('room.invite')" data-testid="room-invite" @click="inviteOpen = true"><q-tooltip>{{ $t('room.invite') }}</q-tooltip></q-btn>
        <q-btn round color="negative" icon="call_end" :aria-label="$t('room.leave')" data-testid="room-leave" @click="room.leave()" />
      </div>
      </CallControlsTray>
      <q-btn v-else color="primary" :label="$t('common.close')" data-testid="room-dismiss" @click="room.dismiss" />
    </q-card>
  </q-dialog>
  <q-dialog v-model="inviteOpen">
    <q-card class="room-invite-dialog q-pa-md" data-testid="room-invite-dialog">
      <div class="row items-center justify-between q-mb-md"><div class="text-h6">{{ $t('room.invite') }}</div><q-btn flat round dense icon="close" :aria-label="$t('common.close')" data-testid="room-invite-close" @click="inviteOpen = false" /></div>
      <p>{{ $t('room.inviteHint') }}</p>
      <q-input v-if="showInviteLink" :model-value="room.shareLink" readonly outlined dense :label="$t('room.link')" data-testid="room-link" />
      <div v-else class="text-grey q-py-sm" data-testid="room-link-hidden">{{ $t('room.linkHidden') }}</div>
      <div v-if="inviteError" role="alert" class="text-negative q-py-sm">{{ $t(inviteError) }}</div>
      <div class="row q-gutter-sm q-mt-sm">
        <q-btn color="primary" icon="content_copy" :label="$t('room.copyLink')" data-testid="room-copy-link" @click="copyLink" />
        <q-btn flat :icon="showInviteLink ? 'visibility_off' : 'visibility'" :label="$t(showInviteLink ? 'room.hideLink' : 'room.showLink')" data-testid="room-toggle-link" @click="showInviteLink = !showInviteLink" />
      </div>
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
import { t } from 'src/i18n';
import { contactsService } from 'src/services/contactsService';
import { useNostrStore } from 'src/stores/nostrStore';
import { observeCallActivity } from 'src/services/callActivityService';
import { createActiveSpeakerSelector } from 'src/utils/callActiveSpeaker';
import CallStage from './CallStage.vue';
import CallControlsTray from './CallControlsTray.vue';
import CallVideo from './CallVideo.vue';
import CallRoomAudio from './CallRoomAudio.vue';
const $q = useQuasar();
const room = useCallRoomStore();
const participantNames = ref<Record<string, string>>({});
const ownName = computed(() => participantNames.value[room.session?.own.pubkey || ''] || '');
watch(() => room.session?.members, (members, _, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  participantNames.value = {};
  for (const member of members || []) {
    void (async () => {
      try {
        const contact = await contactsService.getContactByPublicKey(member.pubkey);
        if (!cancelled) participantNames.value[member.pubkey] = contact?.meta.nip05?.trim() || '';
        const profile = await useNostrStore().fetchUserProfileFromRelays(member.pubkey, member.relays);
        if (!cancelled && profile) participantNames.value[member.pubkey] = profile.nip05?.trim() || '';
      } catch { /* Retain a cached NIP-05 identifier when profile relays are unavailable. */ }
    })();
  }
}, { immediate: true });
const stage = ref<InstanceType<typeof CallStage> | null>(null);
const minimized = ref(false);
const maxFill = ref(false);
const speakerView = ref(false);
const activeSpeaker = ref('local');
const levels = new Map<string, number>();
let selectSpeaker = createActiveSpeakerSelector();
function updateLevel(id: string, value: number) {
  levels.set(id, value);
  for (const key of levels.keys()) if (key !== 'local' && !room.participants.some((peer) => peer.pubkey === key)) levels.delete(key);
  activeSpeaker.value = selectSpeaker(levels, performance.now());
}
watch([() => room.localStream, speakerView, () => room.microphoneMuted], ([stream, enabled, muted], _, onCleanup) => {
  updateLevel('local', 0);
  if (stream && enabled && !muted) onCleanup(observeCallActivity(stream, (level) => updateLevel('local', level)));
});
const focusedSpeaker = computed(() => room.participants.some((peer) => peer.pubkey === activeSpeaker.value) ? activeSpeaker.value : 'local');
const outputError = ref('');
const inviteOpen = ref(false);
const showInviteLink = ref(false);
const inviteError = ref('');
const speakerMuted = ref(false);
const speakerId = ref('');
const microphones = ref<MediaDeviceInfo[]>([]);
const cameras = ref<MediaDeviceInfo[]>([]);
const speakers = ref<MediaDeviceInfo[]>([]);
const canSelectSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
const outputs = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
const canRequestSpeaker = typeof outputs?.selectAudioOutput === 'function';
const videoSupported = callMediaSupported('video');
const canShareScreen = canShareCallScreen();
const screens = computed(() => [
  ...room.participants.filter((peer) => peer.screenUrl).map((peer) => ({ id: peer.pubkey, name: participantNames.value[peer.pubkey] || '', url: peer.screenUrl })),
  ...(room.localScreenStream ? [{ id: 'local', name: t('call.yourScreen'), stream: room.localScreenStream }] : []),
]);
async function copyLink() { try { await copyToClipboard(room.shareLink); $q.notify({ message: t('room.linkCopied'), timeout: 1500 }); } catch { inviteError.value = 'room.copyManually'; } }
async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras.value = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    microphones.value = devices.filter((device) => device.kind === 'audioinput' && device.deviceId);
    speakers.value = devices.filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default');
  } catch { /* The running media remains usable when enumeration is unavailable. */ }
}
async function requestSpeaker() { try { const device = await outputs.selectAudioOutput?.(); if (device) speakerId.value = device.deviceId; } catch { outputError.value = 'call.error.speakerPermission'; } }
async function toggleScreen() {
  if (room.localScreenStream) { await room.stopScreenSharing(); return; }
  await room.startScreenSharing();
}
watch(() => room.session?.own.sessionId, () => { minimized.value = false; outputError.value = ''; speakerMuted.value = false; speakerView.value = false; maxFill.value = false; levels.clear(); selectSpeaker = createActiveSpeakerSelector(); activeSpeaker.value = 'local'; });
watch(() => room.session?.phase, (phase) => { if (phase === 'ended') minimized.value = false; });
watch(inviteOpen, () => { showInviteLink.value = false; inviteError.value = ''; });
watch(() => room.busy, (busy) => { if (!busy) inviteOpen.value = false; });
onBeforeUnmount(() => room.reset());
</script>
<style scoped>
.room-invite-dialog { width: min(480px, calc(100vw - 32px)); max-width: 100%; background: var(--nc-panel-header-bg); color: var(--nc-text); }
.call-camera-menu { min-width: 220px; max-width: 320px; }
.room-panel--minimized { visibility: hidden; pointer-events: none; }
.room-panel { width: 100%; height: 100dvh; max-width: 100%; max-height: 100dvh; display: flex; flex-direction: column; overflow: hidden; padding: clamp(8px, 2vw, 20px); padding-bottom: max(8px, env(safe-area-inset-bottom)); background: #000; color: #fff; }
.room-panel > :not(.call-stage) { flex-shrink: 0; }
.room-status--hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.room-grid { height: 100%; min-height: 0; display: grid; grid-template-columns: repeat(var(--gallery-columns), minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); gap: 8px; }
.room-tile { position: relative; min-width: 0; min-height: 0; background: transparent; color: #fff; border-radius: 0; overflow: hidden; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.room-tile video, .room-tile canvas { flex: 1; min-height: 0; width: 100%; height: 100%; object-fit: contain; }
.room-tile__overlay { position: absolute; bottom: 0; left: 0; width: 100%; padding: 12px 8px 4px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.7)); text-align: left; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; pointer-events: none; }
.room-tile__mute { position: absolute; bottom: 6px; left: 6px; z-index: 1; width: 26px; height: 26px; border-radius: 50%; background: rgba(0, 0, 0, 0.65); font-size: 16px; }
.room-tile__overlay--muted { padding-left: 40px; }
.room-tile > .q-icon { min-height: 0; max-height: 100%; }
.room-grid--speaker { position: relative; display: flex; flex-direction: column; align-items: flex-end; }
.room-grid--speaker .room-tile { flex: 0 1 auto; width: calc(25% - 6px); aspect-ratio: 16 / 9; }
.room-grid--speaker .room-tile--speaker { position: absolute; inset: 0 auto 0 0; width: calc(75% - 2px); height: 100%; aspect-ratio: auto; }
@media (max-width: 599px) {
  .room-grid--speaker { display: grid; grid-template-columns: repeat(var(--sidebar-count), minmax(0, 1fr)); grid-template-rows: minmax(0, 3fr) minmax(0, 1fr); }
  .room-grid--speaker .room-tile { width: 100%; aspect-ratio: auto; grid-column: auto; grid-row: 2; }
  .room-grid--speaker .room-tile--speaker { position: static; width: 100%; height: auto; grid-column: 1 / -1; grid-row: 1; }
}
@media (min-width: 600px) {
  .room-grid--sharing { display: flex; flex-direction: column; }
  .room-grid--sharing .room-tile { flex: 0 1 auto; width: 100%; aspect-ratio: 16 / 9; }
}
.room-controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 8px 0 0; }
.room-compact, .room-audio-recovery:has(.q-btn) { position: fixed; z-index: 6500; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 12px); background: var(--nc-panel-header-bg); border-radius: 24px; box-shadow: var(--nc-shadow-md); }
.room-audio-recovery:has(.q-btn) { top: auto; bottom: 12px; }
@media (max-width: 599px), (max-height: 500px) {
  .room-controls { gap: 4px; }
  .room-controls :deep(.q-btn--round) { min-width: 32px; min-height: 32px; }
  .room-panel > .q-mb-md { margin-bottom: 4px; }
  .room-panel > .q-my-md { margin-top: 4px; margin-bottom: 4px; }
}
.room-panel.room-panel--fill { padding: 0; }
.room-panel--fill .room-controls { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
.room-grid--fill { gap: 0; }
.room-grid--fill:not(.room-grid--speaker):not(.room-grid--sharing) { display: flex; flex-wrap: wrap; }
.room-grid--fill:not(.room-grid--speaker):not(.room-grid--sharing) .room-tile { flex: 1 1 calc(100% / var(--gallery-columns)); height: calc(100% / var(--gallery-rows)); }
.room-grid--fill.room-grid--sharing { display: flex; flex-direction: column; }
.room-grid--fill.room-grid--sharing .room-tile { flex: 1 1 0; width: 100%; aspect-ratio: auto; }
@media (min-width: 600px) {
  .room-grid--fill.room-grid--speaker .room-tile { flex: 1 1 0; width: 25%; aspect-ratio: auto; }
  .room-grid--fill.room-grid--speaker .room-tile--speaker { width: 75%; }
}
@media (max-width: 599px) {
  .room-grid--fill.room-grid--sharing { flex-direction: row; }
  .room-grid--fill.room-grid--sharing .room-tile { width: 0; height: 100%; }
}
</style>
