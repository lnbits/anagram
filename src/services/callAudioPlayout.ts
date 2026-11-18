import { Stretch } from '@soundtouchjs/core';
import type { CallAudioJitterBuffer } from './callAudioPackets.ts';

// WSOLA changes duration without changing pitch. Keep it in the codec worker,
// never on the render thread. Normal calls bypass it until a sustained backlog
// requires catch-up; once started, retain its small overlap across tempo changes.
export class CallAudioPlayout {
  private stretch?: Stretch;
  private excessSince?: number;
  private readonly stereo = new Float32Array(1920);
  readonly stats = {
    tempo: 1,
    catchUpSupported: typeof ArrayBuffer.prototype.resize === 'function',
    processedSamples: 0,
    decodedFrames: 0,
    processingBufferedMs: 0,
  };

  pull(now: number, jitter: CallAudioJitterBuffer, decode: () => Float32Array): Float32Array {
    const excess = jitter.bufferedMs - jitter.stats.targetMs;
    if (excess > 100) this.excessSince ??= now;
    else this.excessSince = undefined;
    if (
      !this.stretch &&
      this.stats.catchUpSupported &&
      this.excessSince !== undefined &&
      now - this.excessSince >= 500
    ) {
      this.stretch = new Stretch({ sampleRate: 48000, createBuffers: true });
      this.stretch.setParameters(48000, 20, 8, 5);
    }
    const next = () => {
      this.stats.decodedFrames++;
      const pcm = decode();
      if (pcm.length !== 960) throw new Error('Unexpected audio duration');
      return pcm;
    };
    this.stats.processedSamples += 960;
    if (!this.stretch) return next();
    const stretch = this.stretch;
    // Leave a safety margin above the jitter target and gently return to normal.
    // At most 10% faster, with hysteresis; a target change cannot cause a seek.
    const desired = excess > 60 ? Math.min(1.1, 1 + (excess - 40) / 4000) : 1;
    const tempo = this.stats.tempo + Math.max(-0.005, Math.min(0.005, desired - this.stats.tempo));
    stretch.tempo = this.stats.tempo = tempo;
    let frames = 0;
    while (stretch.outputBuffer!.frameCount < 960 && frames++ < 8) {
      const pcm = next();
      for (let i = 0; i < 960; i++) this.stereo[i * 2] = this.stereo[i * 2 + 1] = pcm[i];
      stretch.inputBuffer!.putSamples(this.stereo);
      stretch.process();
    }
    if (stretch.outputBuffer!.frameCount < 960) throw new Error('Audio stretch made no progress');
    stretch.outputBuffer!.extract(this.stereo, 0, 960);
    stretch.outputBuffer!.receive(960);
    const output = new Float32Array(960);
    for (let i = 0; i < 960; i++) output[i] = this.stereo[i * 2];
    this.stats.processingBufferedMs =
      (stretch.inputBuffer!.frameCount + stretch.outputBuffer!.frameCount + stretch.overlapLength) /
      48;
    return output;
  }
}
