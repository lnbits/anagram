import { CallAudioPlayout } from './callAudioPlayout.ts';
import { CALL_AUDIO_BACKLOG_MS, CallAudioQueue } from './callAudioQueue.ts';
import { Application, createEncoder, createDecoder, loadLibopus } from 'libopus-wasm';
import {
  CallAudioJitterBuffer,
  MAX_DECODE_BATCH,
  packAudio,
  unpackAudio,
} from './callAudioPackets.ts';

type Stream = {
  close(): void;
  packet?(data: Uint8Array, arrival: number): Promise<void>;
  ack?(): void;
  stats?(): unknown;
};
const streams = new Map<number, Promise<Stream>>();
const send = (data: unknown) => globalThis.postMessage(data);
globalThis.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'boot') {
      await loadLibopus();
      send({ type: 'ready' });
      return;
    }
    if (data.type === 'close') {
      const stream = streams.get(id);
      streams.delete(id);
      (await stream)?.close();
      return;
    }
    if (data.type === 'encoded') {
      (await streams.get(id))?.ack?.();
      return;
    }
    if (data.type === 'packets') {
      if (
        !Array.isArray(data.packets) ||
        !data.packets.length ||
        data.packets.length > MAX_DECODE_BATCH
      )
        throw new Error('Invalid decoder batch');
      const stream = await streams.get(id);
      for (const { packet, at } of data.packets) {
        await stream?.packet?.(packet, at - performance.timeOrigin);
      }
      send({ id, type: 'received', stats: stream?.stats?.() });
      return;
    }
    if (streams.size >= 64 || streams.has(id)) throw new Error('Too many audio streams');
    const promise = (async (): Promise<Stream> => {
      const port: MessagePort = data.port;
      let closed = false;
      if (data.type === 'encode') {
        const encoder = await createEncoder({
          sampleRate: 48000,
          channels: 1,
          application: Application.Voip,
          bitrate: 32000,
          complexity: 4,
          fec: true,
          packetLossPercent: 10,
          dtx: false,
          frameSize: 960,
        });
        let credits = 2;
        const pending = new CallAudioQueue<{ packet: Uint8Array; at: number }>();
        const deliver = (frame: { packet: Uint8Array; at: number }) => {
          if (credits) {
            credits--;
            send({ id, type: 'packet', ...frame });
          } else pending.push(frame, performance.now(), frame.at - performance.timeOrigin);
        };
        port.onmessage = ({ data: input }) => {
          if (closed) return;
          try {
            const at = input.at ?? performance.timeOrigin + performance.now();
            if (performance.timeOrigin + performance.now() - at > CALL_AUDIO_BACKLOG_MS) return;
            const opus = encoder.encodeFloat(input.pcm, { frameSize: 960, maxPacketBytes: 1000 });
            deliver({
              at,
              packet: packAudio({
                generation: data.generation,
                sequence: input.sequence,
                timestamp: (input.sequence * 960) >>> 0,
                opus,
              }),
            });
          } catch {
            send({ id, type: 'error' });
          } finally {
            // Capture must not wait for a round trip through a busy WebView UI.
            // Encoded delivery has its own bounded FIFO queue.
            port.postMessage({ ack: true });
          }
        };
        return {
          ack() {
            credits = Math.min(2, credits + 1);
            if (!closed) {
              const frame = pending.shift(performance.now());
              if (frame) deliver(frame);
            }
          },
          close() {
            closed = true;
            pending.clear();
            port.close();
            encoder.free();
          },
        };
      }
      let decoder = await createDecoder({ sampleRate: 48000, channels: 1, maxFrameSize: 960 });
      let jitter = new CallAudioJitterBuffer();
      let generation: number | undefined;
      let playout = new CallAudioPlayout();
      let lastReport = 0;
      const stats = () => ({ ...jitter.stats, bufferedMs: jitter.bufferedMs, ...playout.stats });

      port.onmessage = () => {
        if (closed) return;
        try {
          const now = performance.now();
          const pcm = playout.pull(now, jitter, () => {
            const frame = jitter.pull(now);
            return frame && decoder
              ? decoder.decodeFloat(frame.packet?.opus ?? null, {
                  decodeFec: frame.fec,
                  frameSize: 960,
                  maxFrameSize: 960,
                })
              : new Float32Array(960);
          });
          if (now - lastReport >= 250) {
            lastReport = now;
            send({ id, type: 'playout', stats: stats() });
          }
          port.postMessage({ pcm }, [pcm.buffer]);
        } catch {
          send({ id, type: 'error' });
          port.postMessage({ pcm: new Float32Array(960) });
        }
      };
      return {
        async packet(bytes, arrival) {
          if (closed) return;
          const packet = unpackAudio(bytes);
          if (!packet) return;
          if (generation !== undefined && ((packet.generation - generation) | 0) < 0) return;
          if (generation !== packet.generation) {
            const previous = decoder;
            decoder = undefined;
            previous?.free();
            const replacement = await createDecoder({
              sampleRate: 48000,
              channels: 1,
              maxFrameSize: 960,
            });
            if (closed) {
              replacement.free();
              return;
            }
            decoder = replacement;
            jitter = new CallAudioJitterBuffer();
            playout = new CallAudioPlayout();
            generation = packet.generation;
          }
          jitter.push(packet, arrival);
        },
        stats,
        close() {
          closed = true;
          port.close();
          decoder?.free();
        },
      };
    })();
    streams.set(id, promise);
    await promise;
  } catch {
    send({ id, type: 'error' });
  }
};
