function shapeShareSample(value) {
  const abs = Math.abs(value);
  if (!(abs > 0.5)) return Number.isFinite(value) ? value : 0;
  const sign = value < 0 ? -1 : 1;
  return sign * (0.5 + (1 - Math.exp(-(abs - 0.5) * 2)) * 0.39);
}

class KnotScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.frames = 0;
    this.started = false;
    // Fade in over ~40 ms at 48 kHz every time playback starts or resumes
    // after an underrun. Entering at full amplitude made any residual capture
    // discontinuity audible as a click or pop in the shared computer sound.
    this.fadeInFrames = 1920;
    this.fadedIn = this.fadeInFrames;
    this.recentPeak = 0;
    this.playedFrames = 0;
    this.starved = 0;
    this.port.onmessage = event => {
      if (event.data && event.data.type === 'fade') {
        this.fadedIn = 0;
        if (this.frames >= 1920) this.started = true;
        return;
      }
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
      this.fadedIn = 0;
    }
    for (let frame = 0; frame < left.length; frame++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // A short gap used to restart the 40 ms preroll. That stutter is what
        // Opus turns into robotic packet-loss concealment on the far side.
        // Count the missing frames only. Adding the whole quantum made a
        // one-sample shortfall look like an 80 ms dropout.
        this.starved += left.length - frame;
        if (this.starved > sampleRate * 0.08) {
          this.started = false;
          this.starved = 0;
          this.fadedIn = 0;
        }
        break;
      }
      this.starved = 0;
      const index = this.offset * 2;
      const sampleL = chunk[index] || 0, sampleR = chunk[index + 1] || 0;
      const peak = Math.max(Math.abs(sampleL), Math.abs(sampleR));
      if (this.started && this.fadedIn >= this.fadeInFrames && this.playedFrames < 96000 && this.recentPeak < 0.02 && peak > 0.92) this.fadedIn = 0;
      this.recentPeak = this.recentPeak * 0.9 + peak * 0.1;
      this.playedFrames++;
      let gain = 1;
      if (this.fadedIn < this.fadeInFrames) {
        gain = this.fadedIn / this.fadeInFrames;
        this.fadedIn++;
      }
      const rawL = shapeShareSample(sampleL * gain), rawR = shapeShareSample(sampleR * gain);
      left[frame] = rawL;
      right[frame] = rawR;
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
