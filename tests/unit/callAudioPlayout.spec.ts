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

it('keeps the bounded passthrough when pitch-preserving adjustment is unavailable', () => {
  const jitter = new CallAudioJitterBuffer(),
    playout = new CallAudioPlayout();
  playout.stats.catchUpSupported = false;
  for (let i = 0; i < 200; i++) {
    jitter.push(packet(i), i * 20);
    let decoded: Float32Array | undefined;
    const pcm = playout.pull(jitter, () => {
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
      const pcm = playout.pull(jitter, () => {
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

it.each([19.98, 20.02, 20.1])(
  'matches an independent capture clock (%f ms) without periodic missing speech',
  (period) => {
    const jitter = new CallAudioJitterBuffer(),
      playout = new CallAudioPlayout();
    let sequence = 0;
    const played: number[] = [];
    let previous = 0,
      crossings = 0,
      samples = 0,
      quiet = 0,
      longestQuiet = 0;
    for (let now = 0; now < 120000; now += 20) {
      while (sequence * period <= now) {
        jitter.push(packet(sequence), sequence * period);
        sequence++;
      }
      const pcm = playout.pull(jitter, () => {
        const frame = jitter.pull(now);
        if (!frame?.packet) return new Float32Array(960);
        played.push(frame.packet.sequence);
        return tone(frame.packet.sequence);
      });
      if (now >= 1000)
        for (const sample of pcm) {
          if (sample > 0 && previous <= 0) crossings++;
          previous = sample;
          samples++;
          quiet = Math.abs(sample) < 0.00001 ? quiet + 1 : 0;
          longestQuiet = Math.max(longestQuiet, quiet);
        }
      expect(jitter.bufferedMs).toBeLessThan(300);
    }
    expect(crossings / (samples / 48000)).toBeGreaterThan(435);
    expect(crossings / (samples / 48000)).toBeLessThan(445);
    expect(longestQuiet / 48).toBeLessThan(1);
    expect(playout.stats.processingBufferedMs).toBeLessThan(60);
    expect(jitter.stats.concealed).toBe(0);
    expect(jitter.stats.late).toBe(0);
    expect(played.every((value, i) => i === 0 || value === played[i - 1] + 1)).toBe(true);
  },
);

it('keeps speech continuous after adapting to recurring relay bursts with clock drift', () => {
  const jitter = new CallAudioJitterBuffer(),
    playout = new CallAudioPlayout();
  let sequence = 0,
    concealedAfterWarmup = 0;
  for (let now = 0; now < 60000; now += 20) {
    while (sequence * 20.02 <= now) {
      const captured = sequence * 20.02;
      const phase = captured % 3000;
      const arrival = captured >= 3000 && phase < 100 ? captured - phase + 100 : captured;
      if (arrival > now) break;
      jitter.push(packet(sequence++), arrival);
    }
    playout.pull(jitter, () => {
      const frame = jitter.pull(now);
      return frame?.packet ? tone(frame.packet.sequence) : new Float32Array(960);
    });
    if (now === 15000) concealedAfterWarmup = jitter.stats.concealed;
    expect(jitter.bufferedMs).toBeLessThan(300);
  }
  expect(jitter.stats.concealed).toBe(concealedAfterWarmup);
  expect(jitter.stats.skipped).toBe(0);
});
