import {
  MAX_AUDIO_PACKET_BYTES,
  MAX_NATIVE_AUDIO_BATCH,
  MAX_DECODE_BATCH,
} from './callAudioPackets.ts';
import {
  CallAudioQueue,
  CALL_AUDIO_BACKLOG_MS,
  CALL_AUDIO_QUEUE_FRAMES,
} from './callAudioQueue.ts';
import { isTauri } from '@tauri-apps/api/core';
import { callCaptureTrack } from './callSharedCapture.ts';
import { watchCallAudioContext } from './callAudioRecovery.ts';
import workerUrl from './callAudio.worker.ts?worker&url';
import workletUrl from './callAudio.worklet.js?url';
import { registerCallStream } from './callStreamRegistry.ts';
import type { CallMediaReceiver, CallRecordingOptions } from './callMediaService.ts';

type Listener = (message: {
  type: string;
  packet?: Uint8Array;
  at?: number;
  stats?: Record<string, unknown>;
  renderedSamples?: number;
  underrunSamples?: number;
  renderBufferedMs?: number;
}) => void;
interface Engine {
  context: AudioContext;
  worker: Worker;
  listeners: Map<number, Listener>;
  refs: number;
  recovery: ReturnType<typeof watchCallAudioContext>;
}
let engine: Engine | undefined;
let preparing: Promise<Engine> | undefined;
let nextId = 0;
// Only current stream counters are retained; no media, peer IDs or persistence.
const diagnostics = new Map<number, Record<string, unknown>>();
const sendDiagnostics = new Map<number, () => Record<string, unknown>>();
const captureDiagnostics = new Map<number, Record<string, unknown>>();
export const callPacketAudioDiagnostics = () => [...diagnostics.values()];
// Numeric counters and applied processing settings only; no audio or device IDs.
export const callAudioDiagnostics = () => ({
  at: performance.timeOrigin + performance.now(),
  context: engine?.context.state,
  outputLatencyMs: (engine?.context.outputLatency ?? 0) * 1000,
  capture: [...captureDiagnostics.values()],
  send: [...sendDiagnostics.values()].map((read) => read()),
  receive: callPacketAudioDiagnostics(),
});

export async function prepareCallPacketAudio(): Promise<(() => void) | undefined> {
  // WebKitGTK's realtime AudioWorklet thread can exhaust RLIMIT_RTTIME and
  // terminate the whole renderer under group-call load. Keep native Linux on
  // the negotiated WebM audio path; other engines still use packet audio.
  if (isTauri() && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent))
    return undefined;
  if (
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined' ||
    typeof Worker === 'undefined'
  )
    return undefined;
  try {
    if (!preparing)
      preparing = (async () => {
        const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        let worker: Worker;
        const listeners = new Map<number, Listener>();
        let deadline: ReturnType<typeof setTimeout>;
        try {
          worker = new Worker(workerUrl, { type: 'module' });
          if (context.sampleRate !== 48000) throw new Error('Unsupported audio sample rate');
          await Promise.race([
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(new Error('Audio initialization timed out')),
                5000,
              );
            }),
            Promise.all([
              context.audioWorklet.addModule(workletUrl),
              context.resume(),
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('Audio codec initialization timed out')),
                  5000,
                );
                worker.onerror = () => {
                  clearTimeout(timer);
                  reject(new Error('Audio worker failed'));
                };
                worker.onmessage = ({ data }) => {
                  if (data.type === 'ready') {
                    clearTimeout(timer);
                    resolve();
                  } else listeners.get(data.id)?.(data);
                };
                worker.postMessage({ type: 'boot' });
              }),
            ]),
          ]);
          clearTimeout(deadline);
          worker.onerror = () => {
            for (const listener of [...listeners.values()]) listener({ type: 'error' });
          };
          const recovery = watchCallAudioContext(context);
          return (engine = { context, worker, listeners, refs: 0, recovery });
        } catch (error) {
          clearTimeout(deadline);
          worker?.terminate();
          void context.close();
          throw error;
        }
      })();
    const current = await preparing;
    current.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--current.refs === 0) {
        current.recovery.close();
        current.worker.terminate();
        current.listeners.clear();
        diagnostics.clear();
        captureDiagnostics.clear();
        sendDiagnostics.clear();
        void current.context.close();
        if (engine === current) {
          engine = undefined;
          preparing = undefined;
        }
      }
    };
  } catch {
    preparing = undefined;
    return undefined;
  }
}

