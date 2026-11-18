// Only PCM moves through the audio render thread. Opus runs in a dedicated
// worker. Credits bound MessagePort queues even when either thread is stalled.
// Keep two complete frames ahead of the one being rendered. A worker reply
// delayed past one 20 ms frame must not leave an otherwise healthy stream silent.
const PLAYBACK_FRAMES = 3;
class CallAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mode = options.processorOptions.mode;
    this.active = true;
    this.link = null;
    this.captureFrames = options.processorOptions.captureFrames;
    this.credits = this.captureFrames;
    this.sequence = 0;
    this.captureStarted = false;
    this.captureEpoch = options.processorOptions.captureEpoch;
    this.renderedSamples = 0;
    this.underrunSamples = 0;
    this.reportSamples = 0;
    this.input = new Float32Array(960);
    this.offset = 0;
    this.output = [];
    this.readOffset = 0;
    this.pending = false;
    this.port.onmessage = ({ data }) => {
      if (data.close) {
        this.active = false;
        this.link?.close();
        return;
      }
      if (data.captureEpoch !== undefined) {
        this.captureEpoch = data.captureEpoch;
        return;
      }
      this.link = data.port;
      this.link.onmessage = ({ data }) => {
        if (data.ack) this.credits = Math.min(this.captureFrames, this.credits + 1);
        if (data.pcm) {
          this.pending = false;
          if (this.output.length < PLAYBACK_FRAMES) this.output.push(data.pcm);
        }
      };
    };
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const out = outputs[0][0];
    if (this.mode === 'capture') {
      if (!this.captureStarted) {
        this.captureStarted = true;
        this.port.postMessage({ type: 'capture-started' });
      }
      const input = inputs[0]?.[0];
      for (let i = 0; i < out.length; i++) {
        this.input[this.offset++] = input?.[i] ?? 0;
        if (this.offset === 960) {
          if (this.link && this.credits > 0) {
            this.credits--;
            this.link.postMessage(
              {
                pcm: this.input,
                sequence: this.sequence,
                at: this.captureEpoch + ((currentFrame + i - 959) / sampleRate) * 1000,
              },
              [this.input.buffer],
            );
            this.input = new Float32Array(960);
          }
          this.sequence = (this.sequence + 1) >>> 0;
          this.offset = 0;
        }
      }
    } else {
      for (let i = 0; i < out.length; i++) {
        if (this.output.length) {
          out[i] = this.output[0][this.readOffset++];
          this.renderedSamples++;
          if (this.readOffset === 960) {
            this.output.shift();
            this.readOffset = 0;
          }
        } else this.underrunSamples++;
      }
      this.reportSamples += out.length;
      if (this.reportSamples >= 48000) {
        this.reportSamples = 0;
        this.port.postMessage({
          type: 'render',
          renderedSamples: this.renderedSamples,
          underrunSamples: this.underrunSamples,
          renderBufferedMs: (this.output.length * 960 - this.readOffset) / 48,
        });
      }
      if (this.link && this.output.length < PLAYBACK_FRAMES && !this.pending) {
        this.pending = true;
        this.link.postMessage({ pull: true });
      }
    }
    return true;
  }
}
registerProcessor('anagram-call-audio', CallAudioProcessor);
