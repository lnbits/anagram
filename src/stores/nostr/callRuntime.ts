import { type CallMediaReceiver, callCaptureErrorKey } from 'src/services/callMediaService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_PROTOCOL,
  CALL_RING_TIMEOUT_MS,
  CALL_SUPPORT_TIMEOUT_MS,
  type CallConnection,
  type CallEndpoint,
  type CallEndReason,
  type CallMode,
  type CallSession,
  type CallSignal,
} from 'src/types/call';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from 'src/utils/callSignal';
import { ref, shallowRef } from 'vue';

export interface CallRuntimeDeps {
  sendSignal(peer: string, signal: CallSignal): Promise<void>;
  getOwnPubkey(): string | null;
  resolvePeer(peer: string): Promise<{ name: string } | null>;
  supported(mode: CallMode): boolean;
  otherCallBusy?(): boolean;
  hasSeen?(peer: string, id: string): boolean;
  remember?(peer: string, id: string): void;
  createEndpoint(): Promise<CallEndpoint>;
  getMedia(mode: CallMode, deviceId?: string): Promise<MediaStream>;
  getMicrophone?(deviceId: string): Promise<MediaStream>;
  getCamera?(): Promise<MediaStream>;
  getScreen?(): Promise<MediaStream>;
  unlockPlayback?(): void;
  createReceiver(mime: string, onError: () => void): CallMediaReceiver;
  record(
    stream: MediaStream,
    mime: string,
    send: (data: Uint8Array) => Promise<void>,
    onError: () => void,
    options?: { videoBitsPerSecond?: number }
  ): () => void;
}
interface Context {
  id: string;
  peer: string;
  mode: CallMode;
  endpoint?: CallEndpoint;
  connection?: CallConnection;
  receiver?: CallMediaReceiver;
  videoReceiver?: CallMediaReceiver;
  screenReceiver?: CallMediaReceiver;
  screenStream?: MediaStream;
  stopScreenRecording?: () => void;
  acquiringScreen?: boolean;
  stream?: MediaStream;
  stopRecording?: () => void;
  stopVideoRecording?: () => void;
  supportTimeout?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  mime: string;
  lastReceivedAt: number;
  ready: boolean;
  peerConfirmed: boolean;
  splitMedia: boolean;
  peerVideoSupported: boolean;
  changingMedia: boolean;
  receivedMediaChanges: number[];
  inviteSent: boolean;
}