function audioNode(mode: 'capture' | 'playback', generation: number, listener: Listener) {
  if (!engine) throw new Error('Packet audio was not prepared');
  const current = engine;
  const id = ++nextId;
  const node = new AudioWorkletNode(current.context, 'anagram-call-audio', {
    numberOfInputs: mode === 'capture' ? 1 : 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: {
      mode,
      captureFrames: CALL_AUDIO_QUEUE_FRAMES,
      captureEpoch: performance.timeOrigin + performance.now() - current.context.currentTime * 1000,
    },
  });
  const clock = () => {
    if (mode === 'capture' && current.context.state === 'running')
      node.port.postMessage({
        captureEpoch:
          performance.timeOrigin + performance.now() - current.context.currentTime * 1000,
      });
  };
  current.context.addEventListener('statechange', clock);
  node.port.onmessage = ({ data }) => {
    // Device startup can delay the render clock after the initial epoch was
    // sampled. Rebase when capture actually starts so fresh PCM is not stale.
    // Already queued frames retain their original age and backlog limit.
    if (data.type === 'capture-started') clock();
    if (data.type === 'render') listener(data);
  };
  const channel = new MessageChannel();
  current.listeners.set(id, listener);
  node.onprocessorerror = () => listener({ type: 'error' });
  node.port.postMessage({ port: channel.port1 }, [channel.port1]);
  current.worker.postMessage(
    { id, generation, type: mode === 'capture' ? 'encode' : 'decode', port: channel.port2 },
    [channel.port2],
  );
  let closed = false;
  return {
    id,
    node,
    current,
    close() {
      if (closed) return;
      closed = true;
      current.listeners.delete(id);
      diagnostics.delete(id);
      captureDiagnostics.delete(id);
      current.context.removeEventListener('statechange', clock);
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.port.postMessage({ close: true });
      node.disconnect();
      node.port.close();
      current.worker.postMessage({ id, type: 'close' });
    },
  };
}

export function createPacketAudioReceiver(onError: () => void): CallMediaReceiver {
  let closed = false,
    pending = false;
  // Preserve IPC bursts in order, including while the decoder is briefly busy.
  type Arrival = { packet: Uint8Array; at: number };
  const queued = new CallAudioQueue<Arrival>();
  let received = 0;
  const report: Record<string, unknown> = { receivedAt: 0, decodedAt: 0, renderedAt: 0 };
  const post = (first: Arrival, now: number) => {
    const packets = [first];
    // A busy WebView can take longer than a 20 ms packet to process a worker
    // acknowledgement. Drain only packets already waiting, without delaying live audio.
    while (packets.length < MAX_DECODE_BATCH) {
      const next = queued.shift(now);
      if (!next) break;
      packets.push(next);
    }
    pending = true;
    state.current.worker.postMessage({ id: state.id, type: 'packets', packets });
  };
  const state = audioNode('playback', 0, (message) => {
    if (closed) return;
    if (message.type === 'error') onError();
    if (message.type === 'render') {
      Object.assign(report, {
        renderedSamples: message.renderedSamples,
        underrunSamples: message.underrunSamples,
        renderBufferedMs: message.renderBufferedMs,
        renderedAt: performance.timeOrigin + performance.now(),
      });
    }
    if (message.type === 'playout' || message.type === 'received') {
      Object.assign(report, message.stats, {
        receiveQueueMs: queued.ageMs(performance.now()),
        receiveQueueFrames: queued.length,
      });
      if (message.type === 'playout') report.decodedAt = performance.timeOrigin + performance.now();
    }
    diagnostics.set(state.id, { ...report });
    if (message.type === 'received') {
      pending = false;
      const now = performance.now();
      const next = queued.shift(now);
      if (next) post(next, now);
    }
  });
  const destination = state.current.context.createMediaStreamDestination();
  state.node.connect(destination);
  const handle = registerCallStream(destination.stream, () => received);
  return {
    url: handle.url,
    append(packet) {
      if (closed || packet.byteLength > MAX_AUDIO_PACKET_BYTES) return;
      const now = performance.now();
      received++;
      report.receivedAt = performance.timeOrigin + now;
      const arrival = { packet, at: performance.timeOrigin + now };
      if (pending) queued.push(arrival, now);
      else post(arrival, now);
    },
    close() {
      closed = true;
      queued.clear();
      state.close();
      destination.disconnect();
      handle.close();
    },
  };
}

