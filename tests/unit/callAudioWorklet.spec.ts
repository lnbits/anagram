import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { CALL_AUDIO_QUEUE_FRAMES } from '#src/services/callAudioQueue.ts';

it('retains capture through a short worker stall with a bounded number of outstanding frames', () => {
  let Processor: any;
  runInNewContext(
    readFileSync(new URL('../../src/services/callAudio.worklet.js', import.meta.url), 'utf8'),
    {
      Float32Array,
      AudioWorkletProcessor: class {
        port = { onmessage: undefined };
      },
      registerProcessor: (_name: string, value: any) => {
        Processor = value;
      },
    },
  );
  const frames: Array<{ sequence: number; pcm: Float32Array }> = [];
  const link = {
    onmessage: (_event: any) => {},
    close() {},
    postMessage: (data: any) => frames.push(data),
  };
  const processor = new Processor({
    processorOptions: { mode: 'capture', captureFrames: CALL_AUDIO_QUEUE_FRAMES },
  });
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
