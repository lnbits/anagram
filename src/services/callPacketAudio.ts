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
  stats?: unknown;
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
const diagnostics = new Map<number, unknown>();
export const callPacketAudioDiagnostics = () => [...diagnostics.values()];

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
    processorOptions: { mode },
  });
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
  let latest: Uint8Array | undefined;
  const post = (packet: Uint8Array) => {
    pending = true;
    state.current.worker.postMessage({ id: state.id, type: 'packet', packet });
  };
  const state = audioNode('playback', 0, (message) => {
    if (closed) return;
    if (message.type === 'error') onError();
    if (message.type === 'received') {
      diagnostics.set(state.id, message.stats);
      pending = false;
      if (latest) {
        const packet = latest;
        latest = undefined;
        post(packet);
      }
    }
  });
  const destination = state.current.context.createMediaStreamDestination();
  state.node.connect(destination);
  const handle = registerCallStream(destination.stream);
  return {
    url: handle.url,
    append(packet) {
      if (closed) return;
      if (pending) latest = packet;
      else post(packet);
    },
    close() {
      closed = true;
      latest = undefined;
      state.close();
      destination.disconnect();
      handle.close();
    },
  };
}

function recordPacketAudioSource(
  stream: MediaStream,
  send: (packet: Uint8Array) => Promise<void>,
  onError: () => void,
  options?: CallRecordingOptions,
): () => void {
  let stopped = false,
    sending = false;
  let latest: { packet: Uint8Array; at: number } | undefined;
  const transmit = async (packet: Uint8Array) => {
    sending = true;
    try {
      await send(packet);
      sending = false;
      if (stopped) return;
      if (latest) {
        const next = latest;
        latest = undefined;
        if (performance.now() - next.at < 100) void transmit(next.packet);
      }
    } catch (error) {
      if (!stopped) {
        stop();
        (options?.onSendError ?? onError)(error);
      }
    }
  };
  const state = audioNode('capture', options?.audioGeneration ?? 1, (message) => {
    if (stopped) return;
    if (message.type === 'error') {
      stop();
      onError();
      return;
    }
    if (message.type === 'packet' && message.packet) {
      state.current.worker.postMessage({ id: state.id, type: 'encoded' });
      if (message.at !== undefined && performance.timeOrigin + performance.now() - message.at > 100)
        return;
      if (sending) latest = { packet: message.packet, at: performance.now() };
      else void transmit(message.packet);
    }
  });
  const source = state.current.context.createMediaStreamSource(stream);
  const track = stream.getAudioTracks()[0];
  track.addEventListener('unmute', state.current.recovery.resume);
  source.connect(state.node);
  // A connected, silent output keeps capture processing alive in WebKit.
  state.node.connect(state.current.context.destination);
  function stop() {
    if (stopped) return;
    stopped = true;
    latest = undefined;
    track.removeEventListener('unmute', state.current.recovery.resume);
    source.disconnect();
    state.close();
  }
  return stop;
}

// One encoder per room microphone, with a separate bounded sender per peer.
// A slow participant cannot hold up other participants or duplicate Opus work.
type AudioConsumer = { packet(data: Uint8Array): void; error(): void; close(): void };
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
      async (packet) => {
        for (const consumer of [...consumers]) consumer.packet(packet);
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
  let pending: { packet: Uint8Array; at: number } | undefined;
  const transmit = async (packet: Uint8Array) => {
    inFlight++;
    const frame = packet.slice();
    new DataView(frame.buffer).setUint32(2, options?.audioGeneration ?? 1);
    try {
      await send(frame);
    } catch (error) {
      if (!closed) {
        close();
        (options?.onSendError ?? onError)(error);
      }
    } finally {
      inFlight--;
      if (!closed && pending) {
        const next = pending;
        pending = undefined;
        if (performance.now() - next.at <= 100) void transmit(next.packet);
      }
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    pending = undefined;
    current.consumers.delete(consumer);
    if (!current.consumers.size) {
      current.stop();
      captures.delete(track);
    }
  }
  const consumer: AudioConsumer = {
    error: onError,
    close,
    packet(data) {
      if (closed) return;
      // Two datagrams may await native IPC acknowledgements; a single round trip
      // can exceed the 20 ms packet period. Only one latest packet waits behind them.
      if (inFlight >= 2) pending = { packet: data, at: performance.now() };
      else void transmit(data);
    },
  };
  current.consumers.add(consumer);
  return close;
}
