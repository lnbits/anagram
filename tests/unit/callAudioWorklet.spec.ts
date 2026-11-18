import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { CALL_AUDIO_QUEUE_FRAMES } from '#src/services/callAudioQueue.ts';

function createProcessor(mode: 'capture' | 'playback') {
  let Processor: any;
  const clock = { currentFrame: 0, sampleRate: 48000 };
  runInNewContext(
    readFileSync(new URL('../../src/services/callAudio.worklet.js', import.meta.url), 'utf8'),
    {
      Float32Array,
      get currentFrame() {
        return clock.currentFrame;
      },
      sampleRate: clock.sampleRate,
      AudioWorkletProcessor: class {
        port = { onmessage: undefined, postMessage() {} };
      },
      registerProcessor: (_name: string, value: any) => {
        Processor = value;
      },
    },
  );
  const processor = new Processor({
    processorOptions: { mode, captureFrames: CALL_AUDIO_QUEUE_FRAMES, captureEpoch: 1000 },
  });
  const process = processor.process.bind(processor);
  processor.process = (...args: unknown[]) => {
    const result = process(...args);
    clock.currentFrame += 128;
    return result;
  };
  return processor;
}

it('retains capture through a short worker stall with a bounded number of outstanding frames', () => {
  const frames: Array<{ sequence: number; pcm: Float32Array }> = [];
  const link = {
    onmessage: (_event: any) => {},
    close() {},
    postMessage: (data: any) => frames.push(data),
  };
  const processor = createProcessor('capture');
  processor.port.onmessage({ data: { port: link } });
  const input = new Float32Array(128).fill(0.25);
  const output = new Float32Array(128);
  const render = (count: number) => {
    for (let i = 0; i < count; i++) processor.process([[input]], [[output]]);
  };
  render(75); // 200 ms / ten frames, with no worker acknowledgements.
  expect(frames.map((frame) => frame.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  expect(
    frames.every(
      (frame) => frame.pcm.length === 960 && frame.pcm.every((sample) => sample === 0.25),
    ),
  ).toBe(true);
  render(525); // Only an emergency backlog may exhaust the bounded capture credits.
  expect(frames).toHaveLength(CALL_AUDIO_QUEUE_FRAMES);
  link.onmessage({ data: { ack: true } });
  render(8);
  expect(frames.at(-1)!.sequence).toBe(80);
  processor.port.onmessage({ data: { close: true } });
  expect(processor.process([[input]], [[output]])).toBe(false);
});

it('keeps playback continuous across a delayed codec reply without growing the queue', () => {
  const processor = createProcessor('playback');
  let quantum = 0;
  let pulls = 0;
  let responseAt: number | undefined;
  let maxQueued = 0;
  const link = {
    onmessage: (_event: any) => {},
    close() {},
    postMessage() {
      expect(responseAt).toBeUndefined();
      pulls++;
      // Delay one response by 26.7 ms after steady playback. The worker
      // otherwise replies within one 128-sample render quantum (2.7 ms).
      responseAt = quantum + (pulls === 20 ? 10 : 1);
    },
  };
  processor.port.onmessage({ data: { port: link } });
  for (; quantum < 375; quantum++) {
    if (quantum === responseAt) {
      responseAt = undefined;
      link.onmessage({ data: { pcm: new Float32Array(960).fill(0.25) } });
    }
    const output = new Float32Array(128);
    processor.process([], [[output]]);
    maxQueued = Math.max(maxQueued, processor.output.length);
    if (quantum >= 75) expect(output.every((sample) => sample === 0.25)).toBe(true);
  }
  expect(pulls).toBeGreaterThan(40);
  expect(maxQueued).toBeLessThanOrEqual(3);
});

it('timestamps capture before codec queues and keeps the microphone output silent', () => {
  const processor = createProcessor('capture');
  const frames: any[] = [];
  processor.port.onmessage({ data: { port: { postMessage: (data: any) => frames.push(data) } } });
  for (let i = 0; i < 15; i++) {
    const output = new Float32Array(128);
    processor.process([[new Float32Array(128).fill(0.5)]], [[output]]);
    expect(output.every((sample) => sample === 0)).toBe(true);
  }
  expect(frames.map((frame) => frame.at)).toEqual([1000, 1020]);
  processor.port.onmessage({ data: { captureEpoch: 2000 } });
  for (let i = 0; i < 8; i++)
    processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  expect(frames.at(-1).at).toBe(2040);
});

it('requests one clock calibration when capture actually starts rendering', () => {
  const processor = createProcessor('capture');
  const started = vi.fn();
  processor.port.postMessage = started;
  expect(started).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++)
    processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  expect(started).toHaveBeenCalledExactlyOnceWith({ type: 'capture-started' });
});
