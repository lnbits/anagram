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

it.each([
  { sendMs: 20, fastPeer: false, expected: 600000 },
  { sendMs: 20, fastPeer: false, congested: true, expected: 480000 },
  { sendMs: 20, fastPeer: true, congested: true, expected: 600000 },
  { sendMs: 100, fastPeer: false, expected: 480000 },
  { sendMs: 100, fastPeer: true, expected: 600000 },
])(
  'adapts video before prolonged congestion ($sendMs ms, fast peer: $fastPeer)',
  async ({ sendMs, fastPeer, expected, congested = false }) => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let next!: (result: ReadableStreamReadResult<VideoFrame>) => void;
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<VideoFrame>>((resolve) => (next = resolve)),
      cancel: async () => {},
    };
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readable = { getReader: () => reader };
      },
    );
    const configured: VideoEncoderConfig[] = [];
    vi.stubGlobal(
      'VideoEncoder',
      class {
        encodeQueueSize = 0;
        constructor(private init: VideoEncoderInit) {}
        configure(config: VideoEncoderConfig) {
          configured.push(config);
        }
        encode(frame: VideoFrame) {
          this.init.output(
            {
              timestamp: frame.timestamp,
              type: 'key',
              byteLength: 1,
              copyTo: (bytes: Uint8Array) => {
                bytes[0] = 0;
              },
            } as unknown as EncodedVideoChunk,
            {},
          );
        }
        close() {}
      },
    );
    const track = {
      getSettings: () => ({ width: 640, height: 360 }),
      clone: () => ({ stop() {} }),
    };
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    let release!: () => void;
    const fail = vi.fn();
    const stop = recordPacketVideo(
      stream,
      () => new Promise<void>((resolve) => (release = resolve)),
      fail,
      { isVideoCongested: () => congested },
    );
    const stopFast = fastPeer ? recordPacketVideo(stream, async () => {}, fail) : undefined;
    const frame = () =>
      ({ displayWidth: 640, displayHeight: 360, timestamp: now * 1000, close() {} }) as VideoFrame;
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    try {
      next({ done: false, value: frame() });
      await flush();
      now += sendMs;
      release();
      await flush();
      now += 50;
      next({ done: false, value: frame() });
      await flush();
      expect(configured.at(-1)).toMatchObject({
        bitrate: expected,
        bitrateMode: 'constant',
        framerate: 24,
      });
      expect(fail).not.toHaveBeenCalled();
    } finally {
      stop();
      stopFast?.();
      release();
      next({ done: true, value: undefined });
      await flush();
    }
  },
);

it('paces a 30 fps source near 24 fps instead of discarding every other frame', async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let input!: ReadableStreamDefaultController<VideoFrame>;
  const frames = new ReadableStream<VideoFrame>({
    start(controller) {
      input = controller;
    },
  });
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    class {
      readable = frames;
    },
  );
  const encoded: number[] = [];
  vi.stubGlobal(
    'VideoEncoder',
    class {
      encodeQueueSize = 0;
      configure() {}
      encode() {
        encoded.push(now);
      }
      close() {}
    },
  );
  const track = { getSettings: () => ({ width: 640, height: 360 }), clone: () => ({ stop() {} }) };
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  const stop = recordPacketVideo(stream, async () => {}, vi.fn(), { videoFrameRate: 24 });
  try {
    for (let i = 0; i < 60; i++) {
      now = 1000 + (i * 1000) / 30;
      input.enqueue({ displayWidth: 640, displayHeight: 360, close() {} } as VideoFrame);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(encoded.length).toBeGreaterThanOrEqual(47);
    expect(encoded.length).toBeLessThanOrEqual(49);
  } finally {
    input.close();
    stop();
  }
});
