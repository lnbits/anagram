import { CallAudioQueue } from './callAudioQueue.ts';
import { Application, createEncoder, createDecoder, loadLibopus } from 'libopus-wasm';
import { CallAudioJitterBuffer, packAudio, unpackAudio } from './callAudioPackets.ts';

type Stream = {
  close(): void;
  packet?(data: Uint8Array): Promise<void>;
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
    if (data.type === 'packet') {
      const stream = await streams.get(id);
      await stream?.packet?.(data.packet);
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
          } else pending.push(frame, performance.now());
        };
        port.onmessage = ({ data: input }) => {
          if (closed) return;
          try {
            const opus = encoder.encodeFloat(input.pcm, { frameSize: 960, maxPacketBytes: 1000 });
            deliver({
              at: performance.timeOrigin + performance.now(),
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

      port.onmessage = () => {
        if (closed) return;
        try {
          const frame = jitter.pull(performance.now());
          const pcm =
            frame && decoder
              ? decoder.decodeFloat(frame.packet?.opus ?? null, {
                  decodeFec: frame.fec,
                  frameSize: 960,
                  maxFrameSize: 960,
                })
              : new Float32Array(960);
          // Only the negotiated 20 ms format is accepted, including malformed peers.
          if (pcm.length !== 960) throw new Error('Unexpected audio duration');
          port.postMessage({ pcm }, [pcm.buffer]);
        } catch {
          send({ id, type: 'error' });
          port.postMessage({ pcm: new Float32Array(960) });
        }
      };
      return {
        async packet(bytes) {
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
            generation = packet.generation;
          }
          jitter.push(packet, performance.now());
        },
        stats: () => jitter.stats,
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
