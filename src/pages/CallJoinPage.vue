<template>
  <div class="call-lobby">
    <q-card class="call-lobby__card q-pa-lg">
      <div class="text-h5 q-mb-md">{{ $t('room.title') }}</div>
      <p>{{ $t('room.description', { count: ROOM_MAX_MEMBERS }) }}</p>
      <q-input v-model="input" outlined autogrow :label="$t('room.pasteLink')" data-testid="room-join-link" />
      <div v-if="input && !link" role="alert" class="text-negative q-my-sm">{{ $t('room.error.invalidLink') }}</div>
      <div v-if="room.error && !room.session" role="alert" class="text-negative q-my-sm">{{ $t(room.error) }}</div>
      <div class="row q-gutter-sm q-my-md">
        <template v-if="input">
          <q-btn color="positive" icon="call" no-caps :label="$t('room.joinAudio')" :disable="!link || room.busy" data-testid="room-join-audio" @click="join('audio')" />
          <q-btn color="primary" icon="videocam" no-caps :label="$t('room.joinVideo')" :disable="!link || room.busy" data-testid="room-join-video" @click="join('video')" />
        </template>
        <template v-else>
          <q-btn color="positive" icon="call" no-caps :label="$t('room.createAudio')" :disable="room.busy" data-testid="room-create-audio" @click="room.create('audio')" />
          <q-btn color="primary" icon="videocam" no-caps :label="$t('room.createVideo')" :disable="room.busy" data-testid="room-create-video" @click="room.create('video')" />
        </template>
      </div>
      <q-btn flat icon="arrow_back" :label="$t('common.back')" :to="{ name: 'chats' }" />
    </q-card>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useCallRoomStore } from 'src/stores/callRoomStore';
import { parseRoomLink } from 'src/utils/callRoom';
import { ROOM_MAX_MEMBERS } from 'src/types/callRoom';
import type { CallMode } from 'src/types/call';
const route = useRoute();
const router = useRouter();
const room = useCallRoomStore();
const input = ref('');
watch(() => room.session?.phase, (phase) => {
  if (phase === 'active' && route.name === 'join-call') void router.replace({ name: 'chats' });
});
watch(() => route.params.invite, (value) => { input.value = typeof value === 'string' ? value : ''; }, { immediate: true });
const link = computed(() => parseRoomLink(input.value.trim()));
async function join(mode: CallMode) { const parsed = parseRoomLink(input.value.trim()); if (parsed) await room.join(parsed, mode); }
</script>
<style scoped>
.call-lobby { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px; background: var(--nc-page-bg); }
.call-lobby__card { width: min(620px, 100%); background: var(--nc-panel-header-bg); color: var(--nc-text); border-radius: 20px; }
</style>
