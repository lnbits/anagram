import { afterEach, expect, it, vi } from 'vitest';
import { recordPacketVideo } from '#src/services/callPacketVideo.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('retains one video frame during a slow send and requires a key after a gap', async () => {
  let output!: (chunk: EncodedVideoChunk) => void;
  const reader = { read: () => new Promise(() => {}), cancel: async () => {} };
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    class {
      readable = { getReader: () => reader };
    },
  );
  vi.stubGlobal(
    'VideoEncoder',
    class {
      constructor(init: VideoEncoderInit) {
        output = init.output;
      }
      configure() {}
      close() {}
    },
  );
  const track = { getSettings: () => ({ width: 320, height: 180 }), clone: () => ({ stop() {} }) };
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  const slow: number[] = [],
    fast: number[] = [];
  let release!: () => void;
  const fail = vi.fn();
  const stopSlow = recordPacketVideo(
    stream,
    async (frame) => {
      slow.push(frame[11]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    fail,
  );
  const stopFast = recordPacketVideo(
    stream,
    async (frame) => {
      fast.push(frame[11]);
    },
    fail,
  );
  const emit = async (value: number, type: 'key' | 'delta') => {
    output({
      timestamp: value,
      type,
      byteLength: 1,
      copyTo: (bytes: Uint8Array) => {
        bytes[0] = value;
      },
    } as unknown as EncodedVideoChunk);
    await Promise.resolve();
    await Promise.resolve();
  };
  try {
    await emit(1, 'key');
    await emit(2, 'delta');
    await emit(3, 'delta');
    expect(slow).toEqual([1]);
    release();
    await vi.waitFor(() => expect(slow).toEqual([1, 2]));
    await emit(4, 'delta');
    await emit(5, 'key');
    release();
    await vi.waitFor(() => expect(slow).toEqual([1, 2, 5]));
    await emit(6, 'delta');
    stopSlow();
    release();
    await Promise.resolve();
    expect(slow).toEqual([1, 2, 5]);
    expect(fast).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fail).not.toHaveBeenCalled();
  } finally {
    stopSlow();
    stopFast();
  }
});
