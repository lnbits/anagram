import { PACKET_VIDEO_MIME } from '#src/services/callPacketVideo.ts';
import { OPUS_CALL_MIME, AUDIO_PACKET_KIND } from '#src/services/callAudioPackets.ts';
import {
  type CallMediaReceiver,
  type CallRecordingOptions,
  callCaptureErrorKey,
} from '#src/services/callMediaService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_PROTOCOL,
  CALL_RING_TIMEOUT_MS,
  CALL_SUPPORT_TIMEOUT_MS,
  type CallConnection,
  type CallTransportStats,
  type CallEndpoint,
  type CallEndReason,
  type CallMode,
  type CallSession,
  type CallSignal,
} from '#src/types/call.ts';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from '#src/utils/callSignal.ts';

export interface CallVideoProfile {
  cameraBitrate: number;
  cameraFrameRate: number;
  screenBitrate: number;
  screenFrameRate: number;
  cameraWidth?: number;
  cameraHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
}
const DEFAULT_VIDEO_PROFILE: CallVideoProfile = {
  cameraBitrate: 600_000,
  cameraFrameRate: 24,
  screenBitrate: 1_500_000,
  screenFrameRate: 15,
};
export interface CallRuntimeDeps {
  packetVideoSupported?(): Promise<boolean>;
  preparePacketAudio?(): Promise<(() => void) | undefined>;
  videoProfile?(): CallVideoProfile;
  /** After a video quality refresh, which skips camera and microphone changes while it runs. */
  onVideoQualityRefreshed?(): void;
  onEnded?(session: CallSession): Promise<void>;
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
  getCamera?(deviceId?: string): Promise<MediaStream>;
  getScreen?(): Promise<MediaStream>;
  unlockPlayback?(): void;
  acquireAudioRoute?(): Promise<() => void>;
  createReceiver(mime: string, onError: () => void): CallMediaReceiver;
  record(
    stream: MediaStream,
    mime: string,
    send: (data: Uint8Array) => Promise<void>,
    onError: () => void,
    options?: CallRecordingOptions,
  ): () => void;
}
interface Context {
  releasePacketAudio?: () => void;
  packetPreparation?: Promise<void>;
  peerPacketAudio?: boolean;
  packetAudio?: boolean;
  localPacketVideo?: boolean;
  peerPacketVideo?: boolean;
  packetVideo?: boolean;
  audioGeneration?: number;
  resetAudioOnUnmute?: boolean;
  statsPending?: boolean;
  releaseAudioRoute?: () => void;
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
  screenRequest?: object;
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
  peerMuteStateSupported: boolean;
  changingMedia: boolean;
  receivedMediaChanges: number[];
  inviteSent: boolean;
  multiplexed: boolean;
  reconnectSupported: boolean;
  reconnectAttempt: number;
  recoveryAttempts: number;
  linkRevision: number;
  recoveryStarted?: number;
  attemptStarted?: number;
  recoveryTimer?: ReturnType<typeof setInterval>;
  recoveryOffer?: CallSignal;
  localAddress?: CallSignal['address'];
  connectingAttempt?: number;
  cameraProfile?: number;
  screenProfile?: number;
  qualityTimer?: ReturnType<typeof setTimeout>;
  mediaRecovery?: boolean;
  remoteVideoError?: 'camera' | 'screen';
  videoRetries?: Map<string, number[]>;
  videoRetryTimers?: Map<string, ReturnType<typeof setTimeout>>;
}

