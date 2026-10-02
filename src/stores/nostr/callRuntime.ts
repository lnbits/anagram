import type { CallMediaReceiver } from 'src/services/callMediaService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_PROTOCOL,
  CALL_RING_TIMEOUT_MS,
  type CallConnection,
  type CallEndpoint,
  type CallEndReason,
  type CallMode,
  type CallSession,
  type CallSignal,
} from 'src/types/call';
import { CALL_MIME_TYPES } from 'src/utils/callSignal';
import { ref, shallowRef } from 'vue';

interface CallRuntimeDeps {
  sendSignal(peer: string, signal: CallSignal): Promise<void>;
  getOwnPubkey(): string | null;
  resolvePeer(peer: string): Promise<{ name: string } | null>;
  supported(mode: CallMode): boolean;
  hasSeen?(peer: string, id: string): boolean;
  remember?(peer: string, id: string): void;
  createEndpoint(): Promise<CallEndpoint>;
  getMedia(mode: CallMode): Promise<MediaStream>;
  createReceiver(mime: string, onError: () => void): CallMediaReceiver;
  record(
    stream: MediaStream,
    mime: string,
    send: (data: Uint8Array) => Promise<void>,
    onError: () => void
  ): () => void;
}
interface Context {
  id: string;
  peer: string;
  mode: CallMode;
  endpoint?: CallEndpoint;
  connection?: CallConnection;
  receiver?: CallMediaReceiver;
  stream?: MediaStream;
  stopRecording?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  mime: string;
  lastReceivedAt: number;
  ready: boolean;
}

export function createCallRuntime(deps: CallRuntimeDeps) {
  const session = shallowRef<CallSession | null>(null);
  const localStream = shallowRef<MediaStream | null>(null);
  const remoteMediaUrl = ref('');
  const error = ref('');
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
    if (action !== 'end' && !ctx.endpoint) throw new Error('Call endpoint is not ready');
    return {
      protocol: CALL_PROTOCOL,
      callId: ctx.id,
      action,
      mode: ctx.mode,
      expiresAt: new Date(Date.now() + CALL_RING_TIMEOUT_MS).toISOString(),
      ...(action === 'end'
        ? { reason: reason ?? 'hangup' }
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
    clearInterval(ctx.heartbeat);
    ctx.stopRecording?.();
    ctx.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    ctx.connection?.close(reason);
    void ctx.endpoint?.close().catch(() => {});
    ctx.receiver?.close();
    localStream.value = null;
    remoteMediaUrl.value = '';
    patch({ phase: 'ended', endReason: reason });
    if (notify) void deps.sendSignal(ctx.peer, signal(ctx, 'end', reason)).catch(() => {});
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
    };
    context = ctx;
    error.value = '';
    failureDetail.value = '';
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
    };
    armTimeout(ctx, CALL_RING_TIMEOUT_MS);
    return ctx;
  }
  async function prepare(ctx: Context) {
    const stream = await deps.getMedia(ctx.mode);
    if (!alive(ctx)) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return false;
    }
    ctx.stream = stream;
    localStream.value = stream;
    for (const track of stream.getTracks()) track.onended = () => fail(ctx);
    const endpoint = await deps.createEndpoint();
    if (!alive(ctx)) {
      void endpoint.close();
      return false;
    }
    ctx.endpoint = endpoint;
    await endpoint.online();
    return alive(ctx);
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
          ctx.stopRecording = deps.record(
            stream,
            ctx.mime,
            (frame) => connection.send(frame),
            () => fail(ctx)
          );
        } else if (data[0] === 0 && data.length > 1 && ctx.ready) {
          ctx.receiver?.append(data.subarray(1));
        } else if (data[0] !== 1 || data.length !== 1) {
          throw new Error('Unexpected call frame');
        }
      }
    } catch (cause) {
      const reason = ctx.connection?.end_reason?.();
      if (reason && ['hangup', 'cancelled', 'declined', 'busy', 'timeout'].includes(reason)) {
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
      ctx.receiver = deps.createReceiver(ctx.mime, () => fail(ctx));
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
      await deps.sendSignal(peer, signal(ctx, 'invite'));
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
    if (incoming.action === 'accept') {
      if (
        ctx?.peer === peer &&
        ctx.id === incoming.callId &&
        incoming.mode === ctx.mode &&
        incoming.mimeType === ctx.mime &&
        session.value?.phase === 'outgoing'
      ) {
        void connect(ctx, incoming);
      }
      return;
    }
    if (seen(peer, incoming.callId) || ctx?.id === incoming.callId) return;
    const contact = await deps.resolvePeer(peer);
    if (receivedGeneration !== generation || deps.getOwnPubkey() !== own) return;
    if (!contact || Date.parse(incoming.expiresAt) <= Date.now()) return;
    if (seen(peer, incoming.callId) || context?.id === incoming.callId) return;
    if (context || !deps.supported(incoming.mode)) {
      remember(peer, incoming.callId);
      void deps
        .sendSignal(peer, {
          ...incoming,
          action: 'end',
          address: undefined,
          mimeType: undefined,
          reason: context ? 'busy' : 'failed',
        })
        .catch(() => {});
      return;
    }
    incomingInvite = incoming;
    remember(peer, incoming.callId);
    const next = reserve(peer, contact.name, incoming.mode, 'incoming', incoming.callId);
    armTimeout(next, Math.max(1, Date.parse(incoming.expiresAt) - Date.now()));
  }
  async function accept() {
    const ctx = context;
    const invite = incomingInvite;
    if (!ctx || !invite || session.value?.phase !== 'incoming') return;
    patch({ phase: 'preparing' });
    try {
      if (!(await prepare(ctx))) return;
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
  function toggleCamera() {
    if (!context?.stream || !session.value || context.mode !== 'video') return;
    const muted = !session.value.cameraMuted;
    context.stream.getVideoTracks().forEach((track) => {
      track.enabled = !muted;
    });
    patch({ cameraMuted: muted });
  }
  function reset() {
    generation += 1;
    end();
    session.value = null;
    incomingInvite = null;
    error.value = '';
    failureDetail.value = '';
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
    error,
    failureDetail,
    start,
    receiveSignal,
    accept,
    end,
    toggleMicrophone,
    toggleCamera,
    reset,
    dismiss,
  };
}
