import { afterEach, expect, it, vi } from 'vitest';
import { recordCallMedia } from '#src/services/callMediaService.ts';
import { cloneCallTrack } from '#src/services/callSharedCapture.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('shares WebM encoding, resets late joiners in order, and isolates a stalled recipient', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('isTauri', false);
  const recorders: any[] = [];
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      ondataavailable: (event: { data: Blob }) => void;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        setTimeout(() => (this as any).onstop?.(), 0);
      }
    },
  );
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private tracks: any[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  const original = { clone: () => ({ stop: vi.fn() }) } as unknown as MediaStreamTrack;
  const stream = () => new MediaStream([cloneCallTrack(original)]);
  const first: string[] = [],
    second: string[] = [];
  const failure = vi.fn();
  let release!: () => void;
  const stopped = vi.fn();
  const a = recordCallMedia(
    stream(),
    'video/webm;codecs=vp8',
    async (bytes) => {
      first.push(String(bytes[1]));
    },
    failure,
    {
      onStreamRestart: async () => {
        first.push('reset');
      },
    },
  );
  await vi.advanceTimersByTimeAsync(100);
  recorders[0].ondataavailable({ data: new Blob([new Uint8Array([1])]) });
  await vi.advanceTimersByTimeAsync(0);
  const b = recordCallMedia(
    stream(),
    'video/webm;codecs=vp8',
    async (bytes) => {
      second.push(String(bytes[1]));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    failure,
    {
      onStreamRestart: async () => {
        second.push('reset');
      },
      onCongestion: stopped,
    },
  );
  expect(recorders).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(1);
  expect(recorders[0].state).toBe('inactive');
  expect(recorders).toHaveLength(2);
  recorders[1].ondataavailable({ data: new Blob([new Uint8Array([2])]) });
  await vi.advanceTimersByTimeAsync(0);
  recorders[1].ondataavailable({ data: new Blob([new Uint8Array([3])]) });
  await vi.advanceTimersByTimeAsync(1750);
  expect(first).toEqual(['1', 'reset', '2', '3']);
  expect(second).toEqual(['2']);
  expect(stopped).toHaveBeenCalledOnce();
  expect(recorders[1].state).toBe('recording');
  expect(failure).not.toHaveBeenCalled();
  release();
  b();
  a();
  expect(recorders[1].state).toBe('inactive');
});

it('waits for native teardown, batches joins during it, and cannot restart after disposal', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('isTauri', false);
  const owned: { stop: ReturnType<typeof vi.fn> }[] = [];
  const original = {
    stop: vi.fn(),
    clone() {
      const track = { stop: vi.fn() };
      owned.push(track);
      return track;
    },
  } as unknown as MediaStreamTrack;
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private tracks: any[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  const recorders: any[] = [];
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      onstop: (() => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      constructor(readonly stream: MediaStream) {
        recorders.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      } // Native completion is deliberately deferred.
    },
  );
  const errors = vi.fn();
  const resets = [vi.fn(), vi.fn(), vi.fn()];
  const sent = [vi.fn(), vi.fn(), vi.fn()];
  const subscribe = (i: number) =>
    recordCallMedia(
      new MediaStream([original]),
      'video/webm;codecs=vp8',
      async (bytes) => {
        sent[i](bytes[1]);
      },
      errors,
      {
        onStreamRestart: async () => {
          resets[i]();
        },
      },
    );
  const a = subscribe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(recorders[0].stream.getTracks()[0]).not.toBe(original);
  recorders[0].ondataavailable({ data: new Blob([new Uint8Array([1])]) });
  await vi.advanceTimersByTimeAsync(0);
  const b = subscribe(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(recorders).toHaveLength(1);
  expect(resets[0]).not.toHaveBeenCalled();
  expect(recorders[0].ondataavailable).toBeNull();
  const c = subscribe(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(recorders).toHaveLength(1);
  recorders[0].onstop();
  await vi.advanceTimersByTimeAsync(0);
  expect(owned[0].stop).toHaveBeenCalledOnce();
  expect(recorders).toHaveLength(2);
  expect(resets[0]).toHaveBeenCalledOnce();
  expect(resets[1]).not.toHaveBeenCalled();
  expect(resets[2]).not.toHaveBeenCalled();
  recorders[1].ondataavailable({ data: new Blob([new Uint8Array([2])]) });
  await vi.advanceTimersByTimeAsync(0);
  sent.forEach((send) => expect(send).toHaveBeenLastCalledWith(2));
  c();
  const d = subscribe(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(recorders[1].state).toBe('inactive');
  a();
  b();
  d();
  recorders[1].onstop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(recorders).toHaveLength(2);
  expect(owned[1].stop).toHaveBeenCalledOnce();
  expect(original.stop).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