export function createCallRuntime(deps: CallRuntimeDeps) {
  let session = $state.raw<CallSession | null>(null);
  let localStream = $state.raw<MediaStream | null>(null);
  let remoteMediaUrl = $state('');
  let remoteVideoUrl = $state('');
  let remoteScreenUrl = $state('');
  let localScreenStream = $state.raw<MediaStream | null>(null);
  let error = $state('');
  let deviceError = $state('');
  let microphoneDeviceId = $state('');
  let cameraDeviceId = $state('');
  let changingMedia = $state(false);
  let failureDetail = $state('');
  let transportDiagnostics = $state.raw<CallTransportStats | null>(null);
  let context: Context | null = null;
  let generation = 0;
  const tombstones = new Map<string, number>();
  const alive = (ctx: Context) => context === ctx;
  const patch = (value: Partial<CallSession>) => {
    if (session) session = { ...session, ...value };
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
    if (action !== 'end' && action !== 'ringing' && !ctx.endpoint && !ctx.localAddress)
      throw new Error('Call endpoint is not ready');
    return {
      protocol: CALL_PROTOCOL,
      callId: ctx.id,
      action,
      mode: ctx.mode,
      expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
      mediaVersion: 2,
      ...(ctx.localPacketVideo ? { packetVideoVersion: 1 } : {}),
      ...(ctx.releasePacketAudio && ctx.endpoint?.datagrams ? { packetAudioVersion: 1 } : {}),
      ...(ctx.endpoint?.multiplexed ? { transportVersion: 2 } : {}),
      reconnectSupported: true,
      videoSupported: deps.supported('video'),
      screenSupported: deps.supported('video'),
      muteStateSupported: true,
      mediaRecoveryVersion: 1,
      ...(action === 'end'
        ? { reason: reason ?? 'hangup' }
        : action === 'ringing'
          ? {}
          : {
              address: ctx.localAddress ?? {
                id: ctx.endpoint?.id() ?? '',
                relayUrl: ctx.endpoint?.relay_url() ?? '',
              },
              mimeType: ctx.mime,
            }),
    };
  }
  function finish(ctx: Context, reason: CallEndReason, notify = true) {
    if (!alive(ctx)) return;
    context = null;
    transportDiagnostics = null;
    remember(ctx.peer, ctx.id);
    clearTimeout(ctx.timeout);
    clearTimeout(ctx.supportTimeout);
    clearInterval(ctx.heartbeat);
    clearInterval(ctx.recoveryTimer);
    clearTimeout(ctx.qualityTimer);
    ctx.videoRetryTimers?.forEach(clearTimeout);
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
    ctx.releaseAudioRoute?.();
    ctx.releasePacketAudio?.();
    localScreenStream = null;
    remoteScreenUrl = '';
    localStream = null;
    remoteMediaUrl = '';
    remoteVideoUrl = '';
    changingMedia = false;
    patch({ phase: 'ended', endReason: reason });
    if (ctx.inviteSent && session?.direction === 'outgoing' && deps.onEnded) {
      void deps.onEnded({ ...session }).catch(() => {
        if (session?.id === ctx.id && !error) error = 'call.error.history';
      });
    }
    if (notify && (ctx.inviteSent || session?.direction === 'incoming'))
      void deps.sendSignal(ctx.peer, signal(ctx, 'end', reason)).catch(() => {});
  }
  function fail(ctx: Context, cause?: unknown) {
    if (!alive(ctx)) return;
    error = 'call.error.failed';
    failureDetail = cause instanceof Error ? cause.message : String(cause ?? 'Call media failed');
    finish(ctx, 'failed');
  }
  function armTimeout(ctx: Context, ms: number) {
    clearTimeout(ctx.timeout);
    ctx.timeout = setTimeout(() => finish(ctx, 'timeout'), ms);
  }
  function captureFailed(ctx: Context, cause: unknown) {
    if (!alive(ctx)) return;
    fail(ctx, cause);
    error = callCaptureErrorKey(cause);
  }
  function confirmPeer(ctx: Context, incoming: CallSignal) {
    ctx.peerConfirmed = true;
    ctx.mediaRecovery = incoming.mediaRecoveryVersion === 1;
    ctx.multiplexed = incoming.transportVersion === 2;
    ctx.reconnectSupported = incoming.reconnectSupported === true;
    clearTimeout(ctx.supportTimeout);
    ctx.splitMedia = incoming.mediaVersion === 2;
    ctx.peerPacketVideo = ctx.splitMedia && incoming.packetVideoVersion === 1;
    ctx.peerPacketAudio = ctx.splitMedia && incoming.packetAudioVersion === 1;
    ctx.peerVideoSupported = incoming.videoSupported === true;
    ctx.peerMuteStateSupported =
      incoming.mediaVersion === 2 && incoming.muteStateSupported === true;
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
    id: string,
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
      peerMuteStateSupported: false,
      changingMedia: false,
      receivedMediaChanges: [],
      inviteSent: false,
      multiplexed: false,
      reconnectSupported: false,
      reconnectAttempt: 0,
      recoveryAttempts: 0,
      linkRevision: 0,
    };
    context = ctx;
    error = '';
    failureDetail = '';
    deviceError = '';
    session = {
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
  function preparePacketMedia(ctx: Context) {
    // Start AudioContext.resume within the user's call/answer gesture. Safari
    // can otherwise leave it suspended after permission or contact lookups.
    ctx.packetPreparation = Promise.all([
      (deps.preparePacketAudio?.() ?? Promise.resolve(undefined))
        .then((release) => {
          if (alive(ctx)) ctx.releasePacketAudio = release;
          else release?.();
        })
        .catch(() => {}),
      (deps.packetVideoSupported?.() ?? Promise.resolve(false))
        .then((supported) => {
          if (alive(ctx)) ctx.localPacketVideo = supported;
        })
        .catch(() => {}),
    ]).then(() => {});
  }
  async function prepare(ctx: Context, captureMode: CallMode = ctx.mode) {
    let stream: MediaStream;
    try {
      stream = await deps.getMedia(captureMode, microphoneDeviceId);
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
    if (deps.acquireAudioRoute) {
      try {
        const release = await deps.acquireAudioRoute();
        if (!alive(ctx)) {
          release();
          return false;
        }
        ctx.releaseAudioRoute = release;
      } catch (cause) {
        if (alive(ctx)) {
          fail(ctx, cause);
          error = 'call.error.speaker';
        }
        return false;
      }
    }
    localStream = stream;
    microphoneDeviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId ?? '';
    if (stream.getVideoTracks().length)
      cameraDeviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? '';
    for (const track of stream.getTracks())
      track.onended = () => {
        if (track.kind === 'video' && ctx.splitMedia) disableCamera(ctx);
        else captureFailed(ctx, new DOMException('Capture device disconnected', 'NotFoundError'));
      };
    await ctx.packetPreparation;
    if (!alive(ctx)) return false;
    let endpoint: CallEndpoint;
    try {
      endpoint = await deps.createEndpoint();
    } catch (cause) {
      fail(ctx, cause);
      if (cause instanceof WebAssembly.CompileError || cause instanceof SyntaxError)
        error = 'call.error.unsupported';
      return false;
    }
    if (!alive(ctx)) {
      void endpoint.close();
      return false;
    }
    ctx.endpoint = endpoint;
    await endpoint.online();
    if (alive(ctx)) ctx.localAddress = { id: endpoint.id(), relayUrl: endpoint.relay_url() };
    return alive(ctx);
  }
  function startAudioRecording(ctx: Context) {
    const stream = ctx.stream;
    const connection = ctx.connection;
    if (!stream || !connection || !alive(ctx) || !ctx.ready) return;
    ctx.resetAudioOnUnmute =
      !ctx.packetAudio && stream.getAudioTracks().some((track) => !track.enabled);
    ctx.stopRecording = deps.record(
      ctx.splitMedia ? new MediaStream(stream.getAudioTracks()) : stream,
      ctx.packetAudio ? OPUS_CALL_MIME : ctx.splitMedia ? CALL_MIME_TYPES[1] : ctx.mime,
      (frame) =>
        ctx.packetAudio && connection.sendAudio
          ? connection.sendAudio(frame)
          : connection.send(frame),
      () => {
        if (ctx.connection === connection) fail(ctx, new Error('Audio encoder failed'));
      },
      {
        audioGeneration: (ctx.audioGeneration = (ctx.audioGeneration ?? 0) + 1),
        ...(ctx.splitMedia ? { onStreamRestart: () => connection.send(new Uint8Array([4])) } : {}),
        onSendError: (cause) => {
          if (ctx.connection === connection) recover(ctx, cause);
        },
      },
    );
  }
  async function startVideoRecording(ctx: Context) {
    const connection = ctx.connection;
    if (!connection || !ctx.stream || !alive(ctx) || !ctx.splitMedia) return;
    const revision = ctx.linkRevision,
      stream = ctx.stream;
    const profile = deps.videoProfile?.() ?? DEFAULT_VIDEO_PROFILE;
    await limitFrameRate(
      stream.getVideoTracks(),
      profile.cameraFrameRate,
      profile.cameraWidth,
      profile.cameraHeight,
    );
    if (
      !alive(ctx) ||
      ctx.linkRevision !== revision ||
      ctx.stream !== stream ||
      !stream.getVideoTracks().length
    )
      return;
    await connection.send(new Uint8Array([5, 1]));
    if (
      !alive(ctx) ||
      ctx.linkRevision !== revision ||
      ctx.stream !== stream ||
      !stream.getVideoTracks().length
    )
      return;
    ctx.cameraProfile = profile.cameraBitrate;
    ctx.stopVideoRecording = deps.record(
      new MediaStream(ctx.stream.getVideoTracks()),
      ctx.packetVideo ? PACKET_VIDEO_MIME : CALL_VIDEO_MIME_TYPE,
      (frame) => {
        frame[0] = 3;
        return connection.send(frame);
      },
      () => {
        if (ctx.connection === connection) retryVideo(ctx, 'camera');
      },
      {
        videoBitsPerSecond: profile.cameraBitrate,
        videoFrameRate: profile.cameraFrameRate,
        videoMaxWidth: profile.cameraWidth,
        videoMaxHeight: profile.cameraHeight,
        onStreamRestart: () => connection.send(new Uint8Array([5, 1])),
        onCongestion: () => {
          if (ctx.connection === connection) retryVideo(ctx, 'camera');
        },
        onSendError: (cause) => {
          if (ctx.connection === connection) recover(ctx, cause);
        },
      },
    );
  }
  async function limitFrameRate(
    tracks: MediaStreamTrack[],
    frameRate: number,
    width?: number,
    height?: number,
  ) {
    await Promise.all(
      tracks.map((track) =>
        track
          .applyConstraints?.({
            frameRate: { ideal: frameRate, max: frameRate },
            ...(width ? { width: { ideal: width, max: width } } : {}),
            ...(height ? { height: { ideal: height, max: height } } : {}),
          })
          .catch(() => {}),
      ),
    );
  }
  function disableRemoteVideo(ctx: Context, kind: 'camera' | 'screen') {
    if (!alive(ctx)) return;
    if (kind === 'camera') {
      ctx.videoReceiver?.close();
      ctx.videoReceiver = undefined;
      remoteVideoUrl = '';
    } else {
      ctx.screenReceiver?.close();
      ctx.screenReceiver = undefined;
      remoteScreenUrl = '';
    }
    ctx.remoteVideoError = kind;
    deviceError = kind === 'screen' ? 'call.error.screen' : 'call.error.video';
    // Request a fresh ordered header on this media lane, leaving audio alone.
    if (ctx.mediaRecovery && allowVideoRetry(ctx, `receive:${kind}`))
      void ctx.connection?.send(new Uint8Array([10, kind === 'camera' ? 3 : 6])).catch(() => {});
  }
  function allowVideoRetry(ctx: Context, key: string): boolean {
    const now = Date.now();
    const retries = (ctx.videoRetries ??= new Map());
    const recent = (retries.get(key) ?? []).filter((at) => now - at < 30000);
    if (recent.length >= 2 || (recent.length && now - recent[recent.length - 1] < 2000))
      return false;
    retries.set(key, [...recent, now]);
    return true;
  }
  function retryVideo(ctx: Context, kind: 'camera' | 'screen') {
    if (!alive(ctx) || !ctx.ready) return;
    const timers = (ctx.videoRetryTimers ??= new Map());
    if (timers.has(kind)) return;
    ctx.remoteVideoError = undefined;
    if (!allowVideoRetry(ctx, `send:${kind}`)) {
      if (kind === 'camera') disableCamera(ctx);
      else {
        deviceError = 'call.error.screen';
        void stopScreenSharing();
      }
      return;
    }
    if (kind === 'camera') {
      ctx.stopVideoRecording?.();
      ctx.stopVideoRecording = undefined;
    } else {
      ctx.stopScreenRecording?.();
      ctx.stopScreenRecording = undefined;
    }
    deviceError = kind === 'camera' ? 'call.error.video' : 'call.error.screen';
    const revision = ctx.linkRevision;
    timers.set(
      kind,
      setTimeout(() => {
        timers.delete(kind);
        if (!alive(ctx) || !ctx.ready || ctx.linkRevision !== revision) return;
        if (kind === 'camera' && ctx.stream?.getVideoTracks().length)
          void startVideoRecording(ctx).catch(() => disableCamera(ctx));
        if (kind === 'screen' && ctx.screenStream) void resumeScreenRecording(ctx);
      }, 1000),
    );
  }
  function disableCamera(ctx: Context) {
    if (!alive(ctx) || !ctx.splitMedia) return;
    ctx.stopVideoRecording?.();
    ctx.stopVideoRecording = undefined;
    ctx.stream?.getVideoTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (ctx.stream) ctx.stream = new MediaStream(ctx.stream.getAudioTracks());
    localStream = ctx.stream ?? null;
    patch({ cameraMuted: true });
    ctx.remoteVideoError = undefined;
    deviceError = 'call.error.video';
    const connection = ctx.connection;
    if (ctx.ready)
      void connection?.send(new Uint8Array([5, 0])).catch((cause) => {
        if (ctx.connection === connection) recover(ctx, cause);
      });
  }
  async function resumeScreenRecording(ctx: Context) {
    const connection = ctx.connection,
      screen = ctx.screenStream,
      revision = ctx.linkRevision;
    if (!connection || !screen || !ctx.ready) return;
    const profile = deps.videoProfile?.() ?? DEFAULT_VIDEO_PROFILE;
    const stopScreen = () => {
      if (alive(ctx) && ctx.linkRevision === revision) {
        deviceError = 'call.error.screen';
        retryVideo(ctx, 'screen');
      }
    };
    try {
      await limitFrameRate(
        screen.getVideoTracks(),
        profile.screenFrameRate,
        profile.screenWidth,
        profile.screenHeight,
      );
      if (!alive(ctx) || ctx.linkRevision !== revision || ctx.screenStream !== screen) return;
      await connection.send(new Uint8Array([7, 1]));
      if (!alive(ctx) || ctx.linkRevision !== revision || ctx.screenStream !== screen) return;
      ctx.screenProfile = profile.screenBitrate;
      ctx.stopScreenRecording = deps.record(
        new MediaStream(screen.getVideoTracks()),
        ctx.packetVideo ? PACKET_VIDEO_MIME : CALL_VIDEO_MIME_TYPE,
        (frame) => {
          frame[0] = 6;
          return connection.send(frame);
        },
        stopScreen,
        {
          videoBitsPerSecond: profile.screenBitrate,
          videoFrameRate: profile.screenFrameRate,
          videoMaxWidth: profile.screenWidth,
          videoMaxHeight: profile.screenHeight,
          onStreamRestart: () => connection.send(new Uint8Array([7, 1])),
          onCongestion: stopScreen,
          onSendError: (cause) => {
            if (ctx.linkRevision === revision) recover(ctx, cause);
          },
        },
      );
    } catch {
      stopScreen();
    }
  }
  async function refreshVideoQuality() {
    const ctx = context;
    if (!ctx?.ready || !ctx.splitMedia) return;
    clearTimeout(ctx.qualityTimer);
    if (ctx.changingMedia) {
      ctx.qualityTimer = setTimeout(() => {
        if (alive(ctx)) void refreshVideoQuality();
      }, 150);
      return;
    }
    const profile = deps.videoProfile?.() ?? DEFAULT_VIDEO_PROFILE;
    const revision = ctx.linkRevision;
    let failed = false;
    ctx.changingMedia = true;
    try {
      if (ctx.stopVideoRecording && ctx.cameraProfile !== profile.cameraBitrate) {
        ctx.stopVideoRecording();
        ctx.stopVideoRecording = undefined;
        await startVideoRecording(ctx);
      }
      if (
        alive(ctx) &&
        ctx.ready &&
        ctx.stopScreenRecording &&
        ctx.screenProfile !== profile.screenBitrate
      ) {
        ctx.stopScreenRecording();
        ctx.stopScreenRecording = undefined;
        await resumeScreenRecording(ctx);
      }
    } catch {
      failed = true;
      if (ctx.linkRevision === revision) disableCamera(ctx);
    } finally {
      ctx.changingMedia = false;
      // A failed restart disabled this camera; do not reapply it at once.
      if (alive(ctx) && !failed) deps.onVideoQualityRefreshed?.();
    }
  }
  function dropLink(ctx: Context) {
    clearTimeout(ctx.qualityTimer);
    ctx.videoRetryTimers?.forEach(clearTimeout);
    ctx.videoRetryTimers?.clear();
    ctx.linkRevision++;
    ctx.ready = false;
    clearInterval(ctx.heartbeat);
    ctx.stopRecording?.();
    ctx.stopRecording = undefined;
    ctx.stopVideoRecording?.();
    ctx.stopVideoRecording = undefined;
    ctx.stopScreenRecording?.();
    ctx.stopScreenRecording = undefined;
    ctx.receiver?.close();
    ctx.receiver = undefined;
    ctx.videoReceiver?.close();
    ctx.videoReceiver = undefined;
    ctx.screenReceiver?.close();
    ctx.screenReceiver = undefined;
    ctx.connection?.close('failed');
    ctx.connection = undefined;
    void ctx.endpoint?.close().catch(() => {});
    ctx.endpoint = undefined;
    remoteMediaUrl = remoteVideoUrl = remoteScreenUrl = '';
    ctx.receivedMediaChanges = [];
  }
  function enterRecovery(ctx: Context) {
    if (ctx.recoveryStarted !== undefined) return;
    ctx.recoveryStarted = Date.now();
    ctx.recoveryAttempts = 0;
    ctx.attemptStarted = undefined;
    ctx.connectingAttempt = undefined;
    dropLink(ctx);
    patch({ phase: 'reconnecting' });
    clearTimeout(ctx.timeout);
    ctx.timeout = setTimeout(() => finish(ctx, 'timeout'), 20_000);
    ctx.recoveryTimer = setInterval(() => {
      if (!alive(ctx)) return;
      if (
        session?.direction === 'outgoing' &&
        ctx.attemptStarted !== undefined &&
        Date.now() - ctx.attemptStarted >= 10_000 &&
        ctx.recoveryAttempts < 2
      ) {
        void recoveryAttempt(ctx);
      } else if (ctx.recoveryOffer) {
        void deps
          .sendSignal(ctx.peer, {
            ...ctx.recoveryOffer,
            expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
          })
          .catch(() => {});
      } else if (session?.direction === 'incoming' && !ctx.attemptStarted) {
        requestRecovery(ctx);
      }
    }, 2000);
  }
  function requestRecovery(ctx: Context) {
    if (ctx.reconnectAttempt >= Number.MAX_SAFE_INTEGER) return;
    void deps
      .sendSignal(ctx.peer, {
        ...signal(ctx, 'reconnect'),
        reconnectAttempt: ctx.reconnectAttempt + 1,
      })
      .catch(() => {});
  }
  function recover(ctx: Context, cause?: unknown) {
    if (!alive(ctx)) return;
    if (!ctx.reconnectSupported || !session?.startedAt) {
      fail(ctx, cause);
      return;
    }
    if (ctx.recoveryStarted !== undefined) return;
    if (ctx.reconnectAttempt >= Number.MAX_SAFE_INTEGER) {
      fail(ctx, cause);
      return;
    }
    enterRecovery(ctx);
    if (session.direction === 'outgoing') void recoveryAttempt(ctx);
    else requestRecovery(ctx);
  }
  async function recoveryAttempt(ctx: Context, offer?: CallSignal) {
    if (!alive(ctx)) return;
    const attempt = offer?.reconnectAttempt ?? ctx.reconnectAttempt + 1;
    if (
      !Number.isSafeInteger(attempt) ||
      attempt <= ctx.reconnectAttempt ||
      ctx.recoveryAttempts >= 2
    )
      return;
    ctx.recoveryAttempts++;
    ctx.reconnectAttempt = attempt;
    ctx.attemptStarted = Date.now();
    ctx.recoveryOffer = undefined;
    ctx.connectingAttempt = undefined;
    dropLink(ctx);
    const revision = ctx.linkRevision;
    try {
      const endpoint = await deps.createEndpoint();
      if (!alive(ctx) || ctx.linkRevision !== revision) {
        void endpoint.close();
        return;
      }
      ctx.endpoint = endpoint;
      await endpoint.online();
      if (!alive(ctx) || ctx.linkRevision !== revision) return;
      ctx.localAddress = { id: endpoint.id(), relayUrl: endpoint.relay_url() };
      ctx.recoveryOffer = {
        ...signal(ctx, offer ? 'accept' : 'reconnect'),
        reconnectAttempt: attempt,
      };
      if (offer) void connect(ctx, offer);
      await deps.sendSignal(ctx.peer, ctx.recoveryOffer);
    } catch {
      // The recovery timer owns retries and the overall deadline. A late signal
      // acknowledgement or failed attempt must not tear down a replacement link.
    }
  }

  function checkMediaChangeRate(ctx: Context) {
    ctx.receivedMediaChanges = ctx.receivedMediaChanges.filter((at) => Date.now() - at < 10_000);
    if (ctx.receivedMediaChanges.length >= 12) throw new Error('Too many media changes');
    ctx.receivedMediaChanges.push(Date.now());
  }
  async function receiveFrames(ctx: Context, connection: CallConnection, revision: number) {
    try {
      while (alive(ctx) && ctx.connection === connection && ctx.linkRevision === revision) {
        const data = await connection.recv();
        if (!alive(ctx) || ctx.linkRevision !== revision) return;
        if (!data.length) throw new Error('Empty frame');
        ctx.lastReceivedAt = Date.now();
        if (data[0] === 2 && data.length === 1 && !ctx.ready) {
          const stream = ctx.stream;
          const connection = ctx.connection;
          if (!stream || !connection) throw new Error('Call media is not ready');
          ctx.ready = true;
          clearTimeout(ctx.timeout);
          clearInterval(ctx.recoveryTimer);
          ctx.recoveryTimer = undefined;
          ctx.recoveryStarted = undefined;
          ctx.recoveryOffer = undefined;
          patch({ phase: 'active', startedAt: session?.startedAt ?? new Date().toISOString() });
          sendMuteState(ctx);
          startAudioRecording(ctx);
          if (ctx.splitMedia && stream.getVideoTracks().length)
            void startVideoRecording(ctx).catch(() => {
              if (ctx.linkRevision === revision) disableCamera(ctx);
            });
          if (ctx.screenStream) void resumeScreenRecording(ctx);
        } else if (data[0] === AUDIO_PACKET_KIND && ctx.packetAudio && ctx.ready) {
          ctx.receiver?.append(data);
        } else if (data[0] === 0 && data.length > 1 && ctx.ready && !ctx.packetAudio) {
          ctx.receiver?.append(data.subarray(1));
        } else if (data[0] === 3 && data.length > 1 && ctx.ready && ctx.splitMedia) {
          if (
            ctx.videoReceiver &&
            ctx.remoteVideoError === 'camera' &&
            deviceError === 'call.error.video'
          ) {
            ctx.remoteVideoError = undefined;
            deviceError = '';
          }
          ctx.videoReceiver?.append(data.subarray(1));
        } else if (data[0] === 4 && data.length === 1 && ctx.ready && ctx.splitMedia) {
          checkMediaChangeRate(ctx);
          if (ctx.packetAudio) continue;
          ctx.receiver?.close();
          ctx.receiver = deps.createReceiver(CALL_MIME_TYPES[1], () => {
            if (ctx.linkRevision === revision) fail(ctx, new Error('Audio decoder failed'));
          });
          remoteMediaUrl = ctx.receiver.url;
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
          remoteVideoUrl = '';
          if (data[1] === 1) {
            if (!deps.supported('video')) throw new Error('Video is unsupported');
            try {
              ctx.videoReceiver = deps.createReceiver(
                ctx.packetVideo ? PACKET_VIDEO_MIME : CALL_VIDEO_MIME_TYPE,
                () => {
                  if (ctx.linkRevision === revision) disableRemoteVideo(ctx, 'camera');
                },
              );
              remoteVideoUrl = ctx.videoReceiver.url;
            } catch {
              disableRemoteVideo(ctx, 'camera');
            }
          }
        } else if (
          data[0] === 6 &&
          data.length > 1 &&
          ctx.ready &&
          ctx.splitMedia &&
          session?.screenAvailable
        ) {
          if (
            ctx.screenReceiver &&
            ctx.remoteVideoError === 'screen' &&
            deviceError === 'call.error.screen'
          ) {
            ctx.remoteVideoError = undefined;
            deviceError = '';
          }
          ctx.screenReceiver?.append(data.subarray(1));
        } else if (
          data[0] === 7 &&
          data.length === 2 &&
          (data[1] === 0 || data[1] === 1) &&
          ctx.ready &&
          ctx.splitMedia &&
          session?.screenAvailable
        ) {
          checkMediaChangeRate(ctx);
          ctx.screenReceiver?.close();
          ctx.screenReceiver = undefined;
          remoteScreenUrl = '';
          if (data[1] === 1) {
            try {
              ctx.screenReceiver = deps.createReceiver(
                ctx.packetVideo ? PACKET_VIDEO_MIME : CALL_VIDEO_MIME_TYPE,
                () => {
                  if (ctx.linkRevision === revision) disableRemoteVideo(ctx, 'screen');
                },
              );
              remoteScreenUrl = ctx.screenReceiver.url;
            } catch {
              disableRemoteVideo(ctx, 'screen');
            }
          }
        } else if (
          data[0] === 10 &&
          data.length === 2 &&
          ctx.ready &&
          ctx.mediaRecovery &&
          (data[1] === 3 || data[1] === 6)
        ) {
          checkMediaChangeRate(ctx);
          retryVideo(ctx, data[1] === 3 ? 'camera' : 'screen');
        } else if (
          data[0] === 8 &&
          data.length === 2 &&
          (data[1] === 0 || data[1] === 1) &&
          ctx.ready &&
          ctx.peerMuteStateSupported
        ) {
          patch({ remoteMicrophoneMuted: data[1] === 1 });
        } else if (data[0] !== 1 || data.length !== 1) {
          throw new Error('Unexpected call frame');
        }
      }
    } catch (cause) {
      if (!alive(ctx) || ctx.linkRevision !== revision) return;
      const reason = connection.end_reason?.();
      if (
        reason &&
        ['hangup', 'cancelled', 'declined', 'busy', 'timeout', 'unsupported'].includes(reason)
      ) {
        finish(ctx, reason as CallEndReason, false);
      } else {
        recover(ctx, cause);
      }
    }
  }
  async function receiveAudio(ctx: Context, connection: CallConnection, revision: number) {
    try {
      while (alive(ctx) && ctx.linkRevision === revision) {
        const packet = await connection.recvAudio!();
        if (!alive(ctx) || ctx.linkRevision !== revision) return;
        if (ctx.ready) ctx.receiver?.append(packet);
      }
    } catch (cause) {
      if (alive(ctx) && ctx.linkRevision === revision) recover(ctx, cause);
    }
  }
  async function connect(ctx: Context, invite: CallSignal) {
    if (!alive(ctx) || !invite.address || !ctx.endpoint) return;
    const endpoint = ctx.endpoint;
    const revision = ctx.linkRevision;
    if (ctx.recoveryStarted === undefined) {
      patch({ phase: 'connecting' });
      armTimeout(ctx, CALL_CONNECT_TIMEOUT_MS);
    }
    try {
      const connection =
        session?.direction === 'outgoing'
          ? await (ctx.multiplexed && endpoint.multiplexed
              ? endpoint.connect(invite.address.id, invite.address.relayUrl, ctx.id, true)
              : endpoint.connect(invite.address.id, invite.address.relayUrl, ctx.id))
          : await (ctx.multiplexed && endpoint.multiplexed
              ? endpoint.accept(invite.address.id, ctx.id, true)
              : endpoint.accept(invite.address.id, ctx.id));
      if (!alive(ctx) || ctx.linkRevision !== revision) {
        connection.close();
        return;
      }
      ctx.connection = connection;
      ctx.packetVideo = Boolean(ctx.localPacketVideo && ctx.peerPacketVideo);
      ctx.packetAudio = Boolean(
        ctx.releasePacketAudio && ctx.peerPacketAudio && endpoint.datagrams,
      );
      ctx.receiver = deps.createReceiver(
        ctx.packetAudio ? OPUS_CALL_MIME : ctx.splitMedia ? CALL_MIME_TYPES[1] : ctx.mime,
        () => {
          if (ctx.linkRevision === revision) fail(ctx, new Error('Audio decoder failed'));
        },
      );
      remoteMediaUrl = ctx.receiver.url;
      ctx.lastReceivedAt = Date.now();
      ctx.heartbeat = setInterval(() => {
        if (!alive(ctx)) return;
        if (Date.now() - ctx.lastReceivedAt > 15_000) {
          recover(ctx, new Error('Call heartbeat timed out'));
          return;
        }
        if (connection.transportStats && !ctx.statsPending) {
          ctx.statsPending = true;
          void connection
            .transportStats()
            .then((stats) => {
              if (alive(ctx) && ctx.linkRevision === revision) transportDiagnostics = stats;
            })
            .catch(() => {})
            .finally(() => {
              ctx.statsPending = false;
            });
        }
        void connection.send(new Uint8Array([1])).catch((cause) => {
          if (ctx.linkRevision === revision) recover(ctx, cause);
        });
      }, 3000);
      void receiveFrames(ctx, connection, revision);
      if (ctx.packetAudio && connection.recvAudio) void receiveAudio(ctx, connection, revision);
      await connection.send(new Uint8Array([2]));
    } catch (cause) {
      if (ctx.linkRevision === revision) recover(ctx, cause);
    }
  }
  async function start(peerInput: string, mode: CallMode) {
    if (context) return;
    const peer = inputSanitizerService.normalizeHexKey(peerInput);
    if (!peer || peer === deps.getOwnPubkey() || !deps.getOwnPubkey()) return;
    if (!deps.supported(mode)) {
      error = 'call.error.unsupported';
      return;
    }
    deps.unlockPlayback?.();
    // Reserve before asynchronous checks so rapid clicks cannot create multiple endpoints.
    const ctx = reserve(peer, peer.slice(0, 12), mode, 'outgoing', crypto.randomUUID());
    preparePacketMedia(ctx);
    try {
      const contact = await deps.resolvePeer(peer);
      if (!alive(ctx)) return;
      if (!contact) {
        error = 'call.error.unavailable';
        finish(ctx, 'failed', false);
        return;
      }
      patch({ peerName: contact.name });
      if (!(await prepare(ctx))) return;
      patch({ phase: 'outgoing' });
      armTimeout(ctx, CALL_RING_TIMEOUT_MS);
      ctx.inviteSent = true;
      try {
        await deps.sendSignal(peer, signal(ctx, 'invite'));
      } catch (cause) {
        // An authenticated ringing/accept response proves delivery even if the
        // publishing relay loses its acknowledgement. Do not end that call.
        if (!ctx.peerConfirmed) throw cause;
      }
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
    if (incoming.action === 'reconnect' || incoming.reconnectAttempt !== undefined) {
      if (
        !ctx ||
        ctx.peer !== peer ||
        ctx.id !== incoming.callId ||
        !ctx.reconnectSupported ||
        !session?.startedAt ||
        incoming.mode !== ctx.mode ||
        incoming.mimeType !== ctx.mime ||
        !incoming.address ||
        !incoming.reconnectAttempt
      )
        return;
      const attempt = incoming.reconnectAttempt;
      if (attempt > ctx.reconnectAttempt + 2) return;
      if (incoming.action === 'accept') {
        if (
          session.direction === 'outgoing' &&
          session.phase === 'reconnecting' &&
          attempt === ctx.reconnectAttempt &&
          ctx.connectingAttempt !== attempt
        ) {
          ctx.connectingAttempt = attempt;
          void connect(ctx, incoming);
        }
      } else if (incoming.action === 'reconnect') {
        if (session.direction === 'outgoing') {
          // A guest requests recovery; only the original caller allocates attempts.
          if (attempt <= ctx.reconnectAttempt) return;
          recover(ctx);
        } else if (attempt > ctx.reconnectAttempt) {
          enterRecovery(ctx);
          void recoveryAttempt(ctx, incoming);
        } else if (session.phase === 'reconnecting' && ctx.recoveryOffer) {
          void deps.sendSignal(ctx.peer, ctx.recoveryOffer).catch(() => {});
        }
      }
      return;
    }
    if (incoming.action === 'ringing') {
      if (
        ctx?.peer === peer &&
        ctx.id === incoming.callId &&
        ctx.mode === incoming.mode &&
        session?.phase === 'outgoing'
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
        session?.phase === 'outgoing'
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
    if (!ctx || !invite || session?.phase !== 'incoming') return;
    deps.unlockPlayback?.();
    preparePacketMedia(ctx);
    const captureMode = mode === 'audio' ? 'audio' : ctx.mode;
    patch({ phase: 'preparing', cameraMuted: captureMode === 'audio' });
    try {
      if (!(await prepare(ctx, captureMode))) return;
      // Start accepting before publication so a fast caller cannot outrun the listener.
      void connect(ctx, invite);
      try {
        await deps.sendSignal(ctx.peer, signal(ctx, 'accept'));
      } catch (cause) {
        // The caller could only establish this authenticated connection after
        // receiving our fresh endpoint address. A late relay error is obsolete.
        if (!ctx.connection && !session?.startedAt) throw cause;
      }
    } catch (cause) {
      fail(ctx, cause);
    }
  }
  function end() {
    const ctx = context;
    if (ctx)
      finish(
        ctx,
        session?.phase === 'incoming' ? 'declined' : session?.startedAt ? 'hangup' : 'cancelled',
      );
  }
  function sendMuteState(ctx: Context) {
    const connection = ctx.connection;
    if (ctx.ready && ctx.peerMuteStateSupported)
      void connection
        ?.send(new Uint8Array([8, session?.microphoneMuted ? 1 : 0]))
        .catch((cause) => {
          if (ctx.connection === connection) recover(ctx, cause);
        });
  }
  function toggleMicrophone() {
    if (!context?.stream || !session) return;
    const muted = !session.microphoneMuted;
    context.stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    if (muted && !context.packetAudio) {
      context.resetAudioOnUnmute = true;
      if (context.splitMedia) {
        // Stop legacy encoders from draining captured speech after mute under
        // load. Keep the microphone track and restart its timeline on unmute.
        context.stopRecording?.();
        context.stopRecording = undefined;
        // Discard already-buffered speech too. This reset shares the ordered
        // audio lane, so old frames cannot reappear after it. Unmute starts a
        // fresh header as usual; camera and screen decoders remain untouched.
        const ctx = context,
          connection = ctx.connection;
        void connection?.send(new Uint8Array([4])).catch((cause) => {
          if (ctx.connection === connection) recover(ctx, cause);
        });
      }
    }
    patch({ microphoneMuted: muted });
    sendMuteState(context);
    if (!muted) void resumeMutedRecording(context);
  }
  async function resumeMutedRecording(ctx: Context) {
    // WebKit can stop or change the timestamps of a recorder with a disabled
    // track. Renew the legacy audio timeline on unmute, preserving the capture
    // and video lane. Packet audio keeps its continuous sequence.
    if (!ctx.resetAudioOnUnmute || !ctx.splitMedia || !ctx.ready || ctx.changingMedia) return;
    const connection = ctx.connection,
      stream = ctx.stream,
      generation = ctx.audioGeneration;
    if (!connection || !stream) return;
    ctx.resetAudioOnUnmute = false;
    try {
      ctx.stopRecording?.();
      ctx.stopRecording = undefined;
      await connection.send(new Uint8Array([4]));
      if (
        alive(ctx) &&
        ctx.connection === connection &&
        ctx.stream === stream &&
        ctx.audioGeneration === generation
      )
        startAudioRecording(ctx);
    } catch (cause) {
      if (alive(ctx) && ctx.connection === connection) recover(ctx, cause);
    }
  }
  async function selectMicrophone(deviceId: string) {
    const ctx = context;
    // A link that is down still switches, so reconnecting never resends the old input.
    if (!ctx?.stream || ctx.changingMedia || typeof deviceId !== 'string' || deviceId.length > 512)
      return;
    // Before the peer confirms nothing records yet, so the input can be replaced outright.
    const legacy = () => ctx.peerConfirmed && !ctx.splitMedia;
    if (legacy() || !deps.getMicrophone) {
      deviceError = 'call.error.peerUpgrade';
      return;
    }
    ctx.changingMedia = changingMedia = true;
    const revision = ctx.linkRevision;
    deviceError = '';
    let replacement: MediaStream | undefined;
    try {
      replacement = await deps.getMicrophone(deviceId);
      if (!alive(ctx) || ctx.linkRevision !== revision || legacy()) {
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
        track.enabled = !session?.microphoneMuted;
        track.onended = () =>
          captureFailed(ctx, new DOMException('Microphone disconnected', 'NotFoundError'));
      }
      ctx.stream = new MediaStream([...nextTracks, ...ctx.stream.getVideoTracks()]);
      localStream = ctx.stream;
      microphoneDeviceId = nextTracks[0]?.getSettings().deviceId ?? deviceId;
      previous.forEach((track) => {
        track.onended = null;
        track.stop();
      });
      // The old recorder is stopped before this ordered reset; its pending chunks are cancelled.
      if (ctx.ready) await ctx.connection?.send(new Uint8Array([4]));
      if (alive(ctx) && ctx.linkRevision === revision) startAudioRecording(ctx);
    } catch (cause) {
      // A rejected new device leaves the current microphone and call intact.
      if (replacement && replacement !== ctx.stream)
        replacement.getTracks().forEach((track) => {
          if (!ctx.stream?.getTracks().includes(track)) track.stop();
        });
      if (alive(ctx) && ctx.linkRevision === revision) {
        if (
          replacement &&
          ctx.stream?.getAudioTracks().some((track) => replacement?.getTracks().includes(track))
        )
          recover(ctx, cause);
        else deviceError = callCaptureErrorKey(cause);
      }
    } finally {
      ctx.changingMedia = false;
      if (alive(ctx)) changingMedia = false;
      if (alive(ctx) && !session?.microphoneMuted) void resumeMutedRecording(ctx);
    }
  }
  async function selectCamera(deviceId: string) {
    if (!context?.ready || !session || changingMedia) return;
    if (!context.splitMedia || !session.videoAvailable) {
      deviceError = 'call.error.peerUpgrade';
      return;
    }
    // Choosing a source while muted must not turn the camera on.
    if (session.cameraMuted) {
      cameraDeviceId = deviceId;
      return;
    }
    await updateCamera(deviceId);
  }
  async function toggleCamera() {
    await updateCamera();
  }
  async function updateCamera(deviceId?: string) {
    const ctx = context;
    if (!ctx?.stream || !session || ctx.changingMedia) return;
    if (!ctx.splitMedia) {
      if (!ctx.ready) return;
      if (ctx.mode !== 'video') {
        deviceError = 'call.error.peerUpgrade';
        return;
      }
      const muted = !session.cameraMuted;
      ctx.stream.getVideoTracks().forEach((track) => {
        track.enabled = !muted;
      });
      patch({ cameraMuted: muted });
      return;
    }
    if (!deps.getCamera || !session.videoAvailable) return;
    const turningOff = !session.cameraMuted && deviceId === undefined;
    // Turning off must not wait for a link: a reconnect would resend the live track.
    if (!ctx.ready && !turningOff) return;
    clearTimeout(ctx.videoRetryTimers?.get('camera'));
    ctx.videoRetryTimers?.delete('camera');
    ctx.changingMedia = changingMedia = true;
    const revision = ctx.linkRevision;
    deviceError = '';
    let camera: MediaStream | undefined;
    let installed = false;
    try {
      if (turningOff) {
        ctx.stopVideoRecording?.();
        ctx.stopVideoRecording = undefined;
        const tracks = ctx.stream.getVideoTracks();
        ctx.stream = new MediaStream(ctx.stream.getAudioTracks());
        localStream = ctx.stream;
        patch({ cameraMuted: true });
        tracks.forEach((track) => {
          track.onended = null;
          track.stop();
        });
        if (ctx.ready) await ctx.connection?.send(new Uint8Array([5, 0]));
      } else {
        camera = await deps.getCamera(deviceId ?? cameraDeviceId);
        if (!alive(ctx) || ctx.linkRevision !== revision) {
          camera.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        if (!camera.getVideoTracks().length)
          throw new DOMException('No camera track', 'NotFoundError');
        const previous = ctx.stream.getVideoTracks();
        ctx.stopVideoRecording?.();
        ctx.stopVideoRecording = undefined;
        ctx.stream = new MediaStream([...ctx.stream.getAudioTracks(), ...camera.getVideoTracks()]);
        installed = true;
        cameraDeviceId =
          camera.getVideoTracks()[0]?.getSettings?.().deviceId ?? deviceId ?? cameraDeviceId;
        previous.forEach((track) => {
          track.onended = null;
          track.stop();
        });
        localStream = ctx.stream;
        camera.getVideoTracks().forEach((track) => {
          track.onended = () => disableCamera(ctx);
        });
        patch({ cameraMuted: false });
        await startVideoRecording(ctx);
      }
    } catch (cause) {
      if (alive(ctx) && ctx.linkRevision === revision) {
        if (installed) disableCamera(ctx);
        else deviceError = callCaptureErrorKey(cause);
      }
      camera?.getTracks().forEach((track) => {
        if (!ctx.stream?.getTracks().includes(track)) track.stop();
      });
    } finally {
      ctx.changingMedia = false;
      if (alive(ctx)) changingMedia = false;
    }
  }
  async function stopScreenSharing() {
    const ctx = context;
    if (!ctx) return;
    clearTimeout(ctx.videoRetryTimers?.get('screen'));
    ctx.videoRetryTimers?.delete('screen');
    const revision = ctx.linkRevision;
    ctx.screenRequest = undefined;
    ctx.stopScreenRecording?.();
    ctx.stopScreenRecording = undefined;
    ctx.screenStream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    ctx.screenStream = undefined;
    localScreenStream = null;
    patch({ screenSharing: false });
    try {
      if (ctx.ready && session?.screenAvailable) await ctx.connection?.send(new Uint8Array([7, 0]));
    } catch (cause) {
      if (ctx.linkRevision === revision) recover(ctx, cause);
    }
  }
  async function startScreenSharing() {
    const ctx = context;
    if (
      !ctx?.ready ||
      !ctx.connection ||
      !session?.screenAvailable ||
      !deps.getScreen ||
      ctx.screenStream ||
      ctx.screenRequest
    )
      return;
    const request = {};
    ctx.screenRequest = request;
    deviceError = '';
    let screen: MediaStream | undefined;
    try {
      // Capture is invoked before any await so the browser sees the user's gesture.
      screen = await deps.getScreen();
      if (!alive(ctx) || ctx.screenRequest !== request) {
        screen.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      if (!screen.getVideoTracks().length) throw new Error('No screen video track');
      ctx.screenStream = screen;
      localScreenStream = screen;
      patch({ screenSharing: true });
      screen.getTracks().forEach((track) => {
        track.onended = () => {
          void stopScreenSharing();
        };
      });
      await resumeScreenRecording(ctx);
    } catch {
      if (alive(ctx) && ctx.screenRequest === request) {
        ctx.remoteVideoError = undefined;
        deviceError = 'call.error.screen';
        if (ctx.screenStream) await stopScreenSharing();
      }
      screen?.getTracks().forEach((track) => {
        track.stop();
      });
    } finally {
      if (ctx.screenRequest === request) ctx.screenRequest = undefined;
    }
  }
  function reset() {
    generation += 1;
    end();
    session = null;
    incomingInvite = null;
    error = '';
    failureDetail = '';
    deviceError = '';
    tombstones.clear();
  }
  function dismiss() {
    if (!context) {
      session = null;
      error = '';
    }
  }
  return {
    get transportDiagnostics() {
      return transportDiagnostics;
    },
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
    get remoteMediaUrl() {
      return remoteMediaUrl;
    },
    set remoteMediaUrl(value) {
      remoteMediaUrl = value;
    },
    get remoteVideoUrl() {
      return remoteVideoUrl;
    },
    set remoteVideoUrl(value) {
      remoteVideoUrl = value;
    },
    get remoteScreenUrl() {
      return remoteScreenUrl;
    },
    set remoteScreenUrl(value) {
      remoteScreenUrl = value;
    },
    get localScreenStream() {
      return localScreenStream;
    },
    set localScreenStream(value) {
      localScreenStream = value;
    },
    refreshVideoQuality,
    startScreenSharing,
    stopScreenSharing,
    get error() {
      return error;
    },
    set error(value) {
      error = value;
    },
    get deviceError() {
      return deviceError;
    },
    set deviceError(value) {
      deviceError = value;
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
    get failureDetail() {
      return failureDetail;
    },
    set failureDetail(value) {
      failureDetail = value;
    },
    start,
    receiveSignal,
    accept,
    end,
    toggleMicrophone,
    selectMicrophone,
    toggleCamera,
    selectCamera,
    reset,
    dismiss,
  };
}