export function createCallRuntime(deps: CallRuntimeDeps) {
  const session = shallowRef<CallSession | null>(null);
  const localStream = shallowRef<MediaStream | null>(null);
  const remoteMediaUrl = ref('');
  const remoteVideoUrl = ref('');
  const remoteScreenUrl = ref('');
  const localScreenStream = shallowRef<MediaStream | null>(null);
  const error = ref('');
  const deviceError = ref('');
  const microphoneDeviceId = ref('');
  const changingMedia = ref(false);
  const failureDetail = ref('');
  let context: Context | null = null;
  let generation = 0;
  const tombstones = new Map<string, number>();
  const alive = (ctx: Context) => context === ctx;
  const patch = (value: Partial<CallSession>) => {
    if (session.value) session.value = { ...session.value, ...value };
  };
  const key = (peer: string, id: string) => `${peer}:${id}`;
  const seen = (peer: string, id: string) =>
    tombstones.has(key(peer, id)) || Boolean(deps.hasSeen?.(peer, id));
  function remember(peer: string, id: string) {
    deps.remember?.(peer, id);
    tombstones.set(key(peer, id), Date.now() + CALL_RING_TIMEOUT_MS);
    for (const [entry, expiration] of tombstones)
      if (expiration < Date.now()) tombstones.delete(entry);
    while (tombstones.size > 256) {
      const oldest = tombstones.keys().next().value;
      if (oldest) tombstones.delete(oldest);
    }
  }
  function signal(ctx: Context, action: CallSignal['action'], reason?: CallEndReason): CallSignal {
    if (action !== 'end' && action !== 'ringing' && !ctx.endpoint)
      throw new Error('Call endpoint is not ready');
    return {
      protocol: CALL_PROTOCOL,
      callId: ctx.id,
      action,
      mode: ctx.mode,
      expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
      mediaVersion: 2,
      videoSupported: deps.supported('video'),
      screenSupported: deps.supported('video'),
      ...(action === 'end'
        ? { reason: reason ?? 'hangup' }
        : action === 'ringing'
          ? {}
          : {
              address: { id: ctx.endpoint?.id() ?? '', relayUrl: ctx.endpoint?.relay_url() ?? '' },
              mimeType: ctx.mime,
            }),
    };
  }
  function finish(ctx: Context, reason: CallEndReason, notify = true) {
    if (!alive(ctx)) return;
    context = null;
    remember(ctx.peer, ctx.id);
    clearTimeout(ctx.timeout);
    clearTimeout(ctx.supportTimeout);
    clearInterval(ctx.heartbeat);
    ctx.stopRecording?.();
    ctx.stopVideoRecording?.();
    ctx.stopScreenRecording?.();
    ctx.screenStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    ctx.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    ctx.connection?.close(reason);
    void ctx.endpoint?.close().catch(() => {});
    ctx.receiver?.close();
    ctx.videoReceiver?.close();
    ctx.screenReceiver?.close();
    localScreenStream.value = null;
    remoteScreenUrl.value = '';
    localStream.value = null;
    remoteMediaUrl.value = '';
    remoteVideoUrl.value = '';
    changingMedia.value = false;
    patch({ phase: 'ended', endReason: reason });
    if (notify && (ctx.inviteSent || session.value?.direction === 'incoming'))
      void deps.sendSignal(ctx.peer, signal(ctx, 'end', reason)).catch(() => {});
  }
  function fail(ctx: Context, cause?: unknown) {
    if (!alive(ctx)) return;
    error.value = 'call.error.failed';
    failureDetail.value =
      cause instanceof Error ? cause.message : String(cause ?? 'Call media failed');
    finish(ctx, 'failed');
  }
  function armTimeout(ctx: Context, ms: number) {
    clearTimeout(ctx.timeout);
    ctx.timeout = setTimeout(() => finish(ctx, 'timeout'), ms);
  }
  function captureFailed(ctx: Context, cause: unknown) {
    if (!alive(ctx)) return;
    fail(ctx, cause);
    error.value = callCaptureErrorKey(cause);
  }
  function confirmPeer(ctx: Context, incoming: CallSignal) {
    ctx.peerConfirmed = true;
    clearTimeout(ctx.supportTimeout);
    ctx.splitMedia = incoming.mediaVersion === 2;
    ctx.peerVideoSupported = incoming.videoSupported === true;
    patch({
      peerConfirmed: true,
      mediaVersion: ctx.splitMedia ? 2 : undefined,
      videoAvailable: ctx.splitMedia && ctx.peerVideoSupported && deps.supported('video'),
      screenAvailable:
        ctx.splitMedia && incoming.screenSupported === true && deps.supported('video'),
    });
  }
  function reserve(
    peer: string,
    name: string,
    mode: CallMode,
    direction: CallSession['direction'],
    id: string
  ): Context {
    const ctx: Context = {
      id,
      peer,
      mode,
      mime: CALL_MIME_TYPES[mode === 'video' ? 0 : 1],
      lastReceivedAt: Date.now(),
      ready: false,
      peerConfirmed: false,
      splitMedia: false,
      peerVideoSupported: false,
      changingMedia: false,
      receivedMediaChanges: [],
      inviteSent: false,
    };
    context = ctx;
    error.value = '';
    failureDetail.value = '';
    deviceError.value = '';
    session.value = {
      id,
      peerPubkey: peer,
      peerName: name,
      direction,
      mode,
      phase: direction === 'incoming' ? 'incoming' : 'preparing',
      startedAt: null,
      microphoneMuted: false,
      cameraMuted: mode === 'audio',
      peerConfirmed: false,
    };
    armTimeout(ctx, CALL_RING_TIMEOUT_MS);
    return ctx;
  }
  async function prepare(ctx: Context, captureMode: CallMode = ctx.mode) {
    let stream: MediaStream;
    try {
      stream = await deps.getMedia(captureMode, microphoneDeviceId.value);
    } catch (cause) {
      captureFailed(ctx, cause);
      return false;
    }
    if (!alive(ctx)) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return false;
    }
    ctx.stream = stream;
    localStream.value = stream;
    microphoneDeviceId.value = stream.getAudioTracks()[0]?.getSettings?.().deviceId ?? '';
    for (const track of stream.getTracks())
      track.onended = () =>
        captureFailed(ctx, new DOMException('Capture device disconnected', 'NotFoundError'));
    let endpoint: CallEndpoint;
    try {
      endpoint = await deps.createEndpoint();
    } catch (cause) {
      fail(ctx, cause);
      if (cause instanceof WebAssembly.CompileError || cause instanceof SyntaxError)
        error.value = 'call.error.unsupported';
      return false;
    }
    if (!alive(ctx)) {
      void endpoint.close();
      return false;
    }
    ctx.endpoint = endpoint;
    await endpoint.online();
    return alive(ctx);
  }
  function startAudioRecording(ctx: Context) {
    const stream = ctx.stream;
    const connection = ctx.connection;
    if (!stream || !connection || !alive(ctx)) return;
    ctx.stopRecording = deps.record(
      ctx.splitMedia ? new MediaStream(stream.getAudioTracks()) : stream,
      ctx.splitMedia ? CALL_MIME_TYPES[1] : ctx.mime,
      (frame) => connection.send(frame),
      () => fail(ctx, new Error('Audio encoder failed'))
    );
  }
  async function startVideoRecording(ctx: Context) {
    const connection = ctx.connection;
    if (!connection || !ctx.stream || !alive(ctx) || !ctx.splitMedia) return;
    await connection.send(new Uint8Array([5, 1]));
    if (!alive(ctx) || !ctx.stream.getVideoTracks().length) return;
    ctx.stopVideoRecording = deps.record(
      new MediaStream(ctx.stream.getVideoTracks()),
      CALL_VIDEO_MIME_TYPE,
      (frame) => {
        frame[0] = 3;
        return connection.send(frame);
      },
      () => fail(ctx, new Error('Video encoder failed'))
    );
  }
  function checkMediaChangeRate(ctx: Context) {
    ctx.receivedMediaChanges = ctx.receivedMediaChanges.filter((at) => Date.now() - at < 10_000);
    if (ctx.receivedMediaChanges.length >= 12) throw new Error('Too many media changes');
    ctx.receivedMediaChanges.push(Date.now());
  }
  async function receiveFrames(ctx: Context) {
    try {
      while (alive(ctx) && ctx.connection) {
        const data = await ctx.connection.recv();
        if (!alive(ctx)) return;
        if (!data.length) throw new Error('Empty frame');
        ctx.lastReceivedAt = Date.now();
        if (data[0] === 2 && data.length === 1 && !ctx.ready) {
          const stream = ctx.stream;
          const connection = ctx.connection;
          if (!stream || !connection) throw new Error('Call media is not ready');
          ctx.ready = true;
          clearTimeout(ctx.timeout);
          patch({ phase: 'active', startedAt: new Date().toISOString() });
          startAudioRecording(ctx);
          if (ctx.splitMedia && stream.getVideoTracks().length)
            void startVideoRecording(ctx).catch((cause) => fail(ctx, cause));
        } else if (data[0] === 0 && data.length > 1 && ctx.ready) {
          ctx.receiver?.append(data.subarray(1));
        } else if (
          data[0] === 3 &&
          data.length > 1 &&
          ctx.ready &&
          ctx.splitMedia &&
          ctx.videoReceiver
        ) {
          ctx.videoReceiver.append(data.subarray(1));
        } else if (data[0] === 4 && data.length === 1 && ctx.ready && ctx.splitMedia) {
          checkMediaChangeRate(ctx);
          ctx.receiver?.close();
          ctx.receiver = deps.createReceiver(CALL_MIME_TYPES[1], () =>
            fail(ctx, new Error('Audio decoder failed'))
          );
          remoteMediaUrl.value = ctx.receiver.url;
        } else if (
          data[0] === 5 &&
          data.length === 2 &&
          (data[1] === 0 || data[1] === 1) &&
          ctx.ready &&
          ctx.splitMedia
        ) {
          checkMediaChangeRate(ctx);
          ctx.videoReceiver?.close();
          ctx.videoReceiver = undefined;
          remoteVideoUrl.value = '';
          if (data[1] === 1) {
            if (!deps.supported('video')) throw new Error('Video is unsupported');
            ctx.videoReceiver = deps.createReceiver(CALL_VIDEO_MIME_TYPE, () =>
              fail(ctx, new Error('Video decoder failed'))
            );
            remoteVideoUrl.value = ctx.videoReceiver.url;
          }
        } else if (
          data[0] === 6 &&
          data.length > 1 &&
          ctx.ready &&
          ctx.splitMedia &&
          session.value?.screenAvailable &&
          ctx.screenReceiver
        ) {
          ctx.screenReceiver.append(data.subarray(1));
        } else if (
          data[0] === 7 &&
          data.length === 2 &&
          (data[1] === 0 || data[1] === 1) &&
          ctx.ready &&
          ctx.splitMedia &&
          session.value?.screenAvailable
        ) {
          checkMediaChangeRate(ctx);
          ctx.screenReceiver?.close();
          ctx.screenReceiver = undefined;
          remoteScreenUrl.value = '';
          if (data[1] === 1) {
            ctx.screenReceiver = deps.createReceiver(CALL_VIDEO_MIME_TYPE, () =>
              fail(ctx, new Error('Screen decoder failed'))
            );
            remoteScreenUrl.value = ctx.screenReceiver.url;
          }
        } else if (data[0] !== 1 || data.length !== 1) {
          throw new Error('Unexpected call frame');
        }
      }
    } catch (cause) {
      const reason = ctx.connection?.end_reason?.();
      if (
        reason &&
        ['hangup', 'cancelled', 'declined', 'busy', 'timeout', 'unsupported'].includes(reason)
      ) {
        finish(ctx, reason as CallEndReason, false);
      } else {
        fail(ctx, cause);
      }
    }
  }
  async function connect(ctx: Context, invite: CallSignal) {
    if (!alive(ctx) || !invite.address || !ctx.endpoint) return;
    const endpoint = ctx.endpoint;
    patch({ phase: 'connecting' });
    armTimeout(ctx, CALL_CONNECT_TIMEOUT_MS);
    try {
      const connection =
        session.value?.direction === 'outgoing'
          ? await endpoint.connect(invite.address.id, invite.address.relayUrl, ctx.id)
          : await endpoint.accept(invite.address.id, ctx.id);
      if (!alive(ctx)) {
        connection.close();
        return;
      }
      ctx.connection = connection;
      ctx.receiver = deps.createReceiver(ctx.splitMedia ? CALL_MIME_TYPES[1] : ctx.mime, () =>
        fail(ctx, new Error('Audio decoder failed'))
      );
      remoteMediaUrl.value = ctx.receiver.url;
      ctx.lastReceivedAt = Date.now();
      ctx.heartbeat = setInterval(() => {
        if (!alive(ctx)) return;
        if (Date.now() - ctx.lastReceivedAt > 15_000) {
          fail(ctx);
          return;
        }
        void connection.send(new Uint8Array([1])).catch(() => fail(ctx));
      }, 3000);
      void receiveFrames(ctx);
      await connection.send(new Uint8Array([2]));
    } catch (cause) {
      fail(ctx, cause);
    }
  }
  async function start(peerInput: string, mode: CallMode) {
    if (context) return;
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    if (!peer || peer === deps.getOwnPubkey() || !deps.getOwnPubkey()) return;
    if (!deps.supported(mode)) {
      error.value = 'call.error.unsupported';
      return;
    }
    deps.unlockPlayback?.();
    // Reserve before asynchronous checks so rapid clicks cannot create multiple endpoints.
    const ctx = reserve(peer, peer.slice(0, 12), mode, 'outgoing', crypto.randomUUID());
    try {
      const contact = await deps.resolvePeer(peer);
      if (!alive(ctx)) return;
      if (!contact) {
        error.value = 'call.error.unavailable';
        finish(ctx, 'failed', false);
        return;
      }
      patch({ peerName: contact.name });
      if (!(await prepare(ctx))) return;
      patch({ phase: 'outgoing' });
      armTimeout(ctx, CALL_RING_TIMEOUT_MS);
      ctx.inviteSent = true;
      await deps.sendSignal(peer, signal(ctx, 'invite'));
      if (alive(ctx) && !ctx.peerConfirmed)
        ctx.supportTimeout = setTimeout(() => finish(ctx, 'unsupported'), CALL_SUPPORT_TIMEOUT_MS);
    } catch (cause) {
      fail(ctx, cause);
    }
  }
  let incomingInvite: CallSignal | null = null;
  async function receiveSignal(peer: string, incoming: CallSignal) {
    const receivedGeneration = generation;
    const own = deps.getOwnPubkey();
    if (!own || peer === own || !inputSanitizerService.normalizeHexKey(peer)) return;
    const ctx = context;
    if (incoming.action === 'end') {
      remember(peer, incoming.callId);
      if (ctx?.peer === peer && ctx.id === incoming.callId)
        finish(ctx, incoming.reason ?? 'hangup', false);
      return;
    }
    if (incoming.action === 'ringing') {
      if (
        ctx?.peer === peer &&
        ctx.id === incoming.callId &&
        ctx.mode === incoming.mode &&
        session.value?.phase === 'outgoing'
      )
        confirmPeer(ctx, incoming);
      return;
    }
    if (incoming.action === 'accept') {
      if (
        ctx?.peer === peer &&
        ctx.id === incoming.callId &&
        incoming.mode === ctx.mode &&
        incoming.mimeType === ctx.mime &&
        session.value?.phase === 'outgoing'
      ) {
        confirmPeer(ctx, incoming);
        void connect(ctx, incoming);
      }
      return;
    }
    if (seen(peer, incoming.callId) || ctx?.id === incoming.callId) return;
    const contact = await deps.resolvePeer(peer);
    if (receivedGeneration !== generation || deps.getOwnPubkey() !== own) return;
    if (!contact || Date.parse(incoming.expiresAt) <= Date.now()) return;
    if (seen(peer, incoming.callId) || context?.id === incoming.callId) return;
    if (context || deps.otherCallBusy?.() || !deps.supported(incoming.mode)) {
      remember(peer, incoming.callId);
      void deps
        .sendSignal(peer, {
          ...incoming,
          action: 'end',
          address: undefined,
          mimeType: undefined,
          reason: context || deps.otherCallBusy?.() ? 'busy' : 'unsupported',
        })
        .catch(() => {});
      return;
    }
    incomingInvite = incoming;
    remember(peer, incoming.callId);
    const next = reserve(peer, contact.name, incoming.mode, 'incoming', incoming.callId);
    confirmPeer(next, incoming);
    armTimeout(next, Math.max(1, Date.parse(incoming.expiresAt) - Date.now()));
    void deps.sendSignal(peer, signal(next, 'ringing')).catch(() => {});
  }
  async function accept(mode?: CallMode) {
    const ctx = context;
    const invite = incomingInvite;
    if (!ctx || !invite || session.value?.phase !== 'incoming') return;
    deps.unlockPlayback?.();
    const captureMode = mode === 'audio' ? 'audio' : ctx.mode;
    patch({ phase: 'preparing', cameraMuted: captureMode === 'audio' });
    try {
      if (!(await prepare(ctx, captureMode))) return;
      // Start accepting before publication so a fast caller cannot outrun the listener.
      void connect(ctx, invite);
      await deps.sendSignal(ctx.peer, signal(ctx, 'accept'));
    } catch (cause) {
      fail(ctx, cause);
    }
  }
  function end() {
    const ctx = context;
    if (ctx)
      finish(
        ctx,
        session.value?.phase === 'incoming' ? 'declined' : ctx.ready ? 'hangup' : 'cancelled'
      );
  }
  function toggleMicrophone() {
    if (!context?.stream || !session.value) return;
    const muted = !session.value.microphoneMuted;
    context.stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    patch({ microphoneMuted: muted });
  }
  async function selectMicrophone(deviceId: string) {
    const ctx = context;
    if (
      !ctx?.stream ||
      !ctx.ready ||
      ctx.changingMedia ||
      typeof deviceId !== 'string' ||
      deviceId.length > 512
    )
      return;
    if (!ctx.splitMedia || !deps.getMicrophone) {
      deviceError.value = 'call.error.peerUpgrade';
      return;
    }
    ctx.changingMedia = changingMedia.value = true;
    deviceError.value = '';
    let replacement: MediaStream | undefined;
    try {
      replacement = await deps.getMicrophone(deviceId);
      if (!alive(ctx)) {
        replacement.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      const nextTracks = replacement.getAudioTracks();
      if (!nextTracks.length) throw new DOMException('No microphone track', 'NotFoundError');
      const previous = ctx.stream.getAudioTracks();
      ctx.stopRecording?.();
      for (const track of nextTracks) {
        track.enabled = !session.value?.microphoneMuted;
        track.onended = () =>
          captureFailed(ctx, new DOMException('Microphone disconnected', 'NotFoundError'));
      }
      ctx.stream = new MediaStream([...nextTracks, ...ctx.stream.getVideoTracks()]);
      localStream.value = ctx.stream;
      microphoneDeviceId.value = nextTracks[0]?.getSettings().deviceId ?? deviceId;
      previous.forEach((track) => {
        track.onended = null;
        track.stop();
      });
      // The old recorder is stopped before this ordered reset; its pending chunks are cancelled.
      await ctx.connection?.send(new Uint8Array([4]));
      if (alive(ctx)) startAudioRecording(ctx);
    } catch (cause) {
      // A rejected new device leaves the current microphone and call intact.
      if (replacement && replacement !== ctx.stream)
        replacement.getTracks().forEach((track) => {
          if (!ctx.stream?.getTracks().includes(track)) track.stop();
        });
      if (alive(ctx)) {
        if (
          replacement &&
          ctx.stream?.getAudioTracks().some((track) => replacement?.getTracks().includes(track))
        )
          fail(ctx, cause);
        else deviceError.value = callCaptureErrorKey(cause);
      }
    } finally {
      ctx.changingMedia = false;
      if (alive(ctx)) changingMedia.value = false;
    }
  }
  async function toggleCamera() {
    const ctx = context;
    if (!ctx?.stream || !session.value || ctx.changingMedia) return;
    if (!ctx.splitMedia) {
      if (!ctx.ready) return;
      if (ctx.mode !== 'video') {
        deviceError.value = 'call.error.peerUpgrade';
        return;
      }
      const muted = !session.value.cameraMuted;
      ctx.stream.getVideoTracks().forEach((track) => {
        track.enabled = !muted;
      });
      patch({ cameraMuted: muted });
      return;
    }
    if (!ctx.ready || !deps.getCamera || !session.value.videoAvailable) return;
    ctx.changingMedia = changingMedia.value = true;
    deviceError.value = '';
    let camera: MediaStream | undefined;
    try {
      if (!session.value.cameraMuted) {
        ctx.stopVideoRecording?.();
        ctx.stopVideoRecording = undefined;
        const tracks = ctx.stream.getVideoTracks();
        ctx.stream = new MediaStream(ctx.stream.getAudioTracks());
        localStream.value = ctx.stream;
        patch({ cameraMuted: true });
        tracks.forEach((track) => {
          track.onended = null;
          track.stop();
        });
        await ctx.connection?.send(new Uint8Array([5, 0]));
      } else {
        camera = await deps.getCamera();
        if (!alive(ctx)) {
          camera.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        if (!camera.getVideoTracks().length)
          throw new DOMException('No camera track', 'NotFoundError');
        ctx.stream = new MediaStream([...ctx.stream.getAudioTracks(), ...camera.getVideoTracks()]);
        localStream.value = ctx.stream;
        camera.getVideoTracks().forEach((track) => {
          track.onended = () =>
            captureFailed(ctx, new DOMException('Camera disconnected', 'NotFoundError'));
        });
        patch({ cameraMuted: false });
        await startVideoRecording(ctx);
      }
    } catch (cause) {
      if (alive(ctx)) {
        if (camera && ctx.stream?.getVideoTracks().length) fail(ctx, cause);
        else deviceError.value = callCaptureErrorKey(cause);
      }
      camera?.getTracks().forEach((track) => {
        if (!ctx.stream?.getTracks().includes(track)) track.stop();
      });
    } finally {
      ctx.changingMedia = false;
      if (alive(ctx)) changingMedia.value = false;
    }
  }
  async function stopScreenSharing() {
    const ctx = context;
    if (!ctx) return;
    ctx.acquiringScreen = false;
    ctx.stopScreenRecording?.();
    ctx.stopScreenRecording = undefined;
    ctx.screenStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    ctx.screenStream = undefined;
    localScreenStream.value = null;
    patch({ screenSharing: false });
    try {
      if (ctx.ready && session.value?.screenAvailable)
        await ctx.connection?.send(new Uint8Array([7, 0]));
    } catch (cause) {
      fail(ctx, cause);
    }
  }
  async function startScreenSharing() {
    const ctx = context;
    if (
      !ctx?.ready ||
      !ctx.connection ||
      !session.value?.screenAvailable ||
      !deps.getScreen ||
      ctx.screenStream ||
      ctx.acquiringScreen
    )
      return;
    ctx.acquiringScreen = true;
    deviceError.value = '';
    let screen: MediaStream | undefined;
    try {
      // Capture is invoked before any await so the browser sees the user's gesture.
      screen = await deps.getScreen();
      if (!alive(ctx) || !ctx.acquiringScreen) {
        screen.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      if (!screen.getVideoTracks().length) throw new Error('No screen video track');
      ctx.screenStream = screen;
      localScreenStream.value = screen;
      patch({ screenSharing: true });
      screen.getTracks().forEach((track) => {
        track.onended = () => {
          void stopScreenSharing();
        };
      });
      await ctx.connection.send(new Uint8Array([7, 1]));
      if (!alive(ctx) || ctx.screenStream !== screen) return;
      ctx.stopScreenRecording = deps.record(
        new MediaStream(screen.getVideoTracks()),
        CALL_VIDEO_MIME_TYPE,
        (frame) => {
          frame[0] = 6;
          return ctx.connection?.send(frame);
        },
        () => {
          deviceError.value = 'call.error.screen';
          void stopScreenSharing();
        },
        { videoBitsPerSecond: 1_500_000 }
      );
    } catch {
      if (alive(ctx)) {
        deviceError.value = 'call.error.screen';
        if (ctx.screenStream) await stopScreenSharing();
      }
      screen?.getTracks().forEach((track) => {
        track.stop();
      });
    } finally {
      ctx.acquiringScreen = false;
    }
  }
  function reset() {
    generation += 1;
    end();
    session.value = null;
    incomingInvite = null;
    error.value = '';
    failureDetail.value = '';
    deviceError.value = '';
    tombstones.clear();
  }
  function dismiss() {
    if (!context) {
      session.value = null;
      error.value = '';
    }
  }
  return {
    session,
    localStream,
    remoteMediaUrl,
    remoteVideoUrl,
    remoteScreenUrl,
    localScreenStream,
    startScreenSharing,
    stopScreenSharing,
    error,
    deviceError,
    microphoneDeviceId,
    changingMedia,
    failureDetail,
    start,
    receiveSignal,
    accept,
    end,
    toggleMicrophone,
    selectMicrophone,
    toggleCamera,
    reset,
    dismiss,
  };
}
