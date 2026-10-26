// Only PCM moves through the audio render thread. Opus runs in a dedicated
// worker. Credits bound MessagePort queues even when either thread is stalled.
class CallAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mode = options.processorOptions.mode;
    this.active = true;
    this.link = null;
    this.captureFrames = options.processorOptions.captureFrames;
    this.credits = this.captureFrames;
    this.sequence = 0;
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
      this.link = data.port;
      this.link.onmessage = ({ data }) => {
        if (data.ack) this.credits = Math.min(this.captureFrames, this.credits + 1);
        if (data.pcm) {
          this.pending = false;
          if (this.output.length < 2) this.output.push(data.pcm);
        }
      };
    };
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const out = outputs[0][0];
    if (this.mode === 'capture') {
      const input = inputs[0]?.[0];
      for (let i = 0; i < out.length; i++) {
        this.input[this.offset++] = input?.[i] ?? 0;
        if (this.offset === 960) {
          if (this.link && this.credits > 0) {
            this.credits--;
            this.link.postMessage({ pcm: this.input, sequence: this.sequence }, [
              this.input.buffer,
            ]);
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
          if (this.readOffset === 960) {
            this.output.shift();
            this.readOffset = 0;
          }
        }
      }
      if (this.link && this.output.length < 2 && !this.pending) {
        this.pending = true;
        this.link.postMessage({ pull: true });
      }
    }
    return true;
  }
}
registerProcessor('anagram-call-audio', CallAudioProcessor);
