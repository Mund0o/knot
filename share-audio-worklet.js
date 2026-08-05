/* AudioWorklet: consume interleaved stereo PCM for screen-share system audio. */
class PairShareAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 96000;
    this.buffer = new Float32Array(this.capacity * 2);
    this.write = 0;
    this.available = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'pcm' || !(data.samples instanceof Float32Array)) return;
      const samples = data.samples;
      const frames = (samples.length / 2) | 0;
      for (let i = 0; i < frames; i++) {
        if (this.available >= this.capacity) {
          this.available--;
        }
        const idx = this.write * 2;
        this.buffer[idx] = samples[i * 2];
        this.buffer[idx + 1] = samples[i * 2 + 1];
        this.write = (this.write + 1) % this.capacity;
        this.available++;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const L = output[0];
    const R = output[1];
    const n = L.length;
    if (this.available < n) {
      L.fill(0);
      R.fill(0);
      return true;
    }
    const read = (this.write - this.available + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      const idx = ((read + i) % this.capacity) * 2;
      L[i] = this.buffer[idx];
      R[i] = this.buffer[idx + 1];
    }
    this.available -= n;
    return true;
  }
}

registerProcessor('pair-share-audio', PairShareAudioProcessor);
