import { callCaptureErrorKey } from 'src/services/callMediaService';
import { CALL_SUPPORT_TIMEOUT_MS, type CallMode } from 'src/types/call';
import {
  type CallRoomLink,
  type CallRoomMember,
  type CallRoomSession,
  type CallRoomSignal,
  ROOM_LIFETIME_MS,
  ROOM_MAX_MEMBERS,
  ROOM_PROTOCOL,
} from 'src/types/callRoom';
import { formatRoomLink } from 'src/utils/callRoom';
import { computed, markRaw, ref, shallowRef, type WatchStopHandle, watch } from 'vue';
import { type CallRuntimeDeps, createCallRuntime } from './callRuntime';

type PeerRuntime = ReturnType<typeof createCallRuntime>;
interface Peer {
  member: CallRoomMember;
  runtime: PeerRuntime;
  stop: WatchStopHandle;
}
interface Deps {
  getOwnPubkey(): string | null;
  getIdentity(): Promise<{ name: string; relays: string[] }>;
  isBlocked(peer: string): boolean;
  otherCallBusy(): boolean;
  send(peer: string, signal: CallRoomSignal, relays: string[]): Promise<void>;
  media: Pick<
    CallRuntimeDeps,
    | 'supported'
    | 'getMedia'
    | 'getCamera'
    | 'getMicrophone'
    | 'getScreen'
    | 'createEndpoint'
    | 'createReceiver'
    | 'record'
    | 'unlockPlayback'
  >;
}
export function createCallRoomRuntime(deps: Deps) {
  const session = shallowRef<CallRoomSession | null>(null);
  const localStream = shallowRef<MediaStream | null>(null);
  const localScreenStream = shallowRef<MediaStream | null>(null);
  const microphoneMuted = ref(false);
  const cameraMuted = ref(true);
  const changingMedia = ref(false);
  const microphoneDeviceId = ref('');
  const cameraDeviceId = ref('');
  const error = ref('');
  const peers = shallowRef<Peer[]>([]);
  const busy = computed(() => Boolean(session.value && session.value.phase !== 'ended'));
  const shareLink = computed(() =>
    session.value?.link.relays.length ? formatRoomLink(session.value.link) : ''
  );
  const participants = computed(() =>
    peers.value.map(({ member, runtime }) => ({
      ...member,
      phase: runtime.session.value?.phase ?? 'connecting',
      error: runtime.error.value,
      audioUrl: runtime.remoteMediaUrl.value,
      videoUrl: runtime.remoteVideoUrl.value,
      screenUrl: runtime.remoteScreenUrl.value,
    }))
  );
  const retiredSessions = new Map<string, number>();
  let generation = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expiration: ReturnType<typeof setTimeout> | undefined;
  let retryJoin: ReturnType<typeof setInterval> | undefined;
  let pending: Array<{ peer: string; signal: CallRoomSignal; at: number }> = [];
  const current = (s: CallRoomSession) =>
    session.value?.link.id === s.link.id &&
    session.value.own.sessionId === s.own.sessionId &&
    busy.value;
  function update(patch: Partial<CallRoomSession>) {
    if (session.value) session.value = { ...session.value, ...patch };
  }
  function send(s: CallRoomSession, member: CallRoomMember, body: Partial<CallRoomSignal>) {
    return deps.send(
      member.pubkey,
      {
        protocol: ROOM_PROTOCOL,
        roomId: s.link.id,
        senderSession: s.own.sessionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        action: 'leave',
        ...body,
      },
      member.relays
    );
  }
  function hostMember(s: CallRoomSession): CallRoomMember {
    return (
      s.members.find((member) => member.pubkey === s.link.host) ?? {
        pubkey: s.link.host,
        sessionId: s.link.id,
        name: '',
        relays: s.link.relays,
      }
    );
  }
  function stopStream(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  }
  function leave(reason = '', notify = true) {
    const s = session.value;
    if (!s || !busy.value) return;
    generation += 1;
    update({ phase: 'ended' });
    error.value = reason;
    clearTimeout(deadline);
    clearTimeout(expiration);
    clearInterval(retryJoin);
    pending = [];
    retiredSessions.clear();
    const oldPeers = peers.value;
    peers.value = [];
    oldPeers.forEach((peer) => {
      peer.stop();
      peer.runtime.reset();
    });
    stopStream(localStream.value);
    stopStream(localScreenStream.value);
    localStream.value = localScreenStream.value = null;
    changingMedia.value = false;
    if (notify) {
      if (s.own.pubkey === s.link.host)
        s.members
          .filter((member) => member.pubkey !== s.own.pubkey)
          .forEach((member) => {
            void send(s, member, { action: 'closed' }).catch(() => {});
          });
      else void send(s, hostMember(s), { action: 'leave' }).catch(() => {});
    }
  }
  function cloneTracks(kind: 'audio' | 'video') {
    const tracks =
      localStream.value
        ?.getTracks()
        .filter((track) => track.kind === kind && track.readyState !== 'ended') ?? [];
    if (!tracks.length) throw new DOMException('Capture device is unavailable', 'NotFoundError');
    return new MediaStream(tracks.map((track) => track.clone()));
  }
  async function broadcastRoster() {
    const s = session.value;
    if (!s || !current(s) || s.own.pubkey !== s.link.host) return;
    await Promise.allSettled(
      s.members
        .filter((member) => member.pubkey !== s.own.pubkey)
        .map((member) =>
          send(s, member, { action: 'roster', revision: s.revision, members: s.members })
        )
    );
  }
  function removeMember(pubkey: string) {
    const s = session.value;
    if (
      !s ||
      !current(s) ||
      s.own.pubkey !== s.link.host ||
      pubkey === s.own.pubkey ||
      !s.members.some((member) => member.pubkey === pubkey)
    )
      return;
    const departed = s.members.find((member) => member.pubkey === pubkey);
    if (departed) retiredSessions.set(departed.sessionId, Date.now() + 70_000);
    update({
      members: s.members.filter((member) => member.pubkey !== pubkey),
      revision: s.revision + 1,
    });
    syncPeers();
    void broadcastRoster();
  }
  function syncPeers() {
    const s = session.value;
    if (!s || !current(s)) return;
    const retained = peers.value.filter((peer) =>
      s.members.some(
        (member) =>
          member.pubkey === peer.member.pubkey && member.sessionId === peer.member.sessionId
      )
    );
    const removed = peers.value.filter((peer) => !retained.includes(peer));
    peers.value = retained;
    removed.forEach((peer) => {
      peer.stop();
      peer.runtime.reset();
    });
    for (const member of s.members) {
      if (
        member.pubkey === s.own.pubkey ||
        deps.isBlocked(member.pubkey) ||
        peers.value.some((peer) => peer.member.pubkey === member.pubkey)
      )
        continue;
      const runtime = markRaw(
        createCallRuntime({
          ...deps.media,
          getOwnPubkey: deps.getOwnPubkey,
          resolvePeer: async (pubkey) =>
            current(s) &&
            !deps.isBlocked(pubkey) &&
            session.value?.members.some(
              (entry) => entry.pubkey === pubkey && entry.sessionId === member.sessionId
            )
              ? { name: member.name }
              : null,
          sendSignal: async (pubkey, signal) => {
            if (!current(s)) return;
            await send(
              s,
              { ...member, pubkey },
              { action: 'signal', signal, recipientSession: member.sessionId }
            );
          },
          getMedia: async () => cloneTracks('audio'),
          getMicrophone: async () => cloneTracks('audio'),
          getCamera: async () => cloneTracks('video'),
          getScreen: async () => {
            if (!localScreenStream.value) throw new Error('No active screen share');
            return localScreenStream.value.clone();
          },
        })
      );
      const peer: Peer = { member, runtime, stop: () => {} };
      peers.value = [...peers.value, peer];
      peer.stop = watch(
        () => runtime.session.value?.phase,
        async (phase) => {
          if (!current(s) || !peers.value.includes(peer)) return;
          if (phase === 'incoming') {
            await runtime.accept('audio');
          }
          if (phase === 'active') {
            if (runtime.session.value?.microphoneMuted !== microphoneMuted.value)
              runtime.toggleMicrophone();
            if (!cameraMuted.value && runtime.session.value?.cameraMuted)
              await runtime.toggleCamera();
            if (current(s) && localScreenStream.value) await runtime.startScreenSharing();
          }
          if (phase === 'ended') {
            if (s.own.pubkey === s.link.host) removeMember(member.pubkey);
            else if (member.pubkey === s.link.host) leave('room.error.hostLeft', false);
          }
        }
      );
      if (s.own.pubkey < member.pubkey) void runtime.start(member.pubkey, 'audio');
    }
    const buffered = pending;
    pending = [];
    for (const item of buffered)
      if (Date.now() - item.at < 10_000) void receive(item.peer, item.signal);
  }
  async function begin(mode: CallMode, link?: CallRoomLink) {
    if (busy.value) return;
    if (deps.otherCallBusy()) {
      error.value = 'room.error.busy';
      return;
    }
    if (!deps.media.supported(mode)) {
      error.value = 'call.error.unsupported';
      return;
    }
    const own = deps.getOwnPubkey();
    if (!own || (link && own === link.host)) {
      error.value = 'room.error.ended';
      return;
    }
    deps.media.unlockPlayback?.();
    const version = ++generation;
    const id = crypto.randomUUID();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const roomLink = link ?? {
      id,
      host: own,
      secret,
      expiresAt: new Date(Date.now() + ROOM_LIFETIME_MS).toISOString(),
      relays: [],
    };
    session.value = {
      link: roomLink,
      own: { pubkey: own, sessionId: id, name: own.slice(0, 12), relays: [] },
      phase: 'preparing',
      members: [],
      revision: 0,
    };
    microphoneMuted.value = false;
    cameraMuted.value = mode === 'audio';
    error.value = '';
    deadline = setTimeout(() => leave('room.error.timeout'), 60_000);
    try {
      const media = await deps.media.getMedia(mode, microphoneDeviceId.value);
      if (generation !== version || !busy.value) {
        stopStream(media);
        return;
      }
      localStream.value = media;
      microphoneDeviceId.value = media.getAudioTracks()[0]?.getSettings().deviceId ?? '';
      if (media.getVideoTracks().length)
        cameraDeviceId.value = media.getVideoTracks()[0]?.getSettings().deviceId ?? '';
      media.getTracks().forEach((track) => {
        track.onended = () => leave('call.error.deviceMissing');
      });
      const identity = await deps.getIdentity();
      if (generation !== version || !busy.value) return;
      const self: CallRoomMember = {
        pubkey: own,
        sessionId: id,
        name: identity.name.slice(0, 80) || own.slice(0, 12),
        relays: identity.relays.slice(0, 8),
      };
      if (!self.relays.length) throw new Error('No inbox relays');
      clearTimeout(deadline);
      expiration = setTimeout(
        () => leave('room.error.ended'),
        Math.max(1, Date.parse(roomLink.expiresAt) - Date.now())
      );
      if (!link) {
        update({
          own: self,
          link: { ...roomLink, relays: self.relays },
          phase: 'active',
          members: [self],
          revision: 1,
        });
      } else {
        update({ own: self, phase: 'joining' });
        const joining = session.value;
        if (!joining) return;
        const request = () =>
          send(joining, hostMember(joining), { action: 'join', member: self, secret: link.secret });
        deadline = setTimeout(() => leave('room.error.timeout'), 30_000);
        retryJoin = setInterval(() => {
          if (current(joining) && session.value?.phase === 'joining')
            void request().catch(() => {});
        }, 5000);
        await request();
        if (current(joining) && session.value?.phase === 'joining') {
          clearTimeout(deadline);
          deadline = setTimeout(() => leave('room.error.timeout'), CALL_SUPPORT_TIMEOUT_MS);
        }
      }
    } catch (cause) {
      if (generation === version && busy.value)
        leave(cause instanceof DOMException ? callCaptureErrorKey(cause) : 'room.error.failed');
    }
  }
  async function receive(pubkey: string, signal: CallRoomSignal) {
    const s = session.value;
    if (
      !s ||
      !current(s) ||
      signal.roomId !== s.link.id ||
      pubkey === s.own.pubkey ||
      deps.isBlocked(pubkey) ||
      Date.parse(signal.expiresAt) <= Date.now()
    )
      return;
    if (signal.action === 'join') {
      if (
        s.own.pubkey !== s.link.host ||
        s.phase !== 'active' ||
        signal.secret !== s.link.secret ||
        signal.member?.pubkey !== pubkey ||
        signal.member.sessionId !== signal.senderSession
      )
        return;
      for (const [id, expiry] of retiredSessions)
        if (expiry <= Date.now()) retiredSessions.delete(id);
      if (retiredSessions.has(signal.senderSession)) return;
      const existing = s.members.find((member) => member.pubkey === pubkey);
      if ((!existing && s.members.length >= ROOM_MAX_MEMBERS) || retiredSessions.size >= 256) {
        await send(s, signal.member, { action: 'rejected', reason: 'full' }).catch(() => {});
        return;
      }
      if (existing?.sessionId === signal.member.sessionId) {
        await send(s, signal.member, {
          action: 'roster',
          members: s.members,
          revision: s.revision,
        }).catch(() => {});
        return;
      }
      if (existing) retiredSessions.set(existing.sessionId, Date.now() + 70_000);
      update({
        members: [...s.members.filter((member) => member.pubkey !== pubkey), signal.member],
        revision: s.revision + 1,
      });
      // Publish authority before starting pair negotiations. Receivers also buffer reordering.
      const publishing = broadcastRoster();
      syncPeers();
      await publishing;
      return;
    }
    if (signal.action === 'roster') {
      if (
        pubkey !== s.link.host ||
        signal.senderSession !== s.link.id ||
        !signal.members ||
        !signal.revision ||
        signal.revision <= s.revision ||
        !signal.members.some(
          (member) => member.pubkey === s.link.host && member.sessionId === s.link.id
        )
      )
        return;
      if (
        !signal.members.some(
          (member) => member.pubkey === s.own.pubkey && member.sessionId === s.own.sessionId
        )
      ) {
        leave('room.error.ended', false);
        return;
      }
      clearTimeout(deadline);
      clearInterval(retryJoin);
      update({ phase: 'active', members: signal.members, revision: signal.revision });
      syncPeers();
      return;
    }
    if (
      (signal.action === 'closed' || signal.action === 'rejected') &&
      pubkey === s.link.host &&
      signal.senderSession === s.link.id
    ) {
      leave(signal.reason === 'full' ? 'room.error.full' : 'room.error.hostLeft', false);
      return;
    }
    const member = s.members.find(
      (item) => item.pubkey === pubkey && item.sessionId === signal.senderSession
    );
    if (signal.action === 'leave' && member && s.own.pubkey === s.link.host) {
      removeMember(pubkey);
      return;
    }
    if (signal.action !== 'signal' || !signal.signal || signal.recipientSession !== s.own.sessionId)
      return;
    const peer = peers.value.find((item) => item.member.pubkey === pubkey);
    if (!member || !peer) {
      pending = pending.filter((item) => Date.now() - item.at < 10_000).slice(-15);
      pending.push({ peer: pubkey, signal, at: Date.now() });
      return;
    }
    if (signal.signal.action === 'invite' && pubkey > s.own.pubkey) return;
    await peer.runtime.receiveSignal(pubkey, signal.signal);
  }
  function toggleMicrophone() {
    if (!busy.value || !localStream.value) return;
    microphoneMuted.value = !microphoneMuted.value;
    localStream.value.getAudioTracks().forEach((track) => {
      track.enabled = !microphoneMuted.value;
    });
    peers.value.forEach(({ runtime }) => {
      if (runtime.session.value?.microphoneMuted !== microphoneMuted.value)
        runtime.toggleMicrophone();
    });
  }
  async function selectCamera(deviceId: string) {
    if (!busy.value || !localStream.value || changingMedia.value) return;
    if (cameraMuted.value) {
      cameraDeviceId.value = deviceId;
      return;
    }
    await updateCamera(deviceId);
  }
  async function toggleCamera() {
    await updateCamera();
  }
  async function updateCamera(deviceId?: string) {
    const s = session.value;
    if (!s || !current(s) || !localStream.value || changingMedia.value) return;
    changingMedia.value = true;
    error.value = '';
    let camera: MediaStream | undefined;
    try {
      if (cameraMuted.value || deviceId !== undefined) {
        camera = await deps.media.getCamera?.(deviceId ?? cameraDeviceId.value);
        if (!current(s)) {
          stopStream(camera);
          return;
        }
        if (!camera?.getVideoTracks().length)
          throw new DOMException('No camera track', 'NotFoundError');
        const previous = localStream.value.getVideoTracks();
        localStream.value = new MediaStream([
          ...localStream.value.getAudioTracks(),
          ...camera.getVideoTracks(),
        ]);
        cameraDeviceId.value =
          camera.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? cameraDeviceId.value;
        cameraMuted.value = false;
        previous.forEach((track) => {
          track.onended = null;
          track.stop();
        });
      } else {
        localStream.value.getVideoTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        localStream.value = new MediaStream(localStream.value.getAudioTracks());
        cameraMuted.value = true;
      }
      await Promise.all(
        peers.value.map(({ runtime }) =>
          runtime.session.value?.phase !== 'active'
            ? undefined
            : runtime.session.value.cameraMuted !== cameraMuted.value
              ? runtime.toggleCamera()
              : deviceId !== undefined && !cameraMuted.value
                ? runtime.selectCamera(deviceId)
                : undefined
        )
      );
    } catch (cause) {
      camera?.getTracks().forEach((track) => {
        if (!localStream.value?.getTracks().includes(track)) track.stop();
      });
      if (current(s)) error.value = callCaptureErrorKey(cause);
    } finally {
      if (current(s)) changingMedia.value = false;
    }
  }
  async function selectMicrophone(deviceId: string) {
    const s = session.value;
    if (!s || !current(s) || !localStream.value || changingMedia.value) return;
    changingMedia.value = true;
    error.value = '';
    try {
      const microphone = await deps.media.getMicrophone?.(deviceId);
      if (!current(s)) {
        stopStream(microphone);
        return;
      }
      const previous = localStream.value.getAudioTracks();
      microphone.getAudioTracks().forEach((track) => {
        track.enabled = !microphoneMuted.value;
        track.onended = () => leave('call.error.deviceMissing');
      });
      localStream.value = new MediaStream([
        ...microphone.getAudioTracks(),
        ...localStream.value.getVideoTracks(),
      ]);
      microphoneDeviceId.value = microphone.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId;
      await Promise.all(peers.value.map(({ runtime }) => runtime.selectMicrophone(deviceId)));
      previous.forEach((track) => {
        track.onended = null;
        track.stop();
      });
    } catch (cause) {
      if (current(s)) error.value = callCaptureErrorKey(cause);
    } finally {
      if (current(s)) changingMedia.value = false;
    }
  }
  async function stopScreenSharing() {
    stopStream(localScreenStream.value);
    localScreenStream.value = null;
    await Promise.all(peers.value.map(({ runtime }) => runtime.stopScreenSharing()));
  }
  let acquiringScreen = false;
  async function startScreenSharing() {
    const s = session.value;
    if (!s || !current(s) || localScreenStream.value || acquiringScreen || !deps.media.getScreen)
      return;
    acquiringScreen = true;
    try {
      const screen = await deps.media.getScreen();
      if (!current(s)) {
        stopStream(screen);
        return;
      }
      localScreenStream.value = screen;
      screen.getTracks().forEach((track) => {
        track.onended = () => {
          void stopScreenSharing();
        };
      });
      await Promise.all(peers.value.map(({ runtime }) => runtime.startScreenSharing()));
    } catch {
      if (current(s)) error.value = 'call.error.screen';
    } finally {
      acquiringScreen = false;
    }
  }
  function reset() {
    leave();
    session.value = null;
    error.value = '';
  }
  function dismiss() {
    if (!busy.value) {
      session.value = null;
      error.value = '';
    }
  }
  return {
    session,
    localStream,
    localScreenStream,
    microphoneMuted,
    cameraMuted,
    microphoneDeviceId,
    cameraDeviceId,
    changingMedia,
    busy,
    shareLink,
    participants,
    error,
    create: (mode: CallMode = 'audio') => begin(mode),
    join: (link: CallRoomLink, mode: CallMode = 'audio') => begin(mode, link),
    receive,
    leave,
    reset,
    dismiss,
    toggleMicrophone,
    toggleCamera,
    selectCamera,
    selectMicrophone,
    startScreenSharing,
    stopScreenSharing,
  };
}
