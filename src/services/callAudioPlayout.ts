import { Stretch } from '@soundtouchjs/core';
import type { CallAudioJitterBuffer } from './callAudioPackets.ts';

// WSOLA changes duration without changing pitch. Keep it in the codec worker,
// never on the render thread. Match independent capture/playback clocks in both
// directions; retain the small overlap so tempo changes do not cut speech.
export class CallAudioPlayout {
  private stretch?: Stretch;
  private readonly stereo = new Float32Array(1920);
  readonly stats = {
    tempo: 1,
    catchUpSupported: typeof ArrayBuffer.prototype.resize === 'function',
    processedSamples: 0,
    decodedFrames: 0,
    processingBufferedMs: 0,
  };

  pull(jitter: CallAudioJitterBuffer, decode: () => Float32Array): Float32Array {
    const excess = jitter.bufferedMs - jitter.stats.targetMs;
    if (!this.stretch && this.stats.catchUpSupported) {
      // WSOLA needs lookahead. Prime it from buffered speech at startup rather
      // than requesting missing packets when a running stream gets low.
      if (excess < 40) return new Float32Array(960);
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
    // Keep enough lookahead for the decoder, with a neutral band so packet
    // bursts do not constantly change tempo. Slowing by at most 5% builds a
    // reserve before shortage; speeding by at most 10% drains excess latency.
    const desired =
      excess < 40
        ? Math.max(0.95, 1 + (excess - 40) / 1000)
        : excess > 80
          ? Math.min(1.1, 1 + (excess - 80) / 4000)
          : 1;
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
