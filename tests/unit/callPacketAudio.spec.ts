import { afterEach, expect, it, vi } from 'vitest';
import { CALL_AUDIO_QUEUE_FRAMES } from '#src/services/callAudioQueue.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mockEngine() {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('isTauri', false);
  const posted: any[] = [];
  let worker: any;
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: (event: any) => void;
      constructor() {
        worker = this;
      }
      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'boot')
          queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
      }
      terminate() {}
    },
  );
  vi.stubGlobal(
    'AudioContext',
    class extends EventTarget {
      sampleRate = 48000;
      state = 'running';
      audioWorklet = { addModule: async () => {} };
      async resume() {}
      async close() {}
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [] }, disconnect() {} };
      }
    },
  );
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = {};
      port2 = {};
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { postMessage() {}, close() {} };
      connect() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private tracks: MediaStreamTrack[]) {}
      getAudioTracks() {
        return this.tracks;
      }
    },
  );
  const api = await import('../../src/services/callPacketAudio.ts');
  const release = await api.prepareCallPacketAudio();
  return { posted, worker, release, ...api };
}

it('preserves brief decoder stalls and bounds a sustained decoder backlog', async () => {
  const { posted, worker, release, createPacketAudioReceiver } = await mockEngine();
  const receiver = createPacketAudioReceiver(vi.fn());
  const received = () => {
    const last = posted.filter((message) => message.type === 'packet').at(-1);
    worker.onmessage({ data: { id: last.id, type: 'received', stats: {} } });
  };
  try {
    receiver.append(new Uint8Array(1101));
    expect(posted.filter((message) => message.type === 'packet')).toHaveLength(0);
    for (let i = 1; i <= 4; i++) receiver.append(new Uint8Array([i]));
    for (let i = 0; i < 4; i++) received();
    expect(posted.filter((m) => m.type === 'packet').map((m) => m.packet[0])).toEqual([1, 2, 3, 4]);
    for (let i = 5; i <= 20; i++) receiver.append(new Uint8Array([i]));
    for (let i = 0; i < 16; i++) received();
    expect(
      posted
        .filter((m) => m.type === 'packet')
        .map((m) => m.packet[0])
        .slice(4),
    ).toEqual(Array.from({ length: 16 }, (_, i) => i + 5));
    for (let i = 21; i <= 120; i++) receiver.append(new Uint8Array([i]));
    for (let i = 0; i <= CALL_AUDIO_QUEUE_FRAMES; i++) received();
    expect(
      posted
        .filter((m) => m.type === 'packet')
        .map((m) => m.packet[0])
        .slice(20),
    ).toEqual([
      21,
      ...Array.from(
        { length: CALL_AUDIO_QUEUE_FRAMES },
        (_, i) => 121 - CALL_AUDIO_QUEUE_FRAMES + i,
      ),
    ]);
    receiver.close();
    const count = posted.length;
    receiver.append(new Uint8Array([21]));
    expect(posted).toHaveLength(count);
  } finally {
    receiver.close();
    release?.();
  }
});

it('preserves sender backlog in order without delaying another peer, and clears it on hangup', async () => {
  const { posted, worker, release, recordPacketAudio } = await mockEngine();
  const { packAudio, unpackAudio } = await import('#src/services/callAudioPackets.ts');
  const track = new EventTarget() as MediaStreamTrack;
  const stream = new MediaStream([track]);
  const received: number[] = [];
  const generations: number[] = [];
  const acknowledgements: Array<() => void> = [];
  const fast: number[] = [];
  const error = vi.fn();
  const stopSlow = recordPacketAudio(
    stream,
    async (bytes) => {
      const packet = unpackAudio(bytes)!;
      received.push(packet.sequence);
      generations.push(packet.generation);
      await new Promise<void>((resolve) => acknowledgements.push(resolve));
    },
    error,
    { audioGeneration: 7 },
  );
  const stopFast = recordPacketAudio(
    stream,
    async (bytes) => {
      fast.push(unpackAudio(bytes)!.sequence);
    },
    error,
  );
  const id = posted.find((message) => message.type === 'encode').id;
  const deliver = (sequence: number) =>
    worker.onmessage({
      data: {
        id,
        type: 'packet',
        at: performance.timeOrigin + performance.now() - 200,
        packet: packAudio({
          sequence,
          generation: 1,
          timestamp: sequence * 960,
          opus: new Uint8Array([1]),
        }),
      },
    });
  try {
    for (let i = 0; i < 10; i++) {
      deliver(i);
      await Promise.resolve();
    }
    expect(received).toEqual([0, 1]);
    expect(fast).toEqual(Array.from({ length: 10 }, (_, i) => i));
    while (acknowledgements.length) {
      acknowledgements.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(received).toEqual(fast);
    expect(generations).toEqual(Array(10).fill(7));
    expect(posted.filter((message) => message.type === 'encode')).toHaveLength(1);
    for (let i = 10; i < 20; i++) {
      deliver(i);
      await Promise.resolve();
    }
    stopSlow();
    acknowledgements.splice(0).forEach((resolve) => resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveLength(12); // Queued speech cannot publish after hangup.
    expect(error).not.toHaveBeenCalled();
  } finally {
    stopSlow();
    stopFast();
    release?.();
  }
});

it('releases the audio context when the codec worker cannot be created', async () => {
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      close = close;
    },
  );
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('Worker creation unavailable');
      }
    },
  );
  const { prepareCallPacketAudio } = await import('../../src/services/callPacketAudio.ts');
  expect(await prepareCallPacketAudio()).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  { native: true, agent: 'Mozilla/5.0 (X11; Linux x86_64)', create: false },
  { native: false, agent: 'Mozilla/5.0 (X11; Linux x86_64)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Linux; Android 15)', create: true },
  { native: true, agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Windows NT 10.0)', create: true },
])(
  'avoids realtime worklets only in native Linux: $agent, native=$native',
  async ({ native, agent, create }) => {
    vi.stubGlobal('isTauri', native);
    vi.stubGlobal('navigator', { userAgent: agent });
    const opened = vi.fn();
    const closed = vi.fn(async () => {});
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          opened();
        }
        close = closed;
      },
    );
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Stop after platform capability check');
        }
      },
    );
    const { prepareCallPacketAudio } = await import('../../src/services/callPacketAudio.ts');
    expect(await prepareCallPacketAudio()).toBeUndefined();
    expect(opened).toHaveBeenCalledTimes(create ? 1 : 0);
    expect(closed).toHaveBeenCalledTimes(create ? 1 : 0);
  },
);
