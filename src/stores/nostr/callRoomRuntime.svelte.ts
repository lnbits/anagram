import { callCaptureTrack, cloneCallTrack } from '#src/services/callSharedCapture.ts';
import { roomVideoProfile } from '#src/services/callVideoProfile.ts';
import { toStore } from 'svelte/store';
import { untrack } from 'svelte';
import { callCaptureErrorKey } from '#src/services/callMediaService.ts';
import { CALL_SUPPORT_TIMEOUT_MS, type CallMode } from '#src/types/call.ts';
import {
  type CallRoomLink,
  type CallRoomMember,
  type CallRoomSession,
  type CallRoomSignal,
  ROOM_LIFETIME_MS,
  ROOM_MAX_MEMBERS,
  ROOM_PROTOCOL,
} from '#src/types/callRoom.ts';
import { formatRoomLink } from '#src/utils/callRoom.ts';

import { type CallRuntimeDeps, createCallRuntime } from './callRuntime.svelte.ts';

type PeerRuntime = ReturnType<typeof createCallRuntime>;
interface Peer {
  started?: boolean;
  member: CallRoomMember;
  runtime: PeerRuntime;
  stop: () => void;
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
    | 'acquireAudioRoute'
    | 'preparePacketAudio'
    | 'packetVideoSupported'
  >;
}
export function createCallRoomRuntime(deps: Deps) {
  let releasePacketAudio: (() => void) | undefined;
  let releaseAudioRoute: (() => void) | undefined;
  let session = $state.raw<CallRoomSession | null>(null);
  let localStream = $state.raw<MediaStream | null>(null);
  let localScreenStream = $state.raw<MediaStream | null>(null);
  let microphoneMuted = $state(false);
  let cameraMuted = $state(true);
  let changingMedia = $state(false);
  let microphoneDeviceId = $state('');
  let cameraDeviceId = $state('');
  let error = $state('');
  let qualityTimer: ReturnType<typeof setTimeout> | undefined;
  async function refreshRoomVideoQuality() {
    const profile = roomVideoProfile(session?.members.length ?? 2, Boolean(localScreenStream));
    await Promise.all([
      ...(localStream?.getVideoTracks() ?? []).map((track) =>
        track
          .applyConstraints?.({
            width: { ideal: profile.cameraWidth, max: profile.cameraWidth },
            height: { ideal: profile.cameraHeight, max: profile.cameraHeight },
            frameRate: { ideal: profile.cameraFrameRate, max: profile.cameraFrameRate },
          })
          .catch(() => {}),
      ),
      ...(localScreenStream?.getVideoTracks() ?? []).map((track) =>
        track
          .applyConstraints?.({
            width: { ideal: profile.screenWidth, max: profile.screenWidth },
            height: { ideal: profile.screenHeight, max: profile.screenHeight },
            frameRate: { ideal: profile.screenFrameRate, max: profile.screenFrameRate },
          })
          .catch(() => {}),
      ),
    ]);
    await Promise.all(peers.map(({ runtime }) => runtime.refreshVideoQuality()));
  }
  let peers = $state.raw<Peer[]>([]);
  let busy = $derived.by(() => Boolean(session && session.phase !== 'ended'));
  let shareLink = $derived.by(() =>
    session?.link.relays.length ? formatRoomLink(session.link) : '',
  );
  let participants = $derived.by(() =>
    peers.map(({ member, runtime }) => ({
      ...member,
      phase: runtime.session?.phase ?? 'connecting',
      microphoneMuted: runtime.session?.remoteMicrophoneMuted === true,
      error: runtime.error,
      deviceError: runtime.deviceError,
      audioUrl: runtime.remoteMediaUrl,
      videoUrl: runtime.remoteVideoUrl,
      screenUrl: runtime.remoteScreenUrl,
    })),
  );
  const retiredSessions = new Map<string, number>();
  let generation = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expiration: ReturnType<typeof setTimeout> | undefined;
  let retryJoin: ReturnType<typeof setInterval> | undefined;
  let pending: Array<{ peer: string; signal: CallRoomSignal; at: number }> = [];
  const current = (s: CallRoomSession) =>
    session?.link.id === s.link.id && session.own.sessionId === s.own.sessionId && busy;
  function update(patch: Partial<CallRoomSession>) {
    if (session) session = { ...session, ...patch };
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
      member.relays,
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
    const s = session;
    if (!s || !busy) return;
    generation += 1;
    screenRequest = undefined;
    update({ phase: 'ended' });
    error = reason;
    clearTimeout(deadline);
    clearTimeout(expiration);
    clearInterval(retryJoin);
    pending = [];
    retiredSessions.clear();
    const oldPeers = peers;
    clearTimeout(qualityTimer);
    peers = [];
    oldPeers.forEach((peer) => {
      peer.stop();
      peer.runtime.reset();
    });
    stopStream(localStream);
    stopStream(localScreenStream);
    localStream = localScreenStream = null;
    releaseAudioRoute?.();
    releaseAudioRoute = undefined;
    releasePacketAudio?.();
    releasePacketAudio = undefined;
    changingMedia = false;
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
      localStream
        ?.getTracks()
        .filter((track) => track.kind === kind && track.readyState !== 'ended') ?? [];
    if (!tracks.length) throw new DOMException('Capture device is unavailable', 'NotFoundError');
    return new MediaStream(tracks.map(cloneCallTrack));
  }
  async function broadcastRoster() {
    const s = session;
    if (!s || !current(s) || s.own.pubkey !== s.link.host) return;
    await Promise.allSettled(
      s.members
        .filter((member) => member.pubkey !== s.own.pubkey)
        .map((member) =>
          send(s, member, { action: 'roster', revision: s.revision, members: s.members }),
        ),
    );
  }
  function removeMember(pubkey: string) {
    const s = session;
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
    const s = session;
    if (!s || !current(s)) return;
    const retained = peers.filter((peer) =>
      s.members.some(
        (member) =>
          member.pubkey === peer.member.pubkey && member.sessionId === peer.member.sessionId,
      ),
    );
    const removed = peers.filter((peer) => !retained.includes(peer));
    // Refresh labels without replacing peer objects or restarting media runtimes.
    for (const peer of retained) {
      peer.member = s.members.find(
        (member) =>
          member.pubkey === peer.member.pubkey && member.sessionId === peer.member.sessionId,
      )!;
    }
    peers = retained;
    removed.forEach((peer) => {
      peer.stop();
      peer.runtime.reset();
    });
    for (const member of s.members) {
      if (
        member.pubkey === s.own.pubkey ||
        deps.isBlocked(member.pubkey) ||
        peers.some((peer) => peer.member.pubkey === member.pubkey)
      )
        continue;
      const runtime = createCallRuntime({
        ...deps.media,
        // The room owns routing once; peer reconnects must not acquire/reset it.
        acquireAudioRoute: undefined,
        videoProfile: () =>
          roomVideoProfile(session?.members.length ?? 2, Boolean(localScreenStream)),
        // A quality refresh, deferred or not, blocks camera changes; reapply any it skipped.
        onVideoQualityRefreshed: () => {
          if (current(s) && peers.includes(peer)) void syncPeerMedia(runtime);
        },
        getOwnPubkey: deps.getOwnPubkey,
        resolvePeer: async (pubkey) =>
          current(s) &&
          !deps.isBlocked(pubkey) &&
          session?.members.some(
            (entry) => entry.pubkey === pubkey && entry.sessionId === member.sessionId,
          )
            ? { name: member.name }
            : null,
        sendSignal: async (pubkey, signal) => {
          if (!current(s)) return;
          await send(
            s,
            { ...member, pubkey },
            { action: 'signal', signal, recipientSession: member.sessionId },
          );
        },
        getMedia: async () => cloneTracks('audio'),
        getMicrophone: async () => cloneTracks('audio'),
        getCamera: async () => cloneTracks('video'),
        getScreen: async () => {
          if (!localScreenStream) throw new Error('No active screen share');
          return new MediaStream(localScreenStream.getTracks().map(cloneCallTrack));
        },
      });
      const peer: Peer = { member, runtime, stop: () => {} };
      peers = [...peers, peer];
      peer.stop = toStore(() => runtime.session?.phase).subscribe((phase) => {
        void untrack(async () => {
          if (!current(s) || !peers.includes(peer)) return;
          if (phase === 'incoming') {
            await runtime.accept('audio');
          }
          if (phase === 'active') {
            // Every (re)activation applies controls changed while the link was down.
            await syncPeerMedia(runtime);
            if (!peer.started) {
              peer.started = true;
              if (current(s) && localScreenStream) await runtime.startScreenSharing();
            }
          }
          if (phase === 'ended') {
            if (s.own.pubkey === s.link.host) removeMember(member.pubkey);
            else if (member.pubkey === s.link.host) leave('room.error.hostLeft', false);
          }
        });
      });
      if (s.own.pubkey < member.pubkey) void runtime.start(member.pubkey, 'audio');
    }
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => {
      void refreshRoomVideoQuality();
    }, 150);
    const buffered = pending;
    pending = [];
    for (const item of buffered)
      if (Date.now() - item.at < 10_000) void receive(item.peer, item.signal);
  }
  let nameRequest = 0;
  async function updateName(value: string) {
    const s = session;
    if (!s || s.phase !== 'active') return;
    const request = ++nameRequest;
    const name = (
      value.trim() ||
      (await deps.getIdentity()).name.trim() ||
      s.own.pubkey.slice(0, 12)
    ).slice(0, 80);
    if (!current(s) || request !== nameRequest) return;
    const latest = session!;
    const own =
      name === latest.own.name
        ? latest.own
        : {
            ...latest.own,
            name,
            nameRevision: (latest.own.nameRevision ?? 0) + 1,
          };
    const host = latest.own.pubkey === latest.link.host;
    update({
      own,
      members: latest.members.map((member) => (member.pubkey === own.pubkey ? own : member)),
      revision: host && own !== latest.own ? latest.revision + 1 : latest.revision,
    });
    if (host) await broadcastRoster();
    else
      await send(session!, hostMember(latest), {
        action: 'join',
        member: own,
        secret: latest.link.secret,
      });
  }
  async function begin(mode: CallMode, link?: CallRoomLink) {
    if (busy) return;
    if (deps.otherCallBusy()) {
      error = 'room.error.busy';
      return;
    }
    if (!deps.media.supported(mode)) {
      error = 'call.error.unsupported';
      return;
    }
    const own = deps.getOwnPubkey();
    if (!own || (link && own === link.host)) {
      error = 'room.error.ended';
      return;
    }
    deps.media.unlockPlayback?.();
    const version = ++generation;
    const id = crypto.randomUUID();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const roomLink = link ?? {
      id,
      host: own,
      secret,
      expiresAt: new Date(Date.now() + ROOM_LIFETIME_MS).toISOString(),
      relays: [],
    };
    session = {
      link: roomLink,
      own: { pubkey: own, sessionId: id, name: own.slice(0, 12), relays: [] },
      phase: 'preparing',
      members: [],
      revision: 0,
    };
    microphoneMuted = false;
    cameraMuted = mode === 'audio';
    error = '';
    deadline = setTimeout(() => leave('room.error.timeout'), 60_000);
    const packetPreparation = (deps.media.preparePacketAudio?.() ?? Promise.resolve(undefined))
      .then((release) => {
        if (generation === version && busy) releasePacketAudio = release;
        else release?.();
      })
      .catch(() => {});
    try {
      const media = await deps.media.getMedia(mode, microphoneDeviceId);
      if (generation !== version || !busy) {
        stopStream(media);
        return;
      }
      localStream = media;
      if (deps.media.acquireAudioRoute) {
        const release = await deps.media.acquireAudioRoute();
        if (generation !== version || !busy) {
          release();
          return;
        }
        releaseAudioRoute = release;
      }
      microphoneDeviceId = media.getAudioTracks()[0]?.getSettings().deviceId ?? '';
      if (media.getVideoTracks().length)
        cameraDeviceId = media.getVideoTracks()[0]?.getSettings().deviceId ?? '';
      media.getTracks().forEach((track) => {
        track.onended = () => {
          if (track.kind === 'video') {
            if (!cameraMuted) void updateCamera();
          } else leave('call.error.deviceMissing');
        };
      });
      await packetPreparation;
      const identity = await deps.getIdentity();
      if (generation !== version || !busy) return;
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
        Math.max(1, Date.parse(roomLink.expiresAt) - Date.now()),
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
        const joining = session;
        if (!joining) return;
        const request = () =>
          send(joining, hostMember(joining), {
            action: 'join',
            member: self,
            secret: link.secret,
          });
        deadline = setTimeout(() => leave('room.error.timeout'), 30_000);
        retryJoin = setInterval(() => {
          if (current(joining) && session?.phase === 'joining') void request().catch(() => {});
        }, 5000);
        await request();
        if (current(joining) && session?.phase === 'joining') {
          clearTimeout(deadline);
          deadline = setTimeout(() => leave('room.error.timeout'), CALL_SUPPORT_TIMEOUT_MS);
        }
      }
    } catch (cause) {
      if (generation === version && busy)
        leave(cause instanceof DOMException ? callCaptureErrorKey(cause) : 'room.error.failed');
    }
  }
  async function receive(pubkey: string, signal: CallRoomSignal) {
    const s = session;
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
        if ((signal.member.nameRevision ?? 0) > (existing.nameRevision ?? 0)) {
          const renamed = {
            ...existing,
            name: signal.member.name,
            nameRevision: signal.member.nameRevision,
          };
          update({
            members: s.members.map((member) => (member.pubkey === pubkey ? renamed : member)),
            revision: s.revision + 1,
          });
          syncPeers();
          await broadcastRoster();
          return;
        }
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
          (member) => member.pubkey === s.link.host && member.sessionId === s.link.id,
        )
      )
        return;
      if (
        !signal.members.some(
          (member) => member.pubkey === s.own.pubkey && member.sessionId === s.own.sessionId,
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
      (item) => item.pubkey === pubkey && item.sessionId === signal.senderSession,
    );
    if (signal.action === 'leave' && member && s.own.pubkey === s.link.host) {
      removeMember(pubkey);
      return;
    }
    if (signal.action !== 'signal' || !signal.signal || signal.recipientSession !== s.own.sessionId)
      return;
    const peer = peers.find((item) => item.member.pubkey === pubkey);
    if (!member || !peer) {
      pending = pending.filter((item) => Date.now() - item.at < 10_000).slice(-15);
      pending.push({ peer: pubkey, signal, at: Date.now() });
      return;
    }
    if (signal.signal.action === 'invite' && pubkey > s.own.pubkey) return;
    await peer.runtime.receiveSignal(pubkey, signal.signal);
  }
  function toggleMicrophone() {
    if (!busy || !localStream) return;
    microphoneMuted = !microphoneMuted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !microphoneMuted;
    });
    peers.forEach(({ runtime }) => {
      if (runtime.session?.microphoneMuted !== microphoneMuted) runtime.toggleMicrophone();
    });
  }
  // Idempotent: align one peer link with the room's microphone and camera controls.
  // A busy link skips changes, so re-check after each awaited one; whoever made the
  // link busy syncs it again when done.
  async function syncPeerMedia(runtime: PeerRuntime) {
    const stale = (kind: 'audio' | 'video') =>
      runtime.localStream
        ?.getTracks()
        .some(
          (track) =>
            track.kind === kind && !localStream?.getTracks().includes(callCaptureTrack(track)),
        );
    for (let pass = 0; pass < 3; pass++) {
      const media = runtime.session;
      if (!media || !localStream) return;
      if (media.microphoneMuted !== microphoneMuted) runtime.toggleMicrophone();
      if (stale('audio')) await runtime.selectMicrophone(microphoneDeviceId);
      else if (media.cameraMuted !== cameraMuted) await runtime.toggleCamera();
      else if (!cameraMuted && stale('video')) await runtime.selectCamera(cameraDeviceId);
      else return;
    }
  }
  async function selectCamera(deviceId: string) {
    if (!busy || !localStream || changingMedia) return;
    if (cameraMuted) {
      cameraDeviceId = deviceId;
      return;
    }
    await updateCamera(deviceId);
  }
  async function toggleCamera() {
    await updateCamera();
  }
  async function updateCamera(deviceId?: string) {
    const s = session;
    if (!s || !current(s) || !localStream || changingMedia) return;
    changingMedia = true;
    error = '';
    let camera: MediaStream | undefined;
    try {
      if (cameraMuted || deviceId !== undefined) {
        camera = await deps.media.getCamera?.(deviceId ?? cameraDeviceId);
        if (!current(s)) {
          stopStream(camera);
          return;
        }
        if (!camera?.getVideoTracks().length)
          throw new DOMException('No camera track', 'NotFoundError');
        const previous = localStream.getVideoTracks();
        localStream = new MediaStream([
          ...localStream.getAudioTracks(),
          ...camera.getVideoTracks(),
        ]);
        cameraDeviceId =
          camera.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? cameraDeviceId;
        cameraMuted = false;
        await refreshRoomVideoQuality();
        previous.forEach((track) => {
          track.onended = null;
          track.stop();
        });
      } else {
        localStream.getVideoTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        localStream = new MediaStream(localStream.getAudioTracks());
        cameraMuted = true;
      }
      await Promise.all(
        peers.map(({ runtime }) =>
          !runtime.session
            ? undefined
            : runtime.session.phase !== 'active'
              ? // A link that is down drops its camera clone now; reactivation recaptures.
                runtime.session.cameraMuted
                ? undefined
                : runtime.toggleCamera()
              : runtime.session.cameraMuted !== cameraMuted
                ? runtime.toggleCamera()
                : deviceId !== undefined && !cameraMuted
                  ? runtime.selectCamera(deviceId)
                  : undefined,
        ),
      );
      await Promise.all(peers.map(({ runtime }) => syncPeerMedia(runtime)));
    } catch (cause) {
      camera?.getTracks().forEach((track) => {
        if (!localStream?.getTracks().includes(track)) track.stop();
      });
      if (current(s)) error = callCaptureErrorKey(cause);
    } finally {
      if (current(s)) changingMedia = false;
    }
  }
  async function selectMicrophone(deviceId: string) {
    const s = session;
    if (!s || !current(s) || !localStream || changingMedia) return;
    changingMedia = true;
    error = '';
    try {
      const microphone = await deps.media.getMicrophone?.(deviceId);
      if (!current(s)) {
        stopStream(microphone);
        return;
      }
      const previous = localStream.getAudioTracks();
      microphone.getAudioTracks().forEach((track) => {
        track.enabled = !microphoneMuted;
        track.onended = () => leave('call.error.deviceMissing');
      });
      localStream = new MediaStream([
        ...microphone.getAudioTracks(),
        ...localStream.getVideoTracks(),
      ]);
      microphoneDeviceId = microphone.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId;
      await Promise.all(peers.map(({ runtime }) => runtime.selectMicrophone(deviceId)));
      previous.forEach((track) => {
        track.onended = null;
        track.stop();
      });
      await Promise.all(peers.map(({ runtime }) => syncPeerMedia(runtime)));
    } catch (cause) {
      if (current(s)) error = callCaptureErrorKey(cause);
    } finally {
      if (current(s)) changingMedia = false;
    }
  }
  let screenRequest: object | undefined;
  async function stopScreenSharing() {
    screenRequest = undefined;
    stopStream(localScreenStream);
    localScreenStream = null;
    await Promise.all(peers.map(({ runtime }) => runtime.stopScreenSharing()));
    await refreshRoomVideoQuality();
  }
  async function startScreenSharing() {
    const s = session;
    if (!s || !current(s) || localScreenStream || screenRequest || !deps.media.getScreen) return;
    const request = {};
    screenRequest = request;
    try {
      const screen = await deps.media.getScreen();
      if (!current(s) || screenRequest !== request) {
        stopStream(screen);
        return;
      }
      localScreenStream = screen;
      await refreshRoomVideoQuality();
      if (!current(s) || screenRequest !== request || localScreenStream !== screen) return;
      screen.getTracks().forEach((track) => {
        track.onended = () => {
          void stopScreenSharing();
        };
      });
      await Promise.all(peers.map(({ runtime }) => runtime.startScreenSharing()));
      await refreshRoomVideoQuality();
    } catch {
      if (current(s) && screenRequest === request) error = 'call.error.screen';
    } finally {
      if (screenRequest === request) screenRequest = undefined;
    }
  }
  function reset() {
    leave();
    session = null;
    error = '';
  }
  function dismiss() {
    if (!busy) {
      session = null;
      error = '';
    }
  }
  return {
    get session() {
      return session;
    },
    set session(value) {
      session = value;
    },
    get localStream() {
      return localStream;
    },
    set localStream(value) {
      localStream = value;
    },
    get localScreenStream() {
      return localScreenStream;
    },
    set localScreenStream(value) {
      localScreenStream = value;
    },
    get microphoneMuted() {
      return microphoneMuted;
    },
    set microphoneMuted(value) {
      microphoneMuted = value;
    },
    get cameraMuted() {
      return cameraMuted;
    },
    set cameraMuted(value) {
      cameraMuted = value;
    },
    get microphoneDeviceId() {
      return microphoneDeviceId;
    },
    set microphoneDeviceId(value) {
      microphoneDeviceId = value;
    },
    get cameraDeviceId() {
      return cameraDeviceId;
    },
    set cameraDeviceId(value) {
      cameraDeviceId = value;
    },
    get changingMedia() {
      return changingMedia;
    },
    set changingMedia(value) {
      changingMedia = value;
    },
    get busy() {
      return busy;
    },
    get shareLink() {
      return shareLink;
    },
    get participants() {
      return participants;
    },
    get error() {
      return error;
    },
    set error(value) {
      error = value;
    },
    create: (mode: CallMode = 'audio') => begin(mode),
    join: (link: CallRoomLink, mode: CallMode = 'audio') => begin(mode, link),
    receive,
    leave,
    reset,
    dismiss,
    updateName,
    toggleMicrophone,
    toggleCamera,
    selectCamera,
    selectMicrophone,
    startScreenSharing,
    stopScreenSharing,
  };
}
