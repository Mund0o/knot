(function installSharePlayer(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KnotSharePlayer = api;
})(typeof window === 'object' ? window : typeof globalThis === 'object' ? globalThis : null, root => {
  // Shows a screen share: decodes the pictures a viewer receives and draws them on a canvas at the right moments.
  // Records go in (from share-core's receiver); a picture comes out of the decoder when its turn is near, and the playout
  // controller (share-playout.js) decides when it is shown. Nothing here ever lowers the quality of what is shown.
  //
  // Decoded 4K pictures are big (about 12 MB each in software), so the player keeps the *encoded* pictures queued and only decodes
  // a few ahead of the clock; the buffer the viewer waits behind costs the memory of the compressed stream, not of the raw one.
  const Playout = (typeof require === 'function' && typeof module === 'object') ? require('./share-playout').Playout : root.KnotSharePlayout.Playout;
  const Wire = (typeof require === 'function' && typeof module === 'object') ? require('./share-wire') : root.KnotShareWire;
  const { TYPE } = Wire;

  const DECODE_AHEAD_MIN_US = 150000;      // decode pictures this far ahead of the clock (or six pictures, whichever is more)
  const START_BATCH = 40;                  // before the clock has started, decode this many to get the first picture out
  const MAX_DECODE_QUEUE = 48;
  const MAX_BACKLOG_SECONDS = 20;          // encoded pictures waiting this long means the decoder cannot keep up at all: restart from the newest key
  const NO_OUTPUT_MS = 1200;               // a decoder that has been fed this long without a picture coming out is not working
  const DEFAULT_FPS = 60;
  // A hardware decoder can "work" (every picture decodes, nothing throws) and still hand back garbage: a black or white picture from a bad
  // driver. The first picture it produces is checked once against a software decode of the same key picture, on small thumbnails. If the
  // two disagree, the hardware decoder is replaced by the software one. Two decoders that agree on a black screen (a legitimately black or
  // white share) cause no change.
  const THUMB_W = 64, THUMB_H = 36, VERIFY_MAX_DIFFERENCE = 24;      // brightness, 0-255, averaged over the thumbnail

  function supported() { return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function'; }

  let thumbContext = null;
  function thumbnail(frame) {
    try {
      if (!thumbContext) { const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(THUMB_W, THUMB_H) : Object.assign(document.createElement('canvas'), { width: THUMB_W, height: THUMB_H }); thumbContext = canvas.getContext('2d', { willReadFrequently: true }); }
      thumbContext.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
      const pixels = thumbContext.getImageData(0, 0, THUMB_W, THUMB_H).data, luma = new Float32Array(THUMB_W * THUMB_H);
      for (let i = 0, j = 0; i < pixels.length; i += 4, j++) luma[j] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      return luma;
    } catch { return null; }
  }
  function thumbnailDifference(a, b) { let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]); return total / a.length; }

  function createSharePlayer({ surface, getDisplaySize = () => null, onState = () => {}, onError = () => {}, onFrameDecoded = null, now = () => performance.now(),
    schedule = fn => (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState === 'visible') ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16)),
    preferSoftware = false, playoutOptions = {} } = {}) {
    if (!supported()) throw new Error('This build cannot decode video');
    const playout = new Playout(playoutOptions);
    const canvas = surface?.canvas || null, context = surface?.context || null;
    let config = null, decoder = null, generation = 0, destroyed = false, active = true, ended = false, loopOn = false;
    let software = !!preferSoftware, softwareReason = '', needKey = true, pending = 0, lastSubmitAt = 0, lastOutputAt = 0, verified = !!preferSoftware, verification = preferSoftware ? 'not needed' : 'waiting';
    let encoded = [], replay = [];
    const arrivals = new Map();            // picture time -> when it arrived, for latency
    const latencies = [];
    const stats = { received: 0, decoded: 0, painted: 0, decodeSkips: 0, restarts: 0, errors: 0, width: 0, height: 0, firstPaintAt: 0, lastPaintAt: 0, lastPacketAt: 0, lastLiveAt: 0, lastState: '' };
    const renderIntervals = [];

    const fps = () => Number(config?.fps) || DEFAULT_FPS;
    const aheadUs = () => Math.max(DECODE_AHEAD_MIN_US, 6e6 / fps());

    function closeFrame(frame) { try { frame.close(); } catch {} }

    function stopDecoder() {
      generation++;
      const old = decoder; decoder = null; pending = 0;
      if (old) { try { old.close(); } catch {} }
      for (const entry of playout.frames) closeFrame(entry.handle);
      playout.frames = [];
    }

    function startDecoder() {
      if (destroyed || !config) return false;
      stopDecoder();
      const mine = generation, mode = software ? 'prefer-software' : 'prefer-hardware';
      verified = software; verification = software ? 'not needed' : 'waiting';
      try {
        const instance = new VideoDecoder({
          output: frame => onOutput(frame, mine),
          error: error => onDecoderError(error, mine),
        });
        instance.configure({ codec: config.codec, codedWidth: config.width || undefined, codedHeight: config.height || undefined, hardwareAcceleration: mode, optimizeForLatency: true });
        decoder = instance; needKey = true; lastOutputAt = now(); lastSubmitAt = 0;
        return true;
      } catch (error) { return fallbackOrFail(error); }
    }

    // A hardware decoder that refuses a stream or produces nothing is replaced by the software one, once, and the stream is replayed
    // from its last key picture. That is a decoder failure, not a response to the link, so it is not a downgrade.
    function fallbackOrFail(error) {
      if (!software) {
        software = true; softwareReason = String(error?.message || error || 'hardware decoder failed'); stats.restarts++;
        const resume = replay.slice();
        if (!startDecoder()) return false;
        encoded = [...resume, ...encoded]; replay = [];
        return true;
      }
      stats.errors++; destroyedWith(error); return false;
    }
    function destroyedWith(error) { if (destroyed) return; try { onError(error instanceof Error ? error : new Error(String(error))); } catch {} }

    function verifyAgainstSoftware(first, reference, mine) {
      let reference2 = reference, soft = null, done = false;
      const finish = thumb => {
        if (done) return; done = true;
        try { soft?.close(); } catch {}
        if (mine !== generation || destroyed || software) return;
        if (!thumb || !reference2) { verification = 'could not compare'; return; }          // nothing to compare with: the hardware decoder is trusted
        if (thumbnailDifference(thumb, reference2) > VERIFY_MAX_DIFFERENCE) { verification = 'different'; fallbackOrFail(new Error('The hardware decoder showed a different picture than the software decoder')); }
        else verification = 'ok';
      };
      try {
        soft = new VideoDecoder({ output: frame => { const thumb = thumbnail(frame); try { frame.close(); } catch {} finish(thumb); }, error: () => finish(null) });
        soft.configure({ codec: config.codec, codedWidth: config.width || undefined, codedHeight: config.height || undefined, hardwareAcceleration: 'prefer-software' });
        soft.decode(new EncodedVideoChunk({ type: 'key', timestamp: first.pts, data: first.data }));
        soft.flush().then(() => finish(null), () => finish(null));      // a decoder that outputs nothing at all ends the wait here
      } catch { finish(null); }
    }

    function onDecoderError(error, mine) { if (mine !== generation || destroyed) return; fallbackOrFail(error); }

    function onOutput(frame, mine) {
      if (mine !== generation || destroyed) { closeFrame(frame); return; }
      pending = Math.max(0, pending - 1); stats.decoded++; lastOutputAt = now();
      stats.width = frame.displayWidth || frame.codedWidth; stats.height = frame.displayHeight || frame.codedHeight;
      // The first picture a hardware decoder produces is the key picture that began the replay: check it against a software decode of it.
      if (!verified && !software && replay.length && replay[0].key && replay[0].pts === frame.timestamp) { verified = true; verification = 'checking'; verifyAgainstSoftware(replay[0], thumbnail(frame), mine); }
      if (onFrameDecoded) { try { onFrameDecoded(frame); } catch {} }
      if (!active) { closeFrame(frame); arrivals.delete(frame.timestamp); return; }
      playout.addFrame(frame.timestamp, frame);
      kick();
    }

    // ---- input
    // The description can arrive after the first pictures (it travels a different way); those wait in the queue until there is a decoder.
    function configure(next) {
      const changed = !!config && (config.codec !== next.codec || config.width !== next.width || config.height !== next.height);
      config = { ...next };
      if (changed) { encoded = []; replay = []; playout.reset(); }
      if (!decoder || changed) startDecoder();
      kick();
    }

    function push(record) {
      if (destroyed) return;
      const t = now();
      if (record.type === TYPE.HEARTBEAT) { playout.noteSource(record.pts); stats.lastLiveAt = t; kick(); return; }
      if (record.type === TYPE.END) { ended = true; playout.finish(); stats.lastLiveAt = t; kick(); return; }
      if (record.type !== TYPE.VIDEO) return;
      stats.received++; stats.lastPacketAt = stats.lastLiveAt = t;
      const pts = Math.round(record.pts);
      playout.noteSource(pts);
      arrivals.set(pts, t);
      encoded.push({ key: record.key, pts, data: record.payload });
      if (!active) trimToLastKey();
      else if (encoded.length > MAX_BACKLOG_SECONDS * fps()) skipToLatestKey();
      kick();
    }

    // The sharer moved this viewer forward (it had fallen too far behind): start again from a key picture.
    function skip() {
      encoded = []; replay = []; arrivals.clear(); playout.reset(); stats.decodeSkips++;
      if (decoder) startDecoder();
    }

    function trimToLastKey() {
      let at = -1; for (let i = encoded.length - 1; i >= 0; i--) if (encoded[i].key) { at = i; break; }
      if (at > 0) encoded.splice(0, at);
    }
    function skipToLatestKey() {
      trimToLastKey(); stats.decodeSkips++;
      playout.reset(); replay = []; if (decoder) startDecoder();
    }

    function setActive(value) {
      value = !!value; if (value === active) return; active = value;
      if (!active) { stopDecoder(); trimToLastKey(); replay = []; playout.reset(); }
      else { playout.reset(); startDecoder(); kick(); }
    }

    // ---- decoding
    function pump() {
      if (!decoder || !active) return;
      const limit = playout.playhead === null ? null : playout.playhead + aheadUs();
      let started = playout.playhead === null ? START_BATCH : Infinity;
      while (encoded.length && started > 0 && (decoder.decodeQueueSize || 0) < MAX_DECODE_QUEUE && (limit === null || encoded[0].pts <= limit)) {
        const item = encoded.shift(); started--;
        if (needKey) { if (!item.key) { arrivals.delete(item.pts); continue; } needKey = false; replay = []; }
        else if (item.key) replay = [];
        replay.push(item);
        try { decoder.decode(new EncodedVideoChunk({ type: item.key ? 'key' : 'delta', timestamp: item.pts, data: item.data })); pending++; lastSubmitAt = now(); }
        catch (error) { onDecoderError(error, generation); return; }
      }
    }

    // ---- presenting
    function size() {
      const display = getDisplaySize();
      let w = stats.width, h = stats.height;
      if (display && w && h && (w > display.width || h > display.height)) { const scale = Math.min(display.width / w, display.height / h, 1); w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); }
      return { w: w || 960, h: h || 540 };
    }

    function draw(frame) {
      const t = now(), arrived = arrivals.get(frame.timestamp); arrivals.delete(frame.timestamp);
      if (canvas && context) {
        const { w, h } = size();
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        try { context.drawImage(frame, 0, 0, w, h); } catch (error) { closeFrame(frame); stats.errors++; destroyedWith(error); return; }
        if (!stats.firstPaintAt) { stats.firstPaintAt = t; surface?.reveal?.(); }
      }
      closeFrame(frame);
      if (stats.lastPaintAt) { renderIntervals.push(t - stats.lastPaintAt); if (renderIntervals.length > 360) renderIntervals.shift(); }
      stats.lastPaintAt = t; stats.painted++;
      if (arrived !== undefined) { latencies.push(t - arrived); if (latencies.length > 360) latencies.shift(); }
    }

    function tick(t) {
      loopOn = false;
      if (destroyed) return;
      pump();
      if (active) {
        const result = playout.tick(t, { pending });
        for (const frame of result.dropped) { arrivals.delete(frame.timestamp); closeFrame(frame); }
        if (result.present) draw(result.present);
        pump();
        const label = ended && !playout.frames.length && !encoded.length ? 'ended' : stats.painted ? result.state === 'buffering' ? 'buffering' : 'live' : 'connecting';
        if (label !== stats.lastState) { stats.lastState = label; try { onState({ state: label, ...status() }); } catch {} }
        // A decoder that is fed and never answers is not working (a driver that accepts AV1 and returns nothing, say).
        if (decoder && !software && pending >= 18 && t - Math.max(lastOutputAt, lastSubmitAt - 1) > NO_OUTPUT_MS && lastSubmitAt) fallbackOrFail(new Error('The hardware decoder produced no pictures'));
      }
      if (active) kick();
    }

    function kick() {
      if (loopOn || destroyed) return;
      loopOn = true; schedule(tick);
    }

    function status() {
      return { buffering: playout.state === 'buffering', delayMs: Math.round(playout.delayMs), depthMs: Math.round(playout.depthMs), stalls: playout.stalls, jumps: playout.jumps };
    }

    function percentile(list, p) { if (!list.length) return 0; const sorted = [...list].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }

    return {
      configure, push, skip, setActive, supported,
      get ended() { return ended; },
      // What the buffering view needs: a still screen keeps lastLiveAt fresh through heartbeats even though no picture arrives.
      read() { return { painted: stats.painted, lastPacketAt: stats.lastPacketAt, lastLiveAt: stats.lastLiveAt, liveCapable: true }; },
      stats() {
        const intervals = renderIntervals.slice(-120), mean = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
        return {
          ...stats, ...status(), decoder: software ? 'software' : 'hardware-preferred', softwareReason, pending, verification, queued: encoded.length, decodedWaiting: playout.frames.length, skippedShown: playout.skipped, skippedAtStart: playout.skippedAtStart,
          renderFps: mean ? 1000 / mean : 0, renderCadenceP95Ms: percentile(intervals, .95), latencyP50Ms: percentile(latencies, .5), latencyP95Ms: percentile(latencies, .95), rate: playout.rate,
        };
      },
      destroy() { if (destroyed) return; destroyed = true; stopDecoder(); encoded = []; replay = []; arrivals.clear(); },
    };
  }

  return { createSharePlayer, supported };
});
