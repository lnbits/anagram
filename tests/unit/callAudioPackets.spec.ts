import { describe, expect, it } from 'vitest';
import { CallAudioJitterBuffer, packAudio, unpackAudio } from '#src/services/callAudioPackets.ts';
const packet = (sequence: number, generation = 1) => ({
  generation,
  sequence: sequence >>> 0,
  timestamp: (sequence * 960) >>> 0,
  opus: new Uint8Array([1, 2, 3]),
});
describe('packet call audio', () => {
  it('round-trips headers and rejects oversized or malformed packets', () => {
    expect(unpackAudio(packAudio(packet(10)))).toEqual(packet(10));
    expect(unpackAudio(new Uint8Array(1101))).toBeNull();
    const frame = packAudio(packet(0));
    frame[1] = 2;
    expect(unpackAudio(frame)).toBeNull();
    expect(() => packAudio({ ...packet(1), opus: new Uint8Array(1100) })).toThrow();
  });
  it('reorders, suppresses duplicates and uses the next packet for in-band FEC', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0), 0);
    buffer.push(packet(2), 20);
    buffer.push(packet(2), 21);
    expect(buffer.pull(10)).toBeNull();
    expect(buffer.pull(60)?.packet?.sequence).toBe(0);
    expect(buffer.pull(80)).toEqual({ packet: packet(2), fec: true });
    expect(buffer.pull(100)).toEqual({ packet: packet(2), fec: false });
    expect(buffer.stats.duplicate).toBe(1);
    buffer.push(packet(1), 101);
    expect(buffer.stats.late).toBe(1);
  });
  it('bounds replay after a stall and old generations cannot replace the current stream', () => {
    const buffer = new CallAudioJitterBuffer();
    for (let i = 0; i < 1000; i++) buffer.push(packet(i), i < 5 ? i * 20 : 20000);
    expect(buffer.stats.buffered).toBeLessThanOrEqual(24);
    expect(buffer.pull(20100)?.packet?.sequence).toBeGreaterThan(980);
    buffer.push(packet(0, 2), 20200);
    buffer.push(packet(1000, 1), 20220);
    expect(buffer.pull(20400)?.packet?.generation).toBe(2);
  });
  it('recovers after prolonged loss without an ever-growing concealment queue', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0), 0);
    buffer.pull(40);
    for (let i = 0; i < 100; i++) buffer.pull(60 + i * 20);
    expect(buffer.stats.concealed).toBe(4);
    buffer.push(packet(100), 2100);
    buffer.push(packet(101), 2120);
    expect(buffer.pull(2300)?.packet?.sequence).toBe(100);
  });
  it('does not count the outage as continuing jitter when the capture clock resumes', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0), 0);
    buffer.pull(40);
    for (let now = 60; now <= 120; now += 20) buffer.pull(now);
    buffer.push(packet(10), 1000);
    buffer.push(packet(11), 1020);
    expect(buffer.stats.jitterMs).toBe(0);
    expect(buffer.stats.targetMs).toBe(40);
    expect(buffer.pull(1040)).toEqual({ packet: packet(10), fec: false });
  });
  it('catches up to the current target after a burst without adding a second cushion', () => {
    const buffer = new CallAudioJitterBuffer();
    for (let i = 0; i < 3; i++) buffer.push(packet(i), i * 20);
    buffer.pull(40);
    for (let i = 3; i <= 10; i++) buffer.push(packet(i), 240 + i - 3);
    const frame = buffer.pull(248);
    expect(frame?.packet).not.toBeNull();
    expect(frame?.fec).toBe(false);
    expect(frame?.packet?.sequence).toBeGreaterThanOrEqual(5);
    expect((10 - frame!.packet!.sequence) * 20).toBeLessThanOrEqual(buffer.stats.targetMs + 60);
  });
  it('handles the sequence wrap and keeps a long, jittery call bounded', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0xfffffffe), 0);
    buffer.push(packet(0xffffffff), 20);
    buffer.push(packet(0), 40);
    expect(buffer.pull(40)?.packet?.sequence).toBe(0xfffffffe);
    expect(buffer.pull(60)?.packet?.sequence).toBe(0xffffffff);
    expect(buffer.pull(80)?.packet?.sequence).toBe(0);
    for (let i = 1; i < 180000; i++) {
      if (i % 23) buffer.push(packet(i), 80 + i * 20 + (i % 7) * 3);
      buffer.pull(80 + i * 20);
      expect(buffer.stats.buffered).toBeLessThanOrEqual(24);
    }
    expect(buffer.stats.targetMs).toBeLessThanOrEqual(160);
  });
  it.each([0, 0xfffffff0])(
    'resumes fresh audio after an underrun across sequence wrap (base %i)',
    (base) => {
      const buffer = new CallAudioJitterBuffer();
      const frame = (sequence: number) => packet((base + sequence) >>> 0);
      for (let i = 0; i < 50; i++) {
        buffer.push(frame(i), i * 20);
        buffer.pull(i * 20);
      }
      for (let now = 1000; now < 1260; now += 20) buffer.pull(now);
      expect(buffer.stats.concealed).toBe(4);
      buffer.push(frame(49), 1260);
      expect(buffer.stats.late).toBe(1);
      buffer.push(frame(63), 1260);
      buffer.push(frame(64), 1280);
      buffer.push(frame(65), 1300);
      expect(buffer.pull(1300)).toEqual({ packet: frame(63), fec: false });
      expect(buffer.stats.targetMs).toBe(40);
      expect(buffer.stats.jitterMs).toBe(0);
      // The old run's loss count must not discard the resumed stream on one loss.
      buffer.pull(1320);
      buffer.pull(1340);
      expect(buffer.pull(1360)).toEqual({ packet: null, fec: false });
      buffer.push(frame(67), 1380);
      expect(buffer.pull(1380)).toEqual({ packet: frame(67), fec: false });
    },
  );
});
