class KnotScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.frames = 0;
    this.started = false;
    this.port.onmessage = event => {
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data || 0);
      const frames = Math.floor(samples.length / 2);
      if (!frames) return;
      this.queue.push(samples);
      this.frames += frames;
      // Bound latency at two seconds. If IPC or rendering stalls, discard the
      // oldest audio instead of replaying it late and making the call stutter.
      while (this.frames > 96000 && this.queue.length) {
        const oldest = this.queue.shift();
        this.frames -= Math.floor(oldest.length / 2) - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!left || !right) return true;
    left.fill(0);
    right.fill(0);
    if (!this.started) {
      if (this.frames < 2048) return true;
      this.started = true;
    }
    for (let frame = 0; frame < left.length; frame++) {
      const chunk = this.queue[0];
      if (!chunk) {
        this.started = false;
        break;
      }
      const index = this.offset * 2;
      left[frame] = chunk[index] || 0;
      right[frame] = chunk[index + 1] || 0;
      this.offset++;
      this.frames--;
      if (this.offset >= Math.floor(chunk.length / 2)) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('knot-screen-audio', KnotScreenAudioProcessor);
