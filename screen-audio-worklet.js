class KnotScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.frames = 0;
    this.started = false;
    this.port.onmessage = event => {
      let samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data || 0);
      let frames = Math.floor(samples.length / 2);
      if (!frames) return;
      // A single delayed IPC delivery can itself be larger than the whole
      // jitter budget. Keep its newest 80 ms rather than dropping the entire
      // chunk or playing its stale beginning.
      if (frames > 3840) {
        const droppedFrames = frames - 3840;
        samples = samples.subarray((frames - 3840) * 2);
        frames = 3840;
        this.port.postMessage({ type: 'trim', droppedFrames, bufferedFrames: frames });
      }
      this.queue.push(samples);
      this.frames += frames;
      // Keep 40–160 ms of stereo audio. If IPC or rendering stalls, trim back
      // to about 80 ms instead of replaying seconds of stale desktop sound.
      if (this.frames > 7680) this.trimTo(3840);
    };
  }

  trimTo(targetFrames) {
    let droppedFrames = 0;
    while (this.frames > targetFrames && this.queue.length) {
      const oldest = this.queue[0];
      const available = Math.floor(oldest.length / 2) - this.offset;
      const discard = Math.min(available, this.frames - targetFrames);
      this.offset += discard;
      this.frames -= discard;
      droppedFrames += discard;
      if (this.offset >= Math.floor(oldest.length / 2)) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (droppedFrames) this.port.postMessage({ type: 'trim', droppedFrames, bufferedFrames: this.frames });
  }

  process(_inputs, outputs) {
    const left = outputs[0]?.[0];
    const right = outputs[0]?.[1];
    if (!left || !right) return true;
    left.fill(0);
    right.fill(0);
    if (!this.started) {
      if (this.frames < 1920) return true;
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