function recordPacketAudioSource(
  stream: MediaStream,
  send: (packet: Uint8Array, capturedAt: number) => void,
  onError: () => void,
): () => void {
  let stopped = false;
  const state = audioNode('capture', 1, (message) => {
    if (stopped) return;
    if (message.type === 'error') {
      stop();
      onError();
      return;
    }
    if (message.type === 'packet' && message.packet) {
      state.current.worker.postMessage({ id: state.id, type: 'encoded' });
      if (
        message.at !== undefined &&
        performance.timeOrigin + performance.now() - message.at > CALL_AUDIO_BACKLOG_MS
      )
        return;
      const capturedAt =
        (message.at ?? performance.timeOrigin + performance.now()) - performance.timeOrigin;
      captureDiagnostics.set(state.id, {
        captureAgeMs: Math.max(0, performance.now() - capturedAt),
        encodedAt: performance.timeOrigin + performance.now(),
        ...processingSettings,
      });
      send(message.packet, capturedAt);
    }
  });
  const source = state.current.context.createMediaStreamSource(stream);
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings?.();
  const processingSettings = {
    echoCancellation: settings?.echoCancellation,
    noiseSuppression: settings?.noiseSuppression,
    autoGainControl: settings?.autoGainControl,
    sampleRate: settings?.sampleRate,
    channelCount: settings?.channelCount,
  };
  track.addEventListener('unmute', state.current.recovery.resume);
  source.connect(state.node);
  // A connected, silent output keeps capture processing alive in WebKit.
  state.node.connect(state.current.context.destination);
  function stop() {
    if (stopped) return;
    stopped = true;
    track.removeEventListener('unmute', state.current.recovery.resume);
    source.disconnect();
    state.close();
  }
  return stop;
}

// One encoder per room microphone, with a separate bounded sender per peer.
// A slow participant cannot hold up other participants or duplicate Opus work.
type AudioConsumer = {
  packet(data: Uint8Array, capturedAt: number): void;
  error(): void;
  close(): void;
};
const captures = new WeakMap<MediaStreamTrack, { consumers: Set<AudioConsumer>; stop(): void }>();
export function recordPacketAudio(
  stream: MediaStream,
  send: (packet: Uint8Array) => Promise<void>,
  onError: () => void,
  options?: CallRecordingOptions,
): () => void {
  const track = callCaptureTrack(stream.getAudioTracks()[0]);
  let shared = captures.get(track);
  if (!shared) {
    const consumers = new Set<AudioConsumer>();
    const stop = recordPacketAudioSource(
      new MediaStream([track]),
      (packet, capturedAt) => {
        for (const consumer of [...consumers]) consumer.packet(packet, capturedAt);
      },
      () => {
        for (const consumer of [...consumers]) consumer.error();
      },
    );
    shared = { consumers, stop };
    captures.set(track, shared);
  }
  const current = shared;
  let closed = false,
    inFlight = 0;
  const pending = new CallAudioQueue<Uint8Array>();
  const diagnosticId = ++nextId;
  sendDiagnostics.set(diagnosticId, () => ({
    inFlight,
    queuedFrames: pending.length,
    queueAgeMs: pending.ageMs(performance.now()),
  }));
  const transmit = async (packet: Uint8Array) => {
    inFlight++;
    const stamp = (packet: Uint8Array) => {
      const frame = packet.slice();
      new DataView(frame.buffer).setUint32(2, options?.audioGeneration ?? 1);
      return frame;
    };
    try {
      const first = stamp(packet);
      const now = performance.now();
      const second = options?.sendAudioBatch ? pending.shift(now) : undefined;
      if (second && options?.sendAudioBatch) {
        const frames = [first, stamp(second)];
        while (frames.length < MAX_NATIVE_AUDIO_BATCH) {
          const next = pending.shift(now);
          if (!next) break;
          frames.push(stamp(next));
        }
        await options.sendAudioBatch(frames);
      } else await send(first);
    } catch (error) {
      if (!closed) {
        close();
        (options?.onSendError ?? onError)(error);
      }
    } finally {
      inFlight--;
      if (!closed) {
        // Track muting silences future capture, not speech already queued for
        // this peer. Do not drain that backlog after a slow IPC send completes.
        if (!track.enabled) pending.clear();
        else {
          const next = pending.shift(performance.now());
          if (next) void transmit(next);
        }
      }
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    pending.clear();
    sendDiagnostics.delete(diagnosticId);
    current.consumers.delete(consumer);
    if (!current.consumers.size) {
      current.stop();
      captures.delete(track);
    }
  }
  const consumer: AudioConsumer = {
    error: onError,
    close,
    packet(data, capturedAt) {
      if (closed || performance.now() - capturedAt > CALL_AUDIO_BACKLOG_MS) return;
      // Encoded messages may arrive after the source was muted. The encoder is
      // still acknowledged upstream, but none of this speech should be sent.
      if (!track.enabled) {
        pending.clear();
        return;
      }
      // Retain two concurrent sends, but preserve speech queued behind a brief
      // IPC stall. Each peer drains independently of every other participant.
      if (inFlight >= 2) pending.push(data, performance.now(), capturedAt);
      else void transmit(data);
    },
  };
  current.consumers.add(consumer);
  return close;
}
