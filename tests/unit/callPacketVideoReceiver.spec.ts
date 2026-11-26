import { afterEach, expect, it, vi } from 'vitest';
import { createPacketVideoReceiver } from '#src/services/callPacketVideo.ts';

afterEach(() => vi.unstubAllGlobals());

function receiver() {
  const track = { requestFrame: vi.fn(), stop: vi.fn() };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ({ drawImage() {} }), captureStream: () => stream }),
  });
  let decoder!: {
    decodeQueueSize: number;
    ondequeue?: () => void;
    decode: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  vi.stubGlobal(
    'VideoDecoder',
    class {
      decodeQueueSize = 0;
      ondequeue?: () => void;
      decode = vi.fn(() => this.decodeQueueSize++);
      close = vi.fn();
      constructor() {
        decoder = this;
      }
      configure() {}
    },
  );
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  );
  const error = vi.fn();
  const media = createPacketVideoReceiver(error);
  const append = (timestamp: number, key = false) => {
    const bytes = new Uint8Array(20);
    bytes[0] = 1;
    bytes[1] = key ? 1 : 0;
    new DataView(bytes.buffer).setFloat64(2, timestamp);
    bytes.set(key ? [0, 0, 0, 0x9d, 1, 0x2a, 64, 0, 36, 0] : [1], 10);
    media.append(bytes);
  };
  const drain = () => {
    decoder.decodeQueueSize = 0;
    decoder.ondequeue?.();
  };
  const timestamps = () => decoder.decode.mock.calls.map(([chunk]) => chunk.timestamp);
  return { media, decoder, append, drain, timestamps, error, track };
}

it('decodes a short burst in order without discarding deltas and freezing until a keyframe', () => {
  const r = receiver();
  try {
    for (let i = 0; i < 6; i++) r.append(i * 40000, i === 0);
    expect(r.timestamps()).toEqual([0, 40000, 80000]);
    r.drain();
    expect(r.timestamps()).toEqual([0, 40000, 80000, 120000, 160000, 200000]);
    expect(r.decoder.decodeQueueSize).toBeLessThanOrEqual(3);
    expect(r.error).not.toHaveBeenCalled();
  } finally {
    r.media.close();
  }
  const count = r.timestamps().length;
  r.drain();
  expect(r.timestamps()).toHaveLength(count);
  expect(r.track.stop).toHaveBeenCalledOnce();
});

it('bounds a stalled decoder backlog and recovers only on an independent keyframe', () => {
  const r = receiver();
  try {
    for (let i = 0; i < 100; i++) r.append(i * 40000, i === 0);
    expect(r.timestamps()).toEqual([0, 40000, 80000]);
    r.drain();
    expect(r.timestamps()).toHaveLength(3);
    r.append(4000000, true);
    r.append(4040000);
    expect(r.timestamps()).toEqual([0, 40000, 80000, 4000000, 4040000]);
    expect(r.error).not.toHaveBeenCalled();
  } finally {
    r.media.close();
  }
});
