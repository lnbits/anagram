import { expect, it } from 'vitest';
import { CallAudioPlayout } from '#src/services/callAudioPlayout.ts';
import { CallAudioJitterBuffer } from '#src/services/callAudioPackets.ts';

const packet = (sequence: number) => ({
  generation: 1,
  sequence,
  timestamp: sequence * 960,
  opus: new Uint8Array([1]),
});
const tone = (sequence: number, frequency = 440) =>
  Float32Array.from(
    { length: 960 },
    (_, i) => Math.sin(((sequence * 960 + i) * 2 * Math.PI * frequency) / 48000) * 0.5,
  );

it('leaves normal audio unchanged and does not add a processing buffer', () => {
  const jitter = new CallAudioJitterBuffer(),
    playout = new CallAudioPlayout();
  for (let i = 0; i < 200; i++) {
    jitter.push(packet(i), i * 20);
    let decoded: Float32Array | undefined;
    const pcm = playout.pull(i * 20, jitter, () => {
      const frame = jitter.pull(i * 20);
      return (decoded = frame?.packet ? tone(frame.packet.sequence) : new Float32Array(960));
    });
    expect(pcm).toBe(decoded);
  }
  expect(playout.stats.tempo).toBe(1);
  expect(playout.stats.processingBufferedMs).toBe(0);
});

it.each([100, 220, 440])(
  'drains an 800 ms stall without skipping packets or shifting %i Hz pitch',
  (frequency) => {
    const jitter = new CallAudioJitterBuffer(),
      playout = new CallAudioPlayout();
    const sequences: number[] = [];
    let now = 0,
      crossings = 0,
      previous = 0,
      measuredSamples = 0,
      maxTempo = 1;
    let afterStall = 0;
    for (; now < 22000; now += 20) {
      jitter.push(packet(now / 20), now);
      if (now >= 1000 && now < 1800) continue;
      const pcm = playout.pull(now, jitter, () => {
        const frame = jitter.pull(now);
        if (!frame?.packet) return new Float32Array(960);
        expect(frame.fec).toBe(false);
        sequences.push(frame.packet.sequence);
        return tone(frame.packet.sequence, frequency);
      });
      if (now === 1800) afterStall = jitter.bufferedMs;
      maxTempo = Math.max(maxTempo, playout.stats.tempo);
      if (now > 2500 && now < 11000) {
        for (const sample of pcm) {
          if (sample > 0 && previous <= 0) crossings++;
          previous = sample;
          measuredSamples++;
          expect(Number.isFinite(sample)).toBe(true);
        }
      }
    }
    expect(afterStall).toBeGreaterThan(750);
    expect(jitter.bufferedMs).toBeLessThan(150);
    expect(jitter.stats.skipped).toBe(0);
    expect(jitter.stats.concealed).toBe(0);
    expect(sequences.every((sequence, i) => i === 0 || sequence === sequences[i - 1] + 1)).toBe(
      true,
    );
    expect(maxTempo).toBeCloseTo(1.1);
    expect(playout.stats.tempo).toBeCloseTo(1);
    expect(crossings / (measuredSamples / 48000)).toBeGreaterThan(frequency - 5);
    expect(crossings / (measuredSamples / 48000)).toBeLessThan(frequency + 5);
    expect(playout.stats.processingBufferedMs).toBeLessThan(60);
  },
);
