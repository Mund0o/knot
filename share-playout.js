(function installSharePlayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotSharePlayout = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, () => {
  // When to show each picture. It knows nothing about decoders or canvases: it is told when pictures and heartbeats arrive
  // and asked, every display refresh, which decoded picture (if any) is due. All times in picture time are microseconds on
  // the sharer's clock; "now" is the viewer's own clock in milliseconds.
  //
  // What it never does is show a worse picture to stay on time. If the link stalls it waits, with the last picture still on
  // screen. If the link turns out to be jittery it waits a little longer before starting, from then on. A viewer who joins starts
  // at the live edge (the pictures before it are decoded, because later ones depend on them, but never shown: nobody wants to
  // watch the past). A viewer that has fallen behind recovers lag with a gentle speed-up, and only a lag of several seconds makes
  // it jump forward, which is counted and reported rather than hidden.
  //
  // A display shows at most one picture per refresh, so any speed-up above 1x necessarily skips some. That is why the speed-up
  // is small, and why a stream running at the display's own rate is shown at exactly 1x whenever it is on time.
  const DEFAULTS = {
    startDelayMs: 250,        // how far behind the newest picture the viewer plays, to begin with
    minDelayMs: 100,
    maxDelayMs: 10000,
    catchUpMaxRate: 1.15,     // fastest the clock runs when behind
    catchUpStartMs: 300,      // only run fast when this far beyond the delay (a smaller excess is not worth a visible skip), ...
    catchUpStopMs: 40,        // ... and keep going until this close to it
    jumpMs: 4000,             // lag beyond this is not worth playing through: jump to the live edge
    settleMs: 20000,          // this long without a stall and the delay starts creeping back down
    relaxPerSecondMs: 20,
  };

  class Playout {
    constructor(options = {}) {
      Object.assign(this, DEFAULTS, options);
      this.delayMs = this.startDelayMs;
      this.reset();
    }

    reset() {
      this.state = 'buffering';
      this.playhead = null;           // picture time currently being shown, microseconds
      this.newest = null;             // newest picture time known (pictures and heartbeats), microseconds
      this.frames = [];               // decoded pictures waiting for their time: { pts, handle }
      this.lastTick = null;
      this.playingSince = null;       // when playing last began: the delay only relaxes after a calm stretch from here
      this.lastStallAt = -Infinity;
      this.catchingUp = false;
      this.jumpUntil = 0;
      this.ended = false;
      this.rate = 1;
      this.stalls = 0;
      this.presented = 0;
      this.skipped = 0;               // pictures that were due at the same refresh as a newer one (display slower than the stream, or a speed-up)
      this.skippedAtStart = 0;        // pictures from before the live edge, when this viewer started
      this.jumps = 0;                 // times the viewer was so far behind that it jumped to the live edge
    }

    // Something from the sharer arrived (a picture's time, or a heartbeat's): the stream is known to reach this far.
    noteSource(pts) { if (this.newest === null || pts > this.newest) this.newest = pts; }

    addFrame(pts, handle) {
      this.noteSource(pts);
      this.frames.push({ pts, handle });
    }

    // The share ended: running out of pictures from now on is the end, not a stall.
    finish() { this.ended = true; }

    get depthMs() { return this.playhead === null || this.newest === null ? 0 : (this.newest - this.playhead) / 1000; }

    // pending: pictures handed to the decoder that have not come out yet (the clock waits for them rather than skipping ahead).
    tick(now, { pending = 0 } = {}) {
      const dt = this.lastTick === null ? 0 : Math.max(0, Math.min(250, now - this.lastTick));
      this.lastTick = now;
      const none = { present: null, dropped: [] };
      if (this.playhead === null) {
        if (!this.frames.length) return { ...none, ...this._view() };
        this.playhead = Math.max(this.frames[0].pts, this.newest - this.delayMs * 1000);
        while (this.frames.length > 1 && this.frames[1].pts <= this.playhead) { none.dropped.push(this.frames.shift().handle); this.skippedAtStart++; }
      }
      if (this.state === 'buffering') {
        if (this.depthMs < this.delayMs || !this.frames.length) return { ...none, ...this._view() };
        this.state = 'playing'; this.playingSince = now;
      }
      const excessUs = this.newest - this.playhead - this.delayMs * 1000;
      if (!this.catchingUp && excessUs > this.catchUpStartMs * 1000) this.catchingUp = true;
      else if (this.catchingUp && excessUs < this.catchUpStopMs * 1000) this.catchingUp = false;
      // The pictures that built up during an outage arrive as a burst. Having decided to jump, keep following the burst for a moment, or
      // the part that is still arriving leaves the viewer behind again.
      if (excessUs > this.jumpMs * 1000 || (now < this.jumpUntil && excessUs > this.catchUpStartMs * 1000)) {
        if (now >= this.jumpUntil) this.jumps++;
        this.playhead = this.newest - this.delayMs * 1000; this.catchingUp = false; this.jumpUntil = now + 500;
      }
      this.rate = this.catchingUp ? 1 + Math.min(this.catchUpMaxRate - 1, 0.03 + Math.max(0, excessUs) / 1e6 * 0.05) : 1;
      // Waiting for the decoder is not the link's fault: hold the clock instead of running past pictures that are about to appear.
      if (!this.frames.length && pending > 0) return { ...none, ...this._view() };
      this.playhead += dt * 1000 * this.rate;
      if (this.playhead > this.newest) this.playhead = this.newest;
      const due = [];
      while (this.frames.length && this.frames[0].pts <= this.playhead) due.push(this.frames.shift());
      // The stream's clock and the display's refresh drift against each other, so now and then two pictures are due at once. One
      // picture of slack costs nothing: show them one per refresh. Three or more means the stream really is faster than the
      // display (or the clock is running ahead to catch up): show the newest and count the rest as skipped.
      let present = null, dropped = [];
      if (due.length === 1 || due.length === 2) { present = due[0]; if (due.length === 2) this.frames.unshift(due[1]); }
      else if (due.length > 2) { present = due.pop(); dropped = due; this.skipped += dropped.length; }
      if (present) this.presented++;
      if (!present && !this.frames.length && pending === 0 && this.playhead >= this.newest && !this.ended) {
        // Everything that had arrived has been shown and nothing is on its way: a stall. Wait for a fuller buffer next time.
        this.state = 'buffering'; this.stalls++; this.lastStallAt = now;
        this.delayMs = Math.min(this.maxDelayMs, Math.max(this.delayMs * 1.5, this.delayMs + 100));
      } else if (now - Math.max(this.lastStallAt, this.playingSince ?? now) > this.settleMs && this.delayMs > this.minDelayMs) {
        this.delayMs = Math.max(this.minDelayMs, this.delayMs - this.relaxPerSecondMs * dt / 1000);
      }
      return { present: present ? present.handle : null, dropped: [...none.dropped, ...dropped.map(frame => frame.handle)], ...this._view() };
    }

    _view() { return { state: this.state, rate: this.rate, depthMs: this.depthMs, delayMs: this.delayMs }; }
  }

  return { Playout, DEFAULTS };
});
