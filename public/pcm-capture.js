class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 1600;
    this.frame = new Float32Array(this.frameSize);
    this.offset = 0;
    this.speechActive = false;
    this.silenceFrames = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let energy = 0;
    for (let i = 0; i < input.length; i += 1) energy += input[i] * input[i];
    const rms = Math.sqrt(energy / input.length);
    if (rms > 0.018) {
      this.silenceFrames = 0;
      if (!this.speechActive) {
        this.speechActive = true;
        this.port.postMessage({ type: 'speech-start' });
      }
    } else if (this.speechActive) {
      this.silenceFrames += input.length;
      if (this.silenceFrames > sampleRate * 0.9) this.speechActive = false;
    }

    for (let i = 0; i < input.length; i += 1) {
      this.frame[this.offset] = input[i];
      this.offset += 1;
      if (this.offset === this.frameSize) {
        const copy = this.frame.slice();
        this.port.postMessage({ type: 'audio', samples: copy.buffer }, [copy.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);